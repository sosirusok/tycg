import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// 웹 푸시 (WP64). TEST_PHASE=main runs on the 8790 server (VAPID keys, no PUSH_TEST): the deploy.yml key
// step, GET config, and an http endpoint refused. The default phase runs on 8791 (PUSH_TEST=on,
// READ_BUDGET=on, TEST_HOOKS=on) against a mock push service on 127.0.0.1 that records every POST:
// inline pushes (chat, 제시, 댓글) with a verified VAPID JWT, 410 and repeated failures, the queue trigger's
// types, and 50 키워드 알림 subscribers sent over several ticks B (≤ 20 a tick, one per member, within
// the tick budget), with the 게시판 알림 never pushed.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const phase = process.env.TEST_PHASE || 'strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const TICK_B = '5-59/10 * * * *';
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    const all = JSON.parse(out.slice(out.indexOf('[')));
    return all[all.length - 1].results;
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
    const c = async (path, method = 'GET', data) => {
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
    return c;
}
async function register(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `pu_${run}_${name}`.slice(0, 24), password, nickname: `푸시${name}${run}`.slice(0, 16) });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}
const guest = client();
// A subscription's keys as a browser sends them (the pushes carry no payload, so they are only stored).
const keys = () => ({ p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'), auth: randomBytes(16).toString('base64url') });

// ---- The deploy step (static) ----
async function deployCheck() {
    const yml = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
    const steps = yml.split(/\n {6}- (?=name:|uses:|run:|id:)/);
    const listAt = steps.findIndex(s => /\n {8}id: vapid\n/.test(s));
    const makeAt = steps.findIndex(s => s.includes('generateKeyPairSync'));
    check(listAt > 0 && makeAt > listAt, 'deploy.yml: the step that makes the VAPID keys runs after the secret-list step (id: vapid)');
    const list = steps[listAt], make = steps[makeAt];
    check(/wrangler secret list/.test(list) && /VAPID_PRIVATE_KEY/.test(list) && /make=keys/.test(list) && /"make=\$make" >> "\$GITHUB_OUTPUT"/.test(list), 'the check step reads `wrangler secret list` and outputs make=keys only from that check');
    check(/\[\[ ",\$names," == \*",VAPID_PRIVATE_KEY,"\* \]\]/.test(list), 'make=keys depends on VAPID_PRIVATE_KEY missing from the secret list');
    check(/VAPID_MAKE: \$\{\{ steps\.vapid\.outputs\.make \}\}/.test(make) && /if \(process\.env\.VAPID_MAKE === "keys"\) \{[^}]*generateKeyPairSync/.test(make), 'the keys are made only when the check step said make=keys');
    check(!/wrangler secret (put|delete|bulk)/.test(yml) && !/secrets? delete/i.test(yml), 'deploy.yml never puts, replaces or deletes a secret on its own');
    check(/wrangler deploy --config "\$cfg" \$\{SECRETS_ARGS:-\}/.test(yml), 'the new secrets go with the deploy (--secrets-file is additive)');
}

if (phase === 'main') {
    await deployCheck();
    const config = (await guest('config')).data;
    check(typeof config.vapidPublicKey === 'string' && Buffer.from(config.vapidPublicKey, 'base64url').length === 65, 'GET config has vapidPublicKey (a 65-byte P-256 point)');
    sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%'");
    const M = await register('m');
    equal((await M('push/subscribe', 'POST', { endpoint: 'http://127.0.0.1:9/push', keys: keys() })).status, 400, 'without PUSH_TEST an http endpoint is refused (400), even on 127.0.0.1');
    equal((await guest('push/subscribe', 'POST', { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: keys() })).status, 401, 'a guest cannot subscribe');
    equal((await guest('notifications/latest')).status, 401, 'notifications/latest is 401 for a guest');
    console.log(`verify-push (main): ${checks} checks passed`);
    process.exit(0);
}

// ---- Mock push service ----
const hits = [];
const statusFor = new Map();
const mock = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        hits.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks), at: Date.now() });
        res.writeHead(statusFor.get(req.url) || 201);
        res.end();
    });
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
const on = path => hits.filter(h => h.path === path);
async function waitFor(path, n, ms = 2000) {
    const end = Date.now() + ms;
    while (Date.now() < end && on(path).length < n) await delay(25);
    return on(path);
}
const subscribe = (c, path) => c('push/subscribe', 'POST', { endpoint: mockOrigin + path, keys: keys() });

// 'vapid t=<JWT>, k=<key>' checked against the site's public key.
function vapidOf(header, publicKey) {
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header || '');
    assert.ok(m, `Authorization is 'vapid t=…, k=…' (${header})`);
    const point = Buffer.from(publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') }, format: 'jwk' });
    return {
        token: `${m[1]}.${m[2]}.${m[3]}`, k: m[4],
        header: JSON.parse(Buffer.from(m[1], 'base64url')), claims: JSON.parse(Buffer.from(m[2], 'base64url')),
        valid: verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')),
    };
}

