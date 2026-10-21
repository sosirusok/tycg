import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockMobile } from './fixtures/naver-mock.mjs';

// 네이버 로그인: start and callback (state cookie, safe next), 가입 마무리 (nickname rules, 플러스 체험), a linked
// Naver account signing in, 기존 계정 연결 with the old ID/password (once), the 410 for the old member
// endpoints, the manager's hidden /manager-login and 네이버 계정 연결, and that neither the Naver token nor
// naver_id nor any Naver profile field is ever stored or sent. scripts/test-local.mjs runs it on a short-lived
// server with TEST_HOOKS=on and the mock (tests/fixtures/naver-mock.mjs) as NAVER_AUTH_BASE/NAVER_API_BASE and
// without LEGACY_AUTH_TEST (TEST_PHASE=main), then on one without the Naver client values (TEST_PHASE=unset).
// Nothing here calls Naver.
const base = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791').origin;
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base), 'Local Worker origin required.');
const phase = process.env.TEST_PHASE || 'main';
const mock = process.env.NAVER_MOCK_ORIGIN || '';
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const persist = process.env.TEST_PERSIST || '.wrangler/state';
const run = randomBytes(4).toString('hex');
const MOVED = '네이버 로그인으로 바뀌었습니다.';
let checks = 0;
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }
function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }

function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc', '--persist-to', persist, '--json', '--command', command],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

