import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Two states and the two-sided trade record (WP43). Posts are 진행중 ('open') or 완료 ('closed'); 완료 is
// final (database triggers), 예약중 writes read as open, and a completed post is read-only. Completing
// with a partner writes a pending trade and a '거래 확인 요청' card; the partner answers '확인' (it counts)
// or '거래 아님' (deleted, logged). At most 3 requests per post within 7 days of 완료; a pending request
// expires after 7 days. Counting dedupes per counterpart and 30 days, leaves out 영구 정지 counterparts,
// and 거금 adds MIN(거래가, backing). Accepting a 제시 no longer touches the post.
// Runs only against a local Worker (see scripts/test-local.mjs, 8791: strict post limits).
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
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
function refused(r, status, text, name) {
    assert.equal(r.status, status, `${name}: status ${r.status} ${JSON.stringify(r.data)}`);
    assert.ok(String(r.data.error || '').includes(text), `${name}: ${r.data.error}`);
    checks++; console.log('PASS ' + name);
}

function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
// The error text of a statement the database refuses (a trigger's RAISE).
function sqlError(command) {
    try { sql(command); return ''; }
    catch (error) { return `${error.message}\n${error.stdout || ''}\n${error.stderr || ''}`; }
}

async function send(url, init) {
    try { return await fetch(url, init()); }
    catch (error) {
        if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
        return fetch(url, init());
    }
}

function client() {
    let cookie = '';
    return async (path, method = 'GET', data) => {
        const response = await send(base + '/api/' + path, () => ({
            method, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: data === undefined ? undefined : JSON.stringify(data),
        }));
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const raw = await response.text();
        let result;
        try { result = JSON.parse(raw); }
        catch { throw new Error(`${method} ${path}: expected JSON, received HTTP ${response.status}: ${raw.slice(0, 300)}`); }
        return { status: response.status, data: result };
    };
}

async function register(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `dl_${run}_${name}`.slice(0, 24), password, nickname: `거래${name}${run}` });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}

// The suites before this one use most of the sign-ins per 10 minutes from this address.
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%'");

const guest = client(), manager = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');

let n = 0;
const sale = (price = 300000, extra = {}) => ({ kind: 'sell', category: 'other', title: `[QA] 거래 ${run} ${++n}`, body: '자동 검증', price, accepts_offers: true, tags: [], images: [], details: {}, ...extra });
const wish = (price = 200000) => ({ kind: 'buy', category: 'other', title: `[QA] 구매 ${run} ${++n}`, body: '자동 검증', price, tags: [], images: [], details: {} });
async function created(c, body) {
    const r = await c('posts', 'POST', body);
    assert.equal(r.status, 201, `post created (${r.data.error || ''})`);
    return r.data.id;
}
// The buyer asks about the post from 채팅하기: the first message carries the post card (a partner).
async function asks(buyer, seller, postId) {
    const chat = (await buyer('chats', 'POST', { userId: seller.user.id, postId })).data.id;
    assert.equal((await buyer(`chats/${chat}/messages`, 'POST', { body: '구매 원합니다', postId })).status, 201);
    return chat;
}
const complete = (c, id, extra = {}) => c(`posts/${id}/status`, 'PATCH', { status: 'closed', ...extra });
const stats = async c => { const u = (await guest('users/' + c.user.id)).data.user; return { trades: u.tradeCount, deal: u.dealSum, good: u.goodCount }; };
const status = id => sql(`SELECT status FROM posts WHERE id=${id}`)[0].status;
const tradeRow = id => sql(`SELECT id,author_id,price,backing,backing_offer,kind,title,confirmed_at,created_at FROM trades WHERE post_id=${id}`)[0];

