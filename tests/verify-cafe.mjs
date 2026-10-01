import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Cafe trade fields (WP19): 닉 종류 on accounts (stored, validated and filtered) and ladder
// shorthand in search ('28챌', '30ㄷㅇ', '현플', '다야'). Runs only against a local Worker
// (see scripts/test-local.mjs).
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

function client() {
    let cookie = '';
    return async (path, method = 'GET', data) => {
        const response = await fetch(base + '/api/' + path, {
            method, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: data === undefined ? undefined : JSON.stringify(data),
        });
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const raw = await response.text();
        let result;
        try { result = JSON.parse(raw); }
        catch { throw new Error(`${method} ${path}: expected JSON, received HTTP ${response.status}: ${raw.slice(0, 300)}`); }
        return { status: response.status, data: result };
    };
}

// Nicknames and titles carry no Hangul, so a text search for '마' or '챌' never matches them by text.
async function register(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `cf_${run}_${name}`.slice(0, 24), password, nickname: `${name}${run}` });
    assert.equal(r.status, 200, `${name} registers`);
    c.user = r.data.user;
    return c;
}

const guest = client();
const seller = await register('seller'), buyer = await register('buyer'), trader = await register('trader');
const latest = (await guest('config')).data.latestSeason;
check(Number.isInteger(latest) && latest >= 32, 'config has the latest ladder season');

let n = 0;
const sale = extra => ({ kind: 'sell', category: 'account', title: `[QA] cafe ${run} ${++n}`, body: 'QA', price: 300000, accepts_offers: true, status: 'open', tags: [], images: [], details: {}, ...extra });
const wish = extra => ({ kind: 'buy', category: 'account', title: `[QA] cafe ${run} ${++n}`, body: 'QA', price: 300000, status: 'open', tags: [], images: [], details: {}, ...extra });
async function post(owner, payload, label) {
    const r = await owner('posts', 'POST', payload);
    equal(r.status, 201, label);
    return r.data.id;
}
// Lists only one author's posts, so posts left by earlier runs never push these off the page.
async function ids(owner, query) {
    const r = await guest(`posts?author=${owner.user.id}&size=40&${query}`);
    equal(r.status, 200, `GET posts ${decodeURIComponent(query)} answers 200`);
    return r.data.posts.map(p => p.id);
}
const types = list => JSON.stringify(list);

// 닉 종류 on a sale: stored as a JSON list and found by the nicknameTypes filter (any match).
{
    const yeosa = await post(seller, sale({ details: { nicknameChars: '2', nicknameTypes: types(['여사']), nicknameRank: 'S', ownerCount: '2' } }), 'sell post with 닉 종류 여사');
    const both = await post(seller, sale({ details: { nicknameTypes: types(['귀욤', '영어']) } }), 'sell post with 닉 종류 귀욤, 영어');
    const none = await post(seller, sale({ details: { nicknameChars: '3' } }), 'sell post without 닉 종류');
    equal((await guest('posts/' + yeosa)).data.post.details.nicknameTypes, types(['여사']), '닉 종류 is stored as a JSON list');

    const found = await ids(seller, 'kind=sell&category=account&nicknameTypes=' + encodeURIComponent('여사'));
    check(found.includes(yeosa), 'nicknameTypes=여사 includes the 여사 sale');
    check(!found.includes(both) && !found.includes(none), 'nicknameTypes=여사 leaves out other types and posts without 닉 종류');
    const any = await ids(seller, 'kind=sell&category=account&nicknameTypes=' + encodeURIComponent(types(['여사', '영어'])));
    check(any.includes(yeosa) && any.includes(both) && !any.includes(none), 'a JSON list of types matches any of them');
    const comma = await ids(seller, 'kind=sell&category=account&nicknameTypes=' + encodeURIComponent('남사,귀욤'));
    equal(comma, [both], 'comma-separated types match any of them');

    equal((await guest('posts?kind=sell&nicknameTypes=' + encodeURIComponent('외계'))).status, 400, 'an unknown type in the filter is 400');
    equal((await guest('posts?kind=sell&nicknameTypes=' + encodeURIComponent(types(['외계'])))).status, 400, 'an unknown type in a JSON filter is 400');
    const bad = await seller('posts', 'POST', sale({ details: { nicknameTypes: types(['외계']) } }));
    equal([bad.status, bad.data.error], [400, '닉 종류: 확인해 주세요.'], "a sale with 닉 종류 ['외계'] is 400 '닉 종류: 확인해 주세요.'");
    equal((await seller('posts', 'POST', sale({ details: { nicknameTypes: '여사' } }))).status, 400, '닉 종류 that is not a JSON list is 400');

    // Buyers' key is not part of a sale: it is dropped, so a sale never shows a wish.
    const stray = await post(seller, sale({ details: { wantedNicknameTypes: types(['남사']) } }), 'sell post sending wantedNicknameTypes');
    equal((await guest('posts/' + stray)).data.post.details.wantedNicknameTypes, undefined, 'a sale drops wantedNicknameTypes');
}

