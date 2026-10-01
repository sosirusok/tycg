import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Trade rules from round 2: price history, offers on status changes, chat creation from a post,
// 대리(진행) visibility, blocks, hidden posts, numeric and record filters and per-tab search counts.
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
    return async (path, method = 'GET', data) => {
        const response = await fetch(base + '/api/' + path, {
            method, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: data === undefined ? undefined : JSON.stringify(data),
        });
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
    const r = await c('auth/register', 'POST', { username: `t2_${run}_${name}`.slice(0, 24), password, nickname: `${name}${run}` });
    assert.equal(r.status, 200, `${name} registers`);
    c.user = r.data.user;
    return c;
}

const manager = client(), guest = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const members = {};
for (const name of ['seller', 'buyerA', 'buyerB', 'asker', 'author', 'authorB', 'proxy', 'other']) members[name] = await register(name);
const created = [];
const sale = extra => ({ kind: 'sell', category: 'other', title: `[QA] 판매 ${run} ${created.length}`, body: '자동 검증', price: 400000, accepts_offers: true, status: 'open', tags: [], images: [], details: {}, ...extra });
async function post(owner, payload, label) {
    const r = await owner('posts', 'POST', payload);
    equal(r.status, 201, label);
    created.push(r.data.id);
    return r.data.id;
}
const read = async (viewer, id) => (await viewer('posts/' + id)).data.post;
const prices = p => p.price_history.map(h => h.price);
const offerOf = async (viewer, id) => (await viewer('offers')).data.offers.find(o => o.id === id);
const messages = async (viewer, chatId) => (await viewer(`chats/${chatId}/messages`)).data.messages;
const lastMessage = async (viewer, chatId) => (await messages(viewer, chatId)).at(-1);
const chatUnread = async (viewer, chatId) => (await viewer('chats')).data.chats.find(c => c.id === chatId)?.unread ?? 0;

// F08: history keeps only strictly falling prices above the current one.
{
    const s = members.seller;
    const id = await post(s, sale({ price: 600000 }), 'F08 sell post at 600000');
    for (const price of [500000, 400000, 550000, 450000]) equal((await s('posts/' + id, 'PUT', sale({ price }))).status, 200, `F08 price edit to ${price}`);
    const p = await read(guest, id);
    equal([prices(p), p.price], [[600000, 550000], 450000], 'F08 600, 500, 400, 550, 450 leaves history [600000, 550000] under 450000');
    check(p.price_history.every(h => h.price > p.price), 'F08 no history entry is at or below the current price');

    const open = await post(s, sale({ price: null }), 'F08 sell post with 가격 제시');
    equal((await s('posts/' + open, 'PUT', sale({ price: 500000 }))).status, 200, 'F08 가격 제시 to 500000');
    check(!prices(await read(guest, open)).includes(500000), 'F08 가격 제시 then 500000 has no struck 500000');

    const back = await post(s, sale({ price: 500000 }), 'F08 sell post at 500000');
    for (const price of [400000, null, 500000]) await s('posts/' + back, 'PUT', sale({ price }));
    const again = await read(guest, back);
    equal([prices(again), again.price], [[], 500000], 'F08 500, 400, 가격 제시, 500 leaves no entry equal to the current price');
}

