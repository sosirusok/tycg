import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 알림함 (WP50) on the 8791 server (READ_BUDGET=on, test cron events): 찜 가격 내림 (one unread row per
// post until it is read), 판매완료 to the members who saved the post (none across a block), the header
// count in chats/unread, 모두 읽음, 신청 결과, 숨김, the 6-month grade-end reminder, the 플러스 무료 체험
// reminders (no manager chat), the daily age limits and the 100-a-day cap with its read cost.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const HOUR = 3600000, DAY = 86400000;
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
async function send(url, init) {
    try { return await fetch(url, init()); }
    catch (error) {
        if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
        return fetch(url, init());
    }
}
// Each client has its own address, so the trial's per-address cap never meets another suite's sign-ups.
function client(ip = `10.${100 + Math.floor(Math.random() * 90)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`) {
    let cookie = '';
    return async (path, method = 'GET', data) => {
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
        return { status: response.status, data: result, rows: Number(response.headers.get('x-rows-read')) };
    };
}
async function register(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `al_${run}_${name}`.slice(0, 24), password, nickname: `알림${name}${run}`.slice(0, 16) });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}
async function fireCron() {
    const r = await send(base + '/cdn-cgi/handler/scheduled?cron=17+18+*+*+*', () => ({ signal: AbortSignal.timeout(60000) }));
    await r.arrayBuffer();
    return r.status;
}
const rowsOf = (c, type) => sql(`SELECT id,type,ref,post_id,actor_id,text,read_at FROM notifications WHERE user_id='${c.user.id}'${type ? ` AND type='${type}'` : ''} ORDER BY id`);
const unreadOf = (c, type) => rowsOf(c, type).filter(r => r.read_at === null);
let n = 0;
async function sellPost(c, price) {
    const r = await c('posts', 'POST', { kind: 'sell', category: 'other', title: `[QA] 알림 ${run} ${++n}`, body: '자동 검증', price, tags: [], images: [], details: {} });
    assert.equal(r.status, 201, `post: ${JSON.stringify(r.data)}`);
    return { id: r.data.id, title: `[QA] 알림 ${run} ${n}` };
}

// Earlier suites on this database used up the sign-in limits (per IP and per user).
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%'");
const manager = client('10.251.0.1');
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const A = await register('a'), B = await register('b'), C = await register('c');

// ---- 1. 찜 가격 내림: one unread row per post until it is read ----
const P = await sellPost(A, 400000);
equal((await B(`posts/${P.id}/favorite`, 'POST', { active: true })).status, 200, 'B saves A\'s sale at 400,000');
equal((await C(`posts/${P.id}/favorite`, 'POST', { active: true })).status, 200, 'C saves it too');
equal((await C('blocks', 'POST', { userId: A.user.id, active: true })).status, 200, 'C blocks A');
equal((await A(`posts/${P.id}/price`, 'PATCH', { price: 350000 })).status, 200, 'A lowers the price to 350,000');
let rows = unreadOf(B, 'fav_price');
equal(rows.length, 1, 'B has one unread fav_price row');
check(rows[0].text.includes('가격 내림') && rows[0].text.includes(P.title) && rows[0].text.includes('35만원'), `its text: ${rows[0].text}`);
equal([rows[0].ref, rows[0].post_id, rows[0].actor_id], [String(P.id), P.id, A.user.id], 'ref and post are the post, the actor is A');
equal(rowsOf(C).length, 0, 'C, who blocked A, gets nothing');
equal((await A(`posts/${P.id}/price`, 'PATCH', { price: 330000 })).status, 200, 'A lowers it to 330,000 before B reads');
equal(unreadOf(B, 'fav_price').length, 1, 'still one unread row');
check(unreadOf(B, 'fav_price')[0].text.includes('33만원'), 'the unread row now shows the latest price');
equal((await A(`posts/${P.id}/price`, 'PATCH', { price: 340000 })).status, 200, 'A raises it to 340,000');
equal(rowsOf(B, 'fav_price').length, 1, 'a raise writes nothing');
const list = await B('notifications');
equal(list.status, 200, 'B reads the 알림함');
const first = list.data.alerts.find(a => a.type === 'fav_price');
check(first && !first.read && first.post?.id === P.id && first.post?.title === P.title, 'the list carries the row, unread, with the post title');
equal((await B('notifications/latest')).data.alert?.id, list.data.alerts[0].id, 'latest is the newest unread row');
equal((await A('notifications/read', 'POST', { id: first.id })).status, 200, 'A marking B\'s row answers ok');
equal(unreadOf(B, 'fav_price').length, 1, '…but only the owner can mark a row read');
equal((await B('notifications/read', 'POST', { id: first.id })).status, 200, 'B reads it');
equal(unreadOf(B, 'fav_price').length, 0, 'no unread fav_price row is left');
equal((await A(`posts/${P.id}/price`, 'PATCH', { price: 320000 })).status, 200, 'A lowers it again');
equal([rowsOf(B, 'fav_price').length, unreadOf(B, 'fav_price').length], [2, 1], 'a second row, unread');
// The editor's PUT lowers the price too.
const full = (await A(`posts/${P.id}`)).data.post;
equal((await B('notifications/read-all', 'POST', {})).status, 200, 'B reads every row');
const put = await A(`posts/${P.id}`, 'PUT', { kind: 'sell', category: 'other', title: P.title, body: full.body, price: 300000, tags: [], images: [], details: {} });
equal(put.status, 200, `A saves the post at 300,000 in the editor (${put.data.error || ''})`);
check(unreadOf(B, 'fav_price')[0]?.text.includes('30만원'), 'an edit that lowers the price writes a row');

