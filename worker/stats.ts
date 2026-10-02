import { db, fail, requireUser, json, MANAGER_ID } from './http';
import { STATS_RANK, STATS_TEXT, kstDayStart, perksOf } from '../shared/membership';
import { notifyStatement } from './notifications';

// 판매 통계 (WP63, the round-3 WP38 without its banner). Counted views of a post whose author has 'trend'
// or more are kept per hour in post_views (posts.ts countView, 14 days); GET me/stats?post=<id> reads the
// post's own rows only. The 엘리트 주간 요약 is a tick B slice (weeklyStatements).

const HOUR = 3600000, DAY = 24 * HOUR;
// post_views and the 'bump' and 'fresh' post_events are kept this long (cleanup.ts).
export const STATS_KEEP_DAYS = 14;
const WEEK_DAYS = 7;
// '끌올 효과': the last placements of the post, views in the 2 hours before against the 2 hours after.
const EFFECT_EVENTS = 10, EFFECT_HOURS = 2;
// 시세 (엘리트): confirmed 판매 trades of the last 90 days, shown with at least 3 different sellers.
const MARKET_DAYS = 90, MARKET_SELLERS = 3;
// 주간 요약: members written per tick.
const WEEKLY_PER_TICK = 20;

export type MarketTrade = { price: number; seller_id: string; tags: string | null };
type Tag = { tier: string; season: number };
const parseTags = (raw: unknown): Tag[] => { try { const v = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(v) ? v : []; } catch { return []; } };

// The 시세 of a post with these season tags: the confirmed 판매 trades of its category (the caller reads
// them) whose snapshot tags share a tier-season with the post, shown only with MARKET_SELLERS or more
// different sellers. Closed posts without a trade never count. null: nothing to show.
export function marketOf(trades: MarketTrade[], tags: Tag[]) {
    if (!tags.length) return null;
    const want = new Set(tags.map(t => `${t.tier}:${t.season}`));
    const hits = trades.filter(t => typeof t.price === 'number' && parseTags(t.tags).some(x => want.has(`${x?.tier}:${x?.season}`)));
    if (new Set(hits.map(t => t.seller_id)).size < MARKET_SELLERS) return null;
    const prices = hits.map(t => t.price).sort((a, b) => a - b), mid = prices.length >> 1;
    return { n: hits.length, median: prices.length % 2 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2) };
}
// The trades marketOf reads: confirmed, not removed, sold in the last 90 days (trades_market, 0048).
// Bind the earliest confirm time first, then the categories.
export const MARKET_SQL = `SELECT t.category,t.price,t.seller_id,t.tags FROM trades t WHERE t.kind='sell' AND t.removed_at IS NULL AND t.confirmed_at>? AND t.price IS NOT NULL`;
export const marketSince = (now: number) => now - MARKET_DAYS * DAY;

type Placement = { type: 'manual' | 'auto' | 'relist'; at: number };