// F17 and F24: 현젯 below 즉거가, prices of at least 1,000원, 제시 only on 판매 posts.
{
    const s = members.seller;
    const high = await s('posts', 'POST', sale({ price: 400000, details: { currentOffer: '450000' } }));
    equal([high.status, high.data.error], [400, '현젯은 즉거가보다 낮게 입력해 주세요.'], 'F17 현젯 above 즉거가 is refused');
    equal((await s('posts', 'POST', sale({ price: 400000, details: { currentOffer: '400000' } }))).status, 400, 'F17 현젯 equal to 즉거가 is refused');
    const zero = await s('posts', 'POST', sale({ price: 0 }));
    equal([zero.status, zero.data.error], [400, '즉거가는 1,000원 이상입니다.'], 'F24 sell price 0 is refused');
    equal((await s('posts', 'POST', sale({ price: 999 }))).status, 400, 'F24 sell price 999 is refused');
    const buy = await post(s, { ...sale({ price: 300000 }), kind: 'buy', accepts_offers: true }, 'F24 buy post with accepts_offers');
    equal((await read(guest, buy)).accepts_offers, 0, 'F24 buy posts never accept offers');
    const onBuy = await members.buyerA('offers', 'POST', { postId: buy, amount: 200000 });
    equal([onBuy.status, onBuy.data.error], [400, '판매 글에만 제시할 수 있습니다.'], 'F24 offer on a buy post is refused');
    const target = await post(s, sale(), 'F24 sell post for offers');
    const small = await members.buyerA('offers', 'POST', { postId: target, amount: 0 });
    equal([small.status, small.data.error], [400, '제시가는 1,000원 이상입니다.'], 'F24 offer amount 0 is refused');
    const tiny = await s('posts', 'POST', sale({ price: 400000, details: { currentOffer: '500' } }));
    equal([tiny.status, tiny.data.error], [400, '현젯은 1,000원 이상입니다.'], 'F24 현젯 below 1,000원 is refused');
}

