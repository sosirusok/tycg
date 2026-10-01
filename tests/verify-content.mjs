import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// 자동 링크, 링크 차단 and 링크 미리보기 (WP48) on the 8790 server, which scripts/test-local.mjs starts with
// PREVIEW_TEST_ORIGIN pointing at tests/fixtures/preview-server.mjs (every preview fetch goes there as
// <origin>/<host><path>; the address and redirect checks stay the production ones).
// 1. findLinks (shared/links.ts, bundled on the fly). 2. The manager's blocklist on posts and chat.
// 3. Save-time previews by grade, switch, redirect, size, type, image host, cache. 4. Reads: lists
// carry no cards, edits drop removed links, an ended grade shows none.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const fixture = process.env.PREVIEW_TEST_ORIGIN;
assert.ok(fixture, 'PREVIEW_TEST_ORIGIN (the preview fixture) is required.');
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }
function refused(r, status, text, name) {
    assert.equal(r.status, status, `${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    assert.ok(String(r.data.error || '').includes(text), `${name}: ${r.data.error}`);
    checks++;
    console.log(`PASS ${name} (${r.data.error})`);
}

function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

// ---- 1. findLinks, pure ----
const bundle = await build({ configFile: false, logLevel: 'silent', root, build: { lib: { entry: 'shared/links.ts', formats: ['es'], fileName: 'links' }, write: false, minify: false } });
const L = await import('data:text/javascript;base64,' + Buffer.from((Array.isArray(bundle) ? bundle[0] : bundle).output[0].code).toString('base64'));
const texts = s => L.findLinks(s).map(l => s.slice(l.start, l.end));
const urls = (s, o) => L.findLinks(s, o).map(l => l.url);
equal(texts('https://open.kakao.com/o/abc로 연락'), ['https://open.kakao.com/o/abc'], 'unit: a Korean word right after the path ends the link');
equal(texts('오픈채팅(https://open.kakao.com/o/abc).'), ['https://open.kakao.com/o/abc'], "unit: a trailing ').' is trimmed");
equal(texts('위키 https://en.wikipedia.org/wiki/Zombie_(game), 참고'), ['https://en.wikipedia.org/wiki/Zombie_(game)'], 'unit: balanced parentheses stay, a trailing comma goes');
for (const s of ['http://1.2.3.4/x', 'http://[::1]/x', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'https://user:pass@example.com/x', 'https://example.com:8080/x',
    'http://localhost/x', 'https://printer.local/x', 'https://db.internal/x', 'https://nodot/x', 'http://0x7f.1/x', 'https://xn--80ak6aa92e.com/x'])
    equal(urls(s), [], `unit: no link for ${s}`);
equal(urls('www.x.com 참고'), ['https://www.x.com/'], "unit: 'www.x.com' links to https");
equal(urls('https://example.com:443/a'), ['https://example.com/a'], 'unit: port 443 is allowed');
equal(urls('가짜 https://k\u0430kao.com/login'), [], 'unit: a Cyrillic look-alike host is not linked');
equal(urls('https://kakao-login.xyz/o/abc'), [], 'unit: kakao-login.xyz (a brand look-alike) stays plain text');
equal(urls('https://naver.com.evil.xyz/ https://youtube-free.example/ https://toss-event.example/'), [], 'unit: naver, youtube and toss outside their domains stay plain text');
equal(urls('https://m.cafe.naver.com/a https://youtu.be/dQw4w9WgXcQ https://thecheat.co.kr'), ['https://m.cafe.naver.com/a', 'https://youtu.be/dQw4w9WgXcQ', 'https://thecheat.co.kr/'], 'unit: the real brand domains link');
equal(urls('https://sub.bad.example/x https://good.example/', { blocked: ['bad.example'] }), ['https://good.example/'], 'unit: a blocked domain and its subdomains stay plain text');
equal(urls('xhttps://a.example/ awww.b.example'), [], 'unit: an address glued to a word is not linked');
equal(urls('https://' + 'a'.repeat(1990) + '.example/'), [], 'unit: an address over 2,000 characters is not linked');
equal(urls('http://127.0.0.1:8790/posts/3', { selfHost: '127.0.0.1:8790' }), ['http://127.0.0.1:8790/posts/3'], "unit: the site's own host is linked (in-app post links)");
equal(L.parseBlockedDomains('https://www.Bad.example/path\n*.evil.example\nnot a domain\nbad.example'), ['bad.example', 'evil.example'], 'unit: blocklist lines are normalized and deduped');
equal(L.distinctLinks('https://a.example/ https://a.example/ https://b.example/ https://c.example/ https://d.example/'), ['https://a.example/', 'https://b.example/', 'https://c.example/'], 'unit: the first 3 distinct addresses');

// ---- API helpers ----
async function send(url, init) {
    try { return await fetch(url, init()); }
    catch (error) {
        if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
        return fetch(url, init());
    }
}
function client() {
    let cookie = '';
    return async (path, method = 'GET', data) => {
        const response = await send(base + '/api/' + path, () => ({
            method, redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: data === undefined ? undefined : JSON.stringify(data),
        }));
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); }
        catch { throw new Error(`${method} ${path}: expected JSON, received HTTP ${response.status}: ${text.slice(0, 300)}`); }
        return { status: response.status, data: result };
    };
}
async function register(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `ct_${run}_${name}`.slice(0, 24), password, nickname: `링크${name}${run}`.slice(0, 16) });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%'");
const manager = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const grant = async (c, grade, plan = 'permanent') => equal((await manager(`manage/users/${c.user.id}/grades`, 'POST', { grade, plan })).status, 201, `manager grants ${grade} ${plan}`);
let n = 0;
const sale = (body, extra = {}) => ({ kind: 'sell', category: 'other', title: `[QA] 링크 ${run} ${++n}`, body, price: 10000, tags: [], images: [], details: {}, ...extra });
async function post(c, body, extra) {
    const r = await c('posts', 'POST', sale(body, extra));
    assert.equal(r.status, 201, `post: ${JSON.stringify(r.data)}`);
    return r.data.id;
}
const cards = async (c, id) => (await c('posts/' + id)).data.post.link_cards;
const hits = async () => (await fetch(fixture + '/__hits')).json();

const normal = await register('n'), plus = await register('p'), other = await register('o'), ender = await register('e');
await grant(plus, 'plus');
await grant(other, 'plus');
await grant(ender, 'premium', '6m');

// ---- 2. 링크 차단 ----
refused(await normal('manage/links'), 403, '매니저', 'a member cannot read the blocklist');
const blockedList = (await manager('manage/links', 'PUT', { domains: 'https://www.Bad-Link.example/x\n*.evil-link.example\n잘못된 줄' })).data;
equal(blockedList.domains, ['bad-link.example', 'evil-link.example'], 'manager saves the blocklist (normalized)');
equal((await manager('manage/links')).data.domains, ['bad-link.example', 'evil-link.example'], 'manager reads it back');
check((await normal('config')).data.blockedLinks.includes('bad-link.example'), 'config carries the blocklist for rendering');
refused(await normal('posts', 'POST', sale('여기로 연락 https://sub.bad-link.example/o/1')), 400, '등록할 수 없는 링크가 있습니다.', 'a post linking a blocked subdomain is refused');
const clean = await post(normal, '깨끗한 글 https://good.example/a');
refused(await normal('posts/' + clean, 'PUT', sale('수정 www.evil-link.example/x')), 400, '등록할 수 없는 링크가 있습니다.', 'an edit adding a blocked link is refused');
const chatId = (await plus('chats', 'POST', { postId: clean })).data.id;
refused(await plus(`chats/${chatId}/messages`, 'POST', { body: '이거 보세요 https://bad-link.example/pay' }), 400, '등록할 수 없는 링크가 있습니다.', 'a chat message with a blocked link is refused');
equal((await plus(`chats/${chatId}/messages`, 'POST', { body: '정상 링크 https://good.example/b' })).status, 201, 'a chat message with a normal link is sent');
equal((await normal('posts', 'POST', sale('bad-link.example 은 주소만 적은 글'))).status, 201, 'a bare domain without www or https is not a link, so it is not refused');
equal((await normal('posts', 'POST', { ...sale('본문'), title: '[QA] https://bad-link.example 제목' })).status, 201, 'titles are never linked, so a blocked address in a title is not refused');
equal((await manager('manage/links', 'PUT', { domains: '' })).data.domains, [], 'manager clears the blocklist');
equal((await normal('posts', 'POST', sale('이제 https://bad-link.example/ok'))).status, 201, 'after clearing, the link is accepted');

// ---- 3. Previews ----
const four = 'https://og.example/1 첫째\n둘째 https://og.example/2\nhttps://og.example/3 그리고 https://og.example/4';
const plusPost = await post(plus, four);
const pc = await cards(plus, plusPost);
equal(pc.map(c => c.url), ['https://og.example/1', 'https://og.example/2', 'https://og.example/3'], 'plus with 4 links gets 3 cards, in order');
equal([pc[0].title, pc[0].description, pc[0].site, pc[0].domain, 'image' in pc[0]], ['미리보기 /1', '미리보기 /1 설명', '예시 사이트', 'og.example', false], 'a card has og:title, og:description, og:site_name and the domain');
equal(await cards(normal, plusPost), pc, 'other viewers see the same cards');
equal(await cards(normal, await post(normal, four)), [], '일반 gets no cards');
const offPost = await post(plus, 'https://og.example/off', { link_preview: false });
equal(await cards(plus, offPost), [], 'link_preview=0 gets no cards');
equal((await plus('posts/' + offPost)).data.post.link_preview, false, 'the detail carries the switch for the editor');
const before = await hits();
equal(await cards(plus, await post(plus, 'https://redir-ip.example/go')), [], 'a redirect to 127.0.0.1 (production rule) gives no card');
equal((await hits())['og.example/ip'] || 0, before['og.example/ip'] || 0, 'the redirect target on 127.0.0.1 is never fetched');
equal(await cards(plus, await post(plus, 'https://redir-local.example/go')), [], 'a redirect to a .local host gives no card');
equal((await cards(plus, await post(plus, 'https://redir-ok.example/go'))).map(c => [c.url, c.title]), [['https://redir-ok.example/go', '미리보기 /after-redirect']], 'a redirect to a valid host is followed (the card keeps the posted address)');
equal(await cards(plus, await post(plus, 'https://loop.example/0')), [], 'more than 3 hops give no card');
const big = await cards(plus, await post(plus, 'https://big.example/page'));
equal([big.length, big[0]?.title, big[0]?.description], [1, '큰 문서', ''], 'a 65KB head is parsed up to 64KB (the description after it is not read)');
equal(await cards(plus, await post(plus, 'https://png.example/file')), [], 'image/png content gives no card');
equal(await cards(plus, await post(plus, 'https://euc.example/doc')), [], 'a non-UTF-8 page gives no card');
equal(await cards(plus, await post(plus, 'https://notfound.example/x')), [], 'a 404 gives no card');
const other1 = await cards(plus, await post(plus, 'https://otherimg.example/x\nhttps://cdnimg.example/y'));
equal(other1.map(c => [c.title, c.image ?? null]), [['다른 이미지', null], ['카카오 이미지', 'https://k.kakaocdn.net/dn/abc.jpg']], 'an og:image on another host is dropped; *.kakaocdn.net is kept');
const ent = (await cards(plus, await post(plus, 'https://entity.example/x')))[0];
check(ent && ent.title.startsWith('A & B <좀비> \u{1F600} evil ') && [...ent.title].length === 100 && !/[‪-‮]/.test(ent.title), 'entities are decoded, bidi characters removed, the title clamped to 100');
equal((await cards(plus, await post(plus, 'https://title.example/x')))[0]?.title, '태그 제목 "따옴표"', '<title> is the fallback title');
const kakao = (await cards(plus, await post(plus, '오픈채팅 https://open.kakao.com/o/sAbc123 입니다')))[0];
equal([kakao.site, kakao.domain, kakao.image], ['카카오톡 오픈채팅', 'open.kakao.com', 'https://open.kakaocdn.net/dn/room.jpg'], 'open.kakao.com is labelled 카카오톡 오픈채팅 with its kakaocdn image');
const yt = (await cards(plus, await post(plus, 'https://youtu.be/dQw4w9WgXcQ')))[0];
equal([yt.site, yt.title, yt.description, yt.image], ['YouTube', '좀비고 래더 하이라이트', '좀비고 채널', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg'], 'YouTube uses oEmbed and the i.ytimg.com thumbnail');
const beforeNaver = await hits();
const naver = (await cards(plus, await post(plus, 'https://cafe.naver.com/zombiego/123 https://naver.me/abc')));
equal(naver.map(c => [c.site, c.title]), [['네이버 카페', '네이버 카페 글'], ['네이버 카페', '네이버 카페 글']], 'cafe.naver.com and naver.me get the fixed 네이버 카페 글 card');
equal(Object.keys(await hits()).length, Object.keys(beforeNaver).length, 'Naver cards make no fetch');
const own = (await cards(plus, await post(plus, `우리 글 ${base}/posts/${clean} 참고`)))[0];
equal([own?.site, own?.title, own?.description], ['좀비고 거래소', (await normal('posts/' + clean)).data.post.title, '판매 · 기타 · 1만원'], "the site's own post gets a card from the database");
// The cache: another post (another member) with an address fetched before makes no new fetch.
const cached = await hits();
equal((await cards(other, await post(other, 'https://og.example/1 다시'))).map(c => c.title), ['미리보기 /1'], 'a cached card is reused');
equal((await hits())['og.example/1'], cached['og.example/1'], 'the cached address is not fetched again');
check(sql("SELECT ok FROM link_cache WHERE url='https://png.example/file'")[0]?.ok === 0, 'a failed preview is cached as failed');

// ---- 4. Reads ----
const list = (await plus(`posts?author=${plus.user.id}&size=40`)).data.posts;
check(list.length > 5 && list.every(p => !('link_cards' in p) && !('link_preview' in p)), 'list rows carry no link_cards or link_preview key');
equal((await plus('posts/' + plusPost, 'PUT', sale('https://og.example/1 첫째\nhttps://og.example/3 셋째'))).status, 200, 'plus edits the post, removing /2');
equal((await cards(plus, plusPost)).map(c => c.url), ['https://og.example/1', 'https://og.example/3'], 'an edit removing a URL drops its card');
equal((await plus('posts/' + plusPost, 'PUT', sale('링크 없음'))).status, 200, 'plus edits the post to no links');
equal(await cards(plus, plusPost), [], 'with no links left, no cards');
const endPost = await post(ender, 'https://og.example/premium');
equal((await cards(ender, endPost)).length, 1, 'a 6-month 프리미엄 gets a card');
sql(`UPDATE user_grades SET expires_at=${Date.now() - 1000} WHERE user_id='${ender.user.id}'`);
equal(await cards(normal, endPost), [], 'an ended 6-month grade shows no cards');
// The switch turned off on an edit hides the cards; turned back on shows them again (cards stay stored).
const sw = await post(plus, 'https://og.example/switch');
equal((await plus('posts/' + sw, 'PUT', sale('https://og.example/switch', { link_preview: false }))).status, 200, 'plus turns the switch off');
equal(await cards(normal, sw), [], 'switch off: no cards');
equal((await plus('posts/' + sw, 'PUT', sale('https://og.example/switch'))).status, 200, 'an edit that leaves the switch out keeps it off');
equal((await plus('posts/' + sw)).data.post.link_preview, false, 'the switch stays off');

console.log(`verify-content: ${checks} checks passed`);
