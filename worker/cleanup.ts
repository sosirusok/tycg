import { db, MANAGER_ID } from './http';
import { STATS_KEEP_DAYS } from './stats';
import { unused } from './files';
import { deleteR2Photos, deleteKvKeys, getKv, putR2, blobBytes, hasBucket, hasKv, counterValue, utcDate } from './storage';
import { UNREAD_RECOUNT } from './chat';
import { postTitleKey } from './posts';
import { PRINT_DAYS } from './prints';
import { printFill, type UnfilledPrint } from '../shared/listing';
import { gradeInfo, trialAlertSoon, TRIAL_ALERT_ENDED } from '../shared/membership';
import { notifyStatement } from './notifications';
import { autoDailyStatements } from './automation';

const DAY = 86400000;
// Photos removed per daily run (one SELECT, one DELETE and one R2 call).
export const PHOTOS_PER_RUN = 100;
const TITLE_KEYS_PER_ROUND = 200;
// Backfilled prints filled per daily run (one SELECT and one UPDATE, committed after the main write batch).
// Each row costs JSON parsing, the canonical fields and a SHA-256 (about 0.1 ms of CPU), and the Free plan
// gives 10 ms per invocation, so 50 rows keep the fill near 5 ms.
export const PRINTS_PER_RUN = 50;
// Open posts written without a print (the previous Worker during a deploy) get one per run, among the
// newest 2,000 post ids (a rowid range, so the read stays small).
const MISSING_PRINTS_PER_RUN = 200;
// Photo retention (decisions item 6): a 완료 post keeps every photo for 90 days, then only its 대표;
// a deleted post's photos are held 30 days for the manager (the posts_delete_hold trigger, 0022).
export const RETAIN_DAYS = 90;
export const RETENTION_PER_RUN = 100;
// Inline thumbnails are cleared on posts completed more than 90 days ago and on open posts not bumped for
// 60 days (an edit makes a new one), which bounds them to about 60 days of posts in D1.
const THUMB_OPEN_DAYS = 60;
const THUMBS_PER_RUN = 2000;
// KV deletes: at most 30 a run, and only while settings 'sys:kv_deletes' ('<UTC date>:<n>') is under 900
// for the UTC day (KV Free allows 1,000 deletes a day and resets at 00:00 UTC). The Workers limits page
// counts KV, R2 and D1 calls as subrequests (50 per invocation on Free; its 1,000 'to internal services'
// is not relied on), and the rest of a run takes at most 15 calls, so 30 keeps the run at 45 or less.
// They run after the main write batch, so a failing KV call never holds back the rest of the cleanup.
// kv_trash keys still count toward the KV size guard while they wait. Tick B (WP52) may take this over
// with more runs a day.
export const KV_DELETES_PER_RUN = 30;
export const KV_DELETES_PER_DAY = 900;
// The R2 mover: once a bucket is bound, at most 3 photos a run are copied into R2: KV ones first, and at
// most 1 D1 photo (its base64 text, up to about 1.9 MB, is read on its own and decoded, which costs CPU).
export const MOVES_PER_RUN = 3;
const D1_MOVES_PER_RUN = 1;

// "10월 7일" on the Korean calendar.
const monthDay = (t: number) => new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

// 알림함 (WP50): read rows go after 14 days, every row after 60, and each member keeps the newest 300;
// one windowed DELETE of at most 2,000 rows a run.
export const ALERTS_DELETES_PER_RUN = 2000;
const ALERTS_KEPT = 300;
// Members trimmed to the newest ALERTS_KEPT per run; others wait for a later run (the 60-day limit
// removes their old rows in any case).
const ALERTS_TRIM_MEMBERS = 50;
// 플러스 무료 체험 reminders per run (each a set-based INSERT … SELECT and an UPDATE).
const TRIAL_ALERTS_PER_RUN = 500;

type Due = { id: number; user_id: string; grade: string; expires_at: number };
type Photo = { id: string; storage: string };
type Movable = { id: string; storage: string; mime: string };

