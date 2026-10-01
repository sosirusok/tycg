import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Chat API from WP16: the post a chat is about (GET /chats/:id listing, list rows' post title and
// photo), offer rows with their post's price, and the manager-only ?filter=applications list.
// Runs only against a local Worker (see scripts/test-local.mjs).
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

function client() {
    let cookie = '';
    return async (path, method = 'GET', data, raw) => {
        const response = await fetch(base + '/api/' + path, {
            method, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(raw ? { 'Content-Type': raw.type } : data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: raw ? raw.bytes : data === undefined ? undefined : JSON.stringify(data),
        });
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); }
        catch { throw new Error(`${method} ${path}: expected JSON, received HTTP ${response.status}: ${text.slice(0, 300)}`); }
        return { status: response.status, data: result };
    };
}
async function register(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `ch_${run}_${name}`.slice(0, 24), password, nickname: `${name}${run}` });
    assert.equal(r.status, 200, `${name} registers`);
    c.user = r.data.user;
    return c;
}

const manager = client();
const login = await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword });
equal(login.status, 200, 'manager logs in');
const managerId = login.data.user.id;
const seller = await register('seller'), buyer = await register('buyer'), asker = await register('asker'), applicant = await register('appl'), quitter = await register('quit');
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const photo = (await seller('uploads', 'POST', undefined, { type: 'image/png', bytes: png })).data.id;
check(typeof photo === 'string', 'seller uploads a photo');
const created = [];
async function sale(title, extra = {}) {
    const r = await seller('posts', 'POST', { kind: 'sell', category: 'other', title, body: '자동 검증', price: 400000, accepts_offers: true, status: 'open', tags: [], images: [], details: { currentOffer: '200000' }, ...extra });
    equal(r.status, 201, 'post: ' + title);
    created.push(r.data.id);
    return r.data.id;
}
const withPhoto = await sale(`[QA] 채팅 글 ${run}`, { images: [photo] });
const offered = await sale(`[QA] 제시 글 ${run}`);

// A chat opened with 채팅하기 has no post until the first message carries one.
const chatId = (await buyer('chats', 'POST', { postId: withPhoto })).data.id;
equal((await buyer('chats/' + chatId)).data.chat.listing, null, 'no post card yet: listing is null');
equal((await buyer(`chats/${chatId}/messages`, 'POST', { body: '아직 판매중인가요?', postId: withPhoto })).status, 201, 'first message about the post');
const listing = (await buyer('chats/' + chatId)).data.chat.listing;
equal({ ...listing }, { id: withPhoto, title: `[QA] 채팅 글 ${run}`, kind: 'sell', price: 400000, status: 'open', author_id: seller.user.id, price_mode: 'fixed', thumb: photo, currentOffer: 200000 }, 'listing names the post with thumb and 현젯');
equal((await seller('chats/' + chatId)).data.chat.listing?.id, withPhoto, 'the seller sees the same listing');
const row = (await buyer('chats')).data.chats.find(c => c.id === chatId);
equal([row.last_post_title, row.last_post_thumb], [`[QA] 채팅 글 ${run}`, photo], 'list row has the post title and photo');

// A chat that starts with 제시하기 is about the offered post; offers carry its price and author.
const offer = await asker('offers', 'POST', { postId: offered, amount: 300000, note: '' });
equal(offer.status, 201, 'offer sent');
equal((await asker('chats/' + offer.data.chatId)).data.chat.listing?.id, offered, 'listing comes from the latest 제시');
const offerRow = (await seller(`chats/${offer.data.chatId}/messages`)).data.offers[0];
equal([offerRow.post_kind, offerRow.post_price, offerRow.post_author_id], ['sell', 400000, seller.user.id], 'offer rows carry the post kind, price and author');
const askerRow = (await asker('chats')).data.chats.find(c => c.id === offer.data.chatId);
equal([askerRow.last_post_title, askerRow.last_post_thumb], [`[QA] 제시 글 ${run}`, null], 'list row without a photo has a null thumb');
equal((await seller(`posts/${offered}/price`, 'PATCH', { currentOffer: 300000 })).status, 200, '현젯으로 표시 (PATCH price)');
equal((await asker('chats/' + offer.data.chatId)).data.chat.listing.currentOffer, 300000, 'listing shows the new 현젯');

// A post the manager hides drops out for the other member, not for its author.
equal((await manager('manage/visibility', 'POST', { postId: withPhoto, hidden: true, reason: '도배·중복 글' })).status, 200, 'manager hides the post');
equal((await buyer('chats/' + chatId)).data.chat.listing, null, 'hidden post: no listing for the buyer');
equal((await buyer('chats')).data.chats.find(c => c.id === chatId).last_post_title, null, 'hidden post: no title in the buyer list');
equal((await seller('chats/' + chatId)).data.chat.listing?.id, withPhoto, 'hidden post: the author still sees it');
await manager('manage/visibility', 'POST', { postId: withPhoto, hidden: false });

