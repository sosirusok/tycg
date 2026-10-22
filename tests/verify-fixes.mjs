import assert from 'node:assert/strict';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Race conditions, nickname rules, the retired 대리 boards and 대리 인증 (0064), exchange
// wanted ladders, skin aliases and photo access. Runs only against a local Worker
// (see scripts/test-local.mjs); the daily cleanup is checked in verify-cleanup.mjs.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

// Reads or changes the local D1 database the Worker is using.
function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

function client() {
    let cookie = '';
    return async (path, method = 'GET', data, raw) => {
        const send = () => fetch(base + '/api/' + path, {
            method, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(raw ? { 'Content-Type': raw.type } : data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: raw ? raw.bytes : data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data),
        });
        // The local server closes idle keep-alive connections while the wrangler SQL checks run, and the
        // connection of an upload it refuses early (the over-quota uploads below); a request that lands on
        // such a closed connection ('other side closed') never reached the Worker, so it is sent once more.
        const response = await send().catch(e => { if (e?.cause?.code === 'UND_ERR_SOCKET' || /other side closed/.test(String(e?.cause?.message))) return send(); throw e; });
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        if (!(response.headers.get('content-type') || '').includes('json')) { await response.arrayBuffer(); return { status: response.status }; }
        return { status: response.status, data: await response.json() };
    };
}

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const photo = async c => { const r = await c('uploads', 'POST', undefined, { type: 'image/png', bytes: png }); assert.equal(r.status, 201, 'upload'); return r.data.id; };

async function register(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `f_${run}_${name}`.slice(0, 24), password, nickname: `${name}${run}` });
    assert.equal(r.status, 200, `${name} registers`);
    c.user = r.data.user;
    return c;
}

const manager = client(), guest = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const a = await register('fa'), b = await register('fb'), c = await register('fc');

// Nicknames: look-alikes of the manager and staff words are refused; NFKC form is stored.
{
    const tries = [['우와오​', 400, 'zero-width space'], ['우ㅤ와오', 400, 'Hangul filler'], ['우 와 오', 409, 'spaced 우와오'], ['진짜우와오', 409, 'contains 우와오'], ['운영자' + run.slice(0, 4), 409, 'staff word']];
    for (const [nickname, status, label] of tries) {
        const r = await client()('auth/register', 'POST', { username: `n_${run}_${checks}`, password, nickname });
        equal(r.status, status, `nickname refused: ${label}`);
    }
    const wide = await client()('auth/register', 'POST', { username: `w_${run}`, password, nickname: `ＡＢ${run}` });
    equal([wide.status, wide.data.user?.nickname], [200, `AB${run}`], 'full-width letters are stored in NFKC form');
    equal((await b('users/' + b.user.id, 'PUT', { nickname: '우와오', bio: '' })).status, 409, 'renaming to the manager nickname is refused');
    equal((await b('users/' + b.user.id, 'PUT', { nickname: b.user.nickname, bio: '소개' })).status, 200, 'unchanged nickname still saves the bio');
}

// Two decisions on one application: only one takes effect.
{
    const app = await a('applications', 'POST', { kind: 'badge', target: 'identity' });
    equal(app.status, 201, 'identity application');
    const decisions = await Promise.all([
        manager('applications/' + app.data.id, 'PATCH', { action: 'approve' }),
        manager('applications/' + app.data.id, 'PATCH', { action: 'reject', note: '중복' }),
    ]);
    equal(decisions.map(r => r.status).sort(), [200, 409], 'overlapping decisions: one succeeds, the other gets 409');
    const approved = decisions[0].status === 200;
    const me = await a('auth/me');
    equal(me.data.user.badges.includes('identity'), approved, 'badge matches the decision that won');
    const msgs = await a(`chats/${app.data.chatId}/messages`);
    equal(msgs.data.messages.filter(m => m.type === 'system' && m.reference_id === app.data.id).length, 1, 'exactly one decision message');
    equal((await a('applications/' + app.data.id, 'PATCH', { action: 'cancel' })).status, 409, 'a decided application cannot be cancelled');

    const grade = await a('applications', 'POST', { kind: 'grade', target: 'plus', plan: 'permanent' });
    const both = await Promise.all([1, 2].map(() => manager('applications/' + grade.data.id, 'PATCH', { action: 'approve' })));
    equal(both.map(r => r.status).sort(), [200, 409], 'double-click approve grants once');
    const detail = await manager('manage/users/' + a.user.id);
    equal(detail.data.grants.filter(g => g.application_id === grade.data.id).length, 1, 'one grade row for one application');
}

