import { db, fail, requireUser, requireActive, json, body, isManager, isSuspended } from './http';
import { notifyStatement } from './notifications';
import { amount, walletJson } from './posts';
import { adTrimManyStatement } from './ads';
import { assertNoBlockedLinks } from './unfurl';
import { TRADE_KINDS, categoriesForKind, priceText, type User } from '../shared/market';
import { AUTO_REPLY_MAX, AUTO_RESERVE, AUTO_TEXT, AWAY_FROM, AWAY_NOW_MS, AWAY_TO, CHAT_AUTO_TEXT, DROP_MAX, DROP_PCTS, DROP_STEPS, DROP_TEXT, MANAGER_PERKS, MATCH_TEXT, TEMPLATE_MAX, PERKS, defaultDropFloor, dropSlotAt, gradeInfo, kstDate, kstDayStart, nextDropPrice, perksOf, perksOfRank, walletOf, type GradeId, type Perks } from '../shared/membership';

// 자동 끌올 (WP52). Two cron ticks share the work:
// - tick A (every 10 minutes, ':00') moves at most one post per due member, only 09:00-02:00 KST;
// - tick B (every 10 minutes, ':05') sends the '끌올 가능' 알림 members asked for.
// Each run stays inside the Free plan's per-invocation limits: at most 8 D1 calls, 45 statements and
// 300 rows handled in JS. The writes come last, set-based (UPDATE … FROM json_each), so a failed run
// writes nothing and the next tick simply looks again.
export const TICK_A = '*/10 * * * *';
export const TICK_B = '5-59/10 * * * *';

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR, KST = 9 * HOUR;
// Members looked at per tick, candidate posts per member, bumps per tab per tick and per tick site-wide.
export const TICK_MEMBERS = 30;
const CANDIDATES = 5, PER_TAB = 1, PER_TICK = 5;
// Daily site cap (settings 'sys:auto_bump_cap' overrides it).
export const AUTO_DAILY_CAP = 400;
// Members paused for no visit and grade-less rows parked per tick (set-based, before the due read).
const AWAY_PER_TICK = 100, PARK_PER_TICK = 500;
const REMINDS_PER_TICK = 100;
// A delayed member (busy board) is looked at again after 10 minutes, one with nothing to bump after 30.
const BUSY_MS = 10 * MIN, IDLE_MS = 30 * MIN;
// Page 1 of a board holds 16 posts; the member's own post in a tab's top 5 also holds the tick back.
const PAGE = 16, TOP = 5;
const STALE_MS = 7 * DAY;
// Boards show posts bumped in the last 30 days (posts.ts LIST_WINDOW).
const LIST_WINDOW = 30 * DAY;

// Every board a member can open: one tab (kind) and one of its categories.
const BOARDS: [string, string][] = TRADE_KINDS.flatMap(k => categoriesForKind(k).map(c => [k, c.id] as [string, string]));

// 09:00 to 02:00 KST.
export function inAutoWindow(now: number) {
    const h = new Date(now + KST).getUTCHours();
    return h >= 9 || h < 2;
}
// The window's day ('2026-10-01' for 09:00 on the 1st through 01:59 on the 2nd), the key of the counters.
export const autoDay = (now: number) => kstDate(now - 4 * HOUR);
// The next time a tick may bump: now inside the window, else 09:00 KST.
function windowNext(t: number) {
    if (inAutoWindow(t)) return t;
    return kstDayStart(t) + 9 * HOUR;
}
// The per-tab hourly cap: auto bumps in a tab stay under min(4, max(2, ⌈O/3⌉)), O being new posts and
// manual 끌올 there in the last hour.
export const tabLimit = (others: number) => Math.min(4, Math.max(2, Math.ceil(others / 3)));

// The member's rank now (0 when every grade ended), from unexpired user_grades. Bind now.
const RANK = (uid: string) => `COALESCE((SELECT MAX(g.rank) FROM user_grades g WHERE g.user_id=${uid} AND (g.expires_at IS NULL OR g.expires_at>?)),0)`;
// A grade the manager granted (not only the 플러스 체험) is unexpired. Bind now.
const PAYING = (uid: string) => `EXISTS(SELECT 1 FROM user_grades g WHERE g.user_id=${uid} AND g.source!='trial' AND g.rank>=1 AND (g.expires_at IS NULL OR g.expires_at>?))`;
const perksFor = (rank: number, manager: boolean): Perks => manager ? MANAGER_PERKS : perksOfRank(rank);
const pauseDays = (rank: number) => rank >= 3 ? 7 : 3;
// The same-post gap, the wallet cap and the refill as the tick binds them (no wallet: m 0).
const walletArgs = (perks: Perks) => ({ g: perks.bumpGapMinutes * MIN, m: Number.isFinite(perks.bumpMax) ? perks.bumpMax : 0, r: perks.bumpRefillMinutes * MIN });

type Due = {
    id: string; next: number; auto_today: number; reason: string; paused_at: number | null; role: string; suspended_until: number | null;
    bump_tokens: number; bump_at: number; last_seen_at: number | null; rank: number; paying: number; proxy: number;
};
// e 1: a real candidate; e 0: one row per member without one, carrying n (listed posts) and f (those
// held back by page 1 or a top-5 place), so the card names the real reason.
type Candidate = { id: number; author_id: string; kind: string; bumped_at: number; rn: number; e: number; n: number; f: number };
type Plan = { u: string; n: number; s: string; pa: number | null; b: number | null };
// One auto bump: post, member, the member's gap, wallet cap and refill, and ad slots (WP53).
type Bump = { p: number; u: string; g: number; m: number; r: number; a: number };

// Members due for a look: on, not paused for 'away', due by now. The rank, whether they pay and the
// wallet come along. Bind now ×4.
const dueSelect = (now: number) => db().prepare(`SELECT a.user_id AS id,a.bump_next_at AS next,a.auto_today,a.pause_reason AS reason,a.paused_at,u.role,u.suspended_until,u.bump_tokens,u.bump_at,COALESCE(u.last_seen_at,u.created_at) AS last_seen_at,
        ${RANK('a.user_id')} AS rank,${PAYING('a.user_id')} AS paying,(u.role='manager' OR EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=a.user_id AND b.badge='proxy')) AS proxy
    FROM automation a INDEXED BY automation_due JOIN users u ON u.id=a.user_id
    WHERE a.bump_on=1 AND a.pause_reason!='away' AND a.bump_next_at<=? AND u.deleted_at IS NULL ORDER BY a.bump_next_at LIMIT ${TICK_MEMBERS}`).bind(now, now, now);

// Members who have not visited for 3 days (7 for 엘리트 and 관리자): one '…접속하지 않아…' 알림 and the
// 'away' pause, which takes them out of the due index until their next visit (currentUser clears it).
function awayStatements(now: number) {
    const set = `SELECT x.user_id,x.rank FROM (SELECT a.user_id,${RANK('a.user_id')} AS rank,COALESCE(u.last_seen_at,u.created_at) AS seen FROM automation a INDEXED BY automation_due JOIN users u ON u.id=a.user_id
        WHERE a.bump_on=1 AND a.pause_reason!='away' AND a.bump_next_at<=? AND u.role!='manager' AND u.deleted_at IS NULL AND COALESCE(u.last_seen_at,u.created_at)<? ORDER BY a.bump_next_at LIMIT ${AWAY_PER_TICK}) x
        WHERE x.rank>=1 AND (x.rank<3 OR x.seen<?)`;
    const args = [now, now, now - 3 * DAY, now - 7 * DAY];
    return [
        notifyStatement('auto_paused', `SELECT s.user_id,'away' AS ref,NULL AS post_id,NULL AS actor_id,CASE WHEN s.rank>=3 THEN ? ELSE ? END AS text FROM (${set}) s`,
            [AUTO_TEXT.away(7), AUTO_TEXT.away(3), ...args], now),
        db().prepare(`UPDATE automation SET pause_reason='away',paused_at=?,updated_at=? WHERE user_id IN (SELECT user_id FROM (${set}))`).bind(now, now, ...args),
    ];
}

// Rows of members whose grades all ended (or who left) leave the due index until a grant wakes them.
const parkStatement = (now: number) => db().prepare(`UPDATE automation SET bump_next_at=NULL WHERE user_id IN (SELECT a.user_id FROM automation a INDEXED BY automation_due JOIN users u ON u.id=a.user_id
    WHERE a.bump_on=1 AND a.pause_reason!='away' AND a.bump_next_at<=? AND u.role!='manager'
    AND (u.deleted_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM user_grades g WHERE g.user_id=a.user_id AND g.rank>=1 AND (g.expires_at IS NULL OR g.expires_at>?))) LIMIT ${PARK_PER_TICK})`).bind(now, now);

// Per board: the bumped_at of its 16th open post (NULL while the board has fewer, so everything is on
// page 1) and the authors of its top 5, from the board index (about 21 index rows per board).
function boardsStatement(now: number) {
    const values = BOARDS.map(() => '(?,?)').join(',');
    const where = "kind=b.column1 AND category=b.column2 AND status!='closed' AND hidden=0 AND bumped_at>?";
    return db().prepare(`SELECT b.column1 AS kind,b.column2 AS category,
            (SELECT bumped_at FROM posts INDEXED BY posts_kind_category_bumped WHERE ${where} ORDER BY bumped_at DESC,id DESC LIMIT 1 OFFSET ${PAGE - 1}) AS cut,
            (SELECT json_group_array(author_id) FROM (SELECT author_id FROM posts INDEXED BY posts_kind_category_bumped WHERE ${where} ORDER BY bumped_at DESC,id DESC LIMIT ${TOP})) AS top
        FROM (VALUES ${values}) b`).bind(now - LIST_WINDOW, now - LIST_WINDOW, ...BOARDS.flat());
}

// The last hour per tab: auto bumps (a60) and everything else (o60: new posts and manual 끌올, one per
// post and time, so a new post's 'post' and 'fresh' rows count once).
const capStatement = (now: number) => db().prepare(`SELECT p.kind,SUM(e.auto) AS a60,COUNT(DISTINCT CASE WHEN e.auto=0 THEN e.post_id||':'||e.created_at END) AS o60
    FROM post_events e INDEXED BY post_events_created JOIN posts p ON p.id=e.post_id WHERE e.created_at>? AND e.created_at<=? AND e.kind IN ('post','fresh','bump') GROUP BY p.kind`).bind(now - HOUR, now);

const settingsStatement = () => db().prepare("SELECT key,value FROM settings WHERE key IN ('sys:auto_bump_cap','sys:auto_count')");

