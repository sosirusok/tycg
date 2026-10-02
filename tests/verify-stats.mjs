import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// WP63 on the strict 8791 server (real post rules, TEST_HOOKS=on, READ_BUDGET=on, cron events): 판매 통계
// (GET me/stats for 프리미엄 and up, post_views only for 'trend' authors, 끌올 효과, the 엘리트 시세 from confirmed
// trades), 대표 글 (PUT posts/:id/pin, pinned first on the profile, a downgrade hides and deletes nothing),
// 인기순, the 엘리트 주간 요약 in tick B, the cleanup's 14 days, and no profile banner route.
// Part of TEST_SUITES=stats.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR, KST = 9 * HOUR;
const TICK_B = '5-59/10 * * * *';
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }
function refused(r, status, text, name) {
    assert.equal(r.status, status, `${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    assert.ok(String(r.data.error || '').includes(text), `${name}: ${r.data.error}`);
    checks++;
    console.log(`PASS ${name} (${r.data.error})`);
}

// wrangler d1 execute takes about 1.7 s a call; a SQLITE_BUSY statement never ran, so it is tried again.
function sql(command) {
    for (let attempt = 1; ; attempt++) {
        try {
            const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
                '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
            const all = JSON.parse(out.slice(out.indexOf('[')));
            return all[all.length - 1].results;
        } catch (error) {
            if (attempt >= 4 || !String(error.stderr || error.message).includes('SQLITE_BUSY')) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
        }
    }
}
async function send(url, init) {
    try { return await fetch(url, init()); }
    catch (error) {
        if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
        return fetch(url, init());
    }
}
function client(ip) {
    let cookie = '';
    return async (path, method = 'GET', data) => {
        const response = await send(base + '/api/' + path, () => ({
            method, redirect: 'error', signal: AbortSignal.timeout(20000),
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
}
let regs = 0;
async function register(name) {
    const c = client(`10.63.${Math.floor(regs / 200)}.${1 + (regs++ % 200)}`);
    const r = await c('auth/register', 'POST', { username: `st_${run}_${name}`.slice(0, 24), password, nickname: `통계${name}${run}`.slice(0, 16) });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%' OR key LIKE 'post:%'");
const manager = client('10.63.250.1');
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const grant = async (c, grade, plan = 'permanent') => equal((await manager(`manage/users/${c.user.id}/grades`, 'POST', { grade, plan })).status, 201, `manager grants ${grade}`);
let n = 0;
async function post(c, extra = {}) {
    const r = await c('posts', 'POST', { kind: 'sell', category: 'other', title: `[QA] 통계 ${run} ${++n}`, body: '판매 통계 검증', price: 100000, tags: [], images: [], details: {}, ...extra });
    assert.equal(r.status, 201, `post: ${JSON.stringify(r.data)}`);
    return r.data.id;
}
const hourOf = t => Math.floor(t / HOUR);

const normal = await register('n'), plus = await register('p'), premium = await register('pr'), elite = await register('e'), admin = await register('a'), viewer = await register('v');
await grant(plus, 'plus');
await grant(premium, 'premium');
await grant(elite, 'elite');
await grant(admin, 'admin');

// ---- 1. No profile banner (dropped) ----
equal((await premium('me/banner', 'PUT', { uploadId: 'x' })).status, 404, 'PUT /api/me/banner → 404');

// ---- 2. Counted views by the hour, only for 'trend' authors ----
const P = await post(premium), N = await post(normal), L = await post(plus);
for (const id of [P, N, L]) equal((await viewer(`posts/${id}?view=1`)).status, 200, `the viewer opens post ${id}`);
const viewRows = id => sql(`SELECT hour,n FROM post_views WHERE post_id=${id} ORDER BY hour`);
// The views of a post, over the hours (a run may cross an hour between two views).
const viewSum = id => viewRows(id).reduce((sum, r) => sum + r.n, 0);
const pRows = viewRows(P);
equal([pRows.length, pRows[0]?.n], [1, 1], 'a counted view of a 프리미엄 post writes a post_views row');
check(Math.abs(pRows[0].hour - hourOf(Date.now())) <= 1, 'for the current hour');
equal(viewRows(N), [], 'a view of a 일반 post writes none');
equal(viewRows(L), [], 'a view of a 플러스 post writes none');
await viewer(`posts/${P}?view=1`);
equal(viewSum(P), 1, 'a second view within 6 hours does not count again');
const guest = client('10.63.251.9');
await guest(`posts/${P}?view=1`);
equal(viewSum(P), 2, 'a guest view counts once per day');

// ---- 3. GET me/stats ----
refused(await plus(`me/stats?post=${L}`), 403, '판매 통계는 프리미엄부터 가능합니다.', '플러스 → 403');
refused(await normal(`me/stats?post=${N}`), 403, '판매 통계는 프리미엄부터 가능합니다.', '일반 → 403');
equal((await premium(`me/stats?post=${N}`)).status, 404, "another member's post → 404");
equal((await premium('me/stats?post=abc')).status, 404, 'a bad id → 404');
equal((await viewer(`posts/${P}/favorite`, 'POST', { active: true })).status, 200, 'the viewer saves the post (찜)');
const chat = (await viewer('chats', 'POST', { postId: P })).data.id;
equal((await viewer(`chats/${chat}/messages`, 'POST', { body: '아직 판매중인가요?', postId: P })).status, 201, 'the viewer asks about it (채팅)');
// 끌올 효과: a manual 끌올 10 hours ago and an auto one 4 hours ago, with views around them.
const now = Date.now(), t0 = now - 10 * HOUR, t1 = now - 4 * HOUR, h0 = hourOf(t0), h1 = hourOf(t1);
sql(`INSERT INTO post_events(user_id,post_id,kind,created_at,auto) VALUES('${premium.user.id}',${P},'bump',${t0},0),('${premium.user.id}',${P},'bump',${t1},1),('${premium.user.id}',${P},'bump',${now - 30 * MIN},0);
    INSERT OR REPLACE INTO post_views(post_id,hour,n) VALUES(${P},${h0 - 2},1),(${P},${h0 - 1},1),(${P},${h0},3),(${P},${h0 + 1},3),(${P},${h1 - 2},2),(${P},${h1 - 1},0),(${P},${h1},5),(${P},${h1 + 1},4)`);
const st = await premium(`me/stats?post=${P}`);
equal(st.status, 200, '프리미엄 GET me/stats?post → 200');
equal([st.data.level, st.data.days.length, 'hours' in st.data, 'market' in st.data], ['trend', 7, false, false], "7 day buckets, level 'trend', no 엘리트 parts");
const week = key => st.data.days.reduce((sum, d) => sum + d[key], 0);
equal([st.data.days[6].views >= 1, week('views') >= 2, week('favorites'), week('chats')], [true, true, 1, 1], 'the buckets hold the views (today), the 찜 and the chat');
check(st.data.days.every((d, i) => i === 0 || d.day - st.data.days[i - 1].day === DAY), 'the buckets are consecutive KST days');
equal(st.data.effect, [{ type: 'manual', count: 1, before: 2, after: 6 }, { type: 'auto', count: 1, before: 2, after: 9 }],
    "끌올 효과 splits manual and auto (views 2 hours before against 2 hours after); a 끌올 30 minutes ago is not over yet");
equal(st.data.promoViews, 0, '광고 유입 is there');

// ---- 4. 엘리트 시세 from confirmed trades (≥ 3 sellers) ----
// The fixture: 판매 trades of the account category with the season tag 챌린저 7; earlier runs' fixture rows are voided.
// trades.post_id is unique and never empty, so the fixture uses negative ids no post has.
const tag = [{ tier: 'challenger', season: 7 }];
const E = await post(elite, { category: 'account', price: 250000, tags: tag, details: { ownerCount: '1' } });
sql(`UPDATE trades SET removed_at=${now} WHERE title LIKE '[QA] 시세 %' AND removed_at IS NULL`);
const trade = (id, seller, price, extra = {}) => {
    const t = { kind: 'sell', category: 'account', tags: JSON.stringify(tag), confirmed: now - DAY, author: seller, removed: null, ...extra };
    return `('${run}-${id}',${-(Number.parseInt(run, 16) * 10 + id)},'${seller}','buyer-${run}',${price},${now - DAY},'${t.author}',${t.confirmed === null ? 'NULL' : t.confirmed},${t.removed === null ? 'NULL' : t.removed},'${t.kind}','${t.category}','[QA] 시세 ${run}','${t.tags}')`;
};
const insertTrades = rows => sql(`INSERT INTO trades(id,post_id,seller_id,buyer_id,price,created_at,author_id,confirmed_at,removed_at,kind,category,title,tags) VALUES ${rows.join(',')}`);
insertTrades([trade(1, `sa-${run}`, 100000), trade(2, `sa-${run}`, 200000), trade(3, `sb-${run}`, 300000),
    // Never counted: unconfirmed, removed, older than 90 days, a 구매 trade, another category, no shared tag.
    trade(4, `sd-${run}`, 900000, { confirmed: null }), trade(5, `se-${run}`, 900000, { removed: now }), trade(6, `sf-${run}`, 900000, { confirmed: now - 91 * DAY }),
    trade(7, `sg-${run}`, 900000, { kind: 'buy' }), trade(8, `sh-${run}`, 900000, { category: 'clan' }), trade(9, `si-${run}`, 900000, { tags: '[{"tier":"master","season":17}]' })]);
const es = await elite(`me/stats?post=${E}`);
equal([es.status, es.data.level, es.data.hours?.length], [200, 'full', 24], "엘리트: level 'full' with 24 hours of the day");
equal(es.data.market, null, '3 trades from 2 sellers → no 시세 card (unconfirmed, removed, old, 구매, other category and other tags ignored)');
sql(`UPDATE trades SET seller_id='sc-${run}' WHERE id='${run}-2'`);
const es2 = await elite(`me/stats?post=${E}`);
equal(es2.data.market, { n: 3, median: 200000 }, 'from 3 sellers → their median (the unconfirmed 90만원 trade is ignored)');
const as = await admin(`me/stats?post=${await post(admin, { category: 'account', tags: tag, details: { ownerCount: '1' } })}`);
equal([as.status, as.data.level, as.data.market], [200, 'full', { n: 3, median: 200000 }], '관리자 gets the 엘리트 stats (rank >= 3)');
// 판매 글 전체 (엘리트): the 최저가 starts at 90% of the 시세 rounded down to 만원 where there is one.
const plain = await post(elite, { price: 300000 });
const allOn = await elite('me/automation/drop-all', 'POST', {});
equal(allOn.status, 200, '엘리트 turns on 판매 글 전체');
equal(sql(`SELECT post_id,drop_floor FROM post_auto WHERE post_id IN (${E},${plain}) ORDER BY post_id`).map(r => [r.post_id, r.drop_floor]), [[E, 180000], [plain, 240000]],
    '최저가: 90% of the 시세 (중간값 20만원 → 18만원) where there is one, else 80% of the 즉거가');
sql(`UPDATE trades SET removed_at=${now} WHERE title='[QA] 시세 ${run}'`);

// ---- 5. 대표 글 ----
const L2 = await post(plus);
refused(await normal(`posts/${N}/pin`, 'PUT', { active: true }), 403, '대표 글은 플러스부터 가능합니다.', '일반 cannot pin');
equal((await plus(`posts/${L}/pin`, 'PUT', { active: true })).status, 200, '플러스 pins its first post');
refused(await plus(`posts/${L2}/pin`, 'PUT', { active: true }), 403, '대표 글은 1개까지입니다.', '플러스 pins a 2nd post → 403 1개까지');
equal((await premium(`posts/${L}/pin`, 'PUT', { active: false })).status, 403, "another member's post → 403");
const profile = (await guest(`posts?author=${plus.user.id}&active=1&size=10`)).data.posts;
equal([profile[0]?.id, profile[0]?.pinned, profile.find(p => p.id === L2)?.pinned, 'profile_pin_at' in profile[0]], [L, true, false, false],
    'the profile list returns the pinned post first (L2 is newer), with pinned and without the pin time');
equal((await plus(`posts?author=${plus.user.id}&counts=1&size=10`)).data.posts.map(p => p.id).slice(0, 2), [L2, L], '내 글 keeps 끌올 order');
equal((await plus(`posts/${L}/pin`, 'PUT', { active: false })).status, 200, '대표 글 해제');
equal((await plus(`posts/${L2}/pin`, 'PUT', { active: true })).status, 200, 'then the other post can be pinned');
// A downgrade hides the older pins and deletes nothing.
const e2 = await register('e2');
await grant(e2, 'elite', '6m');
const pins = [];
for (let i = 0; i < 3; i++) { pins.push(await post(e2)); equal((await e2(`posts/${pins[i]}/pin`, 'PUT', { active: true })).status, 200, `엘리트 pins post ${i + 1}`); }
const shown = async () => (await guest(`posts?author=${e2.user.id}&active=1&size=10`)).data.posts.filter(p => p.pinned).map(p => p.id);
equal(await shown(), [pins[2], pins[1], pins[0]], 'three pins show, the newest pin first');
sql(`UPDATE user_grades SET expires_at=${Date.now() - 1000} WHERE user_id='${e2.user.id}'`);
equal(await shown(), [], 'the 6-month 엘리트 ended (일반): no pin shows');
equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE author_id='${e2.user.id}' AND profile_pin_at IS NOT NULL`)[0].n, 3, 'and every pin is kept');
await grant(e2, 'plus');
equal(await shown(), [pins[2]], '플러스 again: only the newest pin shows');

