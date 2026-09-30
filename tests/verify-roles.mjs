import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only role 'manager' changes grades or badges or decides applications. A member with the 관리자
// grade (GradeId 'admin') and a plain member get 403 on every manager route and change nothing;
// the manager gets 200/201 on the same calls. Also checks the 6-month renewal (one row, extended),
// and, when the 0009 triggers are present, that the DB refuses non-manager grants.
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

function wranglerSql(command) {
    return execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
}
const sql = command => { const out = wranglerSql(command); return JSON.parse(out.slice(out.indexOf('[')))[0].results; };
// Runs SQL that must fail; returns everything wrangler printed.
function sqlFails(command) {
    try { wranglerSql(command); }
    catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; }
    throw new Error('expected the SQL to fail: ' + command);
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

const username = name => `r_${run}_${name}`.slice(0, 24);
async function register(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: username(name), password, nickname: `역할${name}${run}` });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}

// The suites before this one use most of the 40 sign-ins per 10 minutes from this address.
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%'");

const manager = client(), guest = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const a = await register('a'), b = await register('b');
let c = await register('c');
const A = a.user.id, B = b.user.id, C = c.user.id;

// Setup: B gets the 관리자 grade; C has a pending 본인 인증 application and a 6-month 프리미엄.
equal((await manager(`manage/users/${B}/grades`, 'POST', { grade: 'admin', plan: 'permanent' })).status, 201, 'manager appoints B 관리자');
const appC = await c('applications', 'POST', { kind: 'badge', target: 'identity' });
equal(appC.status, 201, 'C applies for 본인 인증');
const firstGrant = Date.now();
equal((await manager(`manage/users/${C}/grades`, 'POST', { grade: 'premium', plan: '6m' })).status, 201, 'manager grants C 프리미엄 6개월');
let detailC = await manager('manage/users/' + C);
const premiumRow = detailC.data.grants.find(g => g.grade === 'premium');
check(premiumRow && premiumRow.expires_at > firstGrant, 'C has a 6-month 프리미엄 row');
const beforeC = (await guest('users/' + C)).data.user;
equal([beforeC.grade, beforeC.badges], ['premium', []], 'C starts as 프리미엄 without badges');

// A post and a report for the visibility and report routes.
const post = await a('posts', 'POST', { kind: 'sell', category: 'account', title: `[QA] 역할 검증 ${run}`, body: '자동 검증', price: 10000, status: 'open', tags: [], images: [], details: {} });
equal(post.status, 201, 'A writes a post');
equal((await c('reports', 'POST', { postId: post.data.id, reason: '허위 매물', details: '자동 검증' })).status, 200, 'C reports the post');
const report = (await manager('manage')).data.reports.find(r => r.post_id === post.data.id);
check(report, 'the report reaches the manager');

const notice = { title: `[QA] 역할 공지 ${run}`, body: '자동 검증' };
const calls = [
    ['GET', 'manage'],
    ['GET', 'manage/users'],
    ['GET', `manage/users/${C}`],
    ['POST', `manage/users/${C}/grades`, { grade: 'plus', plan: 'permanent' }],
    ['POST', `manage/users/${C}/badges`, { badge: 'identity', active: true }],
    ['DELETE', `manage/users/${C}/grades/${premiumRow.id}`],
    ['POST', `manage/users/${C}/password`, {}],
    ['GET', 'manage/applications'],
    ['PATCH', `applications/${appC.data.id}`, { action: 'approve' }],
    ['PATCH', `applications/${appC.data.id}`, { action: 'reject', note: '자료 부족' }],
    ['PUT', 'manage/settings', { paymentNotice: `가짜 계좌 ${run}`, latestSeason: 99 }],
    ['POST', 'manage/notice', notice],
    ['POST', 'manage/visibility', { postId: post.data.id, hidden: true, reason: '허위 매물' }],
    ['POST', 'manage/report', { id: report.id, status: 'resolved' }],
];
for (const [who, caller] of [['관리자 B', b], ['member A', a]]) {
    for (const [method, path, data] of calls) {
        const r = await caller(path, method, data);
        equal(r.status, 403, `${who}: ${method} ${path} is 403`);
    }
}

// The refusal comes before any lookup, so it does not reveal whether an application exists.
equal((await a('applications/00000000-0000-4000-8000-000000000000', 'PATCH', { action: 'approve' })).status, 403, 'approving an unknown id is the same 403');
equal((await a(`applications/${appC.data.id}`, 'PATCH', { action: 'cancel' })).status, 404, "another member cannot cancel (or see) C's application");

