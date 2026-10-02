import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 검색 (WP70) on the strict server with the read meter (READ_BUDGET=on): a word of 3 or more characters
// goes through posts_fts (0061, trigram) and reads only the posts that hold it; shorter words keep the LIKE
// search; 기타 스킨 and every other detail value, the author's nickname and 특징 태그 are found; the skin and
// ladder shorthands still work; the 태그 filter, 레어닉 and the index triggers (edit, nickname, delete).
// Seeds 20,000 '[search]' posts with one `wrangler d1 execute --file` and removes them at the end.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const ROWS = 1000;
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
    const dir = mkdtempSync(path.join(tmpdir(), 'search-'));
    try {
        const file = path.join(dir, 'seed.sql');
        writeFileSync(file, text);
        execFileSync(process.execPath, [...wrangler, '--yes', '--file', file], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
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
        // The seeding takes a few seconds; a request on a connection the server closed meanwhile is sent again.
        const response = await send().catch(e => { if (e?.cause?.code === 'UND_ERR_SOCKET') return send(); throw e; });
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: response.status, data: json, rows: Number(response.headers.get('x-rows-read')), calls: Number(response.headers.get('x-d1-calls')) };
    };
}

// Rows a crashed earlier run left behind would change the numbers below.
const removeSeed = r => sqlFile(`
DELETE FROM posts WHERE title LIKE '[search] ${r} %' OR title LIKE '[QA 검색] ${r} %';
DELETE FROM users WHERE id LIKE 'srch-${r}-%';
`);
removeSeed('%');
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%' OR key LIKE 'post:%'");

const seller = client(), guest = client();
const nickname = `불새장수${run.slice(0, 4)}`;
const reg = await seller('auth/register', 'POST', { username: `srch_${run}`, password, nickname });
equal(reg.status, 200, 'the seller registers');
check(reg.rows > 0, 'the meter headers are on (READ_BUDGET=on)');
const sellerId = reg.data.user.id;

// 20,000 posts of 50 seeded authors across the tabs; every body holds the common word 'srch<run>'. Post
// 777 keeps 기타 스킨 (details.rareSkins, a retired field that only older posts hold) with '불새상류'.
const now = Date.now(), DAY = 86400000;
const kinds = "CASE i%5 WHEN 0 THEN 'sell' WHEN 1 THEN 'buy' WHEN 2 THEN 'exchange' WHEN 3 THEN 'proxy_request' ELSE 'proxy_offer' END";
const category = `CASE WHEN i%5 IN (0,1) THEN (CASE (i/5)%4 WHEN 0 THEN 'account' WHEN 1 THEN 'clan' WHEN 2 THEN 'goods_coupon' ELSE 'other' END)
    WHEN i%5=2 THEN (CASE (i/5)%2 WHEN 0 THEN 'account' ELSE 'clan' END) ELSE (CASE (i/5)%3 WHEN 0 THEN 'ladder' WHEN 1 THEN 'story' ELSE 'event' END) END`;
const seq = n => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${n})`;
const t0 = Date.now();
sqlFile(`
${seq(50)} INSERT INTO users(id,username,nickname,nickname_key,password_hash,salt,role,bio,created_at)
SELECT 'srch-${run}-'||i,'srch_${run}_'||i,'srch${run}n'||i,'srch${run}n'||i,'','','member','',${now} FROM n;
INSERT INTO user_badges(user_id,badge,granted_by,granted_at) SELECT id,'proxy','manager',${now} FROM users WHERE id LIKE 'srch-${run}-%';
${seq(20000)} INSERT INTO posts(author_id,kind,title,body,price,status,created_at,updated_at,category,price_mode,details,images,bumped_at,title_key)
SELECT 'srch-${run}-'||(1+i%50),${kinds},'[search] ${run} '||i,'srch${run} 본문 '||i,12345,'open',
    ${now}-(i%90)*${DAY}-i*1000,${now}-(i%90)*${DAY}-i*1000,${category},'fixed',
    CASE WHEN i=777 THEN '{"rareSkins":"불새상류 엠블럼, 유령 날개"}' ELSE '{}' END,'[]',${now}-(i%90)*${DAY}-i*1000,'search ${run} '||i FROM n;