// --- 1. Two states ---
const s = await register('s'), b = await register('b');
{
    const P = await created(s, sale());
    sql(`UPDATE posts SET status='reserved' WHERE id=${P}`);
    equal(status(P), 'open', 'an SQL write of reserved reads open (trigger)');
    equal((await guest('posts/' + P)).data.post.status, 'open', 'the API reads it open');
    equal((await s(`posts/${P}/status`, 'PATCH', { status: 'reserved' })).status, 200, 'PATCH reserved on an open post is a no-op');
    const done = await complete(s, P);
    equal([done.status, 'trade' in done.data], [200, false], 'the author completes P without a partner');
    const row = sql(`SELECT status,closed_at,featured_at FROM posts WHERE id=${P}`)[0];
    check(row.status === 'closed' && row.closed_at > Date.now() - 60000 && row.featured_at === null, 'P is closed with closed_at stamped');
    check(sqlError(`UPDATE posts SET status='open' WHERE id=${P}`).includes('closed is final'), 'an SQL reopen of a closed post is refused: closed is final');
    check(sqlError(`UPDATE posts SET status='reserved' WHERE id=${P}`).includes('closed is final'), 'an SQL 예약중 on a closed post is refused too');
    equal(status(P), 'closed', 'P is still closed');
    refused(await s(`posts/${P}/status`, 'PATCH', { status: 'open' }), 409, '완료된 글은 되돌릴 수 없습니다.', 'PATCH open on a closed post');
    refused(await s(`posts/${P}/status`, 'PATCH', { status: 'reserved' }), 409, '되돌릴 수 없습니다', 'PATCH reserved on a closed post');
    refused(await complete(s, P), 409, '이미 완료된 글입니다.', 'completing twice');
    refused(await s(`posts/${P}`, 'PUT', sale()), 409, '완료된 글은 수정할 수 없습니다.', 'PUT on a closed post');
    refused(await s(`posts/${P}/price`, 'PATCH', { price: 200000 }), 409, '완료된 글은 수정할 수 없습니다.', 'price change on a closed post');
    equal((await s(`posts/${P}/bump`, 'POST')).status, 409, 'no 끌올 on a closed post');
    const sneaky = await created(s, sale(300000, { status: 'closed' }));
    equal(status(sneaky), 'open', 'POST with status closed creates an open post');
    sql(`UPDATE posts SET status='closed' WHERE id=${sneaky}`);
    check(sql(`SELECT closed_at FROM posts WHERE id=${sneaky}`)[0].closed_at > 0, 'any writer that closes a post gets closed_at from the trigger');
    equal((await guest(`posts?author=${s.user.id}&status=reserved`)).data.posts.map(p => p.id), [], 'a legacy status=reserved list shows the posts in progress (none left)');
}

// --- 2. Confirm ---
{
    const Q = await created(s, sale(400000));
    const chat = await asks(b, s, Q);
    const done = await complete(s, Q, { partnerId: b.user.id });
    equal(done.status, 200, 'completing with a partner');
    const T = done.data.trade;
    equal([T?.author_id, T?.seller_id, T?.buyer_id, T?.price, T?.confirmed, done.data.chatId], [s.user.id, s.user.id, b.user.id, 400000, 0, chat], 'a pending trade with the post price as 거래가');
    const row = tradeRow(Q);
    equal([row.backing, row.kind, row.title.includes('[QA] 거래'), row.confirmed_at], [400000, 'sell', true, null], 'the row keeps the backing and the post snapshot');
    const room = (await b(`chats/${chat}/messages`)).data;
    check(room.messages.some(m => m.type === 'review' && m.reference_id === T.id && m.sender_id === s.user.id && m.body === '거래 확인 요청'), 'a 거래 확인 요청 card in the pair\'s chat');
    check(room.trades.some(t => t.id === T.id && t.price === 400000 && t.kind === 'sell' && t.confirmed === 0), 'the chat returns the pending trade with 거래가 and kind');
    equal(sql(`SELECT COUNT(*) AS n FROM trade_log WHERE post_id=${Q} AND event='ask'`)[0].n, 1, 'the request is logged');
    equal(await stats(b), { trades: 0, deal: 0, good: 0 }, 'a pending trade counts for nobody');
    refused(await s(`trades/${T.id}/answer`, 'POST', { confirm: true }), 403, '거래 상대만 응답할 수 있습니다.', 'the author answering');
    const c3 = await register('c3');
    equal((await c3(`trades/${T.id}/answer`, 'POST', { confirm: true })).status, 403, 'a third member answering');
    equal((await b(`trades/${T.id}/answer`, 'POST', { confirm: 'yes' })).status, 400, 'confirm must be true or false');
    const yes = await b(`trades/${T.id}/answer`, 'POST', { confirm: true });
    equal([yes.status, yes.data.confirmed], [200, true], 'the partner confirms');
    check(tradeRow(Q).confirmed_at > 0, 'confirmed_at is set');
    refused(await b(`trades/${T.id}/answer`, 'POST', { confirm: false }), 409, '이미 응답한 거래입니다.', 'a second answer');
    check((await s(`chats/${chat}/messages`)).data.messages.some(m => m.type === 'system' && m.sender_id === b.user.id && m.body === '거래 확인 완료'), 'the chat gets 거래 확인 완료');
    equal(await stats(b), { trades: 1, deal: 400000, good: 0 }, 'the partner counts 1 trade and 거금 = the price');
    equal(await stats(s), { trades: 1, deal: 400000, good: 0 }, 'so does the author');
    const detail = (await guest('posts/' + Q)).data.post;
    equal([detail.author_trade_count, detail.author_deal_sum], [1, 400000], 'the detail carries the author\'s counts');
}

