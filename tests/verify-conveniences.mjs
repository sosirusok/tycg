import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Small conveniences (WP20): 최근 접속 (users.last_seen_at, written at most once per 10 minutes by
// currentUser) on the profile, the chat room partner and one post's author; '가격 내림' (price_drop)
// on 찜한 글; saved searches. Runs only against a local Worker (see scripts/test-local.mjs, 8790).
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const MINUTE = 60000;
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

// A pooled keep-alive socket can be closed by the local dev server while the suite waits on
// `wrangler d1 execute`; the request never reached the Worker then, so it is sent once more.
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
    const r = await c('auth/register', 'POST', { username: `cv_${run}_${name}`.slice(0, 24), password, nickname: `${name}${run}` });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}

// The suites before this one use most of the 40 sign-ins per 10 minutes from this address.
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%'");

const guest = client();
const seller = await register('seller'), buyer = await register('buyer');
const stored = id => sql(`SELECT last_seen_at FROM users WHERE id='${id}'`)[0].last_seen_at;

// 1. 최근 접속.
equal((await buyer('auth/me')).status, 200, 'buyer makes a signed-in request');
const profile = (await guest('users/' + buyer.user.id)).data.user;
check(typeof profile.last_seen_at === 'number' && Math.abs(Date.now() - profile.last_seen_at) < MINUTE, 'GET /users/<buyer> last_seen_at is within 60 s of now');
const first = stored(buyer.user.id);
equal(first, profile.last_seen_at, 'the profile shows the stored value');
await delay(1000);
equal((await buyer('auth/me')).status, 200, 'a second request 1 s later');
equal((await buyer('posts?scope=favorites')).status, 200, 'and a third');
equal(stored(buyer.user.id), first, 'requests within 10 minutes do not write last_seen_at again');
sql(`UPDATE users SET last_seen_at=last_seen_at-${11 * MINUTE} WHERE id='${buyer.user.id}'`);
await buyer('auth/me');
const later = stored(buyer.user.id);
check(later > first && Math.abs(Date.now() - later) < MINUTE, 'a request 11 minutes after the last write updates it');
const parallel = await Promise.all([1, 2, 3, 4].map(() => seller('auth/me')));
check(parallel.every(r => r.status === 200) && typeof stored(seller.user.id) === 'number', 'parallel first requests all succeed and write the value');
equal((await guest('users/' + buyer.user.id)).data.user.last_seen_at, later, 'a guest sees the value without changing it');
check(!('last_seen_at' in ((await buyer('auth/me')).data.user || {})), 'the session user (auth/me) does not carry last_seen_at');

const chat = await buyer('chats', 'POST', { userId: seller.user.id });
equal(chat.status, 200, 'buyer opens a chat with seller');
const room = (await buyer('chats/' + chat.data.id)).data.chat;
equal(room.partner.last_seen_at, stored(seller.user.id), 'the chat room partner carries last_seen_at');

// 2. 가격 내림 on 찜한 글.
const sale = (title, price) => ({ kind: 'sell', category: 'other', title, body: '자동 검증', price, accepts_offers: true, status: 'open', tags: [], images: [], details: {} });
async function post(title, price) {
    const r = await seller('posts', 'POST', sale(`[QA] 찜 ${run} ${title}`, price));
    assert.equal(r.status, 201, `${title}: ${JSON.stringify(r.data)}`);
    return r.data.id;
}
const lowered = await post('after', 600000), before = await post('before', 600000), raised = await post('raised', 600000), closed = await post('closed', 600000);
const bounced = await post('bounced', 600000), bouncedLow = await post('bounced low', 600000);
const single = (await guest('posts/' + lowered)).data.post;
equal(single.author_last_seen_at, stored(seller.user.id), 'one post carries its author last_seen_at');
check(!('author_last_seen_at' in (await guest(`posts?author=${seller.user.id}`)).data.posts[0]), 'list rows leave it out');
const price = (id, value) => seller(`posts/${id}/price`, 'PATCH', { price: value });
equal((await price(before, 550000)).status, 200, 'a price lowered before the favorite');
await delay(20);
for (const id of [lowered, before, raised, closed, bounced, bouncedLow]) equal((await buyer(`posts/${id}/favorite`, 'POST', { active: true })).status, 200, `buyer saves post ${id}`);
await delay(20);
equal((await price(lowered, 500000)).status, 200, 'seller lowers 60만원 to 50만원 after the favorite');
equal((await price(lowered, 450000)).status, 200, 'and again to 45만원');
equal((await price(raised, 500000)).status, 200, 'another post goes down to 50만원');
equal((await price(raised, 650000)).status, 200, 'and back up to 65만원');
equal((await price(closed, 500000)).status, 200, 'a post lowered and then closed');
equal((await seller(`posts/${closed}/status`, 'PATCH', { status: 'closed' })).status, 200, 'is closed');
for (const id of [bounced, bouncedLow]) equal((await price(id, 700000)).status, 200, 'a saved post goes up to 70만원');
equal((await price(bounced, 650000)).status, 200, 'then down to 65만원, still above the 60만원 the member saw');
equal((await price(bouncedLow, 550000)).status, 200, 'another down to 55만원, below it');
const favorites = (await buyer('posts?scope=favorites&size=40')).data.posts;
const drop = id => favorites.find(p => p.id === id)?.price_drop;
equal(drop(lowered), { from: 600000, to: 450000 }, '찜한 글: price_drop from the price when saved to the price now');
equal(drop(before), undefined, 'a drop before the favorite is not shown');
equal(drop(raised), undefined, 'a price back above the saved one shows no drop');
equal(drop(closed), undefined, 'a 거래완료 post shows no drop');
equal(drop(bounced), undefined, 'a rise and a smaller fall show no drop (the saved price is kept)');
equal(drop(bouncedLow), { from: 600000, to: 550000 }, 'a fall below the saved price drops from the price the member saw');
equal(sql(`SELECT saved_price FROM favorites WHERE user_id='${buyer.user.id}' AND post_id=${lowered}`)[0].saved_price, 600000, 'the favorite keeps the price when saved');
// A favorite saved before saved_price existed falls back to the price history.
sql(`UPDATE favorites SET saved_price=NULL WHERE user_id='${buyer.user.id}' AND post_id=${lowered}`);
equal((await buyer('posts?scope=favorites&size=40')).data.posts.find(p => p.id === lowered)?.price_drop, { from: 600000, to: 450000 }, 'without a saved price the drop comes from the history');
check(!(await guest(`posts?author=${seller.user.id}&size=40`)).data.posts.some(p => 'price_drop' in p), 'other lists carry no price_drop');
check(!(await seller('posts?scope=favorites')).data.posts.some(p => 'price_drop' in p), 'a member who saved nothing sees no drops');

// 3. Saved searches (the same 20 for every grade).
const query = 'kind=sell&category=account&skinTags=' + encodeURIComponent(JSON.stringify(['유루미']));
equal((await buyer('searches', 'POST', { name: '유루미', query })).status, 200, 'buyer saves a search');
const saved = (await buyer('searches')).data.searches;
equal(saved.map(s => [s.name, s.query]), [['유루미', query]], 'GET searches returns it');
equal((await seller('searches')).data.searches, [], 'another member does not see it');
equal((await buyer('searches/' + saved[0].id, 'DELETE')).status, 200, 'buyer deletes it');
equal((await buyer('searches')).data.searches, [], 'it is gone');
equal((await guest('searches')).status, 401, 'guests have no saved searches');

console.log(`verify-conveniences: ${checks} checks passed`);