// Two simultaneous applications for the same verification share one request.
{
    const [x, y] = await Promise.all([1, 2].map(() => b('applications', 'POST', { kind: 'badge', target: 'credit' })));
    check([x.status, y.status].every(s => s === 200 || s === 201), 'simultaneous applications both succeed');
    equal(x.data.id, y.data.id, 'simultaneous applications return the same request');
    const mine = await b('applications');
    equal(mine.data.applications.filter(p => p.target === 'credit' && p.status === 'pending').length, 1, 'only one pending request stored');
}

// Unknown ids and legacy hashes.
{
    equal((await client()('auth/login', 'POST', { username: `nobody_${run}`, password })).status, 401, 'unknown id gets the same 401');
    const user = `lg_${run}`, pass = 'legacy-' + run, salt = randomBytes(32).toString('hex');
    sql(`INSERT INTO users (id,username,nickname,password_hash,salt,role,bio,created_at) VALUES ('${crypto.randomUUID()}','${user}','레거시${run}','${pbkdf2Sync(pass, salt, 100000, 32, 'sha256').toString('hex')}','${salt}','member','',${Date.now()})`);
    equal((await client()('auth/login', 'POST', { username: user, password: pass })).status, 200, 'legacy hash signs in');
    check(sql(`SELECT password_hash FROM users WHERE username='${user}'`)[0].password_hash.startsWith('pbkdf2-sha256$20000$'), 'legacy hash is replaced with the current format');
    equal((await client()('auth/login', 'POST', { username: user, password: pass })).status, 200, 'upgraded hash signs in');
    const huge = JSON.stringify({ username: 'x'.repeat(70000), password });
    equal((await client()('auth/login', 'POST', huge)).status, 413, 'JSON bodies over 64 KB are refused');
}

