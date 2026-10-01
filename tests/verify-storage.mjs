import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Photo storage without R2 or KV: bytes are kept in D1 (upload_blobs). Also the parts of WP45 that need
// the D1 server with the cron: inline thumbnails, Cache-Control, the D1 guards, retention and the delete
// hold. scripts/test-local.mjs runs this on 8791 (no R2, no KV, --test-scheduled, TEST_HOOKS=on).
const base = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791').origin;
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base), 'Local Worker origin required.');
const root = fileURLToPath(new URL('..', import.meta.url));
const DAY = 86400000, MB = 1024 * 1024;
let checks = 0;
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }
function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }

function client() {
    let cookie = '';
    return async (path, method = 'GET', data, raw, headers = {}) => {
        // A kept-alive socket the dev server closed after a cron request fails once; the retry opens a new one.
        const send = () => fetch(base + '/api/' + path, {
            method, signal: AbortSignal.timeout(30000),
            headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(raw ? { 'Content-Type': raw.type } : data ? { 'Content-Type': 'application/json' } : {}) },
            body: raw ? raw.bytes : data ? JSON.stringify(data) : undefined,
        });
        const r = await send().catch(e => { if (e?.cause?.code === 'UND_ERR_SOCKET') return send(); throw e; });
        const s = r.headers.get('set-cookie');
        if (s) cookie = s.split(';')[0];
        const out = { status: r.status, cache: r.headers.get('cache-control') || '' };
        return (r.headers.get('content-type') || '').includes('json') ? { ...out, data: await r.json() } : { ...out, bytes: new Uint8Array(await r.arrayBuffer()) };
    };
}
function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc', '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
// The daily cron on its own connection each time (the dev server may drop a kept-alive socket, and a
// stuck request is retried after 30 s).
function fireCron(attempt = 1) {
    return new Promise((resolve, reject) => {
        const req = http.get(base + '/cdn-cgi/handler/scheduled?cron=17+18+*+*+*', { agent: false, timeout: 30000 }, res => {
            res.resume();
            res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('scheduled cleanup answered ' + res.statusCode)));
        });
        req.on('timeout', () => req.destroy(new Error('scheduled cleanup timed out')));
        req.on('error', e => attempt < 3 ? fireCron(attempt + 1).then(resolve, reject) : reject(e));
    });
}
// Runs the daily cron until `done()` holds (other runs' leftovers share each run's limits).
async function cronUntil(done, times = 30) {
    for (let i = 0; i < times && !done(); i++) await fireCron();
    return done();
}

const call = client();
const run = randomBytes(4).toString('hex');
assert.equal((await call('auth/register', 'POST', { username: 'st_' + run, password: randomBytes(12).toString('hex'), nickname: '저장' + run })).status, 200);
// A valid PNG signature followed by filler bytes (about 300 KB).
const png = new Uint8Array(300_000);
png.set([137, 80, 78, 71, 13, 10, 26, 10]);
for (let i = 8; i < png.length; i++) png[i] = i % 251;
const up = await call('uploads', 'POST', undefined, { type: 'image/png', bytes: png });
equal(up.status, 201, 'upload stored without R2');
equal(sql(`SELECT storage FROM uploads WHERE id='${up.data.id}'`)[0].storage, 'd1', 'the photo is in D1');
const got = await call('images/' + up.data.id);
equal(got.status, 200, 'owner can read the D1-stored photo');
equal(Buffer.compare(Buffer.from(got.bytes), Buffer.from(png)), 0, 'D1-stored bytes round-trip exactly');
equal(got.cache, 'private, no-store', 'a photo no visible post uses is never stored by the browser');
const big = new Uint8Array(2_000_000);
big.set([137, 80, 78, 71, 13, 10, 26, 10]);
equal((await call('uploads', 'POST', undefined, { type: 'image/png', bytes: big })).status, 413, 'photos above the D1 row limit are rejected');
equal((await call('uploads/' + up.data.id, 'DELETE')).status, 200, 'unused D1 photo can be deleted');
const missing = await call('images/' + up.data.id);
equal([missing.status, missing.cache.includes('no-store')], [404, true], 'a missing photo is 404 with no-store');