// Monday 10:00 KST: one '자동 끌올 글 12개 확인 필요' per member whose listed open posts include some
// untouched for 7 days (the tick skips those; '모두 계속' brings them back).
function staleNotice(now: number) {
    const d = new Date(now + KST);
    if (d.getUTCDay() !== 1 || d.getUTCHours() !== 10 || d.getUTCMinutes() >= 10) return [];
    return [notifyStatement('auto_stale', `SELECT pa.user_id,? AS ref,NULL AS post_id,NULL AS actor_id,'자동 끌올 글 '||COUNT(*)||'개 확인 필요' AS text
        FROM post_auto pa INDEXED BY post_auto_user JOIN posts p ON p.id=pa.post_id AND p.author_id=pa.user_id JOIN automation a ON a.user_id=pa.user_id AND a.bump_on=1 AND a.bump_next_at IS NOT NULL
        WHERE pa.bump=1 AND p.status='open' AND p.hidden=0 AND COALESCE(p.touched_at,p.updated_at)<=? GROUP BY pa.user_id`, [kstDate(now), now - STALE_MS], now)];
}

// The candidate posts of the due members: listed, open, visible, not under a pending report on the post
// itself (a 댓글 신고 does not count), touched in the last 7 days, past their own gap, not ahead of now
// (새 글 우선), off page 1 of their board (or older than the board window), on a board where the member
// has nothing in the top 5. Oldest-bumped first, at most 5 per member (e=1). A member with none gets one
// e=0 row with n (listed open posts) and f (how many of them page 1 or the top 5 holds back).
function candidatesStatement(members: { u: string; g: number; x: number }[], boards: string, now: number) {
    const k = "p.kind||'/'||p.category";
    return db().prepare(`SELECT id,author_id,kind,bumped_at,rn,e,n,f FROM (
        SELECT q.*,ROW_NUMBER() OVER (PARTITION BY q.author_id,q.e ORDER BY q.bumped_at,q.id) AS rn,COUNT(*) OVER (PARTITION BY q.author_id) AS n,SUM(1-q.off) OVER (PARTITION BY q.author_id) AS f
        FROM (SELECT b0.*,b0.ok*b0.off AS e FROM (SELECT p.id,p.author_id,p.kind,p.bumped_at,
            COALESCE(p.bumped_at<=? AND (CASE WHEN p.bump_count=0 THEN p.created_at ELSE p.bumped_at END)<=?-json_extract(d.value,'$.g')
                AND COALESCE(p.touched_at,p.updated_at)>? AND NOT EXISTS(SELECT 1 FROM reports r WHERE r.post_id=p.id AND r.status='pending' AND r.comment_id IS NULL),0) AS ok,
            COALESCE((p.bumped_at<=? OR p.bumped_at<(SELECT json_extract(b.value,'$.c') FROM json_each(?) b WHERE json_extract(b.value,'$.k')=${k}))
                AND NOT EXISTS(SELECT 1 FROM json_each(?) b,json_each(json_extract(b.value,'$.t')) t WHERE json_extract(b.value,'$.k')=${k} AND t.value=p.author_id),0) AS off
        FROM json_each(?) d JOIN post_auto pa INDEXED BY post_auto_user ON pa.user_id=json_extract(d.value,'$.u') AND pa.bump=1
        JOIN posts p ON p.id=pa.post_id AND p.author_id=pa.user_id
        WHERE p.status='open' AND p.hidden=0 AND (p.kind!='proxy_offer' OR json_extract(d.value,'$.x')=1)) b0) q)
        WHERE (e=1 AND rn<=${CANDIDATES}) OR (e=0 AND rn=1)`).bind(now, now, now - STALE_MS, now - LIST_WINDOW, boards, boards, JSON.stringify(members));
}

// A member whose grade went down (a 6-month 엘리트 that ended, back to 프리미엄 or 플러스) keeps only the
// grade's count listed: the most recently bumped open posts stay (as enrolStatements picks them), the
// rest leave the list. s: the grade's count (finite only).
function trimStatement(members: { u: string; s: number }[]) {
    return db().prepare(`UPDATE post_auto SET bump=0 WHERE bump=1 AND post_id IN (SELECT id FROM (SELECT p.id,json_extract(d.value,'$.s') AS s,ROW_NUMBER() OVER (PARTITION BY pa.user_id ORDER BY p.bumped_at DESC,p.id DESC) AS rn
        FROM json_each(?) d JOIN post_auto pa INDEXED BY post_auto_user ON pa.user_id=json_extract(d.value,'$.u') AND pa.bump=1 JOIN posts p ON p.id=pa.post_id WHERE p.status!='closed') WHERE rn>s)`).bind(JSON.stringify(members));
}

// How many different members wait for a reply in each due member's chats about their open posts: the
// other side's last text is 24 hours to 7 days old, the member typed nothing since (only a typed message,
// text or photo, answers: an 'auto' reply, a system line such as '제시 자동 거절', a card or a 제시 does
// not), neither blocked the other and the other has not left. 2 or more pause 자동 끌올; one reply or a
// block resumes it.
function replyStatement(ids: string[], now: number) {
    return db().prepare(`WITH d(uid) AS (SELECT value FROM json_each(?)),
        cv AS (SELECT d.uid,c.id AS cid,c.user_b AS other FROM d JOIN conversations c INDEXED BY conversations_a_updated ON c.user_a=d.uid AND c.updated_at>?
            UNION ALL SELECT d.uid,c.id AS cid,c.user_a AS other FROM d JOIN conversations c INDEXED BY conversations_b_updated ON c.user_b=d.uid AND c.updated_at>?),
        w AS (SELECT cv.uid,cv.cid,cv.other,(SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id=cv.cid AND m.sender_id=cv.other AND m.type='text') AS last FROM cv)
        SELECT w.uid AS id,COUNT(DISTINCT w.other) AS n FROM w
        WHERE w.last<=? AND w.last>?
            AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=w.cid AND m.sender_id=w.uid AND m.created_at>w.last AND m.type='text')
            AND EXISTS(SELECT 1 FROM posts p WHERE p.author_id=w.uid AND p.status!='closed' AND p.id=(SELECT CASE WHEN m.type='listing' THEN CAST(m.reference_id AS INTEGER) ELSE (SELECT o.post_id FROM offers o WHERE o.id=m.reference_id) END
                FROM messages m WHERE m.conversation_id=w.cid AND m.type IN ('listing','offer') ORDER BY m.id DESC LIMIT 1))
            AND NOT EXISTS(SELECT 1 FROM blocks k WHERE (k.user_id=w.uid AND k.target_id=w.other) OR (k.user_id=w.other AND k.target_id=w.uid))
            AND EXISTS(SELECT 1 FROM users o WHERE o.id=w.other AND o.deleted_at IS NULL)
        GROUP BY w.uid`).bind(JSON.stringify(ids), now - 7 * DAY, now - 7 * DAY, now - DAY, now - 7 * DAY);
}

