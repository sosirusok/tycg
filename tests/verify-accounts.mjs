import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Accounts: look-alike nicknames (and the lazy key backfill), the 30-day nickname rule and the
// previous nickname, password change, the manager's temporary password and 회원 탈퇴.
// Runs only against a local Worker (see scripts/test-local.mjs).
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const DAY = 86400000;
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

// Reads or changes the local D1 database the Worker is using.
function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

function client() {
    let cookie = '';
    return async (path, method = 'GET', data) => {
        const response = await fetch(base + '/api/' + path, {
            method, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: data === undefined ? undefined : JSON.stringify(data),
        });
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const raw = await response.text();
        let result;
        try { result = JSON.parse(raw); }
        catch { throw new Error(`${method} ${path}: expected JSON, received HTTP ${response.status}: ${raw.slice(0, 300)}`); }
        return { status: response.status, data: result };
    };
}

const username = name => `a_${run}_${name}`.slice(0, 24);
async function register(name, nickname = `${name}${run}`) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: username(name), password, nickname });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}
const login = (name, pass) => client()('auth/login', 'POST', { username: username(name), password: pass });

// Every local request shares one address, and the suites before this one use most of its
// 40 sign-ins per 10 minutes, so this suite starts from a fresh address window.
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%'");

const manager = client(), guest = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');

// Look-alike nicknames: spaces, punctuation and case do not make a new nickname.
{
    const x = await register('x', `ab${run}`);
    equal(x.user.nickname, `ab${run}`, 'X registers ab+run');
    for (const nickname of [`a b${run}`, `ab${run}.`, `AB${run}_`]) {
        const r = await client()('auth/register', 'POST', { username: username('l' + checks), password, nickname });
        equal([r.status, r.data.error], [409, '비슷한 닉네임이 이미 있습니다.'], `register ${JSON.stringify(nickname)} is refused as a look-alike`);
    }
    const exact = await client()('auth/register', 'POST', { username: username('same'), password, nickname: `ab${run}` });
    equal([exact.status, exact.data.error], [409, '이미 사용 중인 닉네임입니다.'], 'the exact nickname keeps its own message');
    const y = await register('y');
    const put = await y('users/' + y.user.id, 'PUT', { nickname: `Ab-${run}!`, bio: '' });
    equal([put.status, put.data.error], [409, '비슷한 닉네임이 이미 있습니다.'], 'profile PUT to a look-alike is refused');
    const reserved = await client()('auth/register', 'POST', { username: username('rsv'), password, nickname: `탈퇴회원${run.slice(0, 4)}` });
    equal(reserved.status, 409, '탈퇴회원 is a reserved word');
    for (const nickname of ['탈퇴!회원', '매!니저', '관리/자' + run.slice(0, 2)]) {
        const r = await client()('auth/register', 'POST', { username: username('rsvp'), password, nickname });
        equal([r.status, r.data.error], [409, '사용할 수 없는 닉네임입니다.'], `reserved look-alike ${JSON.stringify(nickname)} is refused`);
    }
}

// Rows written without a key (older members, or SQL) are keyed before the next check.
{
    const id = crypto.randomUUID();
    sql(`INSERT INTO users (id,username,nickname,password_hash,salt,role,bio,created_at) VALUES ('${id}','${username('sqlkey')}','키${run}','','','member','',${Date.now()})`);
    equal(sql(`SELECT nickname_key FROM users WHERE id='${id}'`)[0].nickname_key, null, 'SQL row starts without a nickname key');
    const r = await client()('auth/register', 'POST', { username: username('sqlkey2'), password, nickname: `키 ${run}!` });
    equal([r.status, r.data.error], [409, '비슷한 닉네임이 이미 있습니다.'], 'look-alike of a key-less row is refused (lazy backfill)');
    equal(sql(`SELECT nickname_key FROM users WHERE id='${id}'`)[0].nickname_key, `키${run}`, 'the key-less row now has its key');
    // A nickname the previous Worker changes (the key is left as it was) loses its stale key.
    sql(`UPDATE users SET nickname='바뀐${run}' WHERE id='${id}'`);
    equal(sql(`SELECT nickname_key FROM users WHERE id='${id}'`)[0].nickname_key, null, 'a nickname change without a key clears the stale key');
    const renamed = await client()('auth/register', 'POST', { username: username('sqlkey3'), password, nickname: `바뀐 ${run}` });
    equal([renamed.status, renamed.data.error], [409, '비슷한 닉네임이 이미 있습니다.'], 'the new nickname is protected after the lazy backfill');
    equal((await register('sqlkey4', `키${run}`)).user.nickname, `키${run}`, 'the old nickname is free again');
    sql(`DELETE FROM users WHERE id='${id}'`);
}

