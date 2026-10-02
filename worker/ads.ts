import { db } from './http';
import { PERKS, adSlotsOfRank } from '../shared/membership';
import { SUSPENDED_AUTHORS, baseFilters, postSelect } from './posts';
import type { User } from '../shared/market';

// 광고 (WP53). An ad is always one of the member's own open posts with a '광고' label; members never
// upload anything for it, and ads never change list order (the board list below keeps ORDER BY
// bumped_at DESC, id DESC).
// - Slots: posts.featured_at marks the member's ad posts, at most adSlots (프리미엄 1, 엘리트·관리자 and
//   the manager 3). Create, 끌올 (manual and automatic) stamp it, '광고 고정' (featured_pin 1) keeps a
//   post in a slot, '광고 빼기' (featured_pin -1) keeps it out; adTrimStatement cuts the rest.
// - Shown only while eligible (adWhere): 프리미엄+ from the manager (never the 체험), 본인 인증 (the
//   manager is exempt), no 이용 정지 and no suspension in 30 days, not '광고 제외', the post open, visible,
//   without a pending report and touched in 7 days, and the member seen within pauseDays; a 대리(진행)
//   post also needs 대리 인증 (even for its own author, whom the list filters let see it).
// - Placements: the board top box (page 1, 최신순, the 진행중 view, more than 16 진행중 posts), '비슷한 매물' under a
//   completed post (2), the home '엘리트 매물' row (6, 엘리트 and above). Each reads at most 60
//   candidates through the posts_ad index; the rotation runs here, seeded per 10 minutes.
const DAY = 86400000;
export const AD_CANDIDATES = 60;
export const ROTATE_MS = 600000;
// The board box shows when the tab, with the viewer's filters, has more than this many 진행중 posts.
export const BOX_MIN_OPEN = 16;
export const BOX_SIZE = 3, SIMILAR_SIZE = 2, HOME_SIZE = 6;
const STALE_MS = 7 * DAY, SANCTION_MS = 30 * DAY;

// The author's ad rank: 3 for the manager, else the best unexpired grade the manager granted (a 플러스
// 체험 row never counts). Bind now.
const AD_RANK = "CASE WHEN u.role='manager' THEN 3 ELSE COALESCE((SELECT MAX(g.rank) FROM user_grades g WHERE g.user_id=p.author_id AND g.source='manager' AND (g.expires_at IS NULL OR g.expires_at>?)),0) END";

// The ad candidates: the list columns plus ad_rank, read through the slot posts only.
export function adSelect() {
    return postSelect.replace(' FROM posts p JOIN users u ', `,${AD_RANK} AS ad_rank FROM posts p INDEXED BY posts_ad JOIN users u `);
}

// Eligibility (see above) for authors of at least minRank. pauseDays: 프리미엄 3 days, 엘리트 and above 7.
export function adWhere(now: number, minRank: number) {
    return {
        // The row's own columns first, then the grade (most slot posts of a member without 프리미엄 stop
        // there), then the lookups.
        sql: `p.featured_at IS NOT NULL AND p.featured_pin>=0 AND p.status='open' AND p.hidden=0 AND u.deleted_at IS NULL AND u.ad_off=0
            AND COALESCE(p.touched_at,p.updated_at)>? AND (u.suspended_until IS NULL OR u.suspended_until<=?)
            AND ${AD_RANK}>=?
            AND (u.role='manager' OR (COALESCE(u.last_seen_at,u.created_at)>?-CASE WHEN ${AD_RANK}>=3 THEN ? ELSE ? END
                AND EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=p.author_id AND b.badge='identity')))
            AND (p.kind!='proxy_offer' OR u.role='manager' OR EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=p.author_id AND b.badge='proxy'))
            AND NOT EXISTS(SELECT 1 FROM reports r WHERE r.post_id=p.id AND r.status='pending' AND r.comment_id IS NULL)
            AND NOT EXISTS(SELECT 1 FROM sanctions s WHERE s.user_id=p.author_id AND s.days IS NOT NULL AND s.created_at>?)`,
        args: [now - STALE_MS, now, now, minRank, now, now, PERKS.elite.pauseDays * DAY, PERKS.premium.pauseDays * DAY, now - SANCTION_MS],
    };
}

