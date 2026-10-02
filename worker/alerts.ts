import { db, fail, requireUser, json, body, textField, memberColumns } from './http';
import { notifyStatement } from './notifications';
import { buildPostFilter, latestSeason, needsSeason, qClause, searchWord, tierSearch } from './posts';
import { publicMember } from './community';
import { KIND_NAMES, LATEST_SEASON, TRADE_KINDS, categoriesForKind, categoryName, skinsForWord, type User } from '../shared/market';
import { ALERT_TEXT, MANAGER_PERKS, SITE_RULES, perksOf, perksOfRank, type Perks } from '../shared/membership';

// 새 글 알림 (WP54).
// - 키워드 알림 (a saved search of a tab with a search word) and 게시판 새 글 알림 (a tab and category
//   with no word): every grade, SITE_RULES.keywordAlerts per member, inside the 20 saved searches.
// - 판매자 구독: every grade, SITE_RULES.follows per member; the followed member's '구독 허용' decides.
// - 조건 알림 (a saved search with any other filter): perks.filterAlerts (플러스 3, 프리미엄 10, 엘리트 20),
//   새 글 for 플러스 and 새 글 · 가격 내림 for 프리미엄 and up (perks.filterAlertEvents).
// Tick B (alertJob) matches new posts with the same SQL the board runs (qClause, buildPostFilter), so an
// 알림 never promises a post the board would not show. A relist (WP44, posts.relist=1) never sends any.

const MIN = 60000;
// Posts are read 60 seconds behind now, so a post committed while a tick reads is never skipped.
export const ALERT_LAG = MIN;
// At most this many posts (and price drops) per window; the first window after a deploy looks back 11
// minutes (one tick and the lag).
const WINDOW_POSTS = 40, FIRST_LOOK_BACK = 11 * MIN;
// 조건 알림 read per tick, and the statements, bound parameters and SQL size of their reads.
// D1 allows 100 result columns and 5 terms in a compound SELECT, so one read checks up to 90 알림 as
// columns of one SELECT over the window's posts (no UNION). Building one 알림's filter costs about
// 20-40 µs of CPU (buildPostFilter), so 60 a tick stay well inside the Free plan's 10 ms with tick B's
// other work, even in a fresh isolate (verify-alerts-posts times it); more wait for the next tick.
export const BELLS_PER_TICK = 60;
const MATCH_STATEMENTS = 24, PARAMS_MAX = 100, SQL_MAX = 90000, BELLS_PER_READ = 90;
const MAX_ID = Number.MAX_SAFE_INTEGER;
const CURSOR_KEY = 'sys:alert_cursor';
// Runs that started on a window and never wrote the cursor (killed for CPU, a statement D1 refuses):
// {c: the cursor they started from, n: how many}. After LITE_AFTER such runs the window goes on without
// its 조건 알림, after SKIP_AFTER without any 알림, so one bad window never stops 새 글 알림 for good.
const TRY_KEY = 'sys:alert_try';
const LITE_AFTER = 3, SKIP_AFTER = 6;

// Query keys that never change which new posts match (the page, the order, 거래완료 포함, 오래된 글, the
// 교환 구하는 대상 side, which every exchange board shows).
const NEUTRAL_KEYS = ['page', 'sort', 'closed', 'old', 'wantedCategory'];
const KEYWORD_KEYS = ['kind', 'category', 'q'];

// ---- Saved searches with an 알림 ------------------------------------------------------------------

type AlertFields = { keyword: number; kind: string; category: string; word: string; skins: string; tier: string; season: number | null };

// Whether a saved query holds only the tab, the category and the word (a 키워드 or 게시판 알림, free for
// every grade); any other filter makes it a 조건 알림.
const keywordOnly = (s: URLSearchParams) => [...s.entries()].every(([k, v]) => v === '' || NEUTRAL_KEYS.includes(k) || KEYWORD_KEYS.includes(k));

// What a saved query means for the cron: keyword=1 when it holds only the tab, the category and the
// word (an empty word is the 게시판 새 글 알림, which needs a tab); otherwise a 조건 알림, whose filters
// are checked here with the board's own rules (a bad value is the board's 400).
async function alertFields(u: User, query: string): Promise<AlertFields> {
    const s = new URLSearchParams(query);
    const keyword = keywordOnly(s) ? 1 : 0;
    const kind = TRADE_KINDS.includes(s.get('kind') as typeof TRADE_KINDS[number]) ? s.get('kind')! : '';
    const category = kind && categoriesForKind(kind as typeof TRADE_KINDS[number]).some(c => c.id === s.get('category')) ? s.get('category')! : '';
    const word = searchWord(s.get('q'));
    if (keyword && !word && !kind) fail(400, '게시판을 선택해 주세요.');
    const latest = needsSeason(s) ? await latestSeason() : LATEST_SEASON;
    if (!keyword) buildPostFilter(s, u, latest, Date.now());
    const ladder = word ? tierSearch(word, latest) : null;
    return { keyword, kind, category, word, skins: JSON.stringify(word ? skinsForWord(word) : []), tier: ladder?.tier || '', season: ladder?.season ?? null };
}