// A 6-month grade that ends within 7 days gets one manager chat message. A 플러스 무료 체험 never does
// (its reminders stay in the app: the member's status line and the home end band). A renewal moves the
// end date, so the grant is reminded again before the new date. Grants outlived by another grant of
// the same or a higher grade are skipped. At most 50 per run.
const dueReminders = (now: number) => db().prepare(`SELECT g.id,g.user_id,g.grade,g.expires_at FROM user_grades g
    WHERE g.source='manager' AND g.expires_at>? AND g.expires_at<=? AND (g.reminded_at IS NULL OR g.reminded_at<g.expires_at-?)
    AND NOT EXISTS(SELECT 1 FROM user_grades o WHERE o.user_id=g.user_id AND o.id!=g.id AND o.rank>=g.rank AND (o.expires_at IS NULL OR o.expires_at>g.expires_at))
    ORDER BY g.expires_at LIMIT 50`).bind(now, now + 7 * DAY, 7 * DAY);

// '10월 9일 14:32' (KST) of an epoch-ms column, in SQL, as kstDateTime words it.
const kstSql = (col: string) => {
    const at = (f: string) => `strftime('${f}',${col}/1000+32400,'unixepoch')`;
    return `CAST(${at('%m')} AS INTEGER)||'월 '||CAST(${at('%d')} AS INTEGER)||'일 '||${at('%H:%M')}`;
};

// The 플러스 무료 체험's 알림 (no manager chat, WP41/WP50). A trial ending within 24 hours gets the
// reminder once (reminded_at=now); a trial that ended (in the last 7 days) and was not seen yet
// (reminded_at NULL or ≥ 0) gets '플러스 무료 체험이 끝났습니다.' once (reminded_at=-2: the 알림 is sent,
// and the home end band stays until the member closes it, which sets -1). A member who holds a paid grade that outlives the trial gets neither row, but the
// trial is still marked so it is not looked at again. Each pair selects the same rows (same order and
// limit): the 알림 first, then the mark.
function trialAlertStatements(now: number) {
    const outlived = (at: string) => `NOT EXISTS(SELECT 1 FROM user_grades o WHERE o.user_id=x.user_id AND o.source!='trial' AND o.rank>=1 AND (o.expires_at IS NULL OR o.expires_at>${at}))`;
    const soon = "g.source='trial' AND g.reminded_at IS NULL AND g.expires_at>? AND g.expires_at<=?", soonArgs = [now, now + DAY];
    const ended = "g.source='trial' AND g.expires_at<=? AND g.expires_at>? AND (g.reminded_at IS NULL OR g.reminded_at>=0)", endedArgs = [now, now - 7 * DAY];
    const [head, tail] = trialAlertSoon('\u0000').split('\u0000');
    return [
        notifyStatement('grade_end', `SELECT g.user_id,g.id||':soon' AS ref,NULL AS post_id,NULL AS actor_id,?||${kstSql('g.expires_at')}||? AS text,g.expires_at
            FROM user_grades g WHERE ${soon} ORDER BY g.id LIMIT ${TRIAL_ALERTS_PER_RUN}`, [head, tail, ...soonArgs], now, outlived('x.expires_at')),
        db().prepare(`UPDATE user_grades SET reminded_at=? WHERE id IN (SELECT g.id FROM user_grades g WHERE ${soon} ORDER BY g.id LIMIT ${TRIAL_ALERTS_PER_RUN})`).bind(now, ...soonArgs),
        notifyStatement('grade_end', `SELECT g.user_id,g.id||':end' AS ref,NULL AS post_id,NULL AS actor_id,? AS text
            FROM user_grades g WHERE ${ended} ORDER BY g.id LIMIT ${TRIAL_ALERTS_PER_RUN}`, [TRIAL_ALERT_ENDED, ...endedArgs], now, outlived('?'), [now]),
        db().prepare(`UPDATE user_grades SET reminded_at=-2 WHERE id IN (SELECT g.id FROM user_grades g WHERE ${ended} ORDER BY g.id LIMIT ${TRIAL_ALERTS_PER_RUN})`).bind(...endedArgs),
    ];
}

// Unused photos the cleanup may remove: uploaded more than a day ago, no post, chat or draft uses them,
// nothing touched them for a day (a lookup that reused a photo, WP44, counts as a use), and the delete
// hold (keep_until) is over. The final DELETE checks all of it again, so a photo reused or attached
// between the read and the write batch is kept.
const removable = (now: number) => {
    const t = Math.floor(now), day = Math.floor(now - DAY);
    return `uploads.created_at<${day} AND COALESCE(uploads.touched_at,0)<${day} AND ${unused} AND COALESCE(uploads.keep_until,0)<${t}`;
};

