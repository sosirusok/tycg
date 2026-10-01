import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// R2 mode (WP45). TEST_PHASE=main runs on 8790 (R2 bound): the 1GB per member budget, the site guards,
// 조회수 inside GET posts/:id?view=1, manage/storage and caching. TEST_PHASE=mover runs on a short-lived
// 8791 server with both R2 and KV bound (no assets, --test-scheduled, TEST_HOOKS=on): the R2 mover.
const base = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790').origin;
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base), 'Local Worker origin required.');
const phase = process.env.TEST_PHASE || 'main';
const root = fileURLToPath(new URL('..', import.meta.url));
const MB = 1024 * 1024, GB = 1024 * MB;
const FULL = '사진 저장 공간이 부족합니다. 매니저에게 문의해 주세요.';
const DAILY = '오늘 사진 올리기 한도를 넘었습니다. 매니저에게 문의해 주세요.';
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
const setSetting = (key, value) => sql(`INSERT INTO settings(key,value,updated_at) VALUES('${key}','${value}',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
const run = randomBytes(4).toString('hex');
const password = randomBytes(12).toString('hex');
async function member(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `pa_${run}_${name}`, password, nickname: `${name}${run}` });
    assert.equal(r.status, 200, 'register ' + name);
    return { call: c, user: r.data.user };
}
const png = new Uint8Array(50_000);
png.set([137, 80, 78, 71, 13, 10, 26, 10]);
for (let i = 8; i < png.length; i++) png[i] = (i * 13) % 251;
const small = png.slice(0, 1000);
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
const storageOf = id => sql(`SELECT storage FROM uploads WHERE id='${id}'`)[0]?.storage;

if (phase === 'main') {
    const a = await member('a'), b = await member('b'), guest = client(), guest2 = client();
    const upload = (c, bytes = small) => c('uploads', 'POST', undefined, { type: 'image/png', bytes });
    equal((await a.call('config')).data.storage, 'r2', 'config says photos go to R2');
    const first = await upload(a.call, png);
    equal([first.status, storageOf(first.data.id)], [201, 'r2'], 'an upload goes to R2');

    // 1GB per member on R2.
    try {
        sql(`INSERT INTO uploads (id,owner_id,mime,size,storage,created_at) VALUES ('r2budget-${run}','${a.user.id}','image/png',${GB - 10},'r2',${Date.now()})`);
        const over = await upload(a.call);
        equal([over.status, over.data.error.includes('1GB')], [409, true], 'per-member R2 photo budget (1GB)');
    } finally { sql(`DELETE FROM uploads WHERE id='r2budget-${run}'`); }

    // The site guards: the manager's stop (settings 'sys:r2_site_bytes') and 25,000 puts a UTC day.
    try {
        setSetting('sys:r2_site_bytes', '1');
        const stop = await upload(b.call);
        equal([stop.status, stop.data.error], [507, FULL], 'the R2 site stop refuses uploads');
    } finally { sql("DELETE FROM settings WHERE key='sys:r2_site_bytes'"); }
    try {
        setSetting('sys:r2_puts', `${new Date().toISOString().slice(0, 10)}:25000`);
        const daily = await upload(b.call);
        equal([daily.status, daily.data.error], [507, DAILY], 'the 25,000 daily R2 uploads refuse the next one');
    } finally { sql("DELETE FROM settings WHERE key='sys:r2_puts'"); }
    equal((await upload(b.call)).status, 201, 'uploads work again under the guards');

    // 조회수: a member counts once per 6 hours, the author never, a guest once per address and day.
    const post = await a.call('posts', 'POST', { kind: 'sell', category: 'other', title: `[QA] 조회 ${run}`, body: '자동 검증', price: 10000, tags: [], details: {}, images: [first.data.id] });
    equal(post.status, 201, 'A creates a post');
    const id = post.data.id, views = () => sql(`SELECT view_count FROM posts WHERE id=${id}`)[0].view_count;
    equal((await b.call(`posts/${id}?view=1`)).data.post.view_count, 1, 'B\'s first view counts and is returned');
    await b.call(`posts/${id}?view=1`);
    equal(views(), 1, 'B again within 6 hours does not count');
    await a.call(`posts/${id}?view=1`);
    equal(views(), 1, 'the author never counts');
    await guest(`posts/${id}?view=1`);
    equal(views(), 2, 'a guest counts');
    await guest2(`posts/${id}?view=1`);
    equal(views(), 2, 'the same guest address again does not count');
    await b.call(`posts/${id}`);
    await guest(`posts/${id}`);
    equal(views(), 2, 'a GET without view=1 never counts');
    equal(sql(`SELECT COUNT(*) AS n FROM history WHERE user_id='${b.user.id}' AND post_id=${id}`)[0].n, 1, 'the view keeps B\'s 최근 본 글 row');
    equal((await b.call(`posts/${id}/view`, 'POST', {})).status, 200, 'the old view call still answers');
    equal(views(), 2, 'and it dedupes the same way');

    const pub = await guest('images/' + first.data.id);
    check(pub.status === 200 && pub.cache === 'private, max-age=31536000, immutable', 'a public R2 photo is cached private and immutable');

    const manager = client();
    equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: process.env.TEST_MANAGER_PASSWORD || 'local-manager-password' })).status, 200, 'manager logs in');
    const report = await manager('manage/storage');
    equal([report.status, report.data.mode, report.data.r2Limit], [200, 'r2', 20 * GB], 'manage/storage reports R2 mode');
    check(report.data.dbBytes > 0 && report.data.r2Bytes > 0, 'manage/storage gives the database size and the R2 total');
    equal((await a.call('manage/storage')).status, 403, 'a member gets 403 for manage/storage');
    equal((await manager('manage/storage', 'PUT', { r2LimitGB: 25 })).data.r2Limit, 25 * GB, 'the manager moves the R2 stop');
    sql("DELETE FROM settings WHERE key='sys:r2_site_bytes'");
} else {
    // The R2 mover: KV rows first (then D1) are copied into R2 by the daily cron and still serve.
    const a = await member('m');
    const upload = (storage, bytes) => a.call('uploads', 'POST', undefined, { type: 'image/png', bytes }, { 'X-Test-Storage': storage });
    const bytes = [png.slice(0, 2000), png.slice(0, 3000)];
    const kv1 = await upload('kv', bytes[0]), kv2 = await upload('kv', bytes[1]);
    equal([storageOf(kv1.data.id), storageOf(kv2.data.id)], ['kv', 'kv'], 'two KV rows before the mover');
    const ids = [kv1.data.id, kv2.data.id];
    const allR2 = () => ids.every(i => storageOf(i) === 'r2');
    for (let i = 0; i < 30 && !allR2(); i++) await fireCron();
    check(allR2(), 'the mover moves them to R2');
    for (const [i, id] of ids.entries()) {
        const got = await a.call('images/' + id);
        equal([got.status, Buffer.compare(Buffer.from(got.bytes), Buffer.from(bytes[i]))], [200, 0], `moved photo ${i + 1} still serves the same bytes`);
    }
    // D1 rows follow KV rows: each run moves up to 3 photos, KV first and at most 1 D1 photo (its base64
    // text is read on its own), and their D1 bytes go.
    const d1 = await upload('d1', png.slice(0, 5000));
    equal(storageOf(d1.data.id), 'd1', 'a D1 row before the mover');
    const count = s => sql(`SELECT COUNT(*) AS n FROM uploads WHERE storage='${s}'`)[0].n;
    const movable = () => count('kv') + count('d1');
    const before = movable(), expected = Math.min(3, Math.min(3, count('kv')) + Math.min(1, count('d1')));
    await fireCron();
    check(movable() === before - expected, `one run moves ${expected} more photos (KV first, at most 1 D1)`);
    const moved = sql("SELECT u.id,b.id AS blob FROM uploads u LEFT JOIN upload_blobs b ON b.id=u.id WHERE u.storage='r2' AND u.created_at>" + (Date.now() - 3600000));
    check(moved.every(r => r.blob === null), 'moved rows keep no D1 copy');
    // The old KV copies go through kv_trash (the KV delete budget), and later runs delete them.
    const kvHas = id => {
        try {
            // 'Value not found' (exit 0) when the key is absent.
            const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'kv', 'key', 'get', 'uploads/' + id, '--binding', 'PHOTOS', '--local', '--config', 'dist/zombiego_market/wrangler.mover.json',
                '--persist-to', process.env.TEST_PERSIST || '.wrangler/state'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
            return !out.includes('Value not found');
        } catch { return false; }
    };
    const trashed = () => sql(`SELECT COUNT(*) AS n FROM kv_trash WHERE id IN ('${kv1.data.id}','${kv2.data.id}')`)[0].n;
    for (let i = 0; i < 30 && trashed() > 0; i++) {
        await fireCron();
    }
    check(trashed() === 0 && !kvHas(kv1.data.id) && !kvHas(kv2.data.id), 'the old KV copies are deleted through kv_trash');
    equal(sql("SELECT storage,bytes FROM upload_totals WHERE storage='r2'")[0]?.storage, 'r2', 'upload_totals follows the move');
}
console.log(`PASS R2 parity, ${phase} phase (${checks} checks)`);