// 403 when the member has no room for one more 알림 of this kind (the row being changed aside).
async function assertRoom(u: User, keyword: number, except: string) {
    const r = await db().prepare('SELECT COUNT(*) AS n FROM saved_searches WHERE user_id=? AND alert=1 AND keyword=? AND id!=?').bind(u.id, keyword, except).first<{ n: number }>();
    const n = Number(r?.n) || 0;
    if (keyword) { if (n >= SITE_RULES.keywordAlerts) fail(403, ALERT_TEXT.keywordMax(SITE_RULES.keywordAlerts)); return; }
    const max = perksOf(u).filterAlerts;
    if (!max) fail(403, ALERT_TEXT.filterOff);
    if (n >= max) fail(403, ALERT_TEXT.filterMax(max));
}

// The same room test inside the write, so two requests at once cannot pass the count together. Binds
// (user, keyword, except, max); '1' when the grade has no limit.
function roomGuard(u: User, keyword: number, except: string) {
    const max = keyword ? SITE_RULES.keywordAlerts : perksOf(u).filterAlerts;
    if (!Number.isFinite(max)) return { sql: '1', args: [] as unknown[] };
    return { sql: '(SELECT COUNT(*) FROM saved_searches WHERE user_id=? AND alert=1 AND keyword=? AND id!=?)<?', args: [u.id, keyword, except, max] as unknown[] };
}

// The match columns (alert_word is lowered by SQLite's lower(), as the board's lower(?) does).
const FIELD_SET = "alert_kind=?,alert_category=?,keyword=?,alert_word=lower(?),alert_word_ns=lower(replace(?,' ','')),alert_skins=?,alert_tier=?,alert_season=?";
const fieldArgs = (f: AlertFields) => [f.kind, f.category, f.keyword, f.word, f.word, f.skins, f.tier, f.season];

// GET searches, POST searches {name, query, alert?}, PATCH searches/:id {alert}, DELETE searches/:id.
export async function searchesHandler(req: Request, p: string[]): Promise<Response | null> {
    const u = await requireUser(req), method = req.method;
    if (!p[1] && method === 'GET') {
        const r = await db().prepare('SELECT id,name,query,alert,keyword FROM saved_searches WHERE user_id=? ORDER BY created_at DESC').bind(u.id).all<any>();
        // keyword is stored when the 알림 is turned on; a search saved without one is read from its query.
        return json({ searches: r.results.map(s => ({ ...s, alert: !!s.alert, keyword: s.alert ? !!s.keyword : keywordOnly(new URLSearchParams(s.query)) })),
            filterAlerts: finiteOrNull(perksOf(u).filterAlerts), keywordAlerts: SITE_RULES.keywordAlerts });
    }
    if (!p[1] && method === 'POST') {
        const b = await body(req), name = textField(b.name, 1, 32, '검색 이름'), q = textField(b.query, 1, 12000, '검색 조건');
        const count = await db().prepare('SELECT COUNT(*) AS n FROM saved_searches WHERE user_id=?').bind(u.id).first<any>();
        if (count.n >= SITE_RULES.savedSearches) fail(409, `검색은 최대 ${SITE_RULES.savedSearches}개까지 저장할 수 있습니다.`);
        const id = crypto.randomUUID();
        if (b.alert === true) {
            const f = await alertFields(u, q);
            await assertRoom(u, f.keyword, id);
            // One write with every match column (a row with alert=1 and empty columns would match every
            // new post for a tick), guarded by the room and the 20 saved searches.
            const room = roomGuard(u, f.keyword, id);
            const r = await db().prepare(`INSERT INTO saved_searches(id,user_id,name,query,created_at,alert,alert_kind,alert_category,keyword,alert_word,alert_word_ns,alert_skins,alert_tier,alert_season)
                SELECT ?,?,?,?,?,1,?,?,?,lower(?),lower(replace(?,' ','')),?,?,? WHERE ${room.sql} AND (SELECT COUNT(*) FROM saved_searches WHERE user_id=?)<?`)
                .bind(id, u.id, name, q, Date.now(), ...fieldArgs(f), ...room.args, u.id, SITE_RULES.savedSearches).run();
            if (!r.meta.changes) {
                await assertRoom(u, f.keyword, id);
                fail(409, `검색은 최대 ${SITE_RULES.savedSearches}개까지 저장할 수 있습니다.`);
            }
            return json({ ok: true, id, alert: true, keyword: !!f.keyword });
        }
        // The 20-search cap is checked again inside the write (two saves at once).
        const r = await db().prepare('INSERT INTO saved_searches(id,user_id,name,query,created_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM saved_searches WHERE user_id=?)<?')
            .bind(id, u.id, name, q, Date.now(), u.id, SITE_RULES.savedSearches).run();
        if (!r.meta.changes) fail(409, `검색은 최대 ${SITE_RULES.savedSearches}개까지 저장할 수 있습니다.`);
        return json({ ok: true, id, alert: false });
    }
    if (p[1] && !p[2] && method === 'PATCH') {
        const b = await body(req);
        if (typeof b.alert !== 'boolean') fail(400, '설정을 확인해 주세요.');
        const row = await db().prepare('SELECT id,query FROM saved_searches WHERE id=? AND user_id=?').bind(p[1], u.id).first<{ id: string; query: string }>();
        if (!row) fail(404, '저장한 검색을 찾을 수 없습니다.');
        if (!b.alert) {
            await db().prepare('UPDATE saved_searches SET alert=0 WHERE id=?').bind(row.id).run();
            return json({ ok: true, alert: false });
        }
        const f = await alertFields(u, row.query);
        await assertRoom(u, f.keyword, row.id);
        const room = roomGuard(u, f.keyword, row.id);
        const r = await db().prepare(`UPDATE saved_searches SET alert=1,${FIELD_SET} WHERE id=? AND ${room.sql}`).bind(...fieldArgs(f), row.id, ...room.args).run();
        if (!r.meta.changes) { await assertRoom(u, f.keyword, row.id); fail(409, '설정을 확인해 주세요.'); }
        return json({ ok: true, alert: true, keyword: !!f.keyword });
    }
    if (p[1] && !p[2] && method === 'DELETE') {
        await db().prepare('DELETE FROM saved_searches WHERE id=? AND user_id=?').bind(p[1], u.id).run();
        return json({ ok: true });
    }
    return null;
}
const finiteOrNull = (n: number) => Number.isFinite(n) ? n : null;