// Nothing changed.
const afterC = (await guest('users/' + C)).data.user;
equal([afterC.grade, afterC.badges], [beforeC.grade, beforeC.badges], "C's grade and badges are unchanged");
equal((await c('applications')).data.applications.find(x => x.id === appC.data.id)?.status, 'pending', "C's application is still pending");
equal((await c('auth/me')).data.user?.id, C, 'C is still signed in (no temporary password was issued)');
detailC = await manager('manage/users/' + C);
equal(detailC.data.grants.map(g => [g.id, g.grade, g.expires_at]), [[premiumRow.id, 'premium', premiumRow.expires_at]], "C's grant rows are unchanged");
const config = (await guest('config')).data;
check(!config.paymentNotice.includes(run) && config.latestSeason < 99, 'settings are unchanged');
check(!(await guest('notices')).data.notices.some(n => n.title === notice.title), 'no notice was posted');
equal((await guest('posts/' + post.data.id)).status, 200, 'the post is still public');
equal((await manager('manage')).data.reports.find(r => r.id === report.id)?.status, 'pending', 'the report is still pending');

// B cannot grant itself anything, and stays a member.
equal((await b(`manage/users/${B}/grades`, 'POST', { grade: 'elite' })).status, 403, 'B cannot grant itself 엘리트');
equal((await b(`manage/users/${B}/badges`, 'POST', { badge: 'proxy', active: true })).status, 403, 'B cannot grant itself 대리 인증');
const meB = (await b('auth/me')).data.user;
equal([meB.role, meB.grade, meB.badges], ['member', 'admin', []], 'B is role member with the 관리자 grade');

// F14: a second 6-month grant extends the one row: 12 calendar months from the first grant.
equal((await manager(`manage/users/${C}/grades`, 'POST', { grade: 'premium', plan: '6m' })).status, 201, 'manager grants C 프리미엄 6개월 again');
detailC = await manager('manage/users/' + C);
let premiumRows = detailC.data.grants.filter(g => g.grade === 'premium');
equal(premiumRows.length, 1, 'C still has exactly one 프리미엄 row');
const yearAhead = new Date(firstGrant);
yearAhead.setUTCFullYear(yearAhead.getUTCFullYear() + 1);
check(Math.abs(premiumRows[0].expires_at - yearAhead.getTime()) <= 2 * DAY, `the row ends 12 calendar months ahead (${new Date(premiumRows[0].expires_at).toISOString()})`);
equal(premiumRows[0].id, premiumRow.id, 'the same row was extended');
// An approved 6-month application extends the same row too.
const renew = await c('applications', 'POST', { kind: 'grade', target: 'premium', plan: '6m' });
equal(renew.status, 201, 'C applies to renew 프리미엄 6개월');
equal((await manager(`applications/${renew.data.id}`, 'PATCH', { action: 'approve' })).status, 200, 'manager approves the renewal');
detailC = await manager('manage/users/' + C);
premiumRows = detailC.data.grants.filter(g => g.grade === 'premium');
const eighteen = new Date(firstGrant);
eighteen.setUTCMonth(eighteen.getUTCMonth() + 18);
check(premiumRows.length === 1 && Math.abs(premiumRows[0].expires_at - eighteen.getTime()) <= 2 * DAY, 'the approved renewal extends the same row to 18 months');
equal(premiumRows[0].application_id, renew.data.id, 'the row records the renewal application');
equal((await manager(`manage/users/${C}/grades/${premiumRows[0].id}`, 'DELETE')).status, 200, 'manager revokes the 프리미엄 row');
equal((await guest('users/' + C)).data.user.grade, 'normal', 'C drops to the grade held before 프리미엄 (일반)');

// A grade held permanently is not granted again, for 6 months or for good.
equal((await manager(`manage/users/${A}/grades`, 'POST', { grade: 'premium', plan: 'permanent' })).status, 201, 'manager grants A 프리미엄 영구');
let refused = await manager(`manage/users/${A}/grades`, 'POST', { grade: 'premium', plan: '6m' });
equal([refused.status, refused.data.error], [409, '이미 영구 등급입니다.'], 'a 6-month grant over a permanent one is 409');
refused = await manager(`manage/users/${A}/grades`, 'POST', { grade: 'premium', plan: 'permanent' });
equal(refused.status, 409, 'a second permanent grant of the same grade is 409');
const aPremium = (await manager('manage/users/' + A)).data.grants.find(g => g.grade === 'premium');
equal((await manager(`manage/users/${A}/grades/${aPremium.id}`, 'DELETE')).status, 200, "manager revokes A's 프리미엄");

