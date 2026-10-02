import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

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
    return async (path, method = 'GET', data, upload) => {
        const response = await fetch(base + '/api/' + path, {
            method,
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
            headers: {
                ...(cookie ? { Cookie: cookie } : {}),
                ...(upload ? { 'Content-Type': upload.type } : data === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: upload ? upload.bytes : data === undefined ? undefined : JSON.stringify(data),
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
    // /api/health (deploy.yml checks it on both addresses, WP67): ok and whether the visitor's address
    // reached the Worker, as a boolean only; the address itself is never sent back.
    const health = await guest('health');
    equal(health.status, 200, 'health answers 200');
    equal(Object.keys(health.data).sort(), ['ip', 'ok'], 'health has only ok and ip');
    check(health.data.ok === true && typeof health.data.ip === 'boolean', 'health ok is true and ip is a boolean');
    check(!/\d+\.\d+\.\d+\.\d+|::/.test(JSON.stringify(health.data)), 'health never shows an address');

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
            ownerCount: '47', recordStatus: '무전적', currentOffer: '150000',
            nicknameChars: '2', nicknameRank: 'R', gas: '250', minerals: '80000',
            skinTags: JSON.stringify(['유루미']),
            maxOwners: '3', nicknameCharsMin: '4', nicknameRanks: JSON.stringify(['A']),
        },
        price_history: [{ price: 1, changed_at: 1 }],
    };
    const saleId = await create(seller, sale, 'sale with numeric ownership and current offer');
    const firstSale = await read(saleId);
    equal(firstSale.details.ownerCount, '47', '47 previous owners is preserved as a number string');
    equal(firstSale.details.currentOffer, '150000', 'current offer has its own field');
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
    equal([listedSale.images, listedSale.photo_count], [[], 0], 'a list row without photos has no 대표 and photo_count 0');

    // 대표 이미지 (WP46): list rows carry only images[0] and photo_count; the post itself carries every photo.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const shots = [];
    for (let i = 0; i < 3; i++) {
        const up = await seller('uploads', 'POST', undefined, { type: 'image/png', bytes: Uint8Array.from(Buffer.concat([png, Buffer.from(run + i)])) });
        equal(up.status, 201, `photo ${i + 1} uploads`);
        shots.push(up.data.id);
    }
    equal(new Set(shots).size, 3, 'three distinct photos');
    const photosId = await create(seller, { ...common, category: 'other', tags: [], title: `[로컬 QA] ${run}-photos`, images: shots }, 'post with 3 photos');
    const photoRow = (await search({ q: run + '-photos' })).find(post => post.id === photosId);
    check(Boolean(photoRow), 'the photo post is in the list');
    equal(photoRow.images.length, 1, 'a list row has images.length 1');
    equal(photoRow.images[0], shots[0], 'the list row carries the 대표 (images[0])');
    equal(photoRow.photo_count, 3, 'a list row has photo_count 3');
    const photoDetail = await read(photosId);
    equal(photoDetail.images, shots, 'the detail has all 3 photos in order');
    equal(photoDetail.photo_count, 3, 'the detail has photo_count 3');
    await edit(seller, photosId, { ...common, category: 'other', tags: [], title: `[로컬 QA] ${run}-photos`, images: [shots[2], shots[0], shots[1]] }, '대표로 moves the 3rd photo to the front');
    const recovered = (await search({ q: run + '-photos' })).find(post => post.id === photosId);
    equal([recovered.images, recovered.photo_count], [[shots[2]], 3], 'the list follows the new 대표');
    equal((await read(photosId)).images, [shots[2], shots[0], shots[1]], 'the others keep their order');

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
    check([200000, 300000].includes(afterRace.price), 'the final concurrent update is the current price');
    equal(oldPrices.slice(0, 3), [600000, 500000, 400000], 'concurrent edits preserve the existing chain');
    // A rise records no history, so when 300000 lands second, 200000 is legitimately absent.
    check(oldPrices.every((price, i) => i === 0 || price < oldPrices[i - 1]), 'history after concurrent edits falls strictly');
    check(oldPrices.every(price => price > afterRace.price), 'every history entry is above the final price');

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

    // 스킨 수 (팬텀 %), WP47: a buyer's least 팬텀 % (phantomMin), shown on cards as '팬텀 300% 이상',
    // and '내 계정 팬텀 %' (myPhantom) finding buyers whose minimum my account reaches or who set none.
    const phantomBuy = {
        ...common, kind: 'buy', title: `[로컬 QA] ${run}-buy 팬텀 300`, price: 500000,
        details: { maxOwners: '3', phantomMin: '300' },
    };
    const phantom300 = await create(seller, phantomBuy, 'purchase with a 스킨 수 minimum');
    const phantom200 = await create(seller, { ...phantomBuy, title: `[로컬 QA] ${run}-buy 팬텀 200`, details: { maxOwners: '4', phantomMin: '0200' } }, 'purchase with a lower 스킨 수 minimum');
    const stored300 = await read(phantom300);
    equal(stored300.details.phantomMin, '300', 'purchase stores the 스킨 수 minimum');
    equal((await read(phantom200)).details.phantomMin, '200', 'the 스킨 수 minimum is stored as a plain number');
    const market = await build({ configFile: false, logLevel: 'silent', root: cwd, build: { lib: { entry: 'shared/market.ts', formats: ['es'], fileName: 'market' }, write: false, minify: false } });
    const M = await import('data:text/javascript;base64,' + Buffer.from((Array.isArray(market) ? market[0] : market).output[0].code).toString('base64'));
    // Cards show the first 4 items (CARD_ITEMS in src/components/PostCard.tsx).
    const card = M.accountSummary(stored300.details);
    check(card.slice(0, 4).includes('팬텀 300% 이상'), 'the buy card summary shows 팬텀 300% 이상: ' + card.join(', '));
    check(M.accountSummary(storedBuy.details).slice(0, 4).every(item => !item.startsWith('팬텀')), 'a buy card without a minimum shows no 팬텀 item');
    check(M.accountSummary({ phantom: '214' }).includes('팬텀 214%'), 'the sale card summary stays 팬텀 214%');
    equal(M.BUYER_DETAIL_FIELDS.find(f => f.id === 'phantomMin')?.label, '스킨 수 (팬텀 %)', 'the buyer field is labelled 스킨 수 (팬텀 %)');
    equal(M.DETAIL_FIELDS.account.find(f => f.id === 'phantom')?.label, '스킨 수 (팬텀 %)', 'the sale field is labelled 스킨 수 (팬텀 %)');
    const phantomFilter = { kind: 'buy', category: 'account', q: run + '-buy' };
    const mine250 = (await search({ ...phantomFilter, myPhantom: '250' })).map(post => post.id);
    check(mine250.includes(phantom200), 'myPhantom=250 lists a buyer wanting 200% or more');
    check(mine250.includes(buyId), 'myPhantom=250 lists a buyer with no 스킨 수 minimum');
    check(!mine250.includes(phantom300), 'myPhantom=250 leaves out a buyer wanting 300% or more');
    check(await finds(phantom300, { ...phantomFilter, myPhantom: '300' }), 'myPhantom includes its boundary');
    for (const bad of ['-1', '1.5', 'abc', '5001']) {
        equal((await guest('posts?' + new URLSearchParams({ kind: 'buy', myPhantom: bad }))).status, 400, 'invalid myPhantom rejected: ' + bad);
    }

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
                        wantedNicknameRanks: JSON.stringify(['S']), wantedSkinTags: JSON.stringify(['아람']), wantedPhantomMin: '300',
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
                equal(stored.details.wantedPhantomMin, '300', 'exchange stores the wanted 스킨 수 minimum');
                const filter = { kind: 'exchange', category: offered, wantedCategory: wanted, q: run };
                check(await finds(id, { ...filter, wantedMyPhantom: '300' }), 'wantedMyPhantom=300 finds an exchange wanting 300% or more');
                check(!await finds(id, { ...filter, wantedMyPhantom: '250' }), 'wantedMyPhantom=250 leaves out an exchange wanting 300% or more');
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
        ['negative buyer 스킨 수 rejected', { kind: 'buy', details: { phantomMin: '-1' } }],
        ['buyer 스킨 수 beyond the limit rejected', { kind: 'buy', details: { phantomMin: '5001' } }],
        ['wanted 스킨 수 validated', { kind: 'exchange', details: { wantedCategory: 'account', wantedPhantomMin: '-1' } }],
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

    // ---- 시즌 비공개 (WP68): hidden emblems of a known tier, seller side only ----
    const hiddenSale = { ...common, title: `[로컬 QA] ${run}-hidden 18마스터`, tags: [{ tier: 'master', season: 18 }], ladderHidden: { master: 2 }, details: {} };
    const hiddenId = await create(seller, hiddenSale, 'sale with 18시즌 마스터 and 2 hidden 마스터 emblems');
    const storedHidden = await read(hiddenId);
    equal([storedHidden.tags, storedHidden.ladder_hidden], [[{ tier: 'master', season: 18 }], { master: 2 }], 'GET returns the ladder and 시즌 비공개');
    const hiddenOnlyId = await create(seller, { ...hiddenSale, title: `[로컬 QA] ${run}-hidden only`, tags: [] }, 'sale with only hidden 마스터 emblems');
    const listed = await search({ kind: 'sell', category: 'account', q: run + '-hidden' });
    equal([listed.find(p => p.id === hiddenId)?.ladder_hidden, listed.find(p => p.id === hiddenOnlyId)?.ladder_hidden], [{ master: 2 }, { master: 2 }], 'lists carry the 시즌 비공개 map');
    equal((await read(saleId)).ladder_hidden, {}, 'a post without 시즌 비공개 carries an empty map');
    const swapId = await create(seller, { ...common, kind: 'exchange', title: `[로컬 QA] ${run}-hidden swap`, price: null, tags: [], ladderHidden: { champion: 1 }, details: { wantedCategory: 'clan' } }, '교환 with 시즌 비공개 on the offered account');
    equal((await read(swapId)).ladder_hidden, { champion: 1 }, 'the offered side of 교환 keeps 시즌 비공개');
    for (const [label, payload] of [
        ['ladderHidden on a 구매 post', { ...common, kind: 'buy', title: `[로컬 QA] ${run}-hidden buy`, tags: [], ladderHidden: { master: 1 } }],
        ['ladderHidden on a 클랜 sale', { ...hiddenSale, category: 'clan', title: `[로컬 QA] ${run}-hidden clan`, ladderHidden: { master: 1 } }],
        ['ladderHidden on a 대리 post', { ...common, kind: 'proxy_request', category: 'ladder', title: `[로컬 QA] ${run}-hidden proxy`, ladderHidden: { master: 1 } }],
        ['hidden count 0', { ...hiddenSale, ladderHidden: { master: 0 } }],
        ['hidden count 100', { ...hiddenSale, ladderHidden: { master: 100 } }],
        ['hidden count 1.5', { ...hiddenSale, ladderHidden: { master: 1.5 } }],
        ['hidden count as text', { ...hiddenSale, ladderHidden: { master: '2' } }],
        ['unknown hidden tier', { ...hiddenSale, ladderHidden: { grandmaster: 1 } }],
        ['ladderHidden as a list', { ...hiddenSale, ladderHidden: [{ tier: 'master', count: 2 }] }],
    ]) {
        const response = await validator('posts', 'POST', payload);
        if (response.status === 201) fixturePosts.push({ owner: validator, id: response.data.id });
        equal(response.status, 400, label + ' is refused');
    }
    // Search: '하나라도 맞으면' with every season of a tier also finds hidden emblems of that tier; specific
    // seasons never do, and 'match=all' ignores them.
    const latest = (await guest('config')).data.latestSeason;
    const everyMaster = Array.from({ length: latest - 17 + 1 }, (_, i) => ({ tier: 'master', season: 17 + i }));
    const hiddenQuery = { kind: 'sell', category: 'account', q: run + '-hidden' };
    check(await finds(hiddenOnlyId, { ...hiddenQuery, tags: JSON.stringify(everyMaster) }), 'a buyer filter of every 마스터 season finds the hidden-only post');
    check(await finds(hiddenOnlyId, { ...hiddenQuery, tags: JSON.stringify([...everyMaster, { tier: 'champion', season: 20 }]) }), 'every 마스터 season plus another tier still finds it');
    check(await finds(hiddenId, { ...hiddenQuery, tags: JSON.stringify([{ tier: 'master', season: 18 }]) }), 'a filter of only 18시즌 마스터 finds the post through its visible tag');
    check(!await finds(hiddenOnlyId, { ...hiddenQuery, tags: JSON.stringify([{ tier: 'master', season: 18 }]) }), 'a filter of only 18시즌 마스터 never matches hidden emblems');
    check(!await finds(hiddenId, { ...hiddenQuery, tags: JSON.stringify([{ tier: 'master', season: 19 }]) }), 'a filter of only 19시즌 마스터 does not find the post');
    check(!await finds(hiddenOnlyId, { ...hiddenQuery, tags: JSON.stringify(everyMaster.slice(1)) }), 'a filter missing one 마스터 season does not match hidden emblems');
    check(!await finds(hiddenOnlyId, { ...hiddenQuery, tags: JSON.stringify(everyMaster), match: 'all' }), 'match=all ignores hidden emblems');
    check(await finds(hiddenOnlyId, { kind: 'sell', author: fixtureUsers[0].id, q: '마스터', size: '40' }), "the bare tier word '마스터' also finds hidden emblems");
    // Copy to a new post and 다시 올리기 build the new post from GET /posts/:id (the editor's prefill).
    const source = await read(hiddenOnlyId);
    const copyId = await create(seller, { ...hiddenSale, title: `[로컬 QA] ${run}-hidden copy`, tags: source.tags, ladderHidden: source.ladder_hidden }, '복사해서 새 글 from the hidden-only post');
    equal((await read(copyId)).ladder_hidden, { master: 2 }, 'the copy keeps 시즌 비공개');
    equal((await seller(`posts/${hiddenOnlyId}/status`, 'PATCH', { status: 'closed' })).status, 200, 'the hidden-only post is completed');
    const closed = await read(hiddenOnlyId);
    equal([closed.status, closed.ladder_hidden], ['closed', { master: 2 }], 'a completed post keeps 시즌 비공개');
    const relistId = await create(seller, { ...hiddenSale, title: closed.title, tags: closed.tags, ladderHidden: closed.ladder_hidden }, '다시 올리기 of the completed post');
    equal((await read(relistId)).ladder_hidden, { master: 2 }, 'the relisted post keeps 시즌 비공개');
    // Edits: an empty map removes the rows; an edit from a page without the field keeps them while the post
    // can hold them, and drops them when it cannot (구매).
    await edit(seller, hiddenId, { ...hiddenSale, ladderHidden: {} }, 'edit with an empty 시즌 비공개');
    equal((await read(hiddenId)).ladder_hidden, {}, 'the edit removed the hidden row');
    const { ladderHidden: _omit, ...olderPage } = hiddenSale;
    await edit(seller, copyId, { ...olderPage, title: `[로컬 QA] ${run}-hidden copy` }, 'edit from a page without ladderHidden');
    equal((await read(copyId)).ladder_hidden, { master: 2 }, 'an edit without the field keeps 시즌 비공개');
    await edit(seller, copyId, { ...olderPage, kind: 'buy', title: `[로컬 QA] ${run}-hidden copy`, tags: [] }, 'the copy edited into a 구매 post');
    equal((await read(copyId)).ladder_hidden, {}, 'a 구매 post drops 시즌 비공개');

    // ---- 클랜 래더 티어, 현재 클랜 티어 and 특징 태그 (WP70) ----
    const clanSeasons = [{ tier: 'gold', season: 30 }, { tier: 'gold', season: 31 }, { tier: 'champion', season: 32 }];
    const clanSale = { ...common, category: 'clan', title: `[로컬 QA] ${run}-clan 골드`, tags: [], clanTags: clanSeasons, details: { clanName: `큐에이${run}`, clanLevel: '15', clanMembers: '30', clanTier: 'gold', featureTags: JSON.stringify(['#클랜태그' + run.slice(0, 3)]) } };
    const clanId = await create(seller, clanSale, 'clan sale with clan seasons, 현재 클랜 티어 and a tag');
    const clanPost = await read(clanId);
    equal([clanPost.clan_tags, clanPost.details.clanTier, JSON.parse(clanPost.details.featureTags)], [[{ tier: 'champion', season: 32 }, { tier: 'gold', season: 31 }, { tier: 'gold', season: 30 }], 'gold', ['클랜태그' + run.slice(0, 3)]], 'GET returns the clan seasons, the current tier and the tag');
    const clanBuyId = await create(seller, { ...common, kind: 'buy', category: 'clan', title: `[로컬 QA] ${run}-clan buy`, tags: [], clanTags: [{ tier: 'diamond', season: 31 }], details: { clanTier: 'diamond' } }, '구매 clan post with 원하는 클랜 티어');
    equal((await read(clanBuyId)).clan_tags, [{ tier: 'diamond', season: 31 }], 'a 구매 clan post keeps its wanted clan seasons');
    const swapClanId = await create(seller, { ...common, kind: 'exchange', category: 'account', title: `[로컬 QA] ${run}-clan swap`, price: null, tags: [], wantedClanTags: [{ tier: 'platinum', season: 29 }], details: { wantedCategory: 'clan', wantedClanTier: 'platinum' } }, '교환 asking for a clan');
    const swap = await read(swapClanId);
    equal([swap.wanted_clan_tags, swap.details.wantedClanTier, swap.clan_tags], [[{ tier: 'platinum', season: 29 }], 'platinum', []], 'the wanted clan ladder and tier are kept apart from the offered side');
    const clanQuery = { kind: 'sell', category: 'clan', q: run + '-clan' };
    check(await finds(clanId, { ...clanQuery, clanTags: JSON.stringify([{ tier: 'gold', season: 31 }]) }), 'clan filter (any): 31시즌 클랜 골드');
    check(await finds(clanId, { ...clanQuery, clanTags: JSON.stringify([{ tier: 'gold', season: 31 }, { tier: 'gold', season: 12 }]) }), 'clan filter (any) with one season it lacks');
    check(!await finds(clanId, { ...clanQuery, clanTags: JSON.stringify([{ tier: 'gold', season: 31 }, { tier: 'gold', season: 12 }]), match: 'all' }), 'clan filter (all) needs every season');
    check(await finds(clanId, { ...clanQuery, clanTags: JSON.stringify([{ tier: 'gold', season: 30 }, { tier: 'gold', season: 31 }]), match: 'all' }), 'clan filter (all) with both seasons');
    check(await finds(clanId, { ...clanQuery, clanTier: 'gold' }) && !await finds(clanId, { ...clanQuery, clanTier: 'diamond' }), '현재 클랜 티어 filter');
    check(await finds(clanId, { ...clanQuery, clanLevel: '15', clanMembersMin: '30', clanMembersMax: '30' }) && !await finds(clanId, { ...clanQuery, clanLevel: '16' }), '클랜 레벨 and 클랜원 수 filters');
    check(await finds(clanId, { kind: 'sell', tag: '클랜태그' + run.slice(0, 3) }), 'the tag filter finds the clan post');
    for (const [label, query] of [['an unknown clan tier', { clanTier: 'master' }], ['a clan season out of range', { clanTags: JSON.stringify([{ tier: 'gold', season: 999 }]) }], ['a tag with a space', { tag: '불새 상류' }]]) {
        equal((await guest('posts?' + new URLSearchParams({ kind: 'sell', category: 'clan', ...query }))).status, 400, 'search refuses ' + label);
    }
    // An edit from a page without the clan fields keeps them; an empty list clears them.
    const { clanTags: _clanOmit, ...olderClan } = clanSale;
    await edit(seller, clanId, olderClan, 'clan edit from a page without clanTags');
    equal((await read(clanId)).clan_tags.length, 3, 'an edit without clanTags keeps the clan seasons');
    await edit(seller, clanId, { ...clanSale, clanTags: [] }, 'clan edit with an empty clan ladder');
    equal((await read(clanId)).clan_tags, [], 'an empty clanTags clears them');
    const tagList = n => JSON.stringify(Array.from({ length: n }, (_, i) => `태그${i}`));
    for (const [label, payload] of [
        ['a personal tier on a clan ladder', { ...clanSale, clanTags: [{ tier: 'master', season: 30 }] }],
        ['a clan season before the first clan-ladder season', { ...clanSale, clanTags: [{ tier: 'gold', season: 5 }] }],
        ['a clan season after the latest season', { ...clanSale, clanTags: [{ tier: 'gold', season: 999 }] }],
        ['an unknown 현재 클랜 티어', { ...clanSale, details: { ...clanSale.details, clanTier: 'master' } }],
        ['11 tags', { ...common, title: `[로컬 QA] ${run}-tags 11`, details: { featureTags: tagList(11) } }],
        ['a 13-character tag', { ...common, title: `[로컬 QA] ${run}-tags 13`, details: { featureTags: JSON.stringify(['가나다라마바사아자차카타파']) } }],
        ['a tag with a space', { ...common, title: `[로컬 QA] ${run}-tags space`, details: { featureTags: JSON.stringify(['불새 상류']) } }],
        ['tags on a 구매 post', { ...common, kind: 'buy', title: `[로컬 QA] ${run}-tags buy`, tags: [], details: { featureTags: JSON.stringify(['불새상류']) } }],
    ]) {
        const response = await validator('posts', 'POST', payload);
        if (response.status === 201) fixturePosts.push({ owner: validator, id: response.data.id });
        equal(response.status, 400, label + ' is refused');
    }
    const tenTags = await create(seller, { ...common, title: `[로컬 QA] ${run}-tags 10`, details: { featureTags: tagList(10) } }, '10 tags (the most) are accepted');
    equal(JSON.parse((await read(tenTags)).details.featureTags).length, 10, 'the 10 tags are kept');
    // 레어닉 is a 닉 종류.
    const rareId = await create(seller, { ...common, title: `[로컬 QA] ${run}-rare 사과`, details: { nicknameChars: '2', nicknameTypes: JSON.stringify(['레어닉']) } }, '레어닉 sale');
    check(await finds(rareId, { kind: 'sell', category: 'account', q: run + '-rare', nicknameTypes: JSON.stringify(['레어닉']) }), 'nicknameTypes 레어닉 finds the 레어닉 sale');
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
        // Test members have no chat, report or offer records; their photos go with them (uploads cascade).
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
