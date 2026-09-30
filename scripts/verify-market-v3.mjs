import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8790';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Local runtime only.');
const run = randomBytes(4).toString('hex'); let cookie = '', checks = 0;
async function request(path, method = 'GET', data) {
    const r = await fetch(base + '/api/' + path, { method, headers: { Cookie: cookie, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
    return { status: r.status, data: await r.json() };
}
function ok(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
ok((await request('auth/register', 'POST', { username: 'v3_' + run, password: randomBytes(18).toString('hex'), nickname: '검증' + run })).status === 200, 'test member registered');
const fullSet = '해골 기사단장 남동진 풀세트', skeleton = '해골 기사단장 남동진';
const payload = { title: '로컬 조건 검증 ' + run, body: '실제 판매 글이 아닙니다.', kind: 'sell', category: 'account', price: 10000, price_mode: 'fixed', tags: [{ tier: 'master', season: 29 }], images: [], details: { nicknameChars: '2', nicknameRank: 'R', gas: '250', minerals: '80000', firstOwner: '1대 주인', integrated: '통합', passwordChange: '가능', phoneChange: '불가', skinTags: JSON.stringify([fullSet]), rareSkins: '기존 자유입력 스킨', ownership: '기존 소유 이력', accountType: '기존 범위', emblems: '팬텀', level: '99' } };
const made = await request('posts', 'POST', payload); ok(made.status === 201, 'new account conditions saved'); const id = made.data.id;
try {
    const stored = (await request('posts/' + id)).data.post;
    ok(stored.details.nicknameRank === 'R' && stored.details.minerals === '80000', 'nickname and currency persist');
    ok(JSON.parse(stored.details.skinTags).includes(skeleton), 'full set includes skin possession');
    async function found(filters) { const r = await request('posts?' + new URLSearchParams({ q: run, ...filters })); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.posts.some(p => p.id === id); }
    ok(await found({ nicknameChars: '2', nicknameRank: 'R', gas: '250', minerals: '80000' }), 'combined exact and numeric boundaries match');
    ok(!await found({ nicknameChars: '3' }), 'nickname length exact, not minimum');
    ok(!await found({ nicknameRank: 'S' }), 'nickname rank exact, no invented ordering');
    ok(!await found({ gas: '251' }), 'gas lower bound excludes smaller amount');
    ok(!await found({ minerals: '80001' }), 'mineral lower bound excludes smaller amount');
    ok(await found({ phoneChange: '불가', passwordChange: '가능', firstOwner: '1대 주인', integrated: '통합' }), 'account state conditions match independently');
    ok(!await found({ phoneChange: '가능' }), 'phone change not conflated with password change');
    ok(await found({ skinTags: JSON.stringify([skeleton]) }), 'skin checkbox finds full set');
    ok(await found({ skinTags: JSON.stringify(['파자마 고나래', fullSet]) }), 'skin choices use any-match');
    ok(!await found({ skinTags: JSON.stringify(['파자마 고나래']) }), 'unowned skin excluded');
    ok(await found({ skinTags: JSON.stringify([fullSet]), tags: JSON.stringify([{ tier: 'master', season: 29 }, { tier: 'champion', season: 8 }]) }), 'ladder any-match combines with skin group');
    ok(!await found({ skinTags: JSON.stringify([fullSet]), match: 'all', tags: JSON.stringify([{ tier: 'master', season: 29 }, { tier: 'champion', season: 8 }]) }), 'ladder all-match still requires all pairs');
    for (const details of [{ nicknameRank: 'SSS' }, { nicknameChars: '0' }, { nicknameChars: '2.5' }, { gas: '-1' }, { phoneChange: 'verified' }, { skinTags: 'invalid' }, { skinTags: JSON.stringify(['unknown']) }]) {
        ok((await request('posts', 'POST', { ...payload, details })).status === 400, 'invalid condition rejected: ' + Object.keys(details)[0]);
    }
    ok((await request('posts?skinTags=invalid')).status === 400, 'invalid skin search rejected');
    ok((await request('posts?nicknameRank=SSS')).status === 400, 'invalid nickname search rejected');
    ok((await request('posts/' + id, 'PUT', { ...stored, details: { ...stored.details, gas: '0', skinTags: JSON.stringify([skeleton]) } })).status === 200, 'edit account conditions');
    const edited = (await request('posts/' + id)).data.post;
    ok(edited.details.rareSkins === payload.details.rareSkins && edited.details.ownership === payload.details.ownership && edited.details.accountType === payload.details.accountType && edited.details.emblems === '팬텀', 'legacy free text survives edit');
    ok(!await found({ skinTags: JSON.stringify([fullSet]) }), 'skin alone does not imply full set');
    ok(await found({ gas: '0' }), 'explicit zero currency searchable');
    const { gas, ...withoutGas } = edited.details;
    await request('posts/' + id, 'PUT', { ...edited, details: withoutGas });
    ok(!await found({ gas: '0' }), 'omitted currency is not treated as zero');
    ok((await request('drafts/new', 'PUT', payload)).status === 200 && (await request('drafts/new')).data.draft.details.nicknameRank === 'R', 'new fields persist in drafts');
} finally { await request('drafts/new', 'DELETE'); await request('posts/' + id, 'DELETE'); }
console.log(JSON.stringify({ passed: checks, suite: 'account-v3' }));
