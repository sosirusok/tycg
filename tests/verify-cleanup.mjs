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
function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }

function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
// sql() blocks the event loop for seconds (wrangler d1 execute), so a keep-alive socket the local server
// closed meanwhile can still look open: such a request is sent once more on a new socket (as verify-dup).
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
            method, signal: AbortSignal.timeout(15000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(raw ? { 'Content-Type': raw.type } : data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: raw ? raw.bytes : data === undefined ? undefined : JSON.stringify(data),
        }));
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        if (!(response.headers.get('content-type') || '').includes('json')) { await response.arrayBuffer(); return { status: response.status }; }
        return { status: response.status, data: await response.json() };
    };
}
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

// The cron removes 100 unused photos per run: photos older runs left behind are removed first, so
// the photos of this run are the ones the checks below see.
const UNUSED = "NOT EXISTS(SELECT 1 FROM post_images pi WHERE pi.upload_id=uploads.id) AND NOT EXISTS(SELECT 1 FROM message_images mi WHERE mi.upload_id=uploads.id) AND NOT EXISTS(SELECT 1 FROM comments c WHERE c.image_id=uploads.id) AND NOT EXISTS(SELECT 1 FROM drafts d,json_each(d.content,'$.images') j WHERE d.user_id=uploads.owner_id AND j.value=uploads.id)";
// A photo a lookup reused within the day (touched_at, WP44) counts as used.
// A deleted post's photos are held for the manager until keep_until (WP45).
const eligible = () => sql(`SELECT COUNT(*) AS n FROM uploads WHERE created_at<${Date.now() - DAY} AND COALESCE(touched_at,0)<${Date.now() - DAY} AND COALESCE(keep_until,0)<${Date.now()} AND ${UNUSED}`)[0].n;
async function fireCron() {
    const r = await send(base + '/cdn-cgi/handler/scheduled?cron=17+18+*+*+*', () => ({ signal: AbortSignal.timeout(30000) }));
    await r.arrayBuffer();
    return r.status;
}
for (let i = 0; i < 30 && eligible() > 0; i++) await fireCron();
equal(eligible(), 0, 'no older unused photos are waiting');

const a = client(), b = client();
const users = [];
for (const [name, c] of [['ca', a], ['cb', b]]) {
    const r = await c('auth/register', 'POST', { username: `c_${run}_${name}`, password, nickname: `${name}${run}` });
    assert.equal(r.status, 200);
    users.push(r.data.user);
}
const upload = async () => (await a('uploads', 'POST', undefined, { type: 'image/png', bytes: png })).data.id;
const inPost = await upload(), inChat = await upload(), inDraft = await upload(), unused = await upload(), fresh = await upload(), inComment = await upload();
equal(sql(`SELECT storage FROM uploads WHERE id='${unused}'`)[0].storage, 'd1', 'photos are stored in D1 on this server');
const kept = await a('posts', 'POST', { kind: 'sell', category: 'other', title: `[QA] 정리 ${run}`, body: '자동 검증', price: 10000, status: 'open', tags: [], images: [inPost], details: {} });
equal(kept.status, 201, 'post keeps a photo');
// 댓글·답글 (WP55): a 댓글 photo counts as in use.
equal((await b(`posts/${kept.data.id}/comments`, 'POST', { body: '사진 확인', imageId: inComment })).status, 400, "a 댓글 cannot use another member's photo");
equal((await a(`posts/${kept.data.id}/comments`, 'POST', { body: '사진 첨부', imageId: inComment })).status, 201, 'a 댓글 keeps a photo');
const chat = await a('chats', 'POST', { userId: users[1].id });
equal((await a(`chats/${chat.data.id}/messages`, 'POST', { body: '', images: [inChat] })).status, 201, 'chat keeps a photo');
equal((await a('drafts/new', 'PUT', { kind: 'sell', title: '임시', images: [inDraft], offer: '' })).status, 200, 'draft keeps a photo');

