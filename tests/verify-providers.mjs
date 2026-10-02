import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 중개 인증·가측 인증 and the '중개/가측' tab (WP66), on the strict server (READ_BUDGET=on for the read meter,
// TEST_HOOKS=on for X-Test-Now): who may apply and be granted, the listing by grade block with the 소개 cut
// to 0/12/25, the listing rules ('받는 중', 14 days, grade, blocks), the fair order (접속 중 first, then the
// 3-hour seeded rotation), 플러스 paging, the home popup, the 소개 rules, the 수익 홍보 settings, the 등급 축하
// 창 rank and the read budget (≤ 600 rows and one D1 call for 200 providers). Everything it adds as SQL is
// removed at the end, so later suites (verify-budget's home reads) never see its providers.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8791');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }
function refused(r, status, text, name) {
    assert.equal(r.status, status, `${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    assert.ok(String(r.data.error || '').includes(text), `${name}: ${r.data.error}`);
    checks++;
    console.log(`PASS ${name} (${r.data.error})`);
}

const wrangler = ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc', '--persist-to', process.env.TEST_PERSIST || '.wrangler/state'];
function sql(command) {
    const out = execFileSync(process.execPath, [...wrangler, '--json', '--command', command], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
function sqlFile(text) {
    const dir = mkdtempSync(path.join(tmpdir(), 'providers-'));
    try {
        const file = path.join(dir, 'seed.sql');
        writeFileSync(file, text);
        execFileSync(process.execPath, [...wrangler, '--yes', '--file', file], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

// A keep-alive socket the dev server closed while the suite waited on wrangler: send once more.
async function send(url, init) {
    try { return await fetch(url, init()); }
    catch (error) {
        if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
        return fetch(url, init());
    }
}
function client() {
    let cookie = '';
    return async (p, method = 'GET', data, headers = {}) => {
        const response = await send(base + '/api/' + p, () => ({
            method, redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
            body: data === undefined ? undefined : JSON.stringify(data),
        }));
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        const text = await response.text();
        let json;
        try { json = JSON.parse(text); }
        catch { throw new Error(`${method} ${p}: expected JSON, received HTTP ${response.status}: ${text.slice(0, 300)}`); }
        const h = k => Number(response.headers.get(k));
        return { status: response.status, data: json, rows: h('x-rows-read'), calls: h('x-d1-calls'), cache: response.headers.get('cache-control') };
    };
}
async function register(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `pv_${run}_${name}`.slice(0, 24), password, nickname: `중개${name}${run}`.slice(0, 16) });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}

// The server's rotation: FNV-1a of '<id>:<seed>' (worker/ads.ts hash01), 접속 중 first.
function hash01(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0) / 4294967296;
}
const fair = (list, seed) => [...list].sort((a, b) => Number(b.online) - Number(a.online) || hash01(b.id + ':' + seed) - hash01(a.id + ':' + seed));
const ids = list => list.map(p => p.id);

// Leftovers of an interrupted earlier run.
const cleanup = () => sqlFile(`
DELETE FROM provider_profiles WHERE user_id LIKE 'pvb-%' OR user_id IN (SELECT id FROM users WHERE username LIKE 'pv\\_%' ESCAPE '\\');
DELETE FROM user_badges WHERE user_id LIKE 'pvb-%';
DELETE FROM user_grades WHERE user_id LIKE 'pvb-%';
DELETE FROM users WHERE id LIKE 'pvb-%';
`);
cleanup();
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%' OR key LIKE 'trial-ip:%'");

const manager = client(), guest = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const grant = async (c, grade, plan = 'permanent') => equal((await manager(`manage/users/${c.user.id}/grades`, 'POST', { grade, plan })).status, 201, `manager grants ${grade}`);
const badge = (c, b, active = true) => manager(`manage/users/${c.user.id}/badges`, 'POST', { badge: b, active });

// 1. Who may apply: 일반 and the 플러스 체험 are refused with the rule; 플러스 and up apply.
const normal = await register('n');
for (const b of ['broker', 'appraiser']) refused(await normal('applications', 'POST', { kind: 'badge', target: b }), 403, '중개·가측 인증은 플러스 이상 등급부터 신청할 수 있습니다. (무료 체험 제외)', `일반 applying for ${b}`);
sql(`INSERT INTO settings(key,value,updated_at) VALUES('sys:trial_start','${Date.now() - MIN}',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
equal((await manager('manage/trial', 'PUT', { end: Date.now() + DAY })).status, 200, 'the trial window opens for one sign-up');
const trial = await register('t');
equal((await manager('manage/trial', 'PUT', { close: true })).status, 200, 'the window closes again');
sql("UPDATE settings SET value='-1' WHERE key='sys:trial_end'");
equal([trial.user.grade, trial.user.grade_trial], ['plus', true], 'the new member is on the 플러스 체험');
refused(await trial('applications', 'POST', { kind: 'badge', target: 'appraiser' }), 403, '무료 체험 제외', 'the 체험 member applying for 가측 인증');
refused(await badge(trial, 'appraiser'), 409, '플러스 이상 등급 회원에게만', 'the manager granting 가측 인증 to a 체험 member');

const plus = await register('p'), plus2 = await register('p2'), premium = await register('r'), elite = await register('e'), admin = await register('a'), viewer = await register('v');
await grant(plus, 'plus'); await grant(plus2, 'plus'); await grant(premium, 'premium'); await grant(elite, 'elite'); await grant(admin, 'admin');
const apply = await plus('applications', 'POST', { kind: 'badge', target: 'appraiser' });
equal(apply.status, 201, 'a 플러스 member applies for 가측 인증 (201)');
equal((await manager(`applications/${apply.data.id}`, 'PATCH', { action: 'approve' })).status, 200, 'the manager approves it');
check((await plus('auth/me')).data.user.badges.includes('appraiser'), 'the member holds 가측 인증');

// 2. 중개 인증 needs 본인 인증 first; only the manager grants (the 관리자 grade gets 403).
refused(await badge(plus, 'broker'), 409, '본인 인증', '중개 인증 without 본인 인증');
equal((await badge(plus, 'identity')).status, 200, 'the manager grants 본인 인증');
equal((await badge(plus, 'broker')).status, 200, 'with 본인 인증 the manager grants 중개 인증');
equal((await admin(`manage/users/${plus2.user.id}/badges`, 'POST', { badge: 'broker', active: true })).status, 403, 'the 관리자 grade cannot grant 중개 인증');
for (const c of [plus2, premium, elite, admin]) { equal((await badge(c, 'identity')).status, 200, 'identity'); equal((await badge(c, 'broker')).status, 200, 'the manager grants 중개 인증'); }
equal((await badge(elite, 'appraiser')).status, 200, 'the elite member also holds 가측 인증');

// 3. The 소개: one line of at most 25 characters without links or phone numbers, only with the 인증.
refused(await plus('providers/me/broker', 'PUT', { intro: 'https://open.kakao.com/o/abc 연락' }), 400, '소개에는 링크와 연락처를 넣을 수 없습니다.', '소개 with a link');
refused(await plus('providers/me/broker', 'PUT', { intro: '연락 010-1234-5678' }), 400, '소개에는 링크와 연락처를 넣을 수 없습니다.', '소개 with a phone number');
refused(await plus('providers/me/broker', 'PUT', { intro: '가'.repeat(26) }), 400, '25자까지', '소개 over 25 characters');
refused(await normal('providers/me/broker', 'PUT', { intro: '안녕하세요' }), 403, '인증이 있는 회원만', '소개 without the 인증');
const intro25 = '빠르고 안전한 계정 중개 3년 경력 야간 가능합니다 정말로';
assert.equal([...intro25].length > 25, true);
const long = [...intro25].slice(0, 25).join('');
for (const c of [plus, premium, elite, admin]) equal((await c('providers/me/broker', 'PUT', { intro: long })).data, { intro: long, active: true }, 'the member saves a 25-character 소개');
equal((await plus2('providers/me/broker', 'PUT', { intro: '줄\n바꿈   소개' })).data.intro, '줄 바꿈 소개', 'the 소개 is one trimmed line');

// 4. The listing by grade block, the 소개 cut to 0 / 12 / 25 and the card fields.
const list = async (c, type = 'broker', extra = '', headers = {}) => (await c(`providers?type=${type}${extra}`, 'GET', undefined, headers)).data;
let d = await list(guest);
const find = (data, c) => ['elite', 'premium', 'plus'].map(b => [b, data[b].find(p => p.id === c.user.id)]).find(([, p]) => p) || [null, null];
equal(find(d, elite)[0], 'elite', '엘리트 is in the gold block');
equal([find(d, admin)[0], find(d, admin)[1]?.grade], ['elite', 'admin'], '관리자 is in the gold block too (관리자 = 엘리트)');
equal(find(d, premium)[0], 'premium', '프리미엄 is in the 프리미엄 block');
equal(find(d, plus)[0], 'plus', '플러스 is in the 플러스 block');
equal([find(d, elite)[1].intro.length, find(d, admin)[1].intro.length, find(d, premium)[1].intro, find(d, plus)[1].intro], [25, 25, [...long].slice(0, 12).join(''), ''], 'the 소개 is cut to 25 / 25 / 12 / 0');
const card = find(d, plus)[1];
equal(Object.keys(card).sort(), ['avatar', 'avatarId', 'badges', 'grade', 'id', 'intro', 'lastSeenAt', 'nickname', 'online', 'reviewCount'], 'a card has only the listed fields');
equal([card.badges, card.online, card.reviewCount], [['identity'], true, 0], '본인 badge, 접속 중 and 후기 0');
check(!find(d, normal)[1] && !find(d, trial)[1], 'members without the 인증 are not listed');
check(d.mine === null, 'a guest has no own card');
const r0 = await guest('providers?type=broker');
equal(r0.cache, 'private, max-age=30', 'the listing is cached privately for 30 seconds');
equal(find(await list(guest, 'appraiser'), plus)[0], 'plus', 'the 가측 tab lists the 가측 인증 holder');
refused(await guest('providers?type=other'), 400, '종류', 'an unknown kind');

// 5. Listing rules: '받는 중' off, a grade below 플러스, 15 days away and blocks.
equal((await premium('providers/me/broker', 'PUT', { active: false })).data.active, false, 'the 프리미엄 member turns 받는 중 off');
d = await list(guest);
check(!find(d, premium)[1], 'active=0 hides the member');
equal((await list(premium)).mine, { intro: long, active: false, listed: false, reason: 'off' }, 'their own card says why');
equal((await premium('providers/me/broker', 'PUT', { active: true })).data.active, true, 'and turns it on again');
const plusGrade = (await manager('manage/users/' + plus2.user.id)).data.grants.find(g => g.grade === 'plus');
equal((await manager(`manage/users/${plus2.user.id}/grades/${plusGrade.id}`, 'DELETE')).status, 200, 'the manager takes 플러스 back');
check(!find(await list(guest), plus2)[1], 'a member below 플러스 drops off the list');
equal((await list(plus2)).mine.reason, 'grade', "the member's own card says 플러스 이상 등급일 때 목록에 보입니다");
check((await plus2('auth/me')).data.user.badges.includes('broker'), 'the 인증 is kept');
await grant(plus2, 'plus');
equal(find(await list(guest), plus2)[0], 'plus', 'the member returns when the grade is back');
sql(`UPDATE users SET last_seen_at=${Date.now() - 15 * DAY} WHERE id='${plus2.user.id}'`);
check(!find(await list(guest), plus2)[1], '15 days unseen hides the member');
sql(`UPDATE users SET last_seen_at=${Date.now()} WHERE id='${plus2.user.id}'`);
equal(find(await list(guest), plus2)[0], 'plus', 'a visit lists the member again');
equal((await viewer('blocks', 'POST', { userId: plus.user.id, active: true })).status, 200, 'the viewer blocks the 플러스 provider');
equal((await premium('blocks', 'POST', { userId: viewer.user.id, active: true })).status, 200, 'the 프리미엄 provider blocks the viewer');
d = await list(viewer);
check(!find(d, plus)[1] && !find(d, premium)[1] && !!find(d, elite)[1], 'blocked pairs never see each other, others stay');
const asPremium = await list(premium);
check(!asPremium.plus.some(p => p.id === viewer.user.id), 'and the blocking provider sees nothing of the viewer');
check(!!find(await list(guest), plus)[1], 'a guest still sees both');
equal(find(asPremium, premium)[0], 'premium', "a provider sees their own card in its block");
equal((await list(elite)).mine, { intro: long, active: true, listed: true, reason: '' }, 'the listed own card');

// 6. The home popup: listed 엘리트 and 관리자 providers of both kinds join the bottom card's items.
const home = (await guest('home')).data;
const popup = (home.card || []).filter(x => x.provider).map(x => x.provider);
check(popup.length > 0 && popup.every(p => ['elite', 'admin'].includes(p.grade) && ['broker', 'appraiser'].includes(p.type)), 'the home card picks 엘리트 and 관리자 providers');
check(popup.some(p => p.id === elite.user.id) && popup.some(p => p.id === admin.user.id), 'both the 엘리트 and the 관리자 provider are in it');
check(new Set((home.card || []).map(x => x.provider ? x.provider.id : x.post.author_id)).size === (home.card || []).length, 'one item per member');
check(!popup.some(p => p.id === premium.user.id || p.id === plus.user.id), 'no 프리미엄 or 플러스 provider in the popup');

// 7. 200 providers (10 엘리트, 30 프리미엄, 160 플러스; every other one 접속 중): the read budget, the fair order and paging.
const now = Date.now();
sqlFile(`
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200)
INSERT INTO users(id,username,nickname,password_hash,salt,role,bio,created_at,last_seen_at) SELECT 'pvb-${run}-'||i,'pvb_${run}_'||i,'pvb${run}'||i,'','','member','',${now - 30 * DAY},CASE WHEN i%2=0 THEN ${now - MIN} ELSE ${now - HOUR} END FROM n;
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200)
INSERT INTO user_grades(user_id,grade,rank,expires_at,granted_by,granted_at,source) SELECT 'pvb-${run}-'||i,CASE WHEN i<=10 THEN 'elite' WHEN i<=40 THEN 'premium' ELSE 'plus' END,CASE WHEN i<=10 THEN 3 WHEN i<=40 THEN 2 ELSE 1 END,NULL,'manager',${now},'manager' FROM n;
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200)
INSERT INTO user_badges(user_id,badge,granted_by,granted_at) SELECT 'pvb-${run}-'||i,'broker','manager',${now} FROM n;
`);
equal(sql(`SELECT COUNT(*) AS n FROM provider_profiles WHERE user_id LIKE 'pvb-${run}-%' AND type='broker' AND active=1 AND instr(badges,'"broker"')>0`)[0].n, 200, 'the grant trigger made 200 provider rows');
const scanned = sql("SELECT COUNT(*) AS n FROM provider_profiles WHERE type='broker' AND active=1")[0].n;
const metered = await guest('providers?type=broker');
equal(metered.calls, 1, 'the listing is one D1 call');
check(metered.rows <= 3 * scanned && (scanned > 210 || metered.rows <= 600), `the listing reads ${metered.rows} rows for ${scanned} provider rows (≤ 600 for 200 providers)`);
d = metered.data;
const ours = (block, from = d) => from[block].filter(p => p.id.startsWith(`pvb-${run}-`));
equal([ours('elite').length, ours('premium').length, ours('plus').length], [10, 30, 120 - d.plus.filter(p => !p.id.startsWith(`pvb-${run}-`)).length], 'blocks of 10, 30 and a first 플러스 page of 120');
equal([d.plus.length, d.plusMore], [120, true], '플러스 shows 120 with 더 보기');
for (const block of ['elite', 'premium', 'plus']) {
    const list = d[block];
    const firstOff = list.findIndex(p => !p.online);
    check(firstOff === -1 || list.slice(firstOff).every(p => !p.online), `${block}: 접속 중 first`);
    if (block !== 'plus') equal(ids(list), ids(fair(list, d.seed)), `${block}: the seeded rotation inside each group`);
}
const page2 = await list(guest, 'broker', '&page=2');
equal([page2.elite.length, page2.premium.length, page2.plusMore], [0, 0, false], 'page 2 holds only the next 플러스');
const allPlus = [...d.plus, ...page2.plus];
equal(new Set(ids(allPlus)).size, allPlus.length, 'no member on both pages');
equal(ids(allPlus), ids(fair(allPlus, d.seed)), '플러스 pages follow the rotation');
check(allPlus.filter(p => p.id.startsWith(`pvb-${run}-`)).length === 160, 'every 플러스 provider is reachable');
const again = await list(guest);
equal(ids(ours('plus', again)), ids(ours('plus')), 'the same seed gives the same order');
// The next 3-hour block (X-Test-Now, TEST_HOOKS=on): another seed, another order.
const later = await list(guest, 'broker', '', { 'X-Test-Now': String(now + 3 * HOUR) });
check(later.seed !== d.seed, `the seed moves with the 3-hour block (${d.seed} → ${later.seed})`);
const premiumNow = ids(ours('premium')), premiumLater = ids(ours('premium', later));
equal([...premiumLater].sort(), [...premiumNow].sort(), 'the same members');
const moved = premiumNow.filter((id, i) => premiumLater[i] !== id).length;
check(moved >= 10, `the next block reorders ${moved} of 30 members`);
equal(ids(ours('premium', later)), ids(fair(ours('premium', later), later.seed)), 'the next block follows its own seed');

// 8. The 수익 홍보 settings: defaults, a manager edit, '보장' refused, back to the default.
equal((await guest('config')).data.earn, { broker: '5만원 이상', appraise: '5만원 이상', story: '가측만으로 매달 10만원씩 버는 회원도 있습니다' }, 'the 수익 예시 defaults');
equal((await manager('manage/settings', 'PUT', { earn: { broker: '7만원 이상' } })).data.earn.broker, '7만원 이상', 'the manager edits the 중개 example');
refused(await manager('manage/settings', 'PUT', { earn: { story: '수익 보장' } }), 400, '보장', 'a promise is refused');
equal((await manager('manage/settings', 'PUT', { earn: { broker: '' } })).data.earn.broker, '5만원 이상', 'an empty text goes back to the default');

// 9. 등급 축하 창: the session carries the last celebrated rank; POST me/celebrated stores the public rank.
equal([(await viewer('auth/me')).data.user.celebrated_rank], [0], 'a new member starts at 0');
await grant(viewer, 'premium');
const me1 = (await viewer('auth/me')).data.user;
equal([me1.grade, me1.celebrated_rank], ['premium', 0], 'a grant leaves the rank to celebrate');
equal((await viewer('me/celebrated', 'POST', {})).data, { rank: 2 }, 'the member sees the window: rank 2 stored');
equal((await viewer('auth/me')).data.user.celebrated_rank, 2, 'and it shows once');
equal((await trial('me/celebrated', 'POST', {})).data, { rank: 0 }, 'the 무료 체험 counts as 일반');

cleanup();
equal(sql(`SELECT COUNT(*) AS n FROM provider_profiles WHERE user_id LIKE 'pvb-%'`)[0].n, 0, 'the seeded providers are removed');
console.log(`\n${checks} provider checks passed`);