// --- 3. Deny and limits ---
{
    const sd = await register('sd'), c = await register('c');
    const R = await created(sd, sale());
    const chat = await asks(c, sd, R);
    const first = await complete(sd, R, { partnerId: c.user.id });
    const T1 = first.data.trade;
    check(T1?.id, 'request 1');
    const no = await c(`trades/${T1.id}/answer`, 'POST', { confirm: false });
    equal([no.status, no.data.confirmed], [200, false], 'the partner answers 거래 아님');
    equal(tradeRow(R), undefined, 'the row is gone');
    equal(sql(`SELECT actor_id,target_id FROM trade_log WHERE post_id=${R} AND event='denied'`), [{ actor_id: c.user.id, target_id: sd.user.id }], 'trade_log has denied (actor = denier, target = requester)');
    check((await sd(`chats/${chat}/messages`)).data.messages.some(m => m.type === 'system' && m.sender_id === c.user.id && m.body === '거래 아님'), 'the chat gets 거래 아님');
    equal((await c(`trades/${T1.id}/answer`, 'POST', { confirm: true })).status, 404, 'a denied trade cannot be answered again');
    for (const k of [2, 3]) {
        const r = await sd(`posts/${R}/trade`, 'POST', { partnerId: c.user.id });
        equal(r.status, 201, `request ${k} after a denial`);
        equal((await c(`trades/${r.data.trade.id}/answer`, 'POST', { confirm: false })).status, 200, `denial ${k}`);
    }
    refused(await sd(`posts/${R}/trade`, 'POST', { partnerId: c.user.id }), 429, '거래 기록 요청은 한 글에 3번까지입니다.', 'a 4th request');
    refused(await c(`posts/${R}/trade`, 'POST', {}), 429, '3번까지', 'the partner asking a 4th time');
    // With the 3 requests used, no screen offers '거래 기록 요청' any more.
    equal((await sd(`posts/${R}/partners`)).data.canAsk, false, 'the partners call says no request is left');
    equal((await sd(`chats/${chat}`)).data.chat.listing.canAsk, false, "the chat's pinned post says so too");
    equal((await c(`chats/${chat}`)).data.chat.listing.canAsk, false, 'also for the member who answered 거래 아님');
    const own = (await sd(`posts?author=${sd.user.id}&counts=1&size=20&page=1`)).data.posts.find(p => p.id === R);
    equal([own.traded, own.askable], [false, false], '내 글 marks the post as not askable');
    const panel = (await manager(`manage/users/${sd.user.id}`)).data;
    equal(panel.tradeCounts, { confirmed: 0, pending: 0, denied: 3 }, 'the member panel shows 확인 거래 0 · 확인 대기 0 · 거래 아님 3');

    // A post the manager has hidden completes without a trade record or a card.
    const d = await register('d');
    const H = await created(sd, sale());
    const hChat = await asks(d, sd, H);
    equal((await sd(`posts/${H}/partners`)).data.canAsk, true, 'an open post still has its requests');
    equal((await manager('manage/visibility', 'POST', { postId: H, hidden: true, reason: '도배·중복 글' })).status, 200, 'the manager hides H');
    const hidden = await complete(sd, H, { partnerId: d.user.id });
    equal([hidden.status, hidden.data.trade], [200, undefined], 'completing the hidden post with a partner records nothing');
    equal([status(H), tradeRow(H)], ['closed', undefined], 'H is closed without a trade row');
    check(!(await d(`chats/${hChat}/messages`)).data.messages.some(m => m.type === 'review'), 'no 거래 확인 요청 card is sent');
    equal((await sd(`posts/${H}/partners`)).data.canAsk, false, 'a hidden post offers no request');
    refused(await sd(`posts/${H}/trade`, 'POST', { partnerId: d.user.id }), 409, '숨김 처리된 글입니다.', 'a later request on the hidden post');

    // An 8-day-old request reads expired, and a new one replaces it.
    const X = await created(sd, sale());
    await asks(d, sd, X);
    const old = (await complete(sd, X, { partnerId: d.user.id })).data.trade;
    sql(`UPDATE trades SET created_at=${Date.now() - 8 * DAY} WHERE id='${old.id}'`);
    equal((await sd(`posts/${X}/partners`)).data.trade?.expired, 1, 'the partners call reads the old request as expired');
    refused(await d(`trades/${old.id}/answer`, 'POST', { confirm: true }), 409, '확인 기간 7일이 지났습니다.', 'answering an expired request');
    refused(await d(`trades/${old.id}/review`, 'POST', { good: true, tags: [] }), 409, '확인 기간 7일이 지났습니다.', 'a 후기 cannot confirm an expired request');
    const again = await sd(`posts/${X}/trade`, 'POST', { partnerId: d.user.id });
    equal(again.status, 201, 'a new request replaces the expired one');
    equal(tradeRow(X).id, again.data.trade.id, 'the post holds the new request');
    equal(sql(`SELECT COUNT(*) AS n FROM trades WHERE id='${old.id}'`)[0].n, 0, 'the expired row is gone');
    equal((await manager(`manage/users/${sd.user.id}`)).data.tradeCounts.pending, 1, 'the panel counts the live request as 확인 대기');

    // A post completed 8 days ago takes no request.
    const Y = await created(sd, sale());
    await asks(d, sd, Y);
    equal((await complete(sd, Y)).status, 200, 'Y is completed off site');
    sql(`UPDATE posts SET closed_at=${Date.now() - 8 * DAY} WHERE id=${Y}`);
    refused(await sd(`posts/${Y}/trade`, 'POST', { partnerId: d.user.id }), 409, '완료 후 7일이 지나 거래를 기록할 수 없습니다.', 'a request 8 days after 완료');
    refused(await d(`posts/${Y}/trade`, 'POST', {}), 409, '7일이 지나', 'the partner asking 8 days after 완료');
}

