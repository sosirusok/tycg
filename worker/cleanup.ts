import { db, MANAGER_ID } from './http';
import { unused } from './files';
import { deleteR2Photos, deleteKvKeys, getKv, putR2, blobBytes, hasBucket, hasKv, counterValue, utcDate } from './storage';
import { UNREAD_RECOUNT } from './chat';
import { postTitleKey } from './posts';
import { PRINT_DAYS, fieldsHash } from './prints';
import { listingFields, photoKeys } from '../shared/listing';
import { gradeInfo } from '../shared/membership';

const DAY = 86400000;
// Photos removed per daily run (one SELECT, one DELETE and one R2 call).
export const PHOTOS_PER_RUN = 100;
const TITLE_KEYS_PER_ROUND = 200;
// Backfilled prints filled per daily run (one SELECT and one UPDATE).
export const PRINTS_PER_RUN = 1000;
// Photo retention (decisions item 6): a 완료 post keeps every photo for 90 days, then only its 대표;
// a deleted post's photos are held 30 days for the manager (the posts_delete_hold trigger, 0022).
export const RETAIN_DAYS = 90;
export const RETENTION_PER_RUN = 100;
// Inline thumbnails are cleared on posts completed more than 90 days ago and on open posts not bumped for
// 60 days (an edit makes a new one), which bounds them to about 60 days of posts in D1.
const THUMB_OPEN_DAYS = 60;
const THUMBS_PER_RUN = 2000;
// KV deletes: at most 6 a run, and only while settings 'sys:kv_deletes' ('<UTC date>:<n>') is under 900
// for the UTC day (KV Free allows 1,000 deletes a day and resets at 00:00 UTC). Tick B (WP52) takes this
// over; until then the daily cleanup runs it.
export const KV_DELETES_PER_RUN = 6;
export const KV_DELETES_PER_DAY = 900;
// The R2 mover: once a bucket is bound, at most 3 D1 or KV photos a run are copied into R2.
export const MOVES_PER_RUN = 3;

// "10월 7일" on the Korean calendar.
const monthDay = (t: number) => new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

type Due = { id: number; user_id: string; grade: string; expires_at: number };
type Photo = { id: string; storage: string };
type Movable = { id: string; storage: string; mime: string; data: string | null };

// A 6-month grade that ends within 7 days gets one manager chat message. A 플러스 무료 체험 never does
// (its reminders stay in the app: the member's status line and the home end band). A renewal moves the
// end date, so the grant is reminded again before the new date. Grants outlived by another grant of
// the same or a higher grade are skipped. At most 50 per run.
const dueReminders = (now: number) => db().prepare(`SELECT g.id,g.user_id,g.grade,g.expires_at FROM user_grades g
    WHERE g.source='manager' AND g.expires_at>? AND g.expires_at<=? AND (g.reminded_at IS NULL OR g.reminded_at<g.expires_at-?)
    AND NOT EXISTS(SELECT 1 FROM user_grades o WHERE o.user_id=g.user_id AND o.id!=g.id AND o.rank>=g.rank AND (o.expires_at IS NULL OR o.expires_at>g.expires_at))
    ORDER BY g.expires_at LIMIT 50`).bind(now, now + 7 * DAY, 7 * DAY);

// Unused photos the cleanup may remove: no post, chat or draft uses them, nothing touched them for a day,
// and the delete hold (keep_until) is over.
const removable = (now: number) => `${unused} AND COALESCE(uploads.keep_until,0)<${Math.floor(now)}`;

