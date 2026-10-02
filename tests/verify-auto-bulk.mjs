import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// WP58 on the strict 8791 server (real post rules and wallet, TEST_HOOKS=on, READ_BUDGET=on): 내 글 일괄 변경
// (POST posts/bulk: 끌올 oldest first while the wallet holds, 거래완료 that ends the 제시, other members' ids,
// the 30-post cap), '모두 끌올', 다시 올리기 (WP44 placement: the old place inside the gap, else 1 끌올),
// 자동 매칭 (tick B's 'match' 알림 for 프리미엄, the count on open and the list behind it, relists never
// match) and the 엘리트 '채팅 보내기' (20 a day). Part of TEST_SUITES=auto.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const MIN = 60000, HOUR = 60 * MIN;
const TICK_B = '5-59/10 * * * *';
const NO_TOKENS = '끌올이 없습니다.';
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }
function refused(r, status, text, name) {
    assert.equal(r.status, status, `${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    assert.ok(String(r.data.error || '').includes(text), `${name}: ${r.data.error}`);
    checks++;
    console.log(`PASS ${name} (${r.data.error})`);
}

// wrangler d1 execute takes about 1.7 s a call, so each step sets up its rows in one call. The local dev
// server may hold the SQLite file for a moment while it commits (SQLITE_BUSY): such a statement never
// ran, so it is tried again (3 more times, half a second apart and longer).
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
const members = [];
async function register(name) {
    const c = client(`10.58.${Math.floor(regs / 200)}.${1 + (regs++ % 200)}`);
    const r = await c('auth/register', 'POST', { username: `ab_${run}_${name}`.slice(0, 24), password, nickname: `일괄${name}${run}`.slice(0, 16) });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    members.push(c);
    return c;
}
let n = 0;
async function post(c, extra = {}) {
    const r = await c('posts', 'POST', { kind: 'sell', category: 'other', title: `[QA] 일괄 ${run} ${++n}`, body: '일괄 변경 검증', price: 10000, tags: [], images: [], details: {}, ...extra });
    assert.equal(r.status, 201, `post: ${JSON.stringify(r.data)}`);
    return r.data;
}
const ids = list => list.map(c => `'${c.user.id}'`).join(',');

sql(`DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%' OR key LIKE 'post:%' OR key LIKE 'matchchat:%';
    UPDATE automation SET match_on=0 WHERE match_on=1`);
const manager = client('10.58.250.1');
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const grant = async (c, grade) => equal((await manager(`manage/users/${c.user.id}/grades`, 'POST', { grade, plan: 'permanent' })).status, 201, `manager grants ${grade}`);

// ---- 1. 일괄 끌올: a 일반 member with 3 끌올 and 5 posts past their gap → 3 bumped, oldest first ----
const A = await register('a'), O = await register('o');
const aPosts = [];
for (let i = 0; i < 6; i++) aPosts.push((await post(A)).id);
const other = (await post(O)).id;
const t0 = Date.now();
// Posts 0-4 sit 7 hours back (past the 6-hour gap), 0 the oldest; post 5 is in its 새 글 우선 hour.
sql(aPosts.slice(0, 5).map((id, i) => `UPDATE posts SET created_at=${t0 - 7 * HOUR - (5 - i) * MIN},bumped_at=${t0 - 7 * HOUR - (5 - i) * MIN},bump_count=0 WHERE id=${id};`).join('')
    + `UPDATE posts SET created_at=${t0 - 7 * HOUR},bumped_at=${t0 + 30 * MIN},bump_count=0 WHERE id=${aPosts[5]};
    UPDATE users SET bump_tokens=3,bump_at=${t0} WHERE id='${A.user.id}';`);
let r = await A('posts/bulk', 'POST', { action: 'bump', ids: [...aPosts, other] });
equal(r.status, 200, 'POST posts/bulk bump answers 200');
equal(r.data.done, aPosts.slice(0, 3), '3 끌올: the 3 oldest posts are bumped');
const reasons = Object.fromEntries(r.data.skipped.map(s => [s.id, s.reason]));
check([aPosts[3], aPosts[4]].every(id => reasons[id]?.startsWith(NO_TOKENS)), `the other 2 are skipped with '${reasons[aPosts[3]]}'`);
check(reasons[aPosts[5]]?.startsWith('새 글 우선 중인 글은 ') && reasons[aPosts[5]].endsWith('부터 끌올할 수 있습니다.'), `a post in its 새 글 우선 hour is skipped with its reason (${reasons[aPosts[5]]})`);
equal(reasons[other], '권한이 없습니다.', "another member's id is skipped with '권한이 없습니다.'");
equal(r.data.bumpTokens, 0, 'the wallet is spent (3 → 0)');
let st = sql(`SELECT (SELECT COUNT(*) FROM post_events WHERE user_id='${A.user.id}' AND kind='bump' AND created_at>=${t0}) AS events,
    (SELECT COUNT(*) FROM posts WHERE id IN (${aPosts.slice(0, 3).join(',')}) AND bump_count=1 AND bumped_at>=${t0}) AS moved`)[0];
equal([st.events, st.moved], [3, 3], 'each bumped post has its 끌올 event and count');
refused(await A('posts/bulk', 'POST', { action: 'bump', ids: Array.from({ length: 31 }, (_, i) => i + 1) }), 400, '한 번에 30개까지 선택할 수 있습니다.', '31 ids → 400');
refused(await A('posts/bulk', 'POST', { action: 'move', ids: [aPosts[0]] }), 400, '일괄 변경을 확인해 주세요.', 'an unknown action → 400');

// '모두 끌올' (all: true): with the wallet empty the first reason is the wallet's; with 2 끌올 the 2 posts
// past their gap go (posts 3 and 4), and the bumped ones wait for their gap.
r = await A('posts/bulk', 'POST', { action: 'bump', all: true });
equal(r.data.done, [], "'모두 끌올' with no 끌올 bumps nothing");
check(r.data.skipped[0]?.reason.startsWith(NO_TOKENS), `and its first reason is the wallet (${r.data.skipped[0]?.reason})`);
sql(`UPDATE users SET bump_tokens=2,bump_at=${Date.now()} WHERE id='${A.user.id}'`);
r = await A('posts/bulk', 'POST', { action: 'bump', all: true });
equal(r.data.done, [aPosts[3], aPosts[4]], "'모두 끌올' bumps every post that can go until the wallet is empty (끌올 완료 · 2개)");
check(r.data.skipped.some(s => s.id === aPosts[0] && s.reason.startsWith('같은 글은 6시간마다 끌올할 수 있습니다.')), 'a post bumped a moment ago waits for its gap');
equal(r.data.bumpTokens, 0, 'and the wallet is empty again');

// ---- 2. 일괄 거래완료: 2 posts with pending 제시 → both closed, every 제시 ends with its line ----
const S = await register('s'), B1 = await register('b1'), B2 = await register('b2');
const s1 = (await post(S, { price: 300000, accepts_offers: true })).id, s2 = (await post(S, { price: 200000, accepts_offers: true })).id;
const o1 = await B1('offers', 'POST', { postId: s1, amount: 250000 }), o2 = await B2('offers', 'POST', { postId: s2, amount: 150000 });
equal([o1.status, o2.status], [201, 201], 'two members send a 제시');
const bOwn = (await post(B1)).id;
r = await S('posts/bulk', 'POST', { action: 'close', ids: [s1, s2, bOwn] });
equal([r.status, r.data.done], [200, [s1, s2]], 'bulk 거래완료 closes both posts');
equal(r.data.skipped, [{ id: bOwn, reason: '권한이 없습니다.' }], "another member's post is skipped with '권한이 없습니다.'");
for (const [buyer, id] of [[B1, s1], [B2, s2]]) {
    equal((await S('posts/' + id)).data.post.status, 'closed', `post ${id} is 거래완료`);
    const offer = (await buyer('offers')).data.offers.find(o => o.post_id === id);
    equal(offer?.status, 'cancelled', 'its pending 제시 ended');
    const lines = (await buyer(`chats/${offer.conversation_id}/messages`)).data.messages.filter(m => m.type === 'system').map(m => m.body);
    check(lines.includes('글이 완료되어 제시가 마감되었습니다.'), `the chat says '글이 완료되어 제시가 마감되었습니다.'`);
}
r = await S('posts/bulk', 'POST', { action: 'close', ids: [s1] });
equal([r.data.done, r.data.skipped], [[], [{ id: s1, reason: '이미 완료된 글입니다.' }]], 'a completed post is skipped (이미 완료된 글입니다.)');
const partners = (await S(`posts/${s1}/partners`)).data;
check(partners.canAsk !== false && !partners.trade, 'the trade can still be recorded within 7 days (no record yet, 거래 기록 요청 open)');
// 일괄 삭제: own posts go, another member's stays.
const d1 = (await post(S)).id, d2 = (await post(S)).id;
r = await S('posts/bulk', 'POST', { action: 'delete', ids: [d1, d2, bOwn] });
equal([r.data.done, r.data.skipped], [[d1, d2], [{ id: bOwn, reason: '권한이 없습니다.' }]], 'bulk 삭제 deletes own posts only');
equal((await S('posts/' + d1)).status, 404, 'the deleted post is gone');

// ---- 3. 다시 올리기 (WP44 placement): closed 1 hour ago inside the gap → the old place, no 끌올; closed 5
// hours ago past the gap → 1 끌올 ----
const R = await register('r');
const relisted = { kind: 'sell', category: 'account', title: `[QA] 다시 올리기 ${run}`, body: '같은 매물', price: 150000, tags: [], images: [], details: { ownerCount: '2', recordStatus: '무전적' } };
const r1 = await post(R, relisted);
equal((await R('posts/bulk', 'POST', { action: 'close', ids: [r1.id] })).data.done, [r1.id], 'the post is completed');
let at = Date.now();
sql(`UPDATE post_prints SET anchor_at=${at - 2 * HOUR},gone_at=${at - HOUR} WHERE post_id=${r1.id}; UPDATE posts SET closed_at=${at - HOUR} WHERE id=${r1.id};
    UPDATE users SET bump_tokens=3,bump_at=${at} WHERE id='${R.user.id}';`);
const again = await post(R, relisted);
equal([again.relist, again.placed, again.bumpTokens], [true, 'old', 3], "다시 올리기 1 hour after 완료: placed 'old', 끌올 unchanged (3)");
equal((await R('posts/bulk', 'POST', { action: 'close', ids: [again.id] })).data.done, [again.id], 'the relist is completed too');
at = Date.now();
sql(`UPDATE post_prints SET anchor_at=${at - 7 * HOUR},gone_at=${at - 5 * HOUR} WHERE post_id IN (${r1.id},${again.id}); UPDATE posts SET closed_at=${at - 5 * HOUR} WHERE id IN (${r1.id},${again.id});
    UPDATE users SET bump_tokens=3,bump_at=${at} WHERE id='${R.user.id}';`);
const third = await post(R, relisted);
equal([third.relist, third.placed, third.bumpTokens], [true, 'bump', 2], "다시 올리기 5 hours after 완료 (past the 6-hour gap): placed 'bump', 끌올 3 → 2");

// ---- 4. 자동 매칭 (round-3 WP34 T3-T4) ----
const P = await register('p'), E = await register('e'), N = await register('n'), B = await register('b'), Bx = await register('bx');
const account = { kind: 'sell', category: 'account', price: 300000, details: { ownerCount: '3', recordStatus: '무전적', phantom: '250' } };
const pSell = await post(P, { ...account, title: `[QA] 매칭 판매 ${run}` });
await post(N, { ...account, title: `[QA] 일반 판매 ${run}` });
const eSell = await post(E, { kind: 'sell', category: 'clan', title: `[QA] 엘리트 클랜 ${run}`, price: 50000 });
await grant(P, 'premium');
await grant(E, 'elite');
let auto = (await P('me/automation')).data.match;
equal([auto.on, auto.slots, auto.count], [true, 3, 1], "a 프리미엄 grant turns 자동 매칭 on (글 1/3)");
equal((await E('me/automation')).data.match.slots, null, '엘리트 matches every post');
refused(await N('me/automation', 'PUT', { matchOn: true }), 403, '자동 매칭은 프리미엄부터 가능합니다.', '일반 has no 자동 매칭');
// The cursor right after every post so far; tick B 61 s ahead takes the posts written since.
const setCursor = () => {
    const t = Date.now();
    sql(`INSERT INTO settings(key,value,updated_at) SELECT 'sys:alert_cursor',json_object('t',${t},'i',COALESCE(MAX(id),0)),${t} FROM posts WHERE 1 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
        DELETE FROM settings WHERE key='sys:alert_try';`);
};
async function tick() {
    const res = await send(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(TICK_B)}&time=${Date.now() + 61000}`, () => ({ signal: AbortSignal.timeout(60000) }));
    await res.arrayBuffer();
    assert.equal(res.status, 200, `tick B answered ${res.status}`);
}
setCursor();
const want = await post(B, { kind: 'buy', category: 'account', title: `[QA] 매칭 구매 ${run}`, price: 250000, details: { maxOwners: '5', recordPreference: '무전적', phantomMin: '200' } });
await post(Bx, { kind: 'buy', category: 'account', title: `[QA] 매칭 안 됨 ${run}`, price: 250000, details: { maxOwners: '2' } });
await tick();
const rows = sql(`SELECT n.user_id,n.type,n.ref,n.post_id,n.text,m.d1 FROM notifications n,(SELECT value AS d1 FROM settings WHERE key='sys:last_cron_meter') m
    WHERE n.type='match' AND n.user_id IN (${ids([P, N, E])})`);
