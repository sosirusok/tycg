import { env } from 'cloudflare:workers';
import {
    db, fail, ApiError, body, limit, digest, random, hex, safeEqual, nicknameField, nicknameKey, assertNicknameFree, currentUser,
    initManager, trialWindow, trialOpen,
} from './http';
import { countFetch, localRequest } from './meter';

// 네이버 로그인 (OAuth 2.0). Members sign in with their Naver account only; the site keeps the Naver
// per-app user id (users.naver_id), never the Naver access token. Only response.id of the profile is read:
// the member types a separate site 닉네임 on 가입 마무리, and that is all the site ever shows. naver_id is an
// internal key: no API response carries it (the manager's member panel shows only whether one is linked).
//
//   GET  auth/naver/start?next=/path[&link=1]  302 to nid.naver.com with a fresh state in a short-lived cookie
//   GET  auth/naver/callback?code&state        state check, token exchange, profile read, then one of:
//        a linked member: signed in, 302 to next; the manager's link=1: naver_id set, 302 to next;
//        a new Naver account: the signed pending cookie, 302 to /naver (가입 마무리)
//   GET  auth/naver/pending                    whether the 가입 마무리 screen has a pending Naver sign-in
//   POST auth/naver/finish {nickname, agree}   creates the member (no password), 플러스 체험 as sign-up did
//   POST auth/naver/link {username, password}  기존 계정 연결: links an old ID/password account once
//
// Errors on the redirect paths go to /naver?error=<code>; the screen shows NAVER_ERRORS[code].
// Test only: with TEST_HOOKS=on and a request to 127.0.0.1 or localhost, NAVER_AUTH_BASE and
// NAVER_API_BASE send the token and profile calls to a local mock (tests/fixtures/naver-mock.mjs).

export const NAVER_NOT_READY = '네이버 로그인 설정이 아직 끝나지 않았습니다.';
export const NAVER_MOVED = '네이버 로그인으로 바뀌었습니다.';
const PENDING_GONE = '네이버 로그인 시간이 지났습니다. 다시 로그인해 주세요.';
const MANAGER_LINK_HERE = '관리자 계정은 로그인한 뒤 설정에서 네이버를 연결해 주세요.';

const STATE_COOKIE = 'zg_naver_state', PENDING_COOKIE = 'zg_naver_pending', COOKIE_PATH = '/api/auth/naver';
const STATE_MS = 10 * 60000, PENDING_MS = 30 * 60000;

const vars = () => env as Partial<Env>;
export const naverReady = () => !!(vars().NAVER_CLIENT_ID && vars().NAVER_CLIENT_SECRET);

function bases(req: Request) {
    const v = vars(), test = v.TEST_HOOKS === 'on' && localRequest(req);
    return { auth: (test && v.NAVER_AUTH_BASE) || 'https://nid.naver.com', api: (test && v.NAVER_API_BASE) || 'https://openapi.naver.com' };
}

// The Pages hand-off keeps the visitor's address, so this is the public address + /api/auth/naver/callback
// in production. NAVER_REDIRECT_URI overrides it (it must be on the same origin as /start, or the state
// cookie is not sent back).
const redirectUri = (req: Request) => vars().NAVER_REDIRECT_URI || new URL(req.url).origin + '/api/auth/naver/callback';

