import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 채팅 자동화 (WP57), on the 8790 server: 내 빠른 답장 by grade (GET/PUT me/automation and me/automation/chat),
// '첫 문의 자동 안내' (프리미엄 and up, once per post per chat, not after the seller wrote in 24 hours),
// '자리 비움' (엘리트 and up, once per chat per window, '지금 자리 비움' and the schedule), and the places
// that never get an automatic answer (the manager chat, another automatic answer, a lower grade).
const base = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790').origin;
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base), 'Local Worker origin required.');
const root = fileURLToPath(new URL('..', import.meta.url));
let checks = 0;
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }
function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function refused(r, status, error, name) { equal([r.status, r.data?.error], [status, error], name); }

function client() {
    let cookie = '';
    return async (path, method = 'GET', data) => {
        const send = () => fetch(base + '/api/' + path, {
            method, signal: AbortSignal.timeout(30000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: data !== undefined ? JSON.stringify(data) : undefined,
        });
        const r = await send().catch(e => { if (e?.cause?.code === 'UND_ERR_SOCKET') return send(); throw e; });
        const s = r.headers.get('set-cookie');
        if (s) cookie = s.split(';')[0];
        return (r.headers.get('content-type') || '').includes('json') ? { status: r.status, data: await r.json() } : { status: r.status, data: null };
    };
}
function sql(command) {
    const out = execFileSync(process.execPath, ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc', '--persist-to', process.env.TEST_PERSIST || '.wrangler/state', '--json', '--command', command],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
const run = randomBytes(4).toString('hex');
const password = randomBytes(12).toString('hex');
async function member(name) {
    const c = client();
    const r = await c('auth/register', 'POST', { username: `ca_${run}_${name}`, password, nickname: `${name}${run}` });
    assert.equal(r.status, 200, 'register ' + name);
    return { call: c, user: r.data.user };
}
const manager = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: process.env.TEST_MANAGER_PASSWORD || 'local-manager-password' })).status, 200, 'manager logs in');
const grant = async (m, grade) => equal((await manager(`manage/users/${m.user.id}/grades`, 'POST', { grade, plan: 'permanent' })).status, 201, `manager grants ${grade}`);
const sale = (title, extra = {}) => ({ kind: 'sell', category: 'other', title: `[QA] ${title} ${run}`, body: '자동 검증', price: 300000, tags: [], details: {}, images: [], ...extra });
async function post(m, data) {
    const r = await m.call('posts', 'POST', data);
    assert.equal(r.status, 201, 'create post ' + data.title);
    return { id: r.data.id, title: data.title };
}
// Opens the chat from the post (채팅하기) or with the member, and sends one message.
async function ask(from, to, text, postId) {
    const opened = await from.call('chats', 'POST', postId ? { postId } : { userId: to.user.id });
    assert.equal(opened.status, 200, 'open chat');
    const sent = await from.call(`chats/${opened.data.id}/messages`, 'POST', { body: text, ...postId ? { postId } : {} });
    assert.equal(sent.status, 201, 'send message');
    return opened.data.id;
}
const say = async (from, chat, text) => equal((await from.call(`chats/${chat}/messages`, 'POST', { body: text })).status, 201, `${text}: sent`);
const autos = async (call, chat) => (await call(`chats/${chat}/messages`)).data.messages.filter(x => x.type === 'auto');

// 1. 내 빠른 답장 by grade.
const N = await member('n'), P = await member('p');
refused(await N.call('me/automation', 'PUT', { templates: ['쿨거 환영'] }), 403, '내 빠른 답장은 플러스부터 가능합니다.', '일반 PUT templates → 403');
const nChat = await N.call('me/automation/chat');
equal([nChat.status, nChat.data.templates, nChat.data.max, nChat.data.canFirst, nChat.data.canAway], [200, [], 0, false, false], '일반 GET me/automation/chat: no own replies, no automatic answers');
await grant(P, 'plus');
const six = ['쿨거 환영', '계좌 인증 가능', '이중창 가능', '스펙 캡처 보내드림', '바로 거래 가능', '네고 불가'];
refused(await P.call('me/automation', 'PUT', { templates: six }), 400, '빠른 답장은 5개까지입니다.', '플러스 with 6 entries → 400');
refused(await P.call('me/automation', 'PUT', { templates: ['가'.repeat(101)] }), 400, '빠른 답장은 100자까지입니다.', 'a 101-character reply → 400');
const five = await P.call('me/automation', 'PUT', { templates: six.slice(0, 5) });
equal([five.status, five.data.chat.templates], [200, six.slice(0, 5)], '플러스 with 5 → 200 (chat settings only in the answer)');
const pState = await P.call('me/automation');
equal([pState.status, pState.data.chat.templates, pState.data.chat.max, pState.data.chat.vars], [200, six.slice(0, 5), 5, false], 'GET me/automation returns them (5/5, no variables)');
equal((await P.call('me/automation/chat')).data.templates, six.slice(0, 5), 'GET me/automation/chat returns them too');
refused(await P.call('me/automation', 'PUT', { firstOn: true }), 403, '첫 문의 자동 안내는 프리미엄부터 가능합니다.', '플러스 sets first_on → 403');
refused(await P.call('me/automation', 'PUT', { awayNow: true }), 403, '자리 비움 응답은 엘리트부터 가능합니다.', '플러스 sets 지금 자리 비움 → 403');
refused(await N.call('me/automation', 'PUT', { firstOn: true }), 403, '첫 문의 자동 안내는 프리미엄부터 가능합니다.', '일반 sets first_on → 403');

