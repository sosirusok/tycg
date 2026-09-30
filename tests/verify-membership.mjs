import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Verification badges, grades, manager-chat applications and chat photos.
// Runs only against a local Worker (see scripts/test-local.mjs).
const endpoint = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790');
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Local Worker origin required.');
const base = endpoint.origin;
const managerPassword = process.env.TEST_MANAGER_PASSWORD || 'local-manager-password';
const run = randomBytes(4).toString('hex');
const password = randomBytes(16).toString('hex');
let checks = 0;

function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }

function client() {
    let cookie = '';
    const call = async (path, method = 'GET', data, raw) => {
        const response = await fetch(base + '/api/' + path, {
            method, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(raw ? { 'Content-Type': raw.type } : data === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: raw ? raw.bytes : data === undefined ? undefined : JSON.stringify(data),
        });
        const session = response.headers.get('set-cookie');
        if (session) cookie = session.split(';')[0];
        if (!(response.headers.get('content-type') || '').includes('json')) return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), type: response.headers.get('content-type') };
        return { status: response.status, data: await response.json() };
    };
    return call;
}

// 1x1 PNG
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const applicant = client(), other = client(), manager = client(), guest = client();
const users = {};
for (const [name, c] of Object.entries({ applicant, other })) {
    const r = await c('auth/register', 'POST', { username: `m_${run}_${name}`.slice(0, 24), password, nickname: `${name.slice(0, 3)}${run}` });
    equal(r.status, 200, `${name} registered`);
    users[name] = r.data.user;
    equal(r.data.user.grade, 'normal', `${name} starts as 일반`);
    equal(r.data.user.badges, [], `${name} starts without badges`);
}
const login = await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword });
equal(login.status, 200, 'manager logs in with the deploy-time password');
equal(login.data.user.role, 'manager', 'manager role');
equal(login.data.user.nickname, '우와오', 'manager nickname');

const config = await guest('config');
equal(config.status, 200, 'config is public');
equal(config.data.manager?.id, 'manager', 'config names the manager for application chats');
check(Number.isInteger(config.data.latestSeason) && config.data.latestSeason >= 32, 'config has the latest ladder season');

const proxyPost = { kind: 'proxy_offer', category: 'ladder', title: `[QA] 대리 ${run}`, body: '자동 검증용 게시글입니다.', price: 30000, status: 'open', tags: [], images: [], details: {} };
equal((await applicant('posts', 'POST', proxyPost)).status, 403, '대리(진행) writing requires 대리 인증');
equal((await applicant('posts', 'POST', { ...proxyPost, kind: 'proxy_request' })).status, 201, '대리(구함) stays open to everyone');

// Identity verification through the manager chat
const apply = await applicant('applications', 'POST', { kind: 'badge', target: 'identity' });
equal(apply.status, 201, 'identity application created');
check(apply.data.chatId && apply.data.id, 'application returns the manager chat');
const again = await applicant('applications', 'POST', { kind: 'badge', target: 'identity' });
equal([again.status, again.data.id, again.data.created], [200, apply.data.id, false], 'duplicate pending application reuses the request');
equal((await manager('applications', 'POST', { kind: 'badge', target: 'identity' })).status, 400, 'manager cannot apply');
equal((await applicant('applications', 'POST', { kind: 'badge', target: 'nope' })).status, 400, 'unknown badge rejected');

const chats = await applicant('chats');
const managerChat = chats.data.chats.find(c => c.id === apply.data.chatId);
check(managerChat && managerChat.partner_id === 'manager', 'application chat is with the manager');
equal(managerChat.role, 'manager', 'chat list shows the partner role');
let messages = await applicant(`chats/${apply.data.chatId}/messages`);
check(messages.data.messages.some(m => m.type === 'application' && m.reference_id === apply.data.id), 'application card message in chat');
equal(messages.data.applications.find(a => a.id === apply.data.id)?.status, 'pending', 'chat lists the pending application');

