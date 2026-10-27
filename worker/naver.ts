import { env } from 'cloudflare:workers';
import {
    db, fail, ApiError, body, limit, digest, random, hex, safeEqual, nicknameField, nicknameKey, assertNicknameFree, currentUser,
    initManager, trialWindow, trialOpen, MANAGER_ID,
} from './http';
import { countFetch, localRequest } from './meter';
import { sealPii, type Pii } from './pii';

// 네이버 로그인 (OAuth 2.0). Members sign in with their Naver account only; the site keeps the Naver
// per-app user id (users.naver_id), never the Naver access token. The member types a separate site 닉네임 on
// 가입 마무리, and that is all other members ever see. naver_id is an internal key: no API response carries it
// (the manager's member panel shows only whether one is linked).
// 제공 정보 (all 필수): response.name, email and mobile are kept encrypted in users.pii (worker/pii.ts),
// written at sign-up and 기존 계정 연결 and refreshed at every Naver login; only worker/info.ts shows them (the
// member, the manager, a 관리자 the manager allowed). The mobile number also keeps its keyed hash
// (users.phone_hash): a new Naver account whose number an active member already has cannot sign up. 만 14세 미만
// is kept out by the app's '만 14세 이상만 가입 가능' setting on Naver's side and the age14 confirmation here.
// MANAGER_PHONE: the Naver account with that number signs in as the manager account.
//
//   GET  auth/naver/start?next=/path[&link=1]  302 to nid.naver.com with a fresh state in a short-lived cookie
//   GET  auth/naver/callback?code&state        state check, token exchange, profile read, then one of:
//        a linked member: signed in, 302 to next; the manager's link=1: naver_id set, 302 to next;
//        MANAGER_PHONE's number: signed in as the manager (naver_id moved to it), 302 to next;
//        a new Naver account: the signed pending cookie, 302 to /naver (가입 마무리)
//   GET  auth/naver/pending                    whether the 가입 마무리 screen has a pending Naver sign-in
//   POST auth/naver/finish {nickname, agree, age14}  creates the member (no password), 플러스 체험 as sign-up did
//   POST auth/naver/link {username, password}  기존 계정 연결: links an old ID/password account once
//
// Errors on the redirect paths go to /naver?error=<code>; the screen shows NAVER_ERRORS[code].
// Test only: with TEST_HOOKS=on and a request to 127.0.0.1 or localhost, NAVER_AUTH_BASE and
// NAVER_API_BASE send the token and profile calls to a local mock (tests/fixtures/naver-mock.mjs).

export const NAVER_NOT_READY = '네이버 로그인 설정이 아직 끝나지 않았습니다.';
export const NAVER_MOVED = '네이버 로그인으로 바뀌었습니다.';
const PENDING_GONE = '네이버 로그인 시간이 지났습니다. 다시 로그인해 주세요.';
const MANAGER_LINK_HERE = '관리자 계정은 로그인한 뒤 설정에서 네이버를 연결해 주세요.';
export const PHONE_TAKEN = '같은 휴대전화번호로 가입된 계정이 있습니다. 처음 가입한 네이버 계정으로 로그인해 주세요.';
export const AGE_REQUIRED = '만 14세 이상만 가입할 수 있습니다.';
export const AGE_LINK_REQUIRED = '만 14세 이상만 이용할 수 있습니다.';
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
// The Naver mobile number as 01012345678 ('010-1234-5678' or '+82 10-1234-5678'); anything else is none.
export function phoneDigits(raw: unknown) {
    if (typeof raw !== 'string') return null;
    let d = raw.replace(/[^0-9]/g, '');
    if (d.startsWith('82')) d = '0' + d.slice(2);
    return /^01[016789][0-9]{7,8}$/.test(d) ? d : null;
}
// HMAC-SHA256 of the digits, keyed by PHONE_HASH_KEY (a Worker secret, set once: a new key makes earlier
// hashes stop matching). Local test servers (TEST_HOOKS=on) use a fixed key; anywhere else without the key
// there is no hash, so the number check is off rather than keyed by a value that may change.
async function phoneHash(req: Request, digits: string) {
    const v = vars(), secret = v.PHONE_HASH_KEY || (v.TEST_HOOKS === 'on' && localRequest(req) ? 'zg-phone-test' : '');
    if (!secret) { console.warn('PHONE_HASH_KEY is not set: the phone number check is off'); return null; }
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, enc.encode(digits)));
}
const phoneInUse = async (h: string) => !!await db().prepare('SELECT 1 FROM users WHERE phone_hash=? AND deleted_at IS NULL LIMIT 1').bind(h).first();

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
// h: the phone hash; x: the encrypted 회원 정보 (sealPii), so the cookie never holds a plain value.
export type PendingCookie = { p: 'pending'; e: number; id: string; n: string; h?: string; x?: string };

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