// ---- 판매자 구독 -------------------------------------------------------------------------------------

// POST users/:id/follow {active}. 100 per member; a member with '구독 허용' off takes no new follows.
export async function followHandler(req: Request, targetId: string) {
    const u = await requireUser(req), b = await body(req), now = Date.now();
    if (targetId === u.id) fail(400, '회원을 확인해 주세요.');
    const t = await db().prepare('SELECT id,follow_allowed,deleted_at FROM users WHERE id=?').bind(targetId).first<{ id: string; follow_allowed: number; deleted_at: number | null }>();
    if (!t || t.deleted_at) fail(404, '회원을 찾을 수 없습니다.');
    if (!b.active) {
        await db().prepare('DELETE FROM follows WHERE user_id=? AND target_id=?').bind(u.id, t.id).run();
        return json({ followed: false });
    }
    if (!t.follow_allowed) fail(403, ALERT_TEXT.followClosed);
    const r = await db().batch([
        db().prepare(`INSERT INTO follows(user_id,target_id,created_at) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM (SELECT 1 FROM follows WHERE user_id=? LIMIT ${SITE_RULES.follows}))<${SITE_RULES.follows} ON CONFLICT DO NOTHING`).bind(u.id, t.id, now, u.id),
        db().prepare('SELECT 1 AS ok FROM follows WHERE user_id=? AND target_id=?').bind(u.id, t.id),
    ]);
    if (!r[1].results.length) fail(409, ALERT_TEXT.followMax(SITE_RULES.follows));
    return json({ followed: true });
}

// PATCH users/me {follow_allowed}: '구독 허용'. Off also stops 알림 to members who already follow.
export async function followAllowedHandler(req: Request) {
    const u = await requireUser(req), b = await body(req);
    if (typeof b.follow_allowed !== 'boolean') fail(400, '설정을 확인해 주세요.');
    await db().prepare('UPDATE users SET follow_allowed=? WHERE id=?').bind(b.follow_allowed ? 1 : 0, u.id).run();
    return json({ ok: true, follow_allowed: b.follow_allowed });
}

// GET me/follows: '구독 관리' (newest first).
export async function followsList(req: Request) {
    const u = await requireUser(req);
    const r = await db().prepare(`SELECT f.target_id,f.created_at,u.nickname,u.role,${memberColumns('u')} FROM follows f JOIN users u ON u.id=f.target_id WHERE f.user_id=? AND u.deleted_at IS NULL ORDER BY f.created_at DESC LIMIT ${SITE_RULES.follows}`).bind(u.id).all();
    return json({ follows: r.results.map(row => publicMember(row)), max: SITE_RULES.follows });
}

// ---- Matching SQL shared by the cron and the 알림함 counts -------------------------------------------

