import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Grade benefits (WP10) on the strict server: post caps and same-title rules, 끌올, 게시판 상단 노출
// and the home shelf, photo caps, the quick price change, GET me/usage, and the daily cron's
// bumped_at backfill and grade-end reminder. scripts/test-local.mjs runs it on the 8791 server,
// which has no POST_LIMITS=relaxed and receives test cron events (--test-scheduled).
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const HOUR = 3600000, DAY = 86400000;
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

// A pooled keep-alive socket can be closed by the local dev server while a suite waits on
// `wrangler d1 execute` (about 1.7 s per call). The request never reached the Worker then, so it
// is sent once more on a new connection.
async function send(url, init) {
    try { return await fetch(url, init()); }
    catch (error) {
        if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
        return fetch(url, init());
    }
}

function client() {
    let cookie = '';
    return async (path, method = 'GET', data, raw) => {
        const response = await send(base + '/api/' + path, () => ({
            method, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(raw ? { 'Content-Type': raw.type } : data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: raw ? raw.bytes : data === undefined ? undefined : JSON.stringify(data),
        }));
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
    const r = await c('auth/register', 'POST', { username: `pk_${run}_${name}`.slice(0, 24), password, nickname: `${name}${run}` });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}

async function fireCron() {
    const r = await send(base + '/cdn-cgi/handler/scheduled?cron=17+18+*+*+*', () => ({ signal: AbortSignal.timeout(60000) }));
    await r.arrayBuffer();
    return r.status;
}

// The suites before this one use most of the 40 sign-ins per 10 minutes from this address.
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%'");

const manager = client(), guest = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const grant = async (c, grade, plan = 'permanent') => equal((await manager(`manage/users/${c.user.id}/grades`, 'POST', { grade, plan })).status, 201, `manager grants ${grade} ${plan}`);

let n = 0;
const sale = (title, extra = {}) => ({ kind: 'sell', category: 'other', title, body: '자동 검증', price: 10000, status: 'open', tags: [], images: [], details: {}, ...extra });
const create = (c, extra = {}) => c('posts', 'POST', sale(`[QA] 혜택 ${run} ${++n}`, extra));
async function created(c, name, extra) {
    const r = await create(c, extra);
    assert.equal(r.status, 201, `${name}: ${JSON.stringify(r.data)}`);
    return r.data.id;
}
const setStatus = (c, id, status) => c(`posts/${id}/status`, 'PATCH', { status });
const backdate = (ids, hours) => sql(`UPDATE posts SET bumped_at=bumped_at-${hours * HOUR} WHERE id IN (${ids.join(',')})`);

// 1. Open-post and daily caps (일반: 10 and 10).
const capper = await register('cap');
for (let i = 0; i < 10; i++) await created(capper, `일반 새 글 ${i + 1}`);
check(true, '일반 creates 10 posts with distinct titles');
refused(await create(capper), 429, '10개까지입니다. 거래완료로', '11th open post is refused');
const firstOwn = (await capper(`posts?author=${capper.user.id}&size=40`)).data.posts;
equal((await setStatus(capper, firstOwn[0].id, 'closed')).status, 200, 'one post is closed');
refused(await create(capper), 429, '오늘 새 글은 10개까지입니다.', 'daily cap still refuses after closing one');

// Parallel creates cannot pass the open-post cap.
const racer = await register('race');
for (let i = 0; i < 9; i++) await created(racer, `race ${i}`);
const burst = await Promise.all([1, 2, 3].map(() => create(racer)));
equal(burst.filter(r => r.status === 201).length, 1, 'three parallel creates at 9/10 open posts: exactly one is created');
check(burst.every(r => r.status === 201 || r.status === 429), 'the others are refused with 429');
equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE author_id='${racer.user.id}'`)[0].n, 10, 'the member has exactly 10 posts');
equal(sql(`SELECT COUNT(*) AS n FROM post_seasons s JOIN posts p ON p.id=s.post_id WHERE p.author_id='${racer.user.id}'`)[0].n, 0, 'refused inserts leave no follow-up rows');

// 2. Same-title rules (플러스).
const plus = await register('plus');
await grant(plus, 'plus');
const titled = title => plus('posts', 'POST', sale(title));
const t1 = await titled('28 챌린저 계정 팝니다');
equal(t1.status, 201, 'first title is posted');
refused(await titled('28챌린저  계정팝니다!'), 409, '같은 제목의 거래중 글이 있습니다. 그 글을 끌올해 주세요.', 'same title with other spacing is refused while open');
equal((await plus('posts', 'POST', { ...sale('28 챌린저 계정 팝니다'), kind: 'buy', price: null })).status, 201, 'the same title on another tab is allowed');
equal((await setStatus(plus, t1.data.id, 'closed')).status, 200, 'first post is closed');
const t2 = await titled('28 챌린저 계정 팝니다');
equal(t2.status, 201, 'a title that only matches 거래완료 posts is allowed');
equal((await plus(`posts/${t2.data.id}`, 'DELETE')).status, 200, 'the new post is deleted');
refused(await titled('28 챌린저 계정 팝니다'), 429, '부터 다시 올릴 수 있습니다', 'reposting a deleted title right away is refused');
const kst = t => { const d = new Date(Math.ceil(t / 60000) * 60000 + 9 * HOUR); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const deletedEvent = sql(`SELECT MAX(created_at) AS t FROM post_events WHERE post_id=${t2.data.id} AND kind='post'`)[0].t;
refused(await titled('28 챌린저 계정 팝니다'), 429, `${kst(deletedEvent + 3 * HOUR)}부터`, 'the wait ends 3 hours (플러스 gap) after that post');
const managerTitle = `[QA] 매니저 ${run}`;
const m1 = await manager('posts', 'POST', sale(managerTitle)), m2 = await manager('posts', 'POST', sale(managerTitle));
check(m1.status === 201 && m2.status === 201, 'the manager has no same-title cap');
for (const r of [m1, m2]) await manager(`posts/${r.data.id}`, 'DELETE');

// 3. 끌올 (일반: 6 hours, 3 per day).
const bumper = await register('bump');
const b1 = await created(bumper, 'bump post');
refused(await bumper(`posts/${b1}/bump`, 'POST'), 429, '같은 글은 6시간마다 끌올할 수 있습니다.', 'bump right after posting waits for the 6-hour gap');
backdate([b1], 7);
const bumped = await bumper(`posts/${b1}/bump`, 'POST');
equal(bumped.status, 200, 'bump after 7 hours');
equal([bumped.data.bumpsLeft, bumped.data.bumpsPerDay], [2, 3], 'bumpsLeft 2 of 3');
check(bumped.data.nextBumpAt - bumped.data.bumpedAt === 6 * HOUR && bumped.data.resetAt > Date.now(), 'nextBumpAt and resetAt are returned');
equal((await guest('posts?kind=sell')).data.posts[0].id, b1, 'the bumped post is first in 최신순');
const afterBump = (await guest('posts/' + b1)).data.post;
check(afterBump.bump_count === 1 && afterBump.bumped_at > afterBump.created_at, 'bump_count and bumped_at are returned; created_at is kept');
refused(await bumper(`posts/${b1}/bump`, 'POST'), 429, '(', 'bumping again waits for the gap');
const other = await register('other');
equal((await other(`posts/${b1}/bump`, 'POST')).status, 403, 'another member cannot bump');
equal((await manager(`posts/${b1}/bump`, 'POST')).status, 403, 'the manager cannot bump a member post');
equal((await setStatus(bumper, b1, 'closed')).status, 200, 'post is closed');
refused(await bumper(`posts/${b1}/bump`, 'POST'), 409, '거래중인 글만 끌올할 수 있습니다.', 'a closed post cannot be bumped');
const daily = await register('daily');
const four = [];
for (let i = 0; i < 4; i++) four.push(await created(daily, 'daily bump post'));
backdate(four, 7);
for (let i = 0; i < 3; i++) equal((await daily(`posts/${four[i]}/bump`, 'POST')).data.bumpsLeft, 2 - i, `bump ${i + 1} of 3`);
refused(await daily(`posts/${four[3]}/bump`, 'POST'), 429, '오늘 끌올 3번을 모두 썼습니다. 자정에 초기화됩니다.', 'the 4th bump of the day is refused');
equal((await daily(`posts/${four[3]}`, 'PUT', sale('수정한 제목 ' + run))).status, 200, 'editing is allowed');
equal(sql(`SELECT bumped_at<${Date.now() - 6 * HOUR} AS old FROM posts WHERE id=${four[3]}`)[0].old, 1, 'editing never bumps');

// 대리(진행) needs 대리 인증 to bump.
const proxy = await register('proxy');
equal((await manager(`manage/users/${proxy.user.id}/badges`, 'POST', { badge: 'proxy', active: true })).status, 200, 'proxy member gets 대리 인증');
const proxyPost = await proxy('posts', 'POST', { kind: 'proxy_offer', category: 'ladder', title: `[QA] 대리 ${run}`, body: '자동 검증', price: 10000, status: 'open', tags: [], images: [], details: {} });
equal(proxyPost.status, 201, '대리(진행) post is created');
equal((await manager(`manage/users/${proxy.user.id}/badges`, 'POST', { badge: 'proxy', active: false })).status, 200, '대리 인증 is removed');
backdate([proxyPost.data.id], 7);
equal((await proxy(`posts/${proxyPost.data.id}/bump`, 'POST')).status, 403, 'a 대리(진행) post cannot be bumped without 대리 인증');

// 4. 게시판 상단 노출 and the home shelf.
const plain = await register('plain');
const plainPost = await created(plain, 'plain post');
refused(await plain(`posts/${plainPost}/feature`, 'PUT', { active: true }), 403, '게시판 상단 노출은 프리미엄부터 가능합니다.', '일반 cannot feature');
const premium = await register('prem');
await grant(premium, 'premium');
const A = await created(premium, 'premium A');
const B = await premium('posts', 'POST', sale(`[QA] 혜택 ${run} B${run}`)).then(r => r.data.id);
const fa = await premium(`posts/${A}/feature`, 'PUT', { active: true });
equal([fa.status, fa.data.featured, fa.data.slots, fa.data.used, fa.data.replaced], [200, true, 1, 1, null], 'premium features A');
const fb = await premium(`posts/${B}/feature`, 'PUT', { active: true });
equal([fb.status, fb.data.replaced?.id, fb.data.used], [200, A, 1], 'featuring B replaces A');
equal((await guest('posts/' + A)).data.post.featured, false, 'A is no longer featured');
const board = (await guest(`posts?kind=sell&q=${run}`)).data;
equal(board.featured.map(p => p.id), [B], 'board page 1 featured box holds B');
check(board.posts.some(p => p.id === B), 'B stays in the normal list');
check(!('featured' in (await guest(`posts?kind=sell&q=${run}&page=2`)).data), 'no featured box on page 2');
check(!('featured' in (await guest(`posts?kind=sell&q=${run}&sort=price-low`)).data), 'no featured box when sorted by price');
check(!('featured' in (await guest(`posts?q=${run}`)).data), 'no featured box without a tab');
const reserved = await premium(`posts/${A}/feature`, 'PUT', { active: false });
equal(reserved.status, 200, 'turning a feature off is allowed');
const elite = await register('elite');
await grant(elite, 'elite');
const E = [];
for (let i = 0; i < 3; i++) {
    E.push(await created(elite, `elite ${i}`));
    equal((await elite(`posts/${E[i]}/feature`, 'PUT', { active: true })).data.replaced, null, `elite features post ${i + 1} of 3 without replacing`);
}
equal((await guest(`posts?kind=sell&q=${run}`)).data.featured.map(p => p.id).sort(), [...E].sort(), 'featured box holds the 3 elite posts (at most 3)');
const home = (await guest('posts?featured=home&size=6')).data.posts.map(p => p.id);
check(E.every(id => home.includes(id)) && !home.includes(B), 'home shelf has the elite posts and not the premium one');
check(home.length <= 6, 'home shelf holds at most 6');
equal((await guest(`posts?kind=sell&q=B${run}`)).data.featured.map(p => p.id), [B], 'B is featured before its bump gets old');
backdate([B], 73);
equal((await guest(`posts?kind=sell&q=B${run}`)).data.featured, [], 'B leaves the box 72 hours after its last bump');
equal((await setStatus(elite, E[0], 'reserved')).status, 200, 'an elite post is reserved');
check(!(await guest(`posts?kind=sell&q=${run}`)).data.featured.some(p => p.id === E[0]), 'a 예약중 post drops out of the box');
equal((await setStatus(elite, E[0], 'closed')).status, 200, 'the featured post is closed');
equal(sql(`SELECT featured_at FROM posts WHERE id=${E[0]}`)[0].featured_at, null, 'closing clears featured_at');
refused(await elite(`posts/${E[0]}/feature`, 'PUT', { active: true }), 409, '거래중인 글만 상단에 노출할 수 있습니다.', 'a closed post cannot be featured');
const editClosed = await elite(`posts/${E[1]}`, 'PUT', sale('elite closed by edit ' + run, { status: 'closed' }));
equal(editClosed.status, 200, 'closing through the editor');
equal(sql(`SELECT featured_at FROM posts WHERE id=${E[1]}`)[0].featured_at, null, 'closing through the editor clears featured_at');

// 5. Photos per post (일반 6, 플러스 8); edits keep photos after a grade ends.
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const photos = async (c, count) => { const ids = []; for (let i = 0; i < count; i++) ids.push((await c('uploads', 'POST', undefined, { type: 'image/png', bytes: png })).data.id); return ids; };
const plainPhotos = await photos(plain, 7);
refused(await create(plain, { images: plainPhotos }), 400, '사진은 한 글에 6장까지입니다.', '일반 post with 7 photos');
const photoPlus = await register('photo');
await grant(photoPlus, 'plus');
const plusPhotos = await photos(photoPlus, 9);
const seven = await create(photoPlus, { images: plusPhotos.slice(0, 7) });
equal(seven.status, 201, '플러스 post with 7 photos');
refused(await create(photoPlus, { images: plusPhotos }), 400, '사진은 한 글에 8장까지입니다.', '플러스 post with 9 photos');
const grantRow = (await manager('manage/users/' + photoPlus.user.id)).data.grants.find(g => g.grade === 'plus');
equal((await manager(`manage/users/${photoPlus.user.id}/grades/${grantRow.id}`, 'DELETE')).status, 200, 'manager revokes 플러스');
equal((await photoPlus('posts/' + seven.data.id, 'PUT', sale('photo edit ' + run, { images: plusPhotos.slice(0, 7) }))).status, 200, 'the 7-photo post can still be edited as 일반');

// 6. Quick price change (판매).
const seller = await register('sell');
const sp = await created(seller, 'price post', { price: 500000 });
const bumpedBefore = sql(`SELECT bumped_at FROM posts WHERE id=${sp}`)[0].bumped_at;
const cut = await seller(`posts/${sp}/price`, 'PATCH', { price: 400000 });
equal([cut.status, cut.data.post.price, cut.data.post.price_history.map(h => h.price)], [200, 400000, [500000]], 'price 500000 to 400000 keeps 500000 in price_history');
equal(sql(`SELECT bumped_at FROM posts WHERE id=${sp}`)[0].bumped_at, bumpedBefore, 'a price change never bumps');
refused(await seller(`posts/${sp}/price`, 'PATCH', { currentOffer: 450000 }), 400, '현젯은 즉거가보다 낮게 입력해 주세요.', '현젯 at or above 즉거가');
refused(await seller(`posts/${sp}/price`, 'PATCH', { price: 999 }), 400, '1,000원', '즉거가 below 1,000원');
const offer = await seller(`posts/${sp}/price`, 'PATCH', { currentOffer: 300000 });
equal([offer.status, offer.data.post.details.currentOffer], [200, '300000'], '현젯 is set');
refused(await seller(`posts/${sp}/price`, 'PATCH', { price: 250000 }), 400, '현젯은 즉거가보다 낮게', '즉거가 at or below the current 현젯');
const cleared = await seller(`posts/${sp}/price`, 'PATCH', { currentOffer: '' });
equal([cleared.status, 'currentOffer' in cleared.data.post.details], [200, false], '현젯 is removed');
equal((await other(`posts/${sp}/price`, 'PATCH', { price: 300000 })).status, 403, 'another member cannot change the price');
equal((await plain(`posts/${plainPost}/price`, 'PATCH', { price: 1 })).status, 400, 'the price of a non-sale post is refused');
const buyPost = (await plain('posts', 'POST', { ...sale('buy ' + run), kind: 'buy', price: 300000 })).data.id;
refused(await plain(`posts/${buyPost}/price`, 'PATCH', { price: 200000 }), 400, '판매 글만', 'only 판매 posts have a quick price change');

// 7. GET me/usage.
const usage = (await daily('me/usage')).data;
equal([usage.grade, usage.bumpsToday, usage.bumpsLeft, usage.openPosts, usage.postsToday], ['normal', 3, 0, 4, 4], 'usage counts for 일반');
equal(usage.perks, { bumpsPerDay: 3, bumpGapHours: 6, openPosts: 10, postsPerDay: 10, photos: 6, boardSlots: 0, homeShelf: false }, '일반 perks');
check(usage.resetAt > Date.now() && usage.resetAt - Date.now() <= DAY, 'resetAt is the next KST midnight');
const premiumUsage = (await premium('me/usage')).data;
equal([premiumUsage.grade, premiumUsage.perks.boardSlots, premiumUsage.perks.photos, premiumUsage.featured.map(f => f.id)], ['premium', 1, 10, [B]], 'premium perks and featured list');
const managerUsage = (await manager('me/usage')).data;
equal([managerUsage.perks.bumpsPerDay, managerUsage.perks.openPosts, managerUsage.bumpsLeft], [null, null, null], 'the manager has no caps (null)');
equal((await guest('me/usage')).status, 401, 'usage needs a login');

// 8. Cron: bumped_at and title_key backfill, and old post events.
const legacy = await created(seller, 'legacy post');
sql(`UPDATE posts SET bumped_at=0,title_key='' WHERE id=${legacy}`);
sql(`INSERT INTO post_events(user_id,post_id,kind,title_key,created_at) VALUES('${seller.user.id}',NULL,'post','old-${run}',${Date.now() - 3 * DAY})`);

// 9. Grade-end reminder 7 days before, once; a member who blocked the manager does not stop it.
const reminded = await register('remind');
await grant(reminded, 'premium', '6m');
const endsAt = Date.now() + 3 * DAY;
sql(`UPDATE user_grades SET expires_at=${endsAt} WHERE user_id='${reminded.user.id}'`);
const blocker = await register('blocker');
await grant(blocker, 'premium', '6m');
sql(`UPDATE user_grades SET expires_at=${endsAt} WHERE user_id='${blocker.user.id}'`);
equal((await blocker('blocks', 'POST', { userId: 'manager', active: true })).status, 200, 'a member blocks the manager');
equal((await blocker('blocks')).data.blocks.map(b => b.target_id), ['manager'], 'the block is stored');

equal(await fireCron(), 200, 'the daily cron runs');
const legacyRow = sql(`SELECT bumped_at,created_at,title_key FROM posts WHERE id=${legacy}`)[0];
equal(legacyRow.bumped_at, legacyRow.created_at, 'cron sets bumped_at=created_at');
check(legacyRow.title_key.length > 0, 'cron fills in the same-title key');
equal(sql(`SELECT COUNT(*) AS n FROM post_events WHERE title_key='old-${run}'`)[0].n, 0, 'cron removes post events older than 2 days');
const managerChat = async c => (await c('chats')).data.chats.find(x => x.partner_id === 'manager');
const reminders = async c => { const chat = await managerChat(c); return chat ? (await c(`chats/${chat.id}/messages`)).data.messages.filter(m => m.type === 'system' && m.body.includes('끝납니다')) : []; };
const endDay = new Date(endsAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });
equal((await reminders(reminded)).map(m => m.body), [`프리미엄 등급이 ${endDay}에 끝납니다. 연장은 인증/등급 신청에서 6개월을 다시 신청해 주세요.`], 'the member gets the grade-end message');
check(sql(`SELECT reminded_at FROM user_grades WHERE user_id='${blocker.user.id}'`)[0].reminded_at > 0, 'a member who blocked the manager is marked anyway');
equal((await reminders(blocker)).length, 0, 'and gets no message');
equal(await fireCron(), 200, 'the cron runs again');
equal((await reminders(reminded)).length, 1, 'a second run sends no duplicate');

console.log(`\n${checks} grade benefit checks passed`);