// Only a same-origin path: one leading '/', no '//' or '/\', no control characters, never an API path.
export function safeNext(raw: unknown) {
    if (typeof raw !== 'string' || raw.length > 300 || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
    if (/[\u0000-\u001f\u007f\\]/.test(raw) || raw.startsWith('/api/') || raw.startsWith('/naver') || raw.startsWith('/manager-login')) return '/';
    return raw;
}

// Signed cookie values: base64url(JSON) + '.' + HMAC-SHA256. The key is derived from NAVER_CLIENT_SECRET
// (a Worker secret), so a value cannot be made or changed without it. `p` names the cookie, so a state
// value never reads as a pending one.
const enc = new TextEncoder();
function b64url(s: string) {
    let bin = '';
    for (const b of enc.encode(s)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s: string) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
async function mac(data: string) {
    const secret = vars().NAVER_CLIENT_SECRET;
    if (!secret) fail(503, NAVER_NOT_READY);
    const key = await crypto.subtle.importKey('raw', enc.encode('zg-naver-cookie-v1:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function seal(data: Record<string, unknown>) {
    const payload = b64url(JSON.stringify(data));
    return payload + '.' + await mac(payload);
}
async function open<T extends { p: string; e: number }>(value: string, purpose: string): Promise<T | null> {
    const [payload, sig, extra] = value.split('.');
    if (!payload || !sig || extra !== undefined || payload.length > 2000) return null;
    if (!safeEqual(await mac(payload), sig)) return null;
    try {
        const d = JSON.parse(unb64url(payload));
        return d && d.p === purpose && typeof d.e === 'number' && d.e > Date.now() ? d as T : null;
    } catch { return null; }
}

function cookieOf(req: Request, name: string) {
    return req.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1) || '';
}
function cookie(req: Request, name: string, value: string, ms: number) {
    return `${name}=${value}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${Math.floor(ms / 1000)}${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export const clearPending = (req: Request) => cookie(req, PENDING_COOKIE, '', 0);

function redirect(to: string, cookies: string[] = []) {
    const h = new Headers({ Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    for (const c of cookies) h.append('Set-Cookie', c);
    return new Response(null, { status: 302, headers: h });
}

type StateCookie = { p: 'state'; e: number; s: string; n: string; m: 'login' | 'link'; u?: string };
export type PendingCookie = { p: 'pending'; e: number; id: string; n: string };

async function start(req: Request, url: URL) {
    if (!naverReady()) return redirect('/naver?error=config');
    const next = safeNext(url.searchParams.get('next'));
    const link = url.searchParams.get('link') === '1';
    let u: string | undefined;
    if (link) {
        // 네이버 계정 연결 from the manager's settings: the session must be the manager's, now and at the callback.
        const me = await currentUser(req, false);
        if (me?.role !== 'manager') return redirect('/naver?error=state');
        u = me.id;
    }
    const state = random();
    const value = await seal({ p: 'state', e: Date.now() + STATE_MS, s: state, n: next, m: link ? 'link' : 'login', ...u ? { u } : {} });
    const q = new URLSearchParams({ response_type: 'code', client_id: vars().NAVER_CLIENT_ID!, redirect_uri: redirectUri(req), state });
    return redirect(`${bases(req).auth}/oauth2.0/authorize?${q}`, [cookie(req, STATE_COOKIE, value, STATE_MS)]);
}

// The token exchange and the profile read. The access token lives only in this function.
async function naverProfile(req: Request, code: string, state: string) {
    const { auth, api } = bases(req), v = vars();
    countFetch(2);
    const tokenRes = await fetch(`${auth}/oauth2.0/token`, {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: v.NAVER_CLIENT_ID!, client_secret: v.NAVER_CLIENT_SECRET!, code, state }),
    });
    const token = await tokenRes.json().catch(() => null) as { access_token?: unknown } | null;
    if (!tokenRes.ok || typeof token?.access_token !== 'string' || !token.access_token) throw new Error('token');
    const meRes = await fetch(`${api}/v1/nid/me`, { headers: { Authorization: 'Bearer ' + token.access_token }, signal: AbortSignal.timeout(8000) });
    // Only response.id is read: the Naver name, email, nickname and photo are never requested, kept or shown.
    const me = await meRes.json().catch(() => null) as { resultcode?: unknown; response?: { id?: unknown } } | null;
    const id = me?.response?.id;
    if (!meRes.ok || me?.resultcode !== '00' || typeof id !== 'string' || !id || id.length > 128) throw new Error('profile');
    return { id };
}

async function callback(req: Request, url: URL, signIn: (id: string) => Promise<string>) {
    const clear = cookie(req, STATE_COOKIE, '', 0);
    // Once the state cookie checks out, an error keeps its return path, so a retry from /naver lands there.
    let keep = '';
    const back = (code: string) => redirect('/naver?error=' + code + keep, [clear]);
    if (!naverReady()) return back('config');
    const st = await open<StateCookie>(cookieOf(req, STATE_COOKIE), 'state');
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
    if (!st || !state || !safeEqual(state, st.s)) return back('state');
    if (st.n !== '/') keep = '&next=' + encodeURIComponent(st.n);
    // Naver sends error=access_denied when the member cancels on its screen.
    if (url.searchParams.get('error') || !code) return back('denied');
    try { await limit('naver-ip:' + await digest(req.headers.get('cf-connecting-ip') || 'local'), 40, 600000); }
    catch (e) { if (e instanceof ApiError && e.status === 429) return back('busy'); throw e; }
    let profile: { id: string };
    try { profile = await naverProfile(req, code, state); }
    catch (e) {
        console.warn('Naver login failed', e instanceof Error ? e.message : 'unknown');
        return back('naver');
    }
    const now = Date.now();
    if (st.m === 'link') {
        const me = await currentUser(req, false);
        if (!me || me.id !== st.u || me.role !== 'manager') return back('state');
        try { await db().prepare('UPDATE users SET naver_id=?,naver_linked_at=? WHERE id=?').bind(profile.id, now, me.id).run(); }
        catch (e) { if (String(e).includes('UNIQUE')) return back('taken'); throw e; }
        return redirect(st.n, [clear]);
    }
    const found = await db().prepare('SELECT id FROM users WHERE naver_id=? AND deleted_at IS NULL').bind(profile.id).first<{ id: string }>();
    if (found) return redirect(st.n, [clear, await signIn(found.id)]);
    const pending = await seal({ p: 'pending', e: now + PENDING_MS, id: profile.id, n: st.n });
    return redirect('/naver', [clear, cookie(req, PENDING_COOKIE, pending, PENDING_MS)]);
}

async function pendingOf(req: Request) {
    const p = await open<PendingCookie>(cookieOf(req, PENDING_COOKIE), 'pending');
    if (!p) fail(400, PENDING_GONE);
    return p;
}

const ipOf = (req: Request) => digest(req.headers.get('cf-connecting-ip') || 'local');

// Signs the member in and answers {user, trial, ...extra} with the session cookie and `cookies`.
export type SignedIn = (req: Request, id: string, capped: boolean, cookies: string[], extra?: Record<string, unknown>) => Promise<Response>;

// 가입 마무리: the nickname rules of sign-up (look-alike key, reserved words), the per-address limit and
// the 플러스 체험 with its per-address cap (signUpTrial). The username is never shown; it only fills the
// column ('n_' and 16 hex of the Naver id's hash).
async function finish(req: Request, signUpTrial: (id: string, ip: string, at: number) => Promise<boolean>, signedIn: SignedIn) {
    if (!naverReady()) fail(503, NAVER_NOT_READY);
    const pending = await pendingOf(req);
    const b = await body(req);
    const ip = await ipOf(req);
    await limit('auth-ip:' + ip, 40, 600000);
    if (b.agree !== true) fail(400, '이용 규칙에 동의해 주세요.');
    const nickname = nicknameField(b.nickname), key = nicknameKey(nickname);
    await assertNicknameFree(nickname, '');
    await initManager();
    const id = crypto.randomUUID(), createdAt = Date.now();
    let username = 'n_' + (await digest('naver:' + pending.id)).slice(0, 16);
    for (let attempt = 0; ; attempt++) {
        try {
            // The key and the Naver id are checked again inside the insert, so two sign-ups at once cannot both pass.
            const r = await db().prepare("INSERT INTO users (id,username,nickname,nickname_key,password_hash,salt,role,bio,created_at,naver_id,naver_linked_at) SELECT ?,?,?,?,'','','member','',?,?,? WHERE NOT EXISTS(SELECT 1 FROM users WHERE nickname_key=?)")
                .bind(id, username, nickname, key, createdAt, pending.id, createdAt, key).run();
            if (!r.meta.changes) fail(409, '비슷한 닉네임이 이미 있습니다.');
            break;
        } catch (e) {
            const s = String(e);
            if (!s.includes('UNIQUE')) throw e;
            if (s.includes('users.naver_id')) fail(409, '이미 가입된 네이버 계정입니다. 다시 로그인해 주세요.');
            if (s.includes('users.nickname')) fail(409, '이미 사용 중인 닉네임입니다.');
            if (attempt > 0) throw e;
            username = 'n_' + random().slice(0, 16);
        }
    }
    const capped = await signUpTrial(id, ip, createdAt);
    return signedIn(req, id, capped, [clearPending(req)], { next: pending.n });
}

// 기존 계정 연결: the old ID/password, once. Limits as login had them (per address, and per id from each
// address). The old password is removed with the link, so it never signs in again. The manager account is
// refused here: it links only from its own signed-in session (start?link=1 in 설정).
async function link(req: Request, passwordMatches: (pw: unknown, row: any) => Promise<boolean>, signedIn: SignedIn) {
    if (!naverReady()) fail(503, NAVER_NOT_READY);
    const pending = await pendingOf(req);
    const b = await body(req), username = typeof b.username === 'string' ? b.username.toLowerCase().trim() : '';
    if (!/^[a-z0-9_]{4,24}$/.test(username)) fail(400, '아이디는 영문 소문자, 숫자, _ 4~24자로 입력해 주세요.');
    if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 128) fail(400, '비밀번호는 8~128자로 입력해 주세요.');
    const ip = await ipOf(req);
    await limit('auth-ip:' + ip, 40, 600000);
    await limit('auth-user:' + username + ':' + ip, 15, 600000);
    await initManager();
    const found = await db().prepare('SELECT id,role,salt,password_hash,naver_id FROM users WHERE username=? AND deleted_at IS NULL').bind(username).first<any>();
    // 400, not 401: nobody is signed in here, and the app treats a 401 as an ended session.
    if (!await passwordMatches(b.password, found)) fail(400, '아이디 또는 비밀번호가 맞지 않습니다.');
    if (found.role === 'manager') fail(403, MANAGER_LINK_HERE);
    if (found.naver_id) fail(409, '이미 네이버 계정이 연결된 아이디입니다.');
    try {
        const r = await db().prepare("UPDATE users SET naver_id=?,naver_linked_at=?,password_hash='',salt='' WHERE id=? AND naver_id IS NULL AND deleted_at IS NULL AND role!='manager'")
            .bind(pending.id, Date.now(), found.id).run();
        if (!r.meta.changes) fail(409, '이미 네이버 계정이 연결된 아이디입니다.');
    } catch (e) {
        if (String(e).includes('UNIQUE')) fail(409, '이미 다른 아이디에 연결된 네이버 계정입니다.');
        throw e;
    }
    return signedIn(req, found.id, false, [clearPending(req)], { next: pending.n });
}

export type NaverDeps = {
    session: (req: Request, id: string) => Promise<string>;
    signedIn: SignedIn;
    signUpTrial: (id: string, ip: string, at: number) => Promise<boolean>;
    passwordMatches: (pw: unknown, row: any) => Promise<boolean>;
};

export async function naverHandler(req: Request, p: string[], url: URL, deps: NaverDeps): Promise<Response | null> {
    const method = req.method;
    if (method === 'GET' && p[2] === 'start' && !p[3]) return start(req, url);
    if (method === 'GET' && p[2] === 'callback' && !p[3]) return callback(req, url, id => deps.session(req, id));
    if (method === 'GET' && p[2] === 'pending' && !p[3]) {
        if (!naverReady()) return Response.json({ pending: false }, { headers: { 'Cache-Control': 'no-store' } });
        const pending = await open<PendingCookie>(cookieOf(req, PENDING_COOKIE), 'pending');
        const w = await trialWindow();
        return Response.json(pending ? { pending: true, trial: trialOpen(w) } : { pending: false }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (method === 'POST' && p[2] === 'finish' && !p[3]) return finish(req, deps.signUpTrial, deps.signedIn);
    if (method === 'POST' && p[2] === 'link' && !p[3]) return link(req, deps.passwordMatches, deps.signedIn);
    return null;
}