// ---- 2. 완료 → '판매완료 · 제목' to the members who saved the post ----
equal((await B('notifications/read-all', 'POST', {})).status, 200, 'B reads every row');
equal((await A(`posts/${P.id}/status`, 'PATCH', { status: 'closed' })).status, 200, 'A completes the post');
rows = unreadOf(B, 'fav_closed');
equal(rows.map(r => r.text), [`판매완료 · ${P.title}`], 'B gets 판매완료 · 제목');
equal(rowsOf(C).length, 0, 'C (blocked A) still has nothing');
equal(rowsOf(A).length, 0, 'the author gets no row about their own post');
// The member named as the partner gets the trade request, not '판매완료' for their own trade.
const PQ = await sellPost(A, 200000);
equal((await B(`posts/${PQ.id}/favorite`, 'POST', { active: true })).status, 200, 'B saves Q');
const qChat = (await B('chats', 'POST', { postId: PQ.id })).data.id;
equal((await B(`chats/${qChat}/messages`, 'POST', { body: '아직 판매중인가요?', postId: PQ.id })).status, 201, 'B asks about Q');
equal((await A(`posts/${PQ.id}/status`, 'PATCH', { status: 'closed', partnerId: B.user.id })).status, 200, 'A completes Q with B as the partner');
equal(rowsOf(B, 'fav_closed').filter(r => r.ref === String(PQ.id)).length, 0, 'the partner gets no 판매완료 row');

// ---- 3. The header count ----
const unread = await B('chats/unread');
check(unread.status === 200 && unread.data.alerts >= 1 && typeof unread.data.unread === 'number', `chats/unread carries alerts (${unread.data.alerts})`);
check(unread.rows <= 120, `chats/unread reads ${unread.rows} rows`);
equal((await B('notifications/read-all', 'POST', {})).status, 200, '모두 읽음');
equal((await B('chats/unread')).data.alerts, 0, 'alerts 0 after read-all');
equal((await client()('notifications')).status, 401, 'a guest has no 알림함');

// ---- 4. 신청 결과 ----
const app = await B('applications', 'POST', { kind: 'grade', target: 'premium', plan: 'permanent' });
check([200, 201].includes(app.status), `B applies for 프리미엄 (${app.data.error || ''})`);
equal((await manager(`applications/${app.data.id}`, 'PATCH', { action: 'approve' })).status, 200, 'the manager approves');
rows = unreadOf(B, 'application');
equal(rows.length, 1, 'B has one application row');
check(rows[0].text.startsWith('신청 결과 · 프리미엄 등급 신청') && rows[0].text.endsWith('지급 완료'), `its text: ${rows[0].text}`);
const capp = await C('applications', 'POST', { kind: 'badge', target: 'identity' });
equal((await manager(`applications/${capp.data.id}`, 'PATCH', { action: 'reject', note: '확인 불가' })).status, 200, 'the manager rejects C');
check(unreadOf(C, 'application')[0]?.text.endsWith('반려'), 'C has a 반려 row');