// 구매: wantedNicknameTypes, and '내 계정으로 찾기' with myNicknameType (no type chosen fits every account).
{
    const wantsYeosa = await post(buyer, wish({ details: { wantedNicknameTypes: types(['여사', '중성']) } }), 'buy post wanting 여사 or 중성');
    const wantsAny = await post(buyer, wish({ details: { maxOwners: '3' } }), 'buy post without 닉 종류');
    const wantsNamsa = await post(buyer, wish({ details: { wantedNicknameTypes: types(['남사']) } }), 'buy post wanting 남사');
    equal((await guest('posts/' + wantsYeosa)).data.post.details.wantedNicknameTypes, types(['여사', '중성']), 'buy post stores wantedNicknameTypes');
    const mine = await ids(buyer, 'kind=buy&category=account&myNicknameType=' + encodeURIComponent('여사'));
    check(mine.includes(wantsYeosa) && mine.includes(wantsAny), 'myNicknameType=여사 includes buyers wanting 여사 and buyers with no type');
    check(!mine.includes(wantsNamsa), 'myNicknameType=여사 leaves out a buyer wanting only 남사');
    equal((await guest('posts?kind=buy&myNicknameType=' + encodeURIComponent('외계'))).status, 400, 'an unknown myNicknameType is 400');
    const bad = await buyer('posts', 'POST', wish({ details: { wantedNicknameTypes: types(['외계']) } }));
    equal([bad.status, bad.data.error], [400, '닉 종류: 확인해 주세요.'], 'a buy post with an unknown 닉 종류 is 400');
}

// 교환: the offered account has nicknameTypes, the wanted account wantedNicknameTypes.
{
    const swap = await post(trader, { kind: 'exchange', category: 'account', title: `[QA] cafe ${run} swap`, body: 'QA', price: null, status: 'open', tags: [], wantedTags: [], images: [],
        details: { wantedCategory: 'account', nicknameTypes: types(['중성']), wantedNicknameTypes: types(['귀욤']) } }, 'exchange post offering 중성 and wanting 귀욤');
    const p = (await guest('posts/' + swap)).data.post;
    equal([p.details.nicknameTypes, p.details.wantedNicknameTypes], [types(['중성']), types(['귀욤'])], 'exchange post stores both sides');
    check((await ids(trader, 'kind=exchange&nicknameTypes=' + encodeURIComponent('중성'))).includes(swap), 'nicknameTypes finds the offered side of 교환');
    check(!(await ids(trader, 'kind=exchange&nicknameTypes=' + encodeURIComponent('귀욤'))).includes(swap), 'nicknameTypes never matches the wanted side');
    check((await ids(trader, 'kind=exchange&wantedMyNicknameType=' + encodeURIComponent('귀욤'))).includes(swap), 'wantedMyNicknameType=귀욤 finds the exchange wanting 귀욤');
    check(!(await ids(trader, 'kind=exchange&wantedMyNicknameType=' + encodeURIComponent('여사'))).includes(swap), 'wantedMyNicknameType=여사 leaves it out');
    const bad = await trader('posts', 'POST', { kind: 'exchange', category: 'account', title: `[QA] cafe ${run} bad swap`, body: 'QA', price: null, status: 'open', tags: [], wantedTags: [], images: [],
        details: { wantedCategory: 'account', wantedNicknameTypes: types(['외계']) } });
    equal([bad.status, bad.data.error], [400, '닉 종류: 확인해 주세요.'], 'an exchange wanting an unknown 닉 종류 is 400');
}