const meter = JSON.parse(rows[0]?.d1 || sql("SELECT value FROM settings WHERE key='sys:last_cron_meter'")[0].value);
check(meter.d1Calls <= 8 && meter.d1Statements <= 45, `tick B stays in the budget (${meter.d1Calls} calls, ${meter.d1Statements} statements)`);
equal(rows.map(x => [x.user_id, x.ref, x.post_id, x.text]), [[P.user.id, String(pSell.id), want.id, `‘[QA] 매칭 판매 ${run}’ 글과 맞는 구매 글`]],
    "MAX 25만원 (≥ 80% of 30만원) and 5대주 이하 → one 'match' row for 프리미엄; 2대주 이하 none; the 일반 member's post none");
const shown = (await P('notifications')).data.alerts.find(a => a.type === 'match');
equal([shown?.text, shown?.count], [`‘[QA] 매칭 판매 ${run}’ 글과 맞는 구매 글`, 1], 'the 알림함 counts the match on open (‘…’ 글과 맞는 구매 글 1개)');
const list = (await P(`posts/${pSell.id}/matches?from=${want.id}`)).data;
equal([list.posts.map(p => p.id), list.own.kind, typeof list.own.query], [[want.id], 'sell', 'string'], 'the list behind it holds the matching 구매 글 only');
equal((await B(`posts/${pSell.id}/matches`)).status, 403, "another member's post has no match list");
// A relist of the same 구매 글 never matches.
equal((await P('notifications/read-all', 'POST', {})).status, 200, 'P reads the row');
equal((await B(`posts/${want.id}`, 'DELETE')).status, 200, 'B deletes the 구매 글');
setCursor();
const back = await post(B, { kind: 'buy', category: 'account', title: `[QA] 매칭 구매 ${run}`, price: 250000, details: { maxOwners: '5', recordPreference: '무전적', phantomMin: '200' } });
equal(back.relist, true, 'posting it again is a relist');
await tick();
equal(sql(`SELECT COUNT(*) AS n FROM notifications WHERE type='match' AND user_id='${P.user.id}'`)[0].n, 1, 'a relist sends no match 알림');
// 프리미엄 picks: the 3 most recently bumped posts until the first pick; a 4th pick is refused.
for (let i = 0; i < 3; i++) await post(P, { kind: 'buy', category: 'other', title: `[QA] 매칭 더 ${run} ${i}`, price: 20000 });
auto = (await P('me/automation')).data;
const four = auto.posts.filter(p => p.match !== undefined).sort((x, y) => y.bumped_at - x.bumped_at || y.id - x.id);
const sorted = list => [...list].sort((x, y) => x - y);
equal([four.length, auto.match.count, sorted(auto.posts.filter(p => p.match).map(p => p.id))], [4, 3, sorted(four.slice(0, 3).map(p => p.id))], 'with 4 posts the 3 most recently bumped are matched');
refused(await P(`posts/${four[3].id}/auto`, 'PUT', { match: true }), 409, '자동 매칭은 글 3개까지입니다.', 'a 4th pick is refused');
equal((await P(`posts/${four[0].id}/auto`, 'PUT', { match: false })).data.match, false, 'one post is switched off');
equal((await P(`posts/${four[3].id}/auto`, 'PUT', { match: true })).data.match, true, 'and the 4th goes on');
auto = (await P('me/automation')).data;
equal(sorted(auto.posts.filter(p => p.match).map(p => p.id)), sorted([four[1].id, four[2].id, four[3].id]), 'the picks hold (2 defaults kept, 1 swapped)');

