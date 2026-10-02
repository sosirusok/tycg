import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// 관리자 = 엘리트 (owner rule 2026-10-02, WP72). The manager makes one member 엘리트 and one 관리자, and every
// API that exposes grade-dependent behavior must answer both the same, field by field, except the grade
// name: auth/me and me/usage (perks, rules, wallet), the 자동화 tab (자동 끌올, 새 글 자동 포함, intervals,
// 가격 내리기, 판매 글 전체, 추천 설정 모두 켜기), the chat automation (빠른 답장, 첫 문의, 자리 비움), 조건 알림, 글자 꾸미기
// and 링크 미리보기, 대표 글, 광고 slots and the home '엘리트 매물' row, the 중개/가측 gold block (소개 25자) and the
// home popup copy (elite_until), 판매 통계 (level and keys), the manager's 신고 and chat order (rank 3), and the
// 등급 축하 창 tier. The shared helpers (PERKS, titleTier, ringTier, styleRank, introShown, celebrationLines,
// the benefit rows) are compared too, and a source scan refuses grade === 'elite' style checks.
// Runs against the main local Worker (POST_LIMITS=relaxed); see scripts/test-local.mjs.
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
const T = `ap${run}`;
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
        return { status: response.status, data: result };
    };
}
async function load(entry, fileName) {
    const out = await build({ configFile: false, logLevel: 'silent', root, build: { lib: { entry, formats: ['es'], fileName }, write: false, minify: false } });
    return import('data:text/javascript;base64,' + Buffer.from((Array.isArray(out) ? out[0] : out).output[0].code).toString('base64'));
}

