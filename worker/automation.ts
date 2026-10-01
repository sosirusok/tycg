import { db, fail, requireUser, json, body, isManager, isSuspended } from './http';
import { notifyStatement } from './notifications';
import { walletJson } from './posts';
import { TRADE_KINDS, categoriesForKind, type User } from '../shared/market';
import { AUTO_RESERVE, AUTO_TEXT, MANAGER_PERKS, PERKS, gradeInfo, kstDate, kstDayStart, perksOf, perksOfRank, walletOf, type GradeId, type Perks } from '../shared/membership';

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
type Candidate = { id: number; author_id: string; kind: string; bumped_at: number; rn: number };
type Plan = { u: string; n: number; s: string; pa: number | null; b: number | null };

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

// The candidate posts of the due members: listed, open, visible, not under a pending report, touched in
// the last 7 days, past their own gap, not ahead of now (새 글 우선), off page 1 of their board (or
// older than the board window), on a board where the member has nothing in the top 5. Oldest-bumped
// first, at most 5 per member.
function candidatesStatement(members: { u: string; g: number; x: number }[], boards: string, now: number) {
    const k = "p.kind||'/'||p.category";
    return db().prepare(`SELECT id,author_id,kind,bumped_at,rn FROM (SELECT p.id,p.author_id,p.kind,p.bumped_at,ROW_NUMBER() OVER (PARTITION BY p.author_id ORDER BY p.bumped_at,p.id) AS rn
        FROM json_each(?) d JOIN post_auto pa INDEXED BY post_auto_user ON pa.user_id=json_extract(d.value,'$.u') AND pa.bump=1
        JOIN posts p ON p.id=pa.post_id AND p.author_id=pa.user_id
        WHERE p.status='open' AND p.hidden=0 AND p.bumped_at<=? AND (CASE WHEN p.bump_count=0 THEN p.created_at ELSE p.bumped_at END)<=?-json_extract(d.value,'$.g')
            AND COALESCE(p.touched_at,p.updated_at)>? AND NOT EXISTS(SELECT 1 FROM reports r WHERE r.post_id=p.id AND r.status='pending')
            AND (p.kind!='proxy_offer' OR json_extract(d.value,'$.x')=1)
            AND (p.bumped_at<=? OR p.bumped_at<(SELECT json_extract(b.value,'$.c') FROM json_each(?) b WHERE json_extract(b.value,'$.k')=${k}))
            AND NOT EXISTS(SELECT 1 FROM json_each(?) b,json_each(json_extract(b.value,'$.t')) t WHERE json_extract(b.value,'$.k')=${k} AND t.value=p.author_id))
        WHERE rn<=${CANDIDATES}`).bind(JSON.stringify(members), now, now, now - STALE_MS, now - LIST_WINDOW, boards, boards);
}

