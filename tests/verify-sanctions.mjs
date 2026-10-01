import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Member reports and 이용 정지 (WP22): a member reports another from their shared chat (or the
// profile); the manager sees the report with the reported member and reads that chat. Only the
// manager suspends (3, 7, 30 days or 영구) and clears; a suspended member cannot write posts, 끌올,
// change prices, send 제시, apply or write to other members, but can still write to the manager,
// and their posts leave every list for everyone else. Runs only against a local Worker
// (see scripts/test-local.mjs, 8790).
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
    const r = await c('auth/register', 'POST', { username: `sx_${run}_${name}`.slice(0, 24), password, nickname: `제재${name}${run}` });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}

// The suites before this one use most of the 40 sign-ins per 10 minutes from this address.
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%'");

const guest = client(), manager = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const a = await register('a'), b = await register('b'), c = await register('c'), d = await register('d');
const A = a.user.id, B = b.user.id, C = c.user.id, D = d.user.id;
equal((await manager(`manage/users/${C}/grades`, 'POST', { grade: 'admin', plan: 'permanent' })).status, 201, 'manager appoints C 관리자');

const sale = (title, price = 100000) => ({ kind: 'sell', category: 'account', title: `[QA] ${title} ${run}`, body: '자동 검증', price, accepts_offers: true, status: 'open', tags: [], images: [], details: {} });
const postA = await a('posts', 'POST', sale('제재 판매 A'));
equal(postA.status, 201, 'A writes a sale that takes 제시');
const postB = await b('posts', 'POST', sale('제재 판매 B'));
equal(postB.status, 201, 'B writes a sale');

// --- Reports ---
const chatAB = (await a('chats', 'POST', { userId: B })).data.id;
equal((await a(`chats/${chatAB}/messages`, 'POST', { body: '입금했습니다' })).status, 201, 'A writes to B');
equal((await b(`chats/${chatAB}/messages`, 'POST', { body: '확인 후 보내드릴게요' })).status, 201, 'B answers A');
const chatBC = (await b('chats', 'POST', { userId: C })).data.id;
const chatAC = (await a('chats', 'POST', { userId: C })).data.id;
check(chatBC && chatAC && chatBC !== chatAB, 'B-C and A-C chats exist');

const report = await a('reports', 'POST', { userId: B, conversationId: chatAB, reason: '젯취·거파', details: '입금 후 거래 파기' });
equal(report.status, 201, 'A reports B from their shared chat');
const notIn = await a('reports', 'POST', { userId: B, conversationId: chatBC, reason: '잠수', details: '남의 채팅' });
equal(notIn.status, 403, 'a report naming a chat A is not in is refused');
equal((await a('reports', 'POST', { userId: B, conversationId: chatAC, reason: '잠수', details: '다른 상대의 채팅' })).status, 403, 'a report naming A\'s chat with someone else is refused');
equal((await a('reports', 'POST', { userId: B, conversationId: chatAB, reason: '사기·먹튀', details: '한 번 더' })).status, 409, 'a second waiting report about B is refused');
equal((await a('reports', 'POST', { userId: A, reason: '기타', details: '자기 자신' })).status, 400, 'nobody reports themselves');
equal((await a('reports', 'POST', { userId: 'manager', reason: '기타', details: '매니저' })).status, 400, 'the manager cannot be reported');
equal((await c('reports', 'POST', { userId: B, reason: '허위 매물', details: '회원 신고 사유가 아님' })).status, 400, 'a member report takes only the member reasons');
equal((await c('reports', 'POST', { userId: B, reason: '잠수', details: '프로필에서 신고' })).status, 201, 'C reports B from the profile (no chat)');

const summary = await manager('manage');
const fromChat = summary.data.reports.find(r => r.reporter_id === A && r.target_user_id === B);
check(fromChat, 'the manager\'s reports include target_user_id B');
equal([fromChat.conversation_id, fromChat.post_id, fromChat.reason, fromChat.target_nickname], [chatAB, null, '젯취·거파', b.user.nickname], 'the report carries the chat and the reported member');
const fromProfile = summary.data.reports.find(r => r.reporter_id === C && r.target_user_id === B);
equal(fromProfile?.conversation_id, null, 'a profile report has no chat');
const evidence = await manager(`manage/reports/${fromChat.id}/messages`);
equal(evidence.status, 200, 'the manager reads the reported chat');
equal(evidence.data.messages.map(m => [m.sender_id, m.body]), [[A, '입금했습니다'], [B, '확인 후 보내드릴게요']], 'the reported chat lists both sides in order');
equal((await manager(`manage/reports/${fromProfile.id}/messages`)).status, 404, 'a report without a chat has no chat to read');
for (const [who, caller] of [['member A', a], ['관리자 C', c]]) {
    equal((await caller(`manage/reports/${fromChat.id}/messages`)).status, 403, `${who} cannot read a reported chat`);
}

