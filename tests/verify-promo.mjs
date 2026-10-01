import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 광고 (WP53) on the strict server: ads never change list order; who is eligible (프리미엄+ from the
// manager, 본인 인증, no pending report, not '광고 제외', a recent visit; never the 플러스 체험); the board
// '광고 매물' box (only with more than 16 진행중 posts, at most 3, one per advertiser, the same order inside
// a 10-minute bucket, never a post of the first 5 rows); '비슷한 매물' under completed posts only; the
// home '엘리트 매물' row; '광고 유입' from ?from=ad; the 403 below 프리미엄. scripts/test-local.mjs runs it
// on the 8791 server.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const HOUR = 3600000, DAY = 86400000, BUCKET = 600000;
const T = `zq${run}`;
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
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); }
        catch { throw new Error(`${method} ${path}: expected JSON, received HTTP ${response.status}: ${text.slice(0, 300)}`); }
        return { status: response.status, data: result };
    };
}
async function register(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `pr_${run}_${name}`.slice(0, 24), password, nickname: `${name}${run}`.slice(0, 12) });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}

sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%'");
const manager = client(), guest = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const grant = async (c, grade) => equal((await manager(`manage/users/${c.user.id}/grades`, 'POST', { grade, plan: 'permanent' })).status, 201, `manager grants ${grade}`);
const identity = async c => equal((await manager(`manage/users/${c.user.id}/badges`, 'POST', { badge: 'identity', active: true })).status, 200, 'manager grants 본인 인증');
const adOff = async (c, on) => equal((await manager(`manage/users/${c.user.id}/ad-off`, 'POST', { active: on })).status, 200, `광고 제외 ${on ? 'on' : 'off'}`);

let n = 0;
const post = (kind, extra = {}) => ({ kind, category: 'other', title: `[QA] 광고 ${T} ${++n}`, body: '자동 검증', price: 10000, status: 'open', tags: [], images: [], details: {}, ...extra });
async function created(c, kind = 'sell') {
    const r = await c('posts', 'POST', post(kind));
    assert.equal(r.status, 201, `create: ${JSON.stringify(r.data)}`);
    return r.data.id;
}

