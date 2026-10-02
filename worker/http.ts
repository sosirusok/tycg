import { env } from 'cloudflare:workers';
import { SUSPEND_FOREVER, suspendUntilText, type User } from '../shared/market';
import { BADGES, PERKS, TRIAL_MS, type BadgeId } from '../shared/membership';
import { meteredDb } from './meter';
import { enrolStatements } from './automation';

export const MANAGER_ID = 'manager';
export const MANAGER_USERNAME = 'sosirusok';
export const MANAGER_NICKNAME = '우와오';

export function db() {
    const d = (env as Partial<Env>).DB;
    if (!d) throw new Error('DB unavailable');
    // The test meter (READ_BUDGET=on, local only) counts through a wrapper; otherwise the binding itself.
    return meteredDb(d);
}

export class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
export function fail(status: number, message: string): never { throw new ApiError(status, message); }

export const hex = (a: ArrayBuffer) => Array.from(new Uint8Array(a), x => x.toString(16).padStart(2, '0')).join('');
export function random() { return hex(crypto.getRandomValues(new Uint8Array(32)).buffer); }
export async function digest(v: string) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))); }

// PBKDF2-SHA256. The Workers Free plan allows about 10 ms of CPU per request, so new
// hashes use 20,000 iterations and record the count ("pbkdf2-sha256$<n>$<hex>").
// Hashes without a prefix are the earlier 100,000-iteration format and still verify.
export const PBKDF2_ITERATIONS = 20000;
const LEGACY_ITERATIONS = 100000;

export async function passwordHash(password: string, salt: string, iterations = PBKDF2_ITERATIONS) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations, hash: 'SHA-256' }, key, 256);
    return hex(bits);
}

