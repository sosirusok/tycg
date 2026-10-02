import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 채팅 즉시 전송과 실시간 수신 (WP69), on the strict server (READ_BUDGET=on, so every answer carries
// X-D1-Calls): POST chats/:id/messages answers with the message and readThrough in at most 2 D1 calls;
// GET chats/:id/wait (long polling) returns the partner's message and the partner's read while it holds,
// and nothing after its timeout (?timeout=3, local requests only); a repeated cid writes one message;
// a block and the minute's limit refuse a send exactly as before.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
let checks = 0;
function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    const all = JSON.parse(out.slice(out.indexOf('[')));
    return all[all.length - 1].results;
}
function client(ip = `10.${100 + Math.floor(Math.random() * 90)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`) {
    let cookie = '';
    return async (path, method = 'GET', data) => {
        const started = Date.now();
        const response = await fetch(base + '/api/' + path, {
            method, redirect: 'error', signal: AbortSignal.timeout(40000),
            headers: { 'cf-connecting-ip': ip, ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: data === undefined ? undefined : JSON.stringify(data),
        });
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); }
        catch { throw new Error(`${method} ${path}: expected JSON, received HTTP ${response.status}: ${text.slice(0, 300)}`); }
        return { status: response.status, data: result, ms: Date.now() - started, at: Date.now(), calls: Number(response.headers.get('x-d1-calls')), statements: Number(response.headers.get('x-d1-statements')), rows: Number(response.headers.get('x-rows-read')) };
    };
}
async function register(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `cl_${run}_${name}`, password, nickname: `실시간${name}${run}`.slice(0, 16) });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}
const cid = () => randomBytes(12).toString('base64url');

sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%'");
const A = await register('a'), B = await register('b');
const opened = await A('chats', 'POST', { userId: B.user.id });
equal(opened.status, 200, 'A opens a chat with B');
const chat = opened.data.id;
check(Number.isFinite(opened.calls) && opened.calls > 0, 'the strict server meters D1 calls (READ_BUDGET=on)');

// ---- 1. B waits before A writes; A's send takes at most 2 D1 calls and answers with the message ----
const bWait = B(`chats/${chat}/wait?after=0&read=0`);
await new Promise(resolve => setTimeout(resolve, 400));
const first = cid();
const sent = await A(`chats/${chat}/messages`, 'POST', { body: '바로 보이나요?', cid: first, after: 0 });
equal(sent.status, 201, 'A sends B a message (201)');
check(sent.calls <= 2, `the send took ${sent.calls} D1 calls (≤ 2), ${sent.statements} statements, ${sent.rows} rows read`);
equal([sent.data.message?.body, sent.data.message?.cid, sent.data.message?.sender_id, sent.data.id], ['바로 보이나요?', first, A.user.id, sent.data.message?.id], 'the answer carries the message with its cid');
equal(sent.data.messages.map(m => m.id), [sent.data.message.id], 'and the messages after `after` (only this one)');
equal(sent.data.readThrough, 0, 'and readThrough (0: B has read nothing)');
const got = await bWait;
equal(got.status, 200, 'B\'s wait answers 200');
check(got.at - sent.at < 3000, `B's wait returned ${got.at - sent.at} ms after A's send (< 3 s)`);
equal([got.data.changed, got.data.messages.map(m => m.body)], [true, ['바로 보이나요?']], 'B\'s wait brings A\'s message');
equal(got.data.messages[0].cid, null, 'the cid stays with its sender (B sees none)');
check(Array.isArray(got.data.offers) && Array.isArray(got.data.applications) && Array.isArray(got.data.trades) && got.data.blocked === false, 'it carries the room\'s 제시, applications, trades and block state as GET messages does');
check(got.calls <= 16, `the wait used ${got.calls} D1 calls (≤ 16)`);

