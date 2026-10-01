import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 플러스 7일 무료 체험 (WP41) on the 8791 server: the sign-up grant, the DB triggers, 회수, the per-address
// cap, the closed window, the deploy-gap catch-up, no manager chat (daily cron), the end band, the
// public view and the manager card. scripts/test-local.mjs closes the window after migrating; this
// suite opens it for itself and closes it again at the end.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const HOUR = 3600000, DAY = 86400000, WEEK = 7 * DAY;
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
// The statement must fail; returns the error text (stdout and stderr) to check the trigger's message.
function sqlError(command) {
    try { sql(command); }
    catch (e) { return String(e.stdout || '') + String(e.stderr || '') + String(e.message || ''); }
    assert.fail(`expected the statement to fail: ${command}`);
}

async function send(url, init) {
    try { return await fetch(url, init()); }
    catch (error) {
        if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
        return fetch(url, init());
    }
}

// Each client has its own address (cf-connecting-ip), so the sign-in limit per address and the trial
// cap per address only meet where a check wants them to.
function client(ip = `10.${1 + Math.floor(Math.random() * 90)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`) {
    let cookie = '';
    const c = async (path, method = 'GET', data) => {
        const response = await send(base + '/api/' + path, () => ({
            method, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { 'cf-connecting-ip': ip, ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: data === undefined ? undefined : JSON.stringify(data),
        }));
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); }
        catch { throw new Error(`${method} ${path}: expected JSON, received HTTP ${response.status}: ${text.slice(0, 300)}`); }
        return { status: response.status, data: result };
    };
    return c;
}

let seq = 0;
async function register(name, ip) {
    const c = client(ip);
    const r = await c('auth/register', 'POST', { username: `tr_${run}_${name}`.slice(0, 24), password, nickname: `체험${name}${run}`.slice(0, 16) });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    c.trial = r.data.trial;
    seq++;
    return c;
}
const me = async c => (await c('auth/me')).data;
const trialRows = id => sql(`SELECT id,expires_at,reminded_at,source FROM user_grades WHERE user_id='${id}' AND source='trial'`);

async function fireCron() {
    const r = await send(base + '/cdn-cgi/handler/scheduled?cron=17+18+*+*+*', () => ({ signal: AbortSignal.timeout(60000) }));
    await r.arrayBuffer();
    return r.status;
}

sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'trial-ip:%'");
const manager = client('10.250.0.1');
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');