// ---- 6. 인기순 ----
const pop = [await post(normal, { title: `[QA] 인기 ${run} 찜` }), await post(normal, { title: `[QA] 인기 ${run} 조회` }), await post(normal, { title: `[QA] 인기 ${run} 오래됨` })];
for (const c of [viewer, plus, premium]) equal((await c(`posts/${pop[0]}/favorite`, 'POST', { active: true })).status, 200, 'a member saves the first post');
sql(`UPDATE posts SET view_count=500 WHERE id=${pop[1]}; UPDATE posts SET bumped_at=${now - 8 * DAY} WHERE id=${pop[2]}`);
const popular = (await guest(`posts?kind=sell&q=${encodeURIComponent(`[QA] 인기 ${run}`)}&sort=popular`)).data;
equal(popular.posts.map(p => p.id), [pop[0], pop[1]], 'sort=popular: 3 찜 before 0 찜 and 500 views; a post bumped 8 days ago is out');
equal(popular.total, 2, 'its total counts the candidates');
equal((await guest(`posts?kind=sell&q=${encodeURIComponent(`[QA] 인기 ${run}`)}&sort=popular&page=6`)).data.posts, [], 'pages 1-5 only');

// ---- 7. 엘리트 주간 요약 (tick B) ----
// Next week's Monday 10:05 KST: its 'last week' holds now.
const weekStart = t => { const day = Math.floor((t + KST) / DAY), monday = day - (day + 3) % 7, start = monday * DAY - KST + 10 * HOUR; return start > t ? start - 7 * DAY : start; };
const ws = weekStart(Date.now()) + 7 * DAY, at = ws + 5 * MIN;
const eliteChat = (await viewer('chats', 'POST', { postId: E })).data.id;
equal((await viewer(`chats/${eliteChat}/messages`, 'POST', { body: '계정 문의', postId: E })).status, 201, 'the viewer asks about the 엘리트 post');
equal((await viewer(`posts/${E}?view=1`)).status, 200, 'and opens it (a counted view)');
// Every other member due (엘리트 and up from earlier suites and runs, and the manager) already has that week's
// summary, read, so the slice has this suite's 엘리트 and 관리자 to write.
sql(`INSERT INTO post_events(user_id,post_id,kind,created_at,auto) VALUES('${elite.user.id}',${E},'bump',${Date.now() - 1000},1);
    INSERT INTO notifications(user_id,type,ref,text,created_at,read_at) SELECT m.id,'weekly','${ws}','',${at},${at} FROM (SELECT DISTINCT user_id AS id FROM user_grades WHERE rank>=3 UNION SELECT 'manager') m
        WHERE m.id NOT IN ('${elite.user.id}','${admin.user.id}') AND EXISTS(SELECT 1 FROM users u WHERE u.id=m.id)
        AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.user_id=m.id AND n.type='weekly' AND n.ref='${ws}');
    INSERT INTO settings(key,value,updated_at) VALUES('sys:weekly_last','0',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
const cursor = sql("SELECT value FROM settings WHERE key='sys:alert_cursor'")[0]?.value;
async function tick() {
    const res = await send(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(TICK_B)}&time=${at}`, () => ({ signal: AbortSignal.timeout(60000) }));
    await res.arrayBuffer();
    assert.equal(res.status, 200, `tick B answered ${res.status}`);
    return JSON.parse(sql("SELECT value FROM settings WHERE key='sys:last_cron_meter'")[0]?.value || '{}');
}
const weeklyOf = c => sql(`SELECT ref,text FROM notifications WHERE user_id='${c.user.id}' AND type='weekly'`);
let ticks = 0, meter;
do { meter = await tick(); ticks++; check(meter.d1Calls <= 8 && meter.d1Statements <= 45, `tick B ${ticks} stays in the budget (${meter.d1Calls} calls, ${meter.d1Statements} statements)`); }
while (Number(sql("SELECT value FROM settings WHERE key='sys:weekly_last'")[0].value) < ws && ticks < 20);
equal(Number(sql("SELECT value FROM settings WHERE key='sys:weekly_last'")[0].value), ws, `sys:weekly_last moves to the week start once every member is done (${ticks} ticks)`);
equal(weeklyOf(elite), [{ ref: String(ws), text: '지난주 조회 1 · 채팅 1 · 끌올 1' }], "the 엘리트 has one 'weekly' 알림: 지난주 조회 1 · 채팅 1 · 끌올 1");
equal(weeklyOf(admin).length, 1, '관리자 gets one too');
equal([weeklyOf(premium).length, weeklyOf(plus).length, weeklyOf(normal).length], [0, 0, 0], '프리미엄, 플러스 and 일반 get none');
const all = sql(`SELECT COUNT(*) AS n FROM notifications WHERE type='weekly' AND ref='${ws}'`)[0].n;
await tick();
equal([weeklyOf(elite).length, sql(`SELECT COUNT(*) AS n FROM notifications WHERE type='weekly' AND ref='${ws}'`)[0].n], [1, all], 'a second tick adds none');
if (cursor) sql(`UPDATE settings SET value='${cursor}' WHERE key='sys:alert_cursor'`);
sql(`INSERT INTO settings(key,value,updated_at) VALUES('sys:weekly_last','${Date.now()}',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

// ---- 8. The daily cleanup keeps 14 days ----
const old = Date.now();
sql(`INSERT OR REPLACE INTO post_views(post_id,hour,n) VALUES(${P},${hourOf(old - 15 * DAY)},1),(${P},${hourOf(old - 13 * DAY)},1);
    INSERT INTO post_events(user_id,post_id,kind,created_at,auto) VALUES('${premium.user.id}',${P},'bump',${old - 10 * DAY},0),('${premium.user.id}',${P},'fresh',${old - 10 * DAY},0),
        ('${premium.user.id}',${P},'post',${old - 10 * DAY},0),('${premium.user.id}',${P},'bump',${old - 15 * DAY},0)`);
const daily = await send(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('17 18 * * *')}`, () => ({ signal: AbortSignal.timeout(60000) }));
await daily.arrayBuffer();
equal(daily.status, 200, 'the daily cleanup runs');
equal(sql(`SELECT hour FROM post_views WHERE post_id=${P} AND hour<${hourOf(old - 12 * DAY)} ORDER BY hour`).map(r => r.hour), [hourOf(old - 13 * DAY)], 'post_views older than 14 days are deleted');
equal(sql(`SELECT kind,created_at FROM post_events WHERE post_id=${P} AND created_at<${old - 9 * DAY} ORDER BY kind,created_at`).map(r => [r.kind, r.created_at]),
    [['bump', old - 10 * DAY], ['fresh', old - 10 * DAY]], "'bump' and 'fresh' rows stay 14 days; other kinds 2 days");

console.log(`verify-stats: ${checks} checks passed`);
