import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// R3 step 5 review fixes, on the strict server with the read meter (READ_BUDGET=on, see
// scripts/test-local.mjs):
// 1. A post's side rows are one set-based statement per table: a 판매 계정 post with every season of three
//    tiers ('전체 선택', 70+ season tags), 시즌 비공개 on two tiers and 특징 태그 is written and edited within the
//    statement budget of a request (45, under the Free plan's 50 queries) and reads back whole.
// 2. GET /api/tags never offers a tag that only a hidden post carries.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const STATEMENTS = 45;
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

function wranglerSql(command) {
    return execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
        '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
}
const sql = command => { const out = wranglerSql(command); return JSON.parse(out.slice(out.indexOf('[')))[0].results; };

async function send(url, init) {
    try { return await fetch(url, init()); }
    catch (error) {
        if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
        return fetch(url, init());
    }
}
function client() {
    let cookie = '';
    return async (p, method = 'GET', data) => {
        const response = await send(base + '/api/' + p, () => ({
            method, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: data === undefined ? undefined : JSON.stringify(data),
        }));
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const raw = await response.text();
        let result;
        try { result = JSON.parse(raw); }
        catch { throw new Error(`${method} ${p}: expected JSON, received HTTP ${response.status}: ${raw.slice(0, 300)}`); }
        return { status: response.status, data: result, statements: Number(response.headers.get('x-d1-statements')), calls: Number(response.headers.get('x-d1-calls')) };
    };
}

sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%'");
const seller = client();
const reg = await seller('auth/register', 'POST', { username: `s5_${run}`, password, nickname: `오류수정${run}`.slice(0, 16) });
equal(reg.status, 200, 'a member signs up');
check(Number.isFinite(reg.statements) && reg.statements > 0, 'the server runs with the read meter (READ_BUDGET=on)');
const latest = (await seller('config')).data.latestSeason;

// ---- 1. 70+ season tags in one statement per table ----
const every = (tier, min) => Array.from({ length: latest - min + 1 }, (_, i) => ({ tier, season: min + i }));
const tags = [...every('bronze', 6), ...every('silver', 6), ...every('gold', 6)];
check(tags.length >= 70, `the post carries ${tags.length} season tags ('전체 선택' on 브론즈, 실버, 골드)`);
const sale = {
    kind: 'sell', category: 'account', title: `[QA] 래더 많은 계정 ${run}`, body: '자동 검증용 게시물입니다. 실제 거래가 아닙니다.',
    price: 300000, price_mode: 'fixed', accepts_offers: true, images: [], tags, ladderHidden: { master: 2, champion: 1 },
    details: { featureTags: JSON.stringify(['불새상류', `검증${run.slice(0, 4)}`]) },
};
const created = await seller('posts', 'POST', sale);
equal(created.status, 201, `the post is created (${created.data.error || ''})`);
check(created.statements <= STATEMENTS, `the create stays within ${STATEMENTS} statements (${created.statements})`);
const id = created.data.id;
const read = async () => (await seller('posts/' + id)).data.post;
const sortTags = list => [...list].sort((a, b) => a.tier.localeCompare(b.tier) || a.season - b.season);
let post = await read();
equal([sortTags(post.tags), post.ladder_hidden, JSON.parse(post.details.featureTags)], [sortTags(tags), { master: 2, champion: 1 }, ['불새상류', `검증${run.slice(0, 4)}`]],
    'every season tag, the 시즌 비공개 map and the 특징 태그 read back');
const more = [...tags, ...every('platinum', 6)];
const edited = await seller('posts/' + id, 'PUT', { ...sale, tags: more, ladderHidden: { master: 3 } });
equal(edited.status, 200, `the edit is saved (${edited.data.error || ''})`);
check(edited.statements <= STATEMENTS, `the edit with ${more.length} season tags stays within ${STATEMENTS} statements (${edited.statements})`);
post = await read();
equal([sortTags(post.tags), post.ladder_hidden], [sortTags(more), { master: 3 }], 'the edit replaces the tags and the 시즌 비공개 map');
const kept = await seller('posts/' + id, 'PUT', { ...sale, title: sale.title + ' 수정', tags: more, ladderHidden: undefined });
equal(kept.status, 200, 'an edit without ladderHidden is saved');
equal((await read()).ladder_hidden, { master: 3 }, 'an edit without ladderHidden keeps the stored map');

// ---- 2. A hidden post lends no tag to the board's tag filter ----
// The list is kept 10 minutes per isolate, so the check reads it once, after the manager hid the post.
const lone = `숨김${run.slice(0, 6)}`;
const hiddenPost = await seller('posts', 'POST', { ...sale, title: `[QA] 숨김 태그 ${run}`, price: 310000, tags: [], ladderHidden: {}, details: { featureTags: JSON.stringify([lone]) } });
equal(hiddenPost.status, 201, 'a post with a tag no other post has');
sql(`UPDATE posts SET hidden=1,hidden_reason='검증' WHERE id=${hiddenPost.data.id}`);
const t = await seller('tags');
equal(t.status, 200, 'GET tags answers');
check(![...t.data.pinned, ...t.data.popular].includes(lone), "a hidden post's tag is not offered");

// Clean up: the test posts leave the boards.
sql(`DELETE FROM posts WHERE id IN (${id},${hiddenPost.data.id})`);
console.log(`\n${checks} step 5 fix checks passed`);
