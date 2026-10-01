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

for (const id of created) await manager('posts/' + id, 'DELETE');
console.log(`\n${checks} chat checks passed`);