try {
    // Earlier runs' rows would only send pushes to closed ports; this run's searches are the only ones on.
    sql("DELETE FROM push_subscriptions; DELETE FROM push_queue; UPDATE saved_searches SET alert=0 WHERE alert=1; DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%'");
    const config = (await guest('config')).data;
    const pub = config.vapidPublicKey;
    check(typeof pub === 'string' && Buffer.from(pub, 'base64url').length === 65 && Buffer.from(pub, 'base64url')[0] === 4, 'GET config has vapidPublicKey');
    const A = await register('a'), B = await register('b'), C = await register('c');

    // ---- 1. Subscribing ----
    for (const [bad, why] of [['http://example.com/push', 'an http endpoint off 127.0.0.1'], ['https://127.0.0.1/push', 'an address'], ['https://localhost/push', 'a local name'],
        ['https://push.example.com:8443/push', 'a port'], ['ftp://push.example.com/x', 'another scheme'], ['not a url', 'no URL']]) {
        equal((await B('push/subscribe', 'POST', { endpoint: bad, keys: keys() })).status, 400, `${why} is refused (400)`);
    }
    equal((await B('push/subscribe', 'POST', { endpoint: mockOrigin + '/b' })).status, 400, 'missing keys are refused (400)');
    equal((await guest('push/subscribe', 'POST', { endpoint: mockOrigin + '/g', keys: keys() })).status, 401, 'a guest cannot subscribe (401)');
    equal((await subscribe(B, '/b')).status, 200, 'B subscribes the mock push service (PUSH_TEST=on)');
    equal((await subscribe(B, '/b')).status, 200, 'the same endpoint again');
    for (const n of [1, 2, 3, 4]) equal((await subscribe(C, '/c' + n)).status, 200, `C subscribes device ${n}`);
    equal((await A('push/subscribe', 'DELETE', { endpoint: mockOrigin + '/b' })).status, 200, 'A deleting B\'s endpoint answers ok…');
    let rows = sql(`SELECT user_id,endpoint FROM push_subscriptions WHERE user_id IN ('${B.user.id}','${C.user.id}') ORDER BY id`);
    equal(rows.map(r => [r.user_id === B.user.id ? 'B' : 'C', r.endpoint.slice(mockOrigin.length)]), [['B', '/b'], ['C', '/c2'], ['C', '/c3'], ['C', '/c4']],
        '…but B keeps it; one row per endpoint, and C keeps the newest 3 devices');
    for (const n of [2, 3]) equal((await C('push/subscribe', 'DELETE', { endpoint: mockOrigin + '/c' + n })).status, 200, `C turns off device ${n}`);

    // ---- 2. A chat message: one empty POST with TTL and a VAPID JWT, right after the request ----
    const chat = (await A('chats', 'POST', { userId: B.user.id })).data.id;
    check(typeof chat === 'string', 'A opens a chat with B');
    const t0 = Date.now();
    equal((await A(`chats/${chat}/messages`, 'POST', { body: '푸시 확인 메시지' })).status, 201, 'A sends B a chat message');
    let got = await waitFor('/b', 1);
    equal(got.length, 1, `within 2 s the mock receives one POST (${got.length ? got[0].at - t0 : '-'} ms)`);
    const h = got[0];
    equal([h.method, h.body.length, h.headers['content-length'], h.headers.ttl], ['POST', 0, '0', '86400'], 'an empty POST with TTL 86400');
    check(!h.headers['content-type'] && !h.headers['content-encoding'], 'no payload headers (payload-less push)');
    const v1 = vapidOf(h.headers.authorization, pub);
    check(v1.valid, 'the JWT verifies against the site\'s public key (ES256)');
    equal([v1.header.alg, v1.claims.aud, v1.k], ['ES256', mockOrigin, pub], 'alg ES256, aud = the push service origin, k = the public key');
    check(/^(https:\/\/|mailto:)/.test(v1.claims.sub) && v1.claims.exp > Date.now() / 1000 + 11 * 3600 && v1.claims.exp <= Date.now() / 1000 + 24 * 3600, `sub ${v1.claims.sub} and exp about 12 hours ahead`);

    // What the service worker shows: the newest unread chat, not a visit.
    sql(`UPDATE users SET last_seen_at=1000 WHERE id='${B.user.id}'`);
    let latest = await B('notifications/latest');
    equal(latest.status, 200, 'B reads notifications/latest');
    equal([latest.data.push?.title, latest.data.push?.body, latest.data.push?.url, latest.data.push?.tag], [A.user.nickname, '푸시 확인 메시지', '/chat/' + chat, 'chat-' + chat], 'push: A\'s nickname, the message, the chat');
    equal(sql(`SELECT last_seen_at FROM users WHERE id='${B.user.id}'`)[0].last_seen_at, 1000, 'reading it is not a visit (최근 접속 unchanged)');
    equal((await guest('notifications/latest')).status, 401, 'notifications/latest is 401 for a guest');

    // ---- 3. 제시, its 수락, and 댓글 ----
    equal((await subscribe(A, '/a')).status, 200, 'A subscribes');
    const post = await A('posts', 'POST', { kind: 'sell', category: 'account', title: `[QA] 푸시 판매 ${run}`, body: '푸시 확인', price: 300000, accepts_offers: true, tags: [], images: [], details: {} });
    equal(post.status, 201, `A posts a sale (${post.data.error || ''})`);
    const offer = await B('offers', 'POST', { postId: post.data.id, amount: 250000, note: '' });
    equal(offer.status, 201, 'B sends A a 제시');
    equal((await waitFor('/a', 1)).length, 1, 'A\'s device gets one push');
    equal((await A(`offers/${offer.data.id}`, 'PATCH', { action: 'accepted' })).status, 200, 'A accepts it');
    equal((await waitFor('/b', 2)).length, 2, 'B (who sent the 제시) gets a push');
    const v2 = vapidOf(on('/b')[1].headers.authorization, pub);
    equal(v2.token, v1.token, 'the JWT for the same push service is reused (cached per origin)');
    equal((await B(`posts/${post.data.id}/comments`, 'POST', { body: '댓글 푸시 확인' })).status, 201, 'B comments on A\'s post');
    equal((await waitFor('/a', 2)).length, 2, 'A gets a push for the 댓글 (a new 알림 row)');
    equal((await B(`posts/${post.data.id}/comments`, 'POST', { body: '두 번째 댓글' })).status, 201, 'B comments again while A has not read it');
    await delay(700);
    equal(on('/a').length, 2, 'no second push while the 댓글 알림 is unread');
    latest = await A('notifications/latest');
    equal([latest.data.push?.body, latest.data.push?.url, typeof latest.data.push?.id], [latest.data.alert?.text, `/posts/${post.data.id}#comments`, 'number'], 'A\'s latest is the 댓글 알림, opening the post at its 댓글, with its id to mark read');

    // ---- 4. 410 deletes the subscription; 5 failures in a row delete it too ----
    statusFor.set('/b', 410);
    equal((await A(`chats/${chat}/messages`, 'POST', { body: '410 확인' })).status, 201, 'A writes B again (the mock answers 410)');
    equal((await waitFor('/b', 3)).length, 3, 'the push was tried');
    await delay(500);
    equal(sql(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id='${B.user.id}'`)[0].n, 0, 'B\'s subscription is deleted (410)');
    statusFor.set('/c4', 500);
    const chatC = (await A('chats', 'POST', { userId: C.user.id })).data.id;
    for (let i = 1; i <= 5; i++) {
        equal((await A(`chats/${chatC}/messages`, 'POST', { body: `실패 ${i}` })).status, 201, `A writes C (${i})`);
        equal((await waitFor('/c4', i)).length, i, `C's device was tried (${i})`);
        await delay(300);
        if (i === 1) equal(sql(`SELECT fail_count FROM push_subscriptions WHERE user_id='${C.user.id}'`).map(r => r.fail_count), [1], 'a 500 counts one failure');
    }
    equal(sql(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id='${C.user.id}'`)[0].n, 0, 'the 5th failure in a row deletes it');

    // ---- 5. Which 알림 types go through the queue ----
    const types = [['keyword', 'k1', 1], ['follow', 'f1', 1], ['condition', 'c1', 1], ['match', '7', 1], ['fav_price', '7', 1], ['bump_ready', '7', 1], ['same_listing', '7', 1],
        ['auto_stale', '2026-10-05', 1], ['grade_end', '9:soon', 1], ['grade_end', '9:end', 1], ['grade_end', '9:1790000000000', 0], ['board', 'b1', 0], ['comment', '7', 0], ['fav_closed', '7', 0], ['application', '7', 0]];
    const members = [];
    for (const [type, ref, queued] of types) {
        const m = await register('t' + members.length);
        equal((await subscribe(m, `/t-${members.length}`)).status, 200, `member ${members.length} subscribes (${type})`);
        members.push({ m, type, ref, queued });
    }
    const loner = await register('lone');
    const now = Date.now();
    rows = sql(`DELETE FROM push_queue; INSERT INTO notifications(user_id,type,ref,text,created_at) VALUES ${[...members.map(x => `('${x.m.user.id}','${x.type}','${x.ref}','큐 확인',${now})`), `('${loner.user.id}','keyword','k','큐 확인',${now})`].join(',')};
        SELECT user_id FROM push_queue`);
    const queued = new Set(rows.map(r => r.user_id));
    for (const x of members) equal(queued.has(x.m.user.id), !!x.queued, `${x.type} ${x.ref}: ${x.queued ? 'queued' : 'not queued'}`);
    equal(queued.has(loner.user.id), false, 'a member without a subscription is never queued');
    const tick = async () => {
        const before = hits.length;
        const r = await send(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(TICK_B)}&time=${Date.now() + 61000}`, () => ({ signal: AbortSignal.timeout(60000) }));
        await r.arrayBuffer();
        assert.equal(r.status, 200, `tick B answered ${r.status}`);
        const meter = JSON.parse(sql("SELECT value FROM settings WHERE key='sys:last_cron_meter'")[0]?.value || '{}');
        check(meter.d1Calls <= 8 && meter.d1Statements + meter.fetches <= 45, `tick B stays in the budget (${meter.d1Calls} calls, ${meter.d1Statements} statements + ${meter.fetches} fetches)`);
        return hits.slice(before);
    };
    let sent = await tick();
    equal(members.map(x => sent.filter(s => s.path === `/t-${members.indexOf(x)}`).length), members.map(x => x.queued), 'tick B pushes each queued member once and nobody else');

    // ---- 6. 50 키워드 알림 subscribers and one 게시판 알림 subscriber: ≤ 20 a tick, one each ----
    const word = `푸시${run}`;
    const subscribers = [];
    for (let i = 0; i < 50; i += 10) {
        subscribers.push(...await Promise.all(Array.from({ length: Math.min(10, 50 - i) }, async (_, j) => {
            const m = await register('k' + (i + j));
            assert.equal((await m('searches', 'POST', { name: word, query: `kind=sell&q=${encodeURIComponent(word)}`, alert: true })).status, 200, 'keyword 알림 saved');
            assert.equal((await subscribe(m, `/k${i + j}`)).status, 200, 'subscribed');
            return m;
        })));
    }
    check(subscribers.length === 50, '50 members save the keyword 알림 and subscribe');
    const boardFan = await register('board');
    equal((await boardFan('searches', 'POST', { name: '판매 계정', query: 'kind=sell&category=account', alert: true })).data.keyword, true, 'one member saves the 게시판 알림 (판매 · 계정)');
    equal((await subscribe(boardFan, '/board')).status, 200, '…and subscribes');
    sql(`DELETE FROM push_queue; INSERT INTO settings(key,value,updated_at) SELECT 'sys:alert_cursor',json_object('t',${Date.now()},'i',COALESCE(MAX(id),0)),${Date.now()} FROM posts WHERE 1
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);
    const match = await A('posts', 'POST', { kind: 'sell', category: 'account', title: `[QA] ${word} 계정`, body: '키워드 푸시 확인', price: 100000, tags: [], images: [], details: {} });
    equal(match.status, 201, `A posts a sale with the word (${match.data.error || ''})`);
    // Tick after tick until all 50 are sent (3 ticks at 20 a tick).
    const fan = s => s.filter(x => /^\/k\d+$/.test(x.path));
    const per = new Map(), ticks = [];
    while (ticks.length < 5 && per.size < 50) {
        const got = fan(await tick());
        ticks.push(got);
        got.forEach(x => per.set(x.path, (per.get(x.path) || 0) + 1));
    }
    check(ticks[0].length > 0 && ticks[0].length <= 20, `the first tick B sends ${ticks[0].length} pushes (≤ 20)`);
    check(ticks.length >= 3 && ticks.slice(1).every(t => t.length <= 20), `later ticks send the rest (${ticks.map(t => t.length).join(', ')})`);
    check(ticks.every(t => new Set(t.map(x => x.path)).size === t.length), 'no member gets two pushes in one tick');
    equal([per.size, Math.max(...per.values())], [50, 1], 'all 50 got exactly one push over the ticks');
    equal(on('/board').length, 0, 'the 게시판 알림 subscriber gets no push');
    equal(sql('SELECT COUNT(*) AS n FROM push_queue')[0].n, 0, 'the queue is empty');

    // ---- 7. 회원 탈퇴 removes the member's devices ----
    equal((await subscribers[0]('auth/withdraw', 'POST', { password })).status, 200, 'a subscriber leaves (회원 탈퇴)');
    equal(sql(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id='${subscribers[0].user.id}'`)[0].n, 0, 'their subscription is gone');
} finally {
    mock.close();
    // Later suites must not push to the closed mock or match this run's searches.
    try { sql("DELETE FROM push_subscriptions; DELETE FROM push_queue; UPDATE saved_searches SET alert=0 WHERE alert=1"); }
    catch (e) { console.error('cleanup failed', e.message); }
}
console.log(`verify-push: ${checks} checks passed`);
