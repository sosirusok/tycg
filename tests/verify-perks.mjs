import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Grade benefits on the strict server: the cafe ceilings every member shares (SITE_RULES: open posts,
// posts per day, photos, uploads) and same-title rules, the 끌올 지갑 (WP40: wallet, refill, same-post
// gap, 새 글 우선, grant fill, races), 게시판 상단 노출 and the home shelf, the quick price change,
// GET me/usage, and the daily cron's bumped_at backfill and grade-end reminder. scripts/test-local.mjs runs it on the 8791 server,
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

// 1. Anti-flood ceilings, the same for every member: 100 open posts, 30 new posts a day.
const capper = await register('cap');
for (let i = 0; i < 11; i++) await created(capper, `일반 새 글 ${i + 1}`);
check(true, '일반 creates 11 open posts (the round-2 cap of 10 is gone)');
const now0 = Date.now();
sql(`INSERT INTO post_events(user_id,post_id,kind,title_key,created_at) SELECT '${capper.user.id}',NULL,'post','seed-${run}-'||value,${now0} FROM json_each('${JSON.stringify(Array.from({ length: 18 }, (_, i) => i))}')`);
equal((await capper('me/usage')).data.postsToday, 29, '29 new posts today (11 written, 18 seeded)');
equal((await create(capper)).status, 201, 'the 30th new post of the day is created');
refused(await create(capper), 429, '도배 방지: 오늘 새 글은 30개까지입니다.', 'the 31st new post of the day is refused');

// 100 open posts (hidden included); parallel creates cannot pass the ceiling.
const seedOpen = (c, count) => sql(`INSERT INTO posts(author_id,kind,title,body,price,status,category,created_at,updated_at,bumped_at,title_key)
    SELECT '${c.user.id}','sell','seed '||value,'자동 검증',10000,'open','other',${Date.now()},${Date.now()},${Date.now()},'seed${run}'||value FROM json_each('${JSON.stringify(Array.from({ length: count }, (_, i) => i))}')`);
const racer = await register('race');
seedOpen(racer, 99);
const burst = await Promise.all([1, 2, 3].map(() => create(racer)));
equal(burst.filter(r => r.status === 201).length, 1, 'three parallel creates at 99/100 open posts: exactly one is created');
check(burst.every(r => r.status === 201 || r.status === 429), 'the others are refused with 429');
equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE author_id='${racer.user.id}'`)[0].n, 100, 'the member has exactly 100 posts');
equal(sql(`SELECT COUNT(*) AS n FROM post_seasons s JOIN posts p ON p.id=s.post_id WHERE p.author_id='${racer.user.id}'`)[0].n, 0, 'refused inserts leave no follow-up rows');
refused(await create(racer), 429, '도배 방지: 거래중 글은 100개까지입니다. 거래완료로 바꾸거나 삭제해 주세요.', 'the 101st open post is refused');
const racerOwn = (await racer(`posts?author=${racer.user.id}&size=1`)).data.posts;
equal((await setStatus(racer, racerOwn[0].id, 'closed')).status, 200, 'one post is closed');
equal((await create(racer)).status, 201, 'closing one frees a place');

// 2. Same-title rules (플러스).
const plus = await register('plus');
await grant(plus, 'plus');
const titled = title => plus('posts', 'POST', sale(title));
const t1 = await titled('28 챌린저 계정 팝니다');
equal(t1.status, 201, 'first title is posted');
refused(await titled('28챌린저  계정팝니다!'), 409, '같은 제목의 거래중 글이 있습니다. 그 글을 끌올해 주세요.', 'same title with other spacing is refused while open');
equal((await plus('posts', 'POST', { ...sale('28 챌린저 계정 팝니다'), kind: 'buy', price: null })).status, 201, 'the same title on another tab is allowed');
equal((await setStatus(plus, t1.data.id, 'closed')).status, 200, 'first post is closed');
// 같은 매물 (WP44): a listing completed or deleted within 7 days is never refused; inside its 끌올 gap the
// repost goes back to the old place (the round-2 deleted-title wait is gone).
const t2 = await titled('28 챌린저 계정 팝니다');
equal([t2.status, t2.data.placed, t2.data.relist], [201, 'old', true], 'a title that only matches 거래완료 posts is a relist at the old place');
equal(t2.data.bumpedAt, sql(`SELECT created_at FROM posts WHERE id=${t1.data.id}`)[0].created_at, 'the old place is the completed post\'s place');
equal((await plus(`posts/${t2.data.id}`, 'DELETE')).status, 200, 'the new post is deleted');
const t3 = await titled('28 챌린저 계정 팝니다');
equal([t3.status, t3.data.placed, t3.data.bumpedAt], [201, 'old', t2.data.bumpedAt], 'reposting a deleted title right away goes back to the same place');
const kst = t => { const d = new Date(Math.ceil(t / 60000) * 60000 + 9 * HOUR); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
equal(t3.data.bumpAt, t2.data.bumpedAt + 3 * HOUR, 'it can be bumped 3 hours (플러스 gap) after that place');
await plus(`posts/${t3.data.id}`, 'DELETE');
const managerTitle = `[QA] 매니저 ${run}`;
const m1 = await manager('posts', 'POST', sale(managerTitle)), m2 = await manager('posts', 'POST', sale(managerTitle));
check(m1.status === 201 && m2.status === 201, 'the manager has no same-title cap');
for (const r of [m1, m2]) await manager(`posts/${r.data.id}`, 'DELETE');

// 3. 끌올 지갑 (일반: 3 held, 1 more every 6 hours, the same post every 6 hours).
// age(): moves a post's created_at and bumped_at back, as if it was written `hours` ago.
const age = (ids, hours) => sql(`UPDATE posts SET created_at=created_at-${Math.round(hours * HOUR)},bumped_at=bumped_at-${Math.round(hours * HOUR)} WHERE id IN (${ids.join(',')})`);
const wallet = async c => { const d = (await c('me/usage')).data; return { tokens: d.bumpTokens, max: d.bumpMax, refillMin: d.bumpRefillMin, next: d.nextRefillAt }; };
const setWallet = (c, tokens, at) => sql(`UPDATE users SET bump_tokens=${tokens},bump_at=${at} WHERE id='${c.user.id}'`);
const bumper = await register('bump');
equal(await wallet(bumper), { tokens: 3, max: 3, refillMin: 360, next: null }, 'a new 일반 member starts with a full wallet (3/3)');
const b1 = await created(bumper, 'bump post');
refused(await bumper(`posts/${b1}/bump`, 'POST'), 429, '같은 글은 6시간마다 끌올할 수 있습니다. (', 'bump right after posting waits for the 6-hour gap');
age([b1], 6.1);
const bumped = await bumper(`posts/${b1}/bump`, 'POST');
equal(bumped.status, 200, 'bump after 6 hours');
equal([bumped.data.bumpTokens, bumped.data.bumpMax, bumped.data.bumpRefillMin], [2, 3, 360], 'the bump response carries the wallet (2/3)');
check(bumped.data.nextRefillAt - bumped.data.bumpedAt === 6 * HOUR, 'the refill clock starts at the first spend from a full wallet');
check(bumped.data.nextBumpAt - bumped.data.bumpedAt === 6 * HOUR, 'nextBumpAt is 6 hours later');
// Today's free new posts sit 1 hour ahead (새 글 우선, WP44); below them the bumped post is first.
equal((await guest(`posts?kind=sell&q=${run}&size=40`)).data.posts.find(p => p.bumped_at <= Date.now())?.id, b1, 'the bumped post is first in 최신순 below 새 글 우선');
const afterBump = (await guest('posts/' + b1)).data.post;
check(afterBump.bump_count === 1 && afterBump.bumped_at > afterBump.created_at, 'bump_count and bumped_at are returned; created_at is kept');
refused(await bumper(`posts/${b1}/bump`, 'POST'), 429, '같은 글은 6시간마다', 'bumping again waits for the gap');
const other = await register('other');
equal((await other(`posts/${b1}/bump`, 'POST')).status, 403, 'another member cannot bump');
equal((await manager(`posts/${b1}/bump`, 'POST')).status, 403, 'the manager cannot bump a member post');
equal((await setStatus(bumper, b1, 'closed')).status, 200, 'post is closed');
refused(await bumper(`posts/${b1}/bump`, 'POST'), 409, '거래중인 글만 끌올할 수 있습니다.', 'a closed post cannot be bumped');

// Three bumps empty the wallet; the 4th post waits for the refill.
const daily = await register('daily');
const four = [];
for (let i = 0; i < 4; i++) four.push(await created(daily, 'daily bump post'));
// The 4th new post of the day spent 1 끌올 (새 글 allowance); start these checks from a full wallet.
setWallet(daily, 0, 0);
// Three posts are past the 6-hour gap; the 4th was written 4 hours ago (its gap ends before the refill).
age(four.slice(0, 3), 6.5);
age([four[3]], 4);
let firstSpend = 0;
for (let i = 0; i < 3; i++) {
    const r = await daily(`posts/${four[i]}/bump`, 'POST');
    equal([r.status, r.data.bumpTokens], [200, 2 - i], `bump ${i + 1} of 3 (wallet ${2 - i}/3)`);
    if (!i) firstSpend = r.data.bumpedAt;
}
// The post's own gap (6h from its creation 4h ago) ends before the refill, so the message names the refill.
refused(await daily(`posts/${four[3]}/bump`, 'POST'), 429, `끌올이 없습니다. ${kst(firstSpend + 6 * HOUR)}에 1개 충전됩니다.`, 'the 4th post: the wallet is empty until the refill');
equal((await wallet(daily)).tokens, 0, 'the wallet reads 0/3');
equal((await daily(`posts/${four[3]}`, 'PUT', sale('수정한 제목 ' + run))).status, 200, 'editing is allowed');
equal(sql(`SELECT bumped_at<${Date.now() - 3 * HOUR} AS old FROM posts WHERE id=${four[3]}`)[0].old, 1, 'editing never bumps');
equal(sql(`SELECT COUNT(*) AS n FROM post_events WHERE user_id='${daily.user.id}' AND kind='bump' AND post_id IN (${four.slice(0, 3).join(',')})`)[0].n, 3, 'only the 3 bumps that moved a post are logged');
equal(sql(`SELECT COUNT(*) AS n FROM post_events WHERE user_id='${daily.user.id}' AND kind='bump' AND post_id=${four[3]}`)[0].n, 1, 'the 4th post has only the 끌올 its creation spent');

// Refill: 6 hours and 1 minute after the clock started, 1 is back (the 4th post's gap has passed too).
sql(`UPDATE users SET bump_at=bump_at-${6 * HOUR + 60000} WHERE id='${daily.user.id}'`);
age([four[3]], 3);
equal((await wallet(daily)).tokens, 1, 'after 6h01m the wallet holds 1');
equal((await daily(`posts/${four[3]}/bump`, 'POST')).status, 200, 'and the 4th post is bumped');

// 엘리트: 20 held, 1 every 30 minutes; a long wait is capped at 20.
const eliteW = await register('elitew');
await grant(eliteW, 'elite');
setWallet(eliteW, 0, Date.now() - (10 * HOUR + 60000));
equal(await wallet(eliteW), { tokens: 20, max: 20, refillMin: 30, next: null }, '엘리트 with 0 after 10h01m reads 20/20 (capped)');
setWallet(eliteW, 0, Date.now() - (20 * HOUR));
equal((await wallet(eliteW)).tokens, 20, 'and 20 hours never give more than 20');

// The same post again: 엘리트 20분, 프리미엄 1시간, 플러스 3시간, 일반 6시간 after its last bump.
const ep = await created(eliteW, 'elite gap post');
age([ep], 1);
equal((await eliteW(`posts/${ep}/bump`, 'POST')).status, 200, '엘리트 bumps a post');
sql(`UPDATE posts SET bumped_at=${Date.now() - 10 * 60000} WHERE id=${ep}`);
refused(await eliteW(`posts/${ep}/bump`, 'POST'), 429, '같은 글은 20분마다 끌올할 수 있습니다.', '엘리트: the same post 10 minutes later');
const gapMember = async (name, grade, text) => {
    const c = await register(name);
    if (grade) await grant(c, grade);
    const id = await created(c, name + ' gap post');
    sql(`UPDATE posts SET created_at=${Date.now() - 5 * HOUR},bump_count=1,bumped_at=${Date.now() - 20 * 60000} WHERE id=${id}`);
    refused(await c(`posts/${id}/bump`, 'POST'), 429, `같은 글은 ${text}마다 끌올할 수 있습니다.`, `${grade || 'normal'}: the same post 20 minutes later`);
    return c;
};
const premiumGap = await gapMember('gpre', 'premium', '1시간');
const plusGap = await gapMember('gplus', 'plus', '3시간');
await gapMember('gnorm', null, '6시간');
equal((await premiumGap('me/usage')).data.bumpMax, 10, '프리미엄 holds 10');
equal((await premiumGap('me/usage')).data.bumpRefillMin, 90, '프리미엄 refills every 1시간 30분');
equal((await plusGap('me/usage')).data.bumpRefillMin, 240, '플러스 refills every 4 hours');

// 새 글 우선: a post placed ahead of now cannot be bumped down, and the wallet is untouched.
const prio = await register('prio');
const pp = await created(prio, 'priority post');
const prioUntil = Date.now() + 30 * 60000;
sql(`UPDATE posts SET created_at=${Date.now() - 7 * HOUR},bumped_at=${prioUntil},bump_count=0 WHERE id=${pp}`);
refused(await prio(`posts/${pp}/bump`, 'POST'), 429, `새 글 우선 중인 글은 ${kst(prioUntil)}부터 끌올할 수 있습니다.`, 'a post in 새 글 우선 is not bumped');
equal((await wallet(prio)).tokens, 3, 'the wallet is unchanged (3/3)');
equal(sql(`SELECT bumped_at FROM posts WHERE id=${pp}`)[0].bumped_at, prioUntil, 'the post keeps its place');
equal((await prio(`posts/${pp}`, 'DELETE')).status, 200, 'the priority post is removed (it would stay on top of 최신순 for later runs)');

// A grant fills the wallet to the new grade's cap and says so in the manager chat; the end clamps it.
const granted = await register('grantw');
setWallet(granted, 0, Date.now());
equal((await wallet(granted)).tokens, 0, 'the member is at 0/3');
const app = await granted('applications', 'POST', { kind: 'grade', target: 'elite', plan: 'permanent' });
equal(app.status, 201, `the member applies for 엘리트 (${app.data.error || ''})`);
equal((await manager(`applications/${app.data.id}`, 'PATCH', { action: 'approve' })).status, 200, 'the manager approves');
equal(await wallet(granted), { tokens: 20, max: 20, refillMin: 30, next: null }, 'the grant fills the wallet to 20/20');
const grantLine = (await granted(`chats/${app.data.chatId}/messages`)).data.messages.filter(m => m.type === 'system').map(m => m.body).find(b => b.includes('등급 지급 완료'));
check(grantLine?.includes('끌올이 20개로 충전되었습니다.'), `the grant chat line says the wallet was filled (${JSON.stringify(grantLine)})`);
sql(`UPDATE user_grades SET expires_at=${Date.now() - 1000} WHERE user_id='${granted.user.id}'`);
const clamped = await wallet(granted);
check(clamped.tokens <= 3 && clamped.max === 3, `after the grade ends the next read clamps to 일반 (${clamped.tokens}/${clamped.max})`);
const direct = await register('grantd');
setWallet(direct, 0, Date.now());
await grant(direct, 'premium');
equal((await wallet(direct)).tokens, 10, 'a grant from the member page fills the wallet too (10/10)');
const directChat = (await direct('chats')).data.chats.find(x => x.partner_id === 'manager');
const directLine = directChat && (await direct(`chats/${directChat.id}/messages`)).data.messages.filter(m => m.type === 'system').map(m => m.body);
equal(directLine, ['프리미엄 등급 지급 완료 (영구)\n끌올이 10개로 충전되었습니다.'], 'a direct grant says so in the manager chat too');

// Race: two parallel bumps on two posts with 1 in the wallet: exactly one passes.
const racer2 = await register('wrace');
const rp = [await created(racer2, 'race a'), await created(racer2, 'race b')];
age(rp, 7);
setWallet(racer2, 1, Date.now());
const pair = await Promise.all(rp.map(id => racer2(`posts/${id}/bump`, 'POST')));
equal(pair.map(r => r.status).sort(), [200, 429], 'two parallel bumps with 1 in the wallet: exactly one 200');
equal(sql(`SELECT bump_tokens FROM users WHERE id='${racer2.user.id}'`)[0].bump_tokens, 0, 'the wallet is at 0');
equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE id IN (${rp.join(',')}) AND bump_count=1`)[0].n, 1, 'exactly one post moved');

