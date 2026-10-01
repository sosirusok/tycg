import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 거래 후기 and the trade count (WP23, with the WP43 confirm card): after a post is 완료 its author names the member they
// traded with from the post's partners (a chat with the post's card, or the accepted 제시 on it); that
// writes one trade per post and a '거래 후기 남기기' card in their chat. The named member confirms the
// trade with their 후기; only then does it count and may the author review them. Each side leaves one
// 후기 within 30 days; profiles count confirmed trades and 좋아요. Only the manager removes a 후기 or a
// trade, and a removed one cannot be written again.
// Runs only against a local Worker (see scripts/test-local.mjs, 8790).
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
    const r = await c('auth/register', 'POST', { username: `rv_${run}_${name}`.slice(0, 24), password, nickname: `후기${name}${run}` });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}

// The suites before this one use most of the 40 sign-ins per 10 minutes from this address.
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%'");

const guest = client(), manager = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const s = await register('s'), b = await register('b'), c = await register('c'), d = await register('d'), adm = await register('m');
const S = s.user.id, B = b.user.id, C = c.user.id, D = d.user.id;
equal((await manager(`manage/users/${adm.user.id}/grades`, 'POST', { grade: 'admin', plan: 'permanent' })).status, 201, 'manager appoints a 관리자-grade member');

const sale = (title, price = 300000, extra = {}) => ({ kind: 'sell', category: 'account', title: `[QA] ${title} ${run}`, body: '자동 검증', price, accepts_offers: true, status: 'open', tags: [], images: [], details: {}, ...extra });
const P = (await s('posts', 'POST', sale('후기 판매'))).data.id;
check(P, 'S writes a sale P');

// B asks about P from 채팅하기: the first message carries the post, so the chat gets P's card.
const chatSB = (await b('chats', 'POST', { userId: S, postId: P })).data.id;
equal((await b(`chats/${chatSB}/messages`, 'POST', { body: '아직 판매하시나요?', postId: P })).status, 201, 'B writes to S about P');
check((await b(`chats/${chatSB}/messages`)).data.messages.some(m => m.type === 'listing' && m.reference_id === String(P)), 'the chat holds P\'s card');
// C chats with S without any post: not a partner of P.
const chatSC = (await c('chats', 'POST', { userId: S })).data.id;
equal((await c(`chats/${chatSC}/messages`, 'POST', { body: '다른 글 문의' })).status, 201, 'C writes to S without a post');

// --- P still open ---
equal((await s(`posts/${P}/trade`, 'POST', { partnerId: B })).status, 409, 'a trade on an open post is refused (409)');
equal((await s(`posts/${P}/status`, 'PATCH', { status: 'reserved' })).status, 200, 'a legacy 예약중 request is a no-op');
equal((await guest(`posts/${P}`)).data.post.status, 'open', 'P stays open (two states)');
equal((await s(`posts/${P}/trade`, 'POST', { partnerId: B })).status, 409, 'still no trade on an open post (409)');
equal((await s(`posts/${P}/status`, 'PATCH', { status: 'closed' })).status, 200, 'S completes P without a partner (사이트 밖)');

// --- Partners ---
const partners = await s(`posts/${P}/partners`);
equal(partners.status, 200, 'S reads P\'s partners');
check(partners.data.partners.some(x => x.id === B && x.conversation_id === chatSB && x.nickname === b.user.nickname && Array.isArray(x.badges)), 'the partners include B with nickname, badges and the chat');
check(!partners.data.partners.some(x => x.id === C), 'C, who never asked about P, is not a partner');
equal(partners.data.trade, null, 'P has no trade yet');
equal((await b(`posts/${P}/partners`)).status, 403, 'only the author reads the partners');
equal((await guest(`posts/${P}/partners`)).status, 401, 'a guest cannot read the partners');