// A list's filters for the ad read: the suspension subquery is left out (adWhere checks the author's own
// row instead, so no list of suspended members is built for it). Every other filter keeps its values.
export function adFilters(where: string[], values: unknown[]) {
    const at = where.indexOf(SUSPENDED_AUTHORS);
    if (at < 0) return { where, values };
    // Each filter before it binds one value at most: 'p.hidden=0' none, the subquery one.
    const before = where.slice(0, at).reduce((n, w) => n + (w.match(/\?/g) || []).length, 0);
    return { where: where.filter((_, i) => i !== at), values: values.filter((_, i) => i !== before) };
}

// 0 ≤ x < 1 from a string (FNV-1a), so every viewer with the same seed sees the same order.
export function hash01(s: string) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0) / 4294967296;
}

type AdRow = { id: number; author_id: string; role?: string; ad_rank: number; featured_pin: number; featured_at: number };

// One card per advertiser, weighted by how many slot posts the advertiser has here (Efraimidis-Spirakis:
// the advertiser's key is the largest of its posts' seeded keys, which is rand^(1/w) for w posts), at
// most the grade's slots per advertiser. Returns at most `count` rows, best key first.
export function rotate<T extends AdRow>(rows: T[], seed: string, count: number): T[] {
    const ordered = [...rows].sort((a, b) => (b.featured_pin - a.featured_pin) || (b.featured_at - a.featured_at));
    const best = new Map<string, { row: T; key: number; n: number }>();
    for (const row of ordered) {
        const slots = adSlotsOfRank(Number(row.ad_rank) || 0, row.role === 'manager');
        const key = hash01(seed + ':' + row.id), cur = best.get(row.author_id);
        if (!cur) { best.set(row.author_id, { row, key, n: 1 }); continue; }
        if (cur.n >= slots) continue;
        cur.n++;
        if (key > cur.key) { cur.row = row; cur.key = key; }
    }
    return [...best.values()].sort((a, b) => b.key - a.key).slice(0, count).map(b => b.row);
}

// The seed of a board box: the 10-minute bucket, the tab and the viewer's filters (paging and sorting
// left out), so every viewer of the same view sees the same order for 10 minutes.
export function boxSeed(now: number, params: URLSearchParams) {
    const s = new URLSearchParams(params);
    for (const k of ['page', 'sort', 'size', 'featured', 'ads', 'view']) s.delete(k);
    s.sort();
    return `${Math.floor(now / ROTATE_MS)}:box:${s}`;
}

// '비슷한 매물' under a completed post: other advertisers of the same tab (the viewer's blocks apply).
export function similarStatement(post: { kind: string; author_id: string }, u: User | null, now: number) {
    const f = baseFilters(u, null, now), base = adFilters(f.where, f.values), w = adWhere(now, 2);
    return db().prepare(`${adSelect()} WHERE p.kind=? AND ${w.sql} AND p.author_id!=?${u ? ' AND p.author_id!=?' : ''} AND ${base.where.join(' AND ')} ORDER BY p.featured_at DESC LIMIT ${AD_CANDIDATES}`)
        .bind(now, post.kind, ...w.args, post.author_id, ...u ? [u.id] : [], ...base.values);
}
// 2 cards, from the post's category when 2 or more advertisers have one there, seeded per post.
export function pickSimilar<T extends AdRow & { category: string }>(rows: T[], post: { id: number; category: string }, now: number) {
    const same = rows.filter(r => r.category === post.category);
    const pool = new Set(same.map(r => r.author_id)).size >= SIMILAR_SIZE ? same : rows;
    return rotate(pool, `${Math.floor(now / ROTATE_MS)}:similar:${post.id}`, SIMILAR_SIZE);
}