// F04 and F09 (two states, WP43): accepting a 제시 leaves the post open, 완료 ends the pending offers
// (and an accepted one whose sender is not the partner), and the chat lines offers leave.
{
    const s = members.seller, a = members.buyerA, b = members.buyerB;
    const p1 = await post(s, sale(), 'F04 sell post');
    const offer = await a('offers', 'POST', { postId: p1, amount: 350000 });
    equal(offer.status, 201, 'F04 buyer offers 350000');
    const chat = offer.data.chatId;
    equal((await s(`posts/${p1}/status`, 'PATCH', { status: 'reserved' })).status, 200, 'F04 a legacy 예약중 request is a no-op on an open post');
    equal([(await read(guest, p1)).status, (await offerOf(a, offer.data.id)).status], ['open', 'pending'], 'F04 the post stays open and keeps the pending offer');

    const before = await chatUnread(a, chat);
    equal((await s('offers/' + offer.data.id, 'PATCH', { action: 'accepted' })).status, 200, 'F04 seller accepts');
    equal((await read(guest, p1)).status, 'open', 'F04 accepting leaves the post open');
    check(await chatUnread(a, chat) >= before + 1, 'F09 accepting raises the buyer unread count');
    const accepted = await lastMessage(a, chat);
    equal([accepted.type, accepted.body, accepted.sender_id], ['system', '제시 수락 · 35만원', s.user.id], 'F09 accept line from the seller');

    equal((await s(`posts/${p1}/status`, 'PATCH', { status: 'closed', partnerId: a.user.id })).status, 200, 'F04 seller completes with the buyer as the partner');
    equal((await offerOf(a, offer.data.id)).status, 'accepted', 'F04 완료 keeps the partner\'s accepted offer');
    equal((await s(`posts/${p1}/status`, 'PATCH', { status: 'open' })).status, 409, 'F04 a completed post cannot be reopened');
    equal((await offerOf(a, offer.data.id)).status, 'accepted', 'F04 the refused reopen changes nothing');

    const p2 = await post(s, sale(), 'F04 second sell post');
    const pending = await b('offers', 'POST', { postId: p2, amount: 300000 });
    equal(pending.status, 201, 'F04 second buyer offers');
    equal((await s(`posts/${p2}/status`, 'PATCH', { status: 'closed' })).status, 200, 'F04 seller completes with a pending offer');
    equal((await offerOf(b, pending.data.id)).status, 'cancelled', 'F04 완료 cancels the pending offer');
    const closed = await lastMessage(b, pending.data.chatId);
    equal([closed.type, closed.body, closed.sender_id], ['system', '글이 완료되어 제시가 마감되었습니다.', s.user.id], 'F09 completing leaves the 마감 line from the seller');

    // The editor's PUT never changes the status.
    const p3 = await post(s, sale(), 'F04 third sell post');
    const viaPut = await a('offers', 'POST', { postId: p3, amount: 250000 });
    equal((await s('posts/' + p3, 'PUT', sale({ status: 'closed' }))).status, 200, 'F04 editor saves with a stale status');
    equal([(await read(guest, p3)).status, (await offerOf(a, viaPut.data.id)).status], ['open', 'pending'], 'F04 PUT leaves the post open and the offer pending');

    const p4 = await post(s, sale(), 'F09 post for decline and withdraw');
    const declined = await a('offers', 'POST', { postId: p4, amount: 20000 });
    equal((await s('offers/' + declined.data.id, 'PATCH', { action: 'declined' })).status, 200, 'F09 seller declines');
    const declineLine = await lastMessage(a, declined.data.chatId);
    equal([declineLine.type, declineLine.body], ['system', '제시 거절 · 2만원'], 'F09 decline line');
    const count = (await messages(a, declined.data.chatId)).length;
    equal((await s('offers/' + declined.data.id, 'PATCH', { action: 'declined' })).status, 409, 'F09 a second decline is refused');
    equal((await messages(a, declined.data.chatId)).length, count, 'F09 a refused decision adds no line');
    const withdrawn = await a('offers', 'POST', { postId: p4, amount: 30000 });
    equal((await a('offers/' + withdrawn.data.id, 'PATCH', { action: 'withdrawn' })).status, 200, 'F09 buyer withdraws');
    const withdrawLine = await lastMessage(s, withdrawn.data.chatId);
    equal([withdrawLine.type, withdrawLine.body, withdrawLine.sender_id], ['system', '제시 취소 · 3만원', a.user.id], 'F09 withdraw line from the buyer');

    // Accepting one offer keeps the others pending (WP43); completing with its sender ends them, each with the 마감 line.
    const p5 = await post(s, sale(), 'F09 post with two offers');
    const first = await a('offers', 'POST', { postId: p5, amount: 380000 }), second = await b('offers', 'POST', { postId: p5, amount: 350000 });
    const unreadB = await chatUnread(b, second.data.chatId);
    equal((await s('offers/' + first.data.id, 'PATCH', { action: 'accepted' })).status, 200, 'F09 seller accepts the first offer');
    equal((await offerOf(b, second.data.id)).status, 'pending', 'F09 the other offer stays pending');
    equal((await s(`posts/${p5}/status`, 'PATCH', { status: 'closed', partnerId: a.user.id })).status, 200, 'F09 seller completes with the accepted buyer');
    equal([(await offerOf(b, second.data.id)).status, (await offerOf(a, first.data.id)).status], ['cancelled', 'accepted'], 'F09 the other pending offer ends (마감); the partner\'s stays');
    const endedLine = await lastMessage(b, second.data.chatId);
    equal([endedLine.type, endedLine.body, endedLine.sender_id], ['system', '글이 완료되어 제시가 마감되었습니다.', s.user.id], 'F09 the other buyer gets the 마감 line from the seller');
    check(await chatUnread(b, second.data.chatId) > unreadB, 'F09 the other buyer sees it as unread');
}