// 2. 첫 문의 자동 안내 (프리미엄).
const S = await member('s'), B = await member('b'), C = await member('c'), D = await member('d'), E = await member('e');
await grant(S, 'premium');
const sState = (await S.call('me/automation')).data.chat;
equal([sState.canFirst, sState.firstOn, sState.firstText, sState.max, sState.vars], [true, false, '문의 감사합니다. {제목} 즉거가 {즉거가}입니다. 전번·계좌 인증 가능합니다.', 10, true], '프리미엄: 첫 문의 off by default with the prefilled text, 10 own replies with variables');
const PP = await post(S, sale('첫문의P')), Q = await post(S, sale('첫문의Q', { price: 250000 }));
const quiet = await ask(B, S, '아직 판매중인가요?', PP.id);
equal((await autos(B.call, quiet)).length, 0, 'switch off: no automatic answer');
equal((await S.call('me/automation', 'PUT', { firstOn: true })).data.chat.firstOn, true, '프리미엄 turns 첫 문의 자동 안내 on');
const bChat = await ask(C, S, '쿨거 가능해요', PP.id);
let list = await autos(C.call, bChat);
equal(list.map(m => [m.sender_id, m.body, m.reference_id]), [[S.user.id, `문의 감사합니다. ${PP.title} 즉거가 30만원입니다. 전번·계좌 인증 가능합니다.`, String(PP.id)]], 'C\'s first message about P → one automatic answer from S with P\'s title and 즉거가');
await say(C, bChat, '이중창 인증 가능할까요?');
equal((await autos(C.call, bChat)).length, 1, 'C writes again → no second');
const cUnread = (await C.call('chats/unread')).data.unread;
check(cUnread >= 1, 'the automatic answer counts as unread for C');
const cList = (await C.call('chats')).data.chats.find(x => x.id === bChat);
equal(cList.last_message, '이중창 인증 가능할까요?', 'the chat list preview shows the latest message');
const dChat = await ask(D, S, '아직 판매중인가요?', Q.id);
list = await autos(D.call, dChat);
equal(list.map(m => m.body), [`문의 감사합니다. ${Q.title} 즉거가 25만원입니다. 전번·계좌 인증 가능합니다.`], 'D about Q → one with Q\'s title');
const dPreview = (await D.call('chats')).data.chats.find(x => x.id === dChat);
equal(dPreview.last_message, list[0].body, 'the chat list preview shows the automatic answer\'s body');
// A 구매 글 has no 즉거가: the sentence with {즉거가} is left out.
const R = await post(S, { kind: 'buy', category: 'other', title: `[QA] 구매R ${run}`, body: '자동 검증', price: 200000, tags: [], images: [], details: {} });
const eChat = await ask(E, S, '아직 구하시나요?', R.id);
equal((await autos(E.call, eChat)).map(m => m.body), ['문의 감사합니다. 전번·계좌 인증 가능합니다.'], 'a post without 즉거가 → the sentence with {즉거가} is dropped');
// The seller wrote in the chat an hour earlier: no automatic answer.
const F = await member('f');
const fChat = await ask(S, F, '안녕하세요');
sql(`UPDATE messages SET created_at=created_at-3600000 WHERE conversation_id='${fChat}'`);
await F.call(`chats/${fChat}/messages`, 'POST', { body: '아직 판매중인가요?', postId: PP.id });
equal((await autos(F.call, fChat)).length, 0, 'the seller wrote in the chat 1h earlier → no automatic answer');
// Own text with variables, and the 300-character cap.
refused(await S.call('me/automation', 'PUT', { firstText: '가'.repeat(301) }), 400, '자동 응답 문구는 300자까지입니다.', 'a 301-character text → 400');
equal((await S.call('me/automation', 'PUT', { firstText: '{제목} 문의 감사합니다. 현젯 {현젯}입니다.' })).data.chat.firstText, '{제목} 문의 감사합니다. 현젯 {현젯}입니다.', 'own 첫 문의 text saved');
const G = await member('g');
const gChat = await ask(G, S, '쿨거 가능해요', Q.id);
equal((await autos(G.call, gChat)).map(m => m.body), [`${Q.title} 문의 감사합니다.`], 'own text: {제목} filled, the sentence with {현젯} (none) dropped');
refused(await S.call('me/automation', 'PUT', { awayOn: true }), 403, '자리 비움 응답은 엘리트부터 가능합니다.', '프리미엄 sets 자리 비움 → 403');