// ---- 5. '채팅 보내기' (엘리트): the own post goes with a manual message, 20 a day ----
const chat = (await E('chats', 'POST', { userId: B.user.id })).data.id;
const sendMatch = () => E(`chats/${chat}/messages`, 'POST', { body: '구매 글 보고 연락드립니다.', postId: eSell.id, match: true });
r = await sendMatch();
equal(r.status, 201, "엘리트 sends '구매 글 보고 연락드립니다.' with the own post");
const first = (await B(`chats/${chat}/messages`)).data.messages;
equal(first.filter(m => m.type === 'listing').map(m => Number(m.reference_id)), [eSell.id], 'the own post card goes before the first message');
for (let i = 2; i <= 20; i++) assert.equal((await sendMatch()).status, 201, `match chat ${i}`);
refused(await sendMatch(), 429, '맞는 글 채팅은 하루 20번까지입니다.', 'the 21st match chat in a day → 429');
const pChat = (await P('chats', 'POST', { userId: B.user.id })).data.id;
refused(await P(`chats/${pChat}/messages`, 'POST', { body: '구매 글 보고 연락드립니다.', postId: pSell.id, match: true }), 403, '채팅 보내기는 엘리트부터 가능합니다.', '프리미엄 has no 채팅 보내기');

// ---- 6. [자동 끌올] in the 선택 bar: 엘리트 lists the chosen posts; below 엘리트 it is refused ----
r = await E('posts/bulk', 'POST', { action: 'auto', ids: [eSell.id], on: false });
equal(r.data.done, [eSell.id], '엘리트 takes a post out of 자동 끌올 in bulk');
equal((await E('me/automation')).data.posts.find(p => p.id === eSell.id)?.auto, false, 'the post is off the list');
refused(await P('posts/bulk', 'POST', { action: 'auto', ids: [pSell.id], on: true }), 403, '자동 끌올은 글 5개까지입니다.', '프리미엄 picks its 5 posts one by one');

sql(`UPDATE automation SET match_on=0 WHERE user_id IN (${ids(members)})`);
console.log(`\n${checks} bulk and match checks passed`);