// 신청 대기: manager only, and only chats with a waiting application.
equal((await buyer('chats?filter=applications')).status, 403, 'member gets 403 for ?filter=applications');
equal((await buyer('chats?filter=nope')).status, 400, 'unknown filter is 400');
const pending = await applicant('applications', 'POST', { kind: 'badge', target: 'identity' });
equal(pending.status, 201, 'application sent');
const cancelled = await quitter('applications', 'POST', { kind: 'badge', target: 'identity' });
equal((await quitter('applications/' + cancelled.data.id, 'PATCH', { action: 'cancel' })).status, 200, 'second application cancelled');
const plainChat = (await asker('chats', 'POST', { userId: managerId })).data.id;
equal((await asker(`chats/${plainChat}/messages`, 'POST', { body: '문의드립니다' })).status, 201, 'plain chat with the manager');
const all = (await manager('chats')).data.chats, waiting = (await manager('chats?filter=applications')).data.chats;
check([pending.data.chatId, cancelled.data.chatId, plainChat].every(id => all.some(c => c.id === id)), 'the full list has all three manager chats');
check(waiting.some(c => c.id === pending.data.chatId), '신청 대기 includes the waiting application');
check(!waiting.some(c => c.id === cancelled.data.chatId || c.id === plainChat), '신청 대기 leaves out cancelled and plain chats');
check(waiting.every(c => c.pending_applications > 0), '신청 대기 rows all have a waiting application');
equal((await manager(`applications/${pending.data.id}`, 'PATCH', { action: 'reject', note: '자료 부족' })).status, 200, 'manager rejects');
check(!(await manager('chats?filter=applications')).data.chats.some(c => c.id === pending.data.chatId), 'a decided application leaves 신청 대기');

// Unread counters (WP42): conversations keep each side's unread count, so chats/unread and the list
// rows read the counters instead of counting messages.
const reader = await register('rdr'), writer = await register('wrt');
const before = Date.now() - 1;
const pairChat = (await writer('chats', 'POST', { userId: reader.user.id })).data.id;
for (const text of ['하나', '둘', '셋']) equal((await writer(`chats/${pairChat}/messages`, 'POST', { body: text })).status, 201, 'B sends A: ' + text);
equal((await reader('chats/unread')).data.unread, 3, 'A: chats/unread = 3');
equal((await reader('chats')).data.chats.find(c => c.id === pairChat)?.unread, 3, 'A: the chat row shows 3 unread');
equal((await writer('chats/unread')).data.unread, 0, 'B: nothing unread (own messages)');
const sinceRows = await reader('chats?since=' + before);
equal([sinceRows.status, sinceRows.data.chats.map(c => c.id)], [200, [pairChat]], 'GET chats?since=<t before> returns only that chat');
check(typeof sinceRows.data.at === 'number', 'the list answers with the server time for the next ?since');
equal((await reader('chats?since=' + (Date.now() + 60000))).data.chats, [], 'GET chats?since=<later> returns no rows');
equal((await reader('chats?since=abc')).status, 400, 'a bad since is 400');
const lastId = (await reader(`chats/${pairChat}/messages`)).data.messages.at(-1).id;
equal((await reader(`chats/${pairChat}/read`, 'POST', { lastId })).status, 200, 'A marks read');
equal((await reader('chats/unread')).data.unread, 0, 'A: chats/unread = 0 after reading');
equal((await reader('chats')).data.chats.find(c => c.id === pairChat)?.unread, 0, 'A: the chat row shows 0 unread');
equal((await reader(`chats/${pairChat}/messages`, 'POST', { body: '네' })).status, 201, 'A replies');
equal([(await writer('chats/unread')).data.unread, (await reader('chats/unread')).data.unread], [1, 0], 'the reply counts for B only');
// A post card ('listing') never counts as unread: B asks about A's post, and A gets 1 unread.
const readerPost = await reader('posts', 'POST', { kind: 'sell', category: 'other', title: `[QA] 카드 글 ${run}`, body: '자동 검증', price: 50000, status: 'open', tags: [], images: [], details: {} });
equal(readerPost.status, 201, 'A writes a post');
equal((await writer(`chats/${pairChat}/messages`, 'POST', { body: '이 글 문의', postId: readerPost.data.id })).status, 201, 'B asks about it (card and text)');
equal((await reader('chats/unread')).data.unread, 1, 'A: 1 unread (the card does not count)');
await reader('posts/' + readerPost.data.id, 'DELETE');

for (const id of created) await manager('posts/' + id, 'DELETE');
console.log(`\n${checks} chat checks passed`);
