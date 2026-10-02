import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// 새 글 알림 (WP54) on the 8791 server (strict post rules, READ_BUDGET=on, TEST_HOOKS=on): 키워드 알림 and
// its parity with the board search, 게시판 새 글 알림, the 60-second lag, the limits, 판매자 구독 and '구독
// 허용', 조건 알림 and its parity with the board filters, 300 조건 알림 inside the tick budget, blocks and
// hidden posts, 가격 내림 for 프리미엄 only, and relists (WP44) that never send any 새 글 알림.
// Each step sets the cursor right before its posts and runs tick B 61 s ahead (the event's ?time= is the
// tick's now), so a window holds exactly the step's posts.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const HOUR = 3600000;
const TICK_B = '5-59/10 * * * *';
// Rows a tick B may read in the 300 조건 알림 step (about 3,300 measured; D1 Free: 5,000,000 rows a day).
const ROWS_PER_TICK = 6000;
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

// The local dev server may hold the SQLite file for a moment while it commits (SQLITE_BUSY): such a
// statement never ran, so it is tried again (3 more times, half a second apart and longer).
function sql(command) {
    for (let attempt = 1; ; attempt++) {
        try {
            const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
                '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
            return JSON.parse(out.slice(out.indexOf('[')))[0].results;
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
function client(ip = `10.${100 + Math.floor(Math.random() * 90)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`) {
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
let users = 0;
async function register(name, grade) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `np_${run}_${name}`.slice(0, 24), password, nickname: `새글${name}${run}`.slice(0, 16) });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    users++;
    if (grade) {
        const rank = { plus: 1, premium: 2, elite: 3 }[grade];
        sql(`INSERT INTO user_grades(user_id,grade,rank,expires_at,granted_by,granted_at,source) VALUES('${c.user.id}','${grade}',${rank},NULL,'manager',${Date.now()},'manager')`);
    }
    return c;
}
// The cursor right after every post so far, and tick B 61 s ahead (so the posts made since are inside).
function setCursor() {
    const id = sql('SELECT COALESCE(MAX(id),0) AS id FROM posts')[0].id;
    const t = Date.now();
    sql(`INSERT INTO settings(key,value,updated_at) VALUES('sys:alert_cursor','{"t":${t},"i":${id}}',${t}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);
    return { t, id };
}
const cursor = () => JSON.parse(sql("SELECT value FROM settings WHERE key='sys:alert_cursor'")[0]?.value || 'null');
let maxStatements = 0, maxCalls = 0;
async function tick(at = Date.now() + 61000) {
    const r = await send(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(TICK_B)}&time=${at}`, () => ({ signal: AbortSignal.timeout(60000) }));
    await r.arrayBuffer();
    assert.equal(r.status, 200, `tick B answered ${r.status}`);
    const meter = JSON.parse(sql("SELECT value FROM settings WHERE key='sys:last_cron_meter'")[0]?.value || '{}');
    maxStatements = Math.max(maxStatements, meter.d1Statements || 0);
    maxCalls = Math.max(maxCalls, meter.d1Calls || 0);
    assert.ok(meter.d1Statements <= 45 && meter.d1Calls <= 8, `tick B stays in the budget (${meter.d1Calls} calls, ${meter.d1Statements} statements)`);
    return meter;
}
const rowsOf = (c, type) => sql(`SELECT id,type,ref,post_id,actor_id,text,read_at FROM notifications WHERE user_id='${c.user.id}'${type ? ` AND type='${type}'` : ''} ORDER BY id`);
let n = 0;
async function post(c, kind, category, title, extra = {}) {
    const r = await c('posts', 'POST', { kind, category, title, body: extra.body || '자동 검증', price: extra.price === undefined ? 10000 : extra.price, tags: extra.tags || [], images: [], details: extra.details || {} });
    assert.equal(r.status, 201, `post '${title}': ${JSON.stringify(r.data)}`);
    n++;
    return { id: r.data.id, title, relist: r.data.relist, placed: r.data.placed };
}
async function save(c, name, query, alert = true) { return c('searches', 'POST', { name, query, alert }); }

// Earlier runs' 알림 would only add rows to read; this run's own searches are the only ones on, and no
// earlier member's 자동 매칭 (WP58) runs in these ticks.
sql('UPDATE saved_searches SET alert=0 WHERE alert=1; UPDATE automation SET match_on=0 WHERE match_on=1');
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%'");
const manager = client('10.251.0.2');
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const A = await register('a'), A2 = await register('a2'), A3 = await register('a3');
const B = await register('b');

// ---- 1. 키워드 알림: one unread row, the count on open ----
let r = await save(B, '유루미', 'kind=sell&q=유루미');
equal([r.status, r.data.alert, r.data.keyword], [200, true, true], 'B saves the keyword 유루미 on 판매 with the 알림 on');
equal((await B('searches')).data.searches.find(s => s.id === r.data.id)?.alert, true, 'GET searches shows the 알림');
const kwId = r.data.id;
setCursor();
const k1 = await post(A, 'sell', 'account', `[QA] 유루미 계정 ${run}`, { price: 300000 });
await tick();
let rows = rowsOf(B, 'keyword');
equal(rows.map(x => [x.ref, x.post_id, x.text, x.read_at]), [[kwId, k1.id, '‘유루미’ 새 글', null]], 'B has one keyword row for the first match');
setCursor();
const k2 = await post(A, 'sell', 'other', `[QA] 유루미 기타 ${run}`, { price: 20000 });
await tick();
equal(rowsOf(B, 'keyword').length, 1, 'a second match keeps one unread row');
let list = (await B('notifications')).data.alerts.find(a => a.type === 'keyword');
equal([list?.text, list?.count, new URLSearchParams(list?.query || '').get('q')], ['‘유루미’ 새 글', 2, '유루미'], 'GET notifications shows ‘유루미’ 새 글 with count 2 and the board query');
check(k2.id > k1.id, 'both matches counted');

// ---- 2. Lag: a post 30 s old is not in the window; the next tick after back-dating sends it ----
equal((await B('notifications/read-all', 'POST', {})).status, 200, 'B reads every row');
setCursor();
const lagPost = await post(A, 'sell', 'clan', `[QA] 유루미 클랜 ${run}`, { price: 50000 });
const created = sql(`SELECT created_at FROM posts WHERE id=${lagPost.id}`)[0].created_at;
await tick(created + 30000);
equal(rowsOf(B, 'keyword').filter(x => x.read_at === null).length, 0, 'a post created 30 s before the tick is not in its window');
check(cursor().t < created, `the cursor stays before the post (${cursor().t} < ${created})`);
await tick(created + 61000);
equal(rowsOf(B, 'keyword').filter(x => x.read_at === null).map(x => x.post_id), [lagPost.id], 'the next tick (60 s later) sends it');

// ---- 3. An empty window writes nothing ----
const before = sql("SELECT value,updated_at FROM settings WHERE key='sys:alert_cursor'")[0];
const emptyMeter = await tick(Date.now() + 61000);
equal(sql("SELECT value,updated_at FROM settings WHERE key='sys:alert_cursor'")[0], before, 'an empty window leaves the cursor as it is');
check(emptyMeter.d1Statements <= 5, `and runs only its reads (${emptyMeter.d1Statements} statements)`);

// ---- 4. 게시판 새 글 알림 ----
const G = await register('g');
r = await save(G, '판매 · 계정', 'category=account&kind=sell');
equal([r.status, r.data.keyword], [200, true], 'G turns on the board 알림 for 판매 · 계정');
setCursor();
const b1 = await post(A2, 'sell', 'account', `[QA] 보드 계정 ${run}`, { price: 70000 });
await tick();
equal(rowsOf(G, 'board').map(x => [x.post_id, x.text]), [[b1.id, '판매 · 계정 새 글']], 'one board row: 판매 · 계정 새 글');
equal((await G('notifications/read-all', 'POST', {})).status, 200, 'G reads it');
setCursor();
await post(A2, 'sell', 'clan', `[QA] 보드 클랜 ${run}`, { price: 70000 });
await tick();
equal(rowsOf(G, 'board').length, 1, 'a 판매 · 클랜 post sends nothing');
equal((await save(G, '판매', 'kind=sell&q=', true)).status, 200, 'a tab without a category is a board 알림 too');
equal((await save(G, '전체', 'q=', true)).status, 400, 'a board 알림 needs a tab');

// ---- 5. Limits ----
for (let i = 2; i <= 10; i++) equal((await save(B, `w${i}`, `kind=sell&q=${run}w${i}`)).status, 200, `B's keyword 알림 ${i}`);
r = await save(B, 'w11', `kind=sell&q=${run}w11`);
equal([r.status, r.data.error], [403, '키워드 알림은 10개까지입니다.'], 'the 11th keyword 알림 is refused');
const w2 = (await B('searches')).data.searches.find(s => s.name === 'w2');
equal((await B(`searches/${w2.id}`, 'PATCH', { alert: false })).status, 200, 'one is turned off');
equal((await save(B, 'w11', `kind=sell&q=${run}w11`)).status, 200, 'and the 11th fits');
equal((await B(`searches/${w2.id}`, 'PATCH', { alert: true })).data.error, '키워드 알림은 10개까지입니다.', 'turning it on again is refused');
r = await save(B, '조건', 'kind=sell&category=account&maxOwners=2');
equal([r.status, r.data.error], [403, '조건 알림은 플러스부터 가능합니다.'], 'a normal member has no 조건 알림');
equal((await save(B, '조건', 'kind=sell&category=account&maxOwners=2', false)).status, 200, 'the same search saves without the 알림');
const L = await register('l', 'plus');
for (let i = 1; i <= 3; i++) equal((await save(L, `c${i}`, `kind=sell&category=account&min=${i * 1000}`)).data.keyword, false, `plus 조건 알림 ${i}`);
r = await save(L, 'c4', 'kind=sell&category=account&min=4000');
equal([r.status, r.data.error], [403, '조건 알림은 3개까지입니다.'], 'the plus member\'s 4th is refused');
equal((await save(L, 'bad', 'kind=sell&category=account&level=abc')).status, 400, 'a bad filter is the board\'s 400');

// ---- 6. 판매자 구독 ----
const F = await register('f'), A5 = await register('a5');
r = await F(`users/${A5.user.id}/follow`, 'POST', { active: true });
equal([r.status, r.data.followed], [200, true], 'F follows A5');
equal((await F(`users/${A5.user.id}`)).data.user.followed, true, 'the profile shows 구독 중');
equal((await A5(`users/${A5.user.id}`)).data.user.follower_count, 1, 'A5 sees 1 follower');
equal((await F(`users/${A5.user.id}`)).data.user.follower_count, undefined, 'others do not');
equal((await F('me/follows')).data.follows.map(x => x.target_id), [A5.user.id], '구독 관리 lists A5');
setCursor();
const f1 = await post(A5, 'sell', 'other', `[QA] 구독 글 ${run}`, { price: 30000 });
await tick();
equal(rowsOf(F, 'follow').map(x => [x.ref, x.post_id, x.actor_id, x.text]), [[A5.user.id, f1.id, A5.user.id, `${A5.user.nickname} 새 글`]], 'F has a follow row');
equal((await F('notifications/read-all', 'POST', {})).status, 200, 'F reads it');
equal((await A5('users/me', 'PATCH', { follow_allowed: false })).status, 200, 'A5 turns 구독 허용 off');
equal((await A5(`users/${A5.user.id}`)).data.user.follow_allowed, false, 'the profile says so');
setCursor();
await post(A5, 'sell', 'other', `[QA] 구독 끔 ${run}`, { price: 30000 });
await tick();
equal(rowsOf(F, 'follow').length, 1, 'no new follow row while 구독 허용 is off');
const F2 = await register('f2');
r = await F2(`users/${A5.user.id}/follow`, 'POST', { active: true });
equal([r.status, r.data.error], [403, '구독을 받지 않는 회원입니다.'], 'a new follow is refused');
equal((await F2(`users/${F2.user.id}/follow`, 'POST', { active: true })).status, 400, 'nobody follows themselves');
// A fresh database may hold fewer than 100 other members: fill up with placeholder members first.
sql(`INSERT INTO users(id,username,nickname,password_hash,salt,created_at) WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<100) SELECT 'fx-${run}-'||i,'fx_${run}_'||i,'구독${run}'||i,'','',${Date.now()} FROM k`);
sql(`INSERT INTO follows(user_id,target_id,created_at) SELECT '${F2.user.id}',id,${Date.now()} FROM users WHERE id NOT IN ('${F2.user.id}','${A.user.id}') AND deleted_at IS NULL LIMIT 100`);
r = await F2(`users/${A.user.id}/follow`, 'POST', { active: true });
equal([r.status, r.data.error], [409, '구독은 100명까지입니다.'], 'the 101st follow is refused');
equal((await F(`users/${A5.user.id}/follow`, 'POST', { active: false })).data.followed, false, 'F unfollows (구독 해제)');

// ---- 7. Blocks and hidden posts ----
const K = await register('k'), K2 = await register('k2');
const word = `블록${run}`;
equal((await save(K, word, `kind=sell&q=${word}`)).status, 200, 'K saves a keyword');
equal((await K(`users/${A3.user.id}/follow`, 'POST', { active: true })).status, 200, 'K follows A3');
equal((await save(K2, word, `kind=sell&q=${word}`)).status, 200, 'K2 saves the same keyword');
equal((await K('blocks', 'POST', { userId: A3.user.id, active: true })).status, 200, 'K blocks A3');
setCursor();
const kb = await post(A3, 'sell', 'other', `[QA] ${word} 차단 글`, { price: 40000 });
await tick();
equal([rowsOf(K, 'keyword').length, rowsOf(K, 'follow').length], [0, 0], 'K (blocked A3) gets no keyword or follow row');
equal(rowsOf(K2, 'keyword').map(x => x.post_id), [kb.id], 'K2 gets the keyword row');
equal((await K2('notifications/read-all', 'POST', {})).status, 200, 'K2 reads it');
equal((await K('blocks', 'POST', { userId: A3.user.id, active: false })).status, 200, 'K unblocks A3');
equal((await A3('blocks', 'POST', { userId: K.user.id, active: true })).status, 200, 'A3 blocks K instead');
setCursor();
const hid = await post(A3, 'sell', 'other', `[QA] ${word} 숨김 글`, { price: 40000 });
equal((await manager('manage/visibility', 'POST', { postId: hid.id, hidden: true, reason: '허위 매물' })).status, 200, 'the manager hides the next match');
await tick();
equal([rowsOf(K, 'keyword').length, rowsOf(K2, 'keyword').filter(x => x.read_at === null).length], [0, 0], 'a hidden post sends nothing');
setCursor();
await post(A3, 'sell', 'other', `[QA] ${word} 차단 반대`, { price: 40000 });
await tick();
equal([rowsOf(K, 'keyword').length, rowsOf(K, 'follow').length, rowsOf(K2, 'keyword').filter(x => x.read_at === null).length], [0, 0, 1], 'a block by the author also stops K\'s rows; K2 gets one');

// ---- 8. Parity: keyword 알림 vs the board search, 조건 알림 vs the board filters ----
const S1 = await register('s1'), S2 = await register('s2');
const E1 = await register('e1', 'elite'), E2 = await register('e2', 'elite');
const words = ['유루미', '유루미 계정', '악주', '악몽', 'abc', 'hello world', A.user.nickname, '28챌', '챌린저', '클랜', '띄어쓰기', '유루미계정', 'qaclan', '레벨', '고렙', '제시', run, '없는단어' + run, '150', 'mixed'];
const kwIds = [];
for (const [i, w] of words.entries()) {
    const c = i < 10 ? S1 : S2;
    r = await save(c, w, 'kind=sell&q=' + encodeURIComponent(w));
    equal([r.status, r.data.keyword], [200, true], `keyword 알림 '${w}'`);
    kwIds.push({ c, id: r.data.id, w });
}
const queries = [
    'kind=sell&category=account&min=100000', 'kind=sell&category=account&max=400000', 'kind=sell&category=account&level=100', 'kind=sell&category=account&skins=100',
    'kind=sell&category=account&phantom=260', 'kind=sell&category=account&skinTags=' + encodeURIComponent('["유루미"]'), 'kind=sell&category=account&skinTags=' + encodeURIComponent('["악몽주인"]'),
    'kind=sell&category=account&tags=' + encodeURIComponent('[{"tier":"challenger","season":28}]'), 'kind=sell&category=account&q=' + encodeURIComponent('유루미') + '&min=1000',
    'kind=sell&category=account&maxOwners=2', 'kind=sell&category=account&nicknameChars=3', 'kind=sell&category=clan&min=50000', 'kind=sell&category=other&max=16000',
    'kind=sell&category=other&mode=fixed', 'kind=sell&category=account&mode=offer', 'kind=buy&category=account&myPhantom=250', 'kind=buy&category=account&myPhantom=100',
    'kind=buy&category=account&ownerCountOfMine=2', 'kind=buy&category=other&max=60000', 'kind=sell&category=goods_coupon&min=1000',
    'kind=exchange&category=account&wantedCategory=clan&badge=identity', 'kind=sell&category=account&badge=identity', 'kind=sell&category=account&q=' + run + '&max=1000000',
    'kind=sell&category=account&gas=1', 'kind=sell&category=account&min=10000000', 'kind=sell&category=account&skinTags=' + encodeURIComponent('["유루미","악몽주인"]'),
    'kind=sell&category=account&sort=price-low&min=1000', 'kind=sell&category=account&closed=1&min=1000',
    'kind=exchange&category=account&wantedCategory=clan&tags=' + encodeURIComponent('[{"tier":"challenger","season":28}]'), 'kind=buy&category=account&skinTags=' + encodeURIComponent('["유루미"]'),
];
const bellIds = [];
for (const [i, q] of queries.entries()) {
    const c = i < 20 ? E1 : E2;
    r = await save(c, 'q' + i, q);
    equal([r.status, r.data.keyword], [200, false], `조건 알림 ${i}: ${decodeURIComponent(q)}`);
    bellIds.push({ c, id: r.data.id, q });
}
setCursor();
const fixture = [
    await post(A, 'sell', 'account', `[QA] 유루미 계정 판매 ${run}`, { price: 300000, details: { skinTags: '["유루미"]', level: '120' } }),
    await post(A, 'sell', 'account', `[QA] 악몽 ${run} 판매`, { price: 500000, details: { skinTags: '["악몽주인"]', phantom: '250' }, tags: [{ tier: 'challenger', season: 28 }] }),
    await post(A, 'sell', 'account', `[QA] 래더 ${run}`, { price: 250000, body: '28시즌 챌린저 계정, 레벨 높음', tags: [{ tier: 'challenger', season: 28 }] }),
    await post(A, 'sell', 'clan', `[QA] 클랜 ${run}`, { price: 100000, body: '유루미 클랜 팝니다', details: { clanName: 'QAclan' } }),
    await post(A, 'sell', 'other', `[QA] ABC Mixed ${run}`, { price: 20000, body: 'Hello World' }),
    await post(A, 'sell', 'other', `[QA] 기타 ${run}`, { price: 15000, body: '유루미계정 띄어쓰기 없음' }),
    await post(A2, 'sell', 'account', `[QA] 무난 ${run}`, { price: 90000, body: '평범한 계정', details: { level: '80', ownerCount: '2', nicknameChars: '3' } }),
    await post(A2, 'sell', 'account', `[QA] 고렙 ${run}`, { price: 1200000, details: { level: '200', humanSkins: '150', phantom: '300' } }),
    await post(A2, 'buy', 'account', `[QA] 유루미 삽니다 ${run}`, { price: 400000, details: { maxOwners: '3', phantomMin: '200', skinTags: '["유루미"]' } }),
    await post(A2, 'buy', 'other', `[QA] 구매 ${run}`, { price: 50000 }),
    await post(A3, 'sell', 'goods_coupon', `[QA] 쿠폰 ${run}`, { price: 5000 }),
    await post(A3, 'exchange', 'account', `[QA] 교환 ${run}`, { price: null, details: { wantedCategory: 'clan' } }),
    await post(A3, 'sell', 'account', `[QA] 제시 ${run} 유루미`, { price: null }),
];
const windowIds = new Set(fixture.map(p => p.id));
await tick();
const inWindow = list => list.map(p => p.id).filter(id => windowIds.has(id)).sort((a, b) => a - b);
// The board's answer for the window posts. Earlier runs leave thousands of matching posts on this
// server (placed above the window's by their 끌올 times), so the board is asked per fixture author
// (the author filter only narrows; these subscribers block no one), every page.
async function boardWindow(c, path) {
    const found = [];
    for (const author of [A, A2, A3].map(x => x.user.id)) {
        for (let page = 1; page <= 25; page++) {
            const d = (await c(`${path}&author=${author}&size=40&page=${page}`)).data;
            found.push(...d.posts);
            if (d.posts.length < 40) break;
        }
    }
    return inWindow(found);
}
const parityRows = sql(`SELECT type,ref,post_id,text FROM notifications WHERE user_id IN ('${S1.user.id}','${S2.user.id}','${E1.user.id}','${E2.user.id}') AND type IN ('keyword','condition')`);
for (const { c, id, w } of kwIds) {
    const board = await boardWindow(c, 'posts?kind=sell&q=' + encodeURIComponent(w));
    const got = parityRows.filter(x => x.type === 'keyword' && x.ref === id);
    equal(got.map(x => x.post_id), board.length ? [board[0]] : [], `keyword '${w}': a row exactly when the board finds a window post (${board.length})`);
    if (board.length) {
        const shown = (await c('notifications')).data.alerts.find(a => a.ref === id);
        equal(shown?.count, board.length, `keyword '${w}': the 알림 counts the board's ${board.length} posts`);
    }
}
for (const { c, id, q } of bellIds) {
    const board = await boardWindow(c, 'posts?' + q);
    const got = parityRows.filter(x => x.type === 'condition' && x.ref === id);
    equal(got.map(x => [x.post_id, x.text]), board.length ? [[board[0], `‘q${bellIds.findIndex(b => b.id === id)}’ 조건 새 글`]] : [], `조건 '${decodeURIComponent(q)}': a row exactly when the board finds a window post (${board.length})`);
}

// ---- 9a. CPU: one tick's 조건 알림 filters build well inside a Free cron run's 10 ms ----
// worker/alerts.ts bundled on the fly ('cloudflare:workers' stubbed; nothing here touches D1): the filter of
// each 알림 a tick may read (BELLS_PER_TICK), the parity queries above, warm best of 5 (wrangler dev cannot
// meter CPU). Measured about 1 ms warm and 6-7 ms on the very first run in Node.
{
    const bundle = await build({ configFile: false, logLevel: 'silent', root, resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./fixtures/cloudflare-workers.mjs', import.meta.url)) } },
        build: { lib: { entry: 'worker/alerts.ts', formats: ['es'], fileName: 'alerts' }, write: false, minify: false, rollupOptions: { external: ['node:async_hooks'] } } });
    const W = await import('data:text/javascript;base64,' + Buffer.from((Array.isArray(bundle) ? bundle[0] : bundle).output[0].code).toString('base64'));
    const bells = Array.from({ length: W.BELLS_PER_TICK }, (_, i) => ({ user_id: `cpu${i % 15}${run}`, role: 'member', query: queries[i % queries.length] }));
    const once = () => bells.map(b => W.bellFilter(b, true, 40, Date.now()));
    let t = performance.now();
    const built = once();
    const first = performance.now() - t;
    check(built.every(x => x && x.sql.includes('p.author_id!=')), `each of the ${W.BELLS_PER_TICK} filters a tick may build is SQL`);
    let best = Infinity;
    for (let i = 0; i < 5; i++) { t = performance.now(); once(); best = Math.min(best, performance.now() - t); }
    check(best < 4, `a tick's ${W.BELLS_PER_TICK} 조건 알림 filters build in ${best.toFixed(2)} ms warm (first run ${first.toFixed(2)} ms), inside the 10 ms of a Free cron run`);
}

// ---- 9. 300 조건 알림: every one gets its row, no tick over the budget ----
const elites = [];
for (let i = 0; i < 15; i++) elites.push(await register('m' + i));
const t0 = Date.now();
sql(`INSERT INTO user_grades(user_id,grade,rank,expires_at,granted_by,granted_at,source) VALUES ${elites.map(e => `('${e.user.id}','elite',3,NULL,'manager',${t0},'manager')`).join(',')}`);
const values = elites.flatMap((e, i) => Array.from({ length: 20 }, (_, j) => `('${run}-${String(i).padStart(2, '0')}-${String(j).padStart(2, '0')}','${e.user.id}','m${j}','kind=sell&category=account&min=${1000 + j}',${t0 + j},1,'sell','account',0)`));
sql(`INSERT INTO saved_searches(id,user_id,name,query,created_at,alert,alert_kind,alert_category,keyword) VALUES ${values.join(',')}`);
setCursor();
const big = await post(A3, 'sell', 'account', `[QA] 대량 ${run}`, { price: 5000000 });
let ticks = 0, done = 0, maxRead = 0;
while (ticks < 10) {
    const m = await tick();
    ticks++;
    maxRead = Math.max(maxRead, m.rowsRead || 0);
    done = sql(`SELECT COUNT(*) AS n FROM notifications WHERE type='condition' AND post_id=${big.id} AND user_id IN (${elites.map(e => `'${e.user.id}'`).join(',')})`)[0].n;
    console.log(`tick ${ticks}: ${done}/300 rows, ${m.d1Calls} calls, ${m.d1Statements} statements, ${m.rowsRead} rows read`);
    if (done === 300 && !cursor().et) break;
}
equal(done, 300, `all 300 조건 알림 got their row in ${ticks} ticks`);
check(!cursor().et, 'and the window is closed');
check(maxStatements <= 45 && maxCalls <= 8, `no tick exceeded 45 statements or 8 calls (max ${maxStatements}, ${maxCalls})`);
check(maxRead <= ROWS_PER_TICK, `no tick read more than ${ROWS_PER_TICK} rows (max ${maxRead})`);
sql(`UPDATE saved_searches SET alert=0 WHERE id LIKE '${run}-%'`);

// ---- 10. 가격 내림: 프리미엄 (새 글 · 가격 내림) yes, 플러스 (새 글) no ----
const P = await register('p', 'premium'), L2 = await register('l2', 'plus');
const drop = await post(A2, 'sell', 'other', `[QA] 가격 내림 ${run}`, { price: 500000 });
equal((await save(P, '기타 40만', 'kind=sell&category=other&max=400000')).status, 200, 'P (프리미엄) saves 판매 · 기타 up to 40만원');
equal((await save(L2, '기타 40만', 'kind=sell&category=other&max=400000')).status, 200, 'L2 (플러스) saves the same');
setCursor();
equal((await A2(`posts/${drop.id}/price`, 'PATCH', { price: 350000 })).status, 200, 'A2 lowers the post to 35만원');
await tick();
equal(rowsOf(P, 'condition').map(x => [x.post_id, x.text]), [[drop.id, '‘기타 40만’ 조건 가격 내림']], 'P gets 조건 가격 내림');
equal(rowsOf(L2, 'condition').length, 0, 'L2 gets nothing for a drop');

// ---- 11. Relists (WP44) never send 새 글 알림 ----
const A4 = await register('a4');
const R1 = await register('r1'), R2 = await register('r2'), R3 = await register('r3', 'premium');
const rw = `재등록${run}`;
equal((await save(R1, rw, `kind=sell&q=${rw}`)).status, 200, 'R1 saves a keyword');
equal((await R1(`users/${A4.user.id}/follow`, 'POST', { active: true })).status, 200, 'R1 follows A4');
equal((await save(R2, '판매 · 굿즈', 'category=goods_coupon&kind=sell')).status, 200, 'R2 turns on the 판매 · 굿즈 및 쿠폰 board');
equal((await save(R3, '쿠폰 조건', 'kind=sell&category=goods_coupon&min=1000')).data.keyword, false, 'R3 (프리미엄) saves a 조건 알림');
const subscribers = () => [rowsOf(R1, 'keyword').length, rowsOf(R1, 'follow').length, rowsOf(R2, 'board').length, rowsOf(R3, 'condition').length];
const original = await post(A4, 'sell', 'goods_coupon', `[QA] ${rw} 쿠폰 원본`, { price: 9000 });
equal((await A4(`posts/${original.id}`, 'DELETE')).status, 200, 'A4 deletes the post');
setCursor();
const relistOld = await post(A4, 'sell', 'goods_coupon', `[QA] ${rw} 쿠폰 원본`, { price: 9000 });
equal([relistOld.relist, relistOld.placed], [true, 'old'], 'posting it again inside the gap is a relist at the old place');
await tick();
equal(subscribers(), [0, 0, 0, 0], 'an \'old\' relist sends no keyword, follow, board or 조건 알림');
equal((await A4(`posts/${relistOld.id}`, 'DELETE')).status, 200, 'A4 deletes it again');
sql(`UPDATE post_prints SET anchor_at=anchor_at-${7 * HOUR} WHERE post_id IN (${original.id},${relistOld.id})`);
setCursor();
const relistBump = await post(A4, 'sell', 'goods_coupon', `[QA] ${rw} 쿠폰 원본`, { price: 9000 });
equal([relistBump.relist, relistBump.placed], [true, 'bump'], 'outside the gap the relist spends 1 끌올');
await tick();
equal(subscribers(), [0, 0, 0, 0], 'a \'bump\' relist sends nothing either');
setCursor();
equal((await A4(`posts/${relistBump.id}/price`, 'PATCH', { price: 8000 })).status, 200, 'A4 lowers the relist to 8,000원');
await tick();
equal(subscribers(), [0, 0, 0, 0], 'a price drop on a relist sends no 조건 알림 either');
setCursor();
const freshPost = await post(A4, 'sell', 'goods_coupon', `[QA] ${rw} 새 쿠폰 다른 글`, { price: 12000 });
equal(freshPost.relist, false, 'a different post is new');
await tick();
equal(subscribers(), [1, 1, 1, 1], 'a fresh new post sends all four');
equal(rowsOf(R3, 'condition')[0].post_id, freshPost.id, 'about the new post');

// ---- 12. A window whose runs keep failing (killed for CPU, a statement D1 refuses) never stops 새 글 알림:
// after 3 runs that did not finish it goes on without its 조건 알림, after 6 without any 알림 ----
const markTries = k => sql(`INSERT INTO settings(key,value,updated_at) SELECT 'sys:alert_try',json_object('c',value,'n',${k}),0 FROM settings WHERE key='sys:alert_cursor' ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
// One read: the four subscribers' unread rows (R1 keyword and 구독, R2 board, R3 조건), the cursor, the mark
// and the post's creation time.
const after12 = id => {
    const unread = (c, type) => `(SELECT COUNT(*) FROM notifications WHERE user_id='${c.user.id}' AND type='${type}' AND read_at IS NULL)`;
    const x = sql(`SELECT ${unread(R1, 'keyword')} AS k,${unread(R1, 'follow')} AS f,${unread(R2, 'board')} AS b,${unread(R3, 'condition')} AS c,
        (SELECT value FROM settings WHERE key='sys:alert_cursor') AS cur,(SELECT value FROM settings WHERE key='sys:alert_try') AS mark,(SELECT created_at FROM posts WHERE id=${id}) AS at`)[0];
    return { unread: [x.k, x.f, x.b, x.c], cursor: JSON.parse(x.cur), mark: JSON.parse(x.mark || 'null'), at: x.at };
};
const readAll = async () => { for (const c of [R1, R2, R3]) equal((await c('notifications/read-all', 'POST', {})).status, 200, 'a subscriber reads every row'); };
await readAll();
const liteFrom = setCursor();
const litePost = await post(A4, 'sell', 'goods_coupon', `[QA] ${rw} 쿠폰 세 번째 글`, { price: 13000 });
markTries(3);
await tick();
let st = after12(litePost.id);
equal(st.unread, [1, 1, 1, 0], 'after 3 unfinished runs the window goes on without its 조건 알림 (keyword, 구독 and board 알림 still go out)');
check(!st.cursor.et && st.cursor.t >= st.at, 'and the cursor moves past the window');
equal(st.mark, { c: JSON.stringify({ t: liteFrom.t, i: liteFrom.id }), n: 4 }, 'the run marked itself before its work (the 4th run from that cursor)');
await readAll();
setCursor();
const skipPost = await post(A4, 'sell', 'goods_coupon', `[QA] ${rw} 쿠폰 네 번째 글`, { price: 14000 });
markTries(6);
await tick();
st = after12(skipPost.id);
equal(st.unread, [0, 0, 0, 0], 'after 6 unfinished runs the window is skipped (no 알림 at all)');
check(!st.cursor.et && st.cursor.t >= st.at, 'and the cursor moves past it');
const nextFrom = setCursor();
const nextPost = await post(A4, 'sell', 'goods_coupon', `[QA] ${rw} 쿠폰 다섯 번째 글`, { price: 15000 });
await tick();
st = after12(nextPost.id);
equal(st.unread, [1, 1, 1, 1], 'the next window sends all four again');
equal(st.mark, { c: JSON.stringify({ t: nextFrom.t, i: nextFrom.id }), n: 1 }, 'a new cursor starts the count again (1 run, finished)');

console.log(`verify-alerts-posts: ${checks} checks passed (${users} members, ${n} posts, max ${maxStatements} statements a tick)`);
