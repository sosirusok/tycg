import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Read and call budget (WP42). Runs on the 8791 server (no assets, D1 photos, --test-scheduled) with
// READ_BUDGET=on, so every API response carries X-Rows-Read, X-Rows-Written, X-D1-Calls and
// X-D1-Statements, and the cron stores its counts in settings 'sys:last_cron_meter'.
// Seeds with one `wrangler d1 execute --file`: 20,000 '[budget]' posts across the tabs (a third of them
// bumped in the last 30 days), 2,000 favorites, one seller with 300 chats and 9,000 messages, 300
// unused photos and 60 due grade reminders. Everything it adds is deleted at the end.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const DAY = 86400000;
let checks = 0;
function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }
function atMost(actual, max, name) { assert.ok(Number.isFinite(actual) && actual <= max, `${name}: ${actual} > ${max}`); checks++; console.log(`PASS ${name} (${actual} ≤ ${max})`); }

const wrangler = ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc', '--persist-to', process.env.TEST_PERSIST || '.wrangler/state'];
function sql(command) {
    const out = execFileSync(process.execPath, [...wrangler, '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
function sqlFile(text) {
    const dir = mkdtempSync(path.join(tmpdir(), 'budget-'));
    try {
        const file = path.join(dir, 'seed.sql');
        writeFileSync(file, text);
        execFileSync(process.execPath, [...wrangler, '--yes', '--file', file], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

function client() {
    let cookie = '';
    return async (p, method = 'GET', data) => {
        const send = () => fetch(base + '/api/' + p, {
            method, redirect: 'error', signal: AbortSignal.timeout(30000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: data === undefined ? undefined : JSON.stringify(data),
        });
        // The seeding takes a few seconds, and the server closes idle keep-alive connections meanwhile;
        // a request that lands on such a closed connection is sent once more.
        const response = await send().catch(e => { if (e?.cause?.code === 'UND_ERR_SOCKET') return send(); throw e; });
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        const h = k => Number(response.headers.get(k));
        return { status: response.status, data: json, text, rows: h('x-rows-read'), written: h('x-rows-written'), calls: h('x-d1-calls'), statements: h('x-d1-statements') };
    };
}
async function fireCron() {
    const send = () => fetch(base + '/cdn-cgi/handler/scheduled?cron=17+18+*+*+*', { signal: AbortSignal.timeout(60000) });
    const r = await send().catch(e => { if (e?.cause?.code === 'UND_ERR_SOCKET') return send(); throw e; });
    await r.arrayBuffer();
    assert.equal(r.status, 200, 'scheduled cleanup runs');
    return JSON.parse(sql("SELECT value FROM settings WHERE key='sys:last_cron_meter'")[0]?.value || 'null');
}
// The unused-photo rule of worker/files.ts, for counting what the cron may still remove.
const UNUSED = "NOT EXISTS(SELECT 1 FROM post_images pi WHERE pi.upload_id=uploads.id) AND NOT EXISTS(SELECT 1 FROM message_images mi WHERE mi.upload_id=uploads.id) AND NOT EXISTS(SELECT 1 FROM drafts d,json_each(d.content,'$.images') j WHERE d.user_id=uploads.owner_id AND j.value=uploads.id)";
// A photo a lookup reused within the day (touched_at, WP44) counts as used.
// A deleted post's photos are held for the manager until keep_until (WP45).
const eligible = () => sql(`SELECT COUNT(*) AS n FROM uploads WHERE created_at<${Date.now() - DAY} AND COALESCE(touched_at,0)<${Date.now() - DAY} AND COALESCE(keep_until,0)<${Date.now()} AND ${UNUSED}`)[0].n;

// Rows a crashed earlier run left behind would change every number below.
const removeSeed = r => sqlFile(`
DELETE FROM conversations WHERE user_a LIKE 'bud-${r}-%' OR user_b LIKE 'bud-${r}-%' OR id LIKE 'budc-${r}-%' OR user_a IN (SELECT id FROM users WHERE username LIKE 'bud\\_${r}\\_s' ESCAPE '\\') OR user_b IN (SELECT id FROM users WHERE username LIKE 'bud\\_${r}\\_s' ESCAPE '\\');
DELETE FROM favorites WHERE user_id LIKE 'bud-${r}-%';
DELETE FROM posts WHERE title_key LIKE 'budget ${r} %' OR title LIKE '[budget] ${r} %';
DELETE FROM uploads WHERE owner_id LIKE 'bud-${r}-%';
DELETE FROM user_grades WHERE user_id LIKE 'bud-${r}-%';
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'bud\\_${r}\\_s' ESCAPE '\\');
DELETE FROM post_events WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'bud\\_${r}\\_s' ESCAPE '\\');
DELETE FROM users WHERE id LIKE 'bud-${r}-%' OR username LIKE 'bud\\_${r}\\_s' ESCAPE '\\';
`);
removeSeed('%');

const guest = client(), seller = client();
const reg = await seller('auth/register', 'POST', { username: `bud_${run}_s`, password, nickname: `budsel${run}` });
equal(reg.status, 200, 'the seller registers');
const sellerId = reg.data.user.id;
check(reg.rows > 0 && reg.calls > 0 && reg.statements >= reg.calls, 'the meter headers are on every API response');

// Photos other runs left behind would share the cron's 100 per run with this suite's photos.
for (let i = 0; i < 30 && eligible() > 0; i++) await fireCron();
equal(eligible(), 0, 'no older unused photos are waiting');


const now = Date.now();
const kinds = "CASE i%5 WHEN 0 THEN 'sell' WHEN 1 THEN 'buy' WHEN 2 THEN 'exchange' WHEN 3 THEN 'proxy_request' ELSE 'proxy_offer' END";
const category = `CASE WHEN i%5 IN (0,1) THEN (CASE (i/5)%4 WHEN 0 THEN 'account' WHEN 1 THEN 'clan' WHEN 2 THEN 'goods_coupon' ELSE 'other' END)
    WHEN i%5=2 THEN (CASE (i/5)%2 WHEN 0 THEN 'account' ELSE 'clan' END) ELSE (CASE (i/5)%3 WHEN 0 THEN 'ladder' WHEN 1 THEN 'story' ELSE 'event' END) END`;
const seq = n => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${n})`;
const pair = other => `CASE WHEN '${sellerId}'<${other} THEN '${sellerId}' ELSE ${other} END,CASE WHEN '${sellerId}'<${other} THEN ${other} ELSE '${sellerId}' END`;
const seed = `
-- 50 authors (1-50) and 300 chat partners (51-350).
${seq(350)} INSERT INTO users(id,username,nickname,nickname_key,password_hash,salt,role,bio,created_at)
SELECT 'bud-${run}-'||i,'bud_${run}_'||i,'bud${run}n'||i,'bud${run}n'||i,'','','member','',${now} FROM n;
-- The authors hold 대리 인증, as every 대리(진행) author does.
INSERT INTO user_badges(user_id,badge,granted_by,granted_at) SELECT id,'proxy','manager',${now} FROM users WHERE id LIKE 'bud-${run}-%' AND CAST(substr(id,${`bud-${run}-`.length + 1}) AS INTEGER)<=50;
-- 20,000 posts: every 50th is the seller's; bumped 0-89 days ago, so about a third are in the 30-day window.
${seq(20000)} INSERT INTO posts(author_id,kind,title,body,price,status,created_at,updated_at,category,price_mode,details,images,bumped_at,title_key)
SELECT CASE WHEN i%50=0 THEN '${sellerId}' ELSE 'bud-${run}-'||(i%50) END,${kinds},'[budget] ${run} '||i,'budget',12345,
    CASE WHEN i%7=0 THEN 'closed' WHEN i%11=0 THEN 'reserved' ELSE 'open' END,
    ${now}-(i%90)*${DAY}-i*1000,${now}-(i%90)*${DAY}-i*1000,${category},'fixed','{}','[]',${now}-(i%90)*${DAY}-i*1000,'budget ${run} '||i FROM n;
-- Three featured sale posts (none on the other tabs).
UPDATE posts SET featured_at=${now} WHERE author_id='${sellerId}' AND kind='sell' AND status='open' AND id IN (SELECT id FROM posts WHERE author_id='${sellerId}' AND kind='sell' AND status='open' ORDER BY bumped_at DESC LIMIT 3);
-- 2,000 favorites from the partners.
${seq(2000)} INSERT OR IGNORE INTO favorites(user_id,post_id,created_at)
SELECT 'bud-${run}-'||(51+i%300),b.m+(i*7)%20000,${now} FROM n,(SELECT MIN(id) AS m FROM posts WHERE title_key='budget ${run} 1') b;
-- 300 chats of the seller, 30 messages each. In the 20 newest chats the last 3 from each side are
-- unread; the seller read the others (the unread total reads only chats with something unread).
${seq(300)} INSERT INTO conversations(id,user_a,user_b,created_at,updated_at)
SELECT 'budc-${run}-'||i,${pair(`'bud-${run}-'||(50+i)`)},${now - DAY},${now}-i*60000 FROM n;
${seq(9000)} INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at,read_at)
SELECT 'budc-${run}-'||(1+(i-1)/30),CASE WHEN i%2=0 THEN 'bud-${run}-'||(51+(i-1)/30) ELSE '${sellerId}' END,'budget','text',NULL,'[]',${now - DAY}+i,
    CASE WHEN (i-1)%30>=24 AND (i-1)/30<20 THEN NULL ELSE ${now} END FROM n;
-- 300 unused photos of author 1, uploaded two days ago.
${seq(300)} INSERT INTO uploads(id,owner_id,mime,size,storage,created_at) SELECT 'budu-${run}-'||i,'bud-${run}-1','image/png',68,'d1',${now - 2 * DAY} FROM n;
INSERT INTO upload_blobs(id,data) SELECT id,'iVBORw0KGgo=' FROM uploads WHERE owner_id='bud-${run}-1';
-- 60 6-month grades that end in 3 days (members 51-110).
${seq(60)} INSERT INTO user_grades(user_id,grade,rank,expires_at,granted_by,granted_at,source) SELECT 'bud-${run}-'||(50+i),'premium',2,${now + 3 * DAY},'manager',${now - 170 * DAY},'manager' FROM n;
-- Featured posts other suites left (bumped in the last 72 hours) are taken off the box, so the box
-- holds exactly the three above.
UPDATE posts SET featured_at=NULL WHERE featured_at IS NOT NULL AND title_key NOT LIKE 'budget ${run} %';
-- Other suites' grades that happen to be due are marked, so the 50 reminders of this run are these.
UPDATE user_grades SET reminded_at=${now} WHERE source='manager' AND expires_at>${now} AND expires_at<=${now + 7 * DAY} AND user_id NOT LIKE 'bud-${run}-%';
`;
const t0 = Date.now();
sqlFile(seed);
console.log(`seeded in ${Date.now() - t0} ms`);
equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE title_key LIKE 'budget ${run} %'`)[0].n, 20000, '20,000 posts are seeded');
equal(sql(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id LIKE 'budc-${run}-%'`)[0].n, 9000, '9,000 messages are seeded');

// Unread counters: the trigger counted the seeded messages (3 unread on each side of 20 chats).
const login = await seller('auth/login', 'POST', { username: `bud_${run}_s`, password });
equal(login.status, 200, 'the seller signs in');
const unread = await seller('chats/unread');
equal(unread.data.unread, 60, 'the seller has 60 unread messages (the insert trigger counts them)');
atMost(unread.rows, 50, 'GET chats/unread rows read');

const since = await seller('chats?since=' + Date.now());
equal([since.status, since.data.chats.length], [200, 0], 'GET chats?since=<now> returns no rows');
atMost(since.rows, 100, 'GET chats?since=<now> rows read');
const list = await seller('chats');
equal([list.data.chats.length, list.data.chats[0].unread], [100, 3], 'GET chats returns the 100 newest chats with their unread counts');
console.log(`  (GET chats, 300 chats: ${list.rows} rows read)`);

// Board lists: the 30-day window, the count stopped at 301, the featured box driven from its index.
const sell = await guest('posts?kind=sell');
equal([sell.status, sell.data.total, sell.data.capped], [200, 301, true], 'GET posts?kind=sell stops counting at 301 (capped)');
check(sell.data.posts.every(p => p.bumped_at > Date.now() - 30 * DAY), 'the board shows only posts bumped in the last 30 days');
atMost(sell.rows, 1000, 'GET posts?kind=sell rows read');
const board = await seller('posts?kind=sell&category=account&active=1');
atMost(board.rows, 1000, 'GET posts (the board query, signed in) rows read');
// The seeded posts' price (12,345원) keeps other suites' posts out of this list.
const old = await guest('posts?kind=sell&category=account&active=1&min=12345&max=12345&old=1&page=30');
check(old.data.posts.length > 0 && old.data.posts.every(p => p.bumped_at <= Date.now() - 30 * DAY), "old=1 ('오래된 글 보기') reaches posts bumped more than 30 days ago");
// Post 19950 was bumped 60 days ago, and its title matches no other post.
const search = await guest(`posts?q=${encodeURIComponent(`[budget] ${run} 19950`)}`);
equal(search.data.posts.map(p => p.title), [`[budget] ${run} 19950`], 'a search still covers posts older than 30 days');

// The ad part (WP53) on a tab with no slot posts (other tabs have some): the same list with the
// '광고 매물' box and without it (ads=none). Without a kind there is no box either, but that list
// reads other rows, so the box is compared on the same tab.
const withBox = await guest('posts?kind=buy&category=account&active=1'), withoutBox = await guest('posts?kind=buy&category=account&active=1&ads=none');
equal([withBox.data.ads, withoutBox.data.ads, withBox.statements - withoutBox.statements], [[], undefined, 1], 'the 구매 tab has no ads; ads=none leaves the box statement out');
equal(withBox.data.posts.map(p => p.id), withoutBox.data.posts.map(p => p.id), 'the list is the same either way');
const noKind = await guest('posts?active=1');
equal(noKind.data.ads, undefined, 'a list without a kind has no box');
console.log(`  (구매 with the box ${withBox.rows} rows, without ${withoutBox.rows}, no kind ${noKind.rows})`);
atMost(withBox.rows - withoutBox.rows, 20, 'the ad part of a tab without slot posts costs ≤ 20 rows');
// The 판매 tab holds the seller's three slot posts (not eligible: no grade): the candidates are read
// through the posts_ad index only.
const sellBox = await guest('posts?kind=sell&active=1'), sellPlain = await guest('posts?kind=sell&active=1&ads=none');
equal(sellBox.data.ads, [], 'slot posts of a member without 프리미엄 are no ads');
atMost(sellBox.rows - sellPlain.rows, 60, 'the ad part of a tab with 3 slot posts costs ≤ 60 rows');

const mine = await seller(`posts?author=${sellerId}`);
equal(mine.data.total, 301, "the seller's own list counts up to 301 too");
atMost(mine.rows, 600, 'GET posts?author=<seller> as the seller rows read');
const mineCounts = await seller(`posts?author=${sellerId}&counts=1&size=16&page=1`);
atMost(mineCounts.rows, 600, '내 글 (counts=1) rows read');

const one = await guest('posts/' + sell.data.posts[0].id);
equal(one.status, 200, 'GET posts/<id> works');
atMost(one.rows, 300, 'GET posts/<id> rows read');

// One home request: shelves, 엘리트 매물 and notices.
const home = await guest('home');
equal([home.status, ...['sell', 'buy', 'proxy_offer'].map(k => Array.isArray(home.data.shelves[k]))], [200, true, true, true], 'GET /api/home returns the three shelves');
check(home.data.shelves.sell.length === 6 && home.data.shelves.sell.every(p => p.status !== 'closed' && p.bumped_at > Date.now() - 30 * DAY), 'a shelf holds 6 active posts of the last 30 days');
check(Array.isArray(home.data.ads) && Array.isArray(home.data.notices) && home.data.notices.length <= 4, 'GET /api/home returns 엘리트 매물 and at most 4 notices');
atMost(home.rows, 400, 'GET /api/home rows read');
const homeMember = await seller('home');
atMost(homeMember.rows, 400, 'GET /api/home (signed in) rows read');

// 'sys:' settings stay on the server.
const config = await guest('config');
check(config.status === 200 && !config.text.includes('sys:'), "GET /api/config has no 'sys:' key");

// The daily cron: ≤ 10 calls and ≤ 45 statements, 100 photos per run, 50 reminders per run.
const photos = () => sql(`SELECT COUNT(*) AS n FROM uploads WHERE owner_id='bud-${run}-1'`)[0].n;
const reminded = () => sql(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.sender_id='manager' AND m.type='system' AND (c.user_a LIKE 'bud-${run}-%' OR c.user_b LIKE 'bud-${run}-%')`)[0].n;
let meter = await fireCron();
console.log('  cron meter', JSON.stringify(meter));
atMost(meter.d1Calls + meter.r2Calls, 10, 'the daily cron: D1 and R2 calls');
atMost(meter.d1Statements + meter.fetches, 45, 'the daily cron: statements');
equal(photos(), 200, 'one daily run removes 100 unused photos');
equal(sql(`SELECT COUNT(*) AS n FROM upload_blobs WHERE id LIKE 'budu-${run}-%'`)[0].n, 200, 'their D1 bytes go with them');
equal(reminded(), 50, 'one daily run sends 50 grade reminders');
equal(sql(`SELECT COUNT(*) AS n FROM user_grades WHERE user_id LIKE 'bud-${run}-%' AND reminded_at IS NOT NULL`)[0].n, 50, '50 grants are marked reminded');
meter = await fireCron();
atMost(meter.d1Calls + meter.r2Calls, 10, 'the second run: D1 and R2 calls');
atMost(meter.d1Statements + meter.fetches, 45, 'the second run: statements');
equal([photos(), reminded()], [100, 60], 'the second run removes 100 more photos and sends the last 10 reminders');
meter = await fireCron();
equal(photos(), 0, 'the third run removes the rest: all 300 photos are gone');
const managerChat = sql(`SELECT a_unread,b_unread,user_a,user_b FROM conversations WHERE (user_a='manager' AND user_b='bud-${run}-51') OR (user_b='manager' AND user_a='bud-${run}-51')`)[0];
equal(managerChat.user_a === 'manager' ? [managerChat.a_unread, managerChat.b_unread] : [managerChat.b_unread, managerChat.a_unread], [0, 1], 'the reminder counts as 1 unread for the member');

// Everything this suite added goes.
removeSeed(run);
equal(sql(`SELECT (SELECT COUNT(*) FROM posts WHERE title_key LIKE 'budget ${run} %')+(SELECT COUNT(*) FROM users WHERE id LIKE 'bud-${run}-%')+(SELECT COUNT(*) FROM messages WHERE conversation_id LIKE 'budc-${run}-%') AS n`)[0].n, 0, 'the seeded rows are removed');
console.log(`\n${checks} budget checks passed`);