// How many different members wait for a reply in each due member's chats about their open posts: the
// other side's last text is 24 hours to 7 days old, the member wrote nothing since, neither blocked the
// other and the other has not left. 2 or more pause 자동 끌올; one reply or a block resumes it.
function replyStatement(ids: string[], now: number) {
    return db().prepare(`WITH d(uid) AS (SELECT value FROM json_each(?)),
        cv AS (SELECT d.uid,c.id AS cid,c.user_b AS other FROM d JOIN conversations c INDEXED BY conversations_a_updated ON c.user_a=d.uid AND c.updated_at>?
            UNION ALL SELECT d.uid,c.id AS cid,c.user_a AS other FROM d JOIN conversations c INDEXED BY conversations_b_updated ON c.user_b=d.uid AND c.updated_at>?),
        w AS (SELECT cv.uid,cv.cid,cv.other,(SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id=cv.cid AND m.sender_id=cv.other AND m.type='text') AS last FROM cv)
        SELECT w.uid AS id,COUNT(DISTINCT w.other) AS n FROM w
        WHERE w.last<=? AND w.last>?
            AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=w.cid AND m.sender_id=w.uid AND m.created_at>w.last)
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
        const r2 = await db().batch([candidatesStatement(members, boards, now), ...waitIds.length ? [replyStatement(waitIds, now)] : []]);
        candidates = r2[0].results as Candidate[];
        if (r2[1]) replies = new Map((r2[1].results as { id: string; n: number }[]).map(x => [x.id, num(x.n)]));
    }

    // Paying members before trial members; then the fewest auto bumps today for the grade's day, then
    // the earliest due.
    const share = (d: Due) => num(d.auto_today) / Math.max(1, 24 * 60 / perksFor(num(d.rank), d.role === 'manager').autoEveryMinutes - 2);
    const order = [...looked].sort((a, b) => (Number(!!b.paying || b.role === 'manager') - Number(!!a.paying || a.role === 'manager')) || share(a) - share(b) || num(a.next) - num(b.next));
    const perTab = new Map<string, number>(), bumps: { p: number; u: string; g: number; m: number; r: number }[] = [];
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
        const mine = candidates.filter(c => c.author_id === d.id).sort((a, b) => a.rn - b.rn);
        if (!mine.length) { plans.set(d.id, { u: d.id, n: now + IDLE_MS, s: 'idle', pa: null, b: null }); continue; }
        const pick = mine.find(c => allowed(c.kind));
        if (!pick) { delayed++; plans.set(d.id, { u: d.id, n: now + BUSY_MS, s: 'busy', pa: null, b: null }); continue; }
        perTab.set(pick.kind, (perTab.get(pick.kind) || 0) + 1);
        a60.set(pick.kind, (a60.get(pick.kind) || 0) + 1);
        bumps.push({ p: pick.id, u: d.id, ...w });
        plans.set(d.id, { u: d.id, n: now + perks.autoEveryMinutes * MIN, s: '', pa: null, b: pick.id });
    }
    await db().batch(writeStatements(bumps, [...plans.values()], notices, now, day, delayed));
    return { window: true, bumped: bumps.length, delayed, members: due.length };
}

// Call 3. The posts move only while the post still qualifies and the wallet still holds 3 (2 stay for
// manual use); the wallet, the event (auto=1), auto_today and the counter follow only where the post
// moved at exactly this time. A bump that did not land is looked at again in 10 minutes.
function writeStatements(bumps: { p: number; u: string; g: number; m: number; r: number }[], plans: Plan[], notices: { u: string; f: string; t: string }[], now: number, day: string, delayed: number) {
    const j = `(SELECT json_extract(value,'$.p') AS p,json_extract(value,'$.u') AS u,json_extract(value,'$.g') AS g,json_extract(value,'$.m') AS m,json_extract(value,'$.r') AS r FROM json_each(?))`;
    const list = JSON.stringify(bumps), moved = (col: string) => `EXISTS(SELECT 1 FROM posts mp WHERE mp.id=${col} AND mp.bumped_at=?)`;
    const steps = 'CAST((?-bump_at)/j.r AS INTEGER)';
    const out: D1PreparedStatement[] = [];
    if (bumps.length) out.push(
        db().prepare(`UPDATE posts SET bumped_at=?,bump_count=bump_count+1 FROM ${j} j WHERE posts.id=j.p AND posts.author_id=j.u AND posts.status='open' AND posts.hidden=0 AND posts.bumped_at<=?
            AND (CASE WHEN posts.bump_count=0 THEN posts.created_at ELSE posts.bumped_at END)<=?-j.g
            AND (j.m=0 OR (SELECT MIN(j.m,bump_tokens+CAST((?-bump_at)/j.r AS INTEGER)) FROM users WHERE id=j.u)>?)`).bind(now, list, now, now, now, AUTO_RESERVE),
        db().prepare(`UPDATE users SET bump_tokens=MIN(j.m,bump_tokens+${steps})-1,bump_at=CASE WHEN bump_tokens+${steps}>=j.m THEN ? ELSE bump_at+${steps}*j.r END
            FROM ${j} j WHERE users.id=j.u AND j.m>0 AND ${moved('j.p')}`).bind(now, now, now, now, list, now),
        db().prepare(`INSERT INTO post_events(user_id,post_id,kind,created_at,auto) SELECT j.u,j.p,'bump',?,1 FROM ${j} j WHERE ${moved('j.p')}`).bind(now, list, now),
    );
    if (plans.length) out.push(db().prepare(`UPDATE automation SET bump_next_at=CASE WHEN j.b IS NOT NULL AND NOT ${moved('j.b')} THEN ? ELSE j.n END,
            pause_reason=j.s,paused_at=j.pa,auto_today=auto_today+(j.b IS NOT NULL AND ${moved('j.b')}),updated_at=?
        FROM (SELECT json_extract(value,'$.u') AS u,json_extract(value,'$.n') AS n,json_extract(value,'$.s') AS s,json_extract(value,'$.pa') AS pa,json_extract(value,'$.b') AS b FROM json_each(?)) j
        WHERE automation.user_id=j.u`).bind(now, now + BUSY_MS, now, now, JSON.stringify(plans)));
    if (notices.length) out.push(notifyStatement('auto_paused', "SELECT json_extract(value,'$.u') AS user_id,json_extract(value,'$.f') AS ref,NULL AS post_id,NULL AS actor_id,json_extract(value,'$.t') AS text FROM json_each(?)", [JSON.stringify(notices)], now));
    // The window's counters {day, done, delayed}; the daily cron copies them to 'sys:auto_stats'.
    const done = `(SELECT COUNT(*) FROM json_each(?) WHERE EXISTS(SELECT 1 FROM posts mp WHERE mp.id=json_extract(value,'$.p') AND mp.bumped_at=?))`;
    out.push(db().prepare(`INSERT INTO settings(key,value,updated_at) VALUES('sys:auto_count',json_object('day',?,'done',${done},'delayed',?),?)
        ON CONFLICT(key) DO UPDATE SET value=json_object('day',json_extract(excluded.value,'$.day'),
            'done',CASE WHEN json_extract(settings.value,'$.day')=json_extract(excluded.value,'$.day') THEN COALESCE(json_extract(settings.value,'$.done'),0) ELSE 0 END+json_extract(excluded.value,'$.done'),
            'delayed',CASE WHEN json_extract(settings.value,'$.day')=json_extract(excluded.value,'$.day') THEN COALESCE(json_extract(settings.value,'$.delayed'),0) ELSE 0 END+json_extract(excluded.value,'$.delayed')),
            updated_at=excluded.updated_at`).bind(day, list, now, delayed, now));
    return out;
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

// ---- Enrolment -------------------------------------------------------------------------------------

// How many posts a grade lists (Infinity: all of them).
const slotsOf = (perks: Perks) => perks.autoBumpPosts;

// A grant or the trial: the member's automation row (on, due now, 새 글 자동 포함 for 엘리트 and above)
// and their most recently bumped open posts up to the grade's count. Written only when `guard` holds
// (the grant row was written at this time). force: a manager grant turns 자동 끌올 on again.
export function enrolStatements(userId: string, grade: GradeId, now: number, guard: string, guardArgs: unknown[], force: boolean) {
    const perks = PERKS[grade], slots = slotsOf(perks), elite = gradeInfo(grade).rank >= 3 ? 1 : 0;
    const limit = Number.isFinite(slots) ? `MAX(0,${slots}-(SELECT COUNT(*) FROM post_auto pa JOIN posts q ON q.id=pa.post_id WHERE pa.user_id=? AND pa.bump=1 AND q.status!='closed'))` : '-1';
    return [
        db().prepare(`INSERT INTO automation(user_id,bump_on,bump_new,bump_next_at,updated_at) SELECT ?,1,?,?,? WHERE ${guard}
            ON CONFLICT(user_id) DO UPDATE SET ${force ? 'bump_on=1,' : ''}bump_new=MAX(automation.bump_new,excluded.bump_new),bump_next_at=MIN(COALESCE(automation.bump_next_at,excluded.bump_next_at),excluded.bump_next_at),updated_at=excluded.updated_at`)
            .bind(userId, elite, now, now, ...guardArgs),
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
        ...manager ? [] : [db().prepare('INSERT OR IGNORE INTO automation(user_id,bump_on,bump_new,bump_next_at,updated_at) VALUES(?,1,?,?,?)').bind(u.id, rank >= 3 ? 1 : 0, now, now)],
        db().prepare(`INSERT INTO post_auto(post_id,user_id,bump) SELECT n.id,?,1 FROM ${newPost} n WHERE n.id IS NOT NULL AND EXISTS(SELECT 1 FROM posts WHERE id=n.id AND hidden=0) AND ${room}
            ON CONFLICT(post_id) DO UPDATE SET bump=1`).bind(u.id, ...newArgs, u.id),
    ];
}

// ---- Member routes ---------------------------------------------------------------------------------

const autoAllowed = (u: User) => isManager(u) || gradeInfo(u.grade).rank >= 1;

// GET me/automation: the 자동화 tab. The manager's row is made on first use, off; a member with a grade
// but no row (a grant the previous Worker wrote) gets one, on.
async function automationState(u: User) {
    const now = Date.now(), manager = isManager(u), perks = perksOf(u);
    const r = await db().batch([
        db().prepare('INSERT OR IGNORE INTO automation(user_id,bump_on,bump_new,bump_next_at,updated_at) VALUES(?,?,?,?,?)').bind(u.id, manager ? 0 : 1, gradeInfo(u.grade).rank >= 3 ? 1 : 0, now, now),
        db().prepare('SELECT bump_on,bump_new,bump_next_at,pause_reason,paused_at FROM automation WHERE user_id=?').bind(u.id),
        db().prepare('SELECT bump_tokens,bump_at FROM users WHERE id=?').bind(u.id),
        db().prepare(`SELECT p.id,p.title,p.kind,p.category,p.thumb,CASE WHEN json_valid(p.images) THEN json_extract(p.images,'$[0]') END AS image,p.bumped_at,p.hidden,COALESCE(pa.bump,0) AS auto,
                COALESCE(p.touched_at,p.updated_at)<=? AS stale
            FROM posts p LEFT JOIN post_auto pa ON pa.post_id=p.id WHERE p.author_id=? AND p.status!='closed' ORDER BY COALESCE(pa.bump,0) DESC,p.bumped_at DESC LIMIT 100`).bind(now - STALE_MS, u.id),
        db().prepare(`SELECT ${PAYING('?')} AS paying`).bind(u.id, now),
    ]);
    const a = r[1].results[0] as { bump_on: number; bump_new: number; bump_next_at: number | null; pause_reason: string; paused_at: number | null };
    const posts = (r[3].results as any[]).map(p => ({ ...p, auto: !!p.auto, stale: !!p.stale, hidden: !!p.hidden }));
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
    };
}

// me/automation routes. GET the state; PUT {bumpOn?, bumpNew?}; POST me/automation/continue ('모두 계속':
// every listed open post untouched for 7 days counts as touched now).
export async function automationHandler(req: Request, p: string[]): Promise<Response | null> {
    if (p[1] !== 'automation') return null;
    const u = await requireUser(req), method = req.method, now = Date.now();
    if (!autoAllowed(u)) fail(403, AUTO_TEXT.off);
    if (!p[2] && method === 'GET') return json(await automationState(u));
    if (!p[2] && method === 'PUT') {
        const b = await body(req), sets: string[] = [], args: unknown[] = [];
        if (typeof b.bumpOn === 'boolean') { sets.push('bump_on=?', 'bump_next_at=COALESCE(bump_next_at,?)'); args.push(b.bumpOn ? 1 : 0, now); }
        if (typeof b.bumpNew === 'boolean') {
            if (!isManager(u) && gradeInfo(u.grade).rank < 3) fail(403, '새 글 자동 포함은 엘리트부터 가능합니다.');
            sets.push('bump_new=?'); args.push(b.bumpNew ? 1 : 0);
        }
        if (!sets.length) fail(400, '설정을 확인해 주세요.');
        await automationState(u);
        await db().prepare(`UPDATE automation SET ${sets.join(',')},updated_at=? WHERE user_id=?`).bind(...args, now, u.id).run();
        return json(await automationState(u));
    }
    if (p[2] === 'continue' && !p[3] && method === 'POST') {
        const r = await db().batch([
            db().prepare(`UPDATE posts SET touched_at=? WHERE author_id=? AND status!='closed' AND COALESCE(touched_at,updated_at)<=? AND id IN (SELECT post_id FROM post_auto WHERE user_id=? AND bump=1)`).bind(now, u.id, now - STALE_MS, u.id),
            db().prepare("UPDATE automation SET bump_next_at=? WHERE user_id=? AND pause_reason='idle'").bind(now, u.id),
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
    const row = db().prepare('INSERT OR IGNORE INTO automation(user_id,bump_on,bump_new,bump_next_at,updated_at) VALUES(?,?,?,?,?)').bind(u.id, isManager(u) ? 0 : 1, gradeInfo(u.grade).rank >= 3 ? 1 : 0, now, now);
    // A member resting ('쉬는 중') is looked at on the next tick.
    const wake = db().prepare("UPDATE automation SET bump_next_at=? WHERE user_id=? AND pause_reason='idle'").bind(now, u.id);
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

// The post's own automation for its author (GET posts/:id): the switch and a pending reminder.
export async function postAutoOf(postId: number) {
    const r = await db().prepare('SELECT bump,bump_remind FROM post_auto WHERE post_id=?').bind(postId).first<{ bump: number; bump_remind: number }>();
    return { bump: !!r?.bump, remindAt: r?.bump_remind || null };
}