// 대리 (2026-10-22: 게임산업법 제32조 제1항 제11호): no post of the two retired kinds can be written, edited, bumped
// or found, and 대리 인증 is neither applied for, granted nor shown. Two old posts stand for one the previous Worker
// wrote during the deploy (still visible); 0064_proxy_closed then hides them and cancels the waiting application.
{
    const PROXY_CLOSED = '대리 글은 더 이상 쓸 수 없습니다.', NO_BUMP = '대리 글은 끌올할 수 없습니다.';
    const old = { category: 'ladder', title: `[QA] 대리 ${run}`, body: '자동 검증', price: 20000, status: 'open', tags: [], images: [], details: {} };
    for (const kind of ['proxy_offer', 'proxy_request']) {
        const r = await c('posts', 'POST', { ...old, kind });
        equal([r.status, r.data.error], [400, PROXY_CLOSED], `a new ${kind} post is refused`);
        equal((await manager('posts', 'POST', { ...old, kind })).status, 400, `the manager cannot write ${kind} either`);
    }
    const apply = await c('applications', 'POST', { kind: 'badge', target: 'proxy' });
    equal([apply.status, apply.data.error], [400, '신청할 인증을 선택해 주세요.'], 'a 대리 인증 application is refused');
    equal((await manager(`manage/users/${c.user.id}/badges`, 'POST', { badge: 'proxy', active: true })).status, 400, 'the manager cannot grant 대리 인증');
    const countBefore = (await guest('users/' + c.user.id)).data.user.postCount, now = Date.now();
    sql(`INSERT INTO posts(author_id,kind,title,body,price,status,category,price_mode,details,images,created_at,updated_at,bumped_at,title_key) VALUES
        ('${c.user.id}','proxy_offer','[QA] 옛 대리 진행 ${run}','자동 검증',20000,'open','ladder','fixed','{}','[]',${now},${now},${now},'qa옛대리진행${run}'),
        ('${c.user.id}','proxy_request','[QA] 옛 대리 구함 ${run}','자동 검증',NULL,'open','story','negotiate','{}','[]',${now},${now},${now},'qa옛대리구함${run}');
        INSERT INTO user_badges(user_id,badge,granted_by,granted_at) VALUES('${c.user.id}','proxy','manager',${now});
        INSERT INTO applications(id,user_id,kind,target,plan,status,conversation_id,note,created_at,updated_at) VALUES('qa-proxy-${run}','${c.user.id}','badge','proxy',NULL,'pending',NULL,'',${now},${now});`);
    const idOf = kind => sql(`SELECT id FROM posts WHERE author_id='${c.user.id}' AND kind='${kind}'`)[0].id;
    const offerId = idOf('proxy_offer'), requestId = idOf('proxy_request'), olds = [offerId, requestId];
    const sale = await c('posts', 'POST', { ...old, kind: 'sell', category: 'other', title: `[QA] 대리 옆 판매 ${run}` });
    equal(sale.status, 201, 'a 판매 post of the same member');
    const shows = async (viewer, query) => (await viewer('posts?' + new URLSearchParams({ size: '40', ...query }))).data.posts.some(p => olds.includes(p.id));
    check(!await shows(guest, { q: run }) && !await shows(a, { q: run }) && !await shows(guest, { q: run, kind: 'proxy_offer' }), 'no search lists an old 대리 post');
    check(!await shows(guest, { kind: 'proxy_request', category: 'story' }) && !await shows(guest, { old: '1' }), 'no board lists one');
    const counts = (await guest('posts?' + new URLSearchParams({ q: run }))).data.counts;
    equal(Object.keys(counts || {}).sort(), ['buy', 'exchange', 'sell'], 'a search counts the three boards only');
    check(!await shows(guest, { author: c.user.id }) && await shows(c, { author: c.user.id }), 'the profile list leaves them out; the author still has them in 내 글');
    const profile = (await guest('users/' + c.user.id)).data.user;
    equal(profile.postCount, countBefore + 1, 'the profile post count leaves them out (only the 판매 post is added)');
    check(!profile.badges.includes('proxy'), 'an old 대리 인증 row is not shown');
    check(!(await manager('manage/users/' + c.user.id)).data.badges.some(x => x.badge === 'proxy'), 'not in the member panel either');
    const home = (await guest('home')).data;
    check(!('proxy_offer' in home.shelves) && !Object.values(home.shelves).flat().some(p => olds.includes(p.id)), 'the home page has no 대리 shelf and no 대리 post');
    equal([(await guest('posts/' + offerId)).status, (await a('posts/' + requestId)).status], [404, 404], 'other members get 404');
    equal([(await c('posts/' + offerId)).status, (await manager('posts/' + requestId)).status], [200, 200], 'the author and the manager still open them');
    equal((await c('posts/' + offerId, 'PUT', { ...old, kind: 'proxy_offer' })).data.error, PROXY_CLOSED, 'an edit is refused');
    equal((await c('posts/' + offerId, 'PUT', { ...old, kind: 'sell', category: 'other' })).data.error, PROXY_CLOSED, 'and so is an edit into another board');
    equal((await c(`posts/${offerId}/bump`, 'POST')).data.error, NO_BUMP, '끌올 is refused');
    equal((await c('posts/bulk', 'POST', { action: 'bump', ids: [requestId] })).data.skipped, [{ id: requestId, reason: NO_BUMP }], '일괄 끌올 skips it');
    equal((await c(`posts/${offerId}/auto`, 'PUT', { bump: true })).data.error, NO_BUMP, '자동 끌올 is refused');
    // 광고 and 자동 끌올 slots: a 대리 post still visible never takes one. A 프리미엄 grant fills the ad slot with the newest
    // open post that is not of a retired kind (the 대리 post is bumped last here).
    sql(`UPDATE posts SET bumped_at=${Date.now() + 60000} WHERE id=${offerId}`);
    equal((await manager(`manage/users/${c.user.id}/grades`, 'POST', { grade: 'premium', plan: '6m' })).status, 201, 'c gets 프리미엄');
    equal(sql(`SELECT id FROM posts WHERE author_id='${c.user.id}' AND featured_at IS NOT NULL`).map(r => r.id), [sale.data.id], 'the grant fills the ad slot with the 판매 post, not the newer 대리 post');
    check(!sql(`SELECT post_id FROM post_auto WHERE user_id='${c.user.id}' AND bump=1`).some(r => olds.includes(r.post_id)), 'and enrols no 대리 post in 자동 끌올');
    sql(`UPDATE posts SET featured_at=${Date.now()} WHERE id=${offerId}`);
    equal((await c('me/usage')).data.featured.map(p => p.id), [sale.data.id], "a 대리 post the previous Worker stamped is not counted as the member's ad");
    const premium = sql(`SELECT id FROM user_grades WHERE user_id='${c.user.id}' AND grade='premium'`)[0].id;
    equal((await manager(`manage/users/${c.user.id}/grades/${premium}`, 'DELETE')).status, 200, '프리미엄 회수');
    // What 0064 also clears: saved searches and 알림 of the retired boards, the chat's '문의한 글' title, 알림함 rows, and
    // the public 거래 기록 never shows the title of a trade of a retired kind.
    sql(`INSERT INTO saved_searches(id,user_id,name,query,created_at,alert,alert_kind,keyword) VALUES
        ('qa-ss1-${run}','${c.user.id}','옛 게시판 알림','category=ladder&kind=proxy_offer',${now},1,'proxy_offer',1),
        ('qa-ss2-${run}','${c.user.id}','옛 검색','kind=proxy_request&q=x',${now},0,'',1),
        ('qa-ss3-${run}','${c.user.id}','판매 검색','kind=sell&q=proxy_offer',${now},0,'',1)`);
    const room = (await a('chats', 'POST', { userId: c.user.id })).data.id;
    sql(`INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) VALUES
        ('${room}','${a.user.id}','[QA] 옛 대리 진행 ${run}','listing','${offerId}','[]',${now}),('${room}','${a.user.id}','[QA] 대리 옆 판매 ${run}','listing','${sale.data.id}','[]',${now});
        INSERT INTO notifications(user_id,type,ref,post_id,actor_id,text,created_at) VALUES
        ('${a.user.id}','fav_closed','${offerId}',${offerId},'${c.user.id}','[QA] 옛 알림 ${run}',${now}),('${a.user.id}','fav_closed','${sale.data.id}',${sale.data.id},'${c.user.id}','[QA] 판매 알림 ${run}',${now});
        INSERT INTO trades(id,post_id,seller_id,buyer_id,price,created_at,author_id,confirmed_at,kind,category,title) VALUES
        ('qa-tp-${run}',${offerId},'${c.user.id}','${a.user.id}',20000,${now},'${c.user.id}',${now},'proxy_offer','ladder','[QA] 옛 대리 진행 ${run}');`);
    const traded = (await guest(`users/${c.user.id}/trades`)).data.trades.find(t => t.id === `qa-tp-${run}`);
    equal([traded?.kind, traded?.title], ['proxy_offer', ''], 'the public 거래 기록 sends a trade of a retired kind without its title');
    // 0064_proxy_closed, as the deploy applies it.
    sql(readFileSync(new URL('../migrations/0064_proxy_closed.sql', import.meta.url), 'utf8').replace(/^--.*$/gm, '').trim());
    equal(sql(`SELECT id FROM saved_searches WHERE id LIKE 'qa-ss%-${run}' ORDER BY id`).map(r => r.id), [`qa-ss3-${run}`], '0064 removes the saved searches and 알림 of the retired boards only');
    equal(sql(`SELECT body FROM messages WHERE conversation_id='${room}' AND type='listing' ORDER BY id`).map(r => r.body), ['종료된 분류의 글', `[QA] 대리 옆 판매 ${run}`], "0064 makes the '문의한 글' card of a 대리 post neutral");
    equal(sql(`SELECT text FROM notifications WHERE user_id='${a.user.id}' AND text LIKE '[QA] %${run}'`).map(r => r.text), [`[QA] 판매 알림 ${run}`], '0064 removes the 알림함 rows about 대리 posts');
    sql(`DELETE FROM saved_searches WHERE id='qa-ss3-${run}'; DELETE FROM trades WHERE id='qa-tp-${run}'; DELETE FROM notifications WHERE user_id='${a.user.id}' AND text LIKE '[QA] %${run}'`);
    equal(sql(`SELECT hidden,hidden_reason FROM posts WHERE id IN (${olds.join(',')}) ORDER BY id`), [{ hidden: 1, hidden_reason: '대리 카테고리 종료' }, { hidden: 1, hidden_reason: '대리 카테고리 종료' }], '0064 hides the old 대리 posts with the reason');
    equal(sql(`SELECT hidden FROM posts WHERE id=${sale.data.id}`)[0].hidden, 0, 'and leaves the 판매 post alone');
    equal(sql(`SELECT status FROM applications WHERE id='qa-proxy-${run}'`)[0].status, 'cancelled', '0064 cancels the waiting 대리 인증 application');
    equal(sql(`SELECT COUNT(*) AS n FROM user_badges WHERE user_id='${c.user.id}' AND badge='proxy'`)[0].n, 1, 'the user_badges row stays as the record');
    equal((await c('posts/' + offerId)).data.post.hidden_reason, '대리 카테고리 종료', 'the author sees why');
    equal((await manager('manage/visibility', 'POST', { postId: offerId, hidden: false })).data.error, '대리 글은 다시 공개할 수 없습니다.', 'the manager cannot publish one again');
    check((await manager('manage')).data.hidden.some(p => p.id === offerId), "the manager's 숨긴 글 lists it");
    equal((await c(`posts/${offerId}/status`, 'PATCH', { status: 'closed' })).status, 200, 'its author can still close it');
    equal((await c('posts/' + requestId, 'DELETE')).status, 200, 'and delete it');
    for (const id of [offerId, sale.data.id]) equal((await c('posts/' + id, 'DELETE')).status, 200, `test post ${id} removed`);
    sql(`DELETE FROM user_badges WHERE user_id='${c.user.id}' AND badge='proxy'`);
}