export async function storedHash(password: string, salt: string) {
    return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${await passwordHash(password, salt)}`;
}

// Compared against when a login names an unknown id, so that request costs the same as a real one.
export const DUMMY_HASH = `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${'0'.repeat(64)}`;
export const isLegacyHash = (stored: string) => !stored.startsWith('pbkdf2-sha256$');

export async function verifyPassword(password: string, salt: string, stored: string) {
    const m = /^pbkdf2-sha256\$(\d{1,6})\$([0-9a-f]{64})$/.exec(stored);
    const iterations = m ? Number(m[1]) : LEGACY_ITERATIONS, expected = m ? m[2] : stored;
    if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 100000) return false;
    return safeEqual(await passwordHash(password, salt, iterations), expected);
}

export function safeEqual(a: string, b: string) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}

// Creates the reserved manager account once, from deploy-time secrets. An existing
// manager password is never overwritten by a later secret change.
// Resolves to whether the manager account exists (false only while no password secret is set).
let managerReady = false;
export async function initManager(): Promise<boolean> {
    if (managerReady) return true;
    const e = env as Partial<Env>;
    if (await db().prepare('SELECT 1 FROM users WHERE id=?').bind(MANAGER_ID).first()) { managerReady = true; return true; }
    let hash = e.MANAGER_PASSWORD_HASH, salt = e.MANAGER_PASSWORD_SALT;
    if ((!hash || !salt) && e.MANAGER_PASSWORD && e.MANAGER_PASSWORD.length >= 8) {
        salt = random();
        hash = await storedHash(e.MANAGER_PASSWORD, salt);
    }
    if (!hash || !salt) return false;
    await db().prepare('INSERT OR IGNORE INTO users (id,username,nickname,password_hash,salt,role,bio,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind(MANAGER_ID, MANAGER_USERNAME, MANAGER_NICKNAME, hash, salt, 'manager', '좀비고 거래소 매니저입니다.', Date.now()).run();
    managerReady = true;
    return true;
}

// SQL columns that describe a member's effective grade and verification badges.
// `alias` is the users table alias in the surrounding query. 회원 탈퇴 keeps the grade and badge
// rows (the manager's record of each grant), so a withdrawn member simply shows none of them.
export function memberColumns(alias: string, prefix = '') {
    return `(SELECT json_object('grade',g.grade,'expires_at',g.expires_at,'trial',g.source='trial') FROM user_grades g WHERE g.user_id=${alias}.id AND ${alias}.deleted_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ORDER BY g.rank DESC,(g.expires_at IS NULL) DESC,g.expires_at DESC LIMIT 1) AS ${prefix}grade_info,`
        + `(SELECT json_group_array(b.badge) FROM user_badges b WHERE b.user_id=${alias}.id AND ${alias}.deleted_at IS NULL) AS ${prefix}badges_json`;
}

// The member's paid rank for the manager's handling order (WP60: 신고 and the manager's chat list), as
// priorityRank reads it: the highest current grade the manager granted (source 'manager', so a 플러스 체험
// counts as 일반), with 관리자 (rank 4) counted as 엘리트 (3); 0 for none and for a withdrawn member.
// `alias` is the users table alias in the surrounding query. Binds nothing.
export const paidRankSql = (alias: string) => `COALESCE((SELECT MIN(MAX(g.rank),3) FROM user_grades g WHERE g.user_id=${alias}.id AND ${alias}.deleted_at IS NULL AND g.source='manager'
    AND (g.expires_at IS NULL OR g.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))),0)`;

// A trade counts once the other member confirmed it ('확인' or their 후기) and while the manager has
// not removed it. Rows recorded before the confirm step (no author_id) count as confirmed.
export const countedTrade = (t: string) => `${t}.removed_at IS NULL AND (${t}.confirmed_at IS NOT NULL OR ${t}.author_id IS NULL)`;
// A 후기 shows while neither it nor its trade was removed by the manager.
export const liveReview = (r: string) => `${r}.removed_at IS NULL AND EXISTS(SELECT 1 FROM trades lt WHERE lt.id=${r}.trade_id AND lt.removed_at IS NULL)`;

const TRADE_BUCKET = 30 * 86400000;
export type TradeStats = { trade_count: number; deal_sum: number; good_count: number };
// '거래 12회 · 거금 340만원 · 후기 좋아요 9' (WP43): the member's confirmed, non-removed trades, at most
// one per counterpart per 30-day bucket (floor(at / 30 days)), leaving out counterparts under 영구 정지.
// 거금 adds, per bucket, the largest MIN(거래가, backing) (no backing adds 0), and 후기 좋아요 counts the
// buckets holding a 좋아요 후기 about the member. One read of at most 2000 rows, deduped here.
export async function tradeStats(userId: string): Promise<TradeStats> {
    return tradeStatsOf((await tradeStatsStatement(userId).all()).results as TradeRow[]);
}
type TradeRow = { other: string; price: number | null; backing: number | null; at: number; suspended_until: number | null; good: number };
// The read alone, so a caller can put it in its own batch (GET /posts/:id with '비슷한 매물', WP53).
export function tradeStatsStatement(userId: string) {
    return db().prepare(`SELECT CASE WHEN t.seller_id=? THEN t.buyer_id ELSE t.seller_id END AS other,t.price,t.backing,t.created_at AS at,o.suspended_until,
            EXISTS(SELECT 1 FROM reviews rv WHERE rv.trade_id=t.id AND rv.target_id=? AND rv.good=1 AND rv.removed_at IS NULL) AS good
        FROM trades t LEFT JOIN users o ON o.id=CASE WHEN t.seller_id=? THEN t.buyer_id ELSE t.seller_id END
        WHERE (t.seller_id=? OR t.buyer_id=?) AND ${countedTrade('t')} ORDER BY t.created_at DESC LIMIT 2000`)
        .bind(userId, userId, userId, userId, userId);
}
export function tradeStatsOf(rows: TradeRow[]): TradeStats {
    const keys = new Map<string, { deal: number; good: boolean }>();
    for (const t of rows) {
        if ((t.suspended_until ?? 0) >= SUSPEND_FOREVER) continue;
        const key = t.other + ':' + Math.floor(t.at / TRADE_BUCKET), k = keys.get(key) || { deal: 0, good: false };
        k.deal = Math.max(k.deal, Math.min(t.price ?? 0, t.backing ?? 0));
        k.good ||= !!t.good;
        keys.set(key, k);
    }
    let deal_sum = 0, good_count = 0;
    for (const k of keys.values()) { deal_sum += k.deal; if (k.good) good_count++; }
    return { trade_count: keys.size, deal_sum, good_count };
}

// The one message for anything aimed at a member who left (chat, grants, temporary password).
export const WITHDRAWN = '탈퇴한 회원입니다.';
// What a withdrawn member is called on screen. The stored nickname keeps a random suffix only
// because nicknames are unique.
export const WITHDRAWN_NAME = '탈퇴회원';

const parseJson = (raw: unknown, fallback: any) => { try { return typeof raw === 'string' ? JSON.parse(raw) : fallback; } catch { return fallback; } };

export function sortBadges(list: unknown): BadgeId[] {
    const values = Array.isArray(list) ? list : [];
    return BADGES.map(b => b.id).filter(id => values.includes(id));
}

// Replaces the raw member columns with `grade`, `grade_expires_at`, `grade_trial` and `badges`.
// grade_trial marks a 플러스 무료 체험: every 플러스 benefit applies, and the chip is not shown.
export function withMember<T extends Record<string, any>>(row: T, prefix = ''): T {
    const info = parseJson(row[prefix + 'grade_info'], null);
    const out: Record<string, any> = { ...row };
    delete out[prefix + 'grade_info'];
    delete out[prefix + 'badges_json'];
    out[prefix + 'grade'] = info?.grade || 'normal';
    out[prefix + 'grade_expires_at'] = info?.expires_at ?? null;
    out[prefix + 'grade_trial'] = !!info?.trial;
    out[prefix + 'badges'] = sortBadges(parseJson(row[prefix + 'badges_json'], []));
    return out as T;
}

export function tokenOf(r: Request) {
    return r.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('zg_session='))?.slice(11) || '';
}

export const SESSION_DAYS = 30;
const DAY = 86400000;

// '최근 접속' is written at most once per 10 minutes per member.
export const LAST_SEEN_STEP = 10 * 60000;

// Sessions last 30 days from the last visit. The expiry is pushed forward at most
// once a week so an active member stays signed in without extra writes.
// The same session read gives '최근 접속' (users.last_seen_at); it is written only when it is empty
// or 10 minutes old, and the WHERE repeats that test so parallel requests write it once.
export async function currentUser(r: Request): Promise<User | null> {
    const t = tokenOf(r);
    if (!t) return null;
    const token = await digest(t), now = Date.now();
    const row = await db().prepare(`SELECT s.expires_at AS session_expires_at,u.last_seen_at,u.trial_at,EXISTS(SELECT 1 FROM blocks bl WHERE bl.user_id=u.id) AS has_blocks,u.id,u.username,u.nickname,u.role,u.bio,u.created_at,u.suspended_until,u.celebrated_rank,${memberColumns('u')} FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>?`)
        .bind(token, now).first<any>();
    if (!row) return null;
    const { session_expires_at, last_seen_at, trial_at, has_blocks, ...user } = row;
    const writes: D1PreparedStatement[] = [];
    if (session_expires_at - now < (SESSION_DAYS - 7) * DAY) writes.push(db().prepare('UPDATE sessions SET expires_at=? WHERE token=?').bind(now + SESSION_DAYS * DAY, token));
    if (last_seen_at === null || last_seen_at <= now - LAST_SEEN_STEP) {
        writes.push(db().prepare('UPDATE users SET last_seen_at=? WHERE id=? AND (last_seen_at IS NULL OR last_seen_at<=?)').bind(now, user.id, now - LAST_SEEN_STEP));
        // A visit resumes 자동 끌올 paused for no visit (WP52): the member is due on the next tick.
        writes.push(db().prepare("UPDATE automation SET pause_reason='',paused_at=NULL,bump_next_at=?,updated_at=? WHERE user_id=? AND pause_reason='away'").bind(now, now, user.id));
    }
    if (writes.length) await db().batch(writes);
    // Catch-up for the deploy gap: a member who signed up inside the trial window while the previous
    // Worker still served has no trial yet. Only members with no grade row at all, once per isolate.
    // A failed catch-up never fails the request; the member is tried again in the next isolate.
    if (trial_at === null && user.grade_info === null && user.role !== 'manager' && !catchUpTried.has(user.id)) {
        try {
            const w = await trialWindow();
            if (user.created_at >= w.start && user.created_at <= w.end && user.created_at + TRIAL_MS > now) {
                if (catchUpTried.size > 5000) catchUpTried.clear();
                catchUpTried.add(user.id);
                if (await grantTrial(user.id, now, true)) {
                    const g = await db().prepare(`SELECT ${memberColumns('u')} FROM users u WHERE u.id=?`).bind(user.id).first<any>();
                    if (g) Object.assign(user, g);
                }
            }
        } catch (e) { console.warn('Trial catch-up failed', e instanceof Error ? e.message : 'unknown'); }
    }
    const member = withMember(user) as User;
    // Whether the member blocked anyone, for the board lists (never sent: not enumerable).
    Object.defineProperty(member, HAS_BLOCKS, { value: !!has_blocks, enumerable: false });
    return member;
}

// Set on the members currentUser returns: false when they blocked nobody, so lists skip the per-post
// block check. Any other user object (or a missing flag) counts as having blocks.
const HAS_BLOCKS = Symbol('hasBlocks');
export const mayHaveBlocks = (u: User) => (u as unknown as Record<symbol, unknown>)[HAS_BLOCKS] !== false;

// 플러스 무료 체험 window (settings 'sys:trial_start' and 'sys:trial_end', written by 0016_plus_trial
// and the manager's card). A missing value means closed. Cached for 60 s per isolate; the manager's
// change clears it. Grants never trust the cache: their SQL reads the settings again.
type TrialWindow = { start: number; end: number; at: number };
let trialCache: TrialWindow | null = null;
const catchUpTried = new Set<string>();
export function clearTrialCache() { trialCache = null; catchUpTried.clear(); }
export async function trialWindow(fresh = false): Promise<TrialWindow> {
    const now = Date.now();
    if (!fresh && trialCache && now - trialCache.at < 60000) return trialCache;
    const r = await db().prepare("SELECT key,CAST(value AS INTEGER) AS value FROM settings WHERE key IN ('sys:trial_start','sys:trial_end')").all<{ key: string; value: number }>();
    const get = (k: string) => r.results.find(x => x.key === k)?.value;
    trialCache = { start: get('sys:trial_start') ?? Infinity, end: get('sys:trial_end') ?? -Infinity, at: now };
    return trialCache;
}
export const trialOpen = (w: TrialWindow, now = Date.now()) => now >= w.start && now <= w.end;

// The account's creation time lies inside the window, read from settings in the same statement
// (the user_grades_trial_rule trigger checks exactly this).
const IN_TRIAL_WINDOW = "u.created_at>=COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key='sys:trial_start'),9e18) AND u.created_at<=COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key='sys:trial_end'),-1)";

// Grants the trial: one batch whose WHERE mirrors the trigger, so it inserts nothing instead of
// aborting, then stamps users.trial_at only when the trial row exists. The catch-up path also
// requires that the member has no grade row at all. Returns whether a trial row was written.
export async function grantTrial(userId: string, now = Date.now(), catchUp = false) {
    const r = await db().batch([
        db().prepare(`INSERT INTO user_grades(user_id,grade,rank,expires_at,granted_by,granted_at,source) SELECT u.id,'plus',1,u.created_at+${TRIAL_MS},'${MANAGER_ID}',?,'trial' FROM users u
            WHERE u.id=? AND u.trial_at IS NULL AND u.deleted_at IS NULL AND u.role!='manager' AND ${IN_TRIAL_WINDOW} AND NOT EXISTS(SELECT 1 FROM user_grades g WHERE g.user_id=u.id AND ${catchUp ? '1' : "g.source='trial'"})`).bind(now, userId),
        db().prepare("UPDATE users SET trial_at=? WHERE id=? AND trial_at IS NULL AND EXISTS(SELECT 1 FROM user_grades WHERE user_id=? AND source='trial')").bind(now, userId, userId),
        // The trial fills the 끌올 지갑 to the 플러스 cap (no chat line).
        db().prepare('UPDATE users SET bump_tokens=?,bump_at=? WHERE id=? AND trial_at=?').bind(PERKS.plus.bumpMax, now, userId, now),
        // 자동 끌올 is on from the start (WP52): the automation row and the newest open post (no chat line).
        ...enrolStatements(userId, 'plus', now, 'EXISTS(SELECT 1 FROM users WHERE id=? AND trial_at=?)', [userId, now], false),
    ]);
    return r[0].meta.changes > 0;
}

export async function requireUser(r: Request) {
    const u = await currentUser(r);
    if (!u) fail(401, '로그인이 필요합니다.');
    return u;
}

// The only permission check for manager powers. A member's grade (관리자 included) never grants any.
export const isManager = (u: User | null | undefined) => u?.role === 'manager';

export function requireManager(u: User) {
    if (!isManager(u)) fail(403, '매니저만 사용할 수 있습니다.');
}

// 이용 정지 (WP22): a suspended member can still sign in, read, close or delete their posts, and write
// to the manager's chat to appeal, but cannot write posts, 끌올, 광고 고정·빼기, change prices, reopen or
// reserve a post, send or accept 제시, apply or write to other members until suspended_until passes.
export const isSuspended = (until: number | null | undefined, now = Date.now()) => typeof until === 'number' && until > now;
export function requireActive(u: User) {
    if (isSuspended(u.suspended_until)) fail(403, `이용 정지 중입니다. (${suspendUntilText(u.suspended_until!)})`);
}

export function json(d: unknown, status = 200, h: Record<string, string> = {}) {
    return Response.json(d, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...h } });
}

const JSON_LIMIT = 64 * 1024;

// Reads at most 64 KB so an oversized request is refused before it is decoded.
export async function body(r: Request) {
    if (!r.headers.get('content-type')?.includes('application/json')) fail(415, '올바른 요청 형식이 아닙니다.');
    if (Number(r.headers.get('content-length')) > JSON_LIMIT) fail(413, '입력 내용이 너무 깁니다.');
    const reader = r.body?.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > JSON_LIMIT) { await reader.cancel(); fail(413, '입력 내용이 너무 깁니다.'); }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
    const s = new TextDecoder().decode(bytes);
    if (s.length > 30000) fail(413, '입력 내용이 너무 깁니다.');
    try { return JSON.parse(s); }
    catch { fail(400, '입력 내용을 확인해 주세요.'); }
}

export function csrf(r: Request) {
    const o = r.headers.get('origin');
    if (o && o !== new URL(r.url).origin) fail(403, '허용되지 않은 요청입니다.');
    if (r.headers.get('sec-fetch-site') === 'cross-site') fail(403, '허용되지 않은 요청입니다.');
}

// `text` names the limit when it is a rule members meet (WP58: '맞는 글 채팅은 하루 20번까지입니다.').
export async function limit(key: string, max: number, ms: number, text = '요청이 많습니다. 잠시 후 다시 시도해 주세요.') {
    const now = Date.now();
    const r = await db().prepare('INSERT INTO rate_limits (key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING count')
        .bind(key, now + ms, now, now).first<{ count: number }>();
    if (r && r.count > max) fail(429, text);
}

export function textField(v: unknown, min: number, max: number, label: string) {
    if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) fail(400, `${label}: ${min}~${max}자로 입력해 주세요.`);
    return v.trim();
}

// Nicknames are stored in NFKC form without invisible characters, so a look-alike
// of the manager nickname (e.g. with a zero-width space or Hangul filler) is refused.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800]/u;
const RESERVED_WORDS = ['매니저', '운영자', '관리자', '운영진', '운영팀', '탈퇴회원', 'admin', 'manager'];
export function nicknameField(v: unknown, isManager = false) {
    if (typeof v !== 'string') fail(400, '닉네임은 2~16자로 입력해 주세요.');
    const normalized = v.normalize('NFKC');
    if (INVISIBLE.test(normalized)) fail(400, '닉네임에 쓸 수 없는 문자가 있습니다.');
    const nickname = textField(normalized.replace(/\s+/g, ' '), 2, 16, '닉네임');
    if (isManager) {
        if (nickname !== MANAGER_NICKNAME) fail(400, '매니저 닉네임은 우와오로 고정됩니다.');
        return nickname;
    }
    // Checked on the look-alike key, so '탈퇴!회원' or '매!니저' is refused like the plain word.
    const key = nicknameKey(nickname);
    if (key.includes(MANAGER_NICKNAME) || RESERVED_WORDS.some(w => key.includes(w))) fail(409, '사용할 수 없는 닉네임입니다.');
    return nickname;
}

// Look-alike key: 'ab12', 'a b12', 'AB12_' and 'ab12!' share one key, so only the first of them
// can be registered. U+119E is where NFKC puts 'ㆍ' (U+318D), so both forms are removed.
const NICKNAME_NOISE = /[\s._\-·ㆍ\u119E~!@#$%^&*()[\]{}'`|/\\:;,?<>+="]/gu;
export function nicknameKey(nickname: string) {
    return nickname.normalize('NFKC').toLowerCase().replace(NICKNAME_NOISE, '');
}