// The manager gets 200/201 on the same calls.
{
    const ok = (r, status, name) => equal(r.status, status, 'manager: ' + name);
    ok(await manager('manage'), 200, 'GET manage');
    ok(await manager('manage/users'), 200, 'GET manage/users');
    ok(await manager('manage/users/' + C), 200, 'GET manage/users/:C');
    ok(await manager(`manage/users/${C}/grades`, 'POST', { grade: 'plus', plan: 'permanent' }), 201, 'POST grades');
    ok(await manager(`manage/users/${C}/badges`, 'POST', { badge: 'credit', active: true }), 200, 'POST badges');
    const plusRow = (await manager('manage/users/' + C)).data.grants.find(g => g.grade === 'plus');
    ok(await manager(`manage/users/${C}/grades/${plusRow.id}`, 'DELETE'), 200, 'DELETE grades/:gid');
    ok(await manager('manage/applications'), 200, 'GET manage/applications');
    ok(await manager(`applications/${appC.data.id}`, 'PATCH', { action: 'approve' }), 200, 'PATCH approve');
    const proxyApp = await c('applications', 'POST', { kind: 'badge', target: 'proxy' });
    equal(proxyApp.status, 201, 'C applies for 대리 인증');
    ok(await manager(`applications/${proxyApp.data.id}`, 'PATCH', { action: 'reject', note: '자료 부족' }), 200, 'PATCH reject');
    const cNow = (await guest('users/' + C)).data.user;
    equal([cNow.grade, cNow.badges], ['normal', ['identity', 'credit']], 'C now holds 본인 인증 and 신용인');
    ok(await manager('manage/settings', 'PUT', {}), 200, 'PUT manage/settings');
    ok(await manager('manage/notice', 'POST', notice), 200, 'POST manage/notice');
    const posted = (await guest('notices')).data.notices.find(n => n.title === notice.title);
    check(posted, 'the notice is posted');
    equal((await manager('manage/notice/' + posted.id, 'DELETE')).status, 200, 'the test notice is removed');
    ok(await manager('manage/visibility', 'POST', { postId: post.data.id, hidden: true, reason: '허위 매물' }), 200, 'POST manage/visibility');
    equal((await manager('manage/visibility', 'POST', { postId: post.data.id, hidden: false })).status, 200, 'the post is shown again');
    ok(await manager('manage/report', 'POST', { id: report.id, status: 'resolved' }), 200, 'POST manage/report');
    const temp = await manager(`manage/users/${C}/password`, 'POST', {});
    ok(temp, 200, 'POST manage/users/:C/password');
    equal((await c('auth/me')).data.user, null, "the temporary password ends C's sessions");
    c = client();
    equal((await c('auth/login', 'POST', { username: username('c'), password: temp.data.password })).status, 200, 'C signs in with the temporary password');
}

// The manager takes back B's 관리자 grade.
const adminRow = (await manager('manage/users/' + B)).data.grants.find(g => g.grade === 'admin');
equal((await manager(`manage/users/${B}/grades/${adminRow.id}`, 'DELETE')).status, 200, "manager revokes B's 관리자 grade");
equal((await b('auth/me')).data.user.grade, 'normal', 'B is 일반 again');

// DB triggers (migration 0009): grants whose granted_by is not 'manager' are refused.
if (sql("SELECT name FROM sqlite_master WHERE type='trigger' AND name='user_grades_manager_only'").length) {
    check(sqlFails("INSERT INTO user_grades(user_id,grade,rank,granted_by,granted_at) VALUES('x','plus',1,'someone',1)").includes('manager only'), 'trigger: a member-attributed grade insert aborts');
    check(sqlFails(`INSERT INTO user_grades(user_id,grade,rank,granted_at) VALUES('${B}','plus',1,1)`).includes('manager only'), 'trigger: a grade insert without granted_by aborts');
    check(sqlFails(`INSERT OR IGNORE INTO user_badges(user_id,badge,granted_by,granted_at) VALUES('${B}','proxy','${B}',1)`).includes('manager only'), 'trigger: INSERT OR IGNORE into user_badges aborts');
    equal((await manager(`manage/users/${A}/grades`, 'POST', { grade: 'plus', plan: 'permanent' })).status, 201, 'the manager still grants through the API');
    check(sqlFails(`UPDATE user_grades SET granted_by='${B}' WHERE user_id='${A}'`).includes('manager only'), 'trigger: re-attributing a grant aborts');
    check(sqlFails(`UPDATE user_grades SET expires_at=1,granted_by=NULL WHERE user_id='${A}'`).includes('manager only'), 'trigger: changing the expiry without the manager aborts');
    sql(`UPDATE user_grades SET granted_at=granted_at+1 WHERE user_id='${A}'`);
    check(sql(`SELECT granted_by FROM user_grades WHERE user_id='${A}'`).every(r => r.granted_by === 'manager'), 'trigger: other columns still update');
    equal((await guest('users/' + A)).data.user.grade, 'plus', 'the manager grant is intact');
} else console.log('SKIP triggers are not installed');

console.log(`\n${checks} role checks passed`);