// --- Only the manager suspends ---
for (const [who, caller] of [['member A', a], ['관리자 C', c]]) {
    const r = await caller(`manage/users/${B}/suspend`, 'POST', { days: 7, reason: '사기·먹튀' });
    equal(r.status, 403, `${who} calling suspend gets 403`);
}
equal((await manager(`manage/users/manager/suspend`, 'POST', { days: 7, reason: '사기·먹튀' })).status, 400, 'suspending the manager is refused');
equal((await manager(`manage/users/${B}/suspend`, 'POST', { days: 5, reason: '사기·먹튀' })).status, 400, 'a period other than 3, 7, 30 or 영구 is refused');
equal((await manager(`manage/users/${B}/suspend`, 'POST', { days: 7, reason: '' })).status, 400, 'a suspension needs a reason');
equal((await manager(`manage/users/${B}/suspend`, 'POST', { days: null })).status, 409, 'clearing a member who is not suspended is refused');
equal((await guest(`users/${B}`)).data.user.suspended, undefined, 'B is not suspended yet');

const offerOnB = await a('offers', 'POST', { postId: postB.data.id, amount: 90000 });
equal(offerOnB.status, 201, 'A sends a 제시 on B\'s sale');

// --- 7-day suspension ---
const before = Date.now();
const suspended = await manager(`manage/users/${B}/suspend`, 'POST', { days: 7, reason: '사기·먹튀' });
equal(suspended.status, 200, 'the manager suspends B for 7 days');
check(Math.abs(suspended.data.suspended_until - (before + 7 * DAY)) < 60000, 'the suspension ends 7 days from now');
const blockedWrite = (r, name) => { equal(r.status, 403, name + ' is refused'); check(String(r.data.error).includes('이용 정지'), name + ' says 이용 정지'); };
blockedWrite(await b('posts', 'POST', sale('정지 중 새 글')), 'B\'s new post');
blockedWrite(await b('offers', 'POST', { postId: postA.data.id, amount: 90000 }), 'B\'s 제시');
blockedWrite(await b(`chats/${chatAB}/messages`, 'POST', { body: '정지 중 메시지' }), 'B\'s message to A');
blockedWrite(await b(`posts/${postB.data.id}/bump`, 'POST', {}), 'B\'s 끌올');
blockedWrite(await b(`posts/${postB.data.id}`, 'PUT', sale('제재 판매 B 수정')), 'B\'s edit');
blockedWrite(await b(`posts/${postB.data.id}/price`, 'PATCH', { price: 90000 }), 'B\'s price change');
blockedWrite(await b(`posts/${postB.data.id}/feature`, 'PUT', { active: true }), 'B\'s 상단 노출');
blockedWrite(await b('applications', 'POST', { kind: 'badge', target: 'identity' }), 'B\'s application');
check((await b(`posts/${postB.data.id}/bump`, 'POST', {})).data.error.includes('까지'), 'the refusal says until when');
blockedWrite(await b(`offers/${offerOnB.data.id}`, 'PATCH', { action: 'accepted' }), 'B accepting a 제시');
const toSuspended = await d('offers', 'POST', { postId: postB.data.id, amount: 80000 });
equal(toSuspended.status, 409, 'a 제시 on a suspended member\'s post is refused');
check(String(toSuspended.data.error).includes('이용 제한'), 'the refusal says the member is restricted');

const managerChat = (await b('chats', 'POST', { userId: 'manager' })).data.id;
const notice = (await b(`chats/${managerChat}/messages`)).data.messages.find(m => m.type === 'system' && m.sender_id === 'manager');
equal(notice?.body, '이용 정지 7일 · 사유: 사기·먹튀', 'B gets the suspension notice in the manager chat');
equal((await b(`chats/${managerChat}/messages`, 'POST', { body: '정지 사유 문의드립니다' })).status, 201, 'B can still write to the manager');

const listed = async (caller, query) => (await caller('posts?' + query)).data.posts.map(p => p.id);
check(!(await listed(guest, 'kind=sell&size=40')).includes(postB.data.id), 'B\'s post is gone from the board for guests');
check(!(await listed(a, `author=${B}`)).includes(postB.data.id), 'B\'s post is gone from B\'s profile list for others');
check(!(await listed(a, `q=${encodeURIComponent('제재 판매 B')}`)).includes(postB.data.id), 'B\'s post is gone from search');
check((await listed(b, `author=${B}`)).includes(postB.data.id), 'B still sees their own post');
check((await listed(guest, 'kind=sell&size=40')).includes(postA.data.id), 'other members\' posts stay listed');
blockedWrite(await b(`posts/${postB.data.id}/status`, 'PATCH', { status: 'reserved' }), 'B setting the post to 예약중');
equal((await b(`posts/${postB.data.id}/status`, 'PATCH', { status: 'closed' })).status, 200, 'B can still close the post');

