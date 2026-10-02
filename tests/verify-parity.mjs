import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// R2 mode (WP45). TEST_PHASE=main runs on 8790 (R2 bound): the 1GB per member budget, the site guards,
// 조회수 inside GET posts/:id?view=1, manage/storage and caching. TEST_PHASE=mover runs on a short-lived
// 8791 server with both R2 and KV bound (no assets, --test-scheduled, TEST_HOOKS=on): the R2 mover.
// 카페 기본 기능 나머지 (WP59): the main phase (assets on) checks 공유 (/p/:id and its og: tags), the drafts per
// board, 찜 수, 프로필 사진 and 비밀번호 찾기; the mover phase (cron on) checks that a 프로필 사진 survives the
// daily cleanup.
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
// A 1×1 WebP as the 64px 프로필 사진 copy (any WebP or JPEG data URI of at most 4,000 characters).
const THUMB = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';

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

    // ---- 공유 (WP59): /p/:id is the app's index.html with the post's og: tags (run_worker_first '/p/*') ----
    const page = async path => {
        const r = await fetch(base + path, { signal: AbortSignal.timeout(30000) });
        return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
    };
    const unescape = v => v === undefined ? v : v.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const tag = (html, key) => unescape((new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html) || [])[1]);
    const titleOf = html => unescape((/<title>([^<]*)<\/title>/.exec(html) || [])[1]);
    const cover = await upload(a.call, png.slice(0, 1200)), more = await upload(a.call, png.slice(0, 1300));
    const shareTitle = `[QA] 공유 "카톡" & 미리보기 ${run}`;
    const shared = await a.call('posts', 'POST', { kind: 'sell', category: 'other', title: shareTitle, body: '자동 검증', price: 350000, tags: [], details: { currentOffer: '250000' }, images: [cover.data.id, more.data.id] });
    equal(shared.status, 201, 'A writes a post to share');
    const sid = shared.data.id;
    const sp = await page(`/p/${sid}`);
    equal([sp.status, sp.type.includes('text/html'), sp.text.includes('<div id="root">')], [200, true, true], '/p/:id answers the app page');
    equal([tag(sp.text, 'og:title'), titleOf(sp.text)], [`[판매] ${shareTitle}`, `[판매] ${shareTitle}`], 'og:title and <title> carry the board and the post title');
    equal([tag(sp.text, 'og:description'), tag(sp.text, 'description')], ['기타 · 즉거가 35만원 · 현젯 25만원', '기타 · 즉거가 35만원 · 현젯 25만원'], 'og:description gives 즉거가 and 현젯');
    equal(tag(sp.text, 'og:image'), `${base}/api/images/${cover.data.id}`, 'og:image is the 대표 (images[0])');
    equal(tag(sp.text, 'og:url'), `${base}/p/${sid}`, 'og:url is the share address');
    equal(tag(sp.text, 'og:site_name'), '좀비고 거래소', 'og:site_name stays');
    equal((await guest('images/' + cover.data.id)).status, 200, 'the og:image is public');
    const wanted = await a.call('posts', 'POST', { kind: 'buy', category: 'other', title: `[QA] 공유 구매 ${run}`, body: '자동 검증', price: 300000, tags: [], details: {}, images: [] });
    equal(wanted.status, 201, 'A writes a 구매 post');
    const wp = (await page(`/p/${wanted.data.id}`)).text;
    equal([tag(wp, 'og:title'), tag(wp, 'og:description'), tag(wp, 'og:image')], [`[구매] [QA] 공유 구매 ${run}`, '기타 · MAX 30만원', undefined], 'a 구매 post shares MAX and no photo');
    equal((await manager('manage/visibility', 'POST', { postId: wanted.data.id, hidden: true })).status, 200, 'the manager hides the 구매 post');
    const hp = await page(`/p/${wanted.data.id}`);
    equal([hp.status, tag(hp.text, 'og:title'), titleOf(hp.text), tag(hp.text, 'og:image'), tag(hp.text, 'og:url')], [200, '좀비고 거래소', '좀비고 거래소', undefined, undefined], 'a hidden post gets the site defaults');
    equal(tag((await page('/p/999999999')).text, 'og:title'), '좀비고 거래소', 'an unknown post gets the site defaults');
    equal(tag((await page('/')).text, 'og:title'), '좀비고 거래소', 'index.html carries the default og:title');

    // ---- 찜 수 (WP59) ----
    equal((await guest(`posts/${sid}`)).data.post.fav_count, 0, 'a new post has fav_count 0');
    equal((await b.call(`posts/${sid}/favorite`, 'POST', { active: true })).status, 200, 'B saves the post (찜)');
    equal((await guest(`posts/${sid}`)).data.post.fav_count, 1, 'GET posts/:id returns fav_count 1');

    // ---- 완료 with a counted trade: '판매완료 · 거래가 25만원' (WP59) ----
    const chat = (await b.call('chats', 'POST', { userId: a.user.id, postId: sid })).data.id;
    equal((await b.call(`chats/${chat}/messages`, 'POST', { body: '구매 원합니다', postId: sid })).status, 201, 'B asks about the shared post');
    const done = await a.call(`posts/${sid}/status`, 'PATCH', { status: 'closed', partnerId: b.user.id, amount: 250000 });
    equal([done.status, done.data.trade?.price], [200, 250000], 'A completes it with B at 25만원');
    equal(tag((await page(`/p/${sid}`)).text, 'og:description'), '판매완료 · 즉거가 35만원', 'a closed post without a counted trade shows its price');
    equal((await b.call(`trades/${done.data.trade.id}/answer`, 'POST', { confirm: true })).status, 200, 'B confirms the trade');
    equal(tag((await page(`/p/${sid}`)).text, 'og:description'), '판매완료 · 거래가 25만원', 'a closed post with a counted trade shows the closed label and 거래가');

    // ---- 임시글 per board (WP59) ----
    const style = [[0, 2, 'b']];
    equal((await a.call('drafts/new-sell', 'PUT', { kind: 'sell', category: 'account', title: '판매 임시', body: '굵게 쓴 글', offer: '', link_preview: false, body_style: style })).status, 200, "draft 'new-sell' saved");
    equal((await a.call('drafts/new-buy', 'PUT', { kind: 'buy', category: 'account', title: '구매 임시', body: '', offer: '' })).status, 200, "draft 'new-buy' saved");
    const drafts = (await a.call('drafts')).data.drafts;
    check(['new-sell', 'new-buy'].every(k => drafts.some(d => d.key === k)), 'GET drafts lists both');
    equal(['new-sell', 'new-buy'].map(k => { const d = drafts.find(x => x.key === k); return [d.title, d.kind, d.updated_at > 0]; }), [['판매 임시', 'sell', true], ['구매 임시', 'buy', true]], 'each row has its title, board and time');
    const kept = (await a.call('drafts/new-sell')).data.draft;
    equal([kept.title, kept.link_preview, kept.body_style], ['판매 임시', false, style], 'a draft keeps link_preview and body_style');
    equal((await a.call('drafts/new-buy')).data.draft.title, '구매 임시', 'the 구매 draft did not replace the 판매 one');
    equal((await a.call('drafts/new-../', 'PUT', { kind: 'sell', title: 'x', offer: '' })).status, 400, "key 'new-../' → 400");
    equal((await a.call('drafts/new-hack', 'PUT', { kind: 'sell', title: 'x', offer: '' })).status, 400, 'a key of no board → 400');
    equal((await b.call('drafts')).data.drafts.some(d => d.key === 'new-sell' && d.title === '판매 임시'), false, "another member never sees A's drafts");
    equal((await a.call('drafts/new-buy', 'DELETE')).status, 200, 'a draft is deleted');
    equal((await a.call('drafts')).data.drafts.map(d => d.key).includes('new-buy'), false, 'and leaves the list');
    equal((await guest('drafts')).status, 401, 'a guest has no drafts');

    // ---- 프로필 사진 (WP59) ----
    const photo = await upload(a.call, png.slice(0, 1500));
    equal((await a.call('me/avatar', 'POST', { uploadId: photo.data.id, thumb: 'data:text/html;base64,AA' })).status, 400, "thumb 'data:text/html;base64,AA' → 400");
    equal((await a.call('me/avatar', 'POST', { uploadId: photo.data.id, thumb: 'data:image/webp;base64,' + 'A'.repeat(4000) })).status, 400, 'a thumb over 4,000 characters → 400');
    equal((await b.call('me/avatar', 'POST', { uploadId: photo.data.id, thumb: THUMB })).status, 400, "another member's photo → 400");
    equal((await a.call('me/avatar', 'POST', { uploadId: first.data.id, thumb: THUMB })).status, 400, 'a photo already in a post → 400');
    const set = await a.call('me/avatar', 'POST', { uploadId: photo.data.id, thumb: THUMB });
    equal([set.status, set.data.avatar_id, set.data.avatar_thumb], [200, photo.data.id, THUMB], 'A sets a 프로필 사진');
    const prof = (await guest(`users/${a.user.id}`)).data.user;
    equal([prof.avatar_id, prof.avatar_thumb], [photo.data.id, THUMB], 'GET users/:id has avatar_id and avatar_thumb');
    equal((await guest('images/' + photo.data.id)).status, 200, 'the 프로필 사진 is public');
    equal((await guest(`posts/${id}`)).data.post.author_avatar_thumb, THUMB, 'the post author box carries the 64px copy');
    equal((await b.call('chats')).data.chats.find(c => c.id === chat)?.avatar_thumb, THUMB, 'the chat list row carries it');
    equal((await b.call('chats/' + chat)).data.chat.partner.avatar_thumb, THUMB, 'the room header carries it');
    equal((await b.call(`manage/users/${a.user.id}/avatar`, 'DELETE')).status, 403, "a member cannot remove another member's photo");
    equal((await manager(`manage/users/${a.user.id}`)).data.user.avatar_thumb, THUMB, 'the member panel shows the photo');
    equal((await manager(`manage/users/${a.user.id}/avatar`, 'DELETE')).status, 200, "the manager removes it ('프로필 사진 삭제')");
    check(!(await guest(`users/${a.user.id}`)).data.user.avatar_thumb, 'the profile is back to the initial');
    equal((await a.call('me/avatar', 'POST', { uploadId: photo.data.id, thumb: THUMB })).status, 200, 'A sets it again');
    equal((await a.call('me/avatar', 'DELETE')).status, 200, 'DELETE me/avatar');
    const cleared = (await guest(`users/${a.user.id}`)).data.user;
    equal([cleared.avatar_id, cleared.avatar_thumb, (await guest(`posts/${id}`)).data.post.author_avatar_thumb], [undefined, undefined, undefined], 'DELETE clears it everywhere');

    // ---- 비밀번호 찾기 (WP59): one answer for every id, 3 an hour per address, the manager's list ----
    sql("DELETE FROM rate_limits WHERE key LIKE 'reset-ip:%'");
    const known = await guest('auth/reset-request', 'POST', { username: `pa_${run}_a`, contact: 'https://open.kakao.com/o/qa' + run });
    const unknown = await guest('auth/reset-request', 'POST', { username: `nobody_${run}`, contact: '010-0000-0000' });
    equal([known.status, unknown.status, JSON.stringify(known.data)], [200, 200, JSON.stringify(unknown.data)], 'an existing and an unknown id get identical 200 answers');
    equal((await guest('auth/reset-request', 'POST', { username: `pa_${run}_a`, contact: '' })).status, 400, 'an empty 연락받을 곳 → 400');
    equal((await guest('auth/reset-request', 'POST', { username: `pa_${run}_a`, contact: 'x'.repeat(101) })).status, 400, '연락받을 곳 over 100 characters → 400');
    equal((await guest('auth/reset-request', 'POST', { username: `pa_${run}_b`, contact: '010-1111-1111' })).status, 200, 'a third request within the hour');
    equal((await guest('auth/reset-request', 'POST', { username: `pa_${run}_a`, contact: '010-2222-2222' })).status, 429, 'the 4th within an hour → 429');
    const resets = await manager('manage/reset-requests');
    const named = resets.data.requests.find(r => r.username === `pa_${run}_a`);
    check(named && named.user_id === a.user.id && named.nickname === a.user.nickname && named.identity === false && named.contact === 'https://open.kakao.com/o/qa' + run && named.created_at > 0, 'the manager lists the existing one with its member, 본인 인증 status and 연락받을 곳');
    check(resets.data.requests.some(r => r.username === `nobody_${run}` && r.user_id === null), 'an unknown id is listed without a member');
    equal((await a.call('manage/reset-requests')).status, 403, 'a member gets 403');
    check((await manager('manage')).data.pendingResets >= 3, 'the tab counts the pending requests');
    equal((await manager(`manage/reset-requests/${named.id}`, 'PATCH', { status: 'done' })).status, 200, '처리 완료');
    check(!(await manager('manage/reset-requests')).data.requests.some(r => r.id === named.id), 'a finished request leaves the list');
    equal((await manager(`manage/reset-requests/${named.id}`, 'PATCH', { status: 'done' })).status, 404, 'a finished request cannot be finished again');
    sql(`UPDATE reset_requests SET status='done' WHERE username IN ('pa_${run}_a','pa_${run}_b','nobody_${run}')`);
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

    // 프로필 사진 (WP59): a photo set as the avatar is in use, so the daily cleanup keeps it, while an unused
    // photo of the same age goes.
    const photo = await a.call('uploads', 'POST', undefined, { type: 'image/png', bytes: png.slice(0, 1600) });
    const loose = await a.call('uploads', 'POST', undefined, { type: 'image/png', bytes: png.slice(0, 1700) });
    equal((await a.call('me/avatar', 'POST', { uploadId: photo.data.id, thumb: THUMB })).status, 200, 'M sets a 프로필 사진');
    sql(`UPDATE uploads SET created_at=${Date.now() - 2 * 86400000} WHERE id IN ('${photo.data.id}','${loose.data.id}')`);
    for (let i = 0; i < 30 && storageOf(loose.data.id) !== undefined; i++) await fireCron();
    equal([storageOf(loose.data.id), storageOf(photo.data.id) !== undefined], [undefined, true], 'the 프로필 사진 survives the daily cleanup (an unused photo of the same age is removed)');
    equal((await client()('images/' + photo.data.id)).status, 200, 'and still serves');
    equal((await a.call('me/avatar', 'DELETE')).status, 200, 'DELETE me/avatar');
    equal((await a.call('users/' + a.user.id)).data.user.avatar_id, undefined, 'the photo is cleared');
}
console.log(`PASS R2 parity, ${phase} phase (${checks} checks)`);