// Exchange posts store the ladders they want and can be searched from the wanted side.
{
    const exchange = {
        kind: 'exchange', category: 'account', title: `[QA] 교환 ${run}`, body: '자동 검증', status: 'open', images: [],
        tags: [{ tier: 'gold', season: 20 }], wantedTags: [{ tier: 'master', season: 30 }, { tier: 'champion', season: 31 }],
        details: { wantedCategory: 'account', wantedMaxOwners: '3', wantedNicknameCharsMin: '2', wantedNicknameCharsMax: '3', wantedNicknameRanks: JSON.stringify(['S', 'A']) },
    };
    equal((await a('posts', 'POST', { ...exchange, wantedTags: [{ tier: 'iron', season: 24 }] })).status, 400, 'wanted ladder uses the same season ranges');
    const r = await a('posts', 'POST', exchange);
    equal(r.status, 201, 'exchange with wanted ladders');
    const got = await guest('posts/' + r.data.id);
    equal(got.data.post.wanted_tags.map(t => t.tier + t.season).sort(), ['champion31', 'master30'], 'wanted ladders are returned');
    equal(got.data.post.tags, [{ tier: 'gold', season: 20 }], 'offered ladder stays separate');
    const finds = async extra => (await guest('posts?' + new URLSearchParams({ kind: 'exchange', category: 'account', wantedCategory: 'account', q: run, ...extra }))).data.posts.some(p => p.id === r.data.id);
    check(await finds({ wantedTags: JSON.stringify([{ tier: 'master', season: 30 }]) }), 'wanted ladder search matches');
    check(!await finds({ wantedTags: JSON.stringify([{ tier: 'master', season: 29 }]) }), 'wanted ladder search excludes other seasons');
    check(!await finds({ tags: JSON.stringify([{ tier: 'master', season: 30 }]) }), 'offered-ladder search does not match wanted ladders');
    check(await finds({ wantedOwnerCountOfMine: '3' }), 'my 3-owner account fits "3대주 이하"');
    check(!await finds({ wantedOwnerCountOfMine: '4' }), 'my 4-owner account does not fit');
    check(await finds({ wantedNicknameChars: '2' }) && !await finds({ wantedNicknameChars: '4' }), 'wanted nickname length is a range');
    check(await finds({ wantedNicknameRank: 'S' }) && !await finds({ wantedNicknameRank: 'B' }), 'wanted nickname rank matches any chosen rank');
    equal((await a('posts/' + r.data.id, 'PUT', { ...exchange, details: { wantedCategory: 'clan' } })).status, 200, 'switch to wanting a clan');
    equal((await guest('posts/' + r.data.id)).data.post.wanted_tags, [], 'wanted ladders are cleared for a clan');
}