// Daily housekeeping (cron in wrangler.jsonc): expired sessions, finished rate-limit windows, post
// events older than the caps look back, posts the previous Worker wrote without bumped_at or
// title_key, grade-end reminders, photos that no post, chat message or draft has used for a day, photo
// retention, old thumbnails, the KV delete budget and the R2 mover.
// The Workers Free plan allows 50 subrequests per invocation, so the whole run is set-based: one read
// call, at most 2 title-key calls, one write batch, one R2 delete and 3 R2 puts (≤ 8 D1 or R2 calls and
// about 35 statements), plus at most 6 KV deletes and 3 KV reads, whatever the number of rows.
export async function cleanup(now = Date.now()) {
    const kv = hasKv(), mover = hasBucket();
    // Call 1: the housekeeping writes and the reads the rest of the run works from.
    const reads = {
        titles: db().prepare("SELECT id,title FROM posts WHERE title_key='' LIMIT ?").bind(TITLE_KEYS_PER_ROUND),
        due: dueReminders(now),
        // A lookup that reused a photo (touched_at, WP44) counts as a use too.
        photos: db().prepare(`SELECT id,storage FROM uploads WHERE created_at<? AND COALESCE(touched_at,0)<? AND ${removable(now)} LIMIT ?`).bind(now - DAY, now - DAY, PHOTOS_PER_RUN),
        prints: db().prepare(`SELECT pp.post_id,pp.title_key,p.kind,p.category,p.title,p.details,p.images,
            (SELECT json_group_array(json_object('tier',s.tier,'season',s.season)) FROM post_seasons s WHERE s.post_id=p.id) AS tags
            FROM post_prints pp INDEXED BY post_prints_unfilled JOIN posts p ON p.id=pp.post_id WHERE pp.fields IS NULL ORDER BY pp.post_id DESC LIMIT ?`).bind(PRINTS_PER_RUN),
        // 완료 posts past 90 days that still have more than the 대표, without a pending report or a trade
        // recorded in the last 7 days.
        retain: db().prepare(`SELECT p.id FROM posts p WHERE p.status='closed' AND COALESCE(p.closed_at,p.updated_at)<? AND json_array_length(p.images)>1
            AND NOT EXISTS(SELECT 1 FROM reports r WHERE r.post_id=p.id AND r.status='pending')
            AND NOT EXISTS(SELECT 1 FROM trades t WHERE t.post_id=p.id AND t.created_at>?) LIMIT ?`).bind(now - RETAIN_DAYS * DAY, now - 7 * DAY, RETENTION_PER_RUN),
        trash: db().prepare('SELECT id FROM kv_trash ORDER BY created_at LIMIT ?').bind(kv ? KV_DELETES_PER_RUN : 0),
        kvCount: db().prepare("SELECT value FROM settings WHERE key='sys:kv_deletes'"),
        // KV first (the smaller store), then D1.
        movableKv: db().prepare(`SELECT u.id,u.storage,u.mime,NULL AS data FROM uploads u INDEXED BY uploads_movable WHERE u.storage IN ('d1','kv') AND u.storage='kv' LIMIT ?`)
            .bind(mover && kv ? MOVES_PER_RUN : 0),
        movableD1: db().prepare(`SELECT u.id,u.storage,u.mime,b.data FROM uploads u INDEXED BY uploads_movable LEFT JOIN upload_blobs b ON b.id=u.id WHERE u.storage IN ('d1','kv') AND u.storage='d1' LIMIT ?`)
            .bind(mover ? MOVES_PER_RUN : 0),
    };
    const names = Object.keys(reads) as (keyof typeof reads)[];
    const r = await db().batch([
        db().prepare('DELETE FROM sessions WHERE expires_at<?').bind(now),
        db().prepare('DELETE FROM rate_limits WHERE reset_at<?').bind(now),
        // The daily caps look back to KST midnight and the 새 글 placement at most 2 days.
        db().prepare('DELETE FROM post_events WHERE created_at<?').bind(now - 2 * DAY),
        db().prepare('UPDATE posts SET bumped_at=created_at WHERE bumped_at=0'),
        // 같은 매물 (WP44): prints are kept 7 days after the post was completed or deleted, and never for a
        // member who left.
        db().prepare('DELETE FROM post_prints WHERE gone_at<?').bind(now - PRINT_DAYS * DAY),
        db().prepare('DELETE FROM post_prints WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)'),
        db().prepare(`UPDATE posts SET thumb=NULL WHERE id IN (SELECT id FROM posts INDEXED BY posts_thumb WHERE thumb IS NOT NULL
            AND ((status='closed' AND COALESCE(closed_at,updated_at)<?) OR (status!='closed' AND bumped_at<?)) LIMIT ?)`).bind(now - RETAIN_DAYS * DAY, now - THUMB_OPEN_DAYS * DAY, THUMBS_PER_RUN),
        ...names.map(n => reads[n]),
    ]);
    const got = <T>(n: keyof typeof reads) => r[7 + names.indexOf(n)].results as T[];
    const titles = got<{ id: number; title: string }>('titles'), due = got<Due>('due'), photos = got<Photo>('photos');
    const retain = got<{ id: number }>('retain').map(p => p.id);
    await fillTitleKeys(titles);
    const writes: D1PreparedStatement[] = [];
    const prints = await fillPrints(got<Unfilled>('prints'));
    if (prints) writes.push(prints);
    const remindAt = writes.length;
    if (due.length) writes.push(...remindGradeEnds(due, now));
    // KV deletes under the day's budget, one by one; only the ids that went leave kv_trash.
    const used = counterValue(got<{ value: string }>('kvCount')[0]?.value, now);
    const trash = got<{ id: string }>('trash').map(t => t.id).slice(0, Math.max(0, Math.min(KV_DELETES_PER_RUN, KV_DELETES_PER_DAY - used)));
    const kvDeleted = trash.length ? await deleteKvKeys(trash) : [];
    // The R2 mover: copy first, then switch the row only if it still has the old store; the old copy goes
    // after (the D1 bytes in the same batch, the KV key through kv_trash).
    const moved: Photo[] = [];
    for (const m of [...got<Movable>('movableKv'), ...got<Movable>('movableD1')].slice(0, MOVES_PER_RUN)) {
        try {
            const bytes = m.storage === 'd1' ? (m.data ? blobBytes(m.data) : null) : await getKv(m.id);
            if (!bytes) continue;
            await putR2(m.id, bytes, m.mime);
            moved.push({ id: m.id, storage: m.storage });
        } catch (e) { console.warn('R2 move stopped', e instanceof Error ? e.message : 'unknown'); break; }
    }
    const movedFirst = writes.length;
    for (const m of moved) writes.push(db().prepare("UPDATE uploads SET storage='r2' WHERE id=? AND storage=? RETURNING id").bind(m.id, m.storage));
    if (moved.length) {
        const ids = JSON.stringify(moved.map(m => m.id)), kvIds = JSON.stringify(moved.filter(m => m.storage === 'kv').map(m => m.id));
        writes.push(
            db().prepare("DELETE FROM upload_blobs WHERE id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM uploads u WHERE u.id=upload_blobs.id AND u.storage='r2')").bind(ids),
            db().prepare("INSERT OR IGNORE INTO kv_trash(id,created_at) SELECT value,? FROM json_each(?) WHERE EXISTS(SELECT 1 FROM uploads u WHERE u.id=value AND u.storage='r2')").bind(now, kvIds),
        );
    }
    // Unused photos: the rows go only while still unused, so a photo attached meanwhile is kept. KV keys go
    // to kv_trash, D1 bytes with the rows (upload_blobs ON DELETE CASCADE), R2 objects in one call below.
    let removedAt = -1;
    if (photos.length) {
        const ids = JSON.stringify(photos.map(p => p.id));
        writes.push(db().prepare(`INSERT OR IGNORE INTO kv_trash(id,created_at) SELECT id,? FROM uploads WHERE id IN (SELECT value FROM json_each(?)) AND storage='kv' AND ${removable(now)}`).bind(now, ids));
        removedAt = writes.length;
        writes.push(db().prepare(`DELETE FROM uploads WHERE id IN (SELECT value FROM json_each(?)) AND ${removable(now)} RETURNING id,storage`).bind(ids));
    }
    // Retention: only the 대표 (images[0]) stays on the post; the other photos fall into the unused cleanup
    // on later runs.
    if (retain.length) {
        const ids = JSON.stringify(retain);
        writes.push(
            db().prepare("DELETE FROM post_images WHERE post_id IN (SELECT value FROM json_each(?)) AND upload_id!=(SELECT json_extract(p.images,'$[0]') FROM posts p WHERE p.id=post_images.post_id)").bind(ids),
            db().prepare("UPDATE posts SET images=json_array(json_extract(images,'$[0]')) WHERE id IN (SELECT value FROM json_each(?)) AND status='closed' AND json_array_length(images)>1").bind(ids),
        );
    }
    if (kvDeleted.length) {
        writes.push(
            db().prepare('DELETE FROM kv_trash WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(kvDeleted)),
            db().prepare(`INSERT INTO settings(key,value,updated_at) VALUES('sys:kv_deletes',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
                .bind(`${utcDate(now)}:${used + kvDeleted.length}`, now),
        );
    }
    const w = writes.length ? await db().batch(writes) : [];
    const gone = removedAt >= 0 ? w[removedAt].results as Photo[] : [];
    // A photo deleted while it was being copied leaves an R2 object nobody uses: it goes with the rest.
    const orphans = moved.filter((_, i) => !w[movedFirst + i]?.results.length).map(m => m.id);
    await deleteR2Photos([...gone.filter(p => p.storage === 'r2').map(p => p.id), ...orphans]);
    return { removed: gone.length, reminded: due.length ? w[remindAt + 1].meta.changes : 0, trimmed: retain.length, kvDeleted: kvDeleted.length, moved: moved.length - orphans.length };
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

// The statements for every due grant (in the run's write batch): the manager chat where missing, the message, the chat's order and
// unread counts, and reminded_at. A member who left or who blocked the manager (either way) gets
// nothing, and the grant is still marked, so one member is never retried every day.
function remindGradeEnds(due: Due[], now: number) {
    const list = JSON.stringify(due.map(g => {
        const [a, b] = [MANAGER_ID, g.user_id].sort();
        return { gid: g.id, uid: g.user_id, a, b, cid: crypto.randomUUID(), text: `${gradeInfo(g.grade).name} 등급이 ${monthDay(g.expires_at)}에 끝납니다. 연장은 인증/등급 신청에서 6개월을 다시 신청해 주세요.` };
    }));
    const uid = "json_extract(j.value,'$.uid')", pair = "c.user_a=json_extract(j.value,'$.a') AND c.user_b=json_extract(j.value,'$.b')";
    const reachable = `EXISTS(SELECT 1 FROM users m WHERE m.id='${MANAGER_ID}') AND EXISTS(SELECT 1 FROM users t WHERE t.id=${uid} AND t.deleted_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM blocks k WHERE (k.user_id='${MANAGER_ID}' AND k.target_id=${uid}) OR (k.user_id=${uid} AND k.target_id='${MANAGER_ID}'))`;
    return [
        db().prepare(`INSERT OR IGNORE INTO conversations(id,user_a,user_b,created_at,updated_at) SELECT json_extract(j.value,'$.cid'),json_extract(j.value,'$.a'),json_extract(j.value,'$.b'),?,? FROM json_each(?) j WHERE ${reachable}`)
            .bind(now, now, list),
        db().prepare(`INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) SELECT c.id,'${MANAGER_ID}',json_extract(j.value,'$.text'),'system',NULL,'[]',?
            FROM json_each(?) j JOIN conversations c ON ${pair} WHERE ${reachable}`).bind(now, list),
        db().prepare(`UPDATE conversations SET updated_at=?,${UNREAD_RECOUNT} WHERE id IN (SELECT c.id FROM json_each(?) j JOIN conversations c ON ${pair} WHERE ${reachable})`).bind(now, list),
        db().prepare("UPDATE user_grades SET reminded_at=? WHERE id IN (SELECT json_extract(value,'$.gid') FROM json_each(?))").bind(now, list),
    ];
}

type Unfilled = { post_id: number; title_key: string; kind: string; category: string; title: string; details: string; images: string; tags: string | null };
const parseJson = (s: string | null, fallback: any) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

// The prints the migration backfilled (fields NULL) get their canonical fields, fields hash, photo keys
// and title key in one UPDATE. Those posts' photos predate the hashes, so each photo is keyed by its
// upload id, which still matches a relist that reuses the same upload.
async function fillPrints(rows: Unfilled[]) {
    if (!rows.length) return null;
    const list = await Promise.all(rows.map(async r => {
        const fields = listingFields(r.kind, r.category, parseJson(r.details, {}), parseJson(r.tags, []));
        return { id: r.post_id, f: JSON.stringify(fields), h: await fieldsHash(fields), p: JSON.stringify(photoKeys(parseJson(r.images, []), new Map())), k: r.title_key || postTitleKey(r.title) };
    }));
    const rowsJson = JSON.stringify(list), at = (f: string) => `json_extract(value,'$.${f}') AS ${f}`;
    return db().prepare(`UPDATE post_prints SET fields=j.f,fields_hash=j.h,photos=j.p,title_key=j.k
        FROM (SELECT ${['id', 'f', 'h', 'p', 'k'].map(at).join(',')} FROM json_each(?)) j WHERE post_prints.post_id=j.id AND post_prints.fields IS NULL`).bind(rowsJson);
}
