import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// 같은 매물 and the new-post allowance (WP44, decisions item 1). The matcher (shared/listing.ts, unit
// checks first), photo hashes and upload reuse, relists of a listing completed or deleted within 7 days
// (old place, 1 끌올, or below the latest top time), the only refusal (the same listing open), vendors'
// near-misses that must pass, the +1 hour 새 글 우선, edits, manager-hidden relists, cross-account flags,
// the print triggers and the daily fill, the manager's exemption and the create budget.
// Runs on the strict 8791 server (no POST_LIMITS=relaxed, READ_BUDGET=on, test cron events).
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

// ---- 1. The matcher, pure (shared/listing.ts bundled on the fly) ----
const bundle = await build({ configFile: false, logLevel: 'silent', root, build: { lib: { entry: 'shared/listing.ts', formats: ['es'], fileName: 'listing' }, write: false, minify: false } });
const L = await import('data:text/javascript;base64,' + Buffer.from((Array.isArray(bundle) ? bundle[0] : bundle).output[0].code).toString('base64'));
const acct = (d, seasons = []) => L.listingFields('sell', 'account', d, seasons);
const pr = (o = {}) => ({ kind: 'sell', category: 'account', title_key: '', fields: null, photos: [], ...o });
const ladder = [{ tier: 'challenger', season: 28 }, { tier: 'diamond', season: 30 }];
{
    const a = pr({ fields: acct({ phantom: '214', humanSkins: '300' }, ladder) }), b = pr({ fields: acct({ phantom: '214', humanSkins: '300', ownerCount: '2' }, [...ladder].reverse()) });
    const m = L.sameListing(a, b);
    equal([m?.why, L.sameText(m)], ['fields', '래더·팬텀·인간 스킨'], 'unit: 3 distinctive fields equal (ladder order ignored) is the same listing');
    equal(L.sameListing(a, pr({ fields: acct({ phantom: '214', humanSkins: '300', ownerCount: '2' }, ladder) })) !== null, true, 'unit: a supporting field filled on one side only never contradicts');
    equal(L.sameListing(pr({ fields: acct({ phantom: '214', humanSkins: '300', recordStatus: '무전적' }, ladder) }), pr({ fields: acct({ phantom: '214', humanSkins: '300', recordStatus: '전적 있음' }, ladder) })), null, 'unit: a both-filled supporting field that differs contradicts');
    equal(L.sameListing(pr({ fields: acct({ phantom: '214' }, ladder) }), pr({ fields: acct({ phantom: '214' }, ladder) })), null, 'unit: 2 distinctive fields are not enough');
    const p3 = [['a1', 'b1'], ['a2'], ['a3']];
    equal(L.sameText(L.sameListing(pr({ photos: p3 }), pr({ photos: [['x'], ['b1'], ['a2'], ['a3']] }))), '사진 3장', 'unit: 3 of 4 photos shared (a key of the original matches too)');
    equal(L.sameListing(pr({ photos: [['a1'], ['a2'], ['a3'], ['a4']] }), pr({ photos: [['a1'], ['a2'], ['x3'], ['x4']] })), null, 'unit: half the photos is not more than half');
    const banner = ['bn'];
    equal(L.sameListing(pr({ photos: [banner], fields: acct({ phantom: '214' }) }), pr({ photos: [banner], fields: acct({ phantom: '180' }) })), null, 'unit: a single shared photo is ignored when a field differs');
    equal(L.sameListing(pr({ photos: [banner] }), pr({ photos: [banner] }))?.why, 'photos', 'unit: the one photo of both posts, nothing contradicting');
    equal(L.sameListing(pr({ title_key: 't', fields: acct({ phantom: '214' }) }), pr({ title_key: 't', fields: acct({ phantom: '180' }) })), null, 'unit: the same title with a differing field is not the same listing');
    equal(L.sameText(L.sameListing(pr({ title_key: 't' }), pr({ title_key: 't' }))), '제목', 'unit: the same title, nothing contradicting');
    const want = d => pr({ kind: 'buy', fields: L.listingFields('buy', 'account', d, [{ tier: 'platinum', season: 32 }]) });
    equal(L.sameListing(want({}), want({}))?.why, 'fields', 'unit: the same want map');
    equal(L.sameListing(want({}), want({ skinTags: '["유루미"]' })), null, 'unit: a want with one more condition is another want');
    equal(L.sameListing(pr({ kind: 'buy', fields: L.listingFields('buy', 'other', {}) }), pr({ kind: 'buy', fields: L.listingFields('buy', 'other', {}) })), null, 'unit: an empty want map matches nothing');
    const clan = n => pr({ category: 'clan', fields: L.listingFields('sell', 'clan', { clanName: n, clanLevel: '5' }) });
    equal(L.sameText(L.sameListing(clan('좀비 클랜'), clan('좀비클랜!'))), '클랜명', 'unit: 클랜 by its name');
    const coupon = n => pr({ category: 'goods_coupon', photos: [banner], fields: L.listingFields('sell', 'goods_coupon', { couponName: n }) });
    equal(L.sameListing(coupon('유루미 스쿺'), coupon('코믹스 1권')), null, 'unit: two coupons with the banner and different names');
    equal(L.sameListing(pr({ category: 'other', fields: L.listingFields('sell', 'other', {}) }), pr({ category: 'other', fields: L.listingFields('sell', 'other', {}) })), null, 'unit: 기타 has no fields to match');
    equal(L.sameText(L.sameListing(pr({ kind: 'proxy_offer', category: 'ladder', fields: L.listingFields('proxy_offer', 'ladder', { mode: '래더 솔큐' }) }), pr({ kind: 'proxy_offer', category: 'ladder', fields: L.listingFields('proxy_offer', 'ladder', { mode: '래더솔큐' }) }))), '종목', 'unit: 대리(진행) by 종목');
    equal(L.fieldsHashInput(acct({ phantom: '1', level: '2', gas: '3' })), null, 'unit: no fields hash under 4 distinctive fields');
    check(L.fieldsHashInput(acct({ phantom: '1', level: '2', gas: '3', closet: '4' })), 'unit: a fields hash from 4 distinctive fields');
    equal(L.photoKeys(['u1', 'u2'], new Map([['u1', { hash: 'a'.repeat(64), src_hash: 'b'.repeat(64) }]])), [['a'.repeat(16), 'b'.repeat(16)], ['u:u2']], 'unit: photo keys are 16 hex characters, or the upload id without a hash');
}