// --- Trade ---
equal((await c(`posts/${P}/trade`, 'POST', {})).status, 403, 'a member who is not a partner cannot ask for the record');
equal((await s(`posts/${P}/trade`, 'POST', { partnerId: C })).status, 400, 'a non-partner is refused (400)');
equal((await s(`posts/${P}/trade`, 'POST', {})).status, 400, 'a trade needs a partner');
const trade = await s(`posts/${P}/trade`, 'POST', { partnerId: B });
equal(trade.status, 201, 'S records the trade with B (201)');
const T = trade.data.trade;
equal([T.seller_id, T.buyer_id, T.price, T.post_id, T.author_id, T.confirmed], [S, B, 300000, P, S, 0], 'the author of a sale is the seller; the price is the post price; not confirmed yet');
equal((await s(`posts/${P}/trade`, 'POST', { partnerId: B })).status, 409, 'a second trade on the post is refused (409)');
equal((await s(`posts/${P}/trade`, 'POST', { partnerId: C })).status, 400, 'a non-partner is still refused (400) after the trade');
equal((await s(`posts/${P}/partners`)).data.trade?.id, T.id, 'the partners call returns the recorded trade');

// The card in their chat, visible to both, sent by S (unread for B).
const roomB = (await b(`chats/${chatSB}/messages`)).data;
const card = roomB.messages.find(m => m.type === 'review');
check(card && card.reference_id === T.id && card.sender_id === S && card.body === '거래 확인 요청', 'B\'s chat shows the 거래 확인 요청 card');
check(roomB.trades.some(t => t.id === T.id && t.post_id === P && t.title.includes('후기 판매') && t.reviews.length === 0 && t.author_id === S && t.confirmed === 0 && t.removed === 0), 'B\'s chat returns the unconfirmed trade with no 후기 yet');
check((await s(`chats/${chatSB}/messages`)).data.messages.some(m => m.type === 'review' && m.reference_id === T.id), 'S sees the same card');
check(!(await c(`chats/${chatSC}/messages`)).data.messages.some(m => m.type === 'review'), 'no card in C\'s chat');
const listB = (await b('chats')).data.chats.find(x => x.id === chatSB);
equal([listB.last_message, listB.unread > 0], ['거래 확인 요청', true], 'B\'s chat list shows the card as the latest, unread');

// --- Confirmation: the author waits for the named member's 후기 ---
const early = await s(`trades/${T.id}/review`, 'POST', { good: false, tags: ['잠수'] });
equal(early.status, 409, 'the author cannot review before the other member confirms (409)');
equal(early.data.error, '거래 확인 후 후기를 남길 수 있습니다.', 'the refusal says the trade waits for confirmation');
equal([(await guest(`users/${S}`)).data.user.tradeCount, (await guest(`users/${B}`)).data.user.tradeCount], [0, 0], 'an unconfirmed trade counts for nobody');
const quietPoll = (await b(`chats/${chatSB}/messages?after=${Number.MAX_SAFE_INTEGER - 1}`)).data;
check(!('trades' in quietPoll), 'a poll without news leaves the trades out');
check('trades' in (await b(`chats/${chatSB}/messages?after=${Number.MAX_SAFE_INTEGER - 1}&trades=1`)).data, 'a poll asking for them (trades=1) gets them');

// --- 후기 ---
equal((await b(`trades/${T.id}/review`, 'POST', { good: true, tags: ['잠수'] })).status, 400, 'a 좋아요 takes only the 좋아요 tags');
equal((await b(`trades/${T.id}/review`, 'POST', { good: 'yes', tags: [] })).status, 400, 'good must be true or false');
equal((await b(`trades/${T.id}/review`, 'POST', { good: true, tags: ['답장 빠름', '답장 빠름'] })).status, 400, 'a tag cannot repeat');
equal((await b(`trades/${T.id}/review`, 'POST', { good: true, tags: [], text: 'ㄱ'.repeat(101) })).status, 400, 'a 후기 line is at most 100 characters');
const reviewB = await b(`trades/${T.id}/review`, 'POST', { good: true, tags: ['답장 빠름'], text: '  빠른 거래\n감사합니다  ' });
equal(reviewB.status, 201, 'B reviews S (좋아요, 답장 빠름) (201)');
equal([reviewB.data.review.target_id, reviewB.data.review.good, reviewB.data.review.tags, reviewB.data.review.text], [S, 1, ['답장 빠름'], '빠른 거래 감사합니다'], 'the 후기 targets S as one line');
equal(reviewB.data.confirmed, true, 'B\'s 후기 confirms the trade');
const lastSeenId = roomB.messages.at(-1).id;
const confirmPoll = (await s(`chats/${chatSB}/messages?after=${lastSeenId}`)).data;
check(confirmPoll.messages.some(m => m.type === 'system' && m.sender_id === B && m.body === '거래 확인 완료'), 'the chat gets 거래 확인 완료 from B');
check(confirmPoll.trades?.find(t => t.id === T.id)?.confirmed === 1, 'the poll that brings that line brings the confirmed trade');
equal((await b(`trades/${T.id}/review`, 'POST', { good: false, tags: [] })).status, 409, 'B cannot review the same trade again (409)');
equal((await c(`trades/${T.id}/review`, 'POST', { good: true, tags: [] })).status, 403, 'a third member cannot review the trade (403)');
equal((await guest(`trades/${T.id}/review`, 'POST', { good: true, tags: [] })).status, 401, 'a guest cannot review');
equal((await b('trades/nope/review', 'POST', { good: true, tags: [] })).status, 404, 'an unknown trade is 404');
const reviewS = await s(`trades/${T.id}/review`, 'POST', { good: true, tags: ['약속 잘 지킴', '설명과 같음'] });
equal(reviewS.status, 201, 'S reviews B (201)');