// ---- 1. Source scan: no check names the 엘리트 grade id (use rank >= 3 or PERKS[grade]) ----
// Allowed: the purchase screens that list only the grades for sale (ApplyModal, Guide; 관리자 is never sold)
// and PERKS.elite read as a value next to PERKS.premium (ads.ts pause days).
const SCAN = ['worker', 'shared', 'src'], ALLOW = new Set(['src/app/ApplyModal.tsx', 'src/pages/Guide.tsx']);
const BAD = [/[!=]==?\s*['"]elite['"]/, /['"]elite['"]\s*[!=]==?/, /IN\s*\(\s*'elite'/i, /grade\s*=\s*'elite'/, /\brank\s*===?\s*3\b/, /\brank\s*<\s*4\b/, /\brank\s*<=\s*3\b/, /PERKS\.elite\.(?!pauseDays)/];
const files = dir => readdirSync(path.join(root, dir)).flatMap(f => {
    const rel = dir + '/' + f;
    return statSync(path.join(root, rel)).isDirectory() ? files(rel) : /\.(ts|tsx)$/.test(f) ? [rel] : [];
});
const hits = SCAN.flatMap(files).filter(f => !ALLOW.has(f)).flatMap(f => readFileSync(path.join(root, f), 'utf8').split('\n')
    .flatMap((line, i) => BAD.some(re => re.test(line)) && !/^\s*\/\//.test(line) ? [`${f}:${i + 1}: ${line.trim().slice(0, 120)}`] : []));
equal(hits, [], 'no grade check names 엘리트 alone (rank >= 3 or PERKS[grade] instead)');
const triggers = readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).flatMap(f => readFileSync(path.join(root, 'migrations', f), 'utf8').split('\n')
    .flatMap((line, i) => /'elite'|`rank`\s*=\s*3\b|rank\s*=\s*3\b/.test(line) && !/^\s*--/.test(line) ? [`${f}:${i + 1}`] : []));
equal(triggers, [], 'no migration or trigger names 엘리트 alone');

// ---- 2. Shared helpers: 관리자 reads as 엘리트 everywhere but the name ----
const M = await load('shared/membership.ts', 'membership'), R = await load('shared/richtext.ts', 'richtext'), B = await load('shared/benefits.ts', 'benefits');
equal(M.PERKS.admin, M.PERKS.elite, 'PERKS.admin equals PERKS.elite');
equal(M.perksOfRank(4), M.perksOfRank(3), 'perksOfRank(4) equals perksOfRank(3)');
equal(M.adSlotsOfRank(4), M.adSlotsOfRank(3), 'ad slots of rank 4 equal rank 3');
equal([M.titleTier('admin'), M.ringTier('admin'), M.linkPreviewAllowed('admin'), R.styleRank('admin'), R.codesFor(R.styleRank('admin'))],
    [M.titleTier('elite'), M.ringTier('elite'), M.linkPreviewAllowed('elite'), R.styleRank('elite'), R.codesFor(R.styleRank('elite'))], '제목 강조, 프로필 테두리 (gold), 링크 미리보기 and 글자 꾸미기 tools match');
equal(M.ringTier('admin'), 'gold', '관리자 has the gold ring');
equal([M.introShown(M.gradeInfo('admin').rank), M.priorityRank('admin'), M.gradePriority('admin'), M.celebrationLines('admin')],
    [M.introShown(M.gradeInfo('elite').rank), M.priorityRank('elite'), M.gradePriority('elite'), M.celebrationLines('elite')], '소개 25자, 처리 순서 1순위 and the 축하 창 lines match');
equal(M.canProvide({ grade: 'admin' }), M.canProvide({ grade: 'elite' }), '중개·가측 인증 eligibility matches');
for (const row of B.BENEFIT_ROWS.filter(r => !r.price && r.label !== '닉네임 칩')) equal(row.cell('admin'), row.cell('elite'), `benefit row '${row.label}' matches`);

// ---- 3. Members ----
const manager = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const managerId = (await manager('auth/me')).data.user.id;
sql("DELETE FROM rate_limits WHERE key LIKE 'auth-ip:%' OR key LIKE 'auth-user:%'");
async function register(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `ap_${run}_${name}`.slice(0, 24), password, nickname: `패리티${name}${run}`.slice(0, 16) });
    assert.equal(r.status, 200, `${name} registers (${r.data.error || ''})`);
    c.user = r.data.user;
    return c;
}
const elite = await register('e'), admin = await register('a'), other = await register('o');
const both = [elite, admin];
equal((await manager(`manage/users/${elite.user.id}/grades`, 'POST', { grade: 'elite', plan: 'permanent' })).status, 201, 'the manager grants 엘리트');
equal((await manager(`manage/users/${admin.user.id}/grades`, 'POST', { grade: 'admin', plan: 'permanent' })).status, 201, 'the manager appoints 관리자');
for (const c of both) for (const badge of ['identity', 'broker']) equal((await manager(`manage/users/${c.user.id}/badges`, 'POST', { badge, active: true })).status, 200, `the manager grants ${badge}`);

// Field-by-field comparison: the same answer with the member's own names, ids and times taken out.
const VOLATILE = new Set(['id', 'user_id', 'username', 'nickname', 'grade', 'created_at', 'updated_at', 'last_seen_at', 'avatar', 'avatar_thumb', 'nextAt', 'pausedAt', 'bumpAt',
    'nextRefillAt', 'bump_at', 'author_id', 'title', 'trial_at', 'session_expires_at', 'post_id', 'celebrated_rank', 'drop_next_at', 'endsAt', 'lastSeenAt']);
const strip = v => Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.has(k)).map(([k, x]) => [k, strip(x)])) : v;
async function same(pathOf, name, pick = d => d, method = 'GET', data) {
    const re = await elite(typeof pathOf === 'function' ? pathOf(elite) : pathOf, method, typeof data === 'function' ? data(elite) : data);
    const ra = await admin(typeof pathOf === 'function' ? pathOf(admin) : pathOf, method, typeof data === 'function' ? data(admin) : data);
    equal([ra.status, strip(pick(ra.data))], [re.status, strip(pick(re.data))], name);
    return [re, ra];
}

// ---- 4. Session, usage, wallet ----
const [, meA] = await same('auth/me', 'auth/me: the same session fields');
equal([meA.data.user.grade, (await elite('auth/me')).data.user.grade], ['admin', 'elite'], 'only the grade name differs');
const [usageE] = await same('me/usage', 'me/usage: perks, rules, wallet and counts match');
equal(usageE.data.perks.autoEveryMinutes, 30, 'both 자동 끌올 every 30 minutes');