// A post the subscriber may hear about: visible, not their own, no block either way, its author not
// under 이용 정지, and the 대리(진행) rule. Aliases: p (post), u (its author); bind nothing but `owner`
// (an SQL expression) twice is inlined.
const reachable = (owner: string, now: string) => `p.hidden=0 AND p.author_id!=${owner} AND (u.suspended_until IS NULL OR u.suspended_until<=${now})
    AND (p.kind!='proxy_offer' OR u.role='manager' OR EXISTS(SELECT 1 FROM user_badges bd WHERE bd.user_id=p.author_id AND bd.badge='proxy'))
    AND NOT EXISTS(SELECT 1 FROM blocks bk WHERE (bk.user_id=${owner} AND bk.target_id=p.author_id) OR (bk.user_id=p.author_id AND bk.target_id=${owner}))`;
// A 키워드 or 게시판 알림 s (alias s) matches post p: its tab (or any tab), its category (or any) and the
// board's search SQL with the stored word, skins and ladder (a bare tier word also finds 시즌 비공개
// emblems of that tier, WP68, as the board's ladderSql does).
const keywordMatch = () => `(s.alert_kind=p.kind OR s.alert_kind='') AND (s.alert_category='' OR s.alert_category=p.category)
    AND ${qClause('s.alert_word', 's.alert_word_ns', 's.alert_skins', "(s.alert_tier!='' AND (p.id IN (SELECT post_id FROM post_seasons WHERE tier=s.alert_tier AND (s.alert_season IS NULL OR season=s.alert_season)) OR (s.alert_season IS NULL AND p.id IN (SELECT post_id FROM post_ladder_hidden WHERE tier=s.alert_tier))))")}`;

// Keyword and board text: '‘유루미’ 새 글', '판매 · 계정 새 글' or '판매 새 글'. Bind the two name maps.
const KEYWORD_TEXT = "CASE WHEN s.alert_word='' THEN COALESCE(json_extract(?,'$.'||s.alert_kind),'')||CASE WHEN s.alert_category='' THEN '' ELSE ' · '||COALESCE(json_extract(?,'$.'||s.alert_category),s.alert_category) END||' 새 글' ELSE '‘'||s.name||'’ 새 글' END";
const KIND_MAP = JSON.stringify(KIND_NAMES);
const CATEGORY_MAP = JSON.stringify(Object.fromEntries(TRADE_KINDS.flatMap(k => categoriesForKind(k).map(c => [c.id, categoryName(c.id)]))));

// Inlines bound values that need no binding (safe integers, and short words of letters, digits, '_',
// '-', '.', ':' or Hangul, which hold no quote), so many 조건 알림 fit one statement's 100 parameters.
// Every '?' in these fragments is a placeholder (the filter SQL has no '?' inside a string literal).
function inline(sql: string, args: unknown[]) {
    let i = 0;
    const kept: unknown[] = [];
    const out = sql.replace(/\?/g, () => {
        const v = args[i++];
        if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
        if (typeof v === 'string' && /^[\w\-.:가-힣]{0,64}$/u.test(v)) return `'${v}'`;
        kept.push(v);
        return '?';
    });
    return { sql: out, args: kept };
}
const literal = (id: string) => /^[\w-]{1,64}$/.test(id) ? `'${id}'` : null;

// One 조건 알림's match SQL for tick B, with the board's own filters (buildPostFilter) for its owner: the
// window's new posts, and for 'all' (프리미엄 and up) its price drops too. null when the stored query no
// longer parses (the 알림 is skipped). Exported for the CPU timing in verify-alerts-posts.
export function bellFilter(b: { user_id: string; role: string; query: string }, all: boolean, latest: number, now: number) {
    const owner = literal(b.user_id);
    if (!owner) return null;
    try {
        const f = buildPostFilter(new URLSearchParams(b.query), { id: b.user_id, role: b.role as User['role'] }, latest, now);
        const scope = all ? '((p.id IN (SELECT id FROM n) AND p.relist=0) OR p.id IN (SELECT id FROM d))' : '(p.id IN (SELECT id FROM n) AND p.relist=0)';
        return inline(`${scope} AND ${f.where.join(' AND ')} AND p.author_id!=${owner} AND NOT EXISTS(SELECT 1 FROM blocks bk WHERE bk.user_id=p.author_id AND bk.target_id=${owner})`, f.values);
    } catch { return null; }
}

// ---- Tick B: alertJob ------------------------------------------------------------------------------

// The cursor: the last post handled (t, i). While a window's 조건 알림 take more than one tick, the
// window's end (et, ei) and the last 알림 checked (b) are kept, and the keyword, board and 구독 알림 of
// that window are already written.
type Cursor = { t: number; i: number; et?: number; ei?: number; b?: string };
type WindowPost = { id: number; kind: string; category: string; created_at: number; relist: number };
type Drop = { id: number; kind: string; category: string; at: number };
type Bell = { id: string; user_id: string; name: string; query: string; alert_kind: string; alert_category: string; role: string; rank: number; ord: number };
type Check = { bell: Bell; sql: string; args: unknown[]; all: boolean };