const profileS = (await guest(`users/${S}`)).data.user;
equal([profileS.tradeCount, profileS.goodCount, profileS.reviewCount], [1, 1, 1], 'GET /users/S returns trade count 1 and good 1');
const profileB = (await guest(`users/${B}`)).data.user;
equal([profileB.tradeCount, profileB.goodCount], [1, 1], 'B counts the same trade as the buyer');
equal([(await guest(`users/${C}`)).data.user.tradeCount, (await guest(`users/${C}`)).data.user.goodCount], [0, 0], 'C has no trades');
const detail = (await guest(`posts/${P}`)).data.post;
equal([detail.author_trade_count, detail.author_good_count], [1, 1], 'the post detail carries the author\'s counts');
const reviewsOfS = await guest(`users/${S}/reviews`);
equal(reviewsOfS.status, 200, 'anyone reads a member\'s 후기 tab');
equal(reviewsOfS.data.total, 1, 'S has one 후기');
const row = reviewsOfS.data.reviews[0];
equal([row.author_id, row.nickname, row.good, row.tags, row.text], [B, b.user.nickname, 1, ['답장 빠름'], '빠른 거래 감사합니다'], 'the 후기 row has the nickname, 좋아요, tags and text');
check(typeof row.created_at === 'number' && Array.isArray(row.badges) && !('grade_expires_at' in row), 'the row has the date and the name line, without the grade end');
const roomAfter = (await b(`chats/${chatSB}/messages`)).data.trades.find(t => t.id === T.id);
equal(roomAfter.reviews.map(r => [r.author_id, r.good]).sort(), [[B, 1], [S, 1]].sort(), 'the chat card returns both 후기');
check(roomAfter.reviews.find(r => r.author_id === S).tags.length === 2, 'the chat card returns the tags as a list');

// --- 30 days ---
const P2 = (await s('posts', 'POST', sale('기간 지난 거래'))).data.id;
const chatSD = (await d('chats', 'POST', { userId: S, postId: P2 })).data.id;
equal((await d(`chats/${chatSD}/messages`, 'POST', { body: '구매 원합니다', postId: P2 })).status, 201, 'D writes to S about P2');
equal((await s(`posts/${P2}/status`, 'PATCH', { status: 'closed' })).status, 200, 'S closes P2');
const T2 = (await s(`posts/${P2}/trade`, 'POST', { partnerId: D })).data.trade;
check(T2?.id, 'S records the trade with D');
sql(`UPDATE trades SET created_at=${Date.now() - 31 * DAY} WHERE id='${T2.id}'`);
const late = await d(`trades/${T2.id}/review`, 'POST', { good: false, tags: ['잠수'] });
equal(late.status, 409, 'a 후기 more than 30 days after the trade is refused');
check(late.data.error.includes('30일'), 'the refusal names the 30 days');
equal((await guest(`users/${S}`)).data.user.tradeCount, 1, 'S still has 1 trade: the one with D was never confirmed');

