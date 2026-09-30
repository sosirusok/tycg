import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

// Server message wording: field errors read '라벨: 내용', duplicate sign-ups name
// the taken field, and manager decisions in the chat read '반려: …'.
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

// No worker template joins a variable straight to a particle ('신고 사유은', '대주 수은').
{
    const dir = new URL('../worker/', import.meta.url), hits = [];
    for (const file of (await readdir(dir)).filter(f => f.endsWith('.ts'))) {
        (await readFile(new URL(file, dir), 'utf8')).split('\n').forEach((line, i) => {
            if (/\$\{[^}]+\}(은|는|이|가|을|를|으로)[ .]/.test(line)) hits.push(`worker/${file}:${i + 1}`);
        });
    }
    equal(hits, [], 'no worker template joins a variable to 은/는/이/가/을/를/으로');
}

const member = client(), manager = client(), guest = client();
const username = `c_${run}_a`, nickname = `copy${run}`;
const joined = await member('auth/register', 'POST', { username, password, nickname });
equal(joined.status, 200, 'member registers');
const me = joined.data.user;

// Duplicate sign-ups say which field is taken.
const takenNickname = await client()('auth/register', 'POST', { username: `c_${run}_b`, password, nickname });
equal([takenNickname.status, takenNickname.data.error], [409, '이미 사용 중인 닉네임입니다.'], 'taken nickname is named');
const takenId = await client()('auth/register', 'POST', { username, password, nickname: `cpx${run}` });
equal([takenId.status, takenId.data.error], [409, '이미 사용 중인 아이디입니다.'], 'taken id is named');

// Field errors use '라벨: 내용' so no particle follows a variable label.
const post = await member('posts', 'POST', { kind: 'sell', category: 'other', title: `[QA] 문구 ${run}`, body: '자동 검증용 게시글입니다.', price: 10000, status: 'open', tags: [], images: [], details: {} });
equal(post.status, 201, 'member writes a test post');
const report = await member('reports', 'POST', { postId: post.data.id, reason: 'x', details: 'y' });
equal([report.status, report.data.error], [400, '신고 사유: 2~50자로 입력해 주세요.'], 'short report reason reads 신고 사유: 2~50자');

const owners = await member('posts', 'POST', { kind: 'sell', category: 'account', title: `[QA] 대주 ${run}`, body: '자동 검증용 게시글입니다.', price: 10000, status: 'open', tags: [], images: [], details: { ownerCount: '-1' } });
equal(owners.status, 400, 'negative owner count is refused');
check(/^[^:]+: \d+~\d+ 사이 숫자로 입력해 주세요\.$/.test(owners.data.error) && !owners.data.error.includes('은 '), `owner count error reads '라벨: 범위' (${owners.data.error})`);

const self = await member('chats', 'POST', { userId: me.id });
equal([self.status, self.data.error], [400, '자신과는 채팅할 수 없습니다.'], 'chatting with yourself is refused');

// Manager decisions in the application chat.
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: managerPassword })).status, 200, 'manager logs in');
const apply = await member('applications', 'POST', { kind: 'grade', target: 'plus', plan: 'permanent' });
equal(apply.status, 201, '플러스 application created');
equal((await manager('applications/' + apply.data.id, 'PATCH', { action: 'reject', note: '입금 확인 안 됨' })).status, 200, 'manager rejects the application');
let messages = await member(`chats/${apply.data.chatId}/messages`);
const rejected = messages.data.messages.find(m => m.type === 'system' && m.reference_id === apply.data.id);
check(rejected && rejected.body.startsWith('반려: 플러스 등급 신청') && rejected.body.includes('(사유: 입금 확인 안 됨)'), `rejection reads 반려: … (사유: …) (${rejected?.body})`);

const cancelled = await member('applications', 'POST', { kind: 'grade', target: 'premium', plan: '6m' });
equal(cancelled.status, 201, '프리미엄 application created');
equal((await member('applications/' + cancelled.data.id, 'PATCH', { action: 'cancel' })).status, 200, 'member cancels the application');
messages = await member(`chats/${cancelled.data.chatId}/messages`);
const cancelNote = messages.data.messages.find(m => m.type === 'system' && m.reference_id === cancelled.data.id);
check(cancelNote?.body.startsWith('신청 취소: 프리미엄 등급 신청'), `cancel reads 신청 취소: … (${cancelNote?.body})`);

// Cafe vocabulary: 영전 is a stored choice, 미통합 keeps its stored value (shown as 미통).
const account = (title, details) => member('posts', 'POST', { kind: 'sell', category: 'account', title: `[QA] ${title} ${run}`, body: '자동 검증용 게시글입니다.', price: 10000, status: 'open', tags: [], images: [], details });
const moved = await account('영전', { ownerCount: '3', phoneChange: '영전', passwordChange: '가능' });
equal(moved.status, 201, 'phoneChange 영전 is accepted');
check((await guest(`posts?kind=sell&category=account&phoneChange=${encodeURIComponent('영전')}&size=40`)).data.posts.some(p => p.id === moved.data.id), 'phoneChange=영전 filter finds the post');
const unlinked = await account('미통', { integrated: '미통합' });
equal(unlinked.status, 201, 'integrated 미통합 is still accepted');
equal((await guest('posts/' + unlinked.data.id)).data.post.details.integrated, '미통합', 'stored value stays 미통합');
check((await guest(`posts?kind=sell&category=account&integrated=${encodeURIComponent('미통합')}&size=40`)).data.posts.some(p => p.id === unlinked.data.id), 'integrated=미통합 filter finds the post');
equal((await account('미통 값', { integrated: '미통' })).status, 400, 'the display word 미통 is not a stored value');

// Skin aliases from trade posts find the listed skin.
const yeseul = await account('스킨 A', { skinTags: JSON.stringify(['냥냥 정예슬']) });
const junho = await account('스킨 B', { skinTags: JSON.stringify(['냥냥 김준호']) });
const plum = await account('스킨 C', { skinTags: JSON.stringify(['홍매화 정예슬']) });
equal([yeseul.status, junho.status, plum.status], [201, 201, 201], 'skin test posts created');
const search = async q => (await guest(`posts?kind=sell&q=${encodeURIComponent(q)}&size=40`)).data.posts.map(p => p.id);
for (const q of ['냥예', '냥예슬', '냥슬']) {
    const ids = await search(q);
    check(ids.includes(yeseul.data.id) && !ids.includes(junho.data.id), `q=${q} finds 냥냥 정예슬 only`);
}
check((await search('냥준호')).includes(junho.data.id), 'q=냥준호 finds 냥냥 김준호');
check((await search('홍매화')).includes(plum.data.id), 'q=홍매화 finds 홍매화 정예슬');

// Badges read 본인 인증, 대리 인증, 신용인 in that order whatever the grant order.
for (const badge of ['proxy', 'identity']) {
    equal((await manager(`manage/users/${me.id}/badges`, 'POST', { badge, active: true })).status, 200, `manager grants ${badge}`);
}
equal((await guest('users/' + me.id)).data.user.badges, ['identity', 'proxy'], 'profile lists badges as identity, proxy');

for (const id of [post.data.id, moved.data.id, unlinked.data.id, yeseul.data.id, junho.data.id, plum.data.id]) {
    equal((await member('posts/' + id, 'DELETE')).status, 200, `test post ${id} removed`);
}
console.log(`Copy verification passed: ${checks} checks`);
