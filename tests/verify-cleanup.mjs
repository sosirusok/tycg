import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The daily cron: expired sessions, finished rate-limit windows and photos that no
// post, chat message or draft has used for a day. Local dev only delivers the cron
// to a Worker without static assets, so scripts/test-local.mjs runs this suite on the
// second server (no assets, no R2 — photos are in D1), started with --test-scheduled.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const DAY = 86400000;
let checks = 0;
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
function client() {
    let cookie = '';
    return async (path, method = 'GET', data, raw) => {
        const response = await fetch(base + '/api/' + path, {
            method, signal: AbortSignal.timeout(15000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(raw ? { 'Content-Type': raw.type } : data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: raw ? raw.bytes : data === undefined ? undefined : JSON.stringify(data),
        });
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        if (!(response.headers.get('content-type') || '').includes('json')) { await response.arrayBuffer(); return { status: response.status }; }
        return { status: response.status, data: await response.json() };
    };
}
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const a = client(), b = client();
const users = [];
for (const [name, c] of [['ca', a], ['cb', b]]) {
    const r = await c('auth/register', 'POST', { username: `c_${run}_${name}`, password, nickname: `${name}${run}` });
    assert.equal(r.status, 200);
    users.push(r.data.user);
}
const upload = async () => (await a('uploads', 'POST', undefined, { type: 'image/png', bytes: png })).data.id;
const inPost = await upload(), inChat = await upload(), inDraft = await upload(), unused = await upload(), fresh = await upload();
equal(sql(`SELECT storage FROM uploads WHERE id='${unused}'`)[0].storage, 'd1', 'photos are stored in D1 on this server');
equal((await a('posts', 'POST', { kind: 'sell', category: 'other', title: `[QA] 정리 ${run}`, body: '자동 검증', price: 10000, status: 'open', tags: [], images: [inPost], details: {} })).status, 201, 'post keeps a photo');
const chat = await a('chats', 'POST', { userId: users[1].id });
equal((await a(`chats/${chat.data.id}/messages`, 'POST', { body: '', images: [inChat] })).status, 201, 'chat keeps a photo');
equal((await a('drafts/new', 'PUT', { kind: 'sell', title: '임시', images: [inDraft], offer: '' })).status, 200, 'draft keeps a photo');

const old = Date.now() - 2 * DAY;
sql(`UPDATE uploads SET created_at=${old} WHERE id IN ('${inPost}','${inChat}','${inDraft}','${unused}')`);
sql(`INSERT INTO sessions (token,user_id,expires_at) VALUES ('expired-${run}','${users[0].id}',${old})`);
sql(`INSERT INTO rate_limits (key,count,reset_at) VALUES ('old-${run}',1,${old})`);
const fired = await fetch(base + '/cdn-cgi/handler/scheduled?cron=17+18+*+*+*', { signal: AbortSignal.timeout(30000) });
await fired.arrayBuffer();
equal(fired.status, 200, 'scheduled cleanup runs');

const ids = [inPost, inChat, inDraft, unused, fresh];
equal(sql(`SELECT id FROM uploads WHERE id IN (${ids.map(i => `'${i}'`).join(',')})`).map(r => r.id).sort(), [inPost, inChat, inDraft, fresh].sort(), 'only the day-old unused photo is removed');
equal(sql(`SELECT COUNT(*) AS n FROM upload_blobs WHERE id='${unused}'`)[0].n, 0, 'its D1 bytes are removed too');
equal((await a('images/' + unused)).status, 404, 'removed photo is gone');
equal((await a('images/' + fresh)).status, 200, 'a photo uploaded today is kept');
equal(sql(`SELECT COUNT(*) AS n FROM sessions WHERE token='expired-${run}'`)[0].n, 0, 'expired sessions are removed');
equal(sql(`SELECT COUNT(*) AS n FROM rate_limits WHERE key='old-${run}'`)[0].n, 0, 'finished rate-limit windows are removed');
console.log(`\n${checks} cleanup checks passed`);