// 3. 자리 비움 (엘리트): '지금 자리 비움', once per window.
const X = await member('x'), H = await member('h');
await grant(X, 'elite');
const xNow = await X.call('me/automation', 'PUT', { awayNow: true });
check(xNow.status === 200 && xNow.data.chat.awayUntil > Date.now() + 11 * 3600000, '엘리트 turns 지금 자리 비움 on (12 hours)');
equal([xNow.data.chat.awayOn, xNow.data.chat.awayFrom, xNow.data.chat.awayTo], [false, 2, 10], 'the schedule stays off (02:00-10:00 by default)');
const hChat = await ask(H, X, '계정 아직 있나요');
list = await autos(H.call, hChat);
equal(list.map(m => [m.sender_id, m.body]), [[X.user.id, '지금은 자리를 비웠습니다. 확인 후 답장 드립니다.']], 'H\'s message → the away text once');
await say(H, hChat, '답장 부탁드립니다');
equal((await autos(H.call, hChat)).length, 1, 'a second message → none');
sql(`UPDATE automation SET away_until=away_until+3600000 WHERE user_id='${X.user.id}'`);
await say(H, hChat, '다시 문의드립니다');
equal((await autos(H.call, hChat)).length, 2, 'a new window → one more');
// The manager writes to the away elite: never an automatic answer.
const mChat = await ask({ call: manager }, X, '매니저 안내입니다');
equal((await autos(X.call, mChat)).length, 0, 'a message from the manager → no automatic answer');
// Off again.
equal((await X.call('me/automation', 'PUT', { awayNow: false })).data.chat.awayUntil, null, '지금 자리 비움 off');
await say(H, hChat, '또 문의드립니다');
equal((await autos(H.call, hChat)).length, 2, 'off → no more');
// The schedule: the current KST hour to the next.
const h = new Date(Date.now() + 9 * 3600000).getUTCHours();
refused(await X.call('me/automation', 'PUT', { awayFrom: 3, awayTo: 3 }), 400, '자리 비움 시간을 확인해 주세요.', 'the same start and end hour → 400');
const sched = await X.call('me/automation', 'PUT', { awayOn: true, awayFrom: h, awayTo: (h + 1) % 24, awayText: '지금은 외출 중입니다.' });
equal([sched.status, sched.data.chat.awayOn, sched.data.chat.awayFrom, sched.data.chat.awayText], [200, true, h, '지금은 외출 중입니다.'], 'the schedule covering now, with own text');
const I = await member('i');
const iChat = await ask(I, X, '문의드립니다');
list = await autos(I.call, iChat);
equal(list.map(m => m.body), ['지금은 외출 중입니다.'], 'a message inside the schedule → the own away text');
const start = Date.now() - ((Date.now() + 9 * 3600000) % 3600000);
check(list[0].reference_id === 'away:' + start || list[0].reference_id === 'away:' + (start - 3600000), 'its reference is the window\'s start');
await X.call('me/automation', 'PUT', { awayOn: false });

// 4. Two elites, both away, chat each other: at most one automatic answer per side.
const Y = await member('y'), Z = await member('z');
await grant(Y, 'elite'); await grant(Z, 'elite');
await Y.call('me/automation', 'PUT', { awayNow: true }); await Z.call('me/automation', 'PUT', { awayNow: true });
const yz = await ask(Y, Z, '교환 문의드립니다');
await say(Z, yz, '네 말씀하세요');
await say(Y, yz, '스펙 보내드릴게요');
await say(Z, yz, '확인했습니다');
list = await autos(Y.call, yz);
equal([list.filter(m => m.sender_id === Y.user.id).length, list.filter(m => m.sender_id === Z.user.id).length], [1, 1], 'each side has exactly one automatic answer');