// 새 글 allowance (decisions item 1b): the first 3 new posts of the KST day go to the top for free;
// from the 4th on a new post spends 1 끌올, or, with the wallet empty, sits at the latest top time.
// Changing the title every time buys nothing more.
const fresher = await register('fresh');
const placedPosts = [];
for (let i = 0; i < 3; i++) {
    const r = await fresher('posts', 'POST', sale(`[QA] 새 글 ${run} 제목${i} 다름`));
    equal([r.status, r.data.placed, r.data.bumpTokens], [201, 'fresh', 3], `new post ${i + 1} of 3 is a free new post`);
    placedPosts.push(r.data);
}
equal(sql(`SELECT bumped_at-created_at AS ahead FROM posts WHERE id IN (${placedPosts.map(p => p.id).join(',')})`).map(r => r.ahead), [HOUR, HOUR, HOUR], 'each free new post sits 1 hour ahead (새 글 우선)');
const fourth = await fresher('posts', 'POST', sale(`[QA] 새 글 ${run} 네번째`));
equal([fourth.status, fourth.data.placed, fourth.data.bumpTokens], [201, 'bump', 2], 'the 4th new post spends 1 끌올 (2/3 left)');
equal(sql(`SELECT bumped_at-created_at AS d FROM posts WHERE id=${fourth.data.id}`)[0].d, 0, 'and goes to the top at now');
equal(sql(`SELECT COUNT(*) AS n FROM post_events WHERE user_id='${fresher.user.id}' AND kind='fresh'`)[0].n, 3, 'three fresh events');
setWallet(fresher, 0, Date.now());
const othersNew = await created(other, 'another member posts after the 4th');
const fifth = await fresher('posts', 'POST', sale(`[QA] 새 글 ${run} 다섯번째 완전히 다른 제목`));
equal([fifth.status, fifth.data.placed, fifth.data.bumpTokens], [201, 'last', 0], 'with the wallet empty the 5th new post is placed, not refused');
const refill = 360 * 60000;
equal(fifth.data.bumpedAt, fourth.data.bumpedAt - refill, 'one refill interval below the latest top time (the 4th post)');
const freshList = (await guest(`posts?kind=sell&q=${run}&size=40`)).data.posts.map(p => p.id);
check(freshList.includes(othersNew) && (freshList.indexOf(fifth.data.id) === -1 || freshList.indexOf(fifth.data.id) > freshList.indexOf(othersNew)), `the 5th post sits below a post another member wrote before it (${freshList.slice(0, 6).join(',')})`);
// A burst of empty-wallet posts never stacks at the top: each goes one refill interval lower, and
// deleting one gives nothing back.
const lastBurst = [];
for (let i = 0; i < 10; i++) {
    const r = await fresher('posts', 'POST', sale(`[QA] 새 글 ${run} 연속 ${i} 제목 ${i * 7}`));
    equal([r.status, r.data.placed], [201, 'last'], `burst post ${i + 1} is placed below`);
    lastBurst.push(r.data);
}
equal(lastBurst.map(b => b.bumpedAt), lastBurst.map((_, i) => fourth.data.bumpedAt - refill * (i + 2)), 'each burst post sits one refill interval below the previous one');
await fresher(`posts/${lastBurst[9].id}`, 'DELETE');
const afterDelete = await fresher('posts', 'POST', sale(`[QA] 새 글 ${run} 삭제 후 다시`));
equal(afterDelete.data.bumpedAt, fourth.data.bumpedAt - refill * 12, 'deleting a placed post does not give its place back');
const lastBurstList = (await guest(`posts?kind=sell&q=${run}&size=40`)).data.posts.map(p => p.id);
const fourthAt = lastBurstList.indexOf(fourth.data.id);
check(fourthAt >= 0 && [fifth.data, ...lastBurst.slice(0, 9), afterDelete.data].every(b => lastBurstList.indexOf(b.id) === -1 || lastBurstList.indexOf(b.id) > fourthAt), 'no empty-wallet post ranks above the member\'s own latest top post');
check(lastBurstList.slice(0, 10).filter(id => lastBurst.some(b => b.id === id)).length < 10, 'the burst does not fill the board\'s top 10');
equal((await fresher('me/usage')).data.freshToday, 3, 'usage.freshToday is 3');
const freshRace = await register('fresh2');
const raced = await Promise.all([0, 1, 2, 3, 4].map(i => freshRace('posts', 'POST', sale(`[QA] 동시 새 글 ${run} ${i}`))));
equal(raced.filter(r => r.status === 201).length, 5, 'five parallel new posts are all created');
equal(raced.map(r => r.data.placed).sort(), ['bump', 'bump', 'fresh', 'fresh', 'fresh'], 'exactly 3 are free new posts; the other 2 spend 1 끌올 each');
equal((await wallet(freshRace)).tokens, 1, 'the wallet holds 1 (3 - 2)');
const mgrNew = await manager('posts', 'POST', sale(`[QA] 매니저 새 글 ${run}`));
equal([mgrNew.status, mgrNew.data.placed], [201, 'fresh'], 'the manager has no allowance (always a new post)');
await manager(`posts/${mgrNew.data.id}`, 'DELETE');