// Skin names: the owner's spelling is stored; in-game names and short forms search too.
{
    const r = await b('posts', 'POST', { kind: 'sell', category: 'account', title: `[QA] 스킨 ${run}`, body: '자동 검증', price: 10000, status: 'open', tags: [], images: [], details: { skinTags: JSON.stringify(['악몽주인', '서큐 날개', '송편좀비']) } });
    equal(r.status, 201, 'owner spellings are valid skin values');
    const finds = async extra => (await guest('posts?' + new URLSearchParams({ kind: 'sell', category: 'account', ...extra }))).data.posts.some(p => p.id === r.data.id);
    for (const word of ['악주', '악몽의 주인', '서큐버스 날개', '송편 좀비', '송편좀비']) check(await finds({ q: word }), `search "${word}" finds the skin`);
    check(await finds({ skinTags: JSON.stringify(['악몽주인']) }), 'skin filter matches');
    equal((await guest('posts?' + new URLSearchParams({ skinTags: JSON.stringify(['악몽의 주인']) }))).status, 400, 'filter values stay on the fixed list');
}

// Unread count endpoint and private grade end dates.
{
    const chat = await a('chats', 'POST', { userId: b.user.id });
    equal((await a(`chats/${chat.data.id}/messages`, 'POST', { body: '안녕하세요 ' + run })).status, 201, 'message sent');
    const unread = await b('chats/unread');
    check(unread.data.unread >= 1, 'unread endpoint counts new messages');
    equal(unread.data.user.id, b.user.id, 'unread endpoint returns the current member');
    const msgs = await b(`chats/${chat.data.id}/messages`);
    await b(`chats/${chat.data.id}/read`, 'POST', { lastId: Math.max(...msgs.data.messages.map(m => m.id)) });
    equal((await b('chats/unread')).data.unread, (await b('chats')).data.chats.reduce((n, x) => n + x.unread, 0), 'unread endpoint agrees with the chat list');

    equal((await manager(`manage/users/${b.user.id}/grades`, 'POST', { grade: 'premium', plan: '6m' })).status, 201, '6-month grade granted');
    const post = await b('posts', 'POST', { kind: 'buy', category: 'other', title: `[QA] 등급 ${run}`, body: '자동 검증', price: null, status: 'open', tags: [], images: [], details: {} });
    const seen = await guest('posts/' + post.data.id);
    equal([seen.data.post.author_grade, 'author_grade_expires_at' in seen.data.post], ['premium', false], 'posts show the grade but not its end date');
    const list = await a('chats');
    check(list.data.chats.every(x => !('grade_expires_at' in x)), 'chat list hides partner grade end dates');
    check(typeof (await b('auth/me')).data.user.grade_expires_at === 'number', 'the member still sees their own end date');
}