// F13: 채팅하기 only opens the chat; the first message brings the post's card.
{
    const s = members.seller, q = members.asker;
    const postA = await post(s, sale({ title: `[QA] 채팅 A ${run}` }), 'F13 post A');
    const postB = await post(s, sale({ title: `[QA] 채팅 B ${run}` }), 'F13 post B');
    const unread = (await s('chats/unread')).data.unread;
    const opened = await q('chats', 'POST', { postId: postA });
    equal(opened.status, 200, 'F13 chat opened from a post');
    equal((await s('chats/unread')).data.unread, unread, 'F13 opening a chat does not notify the seller');
    equal((await messages(q, opened.data.id)).length, 0, 'F13 the opened chat has no messages');
    check(!(await s('chats')).data.chats.some(c => c.id === opened.data.id) && !(await q('chats')).data.chats.some(c => c.id === opened.data.id), 'F13 a chat with no messages is in neither chat list');
    equal((await q('chats', 'POST', { userId: s.user.id, postId: postA })).data.id, opened.data.id, 'F13 userId and postId open the same chat');
    equal((await q('chats', 'POST', { userId: members.other.user.id, postId: postA })).status, 400, 'F13 the post must be the partner\'s');

    equal((await q(`chats/${opened.data.id}/messages`, 'POST', { body: '안녕하세요', postId: postA })).status, 201, 'F13 first message about post A');
    equal((await messages(q, opened.data.id)).map(m => [m.type, m.type === 'listing' ? m.reference_id : m.body]),
        [['listing', String(postA)], ['text', '안녕하세요']], 'F13 the chat holds exactly [listing, text]');
    equal((await s('chats/unread')).data.unread, unread + 1, 'F13 the message reaches the seller, and the post card is not counted as unread');
    check((await s('chats')).data.chats.some(c => c.id === opened.data.id), 'F13 the chat is listed after the first message');
    await q(`chats/${opened.data.id}/messages`, 'POST', { body: '이것도요', postId: postB });
    await q(`chats/${opened.data.id}/messages`, 'POST', { body: '다시 A요', postId: postA });
    await q(`chats/${opened.data.id}/messages`, 'POST', { body: '계속 A요', postId: postA });
    equal((await messages(q, opened.data.id)).filter(m => m.type === 'listing').map(m => m.reference_id), [postA, postB, postA].map(String), 'F13 asking about B then A gives cards [A, B, A]');
    equal([(await s('chats/unread')).data.unread, (await s('chats')).data.chats.find(c => c.id === opened.data.id)?.unread], [unread + 4, 4], 'F13 unread counts only the 4 texts, not the post cards');
    equal((await s(`chats/${opened.data.id}/messages`, 'POST', { body: '제 글이에요', postId: postA })).status, 400, 'F13 the post author cannot attach their own post');
}

// F26: a 대리(진행) post is hidden from others once its author loses 대리 인증.
{
    const px = members.proxy, o = members.other;
    equal((await manager(`manage/users/${px.user.id}/badges`, 'POST', { badge: 'proxy', active: true })).status, 200, 'F26 manager grants 대리 인증');
    const id = await post(px, { kind: 'proxy_offer', category: 'story', title: `[QA] 대리 진행 ${run}`, body: '자동 검증', price: 20000, status: 'open', tags: [], images: [], details: {} }, 'F26 대리(진행) post');
    equal((await o('users/' + px.user.id)).data.user.postCount, 1, 'F26 the post counts while the badge is held');
    equal((await manager(`manage/users/${px.user.id}/badges`, 'POST', { badge: 'proxy', active: false })).status, 200, 'F26 manager revokes 대리 인증');
    equal((await o('posts/' + id)).status, 404, 'F26 another member gets 404');
    equal((await guest('posts/' + id)).status, 404, 'F26 a guest gets 404');
    equal((await px('posts/' + id)).status, 200, 'F26 the author still opens it');
    equal((await manager('posts/' + id)).status, 200, 'F26 the manager still opens it');
    equal((await o('chats', 'POST', { postId: id })).status, 404, 'F26 no chat can be opened from it');
    equal((await o('users/' + px.user.id)).data.user.postCount, 0, 'F26 profile postCount excludes it');
    equal((await px('users/' + px.user.id)).data.user.postCount, 1, 'F26 the author still counts it');
}