// --- 4. Counting ---
{
    const g = await register('g'), h = await register('h');
    const ids = [];
    for (const price of [100000, 250000]) {
        const M = await created(g, sale(price));
        await asks(h, g, M);
        const t = (await complete(g, M, { partnerId: h.user.id })).data.trade;
        equal((await h(`trades/${t.id}/answer`, 'POST', { confirm: true })).status, 200, `h confirms the ${price} trade`);
        ids.push(t.id);
    }
    equal(await stats(g), { trades: 1, deal: 250000, good: 0 }, 'two confirmed trades with the same partner within 30 days count once (거금: the larger)');
    equal((await manager(`manage/users/${g.user.id}`)).data.tradeCounts, { confirmed: 2, pending: 0, denied: 0 }, 'the panel shows both as 확인 거래');
    equal((await manager(`manage/trades/${ids[1]}`, 'DELETE')).status, 200, 'the manager voids one');
    equal(await stats(g), { trades: 1, deal: 100000, good: 0 }, 'the other one still counts');
    equal((await manager(`manage/trades/${ids[0]}`, 'DELETE')).status, 200, 'the manager voids the other');
    equal(await stats(g), { trades: 0, deal: 0, good: 0 }, 'a manager void leaves 0');
    // A trade from another 30-day bucket counts again.
    const k = await register('k'), l = await register('l');
    const K1 = await created(k, sale(50000));
    await asks(l, k, K1);
    const kt = (await complete(k, K1, { partnerId: l.user.id })).data.trade;
    equal((await l(`trades/${kt.id}/answer`, 'POST', { confirm: true })).status, 200, 'l confirms');
    const K2 = await created(k, sale(70000));
    await asks(l, k, K2);
    const kt2 = (await complete(k, K2, { partnerId: l.user.id })).data.trade;
    equal((await l(`trades/${kt2.id}/answer`, 'POST', { confirm: true })).status, 200, 'l confirms a second one');
    sql(`UPDATE trades SET created_at=created_at-${40 * DAY} WHERE id='${kt.id}'`);
    equal((await stats(k)).trades, 2, 'trades 40 days apart count twice');
    equal((await manager(`manage/users/${l.user.id}/suspend`, 'POST', { days: 0, reason: '사기·먹튀' })).status, 200, 'the counterpart is set to 영구 정지');
    equal(await stats(k), { trades: 0, deal: 0, good: 0 }, 'trades with a 영구 정지 counterpart drop out');
}