equal((await applicant(`chats/${apply.data.chatId}/messages`, 'POST', { body: '전화번호: 010-0000-0000' })).status, 201, 'applicant sends identity details');
const upload = await applicant('uploads', 'POST', undefined, { type: 'image/png', bytes: png });
equal(upload.status, 201, 'applicant uploads a screenshot');
equal((await other(`chats/${apply.data.chatId}/messages`, 'POST', { body: 'x' })).status, 404, 'outsider cannot post in the chat');
equal((await manager(`chats/${apply.data.chatId}/messages`, 'POST', { images: [upload.data.id] })).status, 403, 'cannot send someone else\'s photo');
equal((await applicant(`chats/${apply.data.chatId}/messages`, 'POST', { body: '', images: [upload.data.id] })).status, 201, 'photo-only chat message');
equal((await applicant(`chats/${apply.data.chatId}/messages`, 'POST', { body: '' })).status, 400, 'empty message rejected');
const managerImage = await manager('images/' + upload.data.id);
equal([managerImage.status, managerImage.type], [200, 'image/png'], 'manager can open the chat photo');
equal(Buffer.compare(Buffer.from(managerImage.bytes), Buffer.from(png)), 0, 'chat photo bytes round-trip');
equal((await other('images/' + upload.data.id)).status, 404, 'outsider cannot open the chat photo');
equal((await guest('images/' + upload.data.id)).status, 404, 'guest cannot open the chat photo');
messages = await manager(`chats/${apply.data.chatId}/messages`);
check(messages.data.messages.some(m => m.attachments?.includes(upload.data.id)), 'message carries the attachment id');
const managerList = await manager('chats');
equal(managerList.data.chats.find(c => c.id === apply.data.chatId)?.pending_applications, 1, 'manager chat list counts pending applications');
equal(managerList.data.chats.find(c => c.id === apply.data.chatId)?.last_message, '사진', 'photo-only preview text');

const pending = await manager('manage/applications?status=pending');
check(pending.data.applications.some(a => a.id === apply.data.id && a.nickname === users.applicant.nickname), 'manager sees the pending application');
equal((await other('manage/applications')).status, 403, 'members cannot open manager tools');
equal((await other(`applications/${apply.data.id}`, 'PATCH', { action: 'approve' })).status, 404, 'other members cannot see the application');
equal((await applicant(`applications/${apply.data.id}`, 'PATCH', { action: 'approve' })).status, 403, 'applicant cannot approve');
equal((await manager(`applications/${apply.data.id}`, 'PATCH', { action: 'approve' })).status, 200, 'manager approves');
equal((await manager(`applications/${apply.data.id}`, 'PATCH', { action: 'approve' })).status, 409, 'approval is one-time');
let me = await applicant('auth/me');
equal(me.data.user.badges, ['identity'], '본인 인증 granted');
messages = await applicant(`chats/${apply.data.chatId}/messages`);
check(messages.data.messages.some(m => m.type === 'system' && m.body.includes('본인 인증')), 'approval notice in chat');
equal((await applicant('applications', 'POST', { kind: 'badge', target: 'identity' })).status, 409, 'held badge cannot be re-requested');

// 대리 인증: rejected, then approved
const proxyApp = await applicant('applications', 'POST', { kind: 'badge', target: 'proxy' });
equal(proxyApp.status, 201, 'proxy application created');
equal(proxyApp.data.chatId, apply.data.chatId, 'all applications share the manager chat');
equal((await manager(`applications/${proxyApp.data.id}`, 'PATCH', { action: 'reject', note: '거래 내역 부족' })).status, 200, 'manager rejects');
messages = await applicant(`chats/${apply.data.chatId}/messages`);
check(messages.data.messages.some(m => m.type === 'system' && m.body.includes('거래 내역 부족')), 'rejection reason in chat');
const proxyApp2 = await applicant('applications', 'POST', { kind: 'badge', target: 'proxy' });
equal(proxyApp2.status, 201, 'new application after rejection');
check(proxyApp2.data.id !== proxyApp.data.id, 'rejected application is not reused');
equal((await manager(`applications/${proxyApp2.data.id}`, 'PATCH', { action: 'approve' })).status, 200, 'proxy approved');
const proxyCreated = await applicant('posts', 'POST', proxyPost);
equal(proxyCreated.status, 201, '대리(진행) allowed after 대리 인증');
const listed = await guest('posts?kind=proxy_offer&category=ladder');
const listedPost = listed.data.posts.find(p => p.id === proxyCreated.data.id);
equal(listedPost?.author_badges, ['proxy', 'identity'], 'listing shows author badges in display order');
equal(listedPost?.author_grade, 'normal', 'listing shows author grade');
check((await guest('posts?kind=proxy_offer&badge=proxy')).data.posts.some(p => p.id === proxyCreated.data.id), 'filter by author badge');