// The manager has no wallet and no gap.
const mp = await manager('posts', 'POST', sale(`[QA] 매니저 끌올 ${run}`));
equal(mp.status, 201, 'the manager writes a post');
const mb = [await manager(`posts/${mp.data.id}/bump`, 'POST'), await manager(`posts/${mp.data.id}/bump`, 'POST')];
equal(mb.map(r => [r.status, r.data.bumpTokens]), [[200, null], [200, null]], 'the manager bumps twice in a row (no wallet, no gap)');
await manager(`posts/${mp.data.id}`, 'DELETE');

// 대리(진행) needs 대리 인증 to bump.
const proxy = await register('proxy');
equal((await manager(`manage/users/${proxy.user.id}/badges`, 'POST', { badge: 'proxy', active: true })).status, 200, 'proxy member gets 대리 인증');
const proxyPost = await proxy('posts', 'POST', { kind: 'proxy_offer', category: 'ladder', title: `[QA] 대리 ${run}`, body: '자동 검증', price: 10000, status: 'open', tags: [], images: [], details: {} });
equal(proxyPost.status, 201, '대리(진행) post is created');
equal((await manager(`manage/users/${proxy.user.id}/badges`, 'POST', { badge: 'proxy', active: false })).status, 200, '대리 인증 is removed');
age([proxyPost.data.id], 7);
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
// Two states (WP43): completing a featured post ends its feature and frees the slot.
equal((await setStatus(elite, E[0], 'closed')).status, 200, 'the featured post is completed');
equal(sql(`SELECT featured_at FROM posts WHERE id=${E[0]}`)[0].featured_at, null, 'completing clears featured_at');
check(!(await guest(`posts?kind=sell&q=${run}`)).data.featured.some(p => p.id === E[0]), 'a completed post drops out of the box');
refused(await elite(`posts/${E[0]}/feature`, 'PUT', { active: true }), 409, '거래중인 글만 상단에 노출할 수 있습니다.', 'a completed post cannot be featured');
const E3 = await created(elite, 'elite 3');
const f3 = await elite(`posts/${E3}/feature`, 'PUT', { active: true });
equal([f3.status, f3.data.replaced, f3.data.used], [200, null, 3], 'the freed slot takes a new post without replacing');
equal((await elite('me/usage')).data.featured.length, 3, 'usage counts only the open featured posts');
// The editor never changes the status: a stale 'closed' in the form keeps the post open and featured.
const editClosed = await elite(`posts/${E[1]}`, 'PUT', sale('elite closed by edit ' + run, { status: 'closed' }));
equal(editClosed.status, 200, 'saving through the editor');
equal(sql(`SELECT status,featured_at IS NOT NULL AS featured FROM posts WHERE id=${E[1]}`)[0], { status: 'open', featured: 1 }, 'the editor leaves the post open and featured');