// --- 5. 거금 backing ---
{
    const pair = async name => [await register(name + 'a'), await register(name + 'b')];
    // 가격 제시 판매 (price NULL) without any 제시: a 1억 trade counts as a trade but adds 0.
    const [n1, o1] = await pair('n1');
    const F1 = await created(n1, sale(null));
    await asks(o1, n1, F1);
    const t1 = await complete(n1, F1, { partnerId: o1.user.id, amount: 100000000 });
    equal([t1.status, t1.data.trade?.price], [200, 100000000], 'a 가격 제시 sale completed at 1억');
    equal(tradeRow(F1).backing, null, 'no backing');
    equal((await o1(`trades/${t1.data.trade.id}/answer`, 'POST', { confirm: true })).status, 200, 'confirmed');
    equal(await stats(n1), { trades: 1, deal: 0, good: 0 }, 'trade_count 1, 거금 0');
    // A partner 제시 the seller never accepted backs nothing (review fix: an alt's 10억 제시 must not inflate 거금).
    const [n0, o0] = await pair('n0');
    const F0 = await created(n0, sale(null));
    equal((await o0('offers', 'POST', { postId: F0, amount: 300000 })).status, 201, 'the partner sends a 30만원 제시 that stays pending');
    const t0 = await complete(n0, F0, { partnerId: o0.user.id, amount: 300000 });
    equal([t0.status, tradeRow(F0).backing], [200, null], 'a 제시 that was not accepted is no backing');
    // The same with the partner's 30만원 제시 accepted: 거금 300,000, marked as backed by a 제시.
    const [n2, o2] = await pair('n2');
    const F2 = await created(n2, sale(null));
    const offer = await o2('offers', 'POST', { postId: F2, amount: 300000 });
    equal(offer.status, 201, 'the partner sends a 30만원 제시 (a partner through the 제시 chat)');
    equal((await n2(`offers/${offer.data.id}`, 'PATCH', { action: 'accepted' })).status, 200, 'the seller accepts it');
    const t2 = await complete(n2, F2, { partnerId: o2.user.id, amount: 100000000 });
    equal([t2.status, t2.data.chatId], [200, offer.data.chatId], 'completed at 1억 with the 제시 sender');
    equal([tradeRow(F2).backing, tradeRow(F2).backing_offer], [300000, 1], 'the backing is the partner\'s accepted 제시 (backing_offer 1)');
    equal((await o2(`trades/${t2.data.trade.id}/answer`, 'POST', { confirm: true })).status, 200, 'confirmed');
    equal(await stats(n2), { trades: 1, deal: 300000, good: 0 }, '거금 300,000');
    // An accepted 10억 제시 on a no-price post backs at most 30만원.
    const [n4, o4] = await pair('n4');
    const F4 = await created(n4, sale(null));
    const big = await o4('offers', 'POST', { postId: F4, amount: 1000000000 });
    equal((await n4(`offers/${big.data.id}`, 'PATCH', { action: 'accepted' })).status, 200, 'a 10억 제시 is accepted');
    await complete(n4, F4, { partnerId: o4.user.id, amount: 1000000000 });
    equal([tradeRow(F4).price, tradeRow(F4).backing], [1000000000, 300000], 'its backing is capped at 30만원');
    // 즉거가 60만 then 40만, completed at 40만: 거금 400,000 (backing 60만).
    const [n3, o3] = await pair('n3');
    const F3 = await created(n3, sale(600000));
    equal((await n3(`posts/${F3}/price`, 'PATCH', { price: 400000 })).status, 200, '즉거가 60만 lowered to 40만');
    await asks(o3, n3, F3);
    const t3 = await complete(n3, F3, { partnerId: o3.user.id, amount: 400000 });
    equal(tradeRow(F3).backing, 600000, 'the backing is the highest listed price');
    equal((await o3(`trades/${t3.data.trade.id}/answer`, 'POST', { confirm: true })).status, 200, 'confirmed');
    equal(await stats(n3), { trades: 1, deal: 400000, good: 0 }, '거금 400,000');
}

