import { db, fail, requireUser, json, body } from './http';
import { kstDayStart } from '../shared/membership';
import { alertCounts } from './alerts';

// 알림함 (WP50). Every 알림 is written by an INSERT … SELECT inside the batch of the event that causes it,
// so it commits (or not) with that event and costs no extra D1 call.
// auto_paused, auto_stale and bump_ready come from the 자동 끌올 ticks (WP52).
// keyword, board, follow and condition are the 새 글 알림 of tick B (WP54, worker/alerts.ts).
export type NotifyType = 'fav_price' | 'fav_closed' | 'application' | 'grade_end' | 'hidden' | 'same_listing' | 'auto_paused' | 'auto_stale' | 'bump_ready'
    | 'keyword' | 'board' | 'follow' | 'condition';

// At most this many 알림 per member per KST day; the check reads at most this many index entries.
export const NOTIFY_PER_DAY = 100;
export const NOTIFY_PAGE = 20;
// The header count stops at 99 ('99+').
const COUNT_CAP = 99;

// One INSERT … SELECT. `select` is a SELECT that yields the columns user_id, ref, post_id, actor_id and
// text (its own FROM and WHERE, with `args` bound in order); `guard` is an extra SQL condition (with
// `guardArgs`), such as 'the post was closed by this very request'. A row is written only when:
// - the recipient is a member who has not left, and is not the actor;
// - neither of the two blocked the other;
// - the recipient got fewer than 100 알림 today (KST);
// - the recipient has no unread row of the same type and ref (the notifications_open index), so a
//   repeated event writes nothing until that row is read; a later 가격 내림 (fav_price) instead updates
//   that unread row's text and time, so it shows the latest price (still one row per post).
// The outer SELECT always has a WHERE, which SQLite needs to parse the upsert after INSERT … SELECT.
// type null: the select also yields the type column (키워드 and 게시판 알림 come from one statement).
export function notifyStatement(type: NotifyType | null, select: string, args: unknown[], now: number, guard = '1', guardArgs: unknown[] = []) {
    return db().prepare(`INSERT INTO notifications(user_id,type,ref,post_id,actor_id,text,created_at)
        SELECT x.user_id,${type === null ? 'x.type' : '?'},COALESCE(x.ref,''),x.post_id,x.actor_id,x.text,? FROM (${select}) x
        WHERE x.user_id IS NOT NULL AND x.user_id IS NOT x.actor_id AND ${guard}
        AND EXISTS(SELECT 1 FROM users nu WHERE nu.id=x.user_id AND nu.deleted_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM blocks nb WHERE (nb.user_id=x.user_id AND nb.target_id=x.actor_id) OR (nb.user_id=x.actor_id AND nb.target_id=x.user_id))
        AND NOT EXISTS(SELECT 1 FROM notifications nd WHERE nd.user_id=x.user_id AND nd.created_at>=? LIMIT 1 OFFSET ${NOTIFY_PER_DAY - 1})
        ON CONFLICT(user_id,type,ref) WHERE read_at IS NULL ${type === 'fav_price' ? 'DO UPDATE SET text=excluded.text,created_at=excluded.created_at' : 'DO NOTHING'}`)
        .bind(...type === null ? [] : [type], now, ...args, ...guardArgs, kstDayStart(now));
}

// The favorites of a post as recipients, the post's author as the actor.
export function favoritesNotify(type: 'fav_price' | 'fav_closed', postId: number, authorId: string, text: string, now: number, guard = '1', guardArgs: unknown[] = []) {
    return notifyStatement(type, "SELECT f.user_id,CAST(f.post_id AS TEXT) AS ref,f.post_id,? AS actor_id,? AS text FROM favorites f WHERE f.post_id=?", [authorId, text, postId], now, guard, guardArgs);
}

// One recipient with fixed values.
export function notifyOne(type: NotifyType, userId: string, ref: string, postId: number | null, actorId: string | null, text: string, now: number, guard = '1', guardArgs: unknown[] = []) {
    return notifyStatement(type, 'SELECT ? AS user_id,? AS ref,? AS post_id,? AS actor_id,? AS text', [userId, ref, postId, actorId, text], now, guard, guardArgs);
}

// The header count: unread 알림, at most 99 rows read (notifications_unread). Bind the member's id.
export const ALERTS_COUNT_SQL = `(SELECT COUNT(*) FROM (SELECT 1 FROM notifications WHERE user_id=? AND read_at IS NULL LIMIT ${COUNT_CAP}))`;

type Row = { id: number; type: string; ref: string; post_id: number | null; text: string; created_at: number; read_at: number | null; post_title: string | null; post_thumb: string | null; post_image: string | null };
// The post shows only while the member may see it: not hidden, or their own. The row picture is the
// inline thumbnail (posts.thumb, no image request); the first photo id only for posts saved without one.
const ROW_SQL = `SELECT n.id,n.type,n.ref,n.post_id,n.text,n.created_at,n.read_at,p.title AS post_title,p.thumb AS post_thumb,
    CASE WHEN p.thumb IS NULL AND json_valid(p.images) THEN json_extract(p.images,'$[0]') END AS post_image
    FROM notifications n LEFT JOIN posts p ON p.id=n.post_id AND (p.hidden=0 OR p.author_id=n.user_id)`;
const row = (r: Row) => ({
    id: r.id, type: r.type, ref: r.ref, text: r.text, created_at: r.created_at, read: r.read_at !== null,
    post_id: r.post_id, post: r.post_title === null ? null : { id: r.post_id, title: r.post_title, thumb: r.post_thumb, image: r.post_image },
});

// GET notifications?page=1 (20 per page, newest first), GET notifications/latest (the newest unread row),
// POST notifications/read {id} and POST notifications/read-all.
export async function notificationsHandler(req: Request, p: string[], url: URL): Promise<Response | null> {
    const method = req.method, u = await requireUser(req);
    if (!p[1] && method === 'GET') {
        const page = Number(url.searchParams.get('page') || 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 50) fail(400, '페이지를 확인해 주세요.');
        const r = await db().prepare(`${ROW_SQL} WHERE n.user_id=? ORDER BY n.created_at DESC,n.id DESC LIMIT ? OFFSET ?`).bind(u.id, NOTIFY_PAGE + 1, (page - 1) * NOTIFY_PAGE).all<Row>();
        const alerts = r.results.slice(0, NOTIFY_PAGE).map(row);
        // 새 글 알림 (WP54): unread rows count the matching posts now and carry the board query.
        const counts = await alertCounts(alerts, u);
        return json({ alerts: alerts.map(a => counts.has(a.id) ? { ...a, ...counts.get(a.id) } : a), hasMore: r.results.length > NOTIFY_PAGE, page });
    }
    if (p[1] === 'latest' && !p[2] && method === 'GET') {
        const r = await db().prepare(`${ROW_SQL} WHERE n.user_id=? AND n.read_at IS NULL ORDER BY n.created_at DESC,n.id DESC LIMIT 1`).bind(u.id).first<Row>();
        return json({ alert: r ? row(r) : null });
    }
    if (p[1] === 'read' && !p[2] && method === 'POST') {
        const b = await body(req);
        if (!Number.isSafeInteger(b.id)) fail(400, '알림을 확인해 주세요.');
        await db().prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL').bind(Date.now(), b.id, u.id).run();
        return json({ ok: true });
    }
    if (p[1] === 'read-all' && !p[2] && method === 'POST') {
        await db().prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').bind(Date.now(), u.id).run();
        return json({ ok: true });
    }
    return null;
}