// Nickname changes: once every 30 days, the previous nickname shows for 90 days.
{
    const n = await register('nick');
    const first = await n('users/' + n.user.id, 'PUT', { nickname: `new${run}`, bio: '' });
    equal(first.status, 200, 'first nickname change after sign-up is allowed');
    const shown = (await guest('users/' + n.user.id)).data.user;
    equal([shown.nickname, shown.prev_nickname], [`new${run}`, `nick${run}`], 'profile shows the previous nickname');
    check(!('nickname_changed_at' in shown) && !('nickname_next_at' in shown), 'the change time itself is not exposed');
    const own = (await n('users/' + n.user.id)).data.user;
    check(own.nickname_next_at > Date.now() + 29 * DAY, 'the member sees when the nickname can change again');
    const again = await n('users/' + n.user.id, 'PUT', { nickname: `newer${run}`, bio: '' });
    equal(again.status, 409, 'a second change right away is refused');
    check(again.data.error.includes('30일') && /\(\d{1,2}월 \d{1,2}일부터 가능\)$/.test(again.data.error), `the refusal names the date: ${again.data.error}`);
    equal((await n('users/' + n.user.id, 'PUT', { nickname: `new${run}`, bio: '소개' })).status, 200, 'the bio still saves with the same nickname');
    sql(`UPDATE users SET nickname_changed_at=${Date.now() - 31 * DAY} WHERE id='${n.user.id}'`);
    equal((await n('users/' + n.user.id, 'PUT', { nickname: `newer${run}`, bio: '' })).status, 200, 'after 30 days the nickname can change again');
    equal((await guest('users/' + n.user.id)).data.user.prev_nickname, `new${run}`, 'the previous nickname follows the latest change');
    sql(`UPDATE users SET nickname_changed_at=${Date.now() - 91 * DAY} WHERE id='${n.user.id}'`);
    check(!('prev_nickname' in (await guest('users/' + n.user.id)).data.user), 'the previous nickname is hidden after 90 days');

    // The manager's nickname stays 우와오 (owner requirement), so the manager never reaches the 30-day rule.
    const me = (await manager('auth/me')).data.user;
    for (const bio of ['매니저 소개 1', '좀비고 거래소 매니저입니다.']) equal((await manager('users/' + me.id, 'PUT', { nickname: '우와오', bio })).status, 200, 'manager saves the profile: ' + bio);
    const rename = await manager('users/' + me.id, 'PUT', { nickname: `mgr${run}`, bio: '' });
    equal([rename.status, (await guest('users/' + me.id)).data.user.nickname], [400, '우와오'], 'the manager nickname stays 우와오');
    await manager('users/' + me.id, 'PUT', { nickname: '우와오', bio: '좀비고 거래소 매니저입니다.' });
}

// Password change: 400 for a wrong current password (never 401), other sessions end.
{
    const p = await register('pw');
    const other = client();
    equal((await other('auth/login', 'POST', { username: username('pw'), password })).status, 200, 'a second device logs in');
    const wrong = await p('auth/password', 'POST', { current: 'wrong-password', next: 'brand-new-pass' });
    equal([wrong.status, wrong.data.error], [400, '현재 비밀번호가 맞지 않습니다.'], 'wrong current password is 400, not 401');
    const short = await p('auth/password', 'POST', { current: password, next: 'short' });
    equal([short.status, short.data.error], [400, '새 비밀번호는 8~128자, 현재와 다르게 입력해 주세요.'], 'a short new password is refused');
    equal((await p('auth/password', 'POST', { current: password, next: password })).status, 400, 'the same password is refused');
    const next = 'new-' + randomBytes(8).toString('hex');
    equal((await p('auth/password', 'POST', { current: password, next })).status, 200, 'password change with the right current password');
    equal((await login('pw', password)).status, 401, 'the old password no longer logs in');
    equal((await login('pw', next)).status, 200, 'the new password logs in');
    equal((await other('auth/me')).data.user, null, 'the other device is signed out');
    equal((await p('auth/me')).data.user?.id, p.user.id, 'the changing device stays signed in');
    equal((await guest('auth/password', 'POST', { current: password, next })).status, 401, 'a guest cannot change a password');
}

