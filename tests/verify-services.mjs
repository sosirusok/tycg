import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 중개·가측 신청 (WP65): free coupons per KST month shared between the two kinds (플러스 1, 프리미엄 5,
// 엘리트 무제한, 체험 0, 일반 0), a request without one is taken as 유료, a cancelled one gives its coupon
// back, one open request per kind, the month key resetting the count, the manager's 완료 / 취소 (role
// manager only), the 운영진 가측가 on the post until the next edit, 운영진 중개 on the trade record, the
// manager list by grade priority, and the lines in the member's chat with the manager.
// Runs only against a local Worker (see scripts/test-local.mjs, 8790).
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const DAY = 86400000, KST = 9 * 3600000;
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }
function refused(r, status, text, name) {
    assert.equal(r.status, status, `${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    assert.ok(String(r.data.error || '').includes(text), `${name}: ${r.data.error}`);
    checks++;
    console.log(`PASS ${name} (${r.data.error})`);
}

function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
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
    const r = await c('auth/register', 'POST', { username: `sv_${run}_${name}`.slice(0, 24), password, nickname: `중개${name}${run}` });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}

sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%'");
const manager = client(), guest = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const grant = async (c, grade) => equal((await manager(`manage/users/${c.user.id}/grades`, 'POST', { grade, plan: 'permanent' })).status, 201, `manager grants ${grade}`);

let n = 0;
const sale = (extra = {}) => ({ kind: 'sell', category: 'account', title: `[QA] 가측 ${run} ${++n}`, body: '자동 검증', price: 150000, accepts_offers: true, status: 'open', tags: [], images: [], details: {}, ...extra });
async function post(c, extra) {
    const body = sale(extra);
    const r = await c('posts', 'POST', body);
    assert.equal(r.status, 201, `post: ${JSON.stringify(r.data)}`);
    return { id: r.data.id, body };
}
const appraise = (c, postId, note) => c('services', 'POST', { kind: 'appraise', postId, ...note === undefined ? {} : { note } });
const done = (id, price) => manager(`manage/services/${id}`, 'PATCH', { action: 'done', ...price === undefined ? {} : { price } });
const cancel = id => manager(`manage/services/${id}`, 'PATCH', { action: 'cancel' });
const coupons = async c => (await c('services/me')).data.coupons;
const managerLines = async c => {
    const chat = (await c('chats')).data.chats.find(x => x.partner_id === 'manager');
    return chat ? (await c(`chats/${chat.id}/messages`)).data.messages.filter(m => m.type === 'system').map(m => m.body) : [];
};
const lastLine = async c => (await managerLines(c)).at(-1);
const kstMonthOf = t => new Date(t + KST).toISOString().slice(0, 7);
const now = Date.now(), month = kstMonthOf(now);
const nextMonth = (() => { const d = new Date(now + KST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - KST; })();
const lastMonth = (() => { const d = new Date(now + KST); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15)).toISOString().slice(0, 7); })();

// 1. 플러스: one free request a month, then 유료.
const plus = await register('p');
await grant(plus, 'plus');
const A = await post(plus);
equal(await coupons(plus), { limit: 1, used: 0, left: 1, resetsAt: nextMonth }, 'plus: 1 free request this month, reset on the next 1st 00:00 KST');
equal((await plus('me/usage')).data.coupons, { limit: 1, used: 0, left: 1, resetsAt: nextMonth }, 'me/usage carries the same coupons object');
equal((await plus('me/usage')).data.perks.serviceCoupons, 1, 'usage.perks.serviceCoupons is 1 for 플러스');
const r1 = await appraise(plus, A.id, '급처 예정');
equal([r1.status, r1.data.request.coupon, r1.data.request.status, r1.data.request.month, r1.data.coupons.left], [201, 1, 'open', month, 0], 'plus: the first 가측 신청 uses the coupon');
equal(await lastLine(plus), `[가측 신청] ${A.body.title}\n무료 쿠폰 사용 (이번 달 1/1)\n메모: 급처 예정`, 'the request leaves a line in the manager chat');
refused(await appraise(plus, A.id), 409, '진행 중인 가측 신청이 있습니다.', 'a second open 가측 신청 is refused');
const managerChat = (await manager('chats')).data.chats.find(x => x.partner_id === plus.user.id);
check(managerChat && managerChat.unread > 0, 'the manager has the request unread');

// The manager list and decision.
const list = (await manager('manage/services?status=open')).data.requests;
const row = list.find(x => x.id === r1.data.request.id);
check(row && row.kind === 'appraise' && row.post_title === A.body.title && row.coupon === 1 && row.priority === 3 && row.nickname === plus.user.nickname && row.conversation_id, 'the manager list shows the request with grade priority 3');
refused(await done(r1.data.request.id), 400, '가측가는 1,000원~1억 원의 정수로 입력해 주세요.', '가측 완료 needs a price');
refused(await done(r1.data.request.id, 500), 400, '가측가', 'a price under 1,000원 is refused');
refused(await done(r1.data.request.id, 100000001), 400, '가측가', 'a price over 1억 is refused');
equal((await done(r1.data.request.id, 120000)).status, 200, 'the manager completes the 가측 at 12만원');
refused(await done(r1.data.request.id, 120000), 409, '이미 처리된 신청입니다.', 'a decided request cannot be decided again');
equal(await lastLine(plus), '가측 완료: 12만원', 'the member gets 가측 완료: 12만원');
const shown = (await guest(`posts/${A.id}`)).data.post;
equal(shown.appraised?.price, 120000, 'the post shows the 운영진 가측가');
check(!('appraised_price' in shown), 'others never see the raw columns');
const card = (await guest(`posts?author=${plus.user.id}`)).data.posts.find(p => p.id === A.id);
equal(card?.appraised?.price, 120000, 'the list card carries the 가측가 too');
equal(await coupons(plus), { limit: 1, used: 1, left: 0, resetsAt: nextMonth }, 'the done request keeps its coupon used');

// The second request of the month is 유료; cancelling it says nothing about a coupon.
const r2 = await appraise(plus, A.id);
equal([r2.status, r2.data.request.coupon], [201, 0], 'plus: the second request this month is 유료 (coupon 0)');
equal(await lastLine(plus), `[가측 신청] ${A.body.title}\n유료 (수수료는 매니저가 안내)`, 'the line says 유료');
equal((await cancel(r2.data.request.id)).status, 200, 'the manager cancels the 유료 request');
equal(await lastLine(plus), '신청 취소', 'a 유료 cancel line names no coupon');

// Editing the post hides the 가측가 (the manager still sees the stored value).
equal((await plus(`posts/${A.id}`, 'PUT', { ...A.body, body: '자동 검증 수정' })).status, 200, 'the member edits the appraised post');
equal((await guest(`posts/${A.id}`)).data.post.appraised, null, 'after the edit the 가측가 is not shown');
const managerView = (await manager(`posts/${A.id}`)).data.post;
equal([managerView.appraised, managerView.appraised_price], [null, 120000], 'the manager still sees the stored 가측가');

// Month rollover: last month's requests no longer count.
sql(`UPDATE service_requests SET month='${lastMonth}' WHERE user_id='${plus.user.id}'`);
equal((await coupons(plus)).left, 1, 'with the requests moved to last month the coupon is back');
const r3 = await appraise(plus, A.id);
equal(r3.data.request.coupon, 1, 'the next request uses this month\'s coupon');
equal((await cancel(r3.data.request.id)).status, 200, 'the manager cancels it');
equal(await lastLine(plus), '신청 취소: 무료 쿠폰을 돌려드렸습니다.', 'the cancel line says the coupon came back');
equal((await coupons(plus)).left, 1, 'the cancelled request gave its coupon back');

// 2. 프리미엄: 5 a month, then 유료.
const prem = await register('r');
await grant(prem, 'premium');
const B = await post(prem);
for (let i = 1; i <= 5; i++) {
    const r = await appraise(prem, B.id);
    equal([r.status, r.data.request.coupon], [201, 1], `premium: request ${i} uses a coupon`);
    if (i === 2) equal(await lastLine(prem), `[가측 신청] ${B.body.title}\n무료 쿠폰 사용 (이번 달 2/5)`, 'the line counts 2/5');
    equal((await done(r.data.request.id, 100000 + i * 1000)).status, 200, `premium: request ${i} done`);
}
equal(await coupons(prem), { limit: 5, used: 5, left: 0, resetsAt: nextMonth }, 'premium: 5/5 used');
const r6 = await appraise(prem, B.id);
equal(r6.data.request.coupon, 0, 'premium: the 6th request is 유료');
equal((await cancel(r6.data.request.id)).status, 200, 'the 유료 request is cancelled');
equal((await guest(`posts/${B.id}`)).data.post.appraised.price, 105000, 'the post shows the latest 가측가');

// 3. 엘리트: 12 in a row, all free. 10 requests a day per member is the rate limit.
const elite = await register('e');
await grant(elite, 'elite');
const E = await post(elite);
equal(await coupons(elite), { limit: null, used: 0, left: null, resetsAt: nextMonth }, 'elite: 무제한 (null)');
let eliteFree = 0;
for (let i = 1; i <= 12; i++) {
    if (i === 11) {
        refused(await appraise(elite, E.id), 429, '요청이 많습니다.', 'the 11th request in a day hits the rate limit');
        sql(`DELETE FROM rate_limits WHERE key='service:${elite.user.id}'`);
    }
    const r = await appraise(elite, E.id);
    assert.equal(r.status, 201, `elite request ${i}: ${JSON.stringify(r.data)}`);
    if (r.data.request.coupon === 1) eliteFree++;
    if (i === 1) equal(await lastLine(elite), `[가측 신청] ${E.body.title}\n무료 쿠폰 사용 (무제한)`, 'the elite line says 무제한');
    assert.equal((await done(r.data.request.id, 200000)).status, 200);
}
equal(eliteFree, 12, 'elite: 12 requests in a row, all free');
equal((await coupons(elite)).used, 12, 'elite: 12 used, still unlimited');

// 4. 일반 and the 플러스 체험: no free requests, still allowed as 유료.
const normal = await register('n');
const N = await post(normal);
equal(await coupons(normal), { limit: 0, used: 0, left: 0, resetsAt: nextMonth }, 'normal: no free requests');
const rn = await appraise(normal, N.id);
equal([rn.status, rn.data.request.coupon], [201, 0], 'normal: a request is 유료');

sql(`INSERT INTO settings(key,value,updated_at) VALUES('sys:trial_start','${Date.now() - 60000}',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
equal((await manager('manage/trial', 'PUT', { end: Date.now() + DAY })).status, 200, 'the trial window opens for one sign-up');
const trial = await register('t');
equal((await manager('manage/trial', 'PUT', { close: true })).status, 200, 'the window closes again');
sql("UPDATE settings SET value='-1' WHERE key='sys:trial_end'");
sql("DELETE FROM rate_limits WHERE key LIKE 'trial-ip:%'");
equal([trial.user.grade, trial.user.grade_trial], ['plus', true], 'the trial member is 플러스 체험');
equal(await coupons(trial), { limit: 0, used: 0, left: 0, resetsAt: nextMonth }, 'trial: no free requests');
equal((await trial('me/usage')).data.perks.serviceCoupons, 0, 'trial: usage.perks.serviceCoupons is 0');
const T = await post(trial);
const rt = await appraise(trial, T.id);
equal([rt.status, rt.data.request.coupon], [201, 0], 'trial: a request is 유료');

// 5. Validation.
const buyPost = (await normal('posts', 'POST', { ...sale(), kind: 'buy', price: 100000 })).data.id;
refused(await normal('services', 'POST', { kind: 'appraise', postId: buyPost }), 400, '가측은 판매·교환 계정 글만', '가측 on a 구매 post is refused');
refused(await normal('services', 'POST', { kind: 'appraise', postId: A.id }), 403, '가측은 내 글만', '가측 on another member\'s post is refused');
refused(await normal('services', 'POST', { kind: 'lend', postId: N.id }), 400, '신청 종류', 'an unknown kind is refused');
refused(await prem('services', 'POST', { kind: 'appraise', postId: B.id, note: 'x'.repeat(201) }), 400, '메모: 200자', 'a note over 200 characters is refused');
refused(await manager('services', 'POST', { kind: 'appraise', postId: B.id }), 400, '매니저 계정은 신청할 수 없습니다.', 'the manager cannot request');
equal((await guest('services/me')).status, 401, 'services/me needs a login');

// 6. Only role manager decides; a 관리자-grade member gets 403.
const adm = await register('m');
await grant(adm, 'admin');
equal(await coupons(adm), { limit: null, used: 0, left: null, resetsAt: nextMonth }, '관리자 grade: 무제한 like 엘리트');
equal((await adm(`manage/services/${rn.data.request.id}`, 'PATCH', { action: 'done' })).status, 403, '관리자-grade member PATCH manage/services is refused (403)');
equal((await adm('manage/services?status=open')).status, 403, '관리자-grade member GET manage/services is refused (403)');
equal((await normal(`manage/services/${rn.data.request.id}`, 'PATCH', { action: 'cancel' })).status, 403, 'a member cannot cancel through manage (403)');

// 7. Priority: 엘리트·관리자 1, 프리미엄 2, 플러스 3, 일반·체험 4, then oldest first.
const re = await appraise(elite, E.id), rp = await appraise(prem, B.id), rplus = await appraise(plus, A.id);
const ours = new Set([re, rp, rplus, rn, rt].map(r => r.data.request.id));
const ordered = (await manager('manage/services?status=open')).data.requests.filter(x => ours.has(x.id));
equal(ordered.map(x => [x.id, x.priority]), [[re.data.request.id, 1], [rp.data.request.id, 2], [rplus.data.request.id, 3], [rn.data.request.id, 4], [rt.data.request.id, 4]], 'open requests come by grade priority, then oldest first (체험 = 4순위)');
equal((await manager('manage')).data.openServices >= 5, true, 'the manage summary counts open requests');
for (const id of ours) equal((await cancel(id)).status, 200, `request ${id} cancelled`);

// 8. 중개: the post author and a member who chats with them. Done before the trade record: the later
// record is marked; done after it: the existing record is marked. The trade count is unchanged.
const seller = await register('s'), buyer = await register('b'), stranger = await register('x');
const S1 = await post(seller);
const chat = (await buyer('chats', 'POST', { userId: seller.user.id, postId: S1.id })).data.id;
equal((await buyer(`chats/${chat}/messages`, 'POST', { body: '중개 거래 원합니다', postId: S1.id })).status, 201, 'the buyer asks about the post');
refused(await stranger('services', 'POST', { kind: 'broker', postId: S1.id, partnerNickname: seller.user.nickname }), 409, '거래 상대와의 채팅이 없습니다.', 'a member without a chat with the author is refused');
refused(await buyer('services', 'POST', { kind: 'broker', postId: S1.id, partnerNickname: stranger.user.nickname }), 400, '작성자와의 거래만', 'a partner who is not the author is refused');
refused(await buyer('services', 'POST', { kind: 'broker', postId: S1.id }), 400, '거래 상대를 확인해 주세요.', 'a 중개 신청 needs a partner');
const rb = await buyer('services', 'POST', { kind: 'broker', postId: S1.id, partnerNickname: seller.user.nickname, note: '오늘 저녁' });
equal([rb.status, rb.data.request.kind, rb.data.request.partner_id, rb.data.request.coupon], [201, 'broker', seller.user.id, 0], 'the buyer asks for 중개 with the seller (유료 for 일반)');
equal(await lastLine(buyer), `[중개 신청] ${S1.body.title} · 상대 ${seller.user.nickname}\n유료 (수수료는 매니저가 안내)\n메모: 오늘 저녁`, 'the 중개 line names the partner');
refused(await buyer('services', 'POST', { kind: 'broker', postId: S1.id, partnerId: seller.user.id }), 409, '진행 중인 중개 신청이 있습니다.', 'a second open 중개 신청 is refused');
equal((await done(rb.data.request.id)).status, 200, 'the manager completes the 중개');
equal(await lastLine(buyer), '중개 완료', 'the member gets 중개 완료');
equal((await seller(`posts/${S1.id}/status`, 'PATCH', { status: 'closed', partnerId: buyer.user.id })).status, 200, 'the seller completes the post with the buyer');
equal(sql(`SELECT brokered FROM trades WHERE post_id=${S1.id}`)[0]?.brokered, 1, 'the trade record written after 중개 완료 is brokered=1');
const panel = (await manager(`manage/users/${seller.user.id}`)).data;
equal(panel.trades.find(t => t.post_id === S1.id)?.brokered, 1, 'the member panel trade row carries brokered');

// The other order: the trade record exists before the manager completes the 중개.
const S2 = await post(seller);
const chat2 = (await buyer('chats', 'POST', { userId: seller.user.id, postId: S2.id })).data.id;
equal((await buyer(`chats/${chat2}/messages`, 'POST', { body: '이것도 중개로', postId: S2.id })).status, 201, 'the buyer asks about the second post');
const rb2 = await seller('services', 'POST', { kind: 'broker', postId: S2.id, partnerId: buyer.user.id });
equal([rb2.status, rb2.data.request.partner_id], [201, buyer.user.id], 'the seller (the author) asks for 중개 naming the buyer');
equal((await seller(`posts/${S2.id}/status`, 'PATCH', { status: 'closed', partnerId: buyer.user.id })).status, 200, 'the seller completes the second post first');
equal(sql(`SELECT brokered FROM trades WHERE post_id=${S2.id}`)[0]?.brokered, 0, 'the record is not brokered yet');
refused(await seller('services', 'POST', { kind: 'appraise', postId: S2.id }), 409, '진행중인 글만', 'a completed post takes no new request');
equal((await done(rb2.data.request.id)).status, 200, 'the manager completes the 중개 afterwards');
equal(sql(`SELECT brokered FROM trades WHERE post_id=${S2.id}`)[0]?.brokered, 1, 'the existing record becomes brokered=1');
equal(sql(`SELECT COUNT(*) AS n FROM service_requests WHERE status='open' AND user_id IN ('${seller.user.id}','${buyer.user.id}')`)[0].n, 0, 'no open requests remain for the pair');

// A decided request stays decided, even through SQL (trigger).
let aborted = false;
try { sql(`UPDATE service_requests SET status='open' WHERE id=${rb.data.request.id}`); } catch { aborted = true; }
check(aborted, 'the service_requests_final trigger refuses reopening a decided request');

console.log(`\n${checks} 중개·가측 checks passed`);