// The Naver profile fields, checked; anything else is none. None of them is ever logged.
const plainText = (v: unknown, max: number) => typeof v === 'string' && v.trim() && v.trim().length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v.trim() : null;
const emailText = (v: unknown) => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;

type Profile = { id: string; digits: string | null; phone: string | null; pii: string | null };

// The token exchange and the profile read. The access token lives only in this function.
async function naverProfile(req: Request, code: string, state: string): Promise<Profile> {
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
    // response.id, name, email and mobile are read (the 제공 정보 the site asks for); the Naver nickname,
    // photo, gender and birthday never are.
    const me = await meRes.json().catch(() => null) as { resultcode?: unknown; response?: { id?: unknown; name?: unknown; email?: unknown; mobile?: unknown } } | null;
    const id = me?.response?.id, r = me?.response;
    if (!meRes.ok || me?.resultcode !== '00' || typeof id !== 'string' || !id || id.length > 128 || !r) throw new Error('profile');
    const digits = phoneDigits(r.mobile);
    const pii: Pii = { name: plainText(r.name, 50), email: emailText(r.email), phone: digits };
    return { id, digits, phone: digits ? await phoneHash(req, digits) : null, pii: await sealPii(req, pii) };
}

// MANAGER_PHONE (a Worker secret), as digits; none when unset or not a mobile number.
const managerPhone = () => phoneDigits(vars().MANAGER_PHONE);

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
    let profile: Profile;
    try { profile = await naverProfile(req, code, state); }
    catch (e) {
        console.warn('Naver login failed', e instanceof Error ? e.message : 'unknown');
        return back('naver');
    }
    const now = Date.now();
    if (st.m === 'link') {
        const me = await currentUser(req, false);
        if (!me || me.id !== st.u || me.role !== 'manager') return back('state');
        try { await db().prepare('UPDATE users SET naver_id=?,naver_linked_at=?,phone_hash=COALESCE(?,phone_hash),pii=COALESCE(?,pii) WHERE id=?').bind(profile.id, now, profile.phone, profile.pii, me.id).run(); }
        catch (e) { if (String(e).includes('UNIQUE')) return back('taken'); throw e; }
        return redirect(st.n, [clear]);
    }
    // MANAGER_PHONE: the Naver account with the manager's number is the manager. Its Naver id moves to the
    // manager row (taken off any other row first, in the same batch, so the unique index holds), with the
    // number's hash and the 회원 정보. /manager-login stays as the backup.
    const managerNumber = managerPhone();
    if (profile.digits && managerNumber && profile.digits === managerNumber && await initManager()) {
        await db().batch([
            db().prepare('UPDATE users SET naver_id=NULL,naver_linked_at=NULL WHERE naver_id=? AND id!=?').bind(profile.id, MANAGER_ID),
            db().prepare('UPDATE users SET naver_linked_at=CASE WHEN naver_id IS ? THEN naver_linked_at ELSE ? END,naver_id=?,phone_hash=COALESCE(?,phone_hash),pii=COALESCE(?,pii) WHERE id=?')
                .bind(profile.id, now, profile.id, profile.phone, profile.pii, MANAGER_ID),
        ]);
        return redirect(st.n, [clear, await signIn(MANAGER_ID)]);
    }
    const found = await db().prepare('SELECT id,phone_hash FROM users WHERE naver_id=? AND deleted_at IS NULL').bind(profile.id).first<{ id: string; phone_hash: string | null }>();
    if (found) {
        // A member who joined before the number was asked for gets it now, so a second account is refused later;
        // the 회원 정보 is written again from this login.
        if ((profile.phone && found.phone_hash !== profile.phone) || profile.pii) await db().prepare('UPDATE users SET phone_hash=COALESCE(?,phone_hash),pii=COALESCE(?,pii) WHERE id=?').bind(profile.phone, profile.pii, found.id).run();
        return redirect(st.n, [clear, await signIn(found.id)]);
    }
    // 같은 휴대전화번호: another Naver account of a number an active member has cannot start a sign-up.
    if (profile.phone && await phoneInUse(profile.phone)) return back('phone');
    const pending = await seal({ p: 'pending', e: now + PENDING_MS, id: profile.id, n: st.n, ...profile.phone ? { h: profile.phone } : {}, ...profile.pii ? { x: profile.pii } : {} });
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
    // 만 14세 미만은 가입할 수 없습니다 (개인정보 처리방침): the member confirms it on 가입 마무리, and on 기존 계정
    // 연결 (the old ID/password sign-up never asked).
    if (b.age14 !== true) fail(400, AGE_REQUIRED);
    const nickname = nicknameField(b.nickname), key = nicknameKey(nickname);
    await assertNicknameFree(nickname, '');
    await initManager();
    const id = crypto.randomUUID(), createdAt = Date.now();
    let username = 'n_' + (await digest('naver:' + pending.id)).slice(0, 16);
    for (let attempt = 0; ; attempt++) {
        try {
            // The key, the number and the Naver id are checked again inside the insert, so two sign-ups at once
            // cannot both pass.
            const h = pending.h ?? null;
            const r = await db().prepare("INSERT INTO users (id,username,nickname,nickname_key,password_hash,salt,role,bio,created_at,naver_id,naver_linked_at,phone_hash,pii) SELECT ?,?,?,?,'','','member','',?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM users WHERE nickname_key=?) AND NOT EXISTS(SELECT 1 FROM users WHERE phone_hash=? AND deleted_at IS NULL)")
                .bind(id, username, nickname, key, createdAt, pending.id, createdAt, h, pending.x ?? null, key, h).run();
            if (!r.meta.changes) fail(409, h && await phoneInUse(h) ? PHONE_TAKEN : '비슷한 닉네임이 이미 있습니다.');
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
    // The old ID/password sign-up never asked the age, so the member confirms 만 14세 이상 here (as in finish).
    if (b.age14 !== true) fail(400, AGE_LINK_REQUIRED);
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
        // The number is checked again here, as in finish: another sign-in may have taken it since the callback.
        const h = pending.h ?? null;
        const r = await db().prepare("UPDATE users SET naver_id=?,naver_linked_at=?,password_hash='',salt='',phone_hash=COALESCE(?,phone_hash),pii=COALESCE(?,pii) WHERE id=? AND naver_id IS NULL AND deleted_at IS NULL AND role!='manager' AND NOT EXISTS(SELECT 1 FROM users o WHERE o.phone_hash=? AND o.deleted_at IS NULL AND o.id!=?)")
            .bind(pending.id, Date.now(), h, pending.x ?? null, found.id, h, found.id).run();
        if (!r.meta.changes) fail(409, h && await phoneInUse(h) ? PHONE_TAKEN : '이미 네이버 계정이 연결된 아이디입니다.');
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