// --- 6. Amount rules ---
{
    const sa = await register('sa'), ba = await register('ba');
    const A1 = await created(sa, sale(300000));
    await asks(ba, sa, A1);
    refused(await complete(sa, A1, { partnerId: ba.user.id, amount: 350000 }), 400, '거래가는 즉거가 이하로 입력해 주세요.', '즉거가 300,000 with 거래가 350,000');
    equal(status(A1), 'open', 'a refused amount leaves the post open');
    refused(await complete(sa, A1, { partnerId: ba.user.id, amount: 1500 }), 400, '1,000원 단위', '거래가 in 1,000원 steps');
    refused(await complete(sa, A1, { partnerId: ba.user.id, amount: 500 }), 400, '1,000원', '거래가 below 1,000원');
    const W = await created(sa, wish(200000));
    await asks(ba, sa, W);
    refused(await complete(sa, W, { partnerId: ba.user.id, amount: 250000 }), 400, '거래가는 MAX 이하로 입력해 주세요.', '구매 MAX 200,000 with 250,000');
    const ok = await complete(sa, W, { partnerId: ba.user.id, amount: 180000 });
    equal([ok.status, ok.data.trade?.seller_id, ok.data.trade?.buyer_id, ok.data.trade?.price], [200, ba.user.id, sa.user.id, 180000], 'a 구매 completes with the partner as the seller');
    equal(tradeRow(W).backing, 200000, 'the 구매 backing is the MAX');
    const E = await created(sa, { kind: 'exchange', category: 'clan', title: `[QA] 교환 ${run}`, body: '자동 검증', price: null, tags: [], wantedTags: [], images: [], details: { wantedCategory: 'clan' } });
    await asks(ba, sa, E);
    const ex = await complete(sa, E, { partnerId: ba.user.id, amount: 500000 });
    equal([ex.status, ex.data.trade?.price, tradeRow(E).kind], [200, null, 'exchange'], '교환 stores no 거래가');
}

// --- 7. 제시 ---
{
    const so = await register('so'), p1 = await register('p1'), p2 = await register('p2');
    const O = await created(so, sale(500000));
    const o1 = await p1('offers', 'POST', { postId: O, amount: 450000 });
    const o2 = await p2('offers', 'POST', { postId: O, amount: 420000 });
    equal([o1.status, o2.status], [201, 201], 'two buyers send a 제시');
    equal((await so(`offers/${o1.data.id}`, 'PATCH', { action: 'accepted' })).status, 200, 'the seller accepts p1');
    equal(status(O), 'open', 'accepting leaves the post open');
    const lastLine = async (c, chat) => (await c(`chats/${chat}/messages`)).data.messages.filter(m => m.type === 'system').at(-1)?.body;
    equal(await lastLine(p1, o1.data.chatId), '제시 수락 · 45만원', 'the accept line has no 예약중');
    const offerOf = async (c, id) => (await c('offers')).data.offers.find(o => o.id === id)?.status;
    equal(await offerOf(p2, o2.data.id), 'pending', 'the other 제시 stays pending');
    refused(await so(`offers/${o2.data.id}`, 'PATCH', { action: 'accepted' }), 409, '수락한 제시가 있습니다. 먼저 수락을 취소해 주세요.', 'a second accept');
    equal((await p2(`offers/${o1.data.id}`, 'PATCH', { action: 'released' })).status, 404, 'a member outside the 제시 cannot release it');
    equal((await p1(`offers/${o1.data.id}`, 'PATCH', { action: 'released' })).status, 200, 'the sender releases the accepted 제시 (수락 취소)');
    equal(await offerOf(p1, o1.data.id), 'cancelled', 'the released 제시 is cancelled');
    equal(await lastLine(so, o1.data.chatId), '제시 수락 취소 · 45만원', 'the line 제시 수락 취소 · 45만원');
    refused(await p1(`offers/${o1.data.id}`, 'PATCH', { action: 'released' }), 409, '이미 처리된 제시입니다.', 'releasing twice');
    equal((await so(`offers/${o2.data.id}`, 'PATCH', { action: 'accepted' })).status, 200, 'the seller accepts p2 after the release');
    const partners = (await so(`posts/${O}/partners`)).data.partners;
    equal(partners.map(x => x.id), [p2.user.id, p1.user.id], 'the accepted sender comes first; any 제시 makes a partner');
    equal(partners[0].accepted_amount, 420000, 'with the accepted amount');
    check(typeof partners[1].chat_at === 'number' && !('suspended_until' in partners[1]), 'each partner has the chat time and no private fields');
    const done = await complete(so, O, { partnerId: p1.user.id, amount: 450000 });
    equal(done.status, 200, 'the seller completes with p1, who is not the accepted sender');
    equal(await offerOf(p2, o2.data.id), 'cancelled', 'the accepted 제시 of p2 is cancelled');
    equal(await lastLine(p2, o2.data.chatId), '글이 완료되어 제시가 마감되었습니다.', 'p2 gets 글이 완료되어 제시가 마감되었습니다.');
    refused(await so(`offers/${o2.data.id}`, 'PATCH', { action: 'released' }), 409, '이미 처리된 제시입니다.', 'no release after 완료');
    // Completing with the accepted sender keeps their 제시.
    const O2 = await created(so, sale(500000));
    const o3 = await p2('offers', 'POST', { postId: O2, amount: 480000 });
    equal((await so(`offers/${o3.data.id}`, 'PATCH', { action: 'accepted' })).status, 200, 'the seller accepts p2 on another post');
    const kept = await complete(so, O2, { partnerId: p2.user.id });
    equal([kept.status, kept.data.trade?.price, await offerOf(p2, o3.data.id)], [200, 480000, 'accepted'], 'the 거래가 defaults to the accepted 제시, which survives');
}

