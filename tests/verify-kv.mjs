import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// KV photo storage (WP45): R2 off, the PHOTOS namespace bound. scripts/test-local.mjs runs this on a
// short-lived 8791 server (no R2, no assets, --test-scheduled) twice: TEST_PHASE=main, then
// TEST_PHASE=fail with KV_TEST_FAIL=on (every KV put and delete throws).
const base = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791').origin;
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base), 'Local Worker origin required.');
const phase = process.env.TEST_PHASE || 'main';
const root = fileURLToPath(new URL('..', import.meta.url));
const DAY = 86400000, MB = 1024 * 1024;
const FULL = '사진 저장 공간이 부족합니다. 매니저에게 문의해 주세요.';
let checks = 0;
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }
function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }

function client() {
    let cookie = '';
    return async (path, method = 'GET', data, raw) => {
        // A kept-alive socket the dev server closed after a cron request fails once; the retry opens a new one.
        const send = () => fetch(base + '/api/' + path, {
            method, signal: AbortSignal.timeout(30000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(raw ? { 'Content-Type': raw.type } : data ? { 'Content-Type': 'application/json' } : {}) },
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
// The local KV value of a photo, read straight from the persisted state.
function kvHas(id) {
    try {
        // 'Value not found' (exit 0) when the key is absent.
        const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'kv', 'key', 'get', 'uploads/' + id, '--binding', 'PHOTOS', '--local', '--config', 'dist/zombiego_market/wrangler.kv.json',
            '--persist-to', process.env.TEST_PERSIST || '.wrangler/state'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
        return !out.includes('Value not found');
    } catch { return false; }
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
async function cronUntil(done, times = 30) {
    for (let i = 0; i < times && !done(); i++) await fireCron();
    return done();
}
const today = () => new Date().toISOString().slice(0, 10);

const call = client();
const run = randomBytes(4).toString('hex');
assert.equal((await call('auth/register', 'POST', { username: 'kv_' + run, password: randomBytes(12).toString('hex'), nickname: '케이' + run })).status, 200);
const me = (await call('auth/me')).data.user;
const png = new Uint8Array(200_000);
png.set([137, 80, 78, 71, 13, 10, 26, 10]);
for (let i = 8; i < png.length; i++) png[i] = (i * 7) % 251;
const small = png.slice(0, 1000);
const upload = bytes => call('uploads', 'POST', undefined, { type: 'image/png', bytes });
const storageOf = id => sql(`SELECT storage FROM uploads WHERE id='${id}'`)[0]?.storage;

if (phase === 'main') {
    // Static: the deploy finds the namespace before it creates one, retries the listing and stops (never
    // drops a namespace in use) when it still cannot read it; only a failed create goes on without KV.
    const yml = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
    const step = yml.slice(yml.indexOf('- name: Find or create the KV namespace'), yml.indexOf('- name: Put real ids into wrangler.jsonc'));
    check(!step.includes('continue-on-error'), 'deploy.yml: a KV listing failure is not ignored');
    check(/for attempt in 1 2 3; do\s+if kv="\$\(find_kv\)"/.test(step) && step.includes('::error::KV 저장소 목록을 확인하지 못했습니다.') && step.includes('USE_KV를 false로'), 'deploy.yml: the listing is retried, then the deploy stops with a Korean error');
    check(step.indexOf('kv namespace list') > 0 && step.indexOf('kv namespace list') < step.indexOf('kv namespace create'), 'deploy.yml: the namespace is found before it is created');
    check(!/kv namespace delete|kv namespace rename/.test(yml), 'deploy.yml: nothing deletes or replaces a namespace');
    check(/kv_namespaces: \[\{ binding: "PHOTOS"/.test(yml), 'deploy.yml: the binding is patched as PHOTOS');

    equal((await call('config')).data.storage, 'kv', 'config says photos go to KV');
    const up = await upload(png);
    equal(up.status, 201, 'upload stored in KV');
    equal(storageOf(up.data.id), 'kv', 'uploads.storage is kv');
    const got = await call('images/' + up.data.id);
    equal(got.status, 200, 'the KV photo is served');
    equal(Buffer.compare(Buffer.from(got.bytes), Buffer.from(png)), 0, 'KV bytes round-trip exactly');
    const usage = (await call('me/usage')).data.photos;
    equal([usage.storage, usage.limit], ['kv', 100 * MB], 'me/usage gives the KV budget (100MB)');

    // 100MB per member on KV.
    try {
        sql(`INSERT INTO uploads (id,owner_id,mime,size,storage,created_at) VALUES ('kvbudget-${run}','${me.id}','image/png',${100 * MB - 10},'kv',${Date.now()})`);
        const over = await upload(small);
        equal([over.status, over.data.error.includes('100MB')], [409, true], 'per-member KV photo budget (100MB)');
    } finally { sql(`DELETE FROM uploads WHERE id='kvbudget-${run}'`); }

    // An unused KV photo is moved to kv_trash by the daily cron; a later run deletes the key.
    sql(`UPDATE uploads SET created_at=${Date.now() - 2 * DAY} WHERE id='${up.data.id}'`);
    check(kvHas(up.data.id), 'the key is in KV before the cleanup');
    check(await cronUntil(() => !storageOf(up.data.id)), 'the daily cron removes the unused KV photo row');
    const trashed = () => sql(`SELECT COUNT(*) AS n FROM kv_trash WHERE id='${up.data.id}'`)[0].n;
    equal(trashed(), 1, 'its key waits in kv_trash');
    check(await cronUntil(() => trashed() === 0), 'a later run deletes the key and its kv_trash row');
    check(!kvHas(up.data.id), 'the key is gone from KV');
    check(/^\d{4}-\d{2}-\d{2}:\d+$/.test(sql("SELECT value FROM settings WHERE key='sys:kv_deletes'")[0]?.value || ''), "the day's KV deletes are counted");

    // The KV delete budget: 898 used today and 10 waiting → one run deletes 2 and leaves 8.
    const fake = Array.from({ length: 10 }, (_, i) => `kvfake-${run}-${i}`);
    sql(`INSERT INTO kv_trash (id,created_at) VALUES ${fake.map((id, i) => `('${id}',${i + 1})`).join(',')}`);
    sql(`INSERT INTO settings(key,value,updated_at) VALUES('sys:kv_deletes','${today()}:898',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    await fireCron();
    const waiting = () => sql(`SELECT id FROM kv_trash WHERE id LIKE 'kvfake-${run}-%' ORDER BY created_at`).map(r => r.id);
    equal(waiting(), fake.slice(2), 'one run deletes 2 keys under the 900 budget and leaves 8 rows');
    equal(sql("SELECT value FROM settings WHERE key='sys:kv_deletes'")[0].value, `${today()}:900`, 'the counter is written once with the 2 deletes');
    await fireCron();
    equal(waiting().length, 8, 'nothing more is deleted once the day reaches 900');
    sql(`DELETE FROM kv_trash WHERE id LIKE 'kvfake-${run}-%'`);
    sql("DELETE FROM settings WHERE key='sys:kv_deletes'");

    // Earlier suites on this database used up the sign-in limits (per IP and per user).
    sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%'");
    const manager = client();
    equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: process.env.TEST_MANAGER_PASSWORD || 'local-manager-password' })).status, 200, 'manager logs in');
    const report = await manager('manage/storage');
    equal([report.status, report.data.mode, report.data.kvLimit], [200, 'kv', 950 * MB], 'manage/storage reports KV mode');
} else {
    // KV refuses every put: the photo lands in D1 when its budget allows, else the storage message.
    const up = await upload(png);
    equal(up.status, 201, 'the upload still succeeds');
    equal(storageOf(up.data.id), 'd1', 'it lands in D1 when the KV put throws');
    const got = await call('images/' + up.data.id);
    equal([got.status, Buffer.compare(Buffer.from(got.bytes), Buffer.from(png))], [200, 0], 'the D1 fallback photo is served');
    try {
        sql(`INSERT INTO uploads (id,owner_id,mime,size,storage,created_at) VALUES ('kvd1-${run}','${me.id}','image/png',${30 * MB},'d1',${Date.now()})`);
        const over = await upload(small);
        equal([over.status, over.data.error], [507, FULL], 'without D1 room the fallback answers with the storage message');
    } finally { sql(`DELETE FROM uploads WHERE id='kvd1-${run}'`); }
    equal((await call('uploads/' + up.data.id, 'DELETE')).status, 200, 'the fallback photo can be deleted');

    // Deletes fail too: no kv_trash row leaves.
    const fake = Array.from({ length: 3 }, (_, i) => `kvfail-${run}-${i}`);
    sql(`INSERT INTO kv_trash (id,created_at) VALUES ${fake.map((id, i) => `('${id}',${i + 1})`).join(',')}`);
    sql("DELETE FROM settings WHERE key='sys:kv_deletes'");
    await fireCron();
    equal(sql(`SELECT COUNT(*) AS n FROM kv_trash WHERE id LIKE 'kvfail-${run}-%'`)[0].n, 3, 'with KV failing no kv_trash row is removed');
    equal(sql("SELECT COUNT(*) AS n FROM settings WHERE key='sys:kv_deletes'")[0].n, 0, 'and no delete is counted');
    sql(`DELETE FROM kv_trash WHERE id LIKE 'kvfail-${run}-%'`);
}
console.log(`PASS KV photo storage, ${phase} phase (${checks} checks)`);