// 5. Photos: 100 per post for every member; uploads 120 per 10 minutes and 300 per day.
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const upload = c => c('uploads', 'POST', undefined, { type: 'image/png', bytes: png });
const photos = async (c, count) => {
    const ids = [];
    for (let i = 0; i < count; i++) { const r = await upload(c); assert.equal(r.status, 201, `upload ${i + 1}: ${JSON.stringify(r.data)}`); ids.push(r.data.id); }
    return ids;
};
const photoMember = await register('photo');
const many = await photos(photoMember, 101);
check(true, '일반 uploads 101 photos within 10 minutes');
const hundred = await create(photoMember, { images: many.slice(0, 100) });
equal(hundred.status, 201, '일반 post with 100 photos');
refused(await create(photoMember, { images: many }), 400, '사진은 한 글에 100장까지입니다.', '일반 post with 101 photos');
// A post that already holds more (written before this rule) keeps its photos on edit.
sql(`UPDATE posts SET images='${JSON.stringify(many)}' WHERE id=${hundred.data.id}`);
equal((await photoMember('posts/' + hundred.data.id, 'PUT', sale('photo edit ' + run, { images: many }))).status, 200, 'an edit keeps the 101 photos the post already has');
await photos(photoMember, 19);
equal((await upload(photoMember)).status, 429, 'the 121st upload within 10 minutes is refused');
const dayMember = await register('upday');
sql(`INSERT INTO rate_limits(key,count,reset_at) VALUES('upload-day:${dayMember.user.id}',300,${Date.now() + DAY})`);
equal((await upload(dayMember)).status, 429, 'the 301st upload of the day is refused');

