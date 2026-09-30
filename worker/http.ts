import { env } from 'cloudflare:workers';
import type { User } from '../shared/market';
import { BADGES, type BadgeId } from '../shared/membership';

export const MANAGER_ID = 'manager';
export const MANAGER_USERNAME = 'sosirusok';
export const MANAGER_NICKNAME = '우와오';

export function db() {
    const d = (env as Partial<Env>).DB;
    if (!d) throw new Error('DB unavailable');
    return d;
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
let managerReady = false;
export async function initManager() {
    if (managerReady) return;
    const e = env as Partial<Env>;
    if (await db().prepare('SELECT 1 FROM users WHERE id=?').bind(MANAGER_ID).first()) { managerReady = true; return; }
    let hash = e.MANAGER_PASSWORD_HASH, salt = e.MANAGER_PASSWORD_SALT;
    if ((!hash || !salt) && e.MANAGER_PASSWORD && e.MANAGER_PASSWORD.length >= 8) {
        salt = random();
        hash = await storedHash(e.MANAGER_PASSWORD, salt);
    }
    if (!hash || !salt) return;
    await db().prepare('INSERT OR IGNORE INTO users (id,username,nickname,password_hash,salt,role,bio,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind(MANAGER_ID, MANAGER_USERNAME, MANAGER_NICKNAME, hash, salt, 'manager', '좀비고 거래소 매니저입니다.', Date.now()).run();
    managerReady = true;
}

// SQL columns that describe a member's effective grade and verification badges.
// `alias` is the users table alias in the surrounding query.
export function memberColumns(alias: string, prefix = '') {
    return `(SELECT json_object('grade',g.grade,'expires_at',g.expires_at) FROM user_grades g WHERE g.user_id=${alias}.id AND (g.expires_at IS NULL OR g.expires_at>strftime('%s','now')*1000) ORDER BY g.rank DESC,(g.expires_at IS NULL) DESC,g.expires_at DESC LIMIT 1) AS ${prefix}grade_info,`
        + `(SELECT json_group_array(b.badge) FROM user_badges b WHERE b.user_id=${alias}.id) AS ${prefix}badges_json`;
}

const parseJson = (raw: unknown, fallback: any) => { try { return typeof raw === 'string' ? JSON.parse(raw) : fallback; } catch { return fallback; } };

export function sortBadges(list: unknown): BadgeId[] {
    const values = Array.isArray(list) ? list : [];
    return BADGES.map(b => b.id).filter(id => values.includes(id));
}

// Replaces the raw member columns with `grade`, `grade_expires_at` and `badges`.
export function withMember<T extends Record<string, any>>(row: T, prefix = ''): T {
    const info = parseJson(row[prefix + 'grade_info'], null);
    const out: Record<string, any> = { ...row };
    delete out[prefix + 'grade_info'];
    delete out[prefix + 'badges_json'];
    out[prefix + 'grade'] = info?.grade || 'normal';
    out[prefix + 'grade_expires_at'] = info?.expires_at ?? null;
    out[prefix + 'badges'] = sortBadges(parseJson(row[prefix + 'badges_json'], []));
    return out as T;
}

export function tokenOf(r: Request) {
    return r.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('zg_session='))?.slice(11) || '';
}

export const SESSION_DAYS = 30;
const DAY = 86400000;

// Sessions last 30 days from the last visit. The expiry is pushed forward at most
// once a week so an active member stays signed in without extra writes.
export async function currentUser(r: Request): Promise<User | null> {
    const t = tokenOf(r);
    if (!t) return null;
    const token = await digest(t), now = Date.now();
    const row = await db().prepare(`SELECT s.expires_at AS session_expires_at,u.id,u.username,u.nickname,u.role,u.bio,u.created_at,${memberColumns('u')} FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>?`)
        .bind(token, now).first<any>();
    if (!row) return null;
    const { session_expires_at, ...user } = row;
    if (session_expires_at - now < (SESSION_DAYS - 7) * DAY) {
        await db().prepare('UPDATE sessions SET expires_at=? WHERE token=?').bind(now + SESSION_DAYS * DAY, token).run();
    }
    return withMember(user) as User;
}

export async function requireUser(r: Request) {
    const u = await currentUser(r);
    if (!u) fail(401, '로그인이 필요합니다.');
    return u;
}

export function requireManager(u: User) {
    if (u.role !== 'manager') fail(403, '매니저만 사용할 수 있습니다.');
}

export function json(d: unknown, status = 200, h: Record<string, string> = {}) {
    return Response.json(d, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...h } });
}

export async function body(r: Request) {
    if (!r.headers.get('content-type')?.includes('application/json')) fail(415, '올바른 요청 형식이 아닙니다.');
    const s = await r.text();
    if (s.length > 30000) fail(413, '입력 내용이 너무 깁니다.');
    try { return JSON.parse(s); }
    catch { fail(400, '입력 내용을 확인해 주세요.'); }
}

export function csrf(r: Request) {
    const o = r.headers.get('origin');
    if (o && o !== new URL(r.url).origin) fail(403, '허용되지 않은 요청입니다.');
    if (r.headers.get('sec-fetch-site') === 'cross-site') fail(403, '허용되지 않은 요청입니다.');
}

export async function limit(key: string, max: number, ms: number) {
    const now = Date.now();
    const r = await db().prepare('INSERT INTO rate_limits (key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING count')
        .bind(key, now + ms, now, now).first<{ count: number }>();
    if (r && r.count > max) fail(429, '요청이 많습니다. 잠시 후 다시 시도해 주세요.');
}

export function textField(v: unknown, min: number, max: number, label: string) {
    if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) fail(400, `${label}은 ${min}~${max}자로 입력해 주세요.`);
    return v.trim();
}

// The cookie outlives the server session; the session row decides whether it is valid.
export function sessionCookie(r: Request, t: string, age = 400 * 86400) {
    return `zg_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${new URL(r.url).protocol === 'https:' ? '; Secure' : ''}`;
}

export async function setting(key: string) {
    return (await db().prepare('SELECT value FROM settings WHERE key=?').bind(key).first<{ value: string }>())?.value ?? null;
}
