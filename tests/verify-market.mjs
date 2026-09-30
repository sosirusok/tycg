import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run against the compiled local Worker after applying local D1 migrations.
// TEST_BASE_URL defaults to http://127.0.0.1:8790. This suite never targets a live site.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790');
assert.ok(['http:', 'https:'].includes(endpoint.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    && !endpoint.username && !endpoint.password && endpoint.pathname === '/'
    && !endpoint.search && !endpoint.hash, 'Local Worker origin required.');
const base = endpoint.origin;
const cwd = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(5).toString('hex');
const password = randomBytes(24).toString('hex');
const fixturePosts = [];
const fixtureUsers = [];
let checks = 0;

function check(value, name) {
    assert.ok(value, name);
    checks++;
    console.log('PASS ' + name);
}

function equal(actual, expected, name) {
    assert.deepEqual(actual, expected, name);
    checks++;
    console.log('PASS ' + name);
}

function client() {
    let cookie = '';
    return async (path, method = 'GET', data) => {
        const response = await fetch(base + '/api/' + path, {
            method,
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
            headers: {
                ...(cookie ? { Cookie: cookie } : {}),
                ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: data === undefined ? undefined : JSON.stringify(data),
        });
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const raw = await response.text();
        let result;
        try { result = JSON.parse(raw); }
        catch { throw new Error(`${method} ${path}: expected JSON, received HTTP ${response.status}; content-type=${response.headers.get('content-type')}; body=${raw.slice(0, 500)}`); }
        return { status: response.status, data: result };
    };
}

const seller = client();
const categories = client();
const validator = client();
const guest = client();
const tag = { tier: 'master', season: 29 };
const common = {
    kind: 'sell', category: 'account', title: '[로컬 QA] v9 ' + run,
    body: '자동 검증용으로 생성한 게시물입니다. 실제 거래가 아닙니다.',
    price: 600000, price_mode: 'fixed', accepts_offers: true,
    status: 'open', tags: [tag], images: [], details: {},
};

async function create(owner, payload, label) {
    const response = await owner('posts', 'POST', payload);
    if (response.status === 201 && Number.isSafeInteger(response.data.id)) {
        fixturePosts.push({ owner, id: response.data.id });
    }
    equal(response.status, 201, label + ': create');
    check(Number.isSafeInteger(response.data.id), label + ': identifier');
    return response.data.id;
}

async function read(id) {
    const response = await guest('posts/' + id);
    equal(response.status, 200, 'public listing can be read');
    return response.data.post;
}

async function edit(owner, id, payload, label) {
    const response = await owner('posts/' + id, 'PUT', payload);
    equal(response.status, 200, label);
}

async function search(filters) {
    const response = await guest('posts?' + new URLSearchParams(filters));
    equal(response.status, 200, 'search request succeeds');
    return response.data.posts;
}

async function finds(id, filters) {
    return (await search(filters)).some(post => post.id === id);
}

function history(post) {
    check(Array.isArray(post.price_history), 'price history is a public array');
    return post.price_history.map(entry => entry.price);
}

let failed;
try {
    // Separate fixture accounts keep normal application rate limits in force.
    for (const [index, request] of [seller, categories, validator].entries()) {
        const username = `v9_${run}_${index}`;
        const response = await request('auth/register', 'POST', {
            username, password, nickname: '검증' + run + index,
        });
        if (response.status === 200 && response.data.user?.id) {
            fixtureUsers.push({ id: response.data.user.id, username });
        }
        equal(response.status, 200, 'fixture member ' + index + ' registered');
    }
    // 대리(진행) posts require 대리 인증; the manager grants it to the category fixture.
    const manager = client();
    equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: process.env.TEST_MANAGER_PASSWORD || 'local-manager-password' })).status, 200, 'manager signs in for badge setup');
    equal((await categories('posts', 'POST', { ...common, kind: 'proxy_offer', category: 'ladder', title: '[로컬 QA] 인증 전 ' + run })).status, 403, '대리(진행) is blocked before 대리 인증');
    equal((await manager('manage/users/' + fixtureUsers[1].id + '/badges', 'POST', { badge: 'proxy', active: true })).status, 200, 'manager grants 대리 인증 to the category fixture');

    const historyStarted = Date.now();
    const sale = {
        ...common, title: `[로컬 QA] ${run}-sale`,
        details: {
            ownerCount: '47', recordStatus: '무전적', currentOffer: '450000',
            nicknameChars: '2', nicknameRank: 'R', gas: '250', minerals: '80000',
            skinTags: JSON.stringify(['유루미']),
            maxOwners: '3', nicknameCharsMin: '4', nicknameRanks: JSON.stringify(['A']),
        },
        price_history: [{ price: 1, changed_at: 1 }],
    };
    const saleId = await create(seller, sale, 'sale with numeric ownership and current offer');
    const firstSale = await read(saleId);
    equal(firstSale.details.ownerCount, '47', '47 previous owners is preserved as a number string');
    equal(firstSale.details.currentOffer, '450000', 'current offer has its own field');
    for (const field of ['maxOwners', 'nicknameCharsMin', 'nicknameRanks']) {
        check(!Object.hasOwn(firstSale.details, field), 'sale discards purchase-only field: ' + field);
    }
    equal(history(firstSale), [], 'client cannot fabricate history on creation');

    await edit(seller, saleId, { ...sale, price: 500000 }, 'immediate price changes to 500000');
    await edit(seller, saleId, { ...sale, price: 400000 }, 'immediate price changes to 400000');
    const discounted = await read(saleId);
    equal(history(discounted), [600000, 500000], 'old prices retain chronological order');
    equal(discounted.price, 400000, 'current price is separate from previous prices');
    check(discounted.price_history.every(entry => Number.isSafeInteger(entry.changed_at)
        && entry.changed_at >= historyStarted && entry.changed_at <= Date.now()),
    'price history timestamps are assigned by the server');

    await edit(seller, saleId, { ...sale, price: 400000, body: sale.body + ' 설명 수정' },
        'description-only edit succeeds');
    equal(history(await read(saleId)), [600000, 500000], 'unchanged price does not add history');
    await edit(seller, saleId, {
        ...sale, price: 400000, details: { ...sale.details, ownerCount: '120', currentOffer: '390000' },
        price_history: [{ price: 999999999, changed_at: 1 }],
    }, 'ownership and current offer can change independently');
    const updatedSale = await read(saleId);
    equal(updatedSale.details.ownerCount, '120', '120 previous owners is accepted');
    equal(updatedSale.details.currentOffer, '390000', 'current offer update persists');
    equal(history(updatedSale), [600000, 500000], 'forged client history is ignored on edit');
    const listedSale = (await search({ kind: 'sell', category: 'account', q: run + '-sale' }))
        .find(post => post.id === saleId);
    check(Boolean(listedSale), 'public search includes the sale');
    equal(history(listedSale), [600000, 500000], 'list and detail expose the same price history');

    equal((await guest('posts/' + saleId, 'PUT', sale)).status, 401, 'anonymous edits are denied');
    equal((await validator('posts/' + saleId, 'PUT', { ...sale, price: 1 })).status, 403,
        'another member cannot change price history');
    equal((await validator('posts/' + saleId, 'DELETE')).status, 403,
        'another member cannot delete the listing');
    equal((await read(saleId)).price, 400000, 'unauthorized requests leave the current price unchanged');

    const concurrent = await Promise.all([300000, 200000].map(price =>
        seller('posts/' + saleId, 'PUT', { ...sale, price })));
    equal(concurrent.map(response => response.status), [200, 200], 'concurrent price edits both complete');
    const afterRace = await read(saleId);
    const oldPrices = history(afterRace);
    equal(oldPrices.slice(0, 3), [600000, 500000, 400000], 'concurrent edits preserve the existing chain');
    equal([...oldPrices, afterRace.price].sort((a, b) => a - b),
        [200000, 300000, 400000, 500000, 600000], 'concurrent edits lose neither changed price');
    check([200000, 300000].includes(afterRace.price), 'the final concurrent update is the current price');

    const buy = {
        ...common, kind: 'buy', title: `[로컬 QA] ${run}-buy`, price: 800000,
        details: {
            maxOwners: '50', recordPreference: '무전적', nicknameCharsMin: '2', nicknameCharsMax: '3',
            nicknameRanks: JSON.stringify(['R', 'S']), skinTags: JSON.stringify(['아람']),
            ownerCount: '99', gas: '999', minerals: '999', currentOffer: '700000',
            nicknameChars: '9', nicknameRank: '잡', recordStatus: '전적 있음',
        },
    };
    const buyId = await create(seller, buy, 'purchase requirements');
    const storedBuy = await read(buyId);
    equal(storedBuy.price, 800000, 'purchase stores the maximum budget');
    equal(storedBuy.details.maxOwners, '50', 'purchase stores allowed ownership count');
    equal(storedBuy.details.recordPreference, '무전적', 'purchase stores the record requirement');
    equal(JSON.parse(storedBuy.details.nicknameRanks), ['R', 'S'], 'purchase stores multiple acceptable nickname ranks');
    for (const field of ['ownerCount', 'gas', 'minerals', 'currentOffer', 'nicknameChars', 'nicknameRank', 'recordStatus']) {
        check(!Object.hasOwn(storedBuy.details, field), 'purchase discards sale-only field: ' + field);
    }
    await edit(seller, buyId, { ...buy, price: 700000 }, 'purchase maximum budget can be edited');
    equal(history(await read(buyId)), [], 'purchase budget edits never create immediate-price history');

    const saleFilter = { kind: 'sell', category: 'account', q: run + '-sale' };
    check(await finds(saleId, { ...saleFilter, maxOwners: '47' }), 'seller ownership limit includes its boundary');
    check(!await finds(saleId, { ...saleFilter, maxOwners: '46' }), 'seller ownership limit excludes excess owners');
    const buyFilter = { kind: 'buy', category: 'account', q: run + '-buy' };
    check(await finds(buyId, { ...buyFilter, ownerCountOfMine: '50' }), 'buyer accepts ownership at the requested limit');
    check(!await finds(buyId, { ...buyFilter, ownerCountOfMine: '51' }), 'buyer matching rejects too many owners');
    for (const count of ['2', '3']) {
        check(await finds(buyId, { ...buyFilter, nicknameChars: count }), 'buyer nickname length includes boundary ' + count);
    }
    check(!await finds(buyId, { ...buyFilter, nicknameChars: '4' }), 'buyer nickname matching uses the requested length range');
    check(await finds(buyId, { ...buyFilter, nicknameRank: 'S' }), 'buyer matches any selected nickname rank');
    check(!await finds(buyId, { ...buyFilter, nicknameRank: 'A' }), 'buyer excludes unselected nickname ranks');
    check(await finds(buyId, { ...buyFilter, recordPreference: '무전적' }), 'buyer record requirement can be searched');
    check(!await finds(buyId, { ...buyFilter, recordPreference: '전적 있어도 괜찮음' }),
        'buyer record search respects the selected requirement');

    check(await finds(saleId, { ...saleFilter, skinTags: JSON.stringify(['아람', '유루미']) }),
        'skin search uses any matching selected skin');
    check(!await finds(saleId, { ...saleFilter, skinTags: JSON.stringify(['아람']) }),
        'skin search excludes listings without any selected skin');
    const seasonChoices = JSON.stringify([tag, { tier: 'champion', season: 8 }]);
    check(await finds(saleId, { ...saleFilter, tags: seasonChoices }), 'season search defaults to any exact tier-season pair');
    check(!await finds(saleId, { ...saleFilter, match: 'all', tags: seasonChoices }),
        'optional all-seasons filter still requires every selected pair');
    check(await finds(saleId, {
        ...saleFilter, tags: seasonChoices, skinTags: JSON.stringify(['아람', '유루미']), maxOwners: '47',
    }), 'skin and season groups combine with ownership conditions');

    for (const kind of ['buy', 'sell']) {
        for (const category of ['account', 'clan', 'goods_coupon', 'other']) {
            const id = await create(categories, {
                ...common, kind, category, title: `[로컬 QA] ${run} ${kind} ${category}`,
                details: category === 'account' ? {} : { gas: '200', ownerCount: '47' },
            }, kind + '/' + category);
            const stored = await read(id);
            equal([stored.kind, stored.category], [kind, category], 'trade kind and subcategory stay distinct');
            if (category !== 'account') {
                equal(stored.tags, [], 'non-account item does not retain account seasons');
                check(!Object.hasOwn(stored.details, 'gas') && !Object.hasOwn(stored.details, 'ownerCount'),
                    'non-account item does not retain account-only details');
            }
        }
    }
    for (const kind of ['proxy_request', 'proxy_offer']) {
        for (const category of ['ladder', 'story', 'event']) {
            const id = await create(categories, {
                ...common, kind, category, title: `[로컬 QA] ${run} ${kind} ${category}`,
            }, kind + '/' + category);
            const stored = await read(id);
            equal([stored.kind, stored.category], [kind, category], 'proxy direction and service category persist');
            equal(stored.tags, category === 'ladder' ? [tag] : [], 'only ladder service retains ladder seasons');
            const result = await search({ kind, category, q: run });
            check(result.some(post => post.id === id) && result.every(post => post.kind === kind && post.category === category),
                'proxy search respects both direction and category');
        }
    }
    for (const offered of ['account', 'clan']) {
        for (const wanted of ['account', 'clan']) {
            const id = await create(categories, {
                ...common, kind: 'exchange', category: offered, price: null, price_mode: 'negotiate',
                title: `[로컬 QA] ${run} ${offered}에서 ${wanted} 구함`,
                details: {
                    wantedCategory: wanted,
                    ...(offered === 'account' ? { ownerCount: '120', nicknameChars: '2', nicknameRank: 'R' } : {}),
                    ...(wanted === 'account' ? {
                        wantedMaxOwners: '47', wantedRecordPreference: '무전적',
                        wantedNicknameCharsMin: '3', wantedNicknameCharsMax: '4',
                        wantedNicknameRanks: JSON.stringify(['S']), wantedSkinTags: JSON.stringify(['아람']),
                    } : {}),
                },
            }, 'exchange ' + offered + ' to ' + wanted);
            const stored = await read(id);
            equal([stored.category, stored.details.wantedCategory], [offered, wanted],
                'exchange independently stores offered and wanted types');
            if (wanted === 'account') {
                equal(stored.details.wantedMaxOwners, '47', 'exchange stores desired-account ownership separately');
                equal([stored.details.wantedNicknameCharsMin, stored.details.wantedNicknameCharsMax], ['3', '4'],
                    'exchange stores desired nickname range');
                equal(JSON.parse(stored.details.wantedNicknameRanks), ['S'], 'exchange stores desired nickname ranks');
                if (offered === 'account') {
                    equal([stored.details.ownerCount, stored.details.nicknameChars, stored.details.nicknameRank], ['120', '2', 'R'],
                        'offered account facts are independent from wanted account requirements');
                }
            }
            check(await finds(id, { kind: 'exchange', category: offered, wantedCategory: wanted, q: run }),
                'exchange matching finds its offered and wanted combination');
            check(!await finds(id, { kind: 'exchange', category: offered, wantedCategory: wanted === 'account' ? 'clan' : 'account', q: run }),
                'exchange matching does not swap or ignore the wanted type');
        }
    }

    const invalid = [
        ['sale cannot select a proxy category', { kind: 'sell', category: 'ladder' }],
        ['purchase cannot select a proxy category', { kind: 'buy', category: 'event' }],
        ['proxy request cannot select an account', { kind: 'proxy_request', category: 'account' }],
        ['proxy offer cannot select goods', { kind: 'proxy_offer', category: 'goods_coupon' }],
        ['exchange cannot offer goods', { kind: 'exchange', category: 'goods_coupon', details: { wantedCategory: 'account' } }],
        ['exchange cannot request other items', { kind: 'exchange', details: { wantedCategory: 'other' } }],
        ['exchange requires the wanted type', { kind: 'exchange', details: {} }],
        ['unknown trade kind rejected', { kind: 'service' }],
        ['unknown subcategory rejected', { category: 'missing' }],
        ['fractional owner count rejected', { details: { ownerCount: '2.5' } }],
        ['zero owner count rejected', { details: { ownerCount: '0' } }],
        ['negative owner count rejected', { details: { ownerCount: '-1' } }],
        ['owner count beyond supported limit rejected', { details: { ownerCount: '10000' } }],
        ['sale record choice validated', { details: { recordStatus: '확인완료' } }],
        ['negative current offer rejected', { details: { currentOffer: '-1000' } }],
        ['fractional current offer rejected', { details: { currentOffer: '1.5' } }],
        ['buyer ownership limit validated', { kind: 'buy', details: { maxOwners: '0' } }],
        ['buyer record choice validated', { kind: 'buy', details: { recordPreference: '알아서' } }],
        ['reversed buyer nickname range rejected', { kind: 'buy', details: { nicknameCharsMin: '4', nicknameCharsMax: '2' } }],
        ['buyer nickname rank JSON validated', { kind: 'buy', details: { nicknameRanks: 'invalid' } }],
        ['buyer nickname rank values validated', { kind: 'buy', details: { nicknameRanks: JSON.stringify(['SSS']) } }],
    ];
    for (const [label, overrides] of invalid) {
        const response = await validator('posts', 'POST', { ...common, ...overrides });
        if (response.status === 201) fixturePosts.push({ owner: validator, id: response.data.id });
        equal(response.status, 400, label);
    }
    for (const query of [
        { skinTags: 'not-json' }, { skinTags: JSON.stringify(['없는 스킨']) },
        { maxOwners: '-1' }, { ownerCountOfMine: '1.5' },
        { nicknameChars: '0' }, { nicknameRank: 'SSS' },
        { tags: JSON.stringify([{ tier: 'iron', season: 24 }]) },
    ]) {
        equal((await guest('posts?' + new URLSearchParams(query))).status, 400,
            'invalid search condition rejected: ' + Object.keys(query)[0]);
    }
} catch (error) {
    failed = error;
} finally {
    const cleanupErrors = [];
    for (const { owner, id } of fixturePosts) {
        try {
            const response = await owner('posts/' + id, 'DELETE');
            if (response.status !== 200 && response.status !== 404) {
                cleanupErrors.push('post ' + id + ': HTTP ' + response.status);
            }
        } catch (error) { cleanupErrors.push('post ' + id + ': ' + error.message); }
    }
    if (fixtureUsers.length) {
        // No production/remote option is accepted. Only this run's exact fixture IDs are removed.
        // Test members have no chat, report, upload, or offer records.
        try {
            assert.ok(fixtureUsers.every(user => /^[a-f0-9-]{36}$/.test(user.id)
                && new RegExp(`^v9_${run}_[0-2]$`).test(user.username)), 'Unexpected fixture identity');
            const ids = fixtureUsers.map(user => `'${user.id}'`).join(',');
            const rateKeys = fixtureUsers.flatMap(user => [`'post:${user.id}'`, `'auth-user:${user.username}'`]).join(',');
            execFileSync(process.execPath, [
                './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local',
                '--config', 'wrangler.jsonc', '--persist-to', '.wrangler/state',
                '--command', `DELETE FROM posts WHERE author_id IN (${ids}); DELETE FROM users WHERE id IN (${ids}); DELETE FROM rate_limits WHERE key IN (${rateKeys});`,
            ], { cwd, stdio: 'pipe', timeout: 30000 });
        } catch (error) { cleanupErrors.push('local fixture account cleanup: ' + error.message); }
    }
    if (cleanupErrors.length) {
        console.error('Fixture cleanup issue: ' + cleanupErrors.join('; '));
        failed ||= new Error('Local fixture cleanup failed.');
    }
}
if (failed) throw failed;
console.log(JSON.stringify({ passed: checks, suite: 'trade-v9', fixturePostsRemoved: fixturePosts.length, fixtureUsersRemoved: fixtureUsers.length }));