// Daily housekeeping (cron in wrangler.jsonc): expired sessions, finished rate-limit windows, post
// events older than the caps look back, posts the previous Worker wrote without bumped_at or
// title_key, grade-end reminders, photos that no post, chat message or draft has used for a day, photo
// retention, old thumbnails, the KV delete budget and the R2 mover.
// The Workers Free plan allows 50 subrequests per invocation (KV, R2 and D1 calls included), so the whole
// run is set-based: one read call, at most 2 title-key calls, 3 reads (KV or one D1 photo) and 3 R2 puts
// for the mover, one write batch, one R2 delete, at most 30 KV deletes and one statement that records
// them, the print fill and the meter row (≤ 45 calls), whatever the number of rows. CPU (10 ms on Free) is kept low by the small JS row
// counts: 50 prints, 1 D1 photo and the title keys.
export async function cleanup(now = Date.now()) {
    const kv = hasKv(), mover = hasBucket();
    // Call 1: the housekeeping writes and the reads the rest of the run works from.
    const reads = {
        titles: db().prepare("SELECT id,title FROM posts WHERE title_key='' LIMIT ?").bind(TITLE_KEYS_PER_ROUND),
        due: dueReminders(now),
        photos: db().prepare(`SELECT id,storage FROM uploads WHERE ${removable(now)} LIMIT ?`).bind(PHOTOS_PER_RUN),
        prints: db().prepare(`SELECT pp.post_id,pp.title_key,p.kind,p.category,p.title,p.details,p.images,
            (SELECT json_group_array(json_object('tier',s.tier,'season',s.season)) FROM post_seasons s WHERE s.post_id=p.id) AS tags
            FROM post_prints pp INDEXED BY post_prints_unfilled JOIN posts p ON p.id=pp.post_id WHERE pp.fields IS NULL ORDER BY pp.post_id DESC LIMIT ?`).bind(PRINTS_PER_RUN),
        // 완료 posts past 90 days that still have more than the 대표, without a pending report or a trade
        // recorded in the last 7 days.
        retain: db().prepare(`SELECT p.id FROM posts p WHERE p.status='closed' AND COALESCE(p.closed_at,p.updated_at)<? AND json_valid(p.images) AND json_array_length(p.images)>1
            AND NOT EXISTS(SELECT 1 FROM reports r WHERE r.post_id=p.id AND r.status='pending' AND r.comment_id IS NULL)
            AND NOT EXISTS(SELECT 1 FROM trades t WHERE t.post_id=p.id AND t.created_at>?) LIMIT ?`).bind(now - RETAIN_DAYS * DAY, now - 7 * DAY, RETENTION_PER_RUN),
        trash: db().prepare('SELECT id FROM kv_trash ORDER BY created_at LIMIT ?').bind(kv ? KV_DELETES_PER_RUN : 0),
        kvCount: db().prepare("SELECT value FROM settings WHERE key='sys:kv_deletes'"),
        // KV first (the smaller store), then D1.
        movableKv: db().prepare(`SELECT u.id,u.storage,u.mime FROM uploads u INDEXED BY uploads_movable WHERE u.storage IN ('d1','kv') AND u.storage='kv' LIMIT ?`)
            .bind(mover && kv ? MOVES_PER_RUN : 0),
        movableD1: db().prepare(`SELECT u.id,u.storage,u.mime FROM uploads u INDEXED BY uploads_movable WHERE u.storage IN ('d1','kv') AND u.storage='d1' LIMIT ?`)
            .bind(mover ? D1_MOVES_PER_RUN : 0),
    };
    const names = Object.keys(reads) as (keyof typeof reads)[];
    const house = [
        db().prepare('DELETE FROM sessions WHERE expires_at<?').bind(now),
        db().prepare('DELETE FROM rate_limits WHERE reset_at<?').bind(now),
        // The daily caps look back to KST midnight and the 새 글 placement at most 2 days; 판매 통계 (WP63) keeps
        // 'bump' and 'fresh' rows 14 days ('끌올 효과', the 주간 요약) and post_views 14 days (by post_views_hour).
        db().prepare("DELETE FROM post_events WHERE created_at<? AND (kind NOT IN ('bump','fresh') OR created_at<?)").bind(now - 2 * DAY, now - STATS_KEEP_DAYS * DAY),
        db().prepare('DELETE FROM post_views WHERE hour<?').bind(Math.floor((now - STATS_KEEP_DAYS * DAY) / 3600000)),
        db().prepare('UPDATE posts SET bumped_at=created_at WHERE bumped_at=0'),
        // 같은 매물 (WP44): prints are kept 7 days after the post was completed or deleted, and never for a
        // member who left.
        db().prepare('DELETE FROM post_prints WHERE gone_at<?').bind(now - PRINT_DAYS * DAY),
        db().prepare('DELETE FROM post_prints WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)'),
        // Open posts without a print (written by the previous Worker after 0021 ran) get an empty one,
        // which the fill below completes on later runs.
        db().prepare(`INSERT OR IGNORE INTO post_prints(post_id,user_id,kind,category,title_key,fields) SELECT p.id,p.author_id,p.kind,p.category,p.title_key,NULL FROM posts p
            WHERE p.id>(SELECT COALESCE(MAX(id),0) FROM posts)-2000 AND p.status!='closed' AND NOT EXISTS(SELECT 1 FROM post_prints pp WHERE pp.post_id=p.id)
            AND EXISTS(SELECT 1 FROM users u WHERE u.id=p.author_id AND u.deleted_at IS NULL) LIMIT ?`).bind(MISSING_PRINTS_PER_RUN),
        db().prepare(`UPDATE posts SET thumb=NULL WHERE id IN (SELECT id FROM posts INDEXED BY posts_thumb WHERE thumb IS NOT NULL
            AND ((status='closed' AND COALESCE(closed_at,updated_at)<?) OR (status!='closed' AND bumped_at<?)) LIMIT ?)`).bind(now - RETAIN_DAYS * DAY, now - THUMB_OPEN_DAYS * DAY, THUMBS_PER_RUN),
        // 링크 미리보기 (WP48): cached previews older than 7 days (the posts keep their own cards).
        db().prepare('DELETE FROM link_cache WHERE fetched_at<?').bind(now - 7 * DAY),
        // 알림함 (WP50): the age limits and the newest 300 per member, then the trial's 알림. Only a member
        // who got a row in the last 3 days can have gone over 300 since the last run, so the count reads
        // those members' rows (notifications_user) and the window runs over at most 50 of them, never the
        // whole table.
        db().prepare(`DELETE FROM notifications WHERE id IN (SELECT id FROM notifications INDEXED BY notifications_created WHERE created_at<?
            UNION SELECT id FROM notifications INDEXED BY notifications_created WHERE created_at<? AND read_at IS NOT NULL
            UNION SELECT id FROM (SELECT id,ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC,id DESC) AS rn FROM notifications
                WHERE user_id IN (SELECT user_id FROM notifications WHERE user_id IN (SELECT user_id FROM notifications INDEXED BY notifications_created WHERE created_at>=?)
                    GROUP BY user_id HAVING COUNT(*)>? LIMIT ${ALERTS_TRIM_MEMBERS})) WHERE rn>?
            LIMIT ?)`).bind(now - 60 * DAY, now - 14 * DAY, now - 3 * DAY, ALERTS_KEPT, ALERTS_KEPT, ALERTS_DELETES_PER_RUN),
        ...trialAlertStatements(now),
        // 자동 끌올 (WP52): yesterday's window counts for the manager, and the fair-share counts reset.
        ...autoDailyStatements(now),
    ];
    const r = await db().batch([...house, ...names.map(n => reads[n])]);
    const got = <T>(n: keyof typeof reads) => r[house.length + names.indexOf(n)].results as T[];
    const titles = got<{ id: number; title: string }>('titles'), due = got<Due>('due'), photos = got<Photo>('photos');
    const retain = got<{ id: number }>('retain').map(p => p.id);
    await fillTitleKeys(titles);
    const writes: D1PreparedStatement[] = [];
    const remindAt = writes.length;
    if (due.length) writes.push(...remindGradeEnds(due, now));
    // The R2 mover: copy first, then switch the row only if it still has the old store; the old copy goes
    // after (the D1 bytes in the same batch, the KV key through kv_trash).
    const moved: Photo[] = [];
    for (const m of [...got<Movable>('movableKv'), ...got<Movable>('movableD1')].slice(0, MOVES_PER_RUN)) {
        try {
            const bytes = m.storage === 'd1' ? await d1Bytes(m.id) : await getKv(m.id);
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
    const w = writes.length ? await db().batch(writes) : [];
    const gone = removedAt >= 0 ? w[removedAt].results as Photo[] : [];
    // A photo deleted while it was being copied leaves an R2 object nobody uses: it goes with the rest.
    const orphans = moved.filter((_, i) => !w[movedFirst + i]?.results.length).map(m => m.id);
    await deleteR2Photos([...gone.filter(p => p.storage === 'r2').map(p => p.id), ...orphans]);
    // KV deletes under the day's budget, one by one and after the main batch has committed; only the ids
    // that went leave kv_trash, recorded with the day's counter in one small batch.
    const used = counterValue(got<{ value: string }>('kvCount')[0]?.value, now);
    const trash = got<{ id: string }>('trash').map(t => t.id).slice(0, Math.max(0, Math.min(KV_DELETES_PER_RUN, KV_DELETES_PER_DAY - used)));
    const kvDeleted = trash.length ? await deleteKvKeys(trash) : [];
    if (kvDeleted.length) {
        await db().batch([
            db().prepare('DELETE FROM kv_trash WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(kvDeleted)),
            db().prepare(`INSERT INTO settings(key,value,updated_at) VALUES('sys:kv_deletes',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
                .bind(`${utcDate(now)}:${used + kvDeleted.length}`, now),
        ]);
    }
    // Last, on its own: the print fill, so a slow fill can never keep the work above from committing.
    const prints = await fillPrints(got<UnfilledPrint>('prints'));
    if (prints) await prints.run();
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
// unread counts, reminded_at and the 알림함 row. A member who left or who blocked the manager (either way) gets
// nothing, and the grant is still marked, so one member is never retried every day.
function remindGradeEnds(due: Due[], now: number) {
    const list = JSON.stringify(due.map(g => {
        const [a, b] = [MANAGER_ID, g.user_id].sort();
        return { gid: g.id, uid: g.user_id, a, b, cid: crypto.randomUUID(), ref: `${g.id}:${g.expires_at}`, text: `${gradeInfo(g.grade).name} 등급이 ${monthDay(g.expires_at)}에 끝납니다. 연장은 인증/등급 신청에서 6개월을 다시 신청해 주세요.` };
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
        // The same text in the member's 알림함 (WP50); the manager is the actor, so a block either way skips it.
        notifyStatement('grade_end', `SELECT json_extract(j.value,'$.uid') AS user_id,json_extract(j.value,'$.ref') AS ref,NULL AS post_id,? AS actor_id,json_extract(j.value,'$.text') AS text
            FROM json_each(?) j WHERE j.value IS NOT NULL`, [MANAGER_ID, list], now),
    ];
}

// The bytes of one D1 photo for the mover, read on its own.
async function d1Bytes(id: string) {
    const row = await db().prepare('SELECT data FROM upload_blobs WHERE id=?').bind(id).first<{ data: string }>();
    return row ? blobBytes(row.data) : null;
}

// The prints the migration backfilled (fields NULL) get their canonical fields, fields hash, photo keys
// and title key in one UPDATE (shared/listing.ts printFill).
async function fillPrints(rows: UnfilledPrint[]) {
    if (!rows.length) return null;
    const list = await Promise.all(rows.map(printFill));
    const rowsJson = JSON.stringify(list), at = (f: string) => `json_extract(value,'$.${f}') AS ${f}`;
    return db().prepare(`UPDATE post_prints SET fields=j.f,fields_hash=j.h,photos=j.p,title_key=j.k
        FROM (SELECT ${['id', 'f', 'h', 'p', 'k'].map(at).join(',')} FROM json_each(?)) j WHERE post_prints.post_id=j.id AND post_prints.fields IS NULL`).bind(rowsJson);
}