// ---- 5. Posts: 글자 꾸미기 (배경 강조 · 가운데 정렬), 링크 미리보기, 광고 slots, 대표 글 ----
const fnv = s => R.fnv1a(s);
const body = '패리티 본문 줄\n둘째 줄';
const style = { v: 1, n: body.length, h: fnv(body), m: [[0, 3, 'h'], [0, 8, 'ac'], [9, 11, 'z3'], [9, 11, 'c1']] };
const sale = (n, extra = {}) => ({ kind: 'sell', category: 'other', title: `[QA] 관리자 패리티 ${T} ${n}`, body, price: 30000 + n, tags: [], images: [], details: {}, ...extra });
const posts = new Map();
for (const c of both) {
    const ids = [];
    for (let n = 0; n < 6; n++) {
        const r = await c('posts', 'POST', sale(n, n === 0 ? { body_style: style, link_preview: true } : {}));
        assert.equal(r.status, 201, `post: ${JSON.stringify(r.data)}`);
        ids.push(r.data.id);
    }
    posts.set(c, ids);
}
check(true, 'both create a post with 배경 강조, 가운데 정렬, 글자 크기 and 글자색');
await same(c => 'posts/' + posts.get(c)[0], 'the styled post reads back the same (body_style, link_preview, title tier)', d => ({ style: d.post.body_style, preview: d.post.link_preview, kind: d.post.kind }));
const [usage2] = await same('me/usage', 'me/usage after posting: 광고 slots filled the same', d => ({ featured: d.featured.length, open: d.openPosts, autoBump: d.autoBump, perks: d.perks }));
equal(usage2.data.featured.length, 3, '광고 3 slots for both');
for (let n = 0; n < 5; n++) await same(c => `posts/${posts.get(c)[n]}/pin`, `대표 글 ${n + 1} is pinned`, d => d, 'PUT', { active: true });
const [pin6] = await same(c => `posts/${posts.get(c)[5]}/pin`, 'a 6th 대표 글 is refused the same way (5 for both)', d => d, 'PUT', { active: true });
equal(pin6.status, 403, 'the 6th 대표 글 is a 403');
await same(c => `posts/${posts.get(c)[1]}/feature`, '광고 고정 works the same', d => d, 'PUT', { active: true });

// ---- 6. 자동화 ----
const autoPick = d => { const { posts: list, ...rest } = d; return { ...rest, posts: list.length }; };
await same('me/automation', 'me/automation: 자동 끌올, 새 글 자동 포함, intervals, slots, pause days and 가격 내리기 match', autoPick);
await same('me/automation', 'PUT 새 글 자동 포함 and the 가격 내리기 options (5%, 12시간, 자동 거절)', autoPick, 'PUT', { bumpNew: true, dropPct: 5, dropEveryH: 12, declineOn: true });
await same('me/automation/drop-all', '판매 글 전체 (가격 내리기) works the same', d => ({ keys: Object.keys(d).sort() }), 'POST', {});
const [rec] = await same('me/automation/recommended', '추천 설정 모두 켜기 works the same', autoPick, 'POST', {});
equal([rec.status, rec.data.bumpNew, rec.data.canBumpNew, rec.data.everyMin, rec.data.slots], [200, true, true, 30, null], '추천 설정: 200, 새 글 자동 포함, every 30 minutes, every post');
await same('me/automation/chat', 'chat automation: templates, 첫 문의, 자리 비움 match');
const templates = n => Array.from({ length: n }, (_, i) => `빠른 답장 ${i + 1}`);
await same('me/automation', '20 빠른 답장 are saved', d => d.chat, 'PUT', { templates: templates(20) });
const [t21] = await same('me/automation', 'a 21st 빠른 답장 is refused the same way', d => d, 'PUT', { templates: templates(21) });
equal(t21.status, 400, 'the 21st 빠른 답장 is a 400');

// ---- 7. 조건 알림 ----
const [searchesE] = await same('searches', 'GET searches: the same 조건 알림 allowance');
equal(searchesE.data.filterAlerts, 20, '조건 알림 20 for both');
for (let n = 0; n < 20; n++) await same('searches', `조건 알림 ${n + 1} is saved`, d => ({ ok: !!d.id || d }), 'POST', { name: `알림 ${n}`, query: `kind=sell&category=account&min=${1000 + n}`, alert: true });
const [s21] = await same('searches', 'a 21st 조건 알림 is refused the same way', d => d, 'POST', { name: '알림 21', query: 'kind=sell&category=account&min=999', alert: true });