// 6. Quick price change (판매).
const seller = await register('sell');
const sp = await created(seller, 'price post', { price: 500000 });
const bumpedBefore = sql(`SELECT bumped_at FROM posts WHERE id=${sp}`)[0].bumped_at;
const cut = await seller(`posts/${sp}/price`, 'PATCH', { price: 400000 });
equal([cut.status, cut.data.post.price, cut.data.post.price_history.map(h => h.price)], [200, 400000, [500000]], 'price 500000 to 400000 keeps 500000 in price_history');
equal(sql(`SELECT bumped_at FROM posts WHERE id=${sp}`)[0].bumped_at, bumpedBefore, 'a price change never bumps');
// Rows the previous Worker wrote (it kept rises too) are filtered when read.
sql(`INSERT INTO post_price_history(post_id,price,changed_at) VALUES(${sp},350000,${Date.now()})`);
equal((await guest('posts/' + sp)).data.post.price_history.map(h => h.price), [500000], 'a stored entry below the current price is not shown');
sql(`INSERT INTO post_price_history(post_id,price,changed_at) VALUES(${sp},700000,${Date.now()})`);
equal((await guest('posts/' + sp)).data.post.price_history.map(h => h.price), [700000], 'an entry followed by a higher one is not shown');
sql(`DELETE FROM post_price_history WHERE post_id=${sp} AND price IN (350000,700000)`);
refused(await seller(`posts/${sp}/price`, 'PATCH', { currentOffer: 500 }), 400, '현젯은 1,000원 이상입니다.', '현젯 below 1,000원');
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
equal([usage.grade, usage.bumpTokens, usage.bumpMax, usage.openPosts, usage.postsToday], ['normal', 0, 3, 4, 4], 'usage counts for 일반');
equal(usage.perks, { bumpMax: 3, bumpRefillMinutes: 360, bumpGapMinutes: 360, autoBumpPosts: 0, autoEveryMinutes: 0, pauseDays: 0, adSlots: 0, boardSlots: 0, homeShelf: false, serviceCoupons: 0 }, '일반 perks');
equal(usage.freshToday, 3, 'usage counts today\'s free new posts (3 of the 4)');
equal(usage.rules, { photosPerPost: 100, openPosts: 100, postsPerDay: 30, uploadsPer10Min: 120, uploadsPerDay: 300, freshPerDay: 3, keywordAlerts: 10, follows: 100, savedSearches: 20, commentsPer10Min: 20, commentsPerDay: 200 }, 'the cafe rules every member shares');
check(usage.nextRefillAt > Date.now() && usage.nextRefillAt - Date.now() <= 6 * HOUR, 'nextRefillAt is within the next 6 hours');
const premiumUsage = (await premium('me/usage')).data;
equal([premiumUsage.grade, premiumUsage.perks.boardSlots, premiumUsage.bumpMax, premiumUsage.featured.map(f => f.id)], ['premium', 1, 10, [B]], 'premium perks and featured list');
const managerUsage = (await manager('me/usage')).data;
equal([managerUsage.perks.bumpMax, managerUsage.bumpTokens, managerUsage.nextRefillAt, managerUsage.rules.openPosts, managerUsage.rules.photosPerPost], [null, null, null, null, 100], 'the manager has no wallet and no open-post ceiling (null)');
equal((await guest('me/usage')).status, 401, 'usage needs a login');