// F27: boards skip blocked authors; their profile list does not.
{
    const o = members.other, s = members.seller;
    const elsewhere = await post(members.buyerA, sale({ title: `[QA] 다른 판매 ${run}` }), 'F27 another member\'s sell post');
    const board = async () => (await o('posts?' + new URLSearchParams({ kind: 'sell', q: run, size: '40' }))).data.posts;
    check((await board()).some(p => p.author_id === s.user.id), 'F27 the seller is on the board before blocking');
    const unblockedProfile = await o('users/' + s.user.id);
    equal(unblockedProfile.data.user.blocked, false, 'F27 profile says not blocked');
    check(!('blocked' in (await guest('users/' + s.user.id)).data.user), 'F27 guests get no blocked flag');
    equal((await o('blocks', 'POST', { userId: s.user.id, active: true })).status, 200, 'F27 member blocks the seller');
    const blockedBoard = await board();
    check(!blockedBoard.some(p => p.author_id === s.user.id), 'F27 the board skips the blocked seller');
    check(blockedBoard.some(p => p.id === elsewhere), 'F27 the board still lists other sellers');
    check((await o('posts?' + new URLSearchParams({ author: s.user.id, size: '40' }))).data.posts.length > 0, 'F27 the blocked seller\'s profile list still shows posts');
    equal((await o('users/' + s.user.id)).data.user.blocked, true, 'F27 profile says blocked');
    equal((await o('blocks', 'POST', { userId: s.user.id, active: false })).status, 200, 'F27 member unblocks');
    check((await board()).some(p => p.author_id === s.user.id), 'F27 the seller is back on the board');
}

// F10: hidden posts, their reason, the author's notice, and offers ended by the hide.
{
    const au = members.author, b = members.buyerB, o = members.other;
    const id = await post(au, sale({ title: `[QA] 숨김 ${run}` }), 'F10 post to hide');
    const offer = await b('offers', 'POST', { postId: id, amount: 300000 });
    equal(offer.status, 201, 'F10 buyer offers before the hide');
    const updated = (await read(au, id)).updated_at;
    equal((await manager('manage/visibility', 'POST', { postId: id, hidden: true, reason: '아무 사유' })).status, 400, 'F10 unknown reasons are refused');
    equal((await manager('manage/visibility', 'POST', { postId: id, hidden: true, reason: '도배·중복 글' })).status, 200, 'F10 manager hides with a reason');
    const own = (await au('posts?' + new URLSearchParams({ author: au.user.id }))).data.posts.find(p => p.id === id);
    equal([own?.hidden, own?.hidden_reason], [1, '도배·중복 글'], 'F10 the author lists the hidden post with its reason');
    equal(own.updated_at, updated, 'F10 hiding keeps updated_at');
    const othersList = (await o('posts?' + new URLSearchParams({ author: au.user.id }))).data.posts;
    check(!othersList.some(p => p.id === id), 'F10 another member\'s list excludes the hidden post');
    check((await o('posts?' + new URLSearchParams({ q: run, size: '40' }))).data.posts.every(p => !('hidden_reason' in p)), 'F10 other members never see hidden_reason');
    equal((await o('posts/' + id)).status, 404, 'F10 another member gets 404');
    equal((await manager('posts/' + id)).data.post.hidden_reason, '도배·중복 글', 'F10 the manager sees the reason');
    const notices = async who => {
        const chat = (await who('chats')).data.chats.find(c => c.partner_id === 'manager');
        return chat ? (await messages(who, chat.id)).filter(m => m.type === 'system' && m.sender_id === 'manager').map(m => m.body) : [];
    };
    check((await notices(au)).some(t => t === `‘[QA] 숨김 ${run}’ 글이 숨김 처리되었습니다. 사유: 도배·중복 글`), 'F10 the author gets the notice with the reason');
    equal((await offerOf(b, offer.data.id)).status, 'cancelled', 'F10 hiding cancels the pending offer');
    const ended = await lastMessage(b, offer.data.chatId);
    equal([ended.body, ended.sender_id], ['글이 숨김 처리되어 제시가 마감되었습니다.', au.user.id], 'F10 the offer chat gets the 마감 line from the author');

    equal((await manager('manage/visibility', 'POST', { postId: id, hidden: false })).status, 200, 'F10 manager unhides');
    const shown = await read(au, id);
    equal([shown.hidden, shown.hidden_reason], [0, ''], 'F10 unhiding clears the reason');
    check((await notices(au)).includes(`‘[QA] 숨김 ${run}’ 글이 다시 공개되었습니다.`), 'F10 the author hears the post is public again');

    const au2 = members.authorB;
    const second = await post(au2, sale({ title: `[QA] 차단 숨김 ${run}` }), 'F10 post by a member who blocked the manager');
    equal((await au2('blocks', 'POST', { userId: 'manager', active: true })).status, 200, 'F10 author blocks the manager');
    equal((await manager('manage/visibility', 'POST', { postId: second, hidden: true, reason: '허위 매물' })).status, 200, 'F10 hide still succeeds');
    equal((await read(au2, second)).hidden, 1, 'F10 the post is hidden anyway');
    await au2('blocks', 'POST', { userId: 'manager', active: false });
}

