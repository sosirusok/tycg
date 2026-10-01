import { db, MANAGER_ID } from './http';
import { unused } from './files';
import { deleteR2Photos } from './storage';
import { UNREAD_RECOUNT } from './chat';
import { postTitleKey } from './posts';
import { gradeInfo } from '../shared/membership';

const DAY = 86400000;
// Photos removed per daily run (one SELECT, one DELETE and one R2 call).
export const PHOTOS_PER_RUN = 100;
const TITLE_KEYS_PER_ROUND = 200;

// "10월 7일" on the Korean calendar.
const monthDay = (t: number) => new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

type Due = { id: number; user_id: string; grade: string; expires_at: number };
type Photo = { id: string; storage: string };

// A 6-month grade that ends within 7 days gets one manager chat message. A 플러스 무료 체험 never does
// (its reminders stay in the app: the member's status line and the home end band). A renewal moves the
// end date, so the grant is reminded again before the new date. Grants outlived by another grant of
// the same or a higher grade are skipped. At most 50 per run.
const dueReminders = (now: number) => db().prepare(`SELECT g.id,g.user_id,g.grade,g.expires_at FROM user_grades g
    WHERE g.source='manager' AND g.expires_at>? AND g.expires_at<=? AND (g.reminded_at IS NULL OR g.reminded_at<g.expires_at-?)
    AND NOT EXISTS(SELECT 1 FROM user_grades o WHERE o.user_id=g.user_id AND o.id!=g.id AND o.rank>=g.rank AND (o.expires_at IS NULL OR o.expires_at>g.expires_at))
    ORDER BY g.expires_at LIMIT 50`).bind(now, now + 7 * DAY, 7 * DAY);

// Daily housekeeping (cron in wrangler.jsonc): expired sessions, finished rate-limit windows, post
// events older than the caps look back, posts the previous Worker wrote without bumped_at or
// title_key, grade-end reminders, and photos that no post, chat message or draft has used for a day.
// The Workers Free plan allows 50 D1 queries per invocation, so the whole run is set-based: at most
// 6 D1 or R2 calls and about 20 statements, whatever the number of rows.
export async function cleanup(now = Date.now()) {
    // Call 1: the housekeeping writes and the three reads the rest of the run works from.
    const r = await db().batch([
        db().prepare('DELETE FROM sessions WHERE expires_at<?').bind(now),
        db().prepare('DELETE FROM rate_limits WHERE reset_at<?').bind(now),
        // The daily caps look back to KST midnight and the deleted-title wait at most 6 hours.
        db().prepare('DELETE FROM post_events WHERE created_at<?').bind(now - 2 * DAY),
        db().prepare('UPDATE posts SET bumped_at=created_at WHERE bumped_at=0'),
        db().prepare("SELECT id,title FROM posts WHERE title_key='' LIMIT ?").bind(TITLE_KEYS_PER_ROUND),
        dueReminders(now),
        db().prepare(`SELECT id,storage FROM uploads WHERE created_at<? AND ${unused} LIMIT ?`).bind(now - DAY, PHOTOS_PER_RUN),
    ]);
    const titles = r[4].results as { id: number; title: string }[], due = r[5].results as Due[], photos = r[6].results as Photo[];
    await fillTitleKeys(titles);
    const reminded = due.length ? await remindGradeEnds(due, now) : 0;
    const removed = photos.length ? await removePhotos(photos) : 0;
    return { removed, reminded };
}

// SQLite has no NFKC, so the same-title keys of older posts are computed here: at most 2 rounds of 200,
// one UPDATE each (≤ 2 more calls). A title changed meanwhile keeps its empty key for the next run.
async function fillTitleKeys(first: { id: number; title: string }[]) {
    const update = (rows: { id: number; title: string }[]) => {
        const list = JSON.stringify(rows.map(p => ({ id: p.id, t: p.title, k: postTitleKey(p.title) })));
        const field = (f: string) => `(SELECT json_extract(j.value,'$.${f}') FROM json_each(?) j WHERE json_extract(j.value,'$.id')=posts.id)`;
        return db().prepare(`UPDATE posts SET title_key=${field('k')} WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND title_key='' AND title=${field('t')}`)
            .bind(list, list, list);
    };
    if (!first.length) return;
    if (first.length < TITLE_KEYS_PER_ROUND) { await update(first).run(); return; }
    const [, next] = await db().batch([update(first), db().prepare("SELECT id,title FROM posts WHERE title_key='' LIMIT ?").bind(TITLE_KEYS_PER_ROUND)]);
    const rows = next.results as { id: number; title: string }[];
    if (rows.length) await update(rows).run();
}

// One batch for every due grant: the manager chat where missing, the message, the chat's order and
// unread counts, and reminded_at. A member who left or who blocked the manager (either way) gets
// nothing, and the grant is still marked, so one member is never retried every day.
async function remindGradeEnds(due: Due[], now: number) {
    const list = JSON.stringify(due.map(g => {
        const [a, b] = [MANAGER_ID, g.user_id].sort();
        return { gid: g.id, uid: g.user_id, a, b, cid: crypto.randomUUID(), text: `${gradeInfo(g.grade).name} 등급이 ${monthDay(g.expires_at)}에 끝납니다. 연장은 인증/등급 신청에서 6개월을 다시 신청해 주세요.` };
    }));
    const uid = "json_extract(j.value,'$.uid')", pair = "c.user_a=json_extract(j.value,'$.a') AND c.user_b=json_extract(j.value,'$.b')";
    const reachable = `EXISTS(SELECT 1 FROM users m WHERE m.id='${MANAGER_ID}') AND EXISTS(SELECT 1 FROM users t WHERE t.id=${uid} AND t.deleted_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM blocks k WHERE (k.user_id='${MANAGER_ID}' AND k.target_id=${uid}) OR (k.user_id=${uid} AND k.target_id='${MANAGER_ID}'))`;
    const r = await db().batch([
        db().prepare(`INSERT OR IGNORE INTO conversations(id,user_a,user_b,created_at,updated_at) SELECT json_extract(j.value,'$.cid'),json_extract(j.value,'$.a'),json_extract(j.value,'$.b'),?,? FROM json_each(?) j WHERE ${reachable}`)
            .bind(now, now, list),
        db().prepare(`INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) SELECT c.id,'${MANAGER_ID}',json_extract(j.value,'$.text'),'system',NULL,'[]',?
            FROM json_each(?) j JOIN conversations c ON ${pair} WHERE ${reachable}`).bind(now, list),
        db().prepare(`UPDATE conversations SET updated_at=?,${UNREAD_RECOUNT} WHERE id IN (SELECT c.id FROM json_each(?) j JOIN conversations c ON ${pair} WHERE ${reachable})`).bind(now, list),
        db().prepare("UPDATE user_grades SET reminded_at=? WHERE id IN (SELECT json_extract(value,'$.gid') FROM json_each(?))").bind(now, list),
    ]);
    return r[1].meta.changes;
}

// The rows go first and only while still unused, so a photo attached meanwhile is kept. D1 bytes go
// with them (upload_blobs ON DELETE CASCADE); R2 objects go in one call.
async function removePhotos(photos: Photo[]) {
    const gone = (await db().prepare(`DELETE FROM uploads WHERE id IN (SELECT value FROM json_each(?)) AND ${unused} RETURNING id,storage`)
        .bind(JSON.stringify(photos.map(p => p.id))).all<Photo>()).results;
    await deleteR2Photos(gone.filter(p => p.storage === 'r2').map(p => p.id));
    return gone.length;
}