// Temporary password from the manager.
{
    const t = await register('temp'), m = await register('tmember');
    equal((await m(`manage/users/${t.user.id}/password`, 'POST', {})).status, 403, 'a member cannot issue a temporary password');
    const r = await manager(`manage/users/${t.user.id}/password`, 'POST', {});
    equal(r.status, 200, 'the manager issues a temporary password');
    check(/^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/.test(r.data.password), 'the temporary password is 10 unambiguous characters');
    equal((await t('auth/me')).data.user, null, 'the member is signed out everywhere');
    equal((await login('temp', password)).status, 401, 'the old password no longer logs in');
    equal((await login('temp', r.data.password)).status, 200, 'the temporary password logs in');
    const me = (await manager('auth/me')).data.user;
    equal((await manager(`manage/users/${me.id}/password`, 'POST', {})).status, 400, 'no temporary password for the manager account');
}

// 회원 탈퇴.
{
    const w = await register('withdraw'), buyer = await register('wbuyer');
    const sale = title => ({ kind: 'sell', category: 'other', title, body: '자동 검증', price: 300000, accepts_offers: true, status: 'open', tags: [], images: [], details: {} });
    const post = await w('posts', 'POST', sale(`[QA] 탈퇴 ${run}`));
    equal(post.status, 201, 'the member writes a post');
    const offer = await buyer('offers', 'POST', { postId: post.data.id, amount: 250000 });
    equal(offer.status, 201, 'another member offers on it');
    // The member's own offer on the other member's post is accepted, so that post is 예약중.
    const theirs = await buyer('posts', 'POST', sale(`[QA] 탈퇴 상대 ${run}`));
    const sent = await w('offers', 'POST', { postId: theirs.data.id, amount: 200000 });
    equal((await buyer('offers/' + sent.data.id, 'PATCH', { action: 'accepted' })).status, 200, 'the other member accepts the member\'s offer');
    equal((await guest('posts/' + theirs.data.id)).data.post.status, 'reserved', 'that post is 예약중');
    equal((await manager(`manage/users/${w.user.id}/badges`, 'POST', { badge: 'identity', active: true })).status, 200, 'the member holds 본인 인증');
    equal((await manager(`manage/users/${w.user.id}/grades`, 'POST', { grade: 'plus', plan: 'permanent' })).status, 201, 'the member holds 플러스');
    const wrong = await w('auth/withdraw', 'POST', { password: 'wrong-password' });
    equal([wrong.status, wrong.data.error], [400, '비밀번호가 맞지 않습니다.'], 'withdraw with a wrong password is 400');
    equal((await w('auth/withdraw', 'POST', { password })).status, 200, 'withdraw with the right password');
    equal((await w('auth/me')).data.user, null, 'the withdrawn member is signed out');
    let started = Date.now();
    equal((await login('withdraw', password)).status, 401, 'the old id no longer logs in');
    check(Date.now() - started < 1000, `login for the old id answers in under 1s (${Date.now() - started} ms)`);
    const placeholder = sql(`SELECT username,password_hash FROM users WHERE id='${w.user.id}'`)[0];
    check(placeholder.username.startsWith('deleted_') && placeholder.password_hash === '', 'the row keeps a deleted_ id and no password');
    started = Date.now();
    equal((await client()('auth/login', 'POST', { username: placeholder.username, password })).status, 401, 'the deleted_ id does not log in');
    check(Date.now() - started < 1000, `an empty stored hash answers in under 1s (${Date.now() - started} ms)`);
    const profile = (await guest('users/' + w.user.id)).data.user;
    equal([profile.nickname, profile.deleted, profile.grade], ['탈퇴회원', true, 'normal'], 'the profile is plain 탈퇴회원, marked deleted');
    equal([profile.bio, profile.badges], ['', []], 'bio and badges are gone');
    equal([sql(`SELECT COUNT(*) AS n FROM user_badges WHERE user_id='${w.user.id}'`)[0].n, sql(`SELECT COUNT(*) AS n FROM user_grades WHERE user_id='${w.user.id}'`)[0].n], [1, 1], 'grade and badge rows stay as the manager\'s record');
    check(sql(`SELECT nickname_key FROM users WHERE id='${w.user.id}'`)[0].nickname_key.startsWith('#deleted:'), 'the withdrawn row has a #deleted: key, never NULL');
    equal((await manager(`manage/users/${w.user.id}/grades`, 'POST', { grade: 'premium', plan: '6m' })).data.error, '탈퇴한 회원입니다.', 'no grade for a withdrawn member');
    equal((await manager(`manage/users/${w.user.id}/badges`, 'POST', { badge: 'proxy', active: true })).data.error, '탈퇴한 회원입니다.', 'no badge for a withdrawn member');
    const vis = await manager('manage/visibility', 'POST', { postId: post.data.id, hidden: false });
    equal([vis.status, vis.data.error], [409, '탈퇴한 회원의 글입니다.'], 'the manager cannot publish a withdrawn member\'s post');
    const seen = (await manager('posts/' + post.data.id)).data.post;
    equal([seen.nickname, seen.author_deleted, seen.author_badges, seen.author_grade], ['탈퇴회원', true, [], 'normal'], 'the manager sees the post\'s author as plain 탈퇴회원');
    const late = await manager('offers', 'POST', { postId: post.data.id, amount: 250000 });
    equal([late.status, late.data.error], [409, '탈퇴한 회원의 글입니다.'], 'an offer on a withdrawn member\'s post names the reason');
    // The chat the two offers share: both end with a line, the 예약중 post is 거래중 again, and nobody can write there.
    const lines = (await buyer(`chats/${offer.data.chatId}/messages`)).data.messages.filter(m => m.type === 'system').map(m => m.body);
    check(lines.includes('회원 탈퇴로 제시가 마감되었습니다.') && lines.includes('회원 탈퇴로 제시가 마감되었습니다. 글이 거래중으로 바뀌었습니다.'), 'both ended offers leave a line: ' + JSON.stringify(lines));
    equal([(await guest('posts/' + theirs.data.id)).data.post.status, (await buyer('offers')).data.offers.find(o => o.id === sent.data.id)?.status], ['open', 'cancelled'], 'the 예약중 post is 거래중 again and the accepted offer ended');
    const room = (await buyer('chats/' + offer.data.chatId)).data.chat;
    equal([room.partner.nickname, room.partner.deleted], ['탈퇴회원', true], 'the chat shows the partner as 탈퇴회원');
    const reply = await buyer(`chats/${offer.data.chatId}/messages`, 'POST', { body: '네 말씀하세요' });
    equal([reply.status, reply.data.error], [404, '탈퇴한 회원입니다.'], 'nobody can write to a withdrawn member');
    equal((await guest('posts?author=' + w.user.id)).data.posts.length, 0, 'a guest sees none of the withdrawn member\'s posts');
    equal((await guest('posts/' + post.data.id)).status, 404, 'the post itself is hidden');
    const chat = await buyer('chats', 'POST', { userId: w.user.id });
    equal([chat.status, chat.data.error], [404, '탈퇴한 회원입니다.'], 'a chat with a withdrawn member is refused');
    equal((await buyer('offers')).data.offers.find(o => o.id === offer.data.id)?.status, 'cancelled', 'the open offer on the post ended');
    const hidden = (await manager('manage')).data.hidden;
    check(!hidden.some(p => p.id === post.data.id), 'withdrawn posts stay out of the manager\'s 숨긴 글');
    equal((await register('wagain', `withdraw${run}`)).user.nickname, `withdraw${run}`, 'the freed nickname can be registered again');
    const mine = await manager('auth/withdraw', 'POST', { password: managerPassword });
    equal([mine.status, mine.data.error], [403, '매니저 계정은 탈퇴할 수 없습니다.'], 'the manager cannot withdraw');
    equal((await manager('auth/me')).data.user?.role, 'manager', 'the manager is still signed in');
}

console.log(`verify-accounts: ${checks} checks passed`);