// F06 and F22: numeric filter errors, and the record condition from the buyer's side.
{
    const bad = await guest('posts?' + new URLSearchParams({ kind: 'sell', category: 'account', phantom: '22.5' }));
    equal([bad.status, bad.data.error], [400, '숫자 검색 조건을 확인해 주세요.'], 'F06 phantom=22.5 gets the search message');
    for (const query of [{ gas: 'abc' }, { level: '1000' }, { minerals: '-1' }, { skins: '10000' }]) {
        const r = await guest('posts?' + new URLSearchParams({ kind: 'sell', category: 'account', ...query }));
        equal([r.status, r.data.error], [400, '숫자 검색 조건을 확인해 주세요.'], 'F06 bad ' + Object.keys(query)[0]);
    }
    equal((await guest('posts?' + new URLSearchParams({ kind: 'sell', category: 'account', gas: '0' }))).status, 200, 'F06 zero is a valid minimum');

    const s = members.seller, token = `rec${run}`;
    const buyPost = (pref, n) => post(s, {
        kind: 'buy', category: 'account', title: `[QA] ${token} ${n}`, body: '자동 검증', price: 300000, status: 'open', tags: [], images: [],
        details: pref ? { recordPreference: pref } : {},
    }, 'F22 buy post ' + n);
    const [clean, any, none] = [await buyPost('무전적', 1), await buyPost('전적 있어도 괜찮음', 2), await buyPost('', 3)];
    const found = async extra => (await guest('posts?' + new URLSearchParams({ kind: 'buy', q: token, ...extra }))).data.posts.map(p => p.id).sort((x, y) => x - y);
    equal(await found({ myRecord: '전적 있음' }), [any, none].sort((x, y) => x - y), 'F22 전적 있음 finds buyers who accept a record or did not say');
    equal(await found({ myRecord: '무전적' }), [clean, any, none].sort((x, y) => x - y), 'F22 무전적 fits every buyer');
    equal((await guest('posts?' + new URLSearchParams({ kind: 'buy', myRecord: '몰라요' }))).status, 400, 'F22 unknown record value is refused');
    check((await found({ recordPreference: '무전적' })).length === 1, 'F22 the old exact-match param still works');

    const exchange = pref => post(s, {
        kind: 'exchange', category: 'clan', title: `[QA] ${token} 교환`, body: '자동 검증', price: null, status: 'open', tags: [], images: [],
        details: { wantedCategory: 'account', ...(pref ? { wantedRecordPreference: pref } : {}) },
    }, 'F22 exchange post');
    const [strict, open] = [await exchange('무전적'), await exchange('')];
    const swaps = (await guest('posts?' + new URLSearchParams({ kind: 'exchange', q: token, wantedMyRecord: '전적 있음' }))).data.posts.map(p => p.id);
    check(swaps.includes(open) && !swaps.includes(strict), 'F22 wantedMyRecord works on 교환');
}