const guestView = (await guest(`users/${B}`)).data.user;
equal([guestView.suspended, guestView.suspended_until], [true, undefined], 'others see only that B is restricted');
equal(guestView.postCount, 0, 'others count none of B\'s posts, as the lists show none');
const ownView = (await b(`users/${B}`)).data.user;
check(ownView.suspended === true && ownView.suspended_until === suspended.data.suspended_until, 'B sees until when');
check(ownView.postCount >= 1, 'B still counts their own posts');
check((await manager(`users/${B}`)).data.user.suspended_until === suspended.data.suspended_until, 'the manager sees until when');
check((await b('auth/me')).data.user.suspended_until === suspended.data.suspended_until, 'B\'s session carries the end');
equal((await a(`chats/${chatAB}`)).data.chat.partner.suspended, true, 'A\'s chat room marks B as restricted');
equal((await b(`chats/${chatAB}`)).data.chat.partner.suspended, undefined, 'B\'s chat room does not mark A');
const panel = (await manager(`manage/users/${B}`)).data;
equal([panel.user.suspended_until, panel.user.suspend_reason, panel.sanctions[0]?.days, panel.sanctions[0]?.reason], [suspended.data.suspended_until, '사기·먹튀', 7, '사기·먹튀'], 'the member panel shows the suspension and its record');
check((await manager('manage/users?q=' + encodeURIComponent(b.user.nickname))).data.users.find(u => u.id === B)?.suspended === true, 'the member list marks B');

// --- An ended suspension stops on its own ---
sql(`UPDATE users SET suspended_until=${Date.now() - 1000} WHERE id='${B}'`);
const afterEnd = await b('posts', 'POST', sale('정지 끝난 뒤 새 글'));
equal(afterEnd.status, 201, 'B can post once the end time has passed');
const relisted = await listed(guest, `author=${B}`);
check(relisted.includes(afterEnd.data.id) && relisted.includes(postB.data.id), 'B\'s posts are listed again');
equal((await b(`posts/${postB.data.id}/status`, 'PATCH', { status: 'open' })).status, 200, 'B can reopen the post once the suspension ends');
equal((await manager(`manage/users/${B}`)).data.user.suspended_until, null, 'an ended suspension reads as none');

// --- Clearing ---
equal((await manager(`manage/users/${B}/suspend`, 'POST', { days: 30, reason: '욕설·비방' })).status, 200, 'the manager suspends B for 30 days');
blockedWrite(await b('posts', 'POST', sale('30일 정지 중')), 'B\'s new post during 30 days');
const cleared = await manager(`manage/users/${B}/suspend`, 'POST', { days: null });
equal([cleared.status, cleared.data.suspended_until], [200, null], 'the manager clears the suspension');
equal((await b('posts', 'POST', sale('해제 후 새 글'))).status, 201, 'B can post again');
equal((await b(`chats/${chatAB}/messages`, 'POST', { body: '다시 연락드립니다' })).status, 201, 'B can write to A again');
const lines = (await b(`chats/${managerChat}/messages`)).data.messages.filter(m => m.type === 'system' && m.sender_id === 'manager').map(m => m.body);
equal(lines.slice(-2), ['이용 정지 30일 · 사유: 욕설·비방', '이용 정지 해제'], 'B hears about the 30 days and the clear');
equal((await manager(`manage/users/${B}`)).data.sanctions.slice(0, 3).map(x => x.days), [null, 30, 7], 'every suspension and clear is recorded');

// --- A member who blocked the manager; 영구 ---
equal((await d('blocks', 'POST', { userId: 'manager', active: true })).status, 200, 'D blocks the manager');
const forever = await manager(`manage/users/${D}/suspend`, 'POST', { days: 0, reason: '사기·먹튀' });
equal([forever.status, forever.data.suspended_until], [200, 9e15], 'suspending a member who blocked the manager works (영구)');
const refused = await d('posts', 'POST', sale('영구 정지 중'));
equal(refused.status, 403, 'D cannot post');
equal(refused.data.error, '이용 정지 중입니다. (영구)', 'the refusal says 영구, in the same form as a dated one');
equal(sql(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE (c.user_a='${D}' OR c.user_b='${D}') AND m.sender_id='manager'`)[0].n, 0, 'no notice reaches a member who blocked the manager');
const dProfile = (await d(`users/${D}`)).data.user;
equal([dProfile.suspended, dProfile.suspended_until], [true, 9e15], 'D sees the 영구 suspension');

console.log(`verify-sanctions: ${checks} checks passed`);