const num = (v: unknown, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const parseJson = (s: unknown) => { try { return typeof s === 'string' ? JSON.parse(s) : null; } catch { return null; } };

// Tick A. Call 1: the away pauses, the parking, the due members, the boards, the last hour per tab, the
// counters (and on Monday 10:00 the weekly stale notice). Call 2: candidates and reply waits. Call 3:
// every write. Returns what it did, for the log and the tests.
export async function bumpJob(now: number) {
    if (!inAutoWindow(now)) return { window: false, bumped: 0, delayed: 0, members: 0 };
    const head = [...awayStatements(now), parkStatement(now), ...staleNotice(now)];
    const reads = [dueSelect(now), boardsStatement(now), capStatement(now), settingsStatement()];
    const r1 = await db().batch([...head, ...reads]);
    const [dueR, boardsR, capR, settingsR] = r1.slice(head.length);
    const due = dueR.results as Due[];
    if (!due.length) return { window: true, bumped: 0, delayed: 0, members: 0 };
    const settings = new Map((settingsR.results as { key: string; value: string }[]).map(s => [s.key, s.value]));
    const day = autoDay(now);
    const counter = parseJson(settings.get('sys:auto_count'));
    const doneToday = counter?.day === day ? num(counter.done) : 0;
    const cap = Math.max(0, num(settings.get('sys:auto_bump_cap'), AUTO_DAILY_CAP));
    const a60 = new Map<string, number>(), o60 = new Map<string, number>();
    for (const row of capR.results as { kind: string; a60: number; o60: number }[]) { a60.set(row.kind, num(row.a60)); o60.set(row.kind, num(row.o60)); }
    const boards = JSON.stringify((boardsR.results as { kind: string; category: string; cut: number | null; top: string }[])
        .map(b => ({ k: b.kind + '/' + b.category, c: b.cut, t: parseJson(b.top) || [] })));

    // Who may be looked at: a grade (or the manager), and the reasons that stop a member without a read.
    const plans = new Map<string, Plan>(), notices: { u: string; f: string; t: string }[] = [];
    const live = due.filter(d => d.role === 'manager' || num(d.rank) >= 1);
    const looked = live.filter(d => {
        const manager = d.role === 'manager', rank = num(d.rank);
        if (isSuspended(d.suspended_until, now)) { plans.set(d.id, { u: d.id, n: now + IDLE_MS, s: '', pa: null, b: null }); return false; }
        if (!manager && num(d.last_seen_at) < now - pauseDays(rank) * DAY) {
            plans.set(d.id, { u: d.id, n: now, s: 'away', pa: now, b: null });
            notices.push({ u: d.id, f: 'away', t: AUTO_TEXT.away(pauseDays(rank)) });
            return false;
        }
        return true;
    });
    let candidates: Candidate[] = [], replies = new Map<string, number>();
    if (looked.length) {
        const members = looked.map(d => ({ u: d.id, g: walletArgs(perksFor(num(d.rank), d.role === 'manager')).g, x: d.proxy ? 1 : 0 }));
        const waitIds = looked.filter(d => d.role !== 'manager').map(d => d.id);
        // A lower grade's count first (the trim runs before the candidates read, in the same batch).
        const trim = looked.flatMap(d => {
            const slots = perksFor(num(d.rank), d.role === 'manager').autoBumpPosts;
            return Number.isFinite(slots) ? [{ u: d.id, s: slots }] : [];
        });
        const head2 = trim.length ? [trimStatement(trim)] : [];
        const r2 = await db().batch([...head2, candidatesStatement(members, boards, now), ...waitIds.length ? [replyStatement(waitIds, now)] : []]);
        candidates = r2[head2.length].results as Candidate[];
        const rr = r2[head2.length + 1];
        if (rr) replies = new Map((rr.results as { id: string; n: number }[]).map(x => [x.id, num(x.n)]));
    }

    // Paying members before trial members; then the fewest auto bumps today for the grade's day, then
    // the earliest due.
    const share = (d: Due) => num(d.auto_today) / Math.max(1, 24 * 60 / perksFor(num(d.rank), d.role === 'manager').autoEveryMinutes - 2);
    const order = [...looked].sort((a, b) => (Number(!!b.paying || b.role === 'manager') - Number(!!a.paying || a.role === 'manager')) || share(a) - share(b) || num(a.next) - num(b.next));
    const perTab = new Map<string, number>(), bumps: Bump[] = [];
    let delayed = 0;
    const allowed = (kind: string) => (perTab.get(kind) || 0) < PER_TAB && (a60.get(kind) || 0) < tabLimit(o60.get(kind) || 0) && bumps.length < PER_TICK && doneToday + bumps.length < cap;
    for (const d of order) {
        const manager = d.role === 'manager', perks = perksFor(num(d.rank), manager), w = walletArgs(perks);
        if (!manager && (replies.get(d.id) || 0) >= 2) {
            const already = d.reason === 'reply';
            plans.set(d.id, { u: d.id, n: now + BUSY_MS, s: 'reply', pa: already ? d.paused_at ?? now : now, b: null });
            if (!already) notices.push({ u: d.id, f: 'reply', t: AUTO_TEXT.reply });
            continue;
        }
        if (w.m) {
            const wallet = walletOf(num(d.bump_tokens), num(d.bump_at), perks, now);
            if (wallet.tokens <= AUTO_RESERVE) {
                // When the wallet holds 3 again (one refill per interval from the next refill time).
                const at = (wallet.nextRefillAt ?? now) + (AUTO_RESERVE - wallet.tokens) * w.r;
                plans.set(d.id, { u: d.id, n: Math.max(at, now + BUSY_MS), s: 'wallet', pa: null, b: null });
                continue;
            }
        }
        const mine = candidates.filter(c => c.author_id === d.id && num(c.e) === 1).sort((a, b) => a.rn - b.rn);
        if (!mine.length) {
            // 'idle' ('모든 글이 1페이지에 있습니다') only when page 1 or a top-5 place holds back every listed
            // post; any other reason (the gap, 새 글 우선, a report, 7 days unchanged) reads as 'wait'.
            const sum = candidates.find(c => c.author_id === d.id);
            const page1 = !!sum && num(sum.n) > 0 && num(sum.f) === num(sum.n);
            plans.set(d.id, { u: d.id, n: now + IDLE_MS, s: page1 ? 'idle' : 'wait', pa: null, b: null });
            continue;
        }
        const pick = mine.find(c => allowed(c.kind));
        if (!pick) { delayed++; plans.set(d.id, { u: d.id, n: now + BUSY_MS, s: 'busy', pa: null, b: null }); continue; }
        perTab.set(pick.kind, (perTab.get(pick.kind) || 0) + 1);
        a60.set(pick.kind, (a60.get(pick.kind) || 0) + 1);
        bumps.push({ p: pick.id, u: d.id, ...w, a: perks.adSlots });
        plans.set(d.id, { u: d.id, n: now + perks.autoEveryMinutes * MIN, s: '', pa: null, b: pick.id });
    }
    await db().batch(writeStatements(bumps, [...plans.values()], notices, now, day, delayed));
    return { window: true, bumped: bumps.length, delayed, members: due.length, share: { perTab, by: new Set(bumps.map(b => b.u)), n: bumps.length } as TickShare };
}

// What tick A's 자동 끌올 used, so the bump on a price drop in the same tick stays inside the same caps
// (1 per tab, 5 site-wide, one per member).
export type TickShare = { perTab: Map<string, number>; by: Set<string>; n: number };

const moved = (col: string) => `EXISTS(SELECT 1 FROM posts mp WHERE mp.id=${col} AND mp.bumped_at=?)`;
// The guarded auto 끌올 writes (tick A and the bump on a price drop): the posts move only while the post
// still qualifies and the wallet still holds 3 (2 stay for manual use); the wallet, the event (auto=1)
// follow only where the post moved at exactly this time. A moved post of a member with 광고 slots (WP53)
// becomes their newest slot, and the slots are trimmed after.
function bumpStatements(bumps: Bump[], now: number): D1PreparedStatement[] {
    if (!bumps.length) return [];
    const j = `(SELECT json_extract(value,'$.p') AS p,json_extract(value,'$.u') AS u,json_extract(value,'$.g') AS g,json_extract(value,'$.m') AS m,json_extract(value,'$.r') AS r,json_extract(value,'$.a') AS a FROM json_each(?))`;
    const list = JSON.stringify(bumps), steps = 'CAST((?-bump_at)/j.r AS INTEGER)';
    return [
        db().prepare(`UPDATE posts SET bumped_at=?,bump_count=bump_count+1,featured_at=CASE WHEN j.a>0 AND posts.featured_pin>=0 THEN ? ELSE posts.featured_at END
            FROM ${j} j WHERE posts.id=j.p AND posts.author_id=j.u AND posts.status='open' AND posts.hidden=0 AND posts.bumped_at<=?
            AND (CASE WHEN posts.bump_count=0 THEN posts.created_at ELSE posts.bumped_at END)<=?-j.g
            AND (j.m=0 OR (SELECT MIN(j.m,bump_tokens+CAST((?-bump_at)/j.r AS INTEGER)) FROM users WHERE id=j.u)>?)`).bind(now, now, list, now, now, now, AUTO_RESERVE),
        db().prepare(`UPDATE users SET bump_tokens=MIN(j.m,bump_tokens+${steps})-1,bump_at=CASE WHEN bump_tokens+${steps}>=j.m THEN ? ELSE bump_at+${steps}*j.r END
            FROM ${j} j WHERE users.id=j.u AND j.m>0 AND ${moved('j.p')}`).bind(now, now, now, now, list, now),
        db().prepare(`INSERT INTO post_events(user_id,post_id,kind,created_at,auto) SELECT j.u,j.p,'bump',?,1 FROM ${j} j WHERE ${moved('j.p')}`).bind(now, list, now),
        ...bumps.some(b => b.a > 0) ? [adTrimManyStatement(JSON.stringify(bumps.filter(b => b.a > 0).map(b => ({ u: b.u, a: b.a }))))] : [],
    ];
}

// Call 3: the bumps (bumpStatements), then auto_today and the counter, which follow only where the post
// moved at exactly this time. A bump that did not land is looked at again in 10 minutes.
function writeStatements(bumps: Bump[], plans: Plan[], notices: { u: string; f: string; t: string }[], now: number, day: string, delayed: number) {
    const list = JSON.stringify(bumps);
    const out: D1PreparedStatement[] = bumpStatements(bumps, now);
    if (plans.length) out.push(db().prepare(`UPDATE automation SET bump_next_at=CASE WHEN j.b IS NOT NULL AND NOT ${moved('j.b')} THEN ? ELSE j.n END,
            pause_reason=j.s,paused_at=j.pa,auto_today=auto_today+(j.b IS NOT NULL AND ${moved('j.b')}),updated_at=?
        FROM (SELECT json_extract(value,'$.u') AS u,json_extract(value,'$.n') AS n,json_extract(value,'$.s') AS s,json_extract(value,'$.pa') AS pa,json_extract(value,'$.b') AS b FROM json_each(?)) j
        WHERE automation.user_id=j.u`).bind(now, now + BUSY_MS, now, now, JSON.stringify(plans)));
    if (notices.length) out.push(notifyStatement('auto_paused', "SELECT json_extract(value,'$.u') AS user_id,json_extract(value,'$.f') AS ref,NULL AS post_id,NULL AS actor_id,json_extract(value,'$.t') AS text FROM json_each(?)", [JSON.stringify(notices)], now));
    out.push(countStatement(list, now, day, delayed));
    return out;
}

// The window's counters {day, done, delayed}; the daily cron copies them to 'sys:auto_stats'. done counts
// the bumps of the list that landed at exactly this time.
function countStatement(list: string, now: number, day: string, delayed: number) {
    const done = `(SELECT COUNT(*) FROM json_each(?) WHERE EXISTS(SELECT 1 FROM posts mp WHERE mp.id=json_extract(value,'$.p') AND mp.bumped_at=?))`;
    return db().prepare(`INSERT INTO settings(key,value,updated_at) VALUES('sys:auto_count',json_object('day',?,'done',${done},'delayed',?),?)
        ON CONFLICT(key) DO UPDATE SET value=json_object('day',json_extract(excluded.value,'$.day'),
            'done',CASE WHEN json_extract(settings.value,'$.day')=json_extract(excluded.value,'$.day') THEN COALESCE(json_extract(settings.value,'$.done'),0) ELSE 0 END+json_extract(excluded.value,'$.done'),
            'delayed',CASE WHEN json_extract(settings.value,'$.day')=json_extract(excluded.value,'$.day') THEN COALESCE(json_extract(settings.value,'$.delayed'),0) ELSE 0 END+json_extract(excluded.value,'$.delayed')),
            updated_at=excluded.updated_at`).bind(day, list, now, delayed, now);
}

// Tick B: '‘제목’ 글 끌올 가능' for the posts whose reminder time came, once the post can really be bumped
// (its gap, 새 글 우선 and 1 끌올 in the wallet). Not yet: the reminder moves to the new time. A post that
// was completed, hidden or deleted drops its reminder. Two calls, at most 100 rows.
export async function remindJob(now: number) {
    const rows = (await db().prepare(`SELECT pa.post_id,p.title,p.status,p.hidden,p.bumped_at,p.bump_count,p.created_at,u.bump_tokens,u.bump_at,u.role,${RANK('pa.user_id')} AS rank,pa.user_id
        FROM post_auto pa INDEXED BY post_auto_remind JOIN posts p ON p.id=pa.post_id JOIN users u ON u.id=pa.user_id
        WHERE pa.bump_remind>0 AND pa.bump_remind<=? ORDER BY pa.bump_remind LIMIT ${REMINDS_PER_TICK}`).bind(now, now).all<any>()).results;
    if (!rows.length) return { reminded: 0 };
    const send: { u: string; p: number; t: string }[] = [], next: { p: number; t: number }[] = [];
    for (const r of rows) {
        if (r.status !== 'open' || r.hidden) { next.push({ p: r.post_id, t: 0 }); continue; }
        const at = bumpReadyAt(r, perksFor(num(r.rank), r.role === 'manager'), now);
        if (at > now) { next.push({ p: r.post_id, t: at }); continue; }
        send.push({ u: r.user_id, p: r.post_id, t: AUTO_TEXT.ready(r.title) });
        next.push({ p: r.post_id, t: 0 });
    }
    await db().batch([
        ...send.length ? [notifyStatement('bump_ready', "SELECT json_extract(value,'$.u') AS user_id,CAST(json_extract(value,'$.p') AS TEXT) AS ref,json_extract(value,'$.p') AS post_id,NULL AS actor_id,json_extract(value,'$.t') AS text FROM json_each(?)", [JSON.stringify(send)], now)] : [],
        db().prepare(`UPDATE post_auto SET bump_remind=j.t FROM (SELECT json_extract(value,'$.p') AS p,json_extract(value,'$.t') AS t FROM json_each(?)) j WHERE post_auto.post_id=j.p`).bind(JSON.stringify(next)),
    ]);
    return { reminded: send.length };
}

// When a post can be bumped: the latest of its gap, 새 글 우선 (bumped_at ahead of now) and, with an
// empty wallet, the next refill (as posts.ts bumpPost words it).
export function bumpReadyAt(p: { bumped_at: number; bump_count: number; created_at: number; bump_tokens: number; bump_at: number }, perks: Perks, now: number) {
    const gapEnd = (p.bump_count ? p.bumped_at : p.created_at) + perks.bumpGapMinutes * MIN;
    const w = walletOf(num(p.bump_tokens), num(p.bump_at), perks, now);
    const refill = w.tokens < 1 && w.nextRefillAt ? w.nextRefillAt : 0;
    return Math.max(gapEnd, p.bumped_at, refill);
}

// The daily cron's part (in the cleanup's main batch): yesterday's window counts as 'sys:auto_stats'
// (the manager's '자동 끌올 어제 46번 · 지연 120번') and auto_today back to 0.
export function autoDailyStatements(now: number) {
    const day = autoDay(now), field = (f: string) => `COALESCE((SELECT json_extract(value,'$.${f}') FROM settings WHERE key='sys:auto_count' AND json_extract(value,'$.day')=?),0)`;
    return [
        db().prepare(`INSERT INTO settings(key,value,updated_at) VALUES('sys:auto_stats',json_object('day',?,'done',${field('done')},'delayed',${field('delayed')}),?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(day, day, day, now),
        db().prepare('UPDATE automation SET auto_today=0 WHERE auto_today>0'),
    ];
}

// ---- 자동 가격 내리기 (WP56) ------------------------------------------------------------------------

// Due setups per tick (tick A, after 자동 끌올), earliest first.
export const DROP_TICK = 30;
// A tick that comes a little late still lands the next drop on the next slot, not the one after.
const DROP_SLACK = 30 * MIN;

// The member's period: the stored one while the grade allows it, else a day (or the grade's only one).
export function dropEvery(stored: unknown, perks: Perks) {
    const h = num(stored, 24);
    if (perks.priceEveryHours.includes(h)) return h;
    return perks.priceEveryHours.includes(24) || !perks.priceEveryHours.length ? 24 : perks.priceEveryHours[0];
}
// The step as the grade allows it: 5% only for 프리미엄 and up.
export function dropStepOf(a: { drop_step?: number | null; drop_pct?: number | null } | null | undefined, perks: Perks) {
    const pct = perks.pricePct && a?.drop_pct && DROP_PCTS.includes(a.drop_pct) ? a.drop_pct : null;
    const step = a?.drop_step && DROP_STEPS.includes(a.drop_step) ? a.drop_step : DROP_STEPS[0];
    return { step, pct };
}

type DropRow = {
    id: number; u: string; floor: number | null; due: number; cnt: number; title: string; price: number | null; status: string; hidden: number; kind: string;
    cur: number | null; bumped_at: number; bump_count: number; created_at: number; role: string; suspended_until: number | null; deleted_at: number | null;
    bump_tokens: number; bump_at: number; seen: number; rank: number; step: number | null; pct: number | null; every: number | null; pos: number; accepted: number; asked: number;
};
// One looked-at setup: on (0 ends it), the next time, whether the look counts (k: drop_checked_at=now)
// and, for a drop, the old and new price (o, n).
type DropPlan = { p: number; on: number; n: number; k: number; o: number | null; np: number | null };

// The due setups with everything the tick decides on: the post, the owner (rank, wallet, last visit),
// their settings, the setup's place among the owner's running ones (newest switch first, for a lower
// grade's allowance), an accepted 제시, and whether another member sent a 제시 or wrote in a chat about
// the post since the last look (an auto-declined 제시 does not count; a chat message counts only when the
// chat's latest post card or 제시 before it is this post, as the room's pinned bar reads it, and only a
// typed message, so a 제시 card is judged by the offers test alone). Bind now ×2.
function dropDueSelect(now: number) {
    const since = 'COALESCE(pa.drop_checked_at,pa.drop_set_at,0)';
    return db().prepare(`SELECT pa.post_id AS id,pa.user_id AS u,pa.drop_floor AS floor,pa.drop_next_at AS due,pa.drop_count AS cnt,
            p.title,p.price,p.status,p.hidden,p.kind,CAST(json_extract(p.details,'$.currentOffer') AS INTEGER) AS cur,p.bumped_at,p.bump_count,p.created_at,
            u.role,u.suspended_until,u.deleted_at,u.bump_tokens,u.bump_at,COALESCE(u.last_seen_at,u.created_at) AS seen,${RANK('pa.user_id')} AS rank,
            a.drop_step AS step,a.drop_pct AS pct,a.drop_every_h AS every,
            (SELECT COUNT(*) FROM post_auto x WHERE x.user_id=pa.user_id AND x.drop_on=1 AND (x.drop_set_at>pa.drop_set_at OR (x.drop_set_at=pa.drop_set_at AND x.post_id>pa.post_id))) AS pos,
            EXISTS(SELECT 1 FROM offers o WHERE o.post_id=pa.post_id AND o.status='accepted') AS accepted,
            (EXISTS(SELECT 1 FROM offers o WHERE o.post_id=pa.post_id AND o.sender_id!=pa.user_id AND o.created_at>${since} AND NOT (o.status='declined' AND o.updated_at=o.created_at))
                OR EXISTS(SELECT 1 FROM conversations c WHERE c.updated_at>${since}
                    AND c.id IN (SELECT l.conversation_id FROM messages l WHERE l.reference_id=CAST(pa.post_id AS TEXT) AND l.type='listing' UNION SELECT o.conversation_id FROM offers o WHERE o.post_id=pa.post_id)
                    AND EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.sender_id!=pa.user_id AND m.type='text' AND m.created_at>${since}
                        AND (SELECT CASE WHEN k.type='listing' THEN CAST(k.reference_id AS INTEGER) ELSE (SELECT o.post_id FROM offers o WHERE o.id=k.reference_id) END
                            FROM messages k WHERE k.conversation_id=m.conversation_id AND k.type IN ('listing','offer') AND k.id<m.id ORDER BY k.id DESC LIMIT 1)=pa.post_id))) AS asked
        FROM post_auto pa INDEXED BY post_auto_drop_due JOIN posts p ON p.id=pa.post_id JOIN users u ON u.id=pa.user_id LEFT JOIN automation a ON a.user_id=pa.user_id
        WHERE pa.drop_on=1 AND pa.drop_next_at<=? ORDER BY pa.drop_next_at LIMIT ${DROP_TICK}`).bind(now, now);
}

// Tick A, after 자동 끌올. Call 1: the due setups and the last hour per tab. Call 2: every write,
// set-based. For each due setup:
// - the post was completed or deleted, or is no longer a priced 판매 post: the setup ends;
// - the owner has no grade, is under 이용 정지, has not visited for 3 (엘리트 7) days, or the setup is
//   beyond a lower grade's allowance, or the post is hidden: skipped, looked at again one period later;
// - an accepted 제시: held until 수락 취소; a 제시 or a chat message from another member since the last
//   look: held one period (every grade);
// - 10 drops done, the price at the floor, or a 현젯 at or above the next price: the setup ends with an 알림;
// - else the price drops (history, 찜 가격 내림 알림 and 조건 알림 via the history) and, while the wallet
//   holds 3 and the tab's hourly cap allows, the post is bumped with 1 끌올 (an auto=1 event).
export async function dropJob(now: number, share?: TickShare) {
    const [dueR, capR, settingsR] = await db().batch([dropDueSelect(now), capStatement(now), settingsStatement()]);
    const rows = dueR.results as DropRow[];
    if (!rows.length) return { dropped: 0, held: 0, ended: 0, bumped: 0 };
    const a60 = new Map<string, number>(), o60 = new Map<string, number>();
    for (const row of capR.results as { kind: string; a60: number; o60: number }[]) { a60.set(row.kind, num(row.a60)); o60.set(row.kind, num(row.o60)); }
    // The daily cap and today's count (자동 끌올's bumps of this tick are already in it).
    const settings = new Map((settingsR.results as { key: string; value: string }[]).map(s => [s.key, s.value]));
    const day = autoDay(now), counter = parseJson(settings.get('sys:auto_count'));
    const doneToday = counter?.day === day ? num(counter.done) : 0;
    const cap = Math.max(0, num(settings.get('sys:auto_bump_cap'), AUTO_DAILY_CAP));
    const plans: DropPlan[] = [], notices: { u: string; ty: string; p: number; t: string }[] = [], drops: { p: number; u: string; o: number; n: number; t: string }[] = [];
    // The tick's 자동 끌올 counts against the same caps: per tab, site-wide per tick, one per member.
    const bumps: Bump[] = [], bumpedBy = new Set<string>(share?.by), perTab = new Map<string, number>(share?.perTab), before = share?.n ?? 0;
    let held = 0, ended = 0;
    for (const r of rows) {
        const manager = r.role === 'manager', rank = num(r.rank), perks = perksFor(rank, manager);
        const every = dropEvery(r.every, perks), next = dropSlotAt(now + every * HOUR - DROP_SLACK, every);
        const later = (k: number) => plans.push({ p: r.id, on: 1, n: next, k, o: null, np: null });
        const end = (ty?: string, t?: string) => { plans.push({ p: r.id, on: 0, n: next, k: 1, o: null, np: null }); ended++; if (ty && t) notices.push({ u: r.u, ty, p: r.id, t }); };
        if (r.deleted_at || r.status === 'closed' || r.kind !== 'sell' || r.price === null) { end(); continue; }
        const away = !manager && num(r.seen) < now - pauseDays(rank) * DAY;
        if (!manager && (rank < 1 || isSuspended(r.suspended_until, now) || away || num(r.pos) >= perks.autoPricePosts)) { later(0); continue; }
        if (r.hidden) { later(0); continue; }
        if (r.accepted || r.asked) { held++; later(1); continue; }
        if (num(r.cnt) >= DROP_MAX) { end('drop_done', DROP_TEXT.maxed(r.title)); continue; }
        const floor = Math.max(1000, num(r.floor, 1000));
        if (r.price <= floor) { end('drop_done', DROP_TEXT.done(r.title)); continue; }
        const { step, pct } = dropStepOf({ drop_step: r.step, drop_pct: r.pct }, perks);
        const np = nextDropPrice(r.price, floor, step, pct);
        if (r.cur && np <= num(r.cur)) { end('drop_stopped', DROP_TEXT.stopped(r.title)); continue; }
        plans.push({ p: r.id, on: 1, n: next, k: 1, o: r.price, np });
        drops.push({ p: r.id, u: r.u, o: r.price, n: np, t: `가격 내림 · ${r.title} ${priceText(np)}` });
        // The bump: one per member per tick, inside 09:00-02:00, past the same-post gap and 새 글 우선,
        // with 3 끌올 in the wallet, one per tab per tick under the tab's hourly cap.
        const w = walletArgs(perks), kind = r.kind;
        const wallet = w.m ? walletOf(num(r.bump_tokens), num(r.bump_at), perks, now).tokens : Infinity;
        const gapOk = r.bumped_at <= now && (r.bump_count ? r.bumped_at : r.created_at) <= now - w.g;
        if (!bumpedBy.has(r.u) && inAutoWindow(now) && gapOk && wallet > AUTO_RESERVE
            && (perTab.get(kind) || 0) < PER_TAB && (a60.get(kind) || 0) < tabLimit(o60.get(kind) || 0) && before + bumps.length < PER_TICK && doneToday + bumps.length < cap) {
            bumpedBy.add(r.u);
            perTab.set(kind, (perTab.get(kind) || 0) + 1);
            a60.set(kind, (a60.get(kind) || 0) + 1);
            bumps.push({ p: r.id, u: r.u, ...w, a: perks.adSlots });
        }
    }
    await db().batch(dropWrites(plans, drops, notices, bumps, now, day));
    return { dropped: drops.length, held, ended, bumped: bumps.length };
}

// Call 2 of dropJob. The history row and the 찜 알림 go before the price UPDATE (they read the price it
// replaces) and are written only while the post still holds the price the tick read (a manual edit in
// between wins). drop_count grows only where this very drop landed. The UPDATE's '+' terms keep the
// planner on the posts primary key (with the json bound, it otherwise scanned every 판매 post by kind).
function dropWrites(plans: DropPlan[], drops: { p: number; u: string; o: number; n: number; t: string }[], notices: { u: string; ty: string; p: number; t: string }[], bumps: Bump[], now: number, day: string) {
    const out: D1PreparedStatement[] = [];
    if (drops.length) {
        const list = JSON.stringify(drops);
        const j = `(SELECT json_extract(value,'$.p') AS p,json_extract(value,'$.u') AS u,json_extract(value,'$.o') AS o,json_extract(value,'$.n') AS n,json_extract(value,'$.t') AS t FROM json_each(?))`;
        out.push(
            db().prepare(`INSERT INTO post_price_history(post_id,price,changed_at) SELECT j.p,j.o,? FROM ${j} j
                WHERE EXISTS(SELECT 1 FROM posts hp WHERE hp.id=j.p AND hp.price=j.o AND hp.status='open' AND hp.kind='sell' AND hp.hidden=0)`).bind(now, list),
            notifyStatement('fav_price', `SELECT f.user_id,CAST(f.post_id AS TEXT) AS ref,f.post_id,j.u AS actor_id,j.t AS text FROM ${j} j JOIN favorites f ON f.post_id=j.p
                JOIN posts fp ON fp.id=j.p AND fp.price=j.o AND fp.status='open' AND fp.kind='sell' AND fp.hidden=0`, [list], now),
            db().prepare(`UPDATE posts SET price=j.n,price_mode='fixed',updated_at=? FROM ${j} j
                WHERE posts.id=j.p AND posts.price=j.o AND +posts.status='open' AND +posts.kind='sell' AND +posts.hidden=0`).bind(now, list),
        );
    }
    out.push(db().prepare(`UPDATE post_auto SET drop_on=j.on_,drop_next_at=j.n,drop_checked_at=CASE WHEN j.k=1 THEN ? ELSE drop_checked_at END,
            drop_count=drop_count+(j.np IS NOT NULL AND EXISTS(SELECT 1 FROM posts mp WHERE mp.id=j.p AND mp.price=j.np AND mp.updated_at=?))
        FROM (SELECT json_extract(value,'$.p') AS p,json_extract(value,'$.on') AS on_,json_extract(value,'$.n') AS n,json_extract(value,'$.k') AS k,json_extract(value,'$.np') AS np FROM json_each(?)) j
        WHERE post_auto.post_id=j.p AND post_auto.drop_on=1`).bind(now, now, JSON.stringify(plans)));
    if (notices.length) out.push(notifyStatement(null, "SELECT json_extract(value,'$.u') AS user_id,json_extract(value,'$.ty') AS type,CAST(json_extract(value,'$.p') AS TEXT) AS ref,json_extract(value,'$.p') AS post_id,NULL AS actor_id,json_extract(value,'$.t') AS text FROM json_each(?)", [JSON.stringify(notices)], now));
    if (bumps.length) {
        // Counted like 자동 끌올's own bumps: auto_today (the fair-share order) and the day's counter.
        const list = JSON.stringify(bumps);
        out.push(...bumpStatements(bumps, now),
            db().prepare(`UPDATE automation SET auto_today=auto_today+1 WHERE user_id IN (SELECT json_extract(value,'$.u') FROM json_each(?) WHERE ${moved("json_extract(value,'$.p')")})`).bind(list, now),
            countStatement(list, now, day, 0));
    }
    return out;
}

// ---- Enrolment -------------------------------------------------------------------------------------

// How many posts a grade lists (Infinity: all of them).
const slotsOf = (perks: Perks) => perks.autoBumpPosts;

// A grant or the trial: the member's automation row (on, due now, 새 글 자동 포함 for 엘리트 and above)
// and their most recently bumped open posts up to the grade's count. Written only when `guard` holds
// (the grant row was written at this time). force: a manager grant turns 자동 끌올 on again.
// 자동 매칭 (WP58) is on from a 프리미엄 or higher grant too (match_on), and a manager grant turns it on again.
export function enrolStatements(userId: string, grade: GradeId, now: number, guard: string, guardArgs: unknown[], force: boolean) {
    const perks = PERKS[grade], slots = slotsOf(perks), elite = gradeInfo(grade).rank >= 3 ? 1 : 0, match = perks.matchPosts ? 1 : 0;
    const limit = Number.isFinite(slots) ? `MAX(0,${slots}-(SELECT COUNT(*) FROM post_auto pa JOIN posts q ON q.id=pa.post_id WHERE pa.user_id=? AND pa.bump=1 AND q.status!='closed'))` : '-1';
    return [
        db().prepare(`INSERT INTO automation(user_id,bump_on,bump_new,bump_next_at,match_on,updated_at) SELECT ?,1,?,?,?,? WHERE ${guard}
            ON CONFLICT(user_id) DO UPDATE SET ${force ? 'bump_on=1,' : ''}${force && match ? 'match_on=1,' : ''}bump_new=MAX(automation.bump_new,excluded.bump_new),bump_next_at=MIN(COALESCE(automation.bump_next_at,excluded.bump_next_at),excluded.bump_next_at),updated_at=excluded.updated_at`)
            .bind(userId, elite, now, match, now, ...guardArgs),
        db().prepare(`INSERT INTO post_auto(post_id,user_id,bump) SELECT p.id,p.author_id,1 FROM posts p WHERE p.author_id=? AND p.status!='closed' AND p.hidden=0 AND ${guard}
            AND NOT EXISTS(SELECT 1 FROM post_auto x WHERE x.post_id=p.id AND x.bump=1) ORDER BY p.bumped_at DESC,p.id DESC LIMIT ${limit}
            ON CONFLICT(post_id) DO UPDATE SET bump=1`).bind(userId, ...guardArgs, ...Number.isFinite(slots) ? [userId] : []),
    ];
}

// A new post joins the list while the grade has room (엘리트 and above while 새 글 자동 포함 is on). The
// member's row is made here too when a grade exists without one (a grant the previous Worker wrote).
export function newPostEnrolStatements(u: User, newPost: string, newArgs: unknown[], now: number) {
    const manager = isManager(u), rank = gradeInfo(u.grade).rank;
    if (!manager && rank < 1) return [];
    const slots = slotsOf(perksOf(u));
    const room = Number.isFinite(slots)
        ? `(SELECT COUNT(*) FROM post_auto pa JOIN posts q ON q.id=pa.post_id WHERE pa.user_id=? AND pa.bump=1 AND q.status!='closed' AND q.id!=n.id)<${slots}`
        : 'EXISTS(SELECT 1 FROM automation WHERE user_id=? AND bump_new=1)';
    return [
        ...manager ? [] : [rowStatement(u, now)],
        db().prepare(`INSERT INTO post_auto(post_id,user_id,bump) SELECT n.id,?,1 FROM ${newPost} n WHERE n.id IS NOT NULL AND EXISTS(SELECT 1 FROM posts WHERE id=n.id AND hidden=0) AND ${room}
            ON CONFLICT(post_id) DO UPDATE SET bump=1`).bind(u.id, ...newArgs, u.id),
    ];
}

// ---- Member routes ---------------------------------------------------------------------------------

const autoAllowed = (u: User) => isManager(u) || gradeInfo(u.grade).rank >= 1;

// The member's automation row, made on first use when a grade exists without one (a grant the previous
// Worker wrote): 자동 끌올 on (off for the manager), 새 글 자동 포함 for 엘리트 and up, and 자동 매칭 on for
// 프리미엄 and up (WP58; off for the manager, like 자동 끌올).
function rowStatement(u: User, now: number) {
    const manager = isManager(u);
    return db().prepare('INSERT OR IGNORE INTO automation(user_id,bump_on,bump_new,bump_next_at,match_on,updated_at) VALUES(?,?,?,?,?,?)')
        .bind(u.id, manager ? 0 : 1, gradeInfo(u.grade).rank >= 3 ? 1 : 0, now, !manager && perksOf(u).matchPosts ? 1 : 0, now);
}

// GET me/automation: the 자동화 tab. The manager's row is made on first use, off; a member with a grade
// but no row (a grant the previous Worker wrote) gets one, on.
async function automationState(u: User) {
    const now = Date.now(), manager = isManager(u), perks = perksOf(u);
    const r = await db().batch([
        rowStatement(u, now),
        db().prepare(`SELECT bump_on,bump_new,bump_next_at,pause_reason,paused_at,drop_step,drop_pct,drop_every_h,decline_on,match_on,${CHAT_COLUMNS} FROM automation WHERE user_id=?`).bind(u.id),
        db().prepare('SELECT bump_tokens,bump_at FROM users WHERE id=?').bind(u.id),
        db().prepare(`SELECT p.id,p.title,p.kind,p.category,p.thumb,CASE WHEN json_valid(p.images) THEN json_extract(p.images,'$[0]') END AS image,p.bumped_at,p.hidden,COALESCE(pa.bump,0) AS auto,
                COALESCE(p.touched_at,p.updated_at)<=? AS stale,p.price,p.price_mode,CAST(json_extract(p.details,'$.currentOffer') AS INTEGER) AS current_offer,
                COALESCE(pa.drop_on,0) AS drop_on,pa.drop_floor,pa.drop_next_at,COALESCE(pa.drop_count,0) AS drop_count,COALESCE(pa.match,0) AS match_pick
            FROM posts p LEFT JOIN post_auto pa ON pa.post_id=p.id WHERE p.author_id=? AND p.status!='closed' ORDER BY COALESCE(pa.bump,0) DESC,p.bumped_at DESC LIMIT 100`).bind(now - STALE_MS, u.id),
        db().prepare(`SELECT ${PAYING('?')} AS paying`).bind(u.id, now),
    ]);
    const a = r[1].results[0] as { bump_on: number; bump_new: number; bump_next_at: number | null; pause_reason: string; paused_at: number | null; drop_step: number | null; drop_pct: number | null; drop_every_h: number | null; decline_on: number; match_on: number };
    const { step, pct } = dropStepOf(a, perks);
    const matched = new Set(matchedPosts(r[3].results as any[], perks));
    const posts = (r[3].results as any[]).map(p => {
        const { drop_on, drop_floor, drop_next_at, drop_count, match_pick, ...rest } = p;
        return { ...rest, auto: !!p.auto, stale: !!p.stale, hidden: !!p.hidden, drop: dropJson(p, step, pct), ...(p.kind === 'sell' || p.kind === 'buy') && !p.hidden ? { match: matched.has(p.id) } : {} };
    });
    const listed = posts.filter(p => p.auto && !p.hidden);
    // The tick that will look: the first ':00, :10, …' at or after the stored time, inside the window.
    const next = a.bump_next_at === null ? null : windowNext(Math.ceil(Math.max(a.bump_next_at, now) / (10 * MIN)) * 10 * MIN);
    return {
        bumpOn: !!a.bump_on, bumpNew: !!a.bump_new, canBumpNew: manager || gradeInfo(u.grade).rank >= 3,
        state: a.pause_reason, pausedAt: a.paused_at, nextAt: next, everyMin: perks.autoEveryMinutes,
        slots: Number.isFinite(perks.autoBumpPosts) ? perks.autoBumpPosts : null, pauseDays: manager ? null : pauseDays(gradeInfo(u.grade).rank),
        trial: !!u.grade_trial && !(r[4].results[0] as any)?.paying,
        listed: listed.length, stale: listed.filter(p => p.stale).length, posts,
        ...walletJson(r[2].results[0] as any, perks, now),
        // 가격 내리기 (WP56): the card's settings; slots null = every 판매 post.
        drop: {
            slots: Number.isFinite(perks.autoPricePosts) ? perks.autoPricePosts : null, step, pct, everyH: dropEvery(a.drop_every_h, perks),
            everyOptions: perks.priceEveryHours, canPct: perks.pricePct, canDecline: perks.autoDecline, declineOn: perks.autoDecline && !!a.decline_on,
            on: posts.filter(p => p.drop?.on && !p.hidden).length,
        },
        // 채팅 자동화 (WP57): the '채팅' card.
        chat: chatJson(r[1].results[0] as ChatRow, perks, now, manager),
        // 자동 매칭 (WP58), on the '알림' card: the switch, how many posts (null: every one) and '채팅 보내기'.
        match: { on: !!perks.matchPosts && !!a.match_on, slots: Number.isFinite(perks.matchPosts) ? perks.matchPosts : null, chats: perks.matchChats, count: matched.size },
    };
}

// The own posts 자동 매칭 looks at now (worker/match.ts decides the same in SQL): every open 판매·구매 post
// for 엘리트 and up; for 프리미엄 the picked ones (match_pick 1, a post switched off is -1), else the most
// recently bumped. rows: the 자동화 tab's posts (any order).
function matchedPosts(rows: { id: number; kind: string; hidden: number; bumped_at: number; match_pick: number }[], perks: Perks) {
    if (!perks.matchPosts) return [];
    const open = rows.filter(p => !p.hidden && (p.kind === 'sell' || p.kind === 'buy')).sort((x, y) => y.bumped_at - x.bumped_at || y.id - x.id);
    if (!Number.isFinite(perks.matchPosts)) return open.map(p => p.id);
    const chosen = open.some(p => p.match_pick !== 0);
    return (chosen ? open.filter(p => p.match_pick === 1) : open).slice(0, perks.matchPosts).map(p => p.id);
}

// 채팅 자동화 (WP57): own quick replies, '첫 문의 자동 안내' and '자리 비움', all in the member's automation
// row. Empty texts read as the prefilled ones; hours are whole KST hours.
const CHAT_COLUMNS = 'templates,first_on,first_text,away_on,away_from,away_to,away_text,away_until';
type ChatRow = { templates: string; first_on: number; first_text: string; away_on: number; away_from: number | null; away_to: number | null; away_text: string; away_until: number | null };
export function storedTemplates(raw: unknown): string[] {
    try { const v = JSON.parse(String(raw ?? '[]')); return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []; } catch { return []; }
}
// The manager's chats are all manager chats, which never get automatic answers, so the two switches stay hidden.
function chatJson(a: ChatRow | null | undefined, perks: Perks, now: number, manager: boolean) {
    const max = Number.isFinite(perks.replyTemplates) ? perks.replyTemplates : null;
    return {
        templates: storedTemplates(a?.templates).slice(0, max ?? undefined), max, vars: perks.templateVars,
        canFirst: perks.firstReply && !manager, firstOn: perks.firstReply && !!a?.first_on, firstText: a?.first_text || CHAT_AUTO_TEXT.firstDefault,
        canAway: perks.awayReply && !manager, awayOn: perks.awayReply && !!a?.away_on, awayFrom: a?.away_from ?? AWAY_FROM, awayTo: a?.away_to ?? AWAY_TO,
        awayText: a?.away_text || CHAT_AUTO_TEXT.awayDefault, awayUntil: perks.awayReply && a?.away_until && a.away_until > now ? a.away_until : null,
    };
}
// GET me/automation/chat (the chat page): the same settings, one row read, for every grade.
async function chatState(u: User) {
    const a = await db().prepare(`SELECT ${CHAT_COLUMNS} FROM automation WHERE user_id=?`).bind(u.id).first<ChatRow>();
    return chatJson(a, perksOf(u), Date.now(), isManager(u));
}
const CHAT_KEYS = ['templates', 'firstOn', 'firstText', 'awayOn', 'awayFrom', 'awayTo', 'awayText', 'awayNow'];
const hourOf = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 23;
const autoText = (v: unknown) => {
    if (typeof v !== 'string') fail(400, '설정을 확인해 주세요.');
    const t = v.trim();
    if (t.length > AUTO_REPLY_MAX) fail(400, CHAT_AUTO_TEXT.textLong);
    // The prefilled text is stored as '' so it follows later wording changes.
    return t;
};
// The chat fields of PUT me/automation, checked before the 자동 끌올 gate so each names its own grade.
// Returns the SET parts.
function chatSets(b: Record<string, any>, perks: Perks, now: number): { sets: string[]; args: unknown[] } {
    const sets: string[] = [], args: unknown[] = [];
    if (b.templates !== undefined) {
        if (!perks.replyTemplates) fail(403, CHAT_AUTO_TEXT.templatesOff);
        if (!Array.isArray(b.templates) || b.templates.some((t: unknown) => typeof t !== 'string')) fail(400, '설정을 확인해 주세요.');
        const list = [...new Set((b.templates as string[]).map(t => t.trim()).filter(Boolean))];
        if (list.some(t => t.length > TEMPLATE_MAX)) fail(400, CHAT_AUTO_TEXT.templateLong);
        if (list.length > perks.replyTemplates) fail(400, CHAT_AUTO_TEXT.templatesMax(perks.replyTemplates));
        sets.push('templates=?'); args.push(JSON.stringify(list));
    }
    if (b.firstOn !== undefined || b.firstText !== undefined) {
        if (!perks.firstReply) fail(403, CHAT_AUTO_TEXT.firstOff);
        if (b.firstOn !== undefined) { if (typeof b.firstOn !== 'boolean') fail(400, '설정을 확인해 주세요.'); sets.push('first_on=?'); args.push(b.firstOn ? 1 : 0); }
        if (b.firstText !== undefined) { const t = autoText(b.firstText); sets.push('first_text=?'); args.push(t === CHAT_AUTO_TEXT.firstDefault ? '' : t); }
    }
    if (b.awayOn !== undefined || b.awayFrom !== undefined || b.awayTo !== undefined || b.awayText !== undefined || b.awayNow !== undefined) {
        if (!perks.awayReply) fail(403, CHAT_AUTO_TEXT.awayOff);
        if (b.awayOn !== undefined) { if (typeof b.awayOn !== 'boolean') fail(400, '설정을 확인해 주세요.'); sets.push('away_on=?'); args.push(b.awayOn ? 1 : 0); }
        if (b.awayFrom !== undefined || b.awayTo !== undefined) {
            if (!hourOf(b.awayFrom) || !hourOf(b.awayTo) || b.awayFrom === b.awayTo) fail(400, CHAT_AUTO_TEXT.hours);
            sets.push('away_from=?', 'away_to=?'); args.push(b.awayFrom, b.awayTo);
        }
        if (b.awayText !== undefined) { const t = autoText(b.awayText); sets.push('away_text=?'); args.push(t === CHAT_AUTO_TEXT.awayDefault ? '' : t); }
        // '지금 자리 비움': 12 hours from now, then it turns itself off.
        if (b.awayNow !== undefined) { if (typeof b.awayNow !== 'boolean') fail(400, '설정을 확인해 주세요.'); sets.push('away_until=?'); args.push(b.awayNow ? now + AWAY_NOW_MS : null); }
    }
    return { sets, args };
}

// A post's 가격 내리기 for its author: on, 최저가, the next drop time and price, and how many drops so far.
// null for a post that cannot have one (not a priced 판매 post).
export function dropJson(p: { kind: string; price: number | null; price_mode?: string; drop_on?: number | null; drop_floor?: number | null; drop_next_at?: number | null; drop_count?: number | null }, step: number, pct: number | null) {
    if (p.kind !== 'sell' || p.price === null || p.price === undefined) return null;
    const on = !!p.drop_on, floor = on && p.drop_floor ? p.drop_floor : defaultDropFloor(p.price);
    return { on, floor, nextAt: on ? p.drop_next_at ?? null : null, nextPrice: on && p.price > floor ? nextDropPrice(p.price, floor, step, pct) : null, count: Number(p.drop_count) || 0 };
}

// me/automation routes. GET the state; PUT {bumpOn?, bumpNew?}; POST me/automation/continue ('모두 계속':
// every listed open post untouched for 7 days counts as touched now).
export async function automationHandler(req: Request, p: string[]): Promise<Response | null> {
    if (p[1] !== 'automation') return null;
    const u = await requireUser(req), method = req.method, now = Date.now();
    if (p[2] === 'chat' && !p[3] && method === 'GET') return json(await chatState(u));
    // The chat fields (WP57) and '자동 매칭' (WP58) are checked first, so a member without a grade hears
    // which grade they need.
    const put = !p[2] && method === 'PUT' ? await body(req) : null;
    const chat = put ? chatSets(put, perksOf(u), now) : null;
    if (put && put.matchOn !== undefined) {
        if (typeof put.matchOn !== 'boolean') fail(400, '설정을 확인해 주세요.');
        if (!perksOf(u).matchPosts) fail(403, MATCH_TEXT.off);
        chat!.sets.push('match_on=?');
        chat!.args.push(put.matchOn ? 1 : 0);
    }
    // The two automatic answers go out by themselves, so a blocked host is refused on save (WP48).
    if (put) await assertNoBlockedLinks(req, typeof put.firstText === 'string' ? put.firstText : null, typeof put.awayText === 'string' ? put.awayText : null);
    if (!autoAllowed(u)) fail(403, AUTO_TEXT.off);
    if (!p[2] && method === 'GET') return json(await automationState(u));
    if (put && chat) {
        const b = put, sets: string[] = [...chat.sets], args: unknown[] = [...chat.args];
        if (typeof b.bumpOn === 'boolean') { sets.push('bump_on=?', 'bump_next_at=COALESCE(bump_next_at,?)'); args.push(b.bumpOn ? 1 : 0, now); }
        if (typeof b.bumpNew === 'boolean') {
            if (!isManager(u) && gradeInfo(u.grade).rank < 3) fail(403, '새 글 자동 포함은 엘리트부터 가능합니다.');
            sets.push('bump_new=?'); args.push(b.bumpNew ? 1 : 0);
        }
        // 가격 내리기 (WP56): the step (1만원, or 5% for 프리미엄 and up), the period the grade offers and,
        // for 엘리트 and up, '최저가 미만 제시 자동 거절'.
        const perks = perksOf(u);
        if (b.dropStep !== undefined) {
            if (!DROP_STEPS.includes(b.dropStep)) fail(400, DROP_TEXT.step);
            sets.push('drop_step=?', 'drop_pct=NULL'); args.push(b.dropStep);
        }
        if (b.dropPct !== undefined && b.dropStep === undefined) {
            if (b.dropPct !== null && (!perks.pricePct || !DROP_PCTS.includes(b.dropPct))) fail(400, DROP_TEXT.step);
            sets.push('drop_pct=?'); args.push(b.dropPct);
        }
        if (b.dropEveryH !== undefined) {
            if (!perks.priceEveryHours.includes(b.dropEveryH)) fail(400, DROP_TEXT.period);
            sets.push('drop_every_h=?'); args.push(b.dropEveryH);
        }
        if (b.declineOn !== undefined) {
            if (typeof b.declineOn !== 'boolean') fail(400, '설정을 확인해 주세요.');
            if (!perks.autoDecline) fail(403, DROP_TEXT.declineOff);
            sets.push('decline_on=?'); args.push(b.declineOn ? 1 : 0);
        }
        if (!sets.length) fail(400, '설정을 확인해 주세요.');
        // Only chat settings (the chat page's '+' and '지금 자리 비움', the '채팅' card): the row and the chat part.
        if (Object.keys(b).every(k => CHAT_KEYS.includes(k))) {
            await db().batch([
                rowStatement(u, now),
                db().prepare(`UPDATE automation SET ${sets.join(',')},updated_at=? WHERE user_id=?`).bind(...args, now, u.id),
            ]);
            return json({ chat: await chatState(u) });
        }
        await automationState(u);
        await db().prepare(`UPDATE automation SET ${sets.join(',')},updated_at=? WHERE user_id=?`).bind(...args, now, u.id).run();
        return json(await automationState(u));
    }
    // '판매 글 전체' (엘리트 and up, the manager): every open priced 판매 post without a running setup gets
    // one, 최저가 80% of the 즉거가 rounded down to 만원 (posts where that is under 1,000원 are left out).
    if (p[2] === 'drop-all' && !p[3] && method === 'POST') {
        const perks = perksOf(u);
        if (Number.isFinite(perks.autoPricePosts)) fail(403, '판매 글 전체는 엘리트부터 가능합니다.');
        requireActive(u);
        const a = await db().prepare('SELECT drop_every_h FROM automation WHERE user_id=?').bind(u.id).first<{ drop_every_h: number | null }>();
        const every = dropEvery(a?.drop_every_h, perks), next = dropSlotAt(now + every * HOUR, every), floor = '(p.price*4/5)/10000*10000';
        const r = await db().prepare(`INSERT INTO post_auto(post_id,user_id,drop_on,drop_floor,drop_next_at,drop_count,drop_set_at,drop_checked_at)
            SELECT p.id,p.author_id,1,${floor},?,0,?,? FROM posts p WHERE p.author_id=? AND p.kind='sell' AND p.status='open' AND p.hidden=0 AND p.price IS NOT NULL AND p.price_mode!='offer'
                AND ${floor}>=1000 AND ${floor}<p.price
            ON CONFLICT(post_id) DO UPDATE SET drop_on=1,drop_floor=excluded.drop_floor,drop_next_at=excluded.drop_next_at,drop_count=0,drop_set_at=excluded.drop_set_at,drop_checked_at=excluded.drop_checked_at
            WHERE post_auto.drop_on=0`).bind(next, now, now, u.id).run();
        return json({ ok: true, count: r.meta.changes, ...await automationState(u) });
    }
    if (p[2] === 'continue' && !p[3] && method === 'POST') {
        const r = await db().batch([
            db().prepare(`UPDATE posts SET touched_at=? WHERE author_id=? AND status!='closed' AND COALESCE(touched_at,updated_at)<=? AND id IN (SELECT post_id FROM post_auto WHERE user_id=? AND bump=1)`).bind(now, u.id, now - STALE_MS, u.id),
            db().prepare("UPDATE automation SET bump_next_at=? WHERE user_id=? AND pause_reason IN ('idle','wait')").bind(now, u.id),
        ]);
        return json({ ok: true, count: r[0].meta.changes });
    }
    return null;
}

// PUT posts/:id/auto {bump} (the post's '자동 끌올' switch) and {remind} (the waiting 끌올 button: an 알림
// when it can be bumped; every grade). 플러스 moves its one post; 프리미엄 at 5/5 gets 409 with the
// listed posts, for the '뺄 글 선택' sheet.
export async function postAutoHandler(req: Request, u: User, post: any) {
    const b = await body(req), now = Date.now(), perks = perksOf(u);
    if (b.drop !== undefined) return dropSwitch(u, post, b.drop, now);
    if (b.match !== undefined) return matchSwitch(u, post, b.match, now);
    if (typeof b.remind === 'boolean') {
        let at = 0;
        if (b.remind) {
            if (post.status === 'closed' || post.hidden) fail(409, '거래중인 글만 끌올할 수 있습니다.');
            if (!Number.isFinite(perks.bumpMax)) fail(409, '지금 끌올할 수 있습니다.');
            const w = await db().prepare('SELECT bump_tokens,bump_at FROM users WHERE id=?').bind(u.id).first<{ bump_tokens: number; bump_at: number }>();
            at = bumpReadyAt({ ...post, ...w! }, perks, now);
            if (at <= now) fail(409, '지금 끌올할 수 있습니다.');
        }
        await db().prepare('INSERT INTO post_auto(post_id,user_id,bump_remind) VALUES(?,?,?) ON CONFLICT(post_id) DO UPDATE SET bump_remind=excluded.bump_remind').bind(post.id, u.id, at).run();
        return json({ remindAt: at || null });
    }
    if (typeof b.bump !== 'boolean') fail(400, '설정을 확인해 주세요.');
    if (!b.bump) {
        await db().prepare('UPDATE post_auto SET bump=0 WHERE post_id=?').bind(post.id).run();
        return json({ bump: false });
    }
    if (!autoAllowed(u)) fail(403, AUTO_TEXT.off);
    if (post.status === 'closed' || post.hidden) fail(409, '거래중인 글만 자동 끌올할 수 있습니다.');
    const slots = slotsOf(perks);
    const row = rowStatement(u, now);
    // A member resting ('쉬는 중') is looked at on the next tick.
    const wake = db().prepare("UPDATE automation SET bump_next_at=? WHERE user_id=? AND pause_reason IN ('idle','wait')").bind(now, u.id);
    const upsert = (guard: string, args: unknown[]) => db().prepare(`INSERT INTO post_auto(post_id,user_id,bump) SELECT ?,?,1 WHERE ${guard} ON CONFLICT(post_id) DO UPDATE SET bump=1 WHERE ${guard}`)
        .bind(post.id, u.id, ...args, ...args);
    if (slots === 1) {
        const r = await db().batch([row, db().prepare('UPDATE post_auto SET bump=0 WHERE user_id=? AND bump=1 AND post_id!=?').bind(u.id, post.id), upsert('1', []), wake]);
        return json({ bump: true, moved: r[1].meta.changes > 0 });
    }
    if (Number.isFinite(slots)) {
        const others = "(SELECT COUNT(*) FROM post_auto pa JOIN posts q ON q.id=pa.post_id WHERE pa.user_id=? AND pa.bump=1 AND q.status!='closed' AND q.id!=?)<?";
        const r = await db().batch([row, upsert(others, [u.id, post.id, slots]), wake, db().prepare('SELECT bump FROM post_auto WHERE post_id=?').bind(post.id)]);
        if (!(r[3].results[0] as any)?.bump) {
            const listed = await db().prepare(`SELECT p.id,p.title,p.kind,p.thumb,CASE WHEN json_valid(p.images) THEN json_extract(p.images,'$[0]') END AS image FROM post_auto pa JOIN posts p ON p.id=pa.post_id
                WHERE pa.user_id=? AND pa.bump=1 AND p.status!='closed' ORDER BY p.bumped_at DESC`).bind(u.id).all();
            return json({ error: AUTO_TEXT.full(slots), slots, listed: listed.results }, 409);
        }
        return json({ bump: true, moved: false });
    }
    await db().batch([row, upsert('1', []), wake]);
    return json({ bump: true, moved: false });
}

// The post's own automation for its author (GET posts/:id): the switch, a pending reminder and the
// 가격 내리기 status ('다음 내림 10월 2일 20:00 · 27만원', WP56).
export async function postAutoOf(post: { id: number; kind: string; price: number | null; author_id: string }, u: User) {
    const r = await db().prepare(`SELECT pa.bump,pa.bump_remind,pa.drop_on,pa.drop_floor,pa.drop_next_at,pa.drop_count,a.drop_step,a.drop_pct
        FROM (SELECT ? AS id) x LEFT JOIN post_auto pa ON pa.post_id=x.id LEFT JOIN automation a ON a.user_id=?`).bind(post.id, post.author_id).first<any>();
    const { step, pct } = dropStepOf(r, perksOf(u));
    return { bump: !!r?.bump, remindAt: r?.bump_remind || null, drop: dropJson({ ...post, ...r ?? {} }, step, pct) };
}

// 최저가 미만 제시 자동 거절 (WP56): true when the post (alias `post`) has a running 가격 내리기 whose 최저가
// is above the amount, and its author is 엘리트 or above (or the manager) with the switch on. args(amount, now).
export function autoDeclineSql(post: string) {
    return {
        sql: `EXISTS(SELECT 1 FROM post_auto da JOIN automation dz ON dz.user_id=da.user_id JOIN users du ON du.id=da.user_id
            WHERE da.post_id=${post}.id AND da.user_id=${post}.author_id AND da.drop_on=1 AND dz.decline_on=1 AND ?<da.drop_floor AND (du.role='manager' OR ${RANK('da.user_id')}>=3))`,
        args: (amount: number, now: number) => [amount, now],
    };
}

// PUT posts/:id/auto {drop: {on, floor}}: the post's 가격 내리기 (WP56), for 플러스 and up on an open
// priced 판매 post, within the grade's posts (플러스 1, 프리미엄 5, 엘리트 all). Switching on starts the
// schedule (the first drop one period later, at 20:00 KST); a new 최저가 on a running setup keeps it.
// floor null takes 80% of the 즉거가 rounded down to 만원.
async function dropSwitch(u: User, post: any, d: any, now: number) {
    if (!d || typeof d !== 'object' || typeof d.on !== 'boolean') fail(400, '설정을 확인해 주세요.');
    const perks = perksOf(u);
    if (!d.on) {
        await db().prepare('UPDATE post_auto SET drop_on=0 WHERE post_id=?').bind(post.id).run();
        return json({ drop: (await postAutoOf(post, u)).drop });
    }
    if (!perks.autoPricePosts) fail(403, DROP_TEXT.off);
    if (post.kind !== 'sell' || post.price === null || post.price_mode === 'offer') fail(400, DROP_TEXT.priced);
    if (post.status === 'closed' || post.hidden) fail(409, '거래중인 글만 가격 내리기를 할 수 있습니다.');
    requireActive(u);
    const floor = d.floor === null || d.floor === undefined || d.floor === '' ? defaultDropFloor(post.price) : amount(d.floor, false)!;
    if (floor < 1000 || floor >= post.price) fail(400, DROP_TEXT.floor);
    const a = await db().prepare('SELECT drop_every_h FROM automation WHERE user_id=?').bind(u.id).first<{ drop_every_h: number | null }>();
    const every = dropEvery(a?.drop_every_h, perks), next = dropSlotAt(now + every * HOUR, every), slots = perks.autoPricePosts;
    // The other running setups on open posts stay under the grade's count.
    const room = Number.isFinite(slots)
        ? "(SELECT COUNT(*) FROM post_auto x JOIN posts q ON q.id=x.post_id WHERE x.user_id=? AND x.drop_on=1 AND q.status!='closed' AND q.id!=?)<?" : '1';
    const roomArgs = Number.isFinite(slots) ? [u.id, post.id, slots] : [];
    const keep = (col: string) => `${col}=CASE WHEN post_auto.drop_on=1 THEN post_auto.${col} ELSE excluded.${col} END`;
    const r = await db().batch([
        db().prepare(`INSERT INTO post_auto(post_id,user_id,drop_on,drop_floor,drop_next_at,drop_count,drop_set_at,drop_checked_at) SELECT ?,?,1,?,?,0,?,? WHERE ${room}
            ON CONFLICT(post_id) DO UPDATE SET drop_floor=excluded.drop_floor,${keep('drop_next_at')},${keep('drop_count')},${keep('drop_set_at')},${keep('drop_checked_at')},drop_on=1 WHERE ${room}`)
            .bind(post.id, u.id, floor, next, now, now, ...roomArgs, ...roomArgs),
        db().prepare('SELECT drop_on FROM post_auto WHERE post_id=?').bind(post.id),
    ]);
    if (!(r[1].results[0] as any)?.drop_on) fail(409, DROP_TEXT.full(slots));
    return json({ drop: (await postAutoOf(post, u)).drop });
}

// PUT posts/:id/auto {match} (WP58): a 프리미엄 member picks the posts 자동 매칭 looks at ('n/3' chips).
// Until the first pick the 3 most recently bumped open 판매·구매 posts are used; the first change makes
// those picks first, so switching one of them off keeps the other two (a post switched off is -1).
// 엘리트 and up match every open post (nothing to pick).
async function matchSwitch(u: User, post: any, on: unknown, now: number) {
    if (typeof on !== 'boolean') fail(400, '설정을 확인해 주세요.');
    const perks = perksOf(u), slots = perks.matchPosts;
    if (!slots) fail(403, MATCH_TEXT.off);
    if (post.kind !== 'sell' && post.kind !== 'buy') fail(400, MATCH_TEXT.kinds);
    if (!Number.isFinite(slots)) return json({ match: true });
    if (on && (post.status === 'closed' || post.hidden)) fail(409, MATCH_TEXT.open);
    const open = "q.author_id=? AND q.status='open' AND q.hidden=0 AND q.kind IN ('sell','buy')";
    const picks = (sign: string) => `(SELECT COUNT(*) FROM posts q INDEXED BY posts_author_status JOIN post_auto x ON x.post_id=q.id WHERE ${open} AND x.match${sign})`;
    const room = `${picks('=1 AND q.id!=?')}<?`, roomArgs = [u.id, post.id, slots];
    const r = await db().batch([
        db().prepare(`INSERT INTO post_auto(post_id,user_id,match) SELECT q.id,q.author_id,1 FROM posts q INDEXED BY posts_author_status WHERE ${open} AND ${picks('!=0')}=0
            ORDER BY q.bumped_at DESC,q.id DESC LIMIT ? ON CONFLICT(post_id) DO UPDATE SET match=1`).bind(u.id, u.id, slots),
        on ? db().prepare(`INSERT INTO post_auto(post_id,user_id,match) SELECT ?,?,1 WHERE ${room} ON CONFLICT(post_id) DO UPDATE SET match=1 WHERE ${room}`).bind(post.id, u.id, ...roomArgs, ...roomArgs)
            : db().prepare('INSERT INTO post_auto(post_id,user_id,match) VALUES(?,?,-1) ON CONFLICT(post_id) DO UPDATE SET match=-1').bind(post.id, u.id),
        db().prepare('SELECT match FROM post_auto WHERE post_id=?').bind(post.id),
    ]);
    const stored = Number((r[2].results[0] as { match?: number } | undefined)?.match) || 0;
    if (on && stored !== 1) fail(409, MATCH_TEXT.full(slots));
    return json({ match: stored === 1 });
}

// POST posts/bulk {action:'auto', ids, on} (WP58, the 선택 bar's [자동 끌올]): 엘리트 and up (every post can
// be listed) put the chosen open posts in their 자동 끌올 list, or take them out. Returns the ids changed.
export async function bulkAuto(u: User, ids: string, on: boolean, now: number) {
    if (!autoAllowed(u)) fail(403, AUTO_TEXT.off);
    const slots = slotsOf(perksOf(u));
    if (Number.isFinite(slots)) fail(403, AUTO_TEXT.full(slots));
    const mine = "SELECT id FROM posts WHERE id IN (SELECT value FROM json_each(?)) AND author_id=? AND status!='closed' AND hidden=0";
    const r = await db().batch([
        rowStatement(u, now),
        on ? db().prepare(`INSERT INTO post_auto(post_id,user_id,bump) SELECT id,?,1 FROM (${mine}) WHERE 1 ON CONFLICT(post_id) DO UPDATE SET bump=1`).bind(u.id, ids, u.id)
            : db().prepare(`UPDATE post_auto SET bump=0 WHERE post_id IN (${mine}) AND bump=1`).bind(ids, u.id),
        // A member resting ('쉬는 중') is looked at on the next tick.
        db().prepare("UPDATE automation SET bump_next_at=? WHERE user_id=? AND pause_reason IN ('idle','wait')").bind(now, u.id),
        db().prepare(`${mine}`).bind(ids, u.id),
    ]);
    return (r[3].results as { id: number }[]).map(x => x.id);
}