// Members: 엘리트 e1 and e2, 프리미엄 p2 and p3 with 본인 인증, 프리미엄 p1 without it, a 플러스 체험 member,
// a 플러스 member and a 일반 member n1.
const [e1, e2, p1, p2, p3, plus, n1] = [await register('e1'), await register('e2'), await register('p1'), await register('p2'), await register('p3'), await register('pl'), await register('n1')];
for (const c of [e1, e2]) { await grant(c, 'elite'); await identity(c); }
for (const c of [p1, p2, p3]) await grant(c, 'premium');
for (const c of [p2, p3]) await identity(c);
await grant(plus, 'plus');
sql(`INSERT INTO settings(key,value,updated_at) VALUES('sys:trial_start','${Date.now() - 60000}',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
equal((await manager('manage/trial', 'PUT', { end: Date.now() + DAY })).status, 200, 'the trial window opens for one sign-up');
const trial = await register('tr');
equal((await manager('manage/trial', 'PUT', { close: true })).status, 200, 'the window closes again');
const trialMe = (await trial('auth/me')).data.user;
equal([trialMe.grade, trialMe.grade_trial], ['plus', true], 'the trial member holds 플러스 체험');
await identity(trial);

// Posts. 판매: e1 3, e2 1, p2 1, p1 1, the trial 1 (its slot forced below), n1 1. 구매: e2 1, p3 1, and
// n1's post that is completed for '비슷한 매물'.
const E1 = [await created(e1), await created(e1), await created(e1)];
const E2s = await created(e2), P2s = await created(p2), P1s = await created(p1), TRs = await created(trial), N1s = await created(n1);
const E2b = await created(e2, 'buy'), P3b = await created(p3, 'buy'), N1b = await created(n1, 'buy');
const slotRows = sql(`SELECT id,featured_at IS NOT NULL AS f FROM posts WHERE title LIKE '%${T}%' ORDER BY id`);
const slotted = slotRows.filter(r => r.f).map(r => r.id).sort((a, b) => a - b);
equal(slotted, [...E1, E2s, P2s, P1s, E2b, P3b].sort((a, b) => a - b), 'new posts of 프리미엄 and 엘리트 take their slots; 일반 and the 체험 do not');
// Other suites' slot posts leave the ads, so every placement below holds only this run's members; the
// trial's post gets a slot it may never use; the ad posts sit below the 판매 fillers (rows 1-5 are never
// ads); 8 fillers (n1, SQL) make 16 open 판매 posts, plus one completed filler.
const now0 = Date.now();
const filler = (i, status, at) => `('${n1.user.id}','sell','[QA] 광고 ${T} filler ${i}','자동 검증',10000,'${status}','other',${at},${at},${at},${at},'qa ad ${T} filler ${i}')`;
sql(`UPDATE posts SET featured_at=NULL WHERE featured_at IS NOT NULL AND title NOT LIKE '%${T}%';
UPDATE posts SET featured_at=${now0} WHERE id=${TRs};
UPDATE posts SET bumped_at=${now0 - 2 * HOUR}-id WHERE title LIKE '%${T}%';
INSERT INTO posts(author_id,kind,title,body,price,status,category,created_at,updated_at,touched_at,bumped_at,title_key) VALUES ${Array.from({ length: 8 }, (_, i) => filler(i, 'open', now0 - i * 1000)).join(',')},${filler(99, 'closed', now0 - 50000)}`);

const board = (extra = '') => guest(`posts?kind=sell&q=${T}&active=1${extra}`);
const authorsOf = list => list.map(p => p.author_id).sort();
const ids = c => c.user.id;
let b = await board();
equal([b.data.total, b.data.ads], [16, []], '16 open 판매 posts: no 광고 box');
b = await guest(`posts?kind=sell&q=${T}`);
equal([b.data.total, b.data.ads], [17, undefined], 'with 거래완료 included there is no box at all');
sql(`INSERT INTO posts(author_id,kind,title,body,price,status,category,created_at,updated_at,touched_at,bumped_at,title_key) VALUES ${filler(16, 'open', now0 + 1000)}`);

// 17 open posts: the box.
async function stableBox(extra = '') {
    for (let i = 0; i < 3; i++) {
        const t0 = Math.floor(Date.now() / BUCKET), a = await board(extra), c = await board(extra), t1 = Math.floor(Date.now() / BUCKET);
        if (t0 === t1) return { a, c };
    }
    throw new Error('10-minute bucket kept changing');
}
let { a: box, c: again } = await stableBox();
equal(box.data.total, 17, '17 open 판매 posts');
equal(authorsOf(box.data.ads), [ids(e1), ids(e2), ids(p2)].sort(), 'the box holds e1, e2 and p2: one card per advertiser, never p1 (no 본인 인증) or the 체험');
check(box.data.ads.length <= 3, 'at most 3 cards');
equal(again.data.ads.map(p => p.id), box.data.ads.map(p => p.id), 'the same order inside one 10-minute bucket');
const top5 = box.data.posts.slice(0, 5).map(p => p.id);
equal((await guest(`posts?kind=sell&q=${T}`)).data.ads, undefined, 'the 거래완료 포함 view has no box even with 17 open posts');
check(!box.data.ads.some(p => top5.includes(p.id)), 'no card repeats a post of the first 5 rows');
check(box.data.ads.every(p => !('featured_pin' in p) && !('promo_views' in p) && !('ad_rank' in p)), 'ad cards carry no private ad columns');
equal((await board('&page=2')).data.ads, undefined, 'no box on page 2');
equal((await board('&sort=price-low')).data.ads, undefined, 'no box when sorted by price');

// List order is ORDER BY bumped_at DESC, id DESC for every grade (ads never change it).
const listed = (await guest(`posts?kind=sell&q=${T}&active=1&size=40`)).data.posts.map(p => p.id);
const ordered = sql(`SELECT id FROM posts WHERE kind='sell' AND status!='closed' AND hidden=0 AND title LIKE '%${T}%' ORDER BY bumped_at DESC,id DESC`).map(r => r.id);
equal(listed, ordered, 'the 판매 list order equals ORDER BY bumped_at DESC, id DESC (일반, 엘리트, 프리미엄 and 체험 posts alike)');

// '비슷한 매물': only under a completed post, other advertisers of the same tab.
equal((await n1(`posts/${N1b}/status`, 'PATCH', { status: 'closed' })).status, 200, "n1's 구매 post is completed");
const similar = async () => (await guest('posts/' + N1b)).data.post.ads;
let sim = await similar();
equal(authorsOf(sim), [ids(e2), ids(p3)].sort(), "'비슷한 매물' under the completed post: e2 and p3 (2 cards, not its author)");
check(!('ads' in (await guest('posts/' + E2b)).data.post), 'an open post carries no ads key');
check(!('ads' in (await guest('posts/' + N1s)).data.post), "n1's open 판매 post carries no ads key either");

// Home '엘리트 매물': e1 and e2 only (프리미엄 never), one card each.
const home = async () => (await guest('home')).data.ads;
let h = await home();
equal(authorsOf(h), [ids(e1), ids(e2)].sort(), "home '엘리트 매물' holds e1 and e2, one card each, no 프리미엄");

// A pending report takes the post out of every placement.
equal((await n1('reports', 'POST', { postId: E2b, reason: '허위 매물', details: '자동 검증' })).status, 200, "a report on e2's 구매 ad");
sim = await similar();
equal(sim.map(p => p.id), [P3b], "the reported post leaves '비슷한 매물'");
check(!(await home()).some(p => p.id === E2b), 'and the home row');
equal((await n1('reports', 'POST', { postId: E2s, reason: '허위 매물', details: '자동 검증' })).status, 200, "a report on e2's 판매 ad");
equal(authorsOf((await board()).data.ads), [ids(e1), ids(p2)].sort(), 'the reported post leaves the box');
equal(authorsOf(await home()), [ids(e1)], 'e2 has no unreported ad left for the home row');

// 본인 인증 makes p1 eligible.
await identity(p1);
equal(authorsOf((await board()).data.ads), [ids(e1), ids(p1), ids(p2)].sort(), 'after 본인 인증, p1 is in the box');

// '광고 제외' takes a member out of every placement.
await adOff(e1, true);
await adOff(p3, true);
equal(authorsOf((await board()).data.ads), [ids(p1), ids(p2)].sort(), '광고 제외: e1 leaves the box');
equal(await home(), [], '광고 제외: e1 leaves the home row (now empty)');
equal(await similar(), [], "광고 제외: p3 leaves '비슷한 매물' (now empty)");
await adOff(e1, false);
await adOff(p3, false);

// The visit rule: 프리미엄 3 days, 엘리트 7 days. A suspension in the last 30 days also stops ads.
sql(`UPDATE users SET last_seen_at=${Date.now() - 4 * DAY} WHERE id IN ('${ids(p2)}','${ids(e1)}')`);
equal(authorsOf((await board()).data.ads), [ids(e1), ids(p1)].sort(), 'a 프리미엄 member away for 4 days leaves the box; an 엘리트 stays');
sql(`UPDATE users SET last_seen_at=${Date.now() - 8 * DAY} WHERE id='${ids(e1)}'; INSERT INTO sanctions(user_id,days,reason,by_id,created_at) VALUES('${ids(p1)}',3,'자동 검증','manager',${Date.now() - DAY})`);
equal((await board()).data.ads, [], 'an 엘리트 away for 8 days and a member suspended yesterday leave the box');
equal(await home(), [], 'and the home row');
sql(`UPDATE users SET last_seen_at=${Date.now()} WHERE id IN ('${ids(p2)}','${ids(e1)}'); DELETE FROM sanctions WHERE user_id='${ids(p1)}'`);

// ?from=ad on a counted first view is '광고 유입'.
const viewed = await n1(`posts/${P2s}?view=1&from=ad`);
equal(viewed.status, 200, 'a member opens an ad with ?from=ad');
equal(sql(`SELECT view_count,promo_views FROM posts WHERE id=${P2s}`)[0], { view_count: 1, promo_views: 1 }, 'the first view counts as 광고 유입 1');
await n1(`posts/${P2s}?view=1&from=ad`);
equal(sql(`SELECT promo_views FROM posts WHERE id=${P2s}`)[0].promo_views, 1, 'a repeat view within 6 hours does not count again');
await n1(`posts/${E1[0]}?view=1`);
equal(sql(`SELECT promo_views FROM posts WHERE id=${E1[0]}`)[0].promo_views, 0, 'a view without ?from=ad is not 광고 유입');
const own = (await p2(`posts?author=${ids(p2)}&counts=1`)).data.posts.find(p => p.id === P2s);
equal([own.promo_views, own.featured, own.featured_pin], [1, true, 0], "내 글 carries '광고 유입 1' and the slot state for the author");
equal((await guest('posts/' + P2s)).data.post.promo_views, undefined, '광고 유입 is the author\'s only');

// Below 프리미엄 there is no 광고 고정; me/usage counts the slots.
const plusPost = await created(plus);
refused(await plus(`posts/${plusPost}/feature`, 'PUT', { active: true }), 403, '광고는 프리미엄부터 가능합니다.', '플러스 cannot pin an ad');
refused(await trial(`posts/${TRs}/feature`, 'PUT', { active: false }), 403, '광고는 프리미엄부터 가능합니다.', 'nor the 체험');
equal([(await e1('me/usage')).data.perks.adSlots, (await e1('me/usage')).data.featured.length], [3, 3], "e1's usage: 광고 3/3");

console.log(`verify-promo: ${checks} checks passed`);