const cur = (f: string, fallback: string) => `COALESCE((SELECT json_extract(value,'$.${f}') FROM settings WHERE key='${CURSOR_KEY}'),${fallback})`;
// The window: posts after the cursor, up to its kept end (or now − 60 s), visible, oldest first; one
// more than the window holds, to know whether it is full. Bind the first look-back and the end time.
const WINDOW_SQL = `SELECT id,kind,category,created_at,relist FROM posts INDEXED BY posts_created
    WHERE created_at>=${cur('t', '?1')} AND (created_at>${cur('t', '?1')} OR id>${cur('i', '0')})
    AND created_at<=${cur('et', '?2')} AND (created_at<${cur('et', '?2')} OR id<=${cur('ei', String(MAX_ID))}) AND hidden=0
    ORDER BY created_at,id LIMIT ${WINDOW_POSTS + 1}`;
// Price drops in the same time window (조건 알림 가격 내림): open, visible 판매 posts now below a price
// they had, first drop time per post. A relist (WP44) sends no 알림 at all, so its drops are left out too.
const DROPS_SQL = `SELECT h.post_id AS id,p.kind,p.category,MIN(h.changed_at) AS at FROM post_price_history h INDEXED BY price_history_changed JOIN posts p ON p.id=h.post_id
    WHERE h.changed_at>${cur('t', '?1')} AND h.changed_at<=${cur('et', '?2')} AND p.hidden=0 AND p.relist=0 AND p.status='open' AND p.price IS NOT NULL AND p.price<h.price
    GROUP BY h.post_id ORDER BY at,h.post_id LIMIT ${WINDOW_POSTS + 1}`;

// The 조건 알림 for the window's tabs and categories, by id after `b`, with the owner's rank now and the
// 알림's place among the owner's 조건 알림 (only the first perks.filterAlerts send). Bind now.
const bellsStatement = (kinds: string[], pairs: string[], after: string, now: number) => db().prepare(`SELECT s.id,s.user_id,s.name,s.query,s.alert_kind,s.alert_category,u.role,
        COALESCE((SELECT MAX(g.rank) FROM user_grades g WHERE g.user_id=s.user_id AND (g.expires_at IS NULL OR g.expires_at>?)),0) AS rank,
        (SELECT COUNT(*) FROM saved_searches o WHERE o.user_id=s.user_id AND o.alert=1 AND o.keyword=0 AND (o.created_at<s.created_at OR (o.created_at=s.created_at AND o.id<s.id))) AS ord
    FROM saved_searches s INDEXED BY saved_alerts JOIN users u ON u.id=s.user_id AND u.deleted_at IS NULL
    WHERE s.alert=1 AND s.keyword=0 AND s.alert_kind IN (SELECT value FROM json_each(?)) AND (s.alert_category='' OR s.alert_kind||'/'||s.alert_category IN (SELECT value FROM json_each(?))) AND s.id>?
    ORDER BY s.id LIMIT ${BELLS_PER_TICK + 1}`).bind(now, JSON.stringify(['', ...kinds]), JSON.stringify(pairs), after);

const key = (x: { kind: string; category: string }) => x.kind + '/' + x.category;
const fits = (b: Bell, x: { kind: string; category: string }) => (!b.alert_kind || b.alert_kind === x.kind) && (!b.alert_category || b.alert_category === x.category);

