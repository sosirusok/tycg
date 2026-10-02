import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// 래더 표시 (WP68) and 클랜 래더 (WP70), unit checks: groupLadders and its helpers (shared/ladder.ts) and the
// 같은 매물 print's ladder, clan ladder and tag fields (shared/listing.ts), both bundled on the fly. The latest season comes from the local
// Worker's GET /api/config, as the pages read it. TEST_BASE_URL defaults to http://127.0.0.1:8790; this
// suite never targets a live site.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790');
assert.ok(['http:', 'https:'].includes(endpoint.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    && !endpoint.username && !endpoint.password && endpoint.pathname === '/'
    && !endpoint.search && !endpoint.hash, 'Local Worker origin required.');
const base = endpoint.origin;
const root = fileURLToPath(new URL('..', import.meta.url));
let checks = 0;
function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

async function load(entry, fileName) {
    const out = await build({ configFile: false, logLevel: 'silent', root, build: { lib: { entry, formats: ['es'], fileName }, write: false, minify: false } });
    return import('data:text/javascript;base64,' + Buffer.from((Array.isArray(out) ? out[0] : out).output[0].code).toString('base64'));
}
const L = await load('shared/ladder.ts', 'ladder');
const P = await load('shared/listing.ts', 'listing');

const config = await (await fetch(base + '/api/config', { signal: AbortSignal.timeout(15000) })).json();
const latest = config.latestSeason;
check(Number.isInteger(latest) && latest >= 32, `the latest season comes from the config (${latest})`);
const range = (tier, from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ tier, season: from + i }));
const labels = (tags, hidden) => L.groupLadders(tags, hidden, latest).map(g => g.label);

// 모든 시즌: every season from the tier's first one (챔피언 8) to the latest.
equal(labels(range('champion', 8, latest)), ['모든 시즌 챔피언'], '8시즌부터 최신 시즌까지 모두 고른 챔피언은 모든 시즌 챔피언');
equal(labels([...range('champion', 8, latest)].reverse().concat({ tier: 'champion', season: 8 })), ['모든 시즌 챔피언'], 'order and repeats do not matter');
equal(labels(range('champion', 9, latest)), [`챔피언 9~${latest}시즌`], 'a missing first season is a range');
// Ranges low~high, listed newest first.
equal(labels([...range('challenger', 23, latest), { tier: 'challenger', season: 20 }, { tier: 'challenger', season: 18 }]), [`챌린저 23~${latest}, 20, 18시즌`], '챌린저 23~최신, 20, 18시즌');
equal(labels([{ tier: 'master', season: 18 }]), ['마스터 18시즌'], 'one season: 마스터 18시즌');
equal(labels([{ tier: 'diamond', season: 20 }, { tier: 'diamond', season: 19 }, { tier: 'diamond', season: 12 }]), ['다이아몬드 19~20, 12시즌'], 'two seasons in a row are a range');
equal(L.seasonRanges([32, 31, 30, 23, 22, 18]), '30~32, 22~23, 18', 'seasonRanges lists the newest range first');
// One group per tier, 챔피언 first and 아이언 last.
const mixed = [
    { tier: 'iron', season: 30 }, { tier: 'gold', season: 10 }, { tier: 'champion', season: 20 }, { tier: 'bronze', season: 7 }, { tier: 'master', season: 18 },
    { tier: 'silver', season: 8 }, { tier: 'diamond', season: 12 }, { tier: 'platinum', season: 9 }, { tier: 'challenger', season: 11 },
];
equal(L.groupLadders(mixed, null, latest).map(g => g.name), ['챔피언', '챌린저', '마스터', '다이아몬드', '플래티넘', '골드', '실버', '브론즈', '아이언'], 'tiers read 챔피언 to 아이언');
equal(L.TIERS_DESC.map(t => t.id), ['champion', 'challenger', 'master', 'diamond', 'platinum', 'gold', 'silver', 'bronze', 'iron'], 'TIERS_DESC is highest first');
// 시즌 비공개.
equal(labels([], { master: 2 }), ['마스터 시즌 비공개 2'], 'hidden only: 마스터 시즌 비공개 2');
equal(labels([{ tier: 'master', season: 18 }], { master: 2 }), ['마스터 18시즌 · 시즌 비공개 2'], 'mixed: 마스터 18시즌 · 시즌 비공개 2');
equal(labels(range('master', 17, latest), { master: 1 }), ['모든 시즌 마스터 · 시즌 비공개 1'], '모든 시즌 with hidden emblems');
equal(labels([], { master: 0, gold: -1 }), [], 'a zero or negative hidden count shows nothing');
const g = L.groupLadders([{ tier: 'master', season: 18 }], { master: 2 }, latest)[0];
equal([g.tier, g.seasons, g.all, g.ranges, g.hidden], ['master', [18], false, '18', 2], 'a group carries its parts');
// The latest season is the config's: one season later the same champion set is no longer 모든 시즌.
equal(L.groupLadders(range('champion', 8, latest), null, latest + 1).map(x => x.label), [`챔피언 8~${latest}시즌`], 'a newer latest season ends 모든 시즌');
equal(L.ladderText([{ tier: 'master', season: 18 }, ...range('champion', 8, latest)], null, latest), '모든 시즌 챔피언, 마스터 18시즌', 'ladderText joins the groups');
// The search side: tiers a filter covers completely.
equal(L.fullTiers([...range('master', 17, latest), { tier: 'champion', season: 9 }], latest), ['master'], 'fullTiers: every 마스터 season');
equal(L.fullTiers(range('master', 18, latest), latest), [], 'fullTiers: one 마스터 season missing');
equal(L.fullTiers(range('iron', 25, latest).concat(range('champion', 8, latest)), latest), ['iron', 'champion'], 'fullTiers: two tiers');
// The API's ladderHidden.
equal(L.validHidden({ master: 2, champion: 99 }), { champion: 99, master: 2 }, 'validHidden accepts known tiers with 1 to 99');
equal(L.validHidden({}), {}, 'validHidden accepts an empty map');
for (const bad of [{ master: 0 }, { master: 100 }, { master: 1.5 }, { master: '2' }, { grandmaster: 1 }, [], null, 'master', { master: 1, x: 1 }])
    equal(L.validHidden(bad), null, 'validHidden refuses ' + JSON.stringify(bad));