// ---- 2. A repeated cid writes nothing more ----
const again = await A(`chats/${chat}/messages`, 'POST', { body: '바로 보이나요?', cid: first, after: 0 });
equal([again.status, again.data.message?.id], [201, sent.data.message.id], 'the same cid again returns the first message');
equal(sql(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id='${chat}'`)[0].n, 1, 'one message in the chat');
equal((await B('chats/unread')).data.unread, 1, 'B has 1 unread, not 2');

// ---- 3. A waits; B reads; A's wait brings the new readThrough ----
const lastId = sent.data.message.id;
const aWait = A(`chats/${chat}/wait?after=${lastId}&read=0`);
await new Promise(resolve => setTimeout(resolve, 600));
const read = await B(`chats/${chat}/read`, 'POST', { lastId });
equal(read.status, 200, 'B marks it read');
const seen = await aWait;
check(seen.at - read.at < 3000, `A's wait returned ${seen.at - read.at} ms after B read (< 3 s)`);
equal([seen.data.changed, seen.data.readThrough, seen.data.messages.length], [true, lastId, 0], 'A\'s wait brings readThrough = the message (no new messages)');
// A client that is behind gets the news at once.
const behind = await A(`chats/${chat}/wait?after=${lastId}&read=0&timeout=3`);
check(behind.ms < 1500 && behind.data.changed && behind.data.readThrough === lastId, `a wait with an old read answers at once (${behind.ms} ms)`);

// ---- 4. Nothing new: the wait answers after its timeout ----
const idle = await A(`chats/${chat}/wait?after=${lastId}&read=${lastId}&timeout=3`);
equal([idle.status, idle.data.changed, idle.data.messages], [200, false, []], 'nothing new: changed false, no messages');
check(idle.ms >= 2900 && idle.ms < 6000, `it answered after the 3 s timeout (${idle.ms} ms)`);
check(idle.calls <= 16, `with ${idle.calls} D1 calls (≤ 16)`);
equal((await B(`chats/${chat}/wait?after=x`)).status, 400, 'a bad after is 400');
equal((await client()(`chats/${chat}/wait?after=0&timeout=3`)).status, 401, 'a guest gets 401');
const C = await register('c');
equal((await C(`chats/${chat}/wait?after=0&timeout=3`)).status, 404, 'a member outside the chat gets 404');
equal((await C(`chats/${chat}/messages`, 'POST', { body: '끼어들기', cid: cid() })).status, 404, '…and cannot send in it (404)');

// ---- 5. B answers with a reply; the answer to a send also brings what came meanwhile ----
const reply = await B(`chats/${chat}/messages`, 'POST', { body: '네 보여요', cid: cid(), after: lastId });
equal(reply.status, 201, 'B replies');
const mine = await A(`chats/${chat}/messages`, 'POST', { body: '좋네요', cid: cid(), after: lastId });
equal(mine.data.messages.map(m => m.body), ['네 보여요', '좋네요'], 'A\'s send answer brings B\'s reply too (everything after `after`)');
equal(mine.data.readThrough, lastId, 'readThrough is the message B read');

// ---- 6. A block refuses the send as before, in one D1 call ----
equal((await B('blocks', 'POST', { userId: A.user.id, active: true })).status, 200, 'B blocks A');
const refused = await A(`chats/${chat}/messages`, 'POST', { body: '차단 후', cid: cid() });
equal([refused.status, refused.data.error], [403, '차단된 회원입니다.'], 'a blocked member\'s send: 403 차단된 회원입니다.');
check(refused.calls <= 2, `refused in ${refused.calls} D1 calls`);
equal((await B('blocks', 'POST', { userId: A.user.id, active: false })).status, 200, 'B unblocks A');
equal((await A(`chats/${chat}/messages`, 'POST', { body: '차단 해제 후', cid: cid() })).status, 201, 'A can write again');

// ---- 7. The minute's limit (60 messages) still holds ----
sql(`UPDATE rate_limits SET count=59 WHERE key='message:${A.user.id}'`);
equal((await A(`chats/${chat}/messages`, 'POST', { body: '60번째', cid: cid() })).status, 201, 'the 60th message of the minute goes');
const limited = await A(`chats/${chat}/messages`, 'POST', { body: '61번째', cid: cid() });
equal([limited.status, limited.data.error], [429, '요청이 많습니다. 잠시 후 다시 시도해 주세요.'], 'the 61st is refused (429) as before');
sql(`DELETE FROM rate_limits WHERE key='message:${A.user.id}'`);
const bad = await A(`chats/${chat}/messages`, 'POST', { body: '', cid: cid() });
equal([bad.status, bad.data.error], [400, '메시지를 입력해 주세요.'], 'an empty message is 400 as before');

console.log(`verify-chat-live: ${checks} checks passed`);