// Photo access follows the post or chat that uses it.
{
    const inPost = await photo(a), inChat = await photo(a), unused = await photo(a);
    const post = await a('posts', 'POST', { kind: 'sell', category: 'other', title: `[QA] 사진 ${run}`, body: '자동 검증', price: 10000, status: 'open', tags: [], images: [inPost], details: {} });
    equal(post.status, 201, 'post with a photo');
    equal((await guest('images/' + inPost)).status, 200, 'photo in a public post is public');
    equal((await guest('images/' + unused)).status, 404, 'unused photo is private');
    equal((await a('images/' + unused)).status, 200, 'owner sees an unused photo');
    const chat = await a('chats', 'POST', { userId: b.user.id });
    equal((await a(`chats/${chat.data.id}/messages`, 'POST', { body: '', images: [inChat] })).status, 201, 'photo sent in chat');
    equal((await b('images/' + inChat)).status, 200, 'chat partner sees the chat photo');
    equal((await c('images/' + inChat)).status, 404, 'others cannot see the chat photo');
    equal((await manager('manage/visibility', 'POST', { postId: post.data.id, hidden: true })).status, 200, 'manager hides the post');
    equal((await guest('images/' + inPost)).status, 404, 'photo of a hidden post is private');
    await manager('manage/visibility', 'POST', { postId: post.data.id, hidden: false });
    equal((await a('posts/' + post.data.id, 'PUT', { kind: 'sell', category: 'other', title: `[QA] 사진 ${run}`, body: '자동 검증', price: 10000, status: 'open', tags: [], images: [], details: {} })).status, 200, 'photo removed from the post');
    equal((await guest('images/' + inPost)).status, 404, 'removed photo is no longer public');
}

