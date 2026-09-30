import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Photo storage without an R2 bucket: bytes are kept in D1 (upload_blobs).
const base = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791').origin;
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base), 'Local Worker origin required.');
let cookie = '';
async function call(path, method = 'GET', data, raw) {
    const r = await fetch(base + '/api/' + path, {
        method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(raw ? { 'Content-Type': raw.type } : data ? { 'Content-Type': 'application/json' } : {}) },
        body: raw ? raw.bytes : data ? JSON.stringify(data) : undefined,
    });
    const s = r.headers.get('set-cookie');
    if (s) cookie = s.split(';')[0];
    return (r.headers.get('content-type') || '').includes('json') ? { status: r.status, data: await r.json() } : { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
}
const run = randomBytes(4).toString('hex');
assert.equal((await call('auth/register', 'POST', { username: 'st_' + run, password: randomBytes(12).toString('hex'), nickname: '저장' + run })).status, 200);
// A valid PNG signature followed by filler bytes (about 300 KB).
const png = new Uint8Array(300_000);
png.set([137, 80, 78, 71, 13, 10, 26, 10]);
for (let i = 8; i < png.length; i++) png[i] = i % 251;
const up = await call('uploads', 'POST', undefined, { type: 'image/png', bytes: png });
assert.equal(up.status, 201, 'upload stored without R2');
const got = await call('images/' + up.data.id);
assert.equal(got.status, 200, 'owner can read the D1-stored photo');
assert.equal(Buffer.compare(Buffer.from(got.bytes), Buffer.from(png)), 0, 'D1-stored bytes round-trip exactly');
const big = new Uint8Array(2_000_000);
big.set([137, 80, 78, 71, 13, 10, 26, 10]);
assert.equal((await call('uploads', 'POST', undefined, { type: 'image/png', bytes: big })).status, 413, 'photos above the D1 row limit are rejected');
assert.equal((await call('uploads/' + up.data.id, 'DELETE')).status, 200, 'unused D1 photo can be deleted');
assert.equal((await call('images/' + up.data.id)).status, 404, 'deleted photo is gone');

// Without R2, photos share the 500 MB database: 30 MB per member and 300 MB for the site.
function sql(command) {
    execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc', '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--command', command],
        { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'pipe', timeout: 30000 });
}
const me = (await call('auth/me')).data.user;
const small = png.slice(0, 1000);
try {
    sql(`INSERT INTO uploads (id,owner_id,mime,size,storage,created_at) VALUES ('budget-${run}','${me.id}','image/png',${30 * 1024 * 1024},'d1',${Date.now()})`);
    assert.equal((await call('uploads', 'POST', undefined, { type: 'image/png', bytes: small })).status, 409, 'per-member D1 photo budget');
    sql(`UPDATE uploads SET owner_id='manager',size=${300 * 1024 * 1024} WHERE id='budget-${run}'`);
    assert.equal((await call('uploads', 'POST', undefined, { type: 'image/png', bytes: small })).status, 507, 'site-wide D1 photo budget');
} finally {
    sql(`DELETE FROM uploads WHERE id='budget-${run}'`);
}
assert.equal((await call('uploads', 'POST', undefined, { type: 'image/png', bytes: small })).status, 201, 'uploads work again once space is freed');
console.log('PASS D1 photo storage fallback and budgets (8 checks)');