`);
console.log(`seeded in ${Date.now() - t0} ms`);
equal(sql(`SELECT COUNT(*) AS n FROM posts WHERE title LIKE '[search] ${run} %'`)[0].n, 20000, '20,000 posts are seeded');
equal(sql(`SELECT COUNT(*) AS n FROM posts_fts WHERE rowid IN (SELECT id FROM posts WHERE title LIKE '[search] ${run} %')`)[0].n, 20000, 'the insert trigger indexed every seeded post');
const rare = sql(`SELECT id FROM posts WHERE title='[search] ${run} 777'`)[0].id;

let n = 0;
async function created(payload, label) {
    const r = await seller('posts', 'POST', { status: 'open', images: [], tags: [], price: 300000, body: '검색 검증', ...payload, title: `[QA 검색] ${run} ${++n} ${payload.title || ''}`.trim() });
    equal(r.status, 201, label);
    return r.data.id;
}
const tagged = await created({ kind: 'sell', category: 'account', title: '태그 계정', details: { featureTags: JSON.stringify(['#불새상류', 'Top10']) } }, 'a sale with the tags #불새상류 and Top10');
const apple = await created({ kind: 'sell', category: 'account', title: '레어닉 사과 계정', details: { nicknameChars: '2', nicknameTypes: JSON.stringify(['레어닉']) } }, "a 레어닉 sale ('사과')");
const skin = await created({ kind: 'sell', category: 'account', title: '스킨 계정', details: { skinTags: JSON.stringify(['악몽주인']) } }, 'a sale with 악몽주인');
const ladder = await created({ kind: 'sell', category: 'account', title: '래더 계정', tags: [{ tier: 'challenger', season: 28 }] }, 'a sale with 28시즌 챌린저');
const clan = await created({ kind: 'sell', category: 'clan', title: '클랜', details: { clanName: `포토존${run}`, clanLevel: '7' } }, 'a clan sale');

const ids = r => r.data.posts.map(p => p.id);
// Words other suites also use ('불새상류', skins, ladders) are checked on the seller's own posts (author=)
// or by inclusion; the words of this run are checked exactly.
const mine = `&author=${sellerId}&size=40`;
async function search(query, label) {
    const r = await guest('posts?' + query);
    equal(r.status, 200, label);
    return r;
}

// 기타 스킨, 특징 태그, 클랜명 and the author's nickname are found, reading only the posts that hold the word.
let r = await search('q=' + encodeURIComponent('불새상류'), "q=불새상류");
check(ids(r).includes(rare) && ids(r).includes(tagged) && !ids(r).includes(apple), "'불새상류' finds the post whose 기타 스킨 holds it and the tagged post");
atMost(r.rows, ROWS, 'rows read for q=불새상류 over 20,000 posts');
r = await search('q=' + encodeURIComponent(nickname), 'q=<nickname>');
equal(ids(r).sort((a, b) => a - b), [tagged, apple, skin, ladder, clan].sort((a, b) => a - b), "the seller's nickname finds the seller's posts");
atMost(r.rows, ROWS, 'rows read for a nickname search');
r = await search('q=' + encodeURIComponent(`포토존${run}`), 'q=<클랜명>');
equal(ids(r), [clan], '클랜명 is found');
r = await search('q=' + encodeURIComponent('유령 날개'), 'q=유령 날개');
equal(ids(r), [rare], 'a 기타 스킨 phrase with a space is found');
r = await search('q=' + encodeURIComponent('유령날개'), 'q=유령날개');
equal(ids(r), [rare], 'and without the space (detail values ignore spaces, as before)');
r = await search('q=' + encodeURIComponent('TOP10') + mine, 'q=TOP10');
equal(ids(r), [tagged], 'a Latin tag is found in any case');

// The 태그 filter (post_tags).
r = await search('tag=' + encodeURIComponent('불새상류'), 'tag=불새상류');
check(ids(r).includes(tagged) && !ids(r).includes(rare), 'tag=불새상류 finds the tagged post, not the 기타 스킨 one');
atMost(r.rows, ROWS, 'rows read for tag=불새상류');
r = await search('tag=' + encodeURIComponent('#TOP10') + mine, 'tag=#TOP10');
equal(ids(r), [tagged], "a tag filter reads '#' and case like the stored tag");
equal((await guest('posts?tag=' + encodeURIComponent('불새 상류'))).status, 400, 'a tag with a space is refused');

// 레어닉.
r = await search('kind=sell&category=account&nicknameTypes=' + encodeURIComponent(JSON.stringify(['레어닉'])), 'nicknameTypes=["레어닉"]');
check(ids(r).includes(apple) && !ids(r).includes(tagged), 'nicknameTypes 레어닉 finds the 사과 post');
r = await search('q=' + encodeURIComponent('레어닉') + mine, 'q=레어닉');
equal(ids(r), [apple], "the word '레어닉' finds it through its 닉 종류");

// Words under 3 characters keep the LIKE search; the skin and ladder shorthands still work.
r = await search('q=' + encodeURIComponent('사과') + mine, 'q=사과 (2 characters)');
equal(ids(r), [apple], 'a 2-character word still finds the post (LIKE search)');
r = await search('q=' + encodeURIComponent('악주') + mine, 'q=악주');
equal(ids(r), [skin], "the skin shorthand '악주' finds the 악몽주인 post");
r = await search('q=' + encodeURIComponent('악몽의 주인'), 'q=악몽의 주인');
check(ids(r).includes(skin) && !ids(r).includes(apple), "the in-game name '악몽의 주인' (3+ characters, posts_fts) finds it too");
atMost(r.rows, ROWS, 'rows read for a skin name');
r = await search('q=' + encodeURIComponent('28챌') + mine, 'q=28챌');
equal(ids(r), [ladder], "the ladder shorthand '28챌' finds the 28시즌 챌린저 post");
r = await search('q=' + encodeURIComponent('챌린저') + mine, 'q=챌린저');
equal(ids(r), [ladder], "the bare tier word '챌린저' finds it (posts_fts plus the ladder by id)");
atMost((await search('q=' + encodeURIComponent('챌린저'), 'q=챌린저 everywhere')).rows, ROWS, 'rows read for a tier word');

// A word held by more posts than the full-text limit keeps the LIKE search over the board order.
r = await search(`q=srch${run}&kind=sell&size=16`, 'a common word');
equal([r.data.posts.length, r.data.capped], [16, true], 'a word in 20,000 posts still lists a full page (300+)');
console.log(`  (common word: ${r.rows} rows read, ${r.calls} calls)`);

// The triggers keep posts_fts in step: an edit, a nickname change, a delete.
const editTitle = `[QA 검색] ${run} 수정된제목${run}`;
equal((await seller(`posts/${clan}`, 'PUT', { kind: 'sell', category: 'clan', title: editTitle, body: '검색 검증', price: 300000, tags: [], images: [], details: { clanName: `포토존${run}`, clanLevel: '7' } })).status, 200, 'the clan post is edited');
equal(ids(await search('q=' + encodeURIComponent(`수정된제목${run}`), 'q=<new title>')), [clan], 'the new title is found');
equal(ids(await search('q=' + encodeURIComponent(`${run} 5 클랜`), 'q=<old title>')), [], 'the old title is gone');
const renamed = `바뀐닉${run.slice(0, 4)}`;
sql(`UPDATE users SET nickname='${renamed}' WHERE id='${sellerId}'`);
equal(ids(await search('q=' + encodeURIComponent(renamed), 'q=<new nickname>')).length, 5, 'a new nickname finds the seller\'s posts');
equal(ids(await search('q=' + encodeURIComponent(nickname), 'q=<old nickname>')), [], 'the old nickname finds nothing');
equal((await seller(`posts/${clan}`, 'DELETE')).status, 200, 'the clan post is deleted');
equal(sql(`SELECT COUNT(*) AS n FROM posts_fts WHERE rowid=${clan}`)[0].n, 0, 'the delete trigger removed it from posts_fts');

// Manager settings: 클랜 래더 첫 시즌 (sys:clan_min_season) and 고정 태그 (sys:pinned_tags, default '불새상류').
const manager = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: process.env.TEST_MANAGER_PASSWORD || 'local-manager-password' })).status, 200, 'the manager signs in');
equal((await guest('tags')).data.pinned, ['불새상류'], "the pinned tags default to '불새상류'");
equal((await manager('manage/settings', 'PUT', { clanMinSeason: 10, pinnedTags: '#클랜전, 불새상류' })).data.clanMinSeason, 10, 'the manager sets the first clan-ladder season to 10');
equal((await guest('tags')).data.pinned, ['클랜전', '불새상류'], 'and pins two tags (normalized, in order)');
const early = await seller('posts', 'POST', { kind: 'sell', category: 'clan', title: `[QA 검색] ${run} early`, body: '검색 검증', price: 10000, status: 'open', images: [], tags: [], clanTags: [{ tier: 'gold', season: 9 }], details: {} });
equal(early.status, 400, 'a clan season before the first clan-ladder season is refused');
equal((await manager('manage/settings', 'PUT', { clanMinSeason: 0 })).status, 400, 'a first season of 0 is refused');
equal((await manager('manage/settings', 'PUT', { pinnedTags: '불새 상류' })).status, 400, 'a pinned tag with a space is refused');
sql("DELETE FROM settings WHERE key IN ('sys:clan_min_season','sys:pinned_tags')");
equal((await guest('config')).data.clanMinSeason, 6, 'without the setting the first clan-ladder season is 6');

removeSeed(run);
equal(sql(`SELECT COUNT(*) AS n FROM posts_fts WHERE posts_fts MATCH '"srch${run}"'`)[0].n, 0, 'the seed is removed, from posts_fts too');
equal((await seller('auth/me')).status, 200, 'the seller is still signed in');
console.log(JSON.stringify({ passed: checks, suite: 'search' }));