// --- 8. 후기 ---
{
    const sr = await register('sr'), q = await register('q');
    const V = await created(sr, sale(100000));
    await asks(q, sr, V);
    const T = (await complete(sr, V, { partnerId: q.user.id })).data.trade;
    refused(await sr(`trades/${T.id}/review`, 'POST', { good: true, tags: [] }), 409, '거래 확인 후 후기를 남길 수 있습니다.', 'the requester\'s 후기 before confirmation');
    const r = await q(`trades/${T.id}/review`, 'POST', { good: true, tags: ['답장 빠름'] });
    equal([r.status, r.data.confirmed], [201, true], 'the partner\'s 후기 on a pending trade confirms it');
    check(tradeRow(V).confirmed_at > 0, 'confirmed_at is set');
    equal((await sr(`trades/${T.id}/review`, 'POST', { good: true, tags: [] })).status, 201, 'then the requester reviews');
    equal(await stats(sr), { trades: 1, deal: 100000, good: 1 }, 'the 좋아요 counts once per bucket');
}

// --- 9. Old clients and partner requests ---
{
    const so = await register('so2'), pb = await register('pb');
    const U = await created(so, sale(150000));
    await asks(pb, so, U);
    equal((await complete(so, U)).status, 200, 'completed without a partner (an old client)');
    const late = await so(`posts/${U}/trade`, 'POST', { partnerId: pb.user.id });
    equal([late.status, late.data.trade?.confirmed, late.data.trade?.price], [201, 0, 150000], 'POST /posts/:id/trade by the author with partnerId is a pending request');
    const U2 = await created(so, sale(150000));
    await asks(pb, so, U2);
    equal((await complete(so, U2)).status, 200, 'another post completed off site');
    const own = await pb(`posts/${U2}/trade`, 'POST', { amount: 120000 });
    equal([own.status, own.data.trade?.author_id, own.data.trade?.seller_id, own.data.trade?.buyer_id, own.data.trade?.price], [201, pb.user.id, so.user.id, pb.user.id, 120000], 'the partner asks for the record themselves');
    refused(await pb(`trades/${own.data.trade.id}/answer`, 'POST', { confirm: true }), 403, '거래 상대만', 'the requester cannot confirm their own request');
    equal((await so(`trades/${own.data.trade.id}/answer`, 'POST', { confirm: true })).status, 200, 'the author confirms');
    const outsider = await register('out');
    equal((await outsider(`posts/${U2}/trade`, 'POST', {})).status, 403, 'a member who never asked about the post cannot ask');
}