// Every response body this suite saw, to check afterwards that no naver_id or Naver profile field was sent.
const seen = [];
// A browser: a cookie jar (name → value, by path prefix), redirects not followed.
function browser() {
    const jar = new Map();
    const cookieFor = p => [...jar.values()].filter(c => p.startsWith(c.path)).map(c => c.name + '=' + c.value).join('; ');
    async function raw(p, method = 'GET', data) {
        const send = () => fetch(base + p, {
            method, redirect: 'manual', signal: AbortSignal.timeout(20000),
            headers: { ...(jar.size ? { Cookie: cookieFor(p) } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: data === undefined ? undefined : JSON.stringify(data),
        });
        const r = await send().catch(e => { if (e?.cause?.code === 'UND_ERR_SOCKET') return send(); throw e; });
        const cookies = r.headers.getSetCookie();
        for (const line of cookies) {
            const [pair, ...attrs] = line.split(';').map(x => x.trim());
            const name = pair.slice(0, pair.indexOf('=')), value = pair.slice(pair.indexOf('=') + 1);
            const cpath = attrs.find(a => a.toLowerCase().startsWith('path='))?.slice(5) || '/';
            const age = attrs.find(a => a.toLowerCase().startsWith('max-age='));
            if (!value || age === 'Max-Age=0') jar.delete(name); else jar.set(name, { name, value, path: cpath });
        }
        const text = await r.text();
        seen.push({ p, text });
        let json = null;
        try { json = JSON.parse(text); } catch { /* a redirect has no body */ }
        return { status: r.status, location: r.headers.get('location') || '', cookies, data: json };
    }
    const api = (p, method, data) => raw('/api/' + p, method, data);
    api.raw = raw;
    api.jar = jar;
    return api;
}

// start → (Naver) → callback for the Naver account `naverId`; returns the callback's answer.
async function naverLogin(b, naverId, next = '/', { link = false } = {}) {
    const start = await b(`auth/naver/start?next=${encodeURIComponent(next)}${link ? '&link=1' : ''}`);
    assert.equal(start.status, 302, 'start redirects');
    const state = new URL(start.location).searchParams.get('state');
    return b(`auth/naver/callback?code=${encodeURIComponent('ok:' + naverId)}&state=${state}`);
}

if (phase === 'unset') {
    const b = browser();
    equal((await b('config')).data.naverLogin, false, 'config says 네이버 로그인 is not set up');
    const start = await b('auth/naver/start?next=/');
    equal([start.status, start.location], [302, '/naver?error=config'], 'start without the client values goes to the config message');
    const finish = await b('auth/naver/finish', 'POST', { nickname: '설정없음' + run, agree: true });
    equal([finish.status, finish.data.error], [503, '네이버 로그인 설정이 아직 끝나지 않았습니다.'], 'finish without the client values is 503 with the Korean line');
    equal((await b('auth/register', 'POST', { username: 'nv_' + run, password: 'password-' + run, nickname: '옛가입' + run })).status, 410, 'sign-up stays 410');
    console.log(`verify-naver (unset): ${checks} checks passed`);
    process.exit(0);
}

assert.ok(mock, 'NAVER_MOCK_ORIGIN required.');
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%' OR key LIKE 'naver-ip:%' OR key LIKE 'trial-ip:%'");
// An earlier run's 네이버 계정 연결 of the manager is undone, so this run links it again.
sql("UPDATE users SET naver_id=NULL,naver_linked_at=NULL,phone_hash=NULL WHERE id='manager'");
// The 플러스 무료 체험 window is open for this suite and closed again at the end.
sql(`INSERT INTO settings(key,value,updated_at) VALUES('sys:trial_start','${Date.now() - 60000}',0),('sys:trial_end','${Date.now() + 86400000}',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

// Old ID/password members, as they were made before 네이버 로그인 (20,000-iteration PBKDF2).
const oldPass = 'old-pass-' + run;
const hash = (pw, salt) => `pbkdf2-sha256$20000$${pbkdf2Sync(pw, salt, 20000, 32, 'sha256').toString('hex')}`;
// The manager's password is the suite's again (a run that stopped inside the password-change check leaves another).
{ const salt = randomBytes(8).toString('hex'); sql(`UPDATE users SET password_hash='${hash(managerPassword, salt)}',salt='${salt}' WHERE id='manager'`); }
const olds = ['a', 'b', 'c'].map(k => ({ id: `nv-old-${k}-${run}`, username: `nvold_${k}_${run}`, nickname: `옛${k}${run}` }));
sql(olds.map(o => { const salt = randomBytes(8).toString('hex'); return `INSERT INTO users(id,username,nickname,password_hash,salt,role,bio,created_at) VALUES('${o.id}','${o.username}','${o.nickname}','${hash(oldPass, salt)}','${salt}','member','',${Date.now() - 86400000 * 40})`; }).join(';'));

const NAVER = k => `NVID${run}${k}`.toUpperCase();
const guest = browser();
equal((await guest('config')).data.naverLogin, true, 'config says 네이버 로그인 is set up');

// start: the authorize address and the state cookie.
{
    const b = browser();
    const start = await b('auth/naver/start?next=' + encodeURIComponent('/trade?kind=sell'));
    const to = new URL(start.location);
    equal([start.status, to.origin + to.pathname], [302, mock + '/oauth2.0/authorize'], 'start redirects to the authorize address');
    equal([to.searchParams.get('response_type'), to.searchParams.get('client_id'), to.searchParams.get('redirect_uri')], ['code', 'test-client', base + '/api/auth/naver/callback'], 'response_type, client_id and the redirect_uri from the request origin');
    check(/^[0-9a-f]{64}$/.test(to.searchParams.get('state') || ''), 'a random 32-byte state');
    const cookie = start.cookies.find(c => c.startsWith('zg_naver_state='));
    check(cookie && /HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie) && /Path=\/api\/auth\/naver/.test(cookie) && /Max-Age=600/.test(cookie), 'the state cookie is HttpOnly, SameSite=Lax, 10 minutes, on the Naver paths: ' + cookie);
    check(!cookie.includes('/trade'), 'next travels inside the signed cookie, not as plain text');
    const again = await b('auth/naver/start?next=/');
    check(new URL(again.location).searchParams.get('state') !== to.searchParams.get('state'), 'each start makes a new state');
}

// callback: the state must match the cookie.
{
    const b = browser();
    const start = await b('auth/naver/start?next=/');
    const state = new URL(start.location).searchParams.get('state');
    const wrong = await b(`auth/naver/callback?code=ok:${NAVER('w')}&state=${'0'.repeat(64)}`);
    equal([wrong.status, wrong.location], [302, '/naver?error=state'], 'a wrong state goes to the state message');
    check(wrong.cookies.some(c => c.startsWith('zg_naver_state=;')), 'the state cookie is cleared');
    const none = await browser()(`auth/naver/callback?code=ok:${NAVER('w')}&state=${state}`);
    equal(none.location, '/naver?error=state', 'a callback without the state cookie is refused');
    const forged = browser();
    forged.jar.set('zg_naver_state', { name: 'zg_naver_state', value: Buffer.from(JSON.stringify({ p: 'state', e: Date.now() + 60000, s: state, n: '/', m: 'login' })).toString('base64url') + '.' + 'ab'.repeat(32), path: '/api/auth/naver' });
    equal((await forged(`auth/naver/callback?code=ok:${NAVER('w')}&state=${state}`)).location, '/naver?error=state', 'a forged state cookie (wrong HMAC) is refused');
    const b2 = browser();
    const s2 = new URL((await b2('auth/naver/start?next=/')).location).searchParams.get('state');
    equal((await b2(`auth/naver/callback?error=access_denied&state=${s2}`)).location, '/naver?error=denied', 'a cancel on Naver goes to the cancel message');
    const b3 = browser();
    const s3 = new URL((await b3('auth/naver/start?next=/')).location).searchParams.get('state');
    equal((await b3(`auth/naver/callback?code=bad&state=${s3}`)).location, '/naver?error=naver', 'a refused token exchange goes to the failure message');
    const b4 = browser();
    const s4 = new URL((await b4('auth/naver/start?next=/posts/123')).location).searchParams.get('state');
    equal((await b4(`auth/naver/callback?error=access_denied&state=${s4}`)).location, '/naver?error=denied&next=%2Fposts%2F123', 'an error after the state check keeps the return path');
    equal(sql(`SELECT COUNT(*) AS n FROM users WHERE naver_id='${NAVER('w')}'`)[0].n, 0, 'no account from refused callbacks');
}

// New Naver account: 가입 마무리.
const fresh = browser();
let member;
{
    const cb = await naverLogin(fresh, NAVER('n'), 'https://evil.example/x');
    equal([cb.status, cb.location], [302, '/naver'], 'a new Naver account goes to 가입 마무리');
    const pendingCookie = cb.cookies.find(c => c.startsWith('zg_naver_pending='));
    check(pendingCookie && /HttpOnly/.test(pendingCookie) && /Path=\/api\/auth\/naver/.test(pendingCookie), 'the pending Naver id is in an HttpOnly cookie: ' + pendingCookie);
    check(!cb.location.includes(NAVER('n')) && !pendingCookie.includes(NAVER('n')), 'the Naver id is not in the URL or readable in the cookie');
    check(!cb.cookies.some(c => c.startsWith('zg_session=')), 'no session before 가입 마무리');
    equal((await fresh('auth/naver/pending')).data, { pending: true, trial: true }, 'pending: only whether a sign-in waits and whether the trial is open');
    equal((await guest('auth/naver/pending')).data, { pending: false }, 'another browser has nothing pending');
    equal((await guest('auth/naver/finish', 'POST', { nickname: '남의' + run, agree: true })).status, 400, 'finish without the pending cookie is refused');
    const noAgree = await fresh('auth/naver/finish', 'POST', { nickname: '네이버' + run });
    equal([noAgree.status, noAgree.data.error], [400, '이용 규칙에 동의해 주세요.'], 'finish needs the 이용 규칙 agreement');
    equal((await fresh('auth/naver/finish', 'POST', { nickname: '운영자' + run.slice(0, 3), agree: true })).status, 409, 'a reserved word is refused');
    const alike = await fresh('auth/naver/finish', 'POST', { nickname: olds[0].nickname.replace('옛', '옛 '), agree: true });
    equal([alike.status, alike.data.error], [409, '비슷한 닉네임이 이미 있습니다.'], 'a look-alike nickname is refused');
    const done = await fresh('auth/naver/finish', 'POST', { nickname: '네이버' + run, agree: true });
    equal(done.status, 200, 'finish creates the member');
    member = done.data.user;
    equal([member.nickname, member.role, done.data.next], ['네이버' + run, 'member', '/'], 'the chosen nickname, a member, and an outside next became /');
    equal([member.grade, member.grade_trial, done.data.trial.popup], ['plus', true, true], '플러스 7일 무료 체험 is applied as at sign-up');
    check(done.cookies.some(c => c.startsWith('zg_session=')) && done.cookies.some(c => c.startsWith('zg_naver_pending=;')), 'signed in; the pending cookie is cleared');
    equal((await fresh('auth/me')).data.user.id, member.id, 'auth/me is the new member');
    const row = sql(`SELECT username,password_hash,naver_id,naver_linked_at,nickname_key FROM users WHERE id='${member.id}'`)[0];
    check(/^n_[0-9a-f]{16}$/.test(row.username) && row.password_hash === '' && row.naver_id === NAVER('n') && row.naver_linked_at > 0, 'no password, n_ username, naver_id stored: ' + row.username);
    // The rename rule is unchanged: the first change after sign-up is free, the next waits 30 days.
    equal((await fresh('users/' + member.id, 'PUT', { nickname: '바꾼' + run, bio: '' })).status, 200, 'the first nickname change after sign-up');
    equal((await fresh('users/' + member.id, 'PUT', { nickname: '또바꾼' + run, bio: '' })).status, 409, 'the 30-day nickname rule applies');
}

// A pending cookie replayed after the account exists cannot make a second account.
{
    const b = browser();
    await naverLogin(b, NAVER('r'));
    const saved = b.jar.get('zg_naver_pending');
    equal((await b('auth/naver/finish', 'POST', { nickname: '재생' + run, agree: true })).status, 200, 'the first finish');
    b.jar.set('zg_naver_pending', saved);
    const replay = await b('auth/naver/finish', 'POST', { nickname: '재생둘' + run, agree: true });
    equal(replay.status, 409, 'a replayed pending cookie is refused (one account per Naver id)');
}

// The same Naver account signs in again.
{
    const b = browser();
    const cb = await naverLogin(b, NAVER('n'), '/trade?kind=sell');
    equal([cb.status, cb.location], [302, '/trade?kind=sell'], 'a linked Naver account goes straight to next');
    check(cb.cookies.some(c => /^zg_session=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\//.test(c)), 'the same session cookie as before');
    equal((await b('auth/me')).data.user.id, member.id, 'signed in as the member');
}

// 기존 계정 연결.
{
    const b = browser();
    await naverLogin(b, NAVER('l'));
    const wrong = await b('auth/naver/link', 'POST', { username: olds[0].username, password: 'wrong-' + oldPass });
    equal([wrong.status, wrong.data.error], [400, '아이디 또는 비밀번호가 맞지 않습니다.'], 'a wrong old password is refused (400, not 401)');
    equal((await b('auth/naver/link', 'POST', { username: 'nobody_' + run, password: oldPass })).status, 400, 'an unknown id is refused the same way');
    const ok = await b('auth/naver/link', 'POST', { username: olds[0].username, password: oldPass });
    equal([ok.status, ok.data.user.id, ok.data.user.nickname], [200, olds[0].id, olds[0].nickname], 'the old account is linked and signed in');
    equal((await b('auth/me')).data.user.id, olds[0].id, 'auth/me is the old account');
    const row = sql(`SELECT naver_id,password_hash,salt FROM users WHERE id='${olds[0].id}'`)[0];
    equal([row.naver_id, row.password_hash, row.salt], [NAVER('l'), '', ''], 'naver_id set; the old password is removed with the link');
    const again = browser();
    equal((await naverLogin(again, NAVER('l'))).location, '/', 'the linked account now signs in with Naver');
    // Once: another Naver account cannot take the same old account.
    const other = browser();
    await naverLogin(other, NAVER('l2'));
    equal((await other('auth/naver/link', 'POST', { username: olds[0].username, password: oldPass })).status, 400, 'the old password does not work a second time');
    equal((await guest('auth/naver/link', 'POST', { username: olds[1].username, password: oldPass })).status, 400, 'link without a pending Naver sign-in is refused');
    // Rate limit like login: 15 tries per id from one address.
    sql("DELETE FROM rate_limits WHERE key LIKE 'auth-user:%' OR key LIKE 'auth-ip:%'");
    let last;
    for (let i = 0; i < 16; i++) last = await other('auth/naver/link', 'POST', { username: olds[2].username, password: 'wrong-' + i + oldPass });
    equal(last.status, 429, 'the 16th try for one id within 10 minutes is 429');
    sql("DELETE FROM rate_limits WHERE key LIKE 'auth-user:%' OR key LIKE 'auth-ip:%'");
}

// The old member endpoints answer 410 (no LEGACY_AUTH_TEST on this server).
{
    const b = browser();
    for (const [p, data] of [['auth/register', { username: 'nvnew_' + run, password: 'password-' + run, nickname: '새옛' + run }], ['auth/signup', { username: 'nvnew_' + run, password: 'password-' + run, nickname: '새옛' + run }],
        ['auth/login', { username: olds[1].username, password: oldPass }], ['auth/reset-request', { username: olds[1].username, contact: '010-0000-0000' }]]) {
        const r = await b(p, 'POST', data);
        equal([r.status, r.data.error], [410, MOVED], `${p} is 410 for members`);
    }
    equal((await fresh('auth/password', 'POST', { current: 'x'.repeat(8), next: 'y'.repeat(8) })).status, 410, 'password change is 410 for members');
    equal(sql(`SELECT COUNT(*) AS n FROM users WHERE username='nvnew_${run}'`)[0].n, 0, 'no account from the refused sign-up');
}

// The manager: /manager-login, auth/login, and 네이버 계정 연결.
const manager = browser();
{
    const asMember = await browser()('auth/manager-login', 'POST', { username: olds[1].username, password: oldPass });
    equal([asMember.status, asMember.data.error], [401, '아이디 또는 비밀번호가 맞지 않습니다.'], 'manager-login refuses a member with the right password');
    equal((await browser()('auth/manager-login', 'POST', { username: 'sosirusok', password: 'wrong-' + managerPassword })).status, 401, 'manager-login refuses a wrong password');
    const ok = await manager('auth/manager-login', 'POST', { username: 'sosirusok', password: managerPassword });
    equal([ok.status, ok.data.user.role], [200, 'manager'], 'the manager signs in on manager-login');
    equal((await browser()('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'auth/login still takes the manager');
    equal((await manager('auth/me')).data.naver, false, 'auth/me: the manager has no Naver link yet');
    equal((await fresh('auth/me')).data.naver, undefined, 'members get no naver field');
    // A member cannot start a link.
    equal((await fresh('auth/naver/start?link=1&next=/manage/settings')).location, '/naver?error=state', 'link=1 needs the manager session');
    // A Naver account a member already uses cannot be linked to the manager.
    equal((await naverLogin(manager, NAVER('n'), '/manage/settings', { link: true })).location, '/naver?error=taken&next=%2Fmanage%2Fsettings', 'a Naver account in use is refused, keeping the return path');
    const linked = await naverLogin(manager, NAVER('m'), '/manage/settings', { link: true });
    equal([linked.status, linked.location], [302, '/manage/settings'], 'the manager links a Naver account');
    equal((await manager('auth/me')).data.naver, true, 'auth/me: linked');
    const viaNaver = browser();
    await naverLogin(viaNaver, NAVER('m'));
    equal((await viaNaver('auth/me')).data.user.role, 'manager', 'the manager signs in with Naver');
    equal((await browser()('auth/manager-login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'and with the password, both work');
    // 기존 계정 연결 with the manager account: refused (it links only from its own session).
    const other = browser();
    await naverLogin(other, NAVER('m2'));
    const twice = await other('auth/naver/link', 'POST', { username: 'sosirusok', password: managerPassword });
    equal([twice.status, twice.data.error], [403, '관리자 계정은 로그인한 뒤 설정에서 네이버를 연결해 주세요.'], '기존 계정 연결 refuses the manager account');
    // A manager password change drops the Naver link, so a link made with a leaked password stops working.
    const changed = 'changed-' + managerPassword;
    equal((await manager('auth/password', 'POST', { current: managerPassword, next: changed })).status, 200, 'the manager changes the password');
    equal((await manager('auth/me')).data.naver, false, 'the password change removed the Naver link');
    equal((await naverLogin(browser(), NAVER('m'))).location, '/naver', 'the old Naver link no longer signs in as the manager');
    equal((await manager('auth/password', 'POST', { current: changed, next: managerPassword })).status, 200, 'and the password is put back');
    // The member panel shows only whether a Naver account is linked, and no temporary password for a linked member.
    const panel = await manager('manage/users/' + member.id);
    equal(panel.data.user.naver, true, 'the member panel: 네이버 연결 yes');
    equal((await manager('manage/users/' + olds[1].id)).data.user.naver, false, 'the member panel: 네이버 연결 no');
    equal((await manager(`manage/users/${member.id}/password`, 'POST', {})).status, 409, 'no temporary password for a Naver-linked member');
    const temp = await manager(`manage/users/${olds[1].id}/password`, 'POST', {});
    equal(temp.status, 200, 'a temporary password for an old member who has not linked yet');
    const b = browser();
    await naverLogin(b, NAVER('t'));
    equal((await b('auth/naver/link', 'POST', { username: olds[1].username, password: temp.data.password })).data.user?.id, olds[1].id, 'the temporary password links the old account');
}

// naver_id and the Naver profile are never sent: lists, profiles, posts, chats, the manager's views.
{
    const post = await fresh('posts', 'POST', { kind: 'sell', category: 'other', title: `[QA] 네이버 ${run}`, body: '자동 검증', price: 10000, accepts_offers: true, status: 'open', tags: [], images: [], details: {} });
    equal(post.status, 201, 'the Naver member writes a post');
    const chat = await manager('chats', 'POST', { userId: member.id });
    await manager(`chats/${chat.data.id}/messages`, 'POST', { body: '안녕하세요' });
    for (const p of ['auth/me', 'config', 'home', 'stats', `users/${member.id}`, `users/${olds[0].id}`, `posts/${post.data.id}`, 'posts?kind=sell', `posts?author=${member.id}`, 'chats', `chats/${chat.data.id}`, `chats/${chat.data.id}/messages`]) {
        await fresh(p); await guest(p); await manager(p);
    }
    for (const p of [`manage/users?q=${encodeURIComponent('바꾼' + run)}`, 'manage/users', `manage/users/${member.id}`, `manage/users/${olds[0].id}`, 'manage', 'manage/reset-requests']) await manager(p);
    const naverIds = ['n', 'l', 'm', 'r', 't'].map(NAVER);
    const leaks = seen.filter(s => naverIds.some(id => s.text.includes(id)) || /naver_id|naver_linked_at/.test(s.text));
    equal(leaks.map(s => s.p), [], `no response carries a naver_id (${seen.length} responses)`);
    const profile = ['네이버별명목', '홍길동목업', 'mock-user@naver.example', 'phinf.example'];
    equal(seen.filter(s => profile.some(v => s.text.includes(v))).map(s => s.p), [], 'no response carries a Naver nickname, name, email or photo');
}

// 같은 휴대전화번호: a second Naver account with an active member's number cannot sign up.
{
    const phone = mockMobile(NAVER('n'));
    const same = await naverLogin(browser(), NAVER('p') + '|' + phone.replace(/-/g, ''));
    equal(same.location, '/naver?error=phone', 'another Naver account with the same number (no dashes) is refused');
    check(!same.cookies.some(c => c.startsWith('zg_naver_pending=') && !c.startsWith('zg_naver_pending=;')), 'no pending sign-up for it');
    equal((await naverLogin(browser(), NAVER('p2') + '|+82 ' + phone.slice(1))).location, '/naver?error=phone', 'the +82 form is the same number');
    equal((await naverLogin(browser(), NAVER('n'))).location, '/', 'the member who has the number still signs in');
    equal((await naverLogin(browser(), NAVER('q') + '|-')).location, '/naver', 'without a number from Naver the sign-up goes on');
    const stored = sql(`SELECT phone_hash FROM users WHERE id='${member.id}'`)[0].phone_hash;
    check(/^[0-9a-f]{64}$/.test(stored), 'the member has a phone hash, not the number');
    // Two sign-ups with one number at once: the second 가입 마무리 is refused.
    const shared = mockMobile(NAVER('race')), r1 = browser(), r2 = browser();
    equal((await naverLogin(r1, NAVER('r1') + '|' + shared)).location, '/naver', 'first pending sign-up');
    equal((await naverLogin(r2, NAVER('r2') + '|' + shared)).location, '/naver', 'second pending sign-up before the first finished');
    equal((await r1('auth/naver/finish', 'POST', { nickname: '번호하나' + run, agree: true })).status, 200, 'the first one joins');
    const second = await r2('auth/naver/finish', 'POST', { nickname: '번호둘' + run, agree: true });
    equal([second.status, second.data.error], [409, '같은 휴대전화번호로 가입된 계정이 있습니다. 처음 가입한 네이버 계정으로 로그인해 주세요.'], 'the second is refused at 가입 마무리');
    // 기존 계정 연결 with a pending sign-in from before the number was taken: refused too.
    const linkShared = mockMobile(NAVER('lrace')), l1 = browser(), l2 = browser();
    await naverLogin(l1, NAVER('l3') + '|' + linkShared);
    await naverLogin(l2, NAVER('l4') + '|' + linkShared);
    equal((await l1('auth/naver/finish', 'POST', { nickname: '연결번호' + run, agree: true })).status, 200, 'one Naver account takes the number');
    const spare = { id: `nv-old-d-${run}`, username: `nvold_d_${run}` }, spareSalt = randomBytes(8).toString('hex');
    sql(`INSERT INTO users(id,username,nickname,password_hash,salt,role,bio,created_at) VALUES('${spare.id}','${spare.username}','옛d${run}','${hash(oldPass, spareSalt)}','${spareSalt}','member','',${Date.now() - 86400000 * 40})`);
    const lateLink = await l2('auth/naver/link', 'POST', { username: spare.username, password: oldPass });
    equal([lateLink.status, lateLink.data.error], [409, '같은 휴대전화번호로 가입된 계정이 있습니다. 처음 가입한 네이버 계정으로 로그인해 주세요.'], '기존 계정 연결 with the same number is refused');
    equal(sql(`SELECT naver_id FROM users WHERE id='${spare.id}'`)[0].naver_id, null, 'the old account stays unlinked');
    // A member from before the check gets the hash at the next Naver login.
    sql(`UPDATE users SET phone_hash=NULL WHERE id='${member.id}'`);
    await naverLogin(browser(), NAVER('n'));
    equal(sql(`SELECT phone_hash FROM users WHERE id='${member.id}'`)[0].phone_hash, stored, 'the hash is stored at the next login');
    equal(seen.filter(s => /phone_hash/.test(s.text) || s.text.includes(phone) || s.text.includes(phone.replace(/-/g, ''))).map(s => s.p), [], 'no response carries the number or its hash');
}

// Nothing from Naver is stored but response.id: no access or refresh token, no profile field (raw database files).
{
    const { log } = await (await fetch(mock + '/__log')).json();
    const tokens = log.filter(e => e.access).flatMap(e => [e.access, e.refresh]);
    check(tokens.length >= 8, `the mock handed out tokens (${tokens.length})`);
    check(log.filter(e => e.path === '/oauth2.0/token').every(e => e.grant_type === 'authorization_code' && e.client_id === 'test-client' && e.secret_ok), 'every token call is authorization_code with the client values');
    const files = [];
    const walk = d => { for (const n of readdirSync(d)) { const f = path.join(d, n); if (statSync(f).isDirectory()) walk(f); else files.push(f); } };
    walk(path.join(root, persist, 'v3', 'd1'));
    const bytes = files.map(f => readFileSync(f));
    check(bytes.some(b => b.includes(Buffer.from(NAVER('n')))), 'the search reaches the stored rows (a naver_id is found)');
    const numbers = [NAVER('n'), NAVER('race')].map(mockMobile).flatMap(m => [m, m.replace(/-/g, '')]);
    const found = [...tokens, ...numbers, '홍길동목업', 'mock-user@naver.example', '네이버별명목'].filter(t => bytes.some(b => b.includes(Buffer.from(t))));
    equal(found, [], `no token, phone number or Naver profile field in the D1 files (${files.length} files)`);
}

// 회원 탈퇴 frees the Naver account, which may then sign up again.
{
    const w = browser();
    await naverLogin(w, NAVER('x'));
    const joined = await w('auth/naver/finish', 'POST', { nickname: '탈퇴할' + run, agree: true });
    equal((await w('auth/withdraw', 'POST', { confirm: '회원' })).status, 400, 'withdraw needs the confirm text');
    equal((await w('auth/withdraw', 'POST', { confirm: '회원 탈퇴' })).status, 200, 'the member withdraws');
    equal(sql(`SELECT naver_id FROM users WHERE id='${joined.data.user.id}'`)[0].naver_id, null, 'the Naver link is removed');
    equal((await naverLogin(browser(), NAVER('x'))).location, '/naver', 'the same Naver account goes to 가입 마무리 again');
    equal(sql(`SELECT phone_hash FROM users WHERE id='${joined.data.user.id}'`)[0].phone_hash, null, 'the phone hash is removed');
    equal((await naverLogin(browser(), NAVER('x2') + '|' + mockMobile(NAVER('x')))).location, '/naver', 'another Naver account with that number may sign up after the withdrawal');
}

sql("UPDATE settings SET value='-1' WHERE key='sys:trial_end'");
console.log(`verify-naver: ${checks} checks passed`);