// Without R2, photos share the 500 MB database: 30 MB per member, 300 MB for the site, and no D1 photo
// writes once the database passes 420 MB.
const me = (await call('auth/me')).data.user;
const small = png.slice(0, 1000);
try {
    sql(`INSERT INTO uploads (id,owner_id,mime,size,storage,created_at) VALUES ('budget-${run}','${me.id}','image/png',${30 * MB},'d1',${Date.now()})`);
    const over = await call('uploads', 'POST', undefined, { type: 'image/png', bytes: small });
    equal([over.status, over.data.error.includes('30MB')], [409, true], 'per-member D1 photo budget (30MB)');
    sql(`UPDATE uploads SET owner_id='manager',size=${300 * MB} WHERE id='budget-${run}'`);
    const site = await call('uploads', 'POST', undefined, { type: 'image/png', bytes: small });
    equal([site.status, site.data.error], [507, '사진 저장 공간이 부족합니다. 매니저에게 문의해 주세요.'], 'site-wide D1 photo budget');
} finally {
    sql(`DELETE FROM uploads WHERE id='budget-${run}'`);
}
const guard = await call('uploads', 'POST', undefined, { type: 'image/png', bytes: small }, { 'X-Test-Db-Bytes': String(421 * MB) });
equal([guard.status, guard.data.error], [507, '사진 저장 공간이 부족합니다. 매니저에게 문의해 주세요.'], 'no D1 photo writes above 420MB of database');
equal((await call('uploads', 'POST', undefined, { type: 'image/png', bytes: small })).status, 201, 'uploads work again once space is freed');
const usage = await call('uploads/usage');
equal([usage.status, usage.data.storage, usage.data.limit], [200, 'd1', 30 * MB], 'uploads/usage gives the D1 budget');
check(usage.data.used >= 1000, 'uploads/usage counts the member\'s D1 photos');

// Inline thumbnails (WP45): only a small WebP data URI is stored, and lists return it.
const photo = async () => (await call('uploads', 'POST', undefined, { type: 'image/png', bytes: small })).data.id;
const thumb = 'data:image/webp;base64,UklGRg==';
const post = (title, images, extra = {}) => call('posts', 'POST', { kind: 'sell', category: 'other', title, body: '자동 검증', price: 10000, tags: [], details: {}, images, ...extra });
const p0 = await photo();
const withThumb = await post(`[QA] 썸네일 ${run}`, [p0], { thumb });
equal(withThumb.status, 201, 'a post saves with a thumbnail');
const row = (await call(`posts?author=${me.id}&size=20`)).data.posts.find(p => p.id === withThumb.data.id);
equal(row.thumb, thumb, 'the list row carries the thumbnail');
const bad = await post(`[QA] 썸네일 나쁨 ${run}`, [p0], { thumb: 'javascript:alert(1)' });
equal([bad.status, bad.data.error], [400, '사진을 다시 선택해 주세요.'], 'a thumbnail that is not a WebP data URI is refused');
equal((await post(`[QA] 썸네일 김 ${run}`, [p0], { thumb: 'data:image/webp;base64,' + 'A'.repeat(6001 - 23) })).status, 400, 'a 6,001-character thumbnail is refused');
const edited = await call('posts/' + withThumb.data.id, 'PUT', { kind: 'sell', category: 'other', title: `[QA] 썸네일 ${run}`, body: '수정', price: 10000, tags: [], details: {}, images: [p0] });
equal(edited.status, 200, 'an edit without a thumbnail saves');
equal(sql(`SELECT thumb FROM posts WHERE id=${withThumb.data.id}`)[0].thumb, thumb, 'the thumbnail stays while the 대표 is the same');
const pub = await call('images/' + p0);
check(pub.status === 200 && pub.cache.includes('private') && pub.cache.includes('immutable'), 'a photo of a visible post is cached private and immutable');