// ---- Helpers for the API suites ----
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
    return async (path, method = 'GET', data, raw) => {
        const response = await send(base + '/api/' + path, () => ({
            method, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(raw ? { 'Content-Type': raw.type, ...raw.headers } : data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: raw ? raw.bytes : data === undefined ? undefined : JSON.stringify(data),
        }));
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); }
        catch { throw new Error(`${method} ${path}: expected JSON, received HTTP ${response.status}: ${text.slice(0, 300)}`); }
        const h = k => Number(response.headers.get(k));
        return { status: response.status, data: result, calls: h('x-d1-calls'), rows: h('x-rows-read') };
    };
}
async function register(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `dp_${run}_${name}`.slice(0, 24), password, nickname: `같은${name}${run}` });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}
async function fireCron() {
    const r = await send(base + '/cdn-cgi/handler/scheduled?cron=17+18+*+*+*', () => ({ signal: AbortSignal.timeout(60000) }));
    await r.arrayBuffer();
    return r.status;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// A small PNG-looking file (the Worker only sniffs the signature), different for every seed.
function png(seed) {
    const bytes = new Uint8Array(400);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    bytes.set(createHash('sha256').update(`${run}:${seed}`).digest(), 8);
    return bytes;
}
// Uploads one photo; src: the original's hash (default: a hash of its own), header: a raw X-Photo-Hash.
async function upload(c, seed, { src, header } = {}) {
    const bytes = png(seed), out = sha(bytes);
    const r = await c('uploads', 'POST', undefined, { type: 'image/png', bytes, headers: { 'X-Photo-Hash': header ?? `${out},${src ?? sha('src:' + run + seed)}` } });
    assert.ok([200, 201].includes(r.status), `upload ${seed}: ${JSON.stringify(r.data)}`);
    return { id: r.data.id, out, src: src ?? sha('src:' + run + seed), r };
}
let n = 0;
const sale = (extra = {}) => ({ kind: 'sell', category: 'other', title: `[QA] 같은 매물 ${run} ${++n}`, body: '자동 검증', price: 10000, tags: [], images: [], details: {}, ...extra });
const account = (details, extra = {}) => sale({ category: 'account', details, ...extra });
async function created(c, body, name) {
    const r = await c('posts', 'POST', body);
    assert.equal(r.status, 201, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
}
const post = id => sql(`SELECT bumped_at,created_at,bump_count,relist,hidden,hidden_reason FROM posts WHERE id=${id}`)[0];
const print = id => sql(`SELECT * FROM post_prints WHERE post_id=${id}`)[0];
const setWallet = (c, tokens, at) => sql(`UPDATE users SET bump_tokens=${tokens},bump_at=${at} WHERE id='${c.user.id}'`);
const tokensOf = async c => (await c('me/usage')).data.bumpTokens;
// Moves every print of the member back, as if its listing was completed or deleted `ms` earlier.
const ageListings = (c, ms) => sql(`UPDATE post_prints SET anchor_at=anchor_at-${ms},gone_at=gone_at-${ms} WHERE user_id='${c.user.id}' AND gone_at IS NOT NULL`);
const reportsOf = c => sql(`SELECT details,post_id,reporter_id,status FROM reports WHERE target_user_id='${c.user.id}' AND reason='같은 매물 (자동)'`);

sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%'");
const manager = client(), guest = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
// Earlier runs may have left pending automatic reports; this suite counts its own members' only.

// ---- 2. Uploads: hashes, reuse, lookup ----
const up = await register('up');
const u1 = await upload(up, 'u1');
equal([u1.r.status, u1.r.data.usedIn], [201, []], 'a new photo is stored (201, in no post yet)');
equal(sql(`SELECT hash,src_hash FROM uploads WHERE id='${u1.id}'`)[0], { hash: u1.out, src_hash: u1.src }, 'X-Photo-Hash is stored as hash and src_hash');
const rowsBefore = sql(`SELECT (SELECT COUNT(*) FROM uploads WHERE owner_id='${up.user.id}') AS n,(SELECT COUNT(*) FROM upload_blobs) AS blobs`)[0];
const again = await upload(up, 'u1');
equal([again.r.status, again.id, again.r.data.reused], [200, u1.id, true], 'the same X-Photo-Hash again returns the same id, reused');
equal(sql(`SELECT (SELECT COUNT(*) FROM uploads WHERE owner_id='${up.user.id}') AS n,(SELECT COUNT(*) FROM upload_blobs) AS blobs`)[0], rowsBefore, 'and writes no upload row and no stored bytes');
const bad = await upload(up, 'u2', { header: 'not-a-hash' });
equal(sql(`SELECT hash,src_hash FROM uploads WHERE id='${bad.id}'`)[0], { hash: null, src_hash: null }, 'a malformed X-Photo-Hash is ignored (hash NULL)');
const other = await register('upo');
const o1 = await upload(other, 'o1');
sql(`UPDATE uploads SET touched_at=NULL WHERE id='${u1.id}'`);
const look = await up('uploads/lookup', 'POST', { hashes: [u1.src, o1.src, u1.out, 'zz'] });
equal(look.data.found, { [u1.src]: u1.id, [u1.out]: u1.id }, 'lookup finds the member\'s own photo by its original or its compressed hash, never another member\'s');
check(sql(`SELECT touched_at FROM uploads WHERE id='${u1.id}'`)[0].touched_at > Date.now() - 60000, 'lookup touches touched_at (the unused-photo cleanup counts from it)');
const usedPost = await created(up, sale({ images: [u1.id] }), 'a post with the photo');
const look2 = await up('uploads/lookup', 'POST', { hashes: [u1.src] });
equal(look2.data.usedIn[u1.id]?.map(p => p.id), [usedPost.id], 'lookup names the open posts the photo is in (usedIn)');
equal((await upload(up, 'u1')).r.data.usedIn.map(p => p.id), [usedPost.id], 'a reused upload names them too');
// The cleanup keeps a photo a lookup touched within a day, even when it was uploaded long ago.
const stale = await upload(up, 'stale');
sql(`UPDATE uploads SET created_at=${Date.now() - 3 * DAY},touched_at=${Date.now()} WHERE id='${stale.id}'`);
equal(await fireCron(), 200, 'the daily cron runs');
equal(sql(`SELECT COUNT(*) AS n FROM uploads WHERE id='${stale.id}'`)[0].n, 1, 'an unused photo touched today is kept');

// ---- 3. Relists: a listing deleted within 7 days comes back as a 끌올 ----
const rel = await register('rel');
const photos = [await upload(rel, 'p1'), await upload(rel, 'p2'), await upload(rel, 'p3')];
const P = await created(rel, sale({ title: `[QA] 리스트 A ${run}`, images: photos.map(p => p.id) }), 'P with 3 hashed photos');
const anchorP = post(P.id).created_at;
equal((await rel(`posts/${P.id}`, 'DELETE')).status, 200, 'P is deleted');
const gone = print(P.id);
check(gone.gone_at > Date.now() - 60000 && gone.anchor_at === anchorP, 'the delete trigger stamps gone_at and the anchor (created_at before any 끌올)');
const tokens0 = await tokensOf(rel);
const R1 = await created(rel, sale({ title: `[QA] 리스트 B ${run}`, images: photos.map(p => p.id) }), 'title B with P\'s photos');
equal([R1.placed, R1.bumpedAt, R1.relist, R1.bumpTokens], ['old', anchorP, true, tokens0], 'inside the gap: back at P\'s place, free (old)');
equal([post(R1.id).relist, post(R1.id).bump_count], [1, 1], 'relist=1 and bump_count=1');
check(R1.bumpAt === anchorP + 6 * HOUR, 'it can be bumped 6 hours (일반 gap) after that place');
await rel(`posts/${R1.id}`, 'DELETE');
ageListings(rel, 6 * HOUR + 60000);
const R2 = await created(rel, sale({ title: `[QA] 리스트 C ${run}`, images: photos.map(p => p.id) }), 'after 6h01m');
equal([R2.placed, R2.bumpTokens], ['bump', tokens0 - 1], 'outside the gap: 1 끌올 (bump)');
equal(post(R2.id).bumped_at, post(R2.id).created_at, 'placed at now');
equal(sql(`SELECT COUNT(*) AS n FROM post_events WHERE post_id=${R2.id} AND kind='bump'`)[0].n, 1, 'a bump event is logged');
const top = (await guest(`posts?kind=sell&q=${run}&size=40`)).data.posts.find(p => p.bumped_at <= Date.now());
equal(top?.id, R2.id, 'listed first below 새 글 우선');
await rel(`posts/${R2.id}`, 'DELETE');
ageListings(rel, 6 * HOUR + 60000);
setWallet(rel, 0, Date.now());
const R3 = await created(rel, sale({ title: `[QA] 리스트 D ${run}`, images: photos.map(p => p.id) }), 'wallet empty');
const T = sql(`SELECT MAX(created_at) AS t FROM post_events WHERE user_id='${rel.user.id}' AND kind IN ('fresh','bump')`)[0].t;
const since = sql(`SELECT COUNT(*) AS n FROM post_events WHERE user_id='${rel.user.id}' AND kind='post' AND created_at>${T} AND post_id!=${R3.id}`)[0].n;
equal([R3.placed, R3.bumpedAt], ['last', T - 360 * 60000 * (1 + since)], 'tokens 0: below the latest top time (stepped like a 4th new post)');
await rel(`posts/${R3.id}`, 'DELETE');
ageListings(rel, 6 * HOUR + 60000);
sql(`UPDATE post_events SET created_at=created_at-${3 * DAY} WHERE user_id='${rel.user.id}'`);
const anchorNow = sql(`SELECT MAX(anchor_at) AS a FROM post_prints WHERE user_id='${rel.user.id}' AND gone_at IS NOT NULL`)[0].a;
const R4 = await created(rel, sale({ title: `[QA] 리스트 E ${run}`, images: photos.map(p => p.id) }), 'no top time in 2 days');
equal([R4.placed, R4.bumpedAt], ['last', anchorNow], 'tokens 0 and no 끌올 in 2 days: the listing\'s own place');
// A relist never takes the new-post priority: no 'fresh' event.
equal(sql(`SELECT COUNT(*) AS n FROM post_events WHERE post_id IN (${[R1.id, R2.id, R3.id, R4.id].join(',')}) AND kind='fresh'`)[0].n, 0, 'relists never use the 새 글 allowance');

// Completing also stamps the print.
const closer = await register('close');
const C1 = await created(closer, sale(), 'a post to complete');
equal((await closer(`posts/${C1.id}/status`, 'PATCH', { status: 'closed' })).status, 200, 'completed');
check(print(C1.id).gone_at > Date.now() - 60000 && print(C1.id).anchor_at === post(C1.id).created_at, 'the completion trigger stamps gone_at and the anchor');

// ---- 4. The only refusal: the same listing open ----
const dup = await register('dup');
const dp = [await upload(dup, 'd1'), await upload(dup, 'd2'), await upload(dup, 'd3')];
const D1 = await created(dup, sale({ images: dp.map(p => p.id) }), 'an open post with 3 photos');
const byPhotos = await dup('posts', 'POST', sale({ images: dp.map(p => p.id) }));
refused(byPhotos, 409, '같은 매물의 거래중 글이 있습니다. 그 글을 끌올해 주세요.', 'the same photos under another title');
equal([byPhotos.data.dup.id, byPhotos.data.dup.why, byPhotos.data.dup.same], [D1.id, 'photos', '사진 3장'], 'the 409 names the post: photos, 사진 3장');
check(byPhotos.data.dup.bumpAt > Date.now(), 'and when it can be bumped (새 글 우선 and the gap)');
const fieldsBody = (t) => account({ phantom: '214', humanSkins: '300' }, { title: t, tags: ladder });
await created(dup, fieldsBody(`[QA] 계정 필드 ${run} 하나`), 'an account by fields');
const byFields = await dup('posts', 'POST', fieldsBody(`[QA] 전혀 다른 제목 ${run}`));
refused(byFields, 409, '같은 매물의 거래중 글', 'the same 28챌+30다야, 팬텀 214, 인간 스킨 300 under another title');
equal([byFields.data.dup.why, byFields.data.dup.same], ['fields', '래더·팬텀·인간 스킨'], 'why fields, 같은 점: 래더·팬텀·인간 스킨');
const wantBody = (t, details = {}) => ({ kind: 'buy', category: 'account', title: t, body: '자동 검증', price: null, tags: [{ tier: 'platinum', season: 32 }], images: [], details });
await created(dup, wantBody(`[QA] 32플 구해요 ${run}`), 'a buy want');
refused(await dup('posts', 'POST', wantBody(`[QA] 32시즌 플래 삽니다 ${run}`)), 409, '같은 조건의 거래중 글이 있습니다. 그 글을 끌올해 주세요.', 'the same want twice');
equal((await dup('posts', 'POST', wantBody(`[QA] 32플 유루미 ${run}`, { skinTags: '["유루미"]' }))).status, 201, 'one more condition is another want (201)');
// Hidden by the manager: the message says to edit it.
const H = await created(dup, sale({ title: `[QA] 숨김 ${run}` }), 'a post to hide');
equal((await manager('manage/visibility', 'POST', { postId: H.id, hidden: true, reason: '허위 매물' })).status, 200, 'the manager hides it');
const hiddenDup = await dup('posts', 'POST', sale({ title: `[QA] 숨김 ${run}` }));
refused(hiddenDup, 409, '숨김 처리된 같은 매물 글이 있습니다. 그 글을 수정해 주세요.', 'the same title as a hidden open post');
equal([hiddenDup.data.dup.hidden, hiddenDup.data.dup.bumpAt], [true, null], 'with no 끌올 offered');

// ---- 5. Vendors' near-misses pass ----
const vendor = await register('vend');
const vbanner = await upload(vendor, 'banner');
for (let i = 0; i < 5; i++) {
    const shots = [await upload(vendor, `v${i}a`), await upload(vendor, `v${i}b`)];
    await created(vendor, account({ phantom: String(100 + i) }, { title: `[QA] 계정 판매 ${run} ${i}번`, images: [vbanner.id, ...shots.map(s => s.id)] }), `vendor post ${i + 1}`);
}
check(true, '5 account posts sharing one banner with 2 own screenshots and distinct 팬텀 are all created');
const v2 = await register('vend2');
await created(v2, account({ phantom: '214' }, { title: `[QA] 같은 제목 ${run}` }), 'title with 팬텀 214');
await created(v2, account({ phantom: '180' }, { title: `[QA] 같은 제목 ${run}` }), 'the same title with 팬텀 180 (201)');
await created(v2, sale({ title: `[QA] 내용 없음 ${run}` }), 'a title with no details');
const titleDup = await v2('posts', 'POST', sale({ title: `[QA] 내용  없음! ${run}` }));
refused(titleDup, 409, '같은 제목의 거래중 글이 있습니다. 그 글을 끌올해 주세요.', 'the same title with no details');
equal(titleDup.data.dup.why, 'title', 'why title');
const cb = await upload(v2, 'cbanner');
const coupon = name => sale({ category: 'goods_coupon', title: `[QA] 쿠폰 ${name} ${run}`, images: [cb.id], details: { couponName: name } });
await created(v2, coupon('유루미 스쿺'), 'a coupon with the banner');
await created(v2, coupon('코믹스 1권 미쿺'), 'another coupon with only the banner and another name (201)');

// ---- 6. The 새 글 allowance ----
const al = await register('allow');
const fresh = [];
for (let i = 0; i < 3; i++) fresh.push(await created(al, sale(), `new post ${i + 1}`));
equal(fresh.map(f => f.placed), ['fresh', 'fresh', 'fresh'], 'the first 3 new posts are fresh');
equal(fresh.map(f => post(f.id).bumped_at - post(f.id).created_at), [HOUR, HOUR, HOUR], 'each sits 1 hour ahead (now + 1h)');
equal(sql(`SELECT COUNT(*) AS n FROM post_events WHERE user_id='${al.user.id}' AND kind='fresh'`)[0].n, 3, 'three fresh rows');
const fourth = await created(al, sale(), 'the 4th');
equal([fourth.placed, fourth.bumpTokens, post(fourth.id).bumped_at - post(fourth.id).created_at], ['bump', 2, 0], 'the 4th: 1 끌올, at now');
setWallet(al, 0, Date.now());
const fifth = await created(al, sale(), 'the 5th, wallet empty');
const lastTop = sql(`SELECT MAX(created_at) AS t FROM post_events WHERE user_id='${al.user.id}' AND kind IN ('fresh','bump')`)[0].t;
equal([fifth.placed, fifth.bumpedAt], ['last', lastTop - 360 * 60000], 'with the wallet empty: below the latest top time');
equal((await al('me/usage')).data.freshToday, 3, 'usage.freshToday is 3');
// Display: a fresh post reads as new, not '끌올'.
const listed = (await guest(`posts?author=${al.user.id}&size=10`)).data.posts.find(p => p.id === fresh[0].id);
equal([listed.bump_count, listed.bumped_at > Date.now()], [0, true], 'GET /posts: the fresh post has bump_count 0 and sits ahead of now');
const freshPlace = post(fresh[0].id).bumped_at;
refused(await al(`posts/${fresh[0].id}/bump`, 'POST'), 429, '끌올', 'a fresh post is not bumped');
equal(post(fresh[0].id).bumped_at, freshPlace, 'and keeps its place');

// ---- 7. Edits ----
const ed = await register('edit');
const ep = [await upload(ed, 'e1'), await upload(ed, 'e2'), await upload(ed, 'e3')];
const Q = await created(ed, sale({ images: ep.map(p => p.id) }), 'Q with photos');
await ed(`posts/${Q.id}`, 'DELETE');
const anchorQ = print(Q.id).anchor_at;
const F = await created(ed, sale(), 'a fresh decoy');
const moved = await ed(`posts/${F.id}`, 'PUT', sale({ title: `[QA] 고친 제목 ${run}`, images: ep.map(p => p.id) }));
equal([moved.status, moved.data.notice], [200, '같은 매물이라 이전 자리로 옮겼습니다.'], 'a < 24h post edited into a deleted listing is moved');
equal([post(F.id).bumped_at, post(F.id).relist, post(F.id).bump_count], [anchorQ, 1, 1], 'to that listing\'s place (relist 1)');
const gp = [await upload(ed, 'g1'), await upload(ed, 'g2')];
const G = await created(ed, sale({ images: gp.map(p => p.id) }), 'an open listing G');
const F2 = await created(ed, sale(), 'another post');
const intoOpen = await ed(`posts/${F2.id}`, 'PUT', sale({ title: `[QA] 다른 제목 ${run}`, images: gp.map(p => p.id) }));
refused(intoOpen, 409, '같은 매물의 거래중 글', 'an edit into an open listing');
equal(intoOpen.data.dup.id, G.id, 'naming G');
const qp = [await upload(ed, 'q1'), await upload(ed, 'q2')];
const Q2 = await created(ed, sale({ images: qp.map(p => p.id) }), 'Q2');
await ed(`posts/${Q2.id}`, 'DELETE');
const Old = await created(ed, sale(), 'a post to age');
sql(`UPDATE posts SET created_at=created_at-${2 * DAY},bumped_at=bumped_at-${2 * DAY} WHERE id=${Old.id}`);
const oldBefore = post(Old.id).bumped_at;
equal((await ed(`posts/${Old.id}`, 'PUT', sale({ title: `[QA] 오래된 글 ${run}`, images: qp.map(p => p.id) }))).status, 200, 'a 2-day-old post edited into a deleted listing');
equal([post(Old.id).bumped_at, post(Old.id).relist], [oldBefore, 0], 'keeps its place');
equal(JSON.parse(print(Old.id).photos).length, 2, 'the edit updates the print');

// ---- 8. A relist of a hidden listing is created hidden ----
const hid = await register('hide');
const hp = [await upload(hid, 'h1'), await upload(hid, 'h2')];
const K = await created(hid, sale({ images: hp.map(p => p.id) }), 'K');
await manager('manage/visibility', 'POST', { postId: K.id, hidden: true, reason: '도배·중복 글' });
await hid(`posts/${K.id}`, 'DELETE');
equal([print(K.id).hidden, print(K.id).hidden_reason], [1, '도배·중복 글'], 'the print keeps the hiding');
const K2 = await created(hid, sale({ images: hp.map(p => p.id) }), 'a relist of K');
equal([K2.hidden, post(K2.id).hidden, post(K2.id).hidden_reason], [true, 1, '도배·중복 글 (같은 매물 다시 등록)'], 'created hidden with the reason copied');

// ---- 9. Cross-account flags (never block) ----
const A = await register('ca'), B = await register('cb');
const ap = await upload(A, 'a1');
const AP = await created(A, sale({ images: [ap.id] }), 'A posts a photo');
const bp = await upload(B, 'b1', { src: ap.out });
const BP = await created(B, sale({ images: [bp.id] }), 'B posts A\'s photo (src = A\'s hash): created');
equal(reportsOf(B).map(r => [r.details, r.reporter_id, r.status, r.post_id]), [[`다른 회원 글 #${AP.id} · 같은 사진 1장`, 'manager', 'pending', BP.id]], 'one pending report about B');
// (The same photo with 2 more is not B's own same listing: 1 shared of 3.)
const more = [await upload(B, 'b2'), await upload(B, 'b3')];
await created(B, sale({ images: [bp.id, ...more.map(m => m.id)] }), 'B\'s second such post');
equal(reportsOf(B).length, 1, 'still one pending report');
// A resale: A's post completed with a trade naming C as buyer.
const A2 = await register('ca2'), Cc = await register('cc');
const a2p = await upload(A2, 'a2');
const A2P = await created(A2, sale({ images: [a2p.id] }), 'A2 posts');
const chat = (await Cc('chats', 'POST', { userId: A2.user.id, postId: A2P.id })).data.id;
equal((await Cc(`chats/${chat}/messages`, 'POST', { body: '구매 원합니다', postId: A2P.id })).status, 201, 'C asks');
equal((await A2(`posts/${A2P.id}/status`, 'PATCH', { status: 'closed', partnerId: Cc.user.id })).status, 200, 'A2 completes naming C');
const cp = await upload(Cc, 'c1', { src: a2p.out });
await created(Cc, sale({ images: [cp.id] }), 'C resells with A2\'s photo');
equal(reportsOf(Cc).length, 0, 'a resale raises no report');
// An image used by 3 members is a shared banner.
const D = await register('cd'), E = await register('ce'), Fm = await register('cf');
const shared = sha('banner:' + run);
for (const [c, s] of [[D, 'dd'], [E, 'ee']]) {
    const x = await upload(c, s, { src: shared });
    await created(c, sale({ images: [x.id] }), 'a banner post');
}
const fx = await upload(Fm, 'ff', { src: shared });
await created(Fm, sale({ images: [fx.id] }), 'a third member with the banner');
equal(reportsOf(Fm).length, 0, 'a hash used by 3 owners raises no report');
// The same account fields on another member.
const accountFields = { phantom: '777', level: '88', gas: '12345', closet: '41' };
const G1 = await register('cg1'), G2 = await register('cg2');
const G1P = await created(G1, account(accountFields), 'an account with 4 distinctive fields');
await created(G2, account(accountFields), 'the same account by another member');
equal(reportsOf(G2).map(r => r.details), [`다른 회원 글 #${G1P.id} · 같은 계정 정보`], 'one report: 같은 계정 정보');
// A relist after a recorded sale.
const S = await register('cs'), Bu = await register('cbu');
const sp = [await upload(S, 's1'), await upload(S, 's2')];
const SP = await created(S, sale({ images: sp.map(p => p.id) }), 'S sells');
const schat = (await Bu('chats', 'POST', { userId: S.user.id, postId: SP.id })).data.id;
await Bu(`chats/${schat}/messages`, 'POST', { body: '살게요', postId: SP.id });
equal((await S(`posts/${SP.id}/status`, 'PATCH', { status: 'closed', partnerId: Bu.user.id })).status, 200, 'S completes naming the buyer');
const SR = await created(S, sale({ images: sp.map(p => p.id) }), 'S posts the sold listing again');
equal(SR.relist, true, 'a relist');
equal(reportsOf(S).map(r => r.details), [`거래완료 글 #${SP.id} (구매자 지정) · 같은 매물`], 'flagged: 거래완료 글 (구매자 지정) · 같은 매물');

// ---- 10. Daily cleanup of prints ----
const cl = await register('clean');
const old = await created(cl, sale(), 'a post whose print will expire');
await cl(`posts/${old.id}`, 'DELETE');
sql(`UPDATE post_prints SET gone_at=${Date.now() - 8 * DAY} WHERE post_id=${old.id}`);
const raw = await created(cl, account({ phantom: '321', level: '77', gas: '999', closet: '12' }, { tags: ladder }), 'an account post');
sql(`UPDATE post_prints SET fields=NULL,fields_hash=NULL,photos='[]',title_key='' WHERE post_id=${raw.id}`);
equal(await fireCron(), 200, 'the daily cron runs');
equal(print(old.id), undefined, 'a print gone more than 7 days ago is removed');
const filled = print(raw.id);
check(filled.fields && JSON.parse(filled.fields).m === 'acct' && filled.fields_hash && filled.title_key, 'a NULL print gets its fields, fields hash and title key');

// ---- 11. The manager skips every rule; the create budget ----
const mp = await upload(manager, 'm1');
const M1 = await manager('posts', 'POST', sale({ title: `[QA] 매니저 ${run}`, images: [mp.id] }));
const M2 = await manager('posts', 'POST', sale({ title: `[QA] 매니저 ${run}`, images: [mp.id] }));
equal([M1.status, M2.status, M2.data.placed], [201, 201, 'fresh'], 'the manager posts the same listing twice');
for (const r of [M1, M2]) await manager(`posts/${r.data.id}`, 'DELETE');
const bud = await register('budget');
sql('DELETE FROM post_prints WHERE post_id<=-1000000');
sql(`INSERT INTO post_prints(post_id,user_id,kind,category,title_key,fields,photos) SELECT -1000000-value,'${bud.user.id}','sell','other','seed'||value,'{"m":"none","d":{},"s":{}}','[]' FROM json_each('${JSON.stringify(Array.from({ length: 400 }, (_, i) => i))}')`);
const bph = [await upload(bud, 'bb1'), await upload(bud, 'bb2')];
const metered = await bud('posts', 'POST', account({ phantom: '1', level: '2', gas: '3', closet: '4' }, { images: bph.map(p => p.id) }));
equal(metered.status, 201, 'a create with photos and account fields');
check(metered.calls <= 8, `create: ${metered.calls} D1 calls (≤ 8)`);
check(metered.rows < 1000, `create reads ${metered.rows} rows with 400 prints on file (the matcher reads at most 300)`);
sql(`DELETE FROM post_prints WHERE user_id='${bud.user.id}' AND post_id<0`);

console.log(`\n${checks} 같은 매물 checks passed`);