// 7b. 무료 중개·가측 (WP65): per KST month, 0 / 1 / 5 / 무제한 (null), 0 during the 플러스 체험; the
// elite permanent price is 150,000원 (the grade application line reads GRADES on the server).
const couponLimits = async c => { const d = (await c('me/usage')).data; return [d.perks.serviceCoupons, d.coupons.limit]; };
equal(await couponLimits(daily), [0, 0], '일반: serviceCoupons 0');
equal(await couponLimits(plus), [1, 1], '플러스: serviceCoupons 1');
equal(await couponLimits(premium), [5, 5], '프리미엄: serviceCoupons 5');
equal(await couponLimits(elite), [null, null], '엘리트: serviceCoupons 무제한 (null)');
sql(`INSERT INTO settings(key,value,updated_at) VALUES('sys:trial_start','${Date.now() - 60000}',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
equal((await manager('manage/trial', 'PUT', { end: Date.now() + DAY })).status, 200, 'the trial window opens for one sign-up');
const trialist = await register('trial');
equal((await manager('manage/trial', 'PUT', { close: true })).status, 200, 'the window closes again');
sql("UPDATE settings SET value='-1' WHERE key='sys:trial_end'");
sql("DELETE FROM rate_limits WHERE key LIKE 'trial-ip:%'");
equal([trialist.user.grade, trialist.user.grade_trial], ['plus', true], 'the new member is on the 플러스 체험');
equal(await couponLimits(trialist), [0, 0], '플러스 체험: serviceCoupons 0');
const elitePrice = await plain('applications', 'POST', { kind: 'grade', target: 'elite', plan: 'permanent' });
equal(elitePrice.status, 201, 'a member applies for 엘리트 영구');
const applyLine = (await plain(`chats/${elitePrice.data.chatId}/messages`)).data.messages.find(m => m.type === 'application')?.body;
equal(applyLine, '엘리트 등급 신청 · 영구 150,000원', 'GRADES: 엘리트 영구 is 150,000원');

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