// Members written before nickname_key existed (or by the previous Worker while a deploy is in
// progress, or by SQL in tests) get their key here, 200 rows per round. The probe is an indexed
// lookup that returns nothing once every row has a key, so it runs before every look-alike check
// instead of being skipped by a per-isolate flag that would miss rows written after it was set.
// Withdrawn members hold a '#deleted:' key (never NULL), so the probe does not grow with them, and a
// nickname the previous Worker changes without touching the key gets NULL from a trigger
// (0010_nickname_key_reset) and is keyed again here.
// At most 10 rounds (2,000 members) per request keep the D1 calls bounded; the next request continues.
export async function ensureNicknameKeys() {
    for (let round = 0; round < 10; round++) {
        const r = await db().prepare('SELECT id,nickname FROM users WHERE nickname_key IS NULL AND deleted_at IS NULL LIMIT 200').all<{ id: string; nickname: string }>();
        if (r.results.length) await db().batch(r.results.map(u => db().prepare('UPDATE users SET nickname_key=? WHERE id=? AND nickname=?').bind(nicknameKey(u.nickname), u.id, u.nickname)));
        if (r.results.length < 200) return;
    }
}

// Refuses a nickname that another member already uses, exactly or as a look-alike.
export async function assertNicknameFree(nickname: string, exceptId: string) {
    await ensureNicknameKeys();
    const r = await db().prepare('SELECT nickname FROM users WHERE nickname_key=? AND id!=? LIMIT 5').bind(nicknameKey(nickname), exceptId).all<{ nickname: string }>();
    if (r.results.some(x => x.nickname === nickname)) fail(409, '이미 사용 중인 닉네임입니다.');
    if (r.results.length) fail(409, '비슷한 닉네임이 이미 있습니다.');
}

// The cookie outlives the server session; the session row decides whether it is valid.
export function sessionCookie(r: Request, t: string, age = 400 * 86400) {
    return `zg_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${new URL(r.url).protocol === 'https:' ? '; Secure' : ''}`;
}

export async function setting(key: string) {
    return (await db().prepare('SELECT value FROM settings WHERE key=?').bind(key).first<{ value: string }>())?.value ?? null;
}