// GET me/stats?post=<id>: the member's own post. 'basic' (일반, 플러스) → 403. 'trend' (프리미엄): 7 KST days
// of 조회, 찜 and 채팅 (chats opened about the post), 끌올 효과 and 광고 유입. 'full' (엘리트, 관리자, the
// manager) adds views by KST hour of day over 14 days and the 시세. One D1 call after the post lookup.
export async function statsHandler(req: Request, url: URL) {
    const u = await requireUser(req), perks = perksOf(u);
    if (STATS_RANK[perks.stats] < STATS_RANK.trend) fail(403, STATS_TEXT.off);
    const id = Number(url.searchParams.get('post'));
    if (!Number.isSafeInteger(id) || id < 1) fail(404, '게시글을 찾을 수 없습니다.');
    const post = await db().prepare('SELECT id,author_id,kind,category,created_at,relist,promo_views FROM posts WHERE id=?').bind(id).first<any>();
    if (!post || post.author_id !== u.id) fail(404, '게시글을 찾을 수 없습니다.');
    const now = Date.now(), full = perks.stats === 'full';
    const dayStart = kstDayStart(now) - (WEEK_DAYS - 1) * DAY, keepFrom = now - STATS_KEEP_DAYS * DAY;
    const firstHour = Math.floor(Math.min(dayStart, keepFrom) / HOUR) - EFFECT_HOURS;
    const r = await db().batch([
        db().prepare('SELECT hour,n FROM post_views WHERE post_id=? AND hour>=?').bind(id, firstHour),
        db().prepare('SELECT created_at FROM favorites WHERE post_id=? AND created_at>=?').bind(id, dayStart),
        // A chat counts once, on the day it first asked about the post (its first card of the post).
        db().prepare("SELECT MIN(created_at) AS at FROM messages WHERE type='listing' AND reference_id=? GROUP BY conversation_id HAVING MIN(created_at)>=?").bind(String(id), dayStart),
        // The post's 끌올 of the last 14 days (post_events_user: the member's 'bump' rows, then this post).
        db().prepare(`SELECT created_at,auto FROM post_events WHERE user_id=? AND kind='bump' AND created_at>? AND post_id=? ORDER BY created_at DESC LIMIT ${EFFECT_EVENTS + 1}`).bind(u.id, keepFrom, id),
        ...full ? [
            db().prepare('SELECT tier,season FROM post_seasons WHERE post_id=?').bind(id),
            db().prepare(`${MARKET_SQL} AND t.category=?`).bind(marketSince(now), post.category),
        ] : [],
    ]);
    const views = new Map((r[0].results as { hour: number; n: number }[]).map(v => [v.hour, Number(v.n) || 0]));
    const day = (t: number) => Math.floor((t - dayStart) / DAY);
    const days = Array.from({ length: WEEK_DAYS }, (_, i) => ({ start: dayStart + i * DAY, views: 0, favorites: 0, chats: 0 }));
    const add = (t: number, key: 'views' | 'favorites' | 'chats', n = 1) => { const i = day(t); if (i >= 0 && i < WEEK_DAYS) days[i][key] += n; };
    for (const [hour, n] of views) add(hour * HOUR, 'views', n);
    for (const f of r[1].results as { created_at: number }[]) add(f.created_at, 'favorites');
    for (const c of r[2].results as { at: number }[]) add(c.at, 'chats');
    // 끌올 효과: manual and auto 끌올 (post_events auto), and the relist itself (the post's creation, its
    // 'before' being the new post's nothing). The 끌올 a 4th new post or a relist spends when it is written
    // is that placement, not a 끌올 of the post. Only placements whose 2 hours after are over.
    const placements: Placement[] = (r[3].results as { created_at: number; auto: number }[])
        .filter(e => Math.abs(e.created_at - post.created_at) >= 1000)
        .map(e => ({ type: e.auto ? 'auto' as const : 'manual' as const, at: e.created_at }));
    if (post.relist && post.created_at > keepFrom) placements.push({ type: 'relist', at: post.created_at });
    const shown = placements.filter(p => p.at + EFFECT_HOURS * HOUR <= now).sort((a, b) => b.at - a.at).slice(0, EFFECT_EVENTS);
    const sum = (from: number, to: number) => { let n = 0; for (let h = from; h < to; h++) n += views.get(h) || 0; return n; };
    const effect = (['manual', 'auto', 'relist'] as const).map(type => {
        const list = shown.filter(p => p.type === type);
        const before = list.reduce((n, p) => n + sum(Math.floor(p.at / HOUR) - EFFECT_HOURS, Math.floor(p.at / HOUR)), 0);
        const after = list.reduce((n, p) => n + sum(Math.floor(p.at / HOUR), Math.floor(p.at / HOUR) + EFFECT_HOURS), 0);
        const avg = (n: number) => list.length ? Math.round(n / list.length * 10) / 10 : 0;
        return { type, count: list.length, before: avg(before), after: avg(after) };
    }).filter(e => e.count > 0);
    const out: Record<string, unknown> = {
        level: perks.stats, post: post.id,
        days: days.map(d => ({ day: d.start, views: d.views, favorites: d.favorites, chats: d.chats })),
        effect, promoViews: Number(post.promo_views) || 0,
    };
    if (full) {
        // KST hour of day (0-23) over the 14 days kept.
        const hours = Array.from({ length: 24 }, () => 0), firstKept = Math.floor(keepFrom / HOUR);
        for (const [hour, n] of views) if (hour >= firstKept) hours[(hour + 9) % 24] += n;
        out.hours = hours;
        out.market = marketOf(r[5].results as MarketTrade[], r[4].results as Tag[]);
    }
    return json(out);
}