// ---- 5. 숨김 ----
const Q = await sellPost(A, 50000);
equal((await manager('manage/visibility', 'POST', { postId: Q.id, hidden: true, reason: '허위 매물' })).status, 200, 'the manager hides A\'s post');
equal(unreadOf(A, 'hidden').map(r => r.text), [`‘${Q.title}’ 글이 숨김 처리되었습니다. 사유: 허위 매물`], 'A gets the 숨김 row with the reason');
const own = (await A('notifications')).data.alerts.find(a => a.type === 'hidden');
equal(own?.post?.id, Q.id, 'the author still sees the hidden post on the row');

// ---- 6. 6-month grade end (manager chat and 알림함) ----
const G = await register('g');
sql(`INSERT INTO user_grades(user_id,grade,rank,expires_at,granted_by,granted_at,source) VALUES('${G.user.id}','premium',2,${Date.now() + 3 * DAY},'manager',${Date.now() - DAY},'manager')`);
equal(await fireCron(), 200, 'the daily cron runs');
rows = unreadOf(G, 'grade_end');
equal(rows.length, 1, 'G has one grade_end row');
check(rows[0].text.startsWith('프리미엄 등급이') && rows[0].text.includes('끝납니다'), `its text: ${rows[0].text}`);
const gChat = (await G('chats')).data.chats.find(x => x.partner_id === 'manager');
check(gChat && gChat.last_message.includes('끝납니다'), 'and the manager chat message');

// ---- 7. 플러스 무료 체험: 24h reminder, end, nothing more, no manager chat ----
const opened = await manager('manage/trial', 'PUT', { end: Date.now() + DAY });
equal([opened.status, opened.data.open], [200, true], 'the manager opens the trial window');
const T = await register('t');
equal([T.user.grade, T.user.grade_trial], ['plus', true], 'T signs up into the trial');
equal((await manager('manage/trial', 'PUT', { close: true })).status, 200, 'the window closes again');
sql(`UPDATE user_grades SET expires_at=${Date.now() + 20 * HOUR} WHERE user_id='${T.user.id}' AND source='trial'`);
const managerChats = () => sql(`SELECT COUNT(*) AS n FROM conversations WHERE (user_a='manager' AND user_b='${T.user.id}') OR (user_b='manager' AND user_a='${T.user.id}')`)[0].n;
equal(await fireCron(), 200, 'the daily cron runs 20 hours before the end');
rows = rowsOf(T, 'grade_end');
equal(rows.length, 1, 'exactly one grade_end row');
check(rows[0].text.includes('플러스 무료 체험') && /\d+월 \d+일 \d\d:\d\d에 끝납니다/.test(rows[0].text), `its text: ${rows[0].text}`);
equal(rows[0].actor_id, null, 'no actor (not the manager)');
equal(await fireCron(), 200, 'the cron runs again before the end');
equal(rowsOf(T, 'grade_end').length, 1, 'still one row');
sql(`UPDATE user_grades SET expires_at=${Date.now() - 60000} WHERE user_id='${T.user.id}' AND source='trial'`);
equal((await T('auth/me')).data.trial?.ended, true, 'the end band is due before the cron');
equal(await fireCron(), 200, 'the cron runs after the end');
rows = rowsOf(T, 'grade_end');
equal(rows.map(r => r.text)[1], '플러스 무료 체험이 끝났습니다.', 'the second run adds the end row');
equal(sql(`SELECT reminded_at FROM user_grades WHERE user_id='${T.user.id}' AND source='trial'`)[0].reminded_at, -2, 'the trial is marked −2 (알림 sent)');
equal((await T('auth/me')).data.trial?.ended, true, 'the home end band is still due after the 알림');
equal(await fireCron(), 200, 'a third run');
equal(rowsOf(T, 'grade_end').length, 2, 'adds none');
equal((await T('me/trial-ended-seen', 'POST', {})).status, 200, 'T closes the end band');
equal(sql(`SELECT reminded_at FROM user_grades WHERE user_id='${T.user.id}' AND source='trial'`)[0].reminded_at, -1, 'closing marks it −1');
equal((await T('auth/me')).data.trial?.ended, false, 'which ends the home band');
equal(await fireCron(), 200, 'a fourth run');
equal(rowsOf(T, 'grade_end').length, 2, 'still adds none');
equal(managerChats(), 0, 'no manager conversation was created');
// A trial member who already holds a paid 플러스 gets no reminder, and the trial is still marked.
equal((await manager('manage/trial', 'PUT', { end: Date.now() + DAY })).data.open, true, 'the window opens again');
const U = await register('u');
equal((await manager('manage/trial', 'PUT', { close: true })).status, 200, 'and closes');
equal((await manager(`manage/users/${U.user.id}/grades`, 'POST', { grade: 'plus', plan: 'permanent' })).status, 201, 'U gets 플러스 영구 during the trial');
sql(`UPDATE user_grades SET expires_at=${Date.now() + 20 * HOUR} WHERE user_id='${U.user.id}' AND source='trial'`);
equal(await fireCron(), 200, 'the cron runs');
equal(rowsOf(U, 'grade_end').length, 0, 'a paid 플러스 gets no trial reminder');
check(sql(`SELECT reminded_at FROM user_grades WHERE user_id='${U.user.id}' AND source='trial'`)[0].reminded_at > 0, 'the trial is still marked');