// --- 제시 partners: a chat opened by 제시하기 has no post card; the accepted 제시 gives the price ---
const P3 = (await s('posts', 'POST', sale('제시 거래', 500000))).data.id;
const offerD = await d('offers', 'POST', { postId: P3, amount: 450000 });
equal(offerD.status, 201, 'D sends a 제시 on P3');
const offerC = await c('offers', 'POST', { postId: P3, amount: 400000 });
equal(offerC.status, 201, 'C sends a 제시 on P3');
equal((await s(`offers/${offerD.data.id}`, 'PATCH', { action: 'accepted' })).status, 200, 'S accepts D\'s 제시');
const p3 = (await s(`posts/${P3}/partners`)).data.partners;
equal(p3[0]?.id, D, 'the sender of the accepted 제시 comes first');
equal(p3[0]?.accepted_amount, 450000, 'with the accepted amount');
check(p3.findIndex(x => x.id === C) > 0, 'a member who sent any 제시 on the post is a partner too, after the accepted sender');
const T3 = await s(`posts/${P3}/status`, 'PATCH', { status: 'closed', partnerId: D });
equal([T3.status, T3.data.trade?.price, T3.data.chatId], [200, 450000, offerD.data.chatId], 'S completes P3 with D: the 거래가 is the accepted 제시, in the 제시 chat');

// --- 구매: the author is the buyer ---
const want = (await b('posts', 'POST', { kind: 'buy', category: 'account', title: `[QA] 후기 구매 ${run}`, body: '자동 검증', price: 200000, status: 'open', tags: [], images: [], details: { maxOwners: '3', recordPreference: '무전적' } })).data.id;
const chatBC = (await c('chats', 'POST', { userId: B, postId: want })).data.id;
equal((await c(`chats/${chatBC}/messages`, 'POST', { body: '팝니다', postId: want })).status, 201, 'C answers B\'s 구매 post');
equal((await b(`posts/${want}/status`, 'PATCH', { status: 'closed' })).status, 200, 'B closes the 구매 post');
const T4 = (await b(`posts/${want}/trade`, 'POST', { partnerId: C })).data.trade;
equal([T4?.seller_id, T4?.buyer_id], [C, B], 'on a 구매 post the partner is the seller');
equal((await c(`trades/${T4.id}/review`, 'POST', { good: true, tags: ['설명과 같음'] })).status, 201, 'C (the seller here) confirms with a 후기');
equal((await b(`trades/${T4.id}/review`, 'POST', { good: true, tags: [] })).status, 201, 'then B, the author, reviews C');

// --- Manager-only delete ---
const idB = reviewB.data.review.id;
equal((await b(`manage/reviews/${idB}`, 'DELETE')).status, 403, 'a member calling DELETE manage/reviews/:id gets 403');
equal((await s(`manage/reviews/${idB}`, 'DELETE')).status, 403, 'the reviewed member cannot delete it either');
equal((await adm(`manage/reviews/${idB}`, 'DELETE')).status, 403, 'a 관리자-grade member gets 403');
equal((await guest(`manage/reviews/${idB}`, 'DELETE')).status, 401, 'a guest gets 401');
equal((await guest(`users/${S}/reviews`)).data.total, 1, 'the 후기 is still there');
equal((await manager(`manage/reviews/${idB}`, 'DELETE')).status, 200, 'the manager deletes the 후기');
equal((await manager(`manage/reviews/${idB}`, 'DELETE')).status, 404, 'a deleted 후기 is gone (404)');
const afterDelete = (await guest(`users/${S}`)).data.user;
equal([afterDelete.goodCount, afterDelete.reviewCount, afterDelete.tradeCount], [0, 0, 1], 'S loses the 좋아요 but keeps the confirmed trade');
equal((await guest(`users/${S}/reviews`)).data.reviews.length, 0, 'the 후기 tab is empty');
equal((await b(`trades/${T.id}/review`, 'POST', { good: false, tags: ['잠수'] })).status, 409, 'B cannot write the deleted 후기 again (409)');
const removedCard = (await b(`chats/${chatSB}/messages`)).data.trades.find(t => t.id === T.id).reviews.find(r => r.author_id === B);
equal([removedCard?.removed, removedCard?.text, removedCard?.tags], [1, '', []], 'B\'s card shows the 후기 as deleted, without its content');