const old = Date.now() - 2 * DAY;
sql(`UPDATE uploads SET created_at=${old} WHERE id IN ('${inPost}','${inChat}','${inDraft}','${unused}','${inComment}')`);
sql(`INSERT INTO sessions (token,user_id,expires_at) VALUES ('expired-${run}','${users[0].id}',${old})`);
sql(`INSERT INTO rate_limits (key,count,reset_at) VALUES ('old-${run}',1,${old})`);
// 링크 미리보기 cache (WP48): rows older than 7 days go, a fresh one stays.
sql(`INSERT INTO link_cache (url,card,ok,fetched_at) VALUES ('https://old-${run}.example/',  '{}',1,${Date.now() - 8 * DAY}),('https://new-${run}.example/','{}',1,${Date.now() - DAY})`);
// A 6-month grade of cb ends in 3 days, and cb blocked the manager: no reminder, but the grant is marked.
equal((await b('blocks', 'POST', { userId: 'manager', active: true })).status, 200, 'cb blocks the manager');
sql(`INSERT INTO user_grades(user_id,grade,rank,expires_at,granted_by,granted_at,source) VALUES('${users[1].id}','premium',2,${Date.now() + 3 * DAY},'manager',${old},'manager')`);
equal(await fireCron(), 200, 'scheduled cleanup runs');

const ids = [inPost, inChat, inDraft, unused, fresh, inComment];
equal(sql(`SELECT id FROM uploads WHERE id IN (${ids.map(i => `'${i}'`).join(',')})`).map(r => r.id).sort(), [inPost, inChat, inDraft, fresh, inComment].sort(), 'only the day-old unused photo is removed (a 댓글 photo survives)');
equal((await client()('images/' + inComment)).status, 200, 'a 댓글 photo on a visible post is public');
equal(sql(`SELECT COUNT(*) AS n FROM upload_blobs WHERE id='${unused}'`)[0].n, 0, 'its D1 bytes are removed too');
equal((await a('images/' + unused)).status, 404, 'removed photo is gone');
equal((await a('images/' + fresh)).status, 200, 'a photo uploaded today is kept');
equal(sql(`SELECT COUNT(*) AS n FROM sessions WHERE token='expired-${run}'`)[0].n, 0, 'expired sessions are removed');
equal(sql(`SELECT COUNT(*) AS n FROM rate_limits WHERE key='old-${run}'`)[0].n, 0, 'finished rate-limit windows are removed');
equal(sql(`SELECT url FROM link_cache WHERE url IN ('https://old-${run}.example/','https://new-${run}.example/')`).map(r => r.url), [`https://new-${run}.example/`], 'link previews cached over 7 days ago are removed');
equal(sql(`SELECT COUNT(*) AS n FROM conversations WHERE (user_a='manager' AND user_b='${users[1].id}') OR (user_b='manager' AND user_a='${users[1].id}')`)[0].n, 0, 'a member who blocked the manager gets no reminder chat');
check(sql(`SELECT reminded_at FROM user_grades WHERE user_id='${users[1].id}'`)[0].reminded_at !== null, "that member's grant is still marked reminded");

// Set-based photo cleanup (WP42): 150 unused photos uploaded two days ago, one daily run removes 100
// with a handful of D1 calls (the meter of the 8791 server, READ_BUDGET=on).
const many = [];
for (let i = 0; i < 150; i++) many.push(`('cl-${run}-${i}','${users[0].id}','image/png',68,'d1',${old})`);
sql(`INSERT INTO uploads(id,owner_id,mime,size,storage,created_at) VALUES ${many.join(',')}; INSERT INTO upload_blobs(id,data) SELECT id,'iVBORw0KGgo=' FROM uploads WHERE id LIKE 'cl-${run}-%'`);
equal(await fireCron(), 200, 'scheduled cleanup runs again');
equal(sql(`SELECT COUNT(*) AS n FROM uploads WHERE id LIKE 'cl-${run}-%'`)[0].n, 50, 'one daily run removes 100 of the 150 photos');
equal(sql(`SELECT COUNT(*) AS n FROM upload_blobs WHERE id LIKE 'cl-${run}-%'`)[0].n, 50, 'their D1 bytes go with them');
const meter = JSON.parse(sql("SELECT value FROM settings WHERE key='sys:last_cron_meter'")[0]?.value || 'null');
check(meter && meter.d1Calls + meter.r2Calls <= 10 && meter.d1Statements <= 45, `the run used ≤ 10 D1 calls and ≤ 45 statements (${meter?.d1Calls} calls, ${meter?.d1Statements} statements)`);
equal(await fireCron(), 200, 'the next run removes the rest');
equal(sql(`SELECT COUNT(*) AS n FROM uploads WHERE id LIKE 'cl-${run}-%'`)[0].n, 0, 'all 150 photos are gone after two runs');
console.log(`\n${checks} cleanup checks passed`);