// ---- 8. Daily age limits and the per-member 300 ----
const O = await register('o');
const now = Date.now();
sql(`INSERT INTO notifications(user_id,type,ref,text,created_at,read_at) VALUES('${O.user.id}','test','old1','오래된 알림',${now - 70 * DAY},NULL),('${O.user.id}','test','old2','읽은 알림',${now - 20 * DAY},${now - 19 * DAY}),('${O.user.id}','test','keep','안 읽은 알림',${now - 20 * DAY},NULL)`);
equal(await fireCron(), 200, 'the daily cron runs');
equal(rowsOf(O).map(r => r.ref), ['keep'], 'rows over 60 days and read rows over 14 days are removed; an unread 20-day row stays');
const many = Array.from({ length: 305 }, (_, i) => `('${O.user.id}','test','m${i}','알림 ${i}',${now - 2 * DAY + i * 1000},${now})`);
sql(`INSERT INTO notifications(user_id,type,ref,text,created_at,read_at) VALUES ${many.join(',')}`);
equal(await fireCron(), 200, 'the cron runs again');
const kept = rowsOf(O);
equal(kept.length, 300, 'the member keeps the newest 300');
check(!kept.some(r => ['keep', 'm0', 'm1', 'm2', 'm3', 'm4'].includes(r.ref)), 'the oldest rows went');

// ---- 9. 100 a day per member, and the read cost of that check ----
const D = await register('d'), E = await register('e');
const R1 = await sellPost(A, 100000), R2 = await sellPost(A, 100000);
equal((await D(`posts/${R1.id}/favorite`, 'POST', { active: true })).status, 200, 'D saves R1');
equal((await E(`posts/${R2.id}/favorite`, 'POST', { active: true })).status, 200, 'E saves R2');
const today = Array.from({ length: 100 }, (_, i) => `('${D.user.id}','test','d${i}','오늘 알림 ${i}',${Date.now() - 1000 + i},NULL)`);
sql(`INSERT INTO notifications(user_id,type,ref,text,created_at,read_at) VALUES ${today.join(',')}`);
const toE = await A(`posts/${R2.id}/price`, 'PATCH', { price: 90000 });
const toD = await A(`posts/${R1.id}/price`, 'PATCH', { price: 90000 });
equal([toE.status, toD.status], [200, 200], 'A lowers both prices');
equal(rowsOf(E, 'fav_price').length, 1, 'E (no 알림 today) gets the row');
equal(rowsOf(D, 'fav_price').length, 0, 'D, with 100 알림 today, gets no 101st');
check(toD.rows - toE.rows <= 120, `the capped insert reads ${toD.rows - toE.rows} more rows than an uncapped one (${toD.rows} vs ${toE.rows}; ≤ 120)`);

// ---- 10. Bad input ----
equal((await B('notifications?page=0')).status, 400, 'page 0 is refused');
equal((await B('notifications/read', 'POST', { id: 'x' })).status, 400, 'a bad id is refused');

console.log(`verify-alerts: ${checks} checks passed`);