// 같은 매물 prints (WP44): the ladder field includes the hidden map; without one it is the value earlier
// prints stored, so existing prints keep matching.
const plain = P.listingFields('sell', 'account', {}, [{ tier: 'master', season: 18 }]);
equal(plain.d.ladder, 'master:18', 'a print without 시즌 비공개 keeps its ladder value');
equal(P.listingFields('sell', 'account', {}, [{ tier: 'master', season: 18 }], {}).d.ladder, 'master:18', 'an empty hidden map changes nothing');
equal(P.listingFields('sell', 'account', {}, [{ tier: 'master', season: 18 }], { master: 2 }).d.ladder, 'master:18,master:h2', 'the print ladder includes the hidden map');
check(P.listingFields('exchange', 'account', {}, [], { master: 2 }).d.ladder !== P.listingFields('exchange', 'account', {}, [], { master: 3 }).d.ladder, 'a different hidden count is a different ladder');

// 클랜 래더 (WP70): the clan tiers, highest first, each from the first clan-ladder season (config).
const clanMin = config.clanMinSeason;
check(Number.isInteger(clanMin) && clanMin >= 1, `the first clan-ladder season comes from the config (${clanMin})`);
const clanTiers = L.clanTiersDesc(clanMin);
equal(clanTiers.map(t => t.name), ['클랜 챔피언', '클랜 챌린저', '클랜 다이아', '클랜 플래티넘', '클랜 골드', '클랜 실버', '클랜 브론즈'], 'clan tiers read 챔피언 to 브론즈');
equal([clanTiers[0].rank, clanTiers[6].rank, clanTiers[4].short], ['1위', '71~100위', '골드'], 'each clan tier carries its clan rank and short name');
const clanLabels = tags => L.groupLadders(tags, null, latest, clanTiers).map(g => g.label);
equal(clanLabels(range('champion', clanMin, latest)), ['모든 시즌 클랜 챔피언'], '모든 시즌 클랜 챔피언');
equal(clanLabels([...range('gold', 28, latest), { tier: 'diamond', season: 20 }]), ['클랜 다이아 20시즌', `클랜 골드 28~${latest}시즌`], `클랜 골드 28~${latest}시즌, highest tier first`);
equal(L.fullTiers(range('gold', clanMin, latest), latest, clanTiers), ['gold'], 'fullTiers works on the clan tiers');
// The 같은 매물 print: the clan ladder supports a clan listing, tags support an account; both empty keep
// the values earlier prints stored.
equal(P.listingFields('sell', 'clan', { clanName: '포토존' }, [], null, [{ tier: 'gold', season: 30 }]).s.clanLadder, 'gold:30', 'a clan print holds its clan ladder');
equal('clanLadder' in P.listingFields('sell', 'clan', { clanName: '포토존' }).s, false, 'a clan print without one is unchanged');
equal(P.listingFields('sell', 'account', { featureTags: '["불새상류","top10"]' }).s.tags, 'top10,불새상류', 'an account print holds its 특징 태그 (sorted)');
equal(P.listingFields('buy', 'clan', {}, [], null, [{ tier: 'champion', season: 32 }]).d.clanLadder, 'champion:32', 'a 구매 clan print holds the wanted clan ladder');
console.log(JSON.stringify({ passed: checks, suite: 'ladder' }));