// Tick B's 새 글 알림. Calls: 1 the window (cursor, the unfinished-run mark, posts, drops); 2 this run's
// mark; 3 the 조건 알림 and the latest season; 4 their match reads (≤ 24 statements); 5 every write in
// one batch (keyword and board, 구독, 조건, the cursor last), so a failed run writes nothing but its mark
// and the next tick reads the same window. An empty window runs nothing more.
export async function alertJob(now: number) {
    const until = now - ALERT_LAG;
    const [curR, postsR, dropsR] = await db().batch([
        db().prepare('SELECT key,value FROM settings WHERE key IN (?,?)').bind(CURSOR_KEY, TRY_KEY),
        db().prepare(WINDOW_SQL).bind(until - FIRST_LOOK_BACK, until),
        db().prepare(DROPS_SQL).bind(until - FIRST_LOOK_BACK, until),
    ]);
    const kept = new Map((curR.results as { key: string; value: string }[]).map(r => [r.key, r.value]));
    const raw = kept.get(CURSOR_KEY) ?? '';
    const stored = parseCursor(raw || undefined);
    const from: Cursor = stored || { t: until - FIRST_LOOK_BACK, i: 0 };
    const pending = from.et !== undefined;
    let posts = postsR.results as WindowPost[], drops = dropsR.results as Drop[];
    if (!posts.length && !drops.length && !pending) return { alerts: 0, posts: 0 };

    // Runs that started from this very cursor and never finished. The mark is written before any work
    // that may fail (its own call), and a finished run moves the cursor, which starts the count again.
    let tried: { c?: unknown; n?: unknown } | null = null;
    try { tried = JSON.parse(kept.get(TRY_KEY) || 'null'); } catch { tried = null; }
    const tries = tried && tried.c === raw ? Number(tried.n) || 0 : 0;
    const mode = tries >= SKIP_AFTER ? 'skip' : tries >= LITE_AFTER ? 'lite' : 'full';
    if (mode !== 'full') console.error(`alertJob: ${tries} runs from cursor ${raw || '-'} did not finish; ${mode === 'skip' ? 'skipping the window' : 'the window goes on without filter alerts'}`);
    if (mode !== 'skip') {
        await db().prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
            .bind(TRY_KEY, JSON.stringify({ c: raw, n: tries + 1 }), now).run();
    }

    // The window's end: the 40th post when more wait, the 40th drop likewise, else now − 60 s.
    let end = pending ? { t: from.et!, i: from.ei! } : { t: until, i: MAX_ID };
    if (posts.length > WINDOW_POSTS) { posts = posts.slice(0, WINDOW_POSTS); end = { t: posts[WINDOW_POSTS - 1].created_at, i: posts[WINDOW_POSTS - 1].id }; }
    if (drops.length > WINDOW_POSTS && drops[WINDOW_POSTS - 1].at < end.t) end = { t: drops[WINDOW_POSTS - 1].at, i: MAX_ID };
    const within = (e: { t: number; i: number }) => ({
        posts: posts.filter(p => p.created_at < e.t || (p.created_at === e.t && p.id <= e.i)),
        drops: drops.filter(d => d.at <= e.t),
    });
    let win = within(end);

    // 조건 알림 for the tabs and categories of the window's new posts (and drops for 'all'); none while the
    // window goes on without them ('lite', 'skip').
    const fresh = () => win.posts.filter(p => !p.relist);
    let bells: Bell[] = [], latest = LATEST_SEASON, truncated = false;
    const candidates = mode === 'full' ? [...fresh(), ...win.drops] : [];
    if (candidates.length) {
        const kinds = [...new Set(candidates.map(c => c.kind))], pairs = [...new Set(candidates.map(key))];
        const [bellsR, seasonR] = await db().batch([
            bellsStatement(kinds, pairs, pending ? from.b || '' : '', now),
            db().prepare("SELECT value FROM settings WHERE key='latest_season'"),
        ]);
        bells = bellsR.results as Bell[];
        truncated = bells.length > BELLS_PER_TICK;
        if (truncated) bells = bells.slice(0, BELLS_PER_TICK);
        const v = Number((seasonR.results[0] as { value?: string } | undefined)?.value);
        if (Number.isInteger(v) && v >= LATEST_SEASON && v <= 200) latest = v;
    }

    // Each 알림's filter is built once per run (the halving loop below only changes which 알림 fit), so the
    // JS work stays inside the Free plan's 10 ms CPU.
    const built = new Map<string, { sql: string; args: unknown[] } | null>();
    const build = (b: Bell, all: boolean) => {
        if (!built.has(b.id)) built.set(b.id, bellFilter(b, all, latest, now));
        return built.get(b.id)!;
    };
    // Each 알림 that may send: the owner's grade now has room for it and it fits a candidate.
    const checksFor = (w: typeof win) => {
        const n = w.posts.filter(p => !p.relist);
        const out: Check[] = [];
        for (const b of bells) {
            const perks: Perks = b.role === 'manager' ? MANAGER_PERKS : perksOfRank(Number(b.rank) || 0);
            if (Number(b.ord) >= perks.filterAlerts) continue;
            const all = perks.filterAlertEvents === 'all';
            if (!n.some(p => fits(b, p)) && !(all && w.drops.some(d => fits(b, d)))) continue;
            const x = build(b, all);
            if (!x) continue;
            out.push({ bell: b, sql: x.sql, args: x.args, all });
        }
        return out;
    };
    // Packs the checks into statements (≤ 100 parameters, ≤ 90 KB and ≤ 90 알림 each); returns the groups.
    const pack = (checks: Check[]) => {
        const groups: Check[][] = [];
        let group: Check[] = [], params = 2, size = 400;
        for (const c of checks) {
            const add = c.args.length, len = c.sql.length + 60;
            if (group.length && (params + add > PARAMS_MAX || size + len > SQL_MAX || group.length >= BELLS_PER_READ)) { groups.push(group); group = []; params = 2; size = 400; }
            group.push(c); params += add; size += len;
        }
        if (group.length) groups.push(group);
        return groups;
    };

    let checks = checksFor(win), groups = pack(checks), partial: boolean;
    // Too many 조건 알림 for one tick: a shorter window first (fewer posts, fewer tabs to check); when
    // even one post needs more, or more 알림 wait than one read holds, the window stays and the 알림
    // are checked over the next ticks (every 알림 against every post of the window).
    if (groups.length > MATCH_STATEMENTS && !truncated && !pending) {
        let k = win.posts.length;
        while (groups.length > MATCH_STATEMENTS && k > 1) {
            k = Math.ceil(k / 2);
            const last = win.posts[k - 1];
            end = { t: last.created_at, i: last.id };
            win = within(end);
            checks = checksFor(win);
            groups = pack(checks);
        }
    }
    const cut = groups.length > MATCH_STATEMENTS;
    partial = cut || truncated;
    if (cut) groups = groups.slice(0, MATCH_STATEMENTS);
    const checked = groups.flat();
    // The next tick goes on after the last 알림 handled: the last one checked when the reads were cut,
    // else the last one read (those after it in the read were skipped for room or tab).
    const lastBell = !partial ? undefined : cut ? checked[checked.length - 1].bell.id : bells[bells.length - 1]?.id || '';

    // Call 3: one row per window post (new or dropped) with one 0/1 column per 알림; each 알림 with a
    // match gets one row (its first new post, else its first drop).
    const newIds = JSON.stringify(win.posts.filter(p => !p.relist).map(p => p.id)), dropIds = JSON.stringify(win.drops.map(d => d.id));
    const matches: { u: string; r: string; p: number; t: string }[] = [];
    if (groups.length) {
        const statements = groups.map(g => {
            const args: unknown[] = [newIds, dropIds];
            const cols = g.map((c, k) => { args.push(...c.args); return `CASE WHEN ${c.sql} THEN 1 ELSE 0 END AS b${k}`; });
            return db().prepare(`WITH n(id) AS (SELECT value FROM json_each(?)),d(id) AS (SELECT value FROM json_each(?))
                SELECT p.id AS id,p.id IN (SELECT id FROM n) AND p.relist=0 AS fresh,${cols.join(',')} FROM posts p JOIN users u ON u.id=p.author_id
                WHERE p.id IN (SELECT id FROM n) OR p.id IN (SELECT id FROM d)`).bind(...args);
        });
        const r = await db().batch(statements);
        r.forEach((res, gi) => {
            const rows = res.results as Record<string, number>[];
            groups[gi].forEach((c, k) => {
                let first: number | null = null, drop: number | null = null;
                for (const row of rows) {
                    if (!row['b' + k]) continue;
                    if (row.fresh) first = first === null ? row.id : Math.min(first, row.id);
                    else drop = drop === null ? row.id : Math.min(drop, row.id);
                }
                if (first !== null) matches.push({ u: c.bell.user_id, r: c.bell.id, p: first, t: ALERT_TEXT.filter(c.bell.name) });
                else if (drop !== null) matches.push({ u: c.bell.user_id, r: c.bell.id, p: drop, t: ALERT_TEXT.filterDrop(c.bell.name) });
            });
        });
    }

    // Call 5: the writes. Keyword, board and 구독 알림 once per window (not again while its 조건 알림 continue,
    // and not for a window that is skipped).
    const ids = JSON.stringify(fresh().map(p => p.id));
    const writes: D1PreparedStatement[] = [];
    if (!pending && fresh().length && mode !== 'skip') {
        writes.push(notifyStatement(null, `SELECT s.user_id,s.id AS ref,MIN(p.id) AS post_id,NULL AS actor_id,CASE WHEN s.alert_word='' THEN 'board' ELSE 'keyword' END AS type,${KEYWORD_TEXT} AS text
            FROM posts p JOIN users u ON u.id=p.author_id JOIN saved_searches s INDEXED BY saved_alerts ON s.alert=1 AND s.keyword=1 AND s.alert_kind IN (p.kind,'')
            WHERE p.id IN (SELECT value FROM json_each(?)) AND p.relist=0 AND ${reachable('s.user_id', '?')} AND ${keywordMatch()}
            GROUP BY s.id`, [KIND_MAP, CATEGORY_MAP, ids, now], now));
        writes.push(notifyStatement('follow', `SELECT f.user_id,p.author_id AS ref,MIN(p.id) AS post_id,p.author_id AS actor_id,u.nickname||' 새 글' AS text
            FROM posts p JOIN users u ON u.id=p.author_id AND u.follow_allowed=1 AND u.deleted_at IS NULL JOIN follows f ON f.target_id=p.author_id
            WHERE p.id IN (SELECT value FROM json_each(?)) AND p.relist=0 AND ${reachable('f.user_id', '?')}
            GROUP BY f.user_id,p.author_id`, [ids, now], now));
    }
    if (matches.length) writes.push(notifyStatement('condition', "SELECT json_extract(value,'$.u') AS user_id,json_extract(value,'$.r') AS ref,json_extract(value,'$.p') AS post_id,NULL AS actor_id,json_extract(value,'$.t') AS text FROM json_each(?)", [JSON.stringify(matches)], now));
    const next: Cursor = partial ? { t: from.t, i: from.i, et: end.t, ei: end.i, b: lastBell } : { t: end.t, i: end.i };
    writes.push(db().prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(CURSOR_KEY, JSON.stringify(next), now));
    const r = await db().batch(writes);
    const written = r.slice(0, -1).reduce((n, x) => n + (Number(x.meta.changes) || 0), 0);
    return { alerts: written, posts: win.posts.length, drops: win.drops.length, bells: checked.length, partial, ...mode === 'full' ? {} : { mode } };
}