equal(s21.status, 409, 'the 21st is refused for both (20 조건 알림 fill the 20 saved searches)');

// ---- 8. 판매 통계 ----
const [stats] = await same(c => `me/stats?post=${posts.get(c)[2]}`, "판매 통계: level 'full' and the same parts", d => ({ level: d.level, keys: Object.keys(d).sort() }));

equal(stats.data.level, 'full', "판매 통계 level 'full'");

// ---- 9. 광고: the home '엘리트 매물' row. Other suites' slot posts leave the ads first (as verify-promo does). ----
sql(`UPDATE posts SET featured_at=NULL WHERE featured_at IS NOT NULL AND author_id NOT IN ('${elite.user.id}','${admin.user.id}')`);
const home = (await other('home')).data;
equal([...new Set(home.ads.map(p => p.author_id))].sort(), [elite.user.id, admin.user.id].sort(), "home '엘리트 매물' holds both the 엘리트 and the 관리자");

// ---- 10. 중개/가측 gold block, 소개 25자 and the home popup copy ----
const intro = '가'.repeat(25);
await same('providers/me/broker', 'both save a 25-character 소개', d => d, 'PUT', { intro });
const list = (await other('providers?type=broker')).data;
const card = c => list.elite.find(p => p.id === c.user.id);
check(card(elite) && card(admin), 'both are in the gold 엘리트 block');
equal(strip(card(admin)), strip(card(elite)), 'the gold cards match field by field (소개 25자)');
const popup = sql(`SELECT user_id,elite_until FROM provider_profiles WHERE type='broker' AND user_id IN ('${elite.user.id}','${admin.user.id}') ORDER BY user_id`);
equal(popup.map(r => r.elite_until), [9000000000000000, 9000000000000000], 'both are in the home popup index (elite_until: permanent)');

// ---- 11. The manager's order: 신고 and unread chats rank both 3 ----
const target = (await other('posts', 'POST', sale(9))).data.id;
for (const c of both) equal((await c('reports', 'POST', { postId: target, reason: '허위 매물', details: `패리티 ${T}` })).status, 200, 'a report is filed');
const reports = (await manager('manage')).data.reports.filter(r => r.post_id === target && r.status === 'pending');
const rankOf = c => reports.find(r => r.reporter_id === c.user.id)?.reporter_rank;
equal([rankOf(admin), rankOf(elite)], [3, 3], '신고 처리 순서: both rank 3 (1순위)');
for (const r of reports) equal((await manager('manage/report', 'POST', { id: r.id, status: 'resolved' })).status, 200, 'the test report is closed');
for (const c of both) {
    const chat = (await c('chats', 'POST', { userId: managerId })).data.id;
    equal((await c(`chats/${chat}/messages`, 'POST', { body: `패리티 문의 ${T}` })).status, 201, 'a chat to the manager');
    c.chat = chat;
}
const chats = (await manager('chats')).data.chats;
equal([chats.find(c => c.id === admin.chat)?.priority, chats.find(c => c.id === elite.chat)?.priority], [3, 3], '매니저 채팅 순서: both rank 3');

// ---- 12. 등급 축하 창: the gold tier for both (the stored rank is the grade's own) ----
const ce = (await elite('me/celebrated', 'POST', {})).data.rank, ca = (await admin('me/celebrated', 'POST', {})).data.rank;
equal([ce >= 3, ca >= 3, M.publicRank({ grade: 'admin' }) >= 3], [true, true, true], 'both reach the gold 축하 창 (rank 3 and up)');

// Clean up: the test posts leave the boards and the ads.
sql(`UPDATE posts SET status='closed',featured_at=NULL WHERE title LIKE '%${T}%'; UPDATE provider_profiles SET active=0 WHERE user_id IN ('${elite.user.id}','${admin.user.id}')`);
console.log(`\n${checks} admin parity checks passed`);