// --- Manager-only trade removal ---
equal((await d(`trades/${T3.data.trade.id}/review`, 'POST', { good: true, tags: ['약속 잘 지킴'] })).status, 201, 'D confirms the 제시 trade with a 후기');
equal([(await guest(`users/${S}`)).data.user.tradeCount, (await guest(`users/${S}`)).data.user.goodCount], [2, 1], 'S counts 2 trades and D\'s 좋아요');
const idT3 = T3.data.trade.id;
equal((await s(`manage/trades/${idT3}`, 'DELETE')).status, 403, 'a member removing a trade gets 403');
equal((await adm(`manage/trades/${idT3}`, 'DELETE')).status, 403, 'a 관리자-grade member gets 403');
equal((await guest(`manage/trades/${idT3}`, 'DELETE')).status, 401, 'a guest gets 401');
equal((await manager(`manage/trades/${idT3}`, 'DELETE')).status, 200, 'the manager removes the trade');
equal((await manager(`manage/trades/${idT3}`, 'DELETE')).status, 404, 'a removed trade is gone (404)');
equal([(await guest(`users/${S}`)).data.user.tradeCount, (await guest(`users/${S}`)).data.user.goodCount, (await guest(`users/${D}`)).data.user.tradeCount], [1, 0, 0], 'the trade and its 좋아요 leave both counts');
equal((await s(`trades/${idT3}/review`, 'POST', { good: true, tags: [] })).status, 404, 'a removed trade takes no 후기');
equal((await s(`posts/${P3}/trade`, 'POST', { partnerId: D })).status, 409, 'the post cannot get another trade');
check((await manager(`manage/users/${S}`)).data.trades.every(t => t.id !== idT3), 'the member panel lists the trades without the removed one');

// --- Paging: 20 per page ---
const many = Array.from({ length: 21 }, (_, i) => `('${T.id}','pg${i}_${run}','${S}',${i % 2},'[]','',${Date.now() - i * 1000})`).join(',');
sql(`INSERT INTO reviews(trade_id,author_id,target_id,good,tags,text,created_at) VALUES ${many}`);
const page1 = (await guest(`users/${S}/reviews`)).data, page2 = (await guest(`users/${S}/reviews?page=2`)).data;
equal([page1.total, page1.reviews.length, page2.reviews.length], [21, 20, 1], 'the 후기 tab pages 20 at a time');
check(page1.reviews[0].created_at >= page1.reviews[19].created_at && page2.reviews[0].created_at <= page1.reviews[19].created_at, 'newest first across pages');
sql(`DELETE FROM reviews WHERE author_id LIKE 'pg%_${run}'`);

// Deleting the post keeps the trade (no foreign key), so the count stays.
const before = (await guest(`users/${B}`)).data.user.tradeCount;
equal(before, 2, 'B has 2 trades (P as the buyer, the 구매 post)');
equal((await s(`posts/${P}`, 'DELETE')).status, 200, 'S deletes P');
equal((await guest(`users/${B}`)).data.user.tradeCount, before, 'B still counts the trade after the post is gone');

// --- Blocks: a pair where either side blocked the other cannot be named ---
const P5 = (await s('posts', 'POST', sale('차단 거래'))).data.id;
equal((await d(`chats/${chatSD}/messages`, 'POST', { body: '이 글도 문의합니다', postId: P5 })).status, 201, 'D asks about P5');
const cards = async () => (await s(`chats/${chatSD}/messages`)).data.messages.filter(m => m.type === 'review').length;
const cardsBefore = await cards();
equal((await d('blocks', 'POST', { userId: S, active: true })).status, 200, 'D blocks S');
equal((await s(`posts/${P5}/status`, 'PATCH', { status: 'closed' })).status, 200, 'S closes P5');
check(!(await s(`posts/${P5}/partners`)).data.partners.some(x => x.id === D), 'a member who blocked the author is not listed');
equal((await s(`posts/${P5}/trade`, 'POST', { partnerId: D })).status, 403, 'naming them is refused (403)');
equal(await cards(), cardsBefore, 'no new card reaches the blocked chat');

console.log(`verify-reviews: ${checks} checks passed`);