// --- 10. 거래 기록 tab and 완료 거래가 (WP51) ---
{
    const st = await register('st'), bt = await register('bt'), third = await register('tt');
    // A confirmed trade at 250,000: everyone sees 거래가 250000; only the members and the manager see deal_state.
    const D = await created(st, sale(300000));
    await asks(bt, st, D);
    const td = (await complete(st, D, { partnerId: bt.user.id, amount: 250000 })).data.trade;
    equal((await bt(`trades/${td.id}/answer`, 'POST', { confirm: true })).status, 200, 'bt confirms the 250,000 trade');
    const seen = async c => { const p = (await c('posts/' + D)).data.post; return [p.deal_price, p.deal_state]; };
    equal(await seen(guest), [250000, undefined], 'a guest sees deal_price 250000 on the closed post');
    equal(await seen(third), [250000, undefined], 'a third member sees deal_price without deal_state');
    equal(await seen(st), [250000, 'confirmed'], 'the author sees 확인 완료');
    equal(await seen(bt), [250000, 'confirmed'], 'the partner sees 확인 완료');
    equal(await seen(manager), [250000, 'confirmed'], 'the manager sees 확인 완료');
    const listed = (await guest(`posts?author=${st.user.id}&status=closed&size=20&page=1`)).data.posts.find(p => p.id === D);
    equal(listed?.deal_price, 250000, 'the closed list row carries deal_price too');
    // A pending trade: no deal_price for a third viewer; the members and the manager see it as 확인 대기.
    const E2 = await created(st, sale(200000));
    await asks(bt, st, E2);
    const te = (await complete(st, E2, { partnerId: bt.user.id, amount: 180000 })).data.trade;
    check(te?.id, 'a pending trade on E2');
    const pending = async c => { const p = (await c('posts/' + E2)).data.post; return [p.deal_price, p.deal_state]; };
    equal(await pending(guest), [undefined, undefined], 'a guest sees no deal_price for a pending trade');
    equal(await pending(third), [undefined, undefined], 'a third member sees no deal_price for a pending trade');
    equal(await pending(st), [180000, 'pending'], 'the author sees 180000 · 확인 대기');
    equal(await pending(bt), [180000, 'pending'], 'the partner sees 확인 대기');
    equal(await pending(manager), [180000, 'pending'], 'the manager sees 확인 대기');
    const open = await created(st, sale(100000));
    check(!('deal_price' in (await guest('posts/' + open)).data.post), 'an open post has no deal_price');

    // GET users/:id/trades lists counted trades only.
    let list = (await guest(`users/${st.user.id}/trades`)).data;
    equal([list.total, list.trades.map(t => t.id)], [1, [td.id]], 'the 거래 기록 of st holds the confirmed trade only (not the pending one)');
    const row = list.trades[0];
    equal([row.post_id, row.price, row.kind, row.sold, row.post_gone, row.partner_id, row.nickname], [D, 250000, 'sell', true, false, bt.user.id, bt.user.nickname], 'the row has the post, 거래가, the side and the partner');
    check(row.title.includes('[QA] 거래') && Array.isArray(row.badges) && 'grade' in row, 'with the title and the partner name line');
    equal((await guest(`users/${bt.user.id}/trades`)).data.trades.map(t => [t.id, t.sold, t.partner_id]), [[td.id, false, st.user.id]], 'the partner sees it as 구매 with st');
    const title = row.title;
    equal((await st(`posts/${D}`, 'DELETE')).status, 200, 'st deletes the post');
    list = (await guest(`users/${st.user.id}/trades`)).data;
    equal(list.trades.map(t => [t.id, t.title, t.post_gone]), [[td.id, title, true]], 'after the delete the trade keeps its title snapshot, marked post_gone');
    // A removed trade is absent.
    const F = await created(st, sale(90000)), ct = await register('ct');
    await asks(ct, st, F);
    const tf = (await complete(st, F, { partnerId: ct.user.id })).data.trade;
    equal((await ct(`trades/${tf.id}/answer`, 'POST', { confirm: true })).status, 200, 'ct confirms another trade');
    equal((await guest(`users/${st.user.id}/trades`)).data.total, 2, 'two trades listed');
    equal((await manager(`manage/trades/${tf.id}`, 'DELETE')).status, 200, 'the manager removes it');
    list = (await guest(`users/${st.user.id}/trades`)).data;
    equal([list.total, list.trades.map(t => t.id)], [1, [td.id]], 'a removed trade is absent from 거래 기록');
    equal((await guest('posts/' + F)).data.post.deal_price, undefined, 'and its post shows no 거래가');
    equal((await guest(`users/${st.user.id}/trades?page=2`)).data.trades, [], 'page 2 is empty');
    // The author box: join date and the earlier nickname within 90 days.
    const G = await created(bt, sale(50000));
    const before = (await guest('posts/' + G)).data.post;
    equal([typeof before.author_created_at, 'author_prev_nickname' in before, 'author_nickname_changed_at' in before], ['number', false, false], 'the detail carries the join date and no earlier nickname yet');
    const renamed = `새닉${run}`;
    equal((await bt('users/' + bt.user.id, 'PUT', { nickname: renamed, bio: '' })).status, 200, 'bt changes the nickname');
    equal((await guest('posts/' + G)).data.post.author_prev_nickname, bt.user.nickname, 'the detail shows 이전 닉네임');
    sql(`UPDATE users SET nickname_changed_at=${Date.now() - 91 * DAY} WHERE id='${bt.user.id}'`);
    equal('author_prev_nickname' in (await guest('posts/' + G)).data.post, false, 'not after 90 days');
    check(!('author_created_at' in ((await guest(`posts?author=${bt.user.id}&size=20&page=1`)).data.posts[0] || {})), 'lists do not carry the join date');
}

console.log(`verify-deals: ${checks} checks passed`);