// Grades
equal((await applicant('applications', 'POST', { kind: 'grade', target: 'plus', plan: '6m' })).status, 400, '플러스 is permanent only');
equal((await applicant('applications', 'POST', { kind: 'grade', target: 'admin', plan: 'permanent' })).status, 400, '관리자 cannot be requested');
equal((await applicant('applications', 'POST', { kind: 'grade', target: 'elite', plan: 'x' })).status, 400, 'unknown plan rejected');
const premium = await applicant('applications', 'POST', { kind: 'grade', target: 'premium', plan: 'permanent' });
equal(premium.status, 201, 'premium request');
const premiumChanged = await applicant('applications', 'POST', { kind: 'grade', target: 'premium', plan: '6m' });
equal([premiumChanged.data.id, premiumChanged.data.created], [premium.data.id, false], 'changing the period updates the pending request');
equal((await manager('manage/applications?status=pending')).data.applications.find(a => a.id === premium.data.id)?.plan, '6m', 'updated period stored');
const before = Date.now();
equal((await manager(`applications/${premium.data.id}`, 'PATCH', { action: 'approve' })).status, 200, 'premium 6 months approved');
me = await applicant('auth/me');
equal(me.data.user.grade, 'premium', 'effective grade 프리미엄');
const days = (me.data.user.grade_expires_at - before) / 86400000;
check(days > 179 && days < 186, '6-month expiry set (' + days.toFixed(1) + ' days)');
const plus = await applicant('applications', 'POST', { kind: 'grade', target: 'plus', plan: 'permanent' });
equal((await manager(`applications/${plus.data.id}`, 'PATCH', { action: 'approve' })).status, 200, 'permanent plus approved');
me = await applicant('auth/me');
equal(me.data.user.grade, 'premium', 'higher active grade wins');
const detail = await manager('manage/users/' + users.applicant.id);
equal(detail.status, 200, 'manager member detail');
const premiumGrant = detail.data.grants.find(g => g.grade === 'premium');
check(premiumGrant && premiumGrant.expires_at, 'premium grant recorded with expiry');
equal((await manager(`manage/users/${users.applicant.id}/grades/${premiumGrant.id}`, 'DELETE')).status, 200, 'manager revokes premium');
me = await applicant('auth/me');
equal([me.data.user.grade, me.data.user.grade_expires_at], ['plus', null], 'falls back to permanent 플러스');
equal((await applicant('applications', 'POST', { kind: 'grade', target: 'plus', plan: 'permanent' })).status, 409, 'cannot buy a grade already held permanently');
const elite = await applicant('applications', 'POST', { kind: 'grade', target: 'elite', plan: '6m' });
equal((await applicant(`applications/${elite.data.id}`, 'PATCH', { action: 'cancel' })).status, 200, 'applicant cancels');
equal((await manager(`applications/${elite.data.id}`, 'PATCH', { action: 'approve' })).status, 409, 'cancelled request cannot be approved');

equal((await manager(`manage/users/${users.other.id}/grades`, 'POST', { grade: 'admin', plan: 'permanent' })).status, 201, 'manager appoints 관리자');
equal((await manager(`manage/users/${users.other.id}/grades`, 'POST', { grade: 'plus', plan: '6m' })).status, 400, 'invalid manual plan rejected');
equal((await manager(`manage/users/${users.other.id}/badges`, 'POST', { badge: 'credit', active: true })).status, 200, 'manager grants 신용인 directly');
let profile = await guest('users/' + users.other.id);
equal([profile.data.user.grade, profile.data.user.badges], ['admin', ['credit']], 'profile shows grade and badges');
equal((await manager(`manage/users/${users.other.id}/badges`, 'POST', { badge: 'credit', active: false })).status, 200, 'manager revokes a badge');
profile = await guest('users/' + users.other.id);
equal(profile.data.user.badges, [], 'badge removed');
const search = await manager('manage/users?q=' + encodeURIComponent(users.other.nickname));
check(search.data.users.some(u => u.id === users.other.id && u.grade === 'admin'), 'manager member search');
equal((await other('manage/users')).status, 403, '관리자 grade has no manager powers');

const privateProfile = await other('users/' + users.applicant.id);
equal(privateProfile.data.user.grade, 'plus', 'others see the grade');
const selfProfile = await applicant('users/' + users.applicant.id);
equal(selfProfile.data.user.grade_expires_at, null, 'permanent grade has no expiry');

// Settings
const settings = await manager('manage/settings', 'PUT', { paymentNotice: '국민 000-00-0000 (예금주 확인)', latestSeason: 33 });
equal(settings.status, 200, 'manager updates settings');
equal([settings.data.paymentNotice, settings.data.latestSeason], ['국민 000-00-0000 (예금주 확인)', 33], 'settings saved');
equal((await guest('config')).data.latestSeason, 33, 'latest season is public');
const s33 = await applicant('posts', 'POST', { kind: 'sell', category: 'account', title: `[QA] 33시즌 ${run}`, body: '자동 검증', price: 10000, status: 'open', tags: [{ tier: 'master', season: 33 }], images: [], details: {} });
equal(s33.status, 201, 'new season accepted after the manager raises it');
equal((await manager('manage/settings', 'PUT', { latestSeason: 32 })).status, 400, 'season cannot go backwards');
equal((await other('manage/settings', 'PUT', { latestSeason: 40 })).status, 403, 'members cannot change settings');

console.log(`\n${checks} membership checks passed`);
