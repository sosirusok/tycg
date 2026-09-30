import { env } from 'cloudflare:workers';
import type { User } from './market';
type AppEnv = {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    MANAGER_PASSWORD_HASH?: string;
    MANAGER_PASSWORD_SALT?: string;
};
export function db() { const d = (env as AppEnv).DB; if (!d)
    throw new Error('DB unavailable'); return d; }
export class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
export function fail(status: number, message: string): never { throw new ApiError(status, message); }
export const hex = (a: ArrayBuffer) => Array.from(new Uint8Array(a), x => x.toString(16).padStart(2, '0')).join('');
export function random() { return hex(crypto.getRandomValues(new Uint8Array(32)).buffer); }
export async function digest(v: string) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))); }
export async function passwordHash(p: string, salt: string) { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(p), 'PBKDF2', false, ['deriveBits']); return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' }, k, 256)); }
export function safeEqual(a: string, b: string) { if (a.length !== b.length)
    return false; let d = 0; for (let i = 0; i < a.length; i++)
    d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
export async function initManager() { const e = env as AppEnv; if (!e.MANAGER_PASSWORD_HASH || !e.MANAGER_PASSWORD_SALT)
    return; await db().prepare('INSERT OR IGNORE INTO users (id,username,nickname,password_hash,salt,role,bio,created_at) VALUES (?,?,?,?,?,?,?,?)').bind('manager', 'sosirusok', '우와오', e.MANAGER_PASSWORD_HASH, e.MANAGER_PASSWORD_SALT, 'manager', '좀비고 거래소 매니저입니다.', Date.now()).run(); }
export function tokenOf(r: Request) { return r.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('zg_session='))?.slice(11) || ''; }
export async function currentUser(r: Request): Promise<User | null> { const t = tokenOf(r); if (!t)
    return null; return db().prepare('SELECT u.id,u.username,u.nickname,u.role,u.bio,u.created_at FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>?').bind(await digest(t), Date.now()).first<User>(); }
export async function requireUser(r: Request) { const u = await currentUser(r); if (!u)
    fail(401, '로그인이 필요합니다.'); return u; }
export function json(d: unknown, status = 200, h: Record<string, string> = {}) { return Response.json(d, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...h } }); }
export async function body(r: Request) { if (!r.headers.get('content-type')?.includes('application/json'))
    fail(415, '올바른 요청 형식이 아닙니다.'); const s = await r.text(); if (s.length > 30000)
    fail(413, '입력 내용이 너무 깁니다.'); try {
    return JSON.parse(s);
}
catch {
    fail(400, '입력 내용을 확인해 주세요.');
} }
export function csrf(r: Request) { const o = r.headers.get('origin'); if (o && o !== new URL(r.url).origin)
    fail(403, '허용되지 않은 요청입니다.'); if (r.headers.get('sec-fetch-site') === 'cross-site')
    fail(403, '허용되지 않은 요청입니다.'); }
export async function limit(key: string, max: number, ms: number) { const now = Date.now(); const r = await db().prepare('INSERT INTO rate_limits (key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING count').bind(key, now + ms, now, now).first<{
    count: number;
}>(); if (r && r.count > max)
    fail(429, '요청이 많습니다. 잠시 후 다시 시도해 주세요.'); }
export function textField(v: unknown, min: number, max: number, label: string) { if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max)
    fail(400, `${label}은 ${min}~${max}자로 입력해 주세요.`); return v.trim(); }
export function sessionCookie(r: Request, t: string, age = 604800) { return `zg_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${new URL(r.url).protocol === 'https:' ? '; Secure' : ''}`; }
export function bucket() { const b = (env as AppEnv).BUCKET; if (!b)
    fail(503, '사진 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'); return b; }