// 4b. Links on the manager's blocklist: refused when the text is saved; a text saved before its host
// was blocked is no longer sent (the member's own message still goes through).
const prevLinks = (await manager('manage/links')).data.domains || [];
equal((await manager('manage/links', 'PUT', { domains: [...prevLinks, `auto-${run}.example`].join('\n') })).status, 200, 'manager blocks a host');
refused(await X.call('me/automation', 'PUT', { awayText: `여기로 연락 https://auto-${run}.example/x` }), 400, '등록할 수 없는 링크가 있습니다.', 'an away text with a blocked link is refused on save');
sql(`UPDATE automation SET away_text='연락처 https://auto-${run}.example/x',away_until=${Date.now() + 3600000} WHERE user_id='${X.user.id}'`);
const K = await member('k');
const kChat = await ask(K, X, '문의드립니다');
equal((await autos(K.call, kChat)).length, 0, 'a stored away text with a host blocked later is not sent');
equal((await manager('manage/links', 'PUT', { domains: prevLinks.join('\n') })).status, 200, 'the blocklist is restored');
sql(`UPDATE automation SET away_text='',away_until=NULL WHERE user_id='${X.user.id}'`);

// 5. A grade that ends keeps the settings but stops the automatic answers.
sql(`UPDATE user_grades SET expires_at=${Date.now() - 1000} WHERE user_id='${S.user.id}'`);
const J = await member('j');
const jChat = await ask(J, S, '아직 판매중인가요?', PP.id);
equal((await autos(J.call, jChat)).length, 0, 'the grade ended → no 첫 문의 자동 안내');
equal((await S.call('me/automation/chat')).data.templates, [], 'the grade ended → no own replies offered');

// 6. '추천 설정 모두 켜기' (WP61, round-3 WP36 change 5): 엘리트 and up (관리자 = 엘리트) turn on 자동 끌올 with 새 글
// 자동 포함, 자동 매칭, 첫 문의 자동 안내 (own text kept) and 자리 비움 (own hours kept) in one call; price drops stay.
const RE = await member('re'), RA = await member('ra'), RP = await member('rp');
await grant(RE, 'elite'); await grant(RA, 'admin'); await grant(RP, 'premium');
const drop = await post(RE, sale('추천 가격 내리기'));
equal((await RE.call(`posts/${drop.id}/auto`, 'PUT', { drop: { on: true, floor: 200000 } })).status, 200, 'the 엘리트 member sets one price drop');
equal((await RE.call('me/automation', 'PUT', { firstText: '내 안내 문구입니다', awayFrom: 1, awayTo: 9, bumpOn: false })).status, 200, 'own 첫 문의 text and 자리 비움 hours, 자동 끌올 off');
const dropBefore = sql(`SELECT drop_on,drop_floor,drop_next_at,drop_count FROM post_auto WHERE post_id=${drop.id}`)[0];
const settingsBefore = sql(`SELECT drop_step,drop_pct,drop_every_h,decline_on FROM automation WHERE user_id='${RE.user.id}'`)[0];
const rec = await RE.call('me/automation/recommended', 'POST', {});
equal([rec.status, rec.data.bumpOn, rec.data.bumpNew, rec.data.chat.firstOn, rec.data.chat.awayOn], [200, true, true, true, true], '엘리트: 추천 설정 모두 켜기 turns everything on');
equal(sql(`SELECT bump_on,bump_new,match_on,first_on,away_on,away_from,away_to,first_text FROM automation WHERE user_id='${RE.user.id}'`)[0],
    { bump_on: 1, bump_new: 1, match_on: 1, first_on: 1, away_on: 1, away_from: 1, away_to: 9, first_text: '내 안내 문구입니다' }, 'match_on, first_on and away_on are 1; the own text and hours stay');
equal(sql(`SELECT drop_on,drop_floor,drop_next_at,drop_count FROM post_auto WHERE post_id=${drop.id}`)[0], dropBefore, 'the price drop of the post is unchanged');
equal(sql(`SELECT drop_step,drop_pct,drop_every_h,decline_on FROM automation WHERE user_id='${RE.user.id}'`)[0], settingsBefore, 'the price drop settings are unchanged');
equal((await RA.call('me/automation/recommended', 'POST', {})).status, 200, '관리자 (= 엘리트) may use it');
equal(sql(`SELECT away_from,away_to FROM automation WHERE user_id='${RA.user.id}'`)[0], { away_from: 2, away_to: 10 }, 'without own hours 자리 비움 is 02:00-10:00');
refused(await RP.call('me/automation/recommended', 'POST', {}), 403, '추천 설정은 엘리트부터 가능합니다.', '프리미엄 → 403');
refused(await N.call('me/automation/recommended', 'POST', {}), 403, '추천 설정은 엘리트부터 가능합니다.', '일반 → 403');

console.log(`verify-chat-auto: ${checks} checks passed`);