// 엘리트 주간 요약 (tick B): once the KST week start (Monday 10:00) is newer than settings 'sys:weekly_last',
// one 'weekly' 알림 per member with 엘리트 or 관리자 (rank 3 and up) and for the manager, '지난주 조회 12 ·
// 채팅 3 · 끌올 40' over the 7 days before the week start, WEEKLY_PER_TICK members a tick in one set-based
// INSERT; 'sys:weekly_last' moves to the week start (never back) once nobody is left. The third statement
// reads it back for the isolate's memo (weeklyDone), so the slice costs nothing for the rest of the week.
const KST = 9 * HOUR;
export function weekStart(now: number) {
    const day = Math.floor((now + KST) / DAY), monday = day - (day + 3) % 7;
    const start = monday * DAY - KST + 10 * HOUR;
    return start > now ? start - 7 * DAY : start;
}
let weeklyMemo = 0;
// The statements of the slice, or none while this isolate already knows the week is done.
export function weeklyStatements(now: number) {
    const ws = weekStart(now);
    if (ws <= weeklyMemo) return [];
    const from = ws - WEEK_DAYS * DAY, fromHour = Math.floor(from / HOUR), toHour = Math.floor(ws / HOUR), ref = String(ws);
    const due = `CAST(COALESCE((SELECT value FROM settings WHERE key='sys:weekly_last'),'0') AS INTEGER)<?`;
    // Members due: 엘리트 and up (or the manager), not withdrawn, without this week's row.
    const waiting = `FROM (SELECT g.user_id AS id FROM user_grades g WHERE g.rank>=3 AND (g.expires_at IS NULL OR g.expires_at>?) UNION SELECT '${MANAGER_ID}') m
        JOIN users u ON u.id=m.id WHERE u.deleted_at IS NULL AND ${due}
        AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.user_id=u.id AND n.created_at>=? AND n.type='weekly' AND n.ref=?)`;
    const waitingArgs = [now, ws, ws, ref];
    const text = `'지난주 조회 '||(SELECT COALESCE(SUM(v.n),0) FROM posts p JOIN post_views v ON v.post_id=p.id WHERE p.author_id=w.id AND v.hour>=? AND v.hour<?)
        ||' · 채팅 '||(SELECT COUNT(DISTINCT ms.conversation_id) FROM posts p JOIN messages ms ON ms.type='listing' AND ms.reference_id=CAST(p.id AS TEXT) WHERE p.author_id=w.id AND ms.created_at>=? AND ms.created_at<?)
        ||' · 끌올 '||(SELECT COUNT(*) FROM post_events e WHERE e.user_id=w.id AND e.kind='bump' AND e.created_at>=? AND e.created_at<?)`;
    return [
        notifyStatement('weekly', `SELECT w.id AS user_id,? AS ref,NULL AS post_id,NULL AS actor_id,${text} AS text FROM (SELECT u.id ${waiting} ORDER BY u.id LIMIT ${WEEKLY_PER_TICK}) w`,
            [ref, fromHour, toHour, from, ws, from, ws, ...waitingArgs], now),
        db().prepare(`INSERT INTO settings(key,value,updated_at) SELECT 'sys:weekly_last',?,? WHERE NOT EXISTS(SELECT 1 ${waiting})
            ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE CAST(settings.value AS INTEGER)<CAST(excluded.value AS INTEGER)`)
            .bind(String(ws), now, ...waitingArgs),
        db().prepare("SELECT CAST(value AS INTEGER) AS v FROM settings WHERE key='sys:weekly_last'"),
    ];
}
// After the slice ran: remember the week once 'sys:weekly_last' reached it (the results of the statements
// weeklyStatements gave, in order). Returns how many 알림 were written.
export function weeklyDone(results: D1Result[], now: number) {
    if (results.length < 3) return 0;
    const ws = weekStart(now), stored = Number((results[2].results[0] as { v?: number } | undefined)?.v) || 0;
    if (stored >= ws) weeklyMemo = Math.max(weeklyMemo, ws);
    return results[0].meta.changes || 0;
}