// Ladder shorthand: a whole search naming a ladder also finds posts with that ladder record.
{
    const q = async (owner, word) => ids(owner, 'q=' + encodeURIComponent(word));
    const challenger = await post(seller, sale({ tags: [{ tier: 'challenger', season: 28 }] }), 'sell post tagged 28 challenger');
    const platinum = await post(seller, sale({ tags: [{ tier: 'platinum', season: latest }] }), `sell post tagged ${latest} platinum`);
    const diamond = await post(seller, sale({ tags: [{ tier: 'diamond', season: 30 }] }), 'sell post tagged 30 diamond');
    const master = await post(seller, sale({ tags: [{ tier: 'master', season: 29 }] }), 'sell post tagged 29 master');
    const titled = await post(seller, sale({ title: `[QA] 28챌 유루미 ${run}` }), "sell post titled '28챌 유루미'");

    for (const word of ['28챌', '28챌린저', '28 챌', '28시즌 챌린저']) check((await q(seller, word)).includes(challenger), `q=${word} includes the 28 challenger post`);
    for (const word of ['현플', '현플래', `${latest}플`]) check((await q(seller, word)).includes(platinum), `q=${word} includes the ${latest} platinum post`);
    for (const word of ['30ㄷㅇ', '30다야', '30 다이아']) check((await q(seller, word)).includes(diamond), `q=${word} includes the 30 diamond post`);
    check(!(await q(seller, '29ㄷㅇ')).includes(diamond), 'q=29ㄷㅇ leaves out the 30 diamond post');
    check(!(await q(seller, '28챌')).includes(platinum), 'q=28챌 leaves out posts of other ladders');

    // A bare tier word of two or more syllables finds every season of that tier.
    for (const [word, id] of [['다야', diamond], ['다이아', diamond], ['챌린저', challenger], ['마스터', master], ['플래', platinum]]) check((await q(seller, word)).includes(id), `q=${word} includes the ${word} post of any season`);
    // One syllable alone stays plain text.
    check(!(await q(seller, '마')).includes(master), "q=마 alone does not return a master post whose text lacks '마'");
    check(!(await q(seller, '챌')).includes(challenger), "q=챌 alone does not return a challenger post whose text lacks '챌'");
    check((await q(seller, '29마')).includes(master), 'q=29마 includes the 29 master post');
    // Seasons outside the tier's range name no ladder.
    equal(await q(seller, '10마'), [], 'q=10마 (master starts at 17) finds nothing');
    equal(await q(seller, `${latest + 1}챌`), [], 'a season after the latest finds nothing');

    // More than the shorthand keeps the plain text search: the titled post only.
    equal(await q(seller, '28챌 유루미'), [titled], "q='28챌 유루미' is a plain text search");
    check((await q(seller, '28챌')).includes(titled), 'q=28챌 still finds the text match too');

    // The all-tab search counts the ladder matches per tab.
    const all = await guest(`posts?author=${seller.user.id}&q=${encodeURIComponent('30ㄷㅇ')}`);
    equal([all.status, all.data.counts?.sell], [200, 1], 'the all-tab search counts the 30 diamond post under 판매');
}

console.log(`verify-cafe: ${checks} checks passed`);