// The home '엘리트 매물' row: 엘리트 and above across every tab.
export function homeAdsStatement(u: User | null, now: number) {
    const f = baseFilters(u, null, now), base = adFilters(f.where, f.values), w = adWhere(now, 3);
    return db().prepare(`${adSelect()} WHERE ${w.sql} AND ${base.where.join(' AND ')} ORDER BY p.featured_at DESC LIMIT ${AD_CANDIDATES}`).bind(now, ...w.args, ...base.values);
}
// The home row's 6 cards, and up to 3 posts for the home bottom card that are never a post of the row:
// other advertisers first (the rotation's next ones), then another slot post of an advertiser already in
// the row (each within its grade's slots), in the same seeded order. No other slot post, no card.
export const HOME_CARD_EXTRA = 3;
export function pickHome<T extends AdRow>(rows: T[], now: number) {
    const seed = `${Math.floor(now / ROTATE_MS)}:home`;
    const picked = rotate(rows, seed, HOME_SIZE + HOME_CARD_EXTRA);
    const row = picked.slice(0, HOME_SIZE), card = picked.slice(HOME_SIZE);
    if (card.length < HOME_CARD_EXTRA) {
        const taken = new Set(picked.map(r => r.id)), counted = new Map<string, number>();
        const more = [...rows].sort((a, b) => (b.featured_pin - a.featured_pin) || (b.featured_at - a.featured_at)).filter(r => {
            const n = (counted.get(r.author_id) || 0) + 1;
            counted.set(r.author_id, n);
            return n <= adSlotsOfRank(Number(r.ad_rank) || 0, r.role === 'manager') && !taken.has(r.id);
        }).sort((a, b) => hash01(seed + ':card:' + b.id) - hash01(seed + ':card:' + a.id));
        card.push(...more.slice(0, HOME_CARD_EXTRA - card.length));
    }
    return { row, card };
}

// ad_rank is internal to the rotation.
export function stripAdRank<T extends { ad_rank?: unknown }>(rows: T[]) {
    for (const r of rows) delete r.ad_rank;
    return rows;
}

// The member's posts that keep a slot: open, visible, not '광고 빼기', 고정 first, then the newest stamp;
// every other featured_at of the member is cleared.
export function adTrimStatement(authorId: string, slots: number) {
    return db().prepare(`UPDATE posts SET featured_at=NULL WHERE author_id=? AND featured_at IS NOT NULL AND id NOT IN (SELECT id FROM posts INDEXED BY posts_ad_author
        WHERE author_id=? AND featured_at IS NOT NULL AND status='open' AND hidden=0 AND featured_pin>=0 ORDER BY featured_pin DESC,featured_at DESC LIMIT ?)`).bind(authorId, authorId, slots);
}
// A free slot takes the member's newest open automatic post without one (its place in time is its
// bumped_at, so it never jumps ahead of newer slot posts). With a guard, only while it holds.
export function adFillStatement(authorId: string, slots: number, now: number, guard = '1', guardArgs: unknown[] = []) {
    return db().prepare(`UPDATE posts SET featured_at=MIN(bumped_at,?) WHERE id=(SELECT id FROM posts INDEXED BY posts_author_bumped WHERE author_id=? AND status='open' AND hidden=0 AND featured_pin=0 AND featured_at IS NULL ORDER BY bumped_at DESC LIMIT 1)
        AND (SELECT COUNT(*) FROM posts INDEXED BY posts_ad_author WHERE author_id=? AND featured_at IS NOT NULL AND status='open' AND hidden=0 AND featured_pin>=0)<? AND ${guard}`).bind(now, authorId, authorId, slots, ...guardArgs);
}
// Set-based trim for the 자동 끌올 tick: list is JSON [{u, a}] (member, slots).
export function adTrimManyStatement(list: string) {
    return db().prepare(`UPDATE posts SET featured_at=NULL WHERE id IN (SELECT x.id FROM (SELECT p.id,p.status,p.hidden,p.featured_pin,j.a,
            ROW_NUMBER() OVER (PARTITION BY p.author_id ORDER BY (p.status='open' AND p.hidden=0 AND p.featured_pin>=0) DESC,p.featured_pin DESC,p.featured_at DESC) AS rn
        FROM (SELECT DISTINCT json_extract(value,'$.u') AS u,json_extract(value,'$.a') AS a FROM json_each(?)) j JOIN posts p INDEXED BY posts_ad_author ON p.author_id=j.u AND p.featured_at IS NOT NULL WHERE j.a>0) x
        WHERE x.rn>x.a OR x.status!='open' OR x.hidden!=0 OR x.featured_pin<0)`).bind(list);
}