function parseCursor(v: string | undefined): Cursor | null {
    if (!v) return null;
    try {
        const c = JSON.parse(v);
        if (!Number.isFinite(c?.t) || !Number.isFinite(c?.i)) return null;
        const out: Cursor = { t: c.t, i: c.i };
        if (Number.isFinite(c.et) && Number.isFinite(c.ei)) { out.et = c.et; out.ei = c.ei; out.b = typeof c.b === 'string' ? c.b : ''; }
        return out;
    } catch { return null; }
}

// ---- 알림함 counts ----------------------------------------------------------------------------------

type AlertRow = { id: number; type: string; ref: string; post_id: number | null; read: boolean; text: string };
const COUNT_CAP = 99;
// Each count looks at most this many post ids after the row's first post (about 5 days of new posts), so an
// old row with a rare word never walks the whole table (LIMIT caps matches, not rows read).
const COUNT_SCAN = 600;
// 새 글 알림 rows still unread show how many posts match now, from the row's first post on ('‘유루미’ 새
// 글 3개'), and carry the board query to open (최신순). At most 20 rows, one count statement each.
export async function alertCounts(rows: AlertRow[], u: User) {
    const live = rows.filter(r => !r.read && r.post_id !== null && ['keyword', 'board', 'follow', 'condition'].includes(r.type));
    if (!live.length) return new Map<number, { count: number; query: string | null }>();
    const searchIds = [...new Set(live.filter(r => r.type !== 'follow').map(r => r.ref))];
    const saved = searchIds.length ? (await db().prepare('SELECT id,query FROM saved_searches WHERE user_id=? AND id IN (SELECT value FROM json_each(?))').bind(u.id, JSON.stringify(searchIds)).all<{ id: string; query: string }>()).results : [];
    const queries = new Map(saved.map(s => [s.id, s.query]));
    const now = Date.now();
    const statements: D1PreparedStatement[] = [], order: AlertRow[] = [];
    let latest: number | null = null;
    for (const r of live) {
        const tail = ` AND p.id>=? AND p.id<${Number(r.post_id) + COUNT_SCAN} AND p.relist=0 AND p.status!='closed' LIMIT ${COUNT_CAP})`;
        if (r.type === 'follow') {
            statements.push(db().prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM posts p JOIN users u ON u.id=p.author_id AND u.follow_allowed=1 WHERE p.author_id=? AND ${reachable('?', '?')}${tail}`).bind(r.ref, u.id, now, u.id, u.id, r.post_id));
        } else if (r.type === 'condition') {
            const q = queries.get(r.ref);
            if (q === undefined) continue;
            const s = new URLSearchParams(q);
            if (latest === null && needsSeason(s)) latest = await latestSeason();
            let f;
            try { f = buildPostFilter(s, u, latest ?? LATEST_SEASON, now); } catch { continue; }
            statements.push(db().prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM posts p JOIN users u ON u.id=p.author_id WHERE ${f.where.join(' AND ')} AND p.author_id!=?${tail}`).bind(...f.values, u.id, r.post_id));
        } else {
            if (!queries.has(r.ref)) continue;
            statements.push(db().prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM posts p JOIN users u ON u.id=p.author_id JOIN saved_searches s ON s.id=? AND s.user_id=? WHERE ${reachable('s.user_id', '?')} AND ${keywordMatch()}${tail}`).bind(r.ref, u.id, now, r.post_id));
        }
        order.push(r);
    }
    const out = new Map<number, { count: number; query: string | null }>();
    const res = statements.length ? await db().batch(statements) : [];
    order.forEach((r, i) => {
        const query = r.type === 'follow' ? null : queries.get(r.ref) ?? null;
        out.set(r.id, { count: Number((res[i].results[0] as { n?: number })?.n) || 0, query });
    });
    return out;
}