// Open the window: it starts a minute ago (the start is not editable in the app), and the manager's
// card moves the end to tomorrow, which also clears the Worker's 60-second window cache.
const start = Date.now() - 60000;
sql(`INSERT INTO settings(key,value,updated_at) VALUES('sys:trial_start','${start}',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
const opened = await manager('manage/trial', 'PUT', { end: Date.now() + DAY });
equal([opened.status, opened.data.open], [200, true], 'the manager opens the window until tomorrow');
const config = await client()('config');
equal(config.data.trial?.open, true, 'GET config: trial.open while the window is open');
check(!JSON.stringify(config.data).includes('sys:'), "GET config never exposes 'sys:' settings");

// 1. Sign-up during the window.
const a = await register('a');
const aCreated = sql(`SELECT created_at,trial_at FROM users WHERE id='${a.user.id}'`)[0];
equal([a.user.grade, a.user.grade_trial], ['plus', true], 'a new sign-up is 플러스 with grade_trial');
equal(a.user.grade_expires_at, aCreated.created_at + WEEK, 'the trial ends exactly 7 days after sign-up');
check(aCreated.trial_at > 0, 'users.trial_at is stamped');
// WP40: the trial grant fills the 끌올 지갑 to the 플러스 cap.
equal(sql(`SELECT bump_tokens,bump_at FROM users WHERE id='${a.user.id}'`)[0], { bump_tokens: 4, bump_at: aCreated.trial_at }, 'the trial fills the wallet to 4 (플러스)');
equal([a.trial.popup, a.trial.endsAt, a.trial.ended, a.trial.capped], [true, aCreated.created_at + WEEK, false, false], 'the sign-up response asks for the popup');
equal((await me(a)).trial.popup, true, 'auth/me keeps asking until the popup is closed');
equal((await a('me/trial-popup', 'POST', {})).status, 200, 'POST me/trial-popup');
equal((await me(a)).trial.popup, false, 'the popup is done for this account');

// 2. Triggers.
const userSql = (id, created, extra = '') => `INSERT INTO users (id,username,nickname,nickname_key,password_hash,salt,role,bio,created_at${extra ? ',trial_at' : ''}) VALUES ('${id}','${id}','${id}','${id}','','','member','',${created}${extra ? ',' + extra : ''})`;
const old = `trold_${run}`, fresh = `trfresh_${run}`;
sql(userSql(old, start - 1000));
sql(userSql(fresh, Date.now()));
const trialInsert = (id, created, grade = 'plus', rank = 1) => `INSERT INTO user_grades(user_id,grade,rank,expires_at,granted_by,granted_at,source) VALUES('${id}','${grade}',${rank},${created}+${WEEK},'manager',${Date.now()},'trial')`;
check(sqlError(trialInsert(old, start - 1000)).includes('trial rule'), 'a trial for an account created before the window aborts with trial rule');
check(sqlError(trialInsert(a.user.id, aCreated.created_at)).includes('trial rule'), 'a second trial for the same member aborts');
const freshCreated = sql(`SELECT created_at FROM users WHERE id='${fresh}'`)[0].created_at;
check(sqlError(trialInsert(fresh, freshCreated, 'premium', 2)).includes('trial rule'), "grade 'premium' with source 'trial' aborts");
check(sqlError(`INSERT INTO user_grades(user_id,grade,rank,expires_at,granted_by,granted_at,source) VALUES('${fresh}','plus',1,${freshCreated + WEEK + 1},'manager',0,'trial')`).includes('trial rule'), 'a trial longer than 7 days aborts');
check(sqlError(`INSERT INTO user_grades(user_id,grade,rank,expires_at,granted_by,granted_at,source) VALUES('${fresh}','plus',1,${freshCreated + WEEK},'someone',0,'trial')`).includes('manager only'), 'the manager-only trigger still applies');
sql(trialInsert(fresh, freshCreated));
equal(trialRows(fresh).length, 1, 'a trial that follows every rule is accepted');
const b = await register('b');
const bRow = trialRows(b.user.id)[0];
check(sqlError(`UPDATE user_grades SET expires_at=expires_at+1 WHERE id=${bRow.id}`).includes('trial no extend'), 'extending a trial aborts');
check(sqlError(`UPDATE user_grades SET expires_at=NULL WHERE id=${bRow.id}`).includes('trial no extend'), 'making a trial permanent aborts');
check(sqlError(`UPDATE user_grades SET source='manager' WHERE id=${bRow.id}`).includes('source fixed'), 'changing the source aborts');
sql(`UPDATE user_grades SET expires_at=${Date.now()} WHERE id=${bRow.id}`);
check(trialRows(b.user.id)[0].expires_at <= Date.now(), 'shortening a trial is allowed');
equal((await me(b)).user.grade, 'normal', 'the shortened trial reads 일반');

// 3. 회수: the manager removes the trial; it never comes back.
const c = await register('c');
const grants = (await manager(`manage/users/${c.user.id}`)).data.grants;
const cGrant = grants.find(g => g.source === 'trial');
check(cGrant && cGrant.grade === 'plus', 'the member panel lists the trial row with its source');
equal((await manager(`manage/users/${c.user.id}/grades/${cGrant.id}`, 'DELETE')).status, 200, 'the manager takes the trial back (회수)');
const cAfter = await me(c);
equal([cAfter.user.grade, trialRows(c.user.id).length], ['normal', 0], 'auth/me after 회수: 일반 and no new trial row');

// 4. The per-address cap: 5 trials a day per address, the 6th sign-up still succeeds.
const capIp = `10.99.${Math.floor(Math.random() * 250)}.7`;
const capped = [];
for (let i = 0; i < 6; i++) capped.push(await register('cap' + i, capIp));
equal(capped.slice(0, 5).map(x => x.user.grade), ['plus', 'plus', 'plus', 'plus', 'plus'], 'the first 5 sign-ups from one address get the trial');
equal([capped[5].user.grade, capped[5].trial.capped], ['normal', true], 'the 6th is signed up as 일반 with trial.capped');
const sixth = await me(capped[5]);
equal([sixth.user.grade, sixth.trial.capped, trialRows(capped[5].user.id).length], ['normal', true, 0], 'the capped account gets no trial later (no catch-up)');

// 5. Window closed: a sign-up stays 일반.
const closed = await manager('manage/trial', 'PUT', { close: true });
equal([closed.status, closed.data.open], [200, false], 'the manager closes the window (지금 마감)');
equal((await client()('config')).data.trial?.open, false, 'GET config: trial.open is false');
const d = await register('d');
equal([d.user.grade, d.trial.popup], ['normal', false], 'a sign-up with the window closed is 일반');

// 6. Catch-up: a member created inside the window with no grade row and no trial_at (the previous
// Worker served the sign-up) gets exactly one trial on the next request.
equal((await manager('manage/trial', 'PUT', { end: Date.now() + DAY })).data.open, true, 'the window is open again');
const dMe = await me(d);
equal([dMe.user.grade, dMe.user.grade_trial, trialRows(d.user.id).length], ['plus', true, 1], 'auth/me creates exactly one trial row');
await me(d);
equal(trialRows(d.user.id).length, 1, 'a second call creates none');
equal(dMe.trial.popup, true, 'the caught-up member gets the popup too');

// 7. No manager chat: a trial ending within 20 hours gets no 7-day reminder from the daily cron.
const e = await register('e');
const managerChats = () => sql("SELECT COUNT(*) AS n FROM conversations WHERE user_a='manager' OR user_b='manager'")[0].n;
const before = managerChats();
sql(`UPDATE user_grades SET expires_at=${Date.now() + 20 * HOUR} WHERE user_id='${e.user.id}' AND source='trial'`);
equal(await fireCron(), 200, 'the daily cron runs');
equal((await e('chats')).data.chats?.length ?? 0, 0, 'the trial member has no conversation with the manager');
equal(managerChats(), before, "the manager's chat list count is unchanged");
equal(sql(`SELECT reminded_at FROM user_grades WHERE user_id='${e.user.id}' AND source='trial'`)[0].reminded_at, null, 'the trial row is not marked as reminded');

// 8. The end band: shown once after the trial ended, until closed.
sql(`UPDATE user_grades SET expires_at=${Date.now() - 1000} WHERE user_id='${e.user.id}' AND source='trial'`);
const ended = await me(e);
equal([ended.user.grade, ended.trial.ended], ['normal', true], 'auth/me after the end: 일반 and trial.ended');
equal((await e('me/trial-ended-seen', 'POST', {})).status, 200, 'POST me/trial-ended-seen');
equal((await me(e)).trial.ended, false, 'the end band is done');

// 9. Public view: the trial member's post lists them as 플러스 with grade_trial (the app hides the chip).
const sale = { kind: 'sell', category: 'other', title: `[QA] 체험 ${run}`, body: '자동 검증', price: 10000, status: 'open', tags: [], images: [], details: {} };
const posted = await a('posts', 'POST', sale);
equal(posted.status, 201, 'the trial member posts');
const listed = (await client()(`posts?author=${a.user.id}&size=10`)).data.posts.find(p => p.id === posted.data.id);
equal([listed?.author_grade, listed?.author_grade_trial], ['plus', true], "GET posts: author grade 'plus' and grade_trial true");
const profile = (await client()(`users/${a.user.id}`)).data.user;
equal([profile.grade, profile.grade_trial, profile.grade_expires_at], ['plus', true, null], 'the public profile carries grade_trial, not the end date');

// 10. The manager card.
equal((await a('manage/trial')).status, 403, 'GET manage/trial as a member is refused');
equal((await a('manage/trial', 'PUT', { close: true })).status, 403, 'PUT manage/trial as a member is refused');
const card = (await manager('manage/trial')).data;
check(card.granted >= 9 && card.active >= 1 && typeof card.applied === 'number' && card.start === start, 'the card shows the window and the counts');
equal((await manager('manage/trial', 'PUT', { end: Date.now() + 91 * DAY })).status, 400, 'an end more than 90 days ahead is refused');
const f = await register('f');
equal(f.user.grade, 'plus', 'another trial starts');
const endAll = await manager('manage/trial', 'PUT', { close: true, endRunning: true });
equal([endAll.status, endAll.data.open, endAll.data.active], [200, false, 0], '지금 마감 with endRunning closes the window and ends every trial');
equal(sql(`SELECT COUNT(*) AS n FROM user_grades WHERE source='trial' AND expires_at>${Date.now()}`)[0].n, 0, 'no trial row ends in the future');
equal((await me(f)).user.grade, 'normal', 'the member reads 일반');
const g = await register('g');
equal(g.user.grade, 'normal', 'sign-ups after 지금 마감 are 일반');

// The suites after this one expect the window closed.
sql("UPDATE settings SET value='-1' WHERE key='sys:trial_end'");
console.log(`\n${checks} trial checks passed (${seq} sign-ups).`);