// Retention (WP45): 90 days after 완료 only the 대표 stays; a pending report keeps everything.
const DONE_AT = Date.now() - 91 * DAY;
const closedPost = async (title) => {
    const ids = [await photo(), await photo(), await photo()];
    const r = await post(title, ids, { thumb });
    assert.equal(r.status, 201, title);
    assert.equal((await call(`posts/${r.data.id}/status`, 'PATCH', { status: 'closed' })).status, 200, 'complete ' + title);
    sql(`UPDATE posts SET closed_at=${DONE_AT} WHERE id=${r.data.id}`);
    return { id: r.data.id, ids };
};
const kept = await closedPost(`[QA] 보관 ${run}`), reported = await closedPost(`[QA] 신고 보관 ${run}`);
sql(`INSERT INTO reports (post_id,reporter_id,reason,details,status,created_at) VALUES (${reported.id},'manager','기타','자동 검증','pending',${Date.now()})`);
const images = id => JSON.parse(sql(`SELECT images FROM posts WHERE id=${id}`)[0].images);
check(await cronUntil(() => images(kept.id).length === 1, 10), 'the daily cron trims the completed post');
equal(images(kept.id), [kept.ids[0]], 'only the old 대표 stays on the post');
equal(sql(`SELECT upload_id FROM post_images WHERE post_id=${kept.id}`).map(r => r.upload_id), [kept.ids[0]], 'post_images keeps one row');
equal(sql(`SELECT thumb FROM posts WHERE id=${kept.id}`)[0].thumb, null, 'the thumbnail of a post completed 90 days ago is cleared');
equal(images(reported.id), reported.ids, 'a post with a pending report keeps every photo');
sql(`UPDATE uploads SET created_at=${Date.now() - 2 * DAY} WHERE id IN ('${kept.ids.join("','")}')`);
const left = () => sql(`SELECT id FROM uploads WHERE id IN ('${kept.ids.join("','")}')`).map(r => r.id);
check(await cronUntil(() => left().length === 1), 'the next passes remove the freed photos');
equal(left(), [kept.ids[0]], 'the 대표 photo stays');

// The delete hold: a deleted post's photos stay 30 days for the manager (and on its report).
const held = await photo();
const doomed = await post(`[QA] 삭제 보관 ${run}`, [held]);
sql(`INSERT INTO reports (post_id,reporter_id,reason,details,status,created_at) VALUES (${doomed.data.id},'manager','기타','자동 검증','pending',${Date.now()})`);
equal((await call('posts/' + doomed.data.id, 'DELETE')).status, 200, 'the author deletes the post');
check(sql(`SELECT keep_until FROM uploads WHERE id='${held}'`)[0].keep_until > Date.now() + 29 * DAY, 'its photo is held for 30 days');
equal(JSON.parse(sql(`SELECT post_images FROM reports WHERE details='자동 검증' AND post_images LIKE '%${held}%'`)[0].post_images), [held], 'the report keeps the photo ids');
equal((await call('uploads/' + held, 'DELETE')).status, 409, 'the member cannot remove a held photo');
const manager = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: process.env.TEST_MANAGER_PASSWORD || 'local-manager-password' })).status, 200, 'manager logs in');
equal((await manager('images/' + held)).status, 200, 'the manager can open the held photo');
sql(`UPDATE uploads SET created_at=${Date.now() - 2 * DAY} WHERE id='${held}'`);
await fireCron();
equal(sql(`SELECT COUNT(*) AS n FROM uploads WHERE id='${held}'`)[0].n, 1, 'the cleanup keeps a held photo');
sql(`UPDATE uploads SET keep_until=${Date.now() - 1000} WHERE id='${held}'`);
check(await cronUntil(() => sql(`SELECT COUNT(*) AS n FROM uploads WHERE id='${held}'`)[0].n === 0), 'once the hold ends the photo is removed');
sql(`DELETE FROM reports WHERE details='자동 검증' AND reporter_id='manager' AND post_id IS NULL`);
sql(`UPDATE reports SET status='resolved' WHERE post_id=${reported.id}`);
console.log(`PASS D1 photo storage, budgets, thumbnails, caching, retention and the delete hold (${checks} checks)`);