// Photo totals (0018_upload_totals) and the R2 per-member quota (1GB, tier table). This server has R2.
{
    const q = await register('fq');
    await photo(q);
    await photo(q);
    const totals = () => sql(`SELECT upload_rows AS n,upload_bytes AS b FROM users WHERE id='${q.user.id}'`)[0];
    equal(totals(), { n: 2, b: 2 * png.byteLength }, 'the triggers count the member\'s uploads and bytes');
    const one = await photo(q);
    equal((await q('uploads/' + one, 'DELETE')).status, 200, 'an unused photo is deleted');
    equal(totals(), { n: 2, b: 2 * png.byteLength }, 'a delete takes it off the totals');
    sql(`UPDATE users SET upload_bytes=${1024 * 1024 * 1024 - 10} WHERE id='${q.user.id}'`);
    const over = await q('uploads', 'POST', undefined, { type: 'image/png', bytes: png });
    equal([over.status, over.data.error], [409, '사진 용량(1인 1GB)을 넘었습니다. 안 쓰는 사진은 하루 뒤, 삭제한 글의 사진은 30일 뒤 정리됩니다.'], 'R2: an upload over 1GB per member is refused');
    sql(`UPDATE users SET upload_rows=10000,upload_bytes=0 WHERE id='${q.user.id}'`);
    equal((await q('uploads', 'POST', undefined, { type: 'image/png', bytes: png })).status, 409, 'the row ceiling (10,000) is read from the totals');
    sql(`UPDATE users SET upload_rows=1000000,upload_bytes=${1024 * 1024 * 1024 * 50} WHERE id='manager'`);
    const mgr = await manager('uploads', 'POST', undefined, { type: 'image/png', bytes: png });
    equal(mgr.status, 201, 'the manager has only the site limits');
    sql(`UPDATE users SET upload_rows=(SELECT COUNT(*) FROM uploads WHERE owner_id='manager'),upload_bytes=(SELECT COALESCE(SUM(size),0) FROM uploads WHERE owner_id='manager') WHERE id='manager'`);
}

console.log(`\n${checks} fix checks passed`);