// V-23: a search across every tab returns per-tab counts.
{
    const all = await guest('posts?' + new URLSearchParams({ q: run }));
    equal(Object.keys(all.data.counts || {}).sort(), ['buy', 'exchange', 'proxy_offer', 'proxy_request', 'sell'], 'V-23 counts cover the five tabs');
    check(all.data.counts.sell >= 1 && all.data.counts.buy >= 3, 'V-23 counts.sell and counts.buy are filled');
    equal(Object.values(all.data.counts).reduce((n, v) => n + v, 0), all.data.total, 'V-23 counts add up to the total');
    check(!('counts' in (await guest('posts?' + new URLSearchParams({ q: run, kind: 'sell' }))).data), 'V-23 no counts inside one tab');
    check(!('counts' in (await guest('posts?kind=sell')).data), 'V-23 no counts without a search word');
}

// WP14: 전변 가능 also finds 영전, the cafe 계정 조건 keys, active=1 hides 거래완료 and the 작성자 인증 filter.
{
    const s = members.seller, token = `cond${run}`;
    const account = (details, n, extra = {}) => post(s, {
        kind: 'sell', category: 'account', title: `[QA] ${token} ${n}`, body: '자동 검증', price: 300000, status: 'open', tags: [], images: [],
        details: { ownerCount: '1', recordStatus: '무전적', ...details }, ...extra,
    }, 'WP14 sell account post ' + n);
    const young = await account({ phoneChange: '영전', passwordChange: '가능', backupEmail: '없음', integrated: '미통합' }, 1);
    const plain = await account({ phoneChange: '가능', passwordChange: '가능', backupEmail: '있음', integrated: '통합' }, 2);
    const cool = await account({ phoneChange: '쿨타임 남음', passwordChange: '가능' }, 3);
    const done = await account({ phoneChange: '가능' }, 4);
    equal((await s(`posts/${done}/status`, 'PATCH', { status: 'closed' })).status, 200, 'WP14 post 4 is completed');
    const found = async extra => (await guest('posts?' + new URLSearchParams({ kind: 'sell', category: 'account', q: token, ...extra }))).data.posts.map(p => p.id).sort((x, y) => x - y);
    const phone = await found({ phoneChange: '가능' });
    check(phone.includes(young), 'WP14 phoneChange=가능 includes a post whose phoneChange is 영전');
    equal(phone, [young, plain, done].sort((x, y) => x - y), 'WP14 phoneChange=가능 leaves out 쿨타임 남음');
    equal(await found({ phoneChange: '영전' }), [young], 'WP14 phoneChange=영전 is still exact');
    equal(await found({ passwordChange: '가능', phoneChange: '가능', active: '1' }), [young, plain].sort((x, y) => x - y), 'WP14 전비변 가능 with active=1');
    equal(await found({ backupEmail: '없음' }), [young], 'WP14 보멜 없음');
    equal(await found({ integrated: '미통합' }), [young], 'WP14 미통');
    check(!(await found({ active: '1' })).includes(done) && (await found({})).includes(done), 'WP14 active=1 hides 거래완료 and the plain list keeps it');
    check(!cool || (await found({})).includes(cool), 'WP14 the unfiltered list has every post');

    const credit = members.other;
    equal((await manager(`manage/users/${credit.user.id}/badges`, 'POST', { badge: 'credit', active: true })).status, 200, 'WP14 manager grants 신용인');
    const mine = await post(credit, {
        kind: 'sell', category: 'other', title: `[QA] ${token} 신용인`, body: '자동 검증', price: 10000, status: 'open', tags: [], images: [], details: {},
    }, 'WP14 신용인 post');
    const byBadge = (await guest('posts?' + new URLSearchParams({ q: token, badge: 'credit' }))).data;
    equal(byBadge.posts.map(p => p.id), [mine], 'WP14 badge=credit lists only posts by 신용인 holders');
    check(byBadge.counts && byBadge.counts.sell === 1, 'WP14 badge=credit also narrows the per-tab counts');
    equal((await guest('posts?' + new URLSearchParams({ q: token, badge: 'identity' }))).data.posts.length, 0, 'WP14 badge=identity finds none of this run');
}

// The manager may delete any post; this run's posts are removed.
for (const id of created) await manager('posts/' + id, 'DELETE');
console.log(`\n${checks} trade checks passed`);
