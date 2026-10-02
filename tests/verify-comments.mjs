import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 댓글·답글 (WP55, cafe parity), on the 8790 server: the routes, one level of 답글, the limits, the 알림,
// blocks, deletes, the post's comment_count, 신고, the 링크 차단 list and 내 거래 '댓글'. The comment photo
// against the daily cleanup is checked in verify-cleanup (the cron runs on 8791 only).
const base = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:8790').origin;
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base), 'Local Worker origin required.');
const root = fileURLToPath(new URL('..', import.meta.url));
let checks = 0;
function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); checks++; console.log('PASS ' + name); }
function check(value, name) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function refused(r, status, error, name) { equal([r.status, r.data?.error], [status, error], name); }

function client() {
    let cookie = '';
    return async (path, method = 'GET', data, raw) => {
        const send = () => fetch(base + '/api/' + path, {
            method, signal: AbortSignal.timeout(30000),
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(raw ? { 'Content-Type': raw.type } : data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: raw ? raw.bytes : data !== undefined ? JSON.stringify(data) : undefined,
        });
        const r = await send().catch(e => { if (e?.cause?.code === 'UND_ERR_SOCKET') return send(); throw e; });
        const s = r.headers.get('set-cookie');
        if (s) cookie = s.split(';')[0];
        return (r.headers.get('content-type') || '').includes('json') ? { status: r.status, data: await r.json() } : { status: r.status, data: null, bytes: await r.arrayBuffer() };
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
    const r = await c('auth/register', 'POST', { username: `cm_${run}_${name}`, password, nickname: `${name}${run}` });
    assert.equal(r.status, 200, 'register ' + name);
    return { call: c, user: r.data.user };
}
const sale = (title, extra = {}) => ({ kind: 'sell', category: 'other', title: `[QA] ${title} ${run}`, body: '자동 검증', price: 10000, tags: [], details: {}, images: [], ...extra });
const comments = async (c, id) => (await c(`posts/${id}/comments`)).data.comments;
const unread = async (c, type) => (await c('notifications?page=1')).data.alerts.filter(a => a.type === type && !a.read);

const A = await member('a'), B = await member('b'), C = await member('c'), D = await member('d'), E = await member('e');
const guest = client(), manager = client();
equal((await manager('auth/login', 'POST', { username: 'sosirusok', password: process.env.TEST_MANAGER_PASSWORD || 'local-manager-password' })).status, 200, 'manager logs in');

const created = await A.call('posts', 'POST', sale('댓글'));
equal(created.status, 201, 'A creates a post');
const postId = created.data.id;
equal((await guest(`posts/${postId}/comments`)).data.comments, [], 'a post with no 댓글 lists none');

// 1. 댓글, 답글 and one level only.
const first = await B.call(`posts/${postId}/comments`, 'POST', { body: '  아직 판매중인가요?  ' });
equal([first.status, first.data.count], [201, 1], 'B comments on A\'s post → 201 (count 1)');
let list = await comments(guest, postId);
equal(list.map(c => [c.id, c.body, c.is_post_author, c.parent_id]), [[first.data.id, '아직 판매중인가요?', false, null]], 'GET comments shows it (trimmed), not by the post author');
const reply = await A.call(`posts/${postId}/comments`, 'POST', { body: '네 판매중입니다', parentId: first.data.id });
equal(reply.status, 201, 'A replies → 201');
list = await comments(B.call, postId);
equal(list.map(c => [c.id, c.parent_id, c.is_post_author]), [[first.data.id, null, false], [reply.data.id, first.data.id, true]], 'the 답글 sits under its 댓글 with is_post_author true');
check(list[1].nickname === A.user.nickname && Array.isArray(list[1].author_badges) && typeof list[1].author_grade === 'string', 'each row carries the name line (nickname, grade, badges)');
refused(await B.call(`posts/${postId}/comments`, 'POST', { body: '답글의 답글', parentId: reply.data.id }), 400, '답글에는 답글을 달 수 없습니다.', 'B replies to A\'s 답글 → 400');
refused(await B.call(`posts/${postId}/comments`, 'POST', { body: '다른 글', parentId: 999999999 }), 404, '댓글을 찾을 수 없습니다.', 'a 답글 to an unknown 댓글 → 404');
refused(await guest(`posts/${postId}/comments`, 'POST', { body: '손님' }), 401, '로그인이 필요합니다.', 'a guest cannot comment');

// 2. Lengths and limits.
refused(await B.call(`posts/${postId}/comments`, 'POST', { body: '가'.repeat(3001) }), 400, '댓글은 3,000자까지입니다.', 'a 3,001-character body → 400');
equal((await B.call(`posts/${postId}/comments`, 'POST', { body: '나'.repeat(3000) })).status, 201, 'a 3,000-character body is fine');
refused(await B.call(`posts/${postId}/comments`, 'POST', { body: ' \n\t ' }), 400, '댓글 내용을 입력해 주세요.', 'whitespace only → 400');
const spam = await E.call('posts', 'POST', sale('도배'));
let codes = [];
for (let i = 0; i < 21; i++) codes.push((await E.call(`posts/${spam.data.id}/comments`, 'POST', { body: '도배 ' + i })).status);
equal([codes.slice(0, 20).every(s => s === 201), codes[20]], [true, 429], 'the 21st 댓글 within 10 minutes → 429');
equal((await E.call(`posts/${spam.data.id}`)).data.post.comment_count, 20, 'the post counts 20 댓글');
// 200 since KST midnight: D's day is filled directly.
sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200) INSERT INTO comments(post_id,author_id,body,created_at) SELECT ${spam.data.id},'${D.user.id}','채움',${Date.now()} FROM n`);
refused(await D.call(`posts/${postId}/comments`, 'POST', { body: '201번째' }), 429, '도배 방지: 오늘 댓글은 200개까지입니다.', 'the 201st 댓글 of the KST day → 429');
sql(`DELETE FROM comments WHERE author_id='${D.user.id}'`);
equal((await manager(`posts/${spam.data.id}/comments`, 'POST', { body: '매니저 안내' })).status, 201, 'the manager is exempt from the limits');

// 3. 알림.
equal((await unread(A.call, 'comment')).length, 1, 'A has one unread comment 알림');
const replyAlerts = await unread(B.call, 'reply');
equal([replyAlerts.length, replyAlerts[0]?.text, replyAlerts[0]?.post_id], [1, `내 댓글 답글 · ${A.user.nickname}`, postId], 'B has one reply 알림');
equal((await unread(A.call, 'comment'))[0].text, `‘[QA] 댓글 ${run}’ 글 댓글 · ${B.user.nickname}`, "the comment 알림 reads '‘제목’ 글 댓글 · 닉'");
equal((await B.call(`posts/${postId}/comments`, 'POST', { body: '한 번 더' })).status, 201, 'B comments again');
equal((await unread(A.call, 'comment')).length, 1, 'A still has one unread comment 알림');
equal((await unread(A.call, 'reply')).length, 0, 'the author never hears of their own 답글');

// 4. Blocks.
equal((await C.call('blocks', 'POST', { userId: B.user.id, active: true })).status, 200, 'C blocks B');
list = await comments(C.call, postId);
check(!list.some(c => c.author_id === B.user.id) && !list.some(c => c.id === reply.data.id), "C's GET comments has no B rows (nor the 답글 under B's 댓글)");
check((await comments(D.call, postId)).some(c => c.author_id === B.user.id), 'D still sees B\'s 댓글');
const cPost = await C.call('posts', 'POST', sale('차단'));
refused(await B.call(`posts/${cPost.data.id}/comments`, 'POST', { body: '안녕하세요' }), 403, '차단된 회원입니다.', 'B cannot comment on the post of C, who blocked B');
equal((await D.call(`posts/${cPost.data.id}/comments`, 'POST', { body: '문의' })).status, 201, 'D comments on C\'s post');
equal((await unread(C.call, 'comment')).length, 1, 'C hears of D');

// 5. Edit and delete.
const aOwn = await A.call(`posts/${postId}/comments`, 'POST', { body: '작성자 공지' });
refused(await B.call('comments/' + aOwn.data.id, 'PATCH', { body: '남의 댓글' }), 403, '권한이 없습니다.', 'only the author edits a 댓글');
equal((await A.call('comments/' + aOwn.data.id, 'PATCH', { body: '작성자 공지 (수정)' })).status, 200, 'the author edits it');
equal((await comments(guest, postId)).find(c => c.id === aOwn.data.id).body, '작성자 공지 (수정)', 'the edit shows');
const bLone = await B.call(`posts/${postId}/comments`, 'POST', { body: '지울 댓글' });
equal((await A.call('comments/' + bLone.data.id, 'DELETE')).status, 200, 'A (the post author) deletes B\'s 댓글 → 200');
equal(sql(`SELECT COUNT(*) AS n FROM comments WHERE id=${bLone.data.id}`)[0].n, 0, 'a 댓글 without 답글 is removed');
refused(await D.call('comments/' + aOwn.data.id, 'DELETE'), 403, '권한이 없습니다.', 'D deletes A\'s 댓글 → 403');
equal((await manager('comments/' + aOwn.data.id, 'DELETE')).status, 200, 'the manager deletes it → 200');
equal((await B.call('comments/' + first.data.id, 'DELETE')).status, 200, 'B deletes the 댓글 that has A\'s 답글');
list = await comments(guest, postId);
const gone = list.find(c => c.id === first.data.id);
equal([gone?.deleted, gone?.body, gone?.author_id, list[list.indexOf(gone) + 1]?.id], [true, undefined, undefined, reply.data.id], "a deleted parent with a 답글 stays as '삭제된 댓글입니다.' (no body or author)");
refused(await B.call(`posts/${postId}/comments`, 'POST', { body: '답글', parentId: first.data.id }), 404, '댓글을 찾을 수 없습니다.', 'a deleted 댓글 takes no new 답글');
equal((await A.call('comments/' + reply.data.id, 'DELETE')).status, 200, 'A deletes the last 답글');
equal(sql(`SELECT COUNT(*) AS n FROM comments WHERE id IN (${first.data.id},${reply.data.id})`)[0].n, 0, 'the cleared parent goes with its last 답글');

// 6. comment_count on the list rows and the detail.
const counted = await A.call('posts', 'POST', sale('개수'));
for (const body of ['하나', '둘']) await D.call(`posts/${counted.data.id}/comments`, 'POST', { body });
const row = (await guest(`posts?author=${A.user.id}&size=40`)).data.posts.find(p => p.id === counted.data.id);
equal(row?.comment_count, 2, 'after two 댓글 the list row comment_count is 2');
const live = sql(`SELECT COUNT(*) AS n FROM comments WHERE post_id=${postId} AND deleted_at IS NULL`)[0].n;
equal((await guest(`posts/${postId}`)).data.post.comment_count, live, 'the detail count matches the live rows');

// 7. A completed post still takes 댓글; a hidden one does not.
equal((await A.call(`posts/${counted.data.id}/status`, 'PATCH', { status: 'closed' })).status, 200, 'A completes the post');
equal((await D.call(`posts/${counted.data.id}/comments`, 'POST', { body: '얼마에 거래됐나요?' })).status, 201, 'a completed post still takes 댓글');
equal((await manager('manage/visibility', 'POST', { postId: counted.data.id, hidden: true })).status, 200, 'the manager hides the post');
refused(await D.call(`posts/${counted.data.id}/comments`, 'POST', { body: '숨김' }), 404, '게시글을 찾을 수 없습니다.', 'a hidden post takes no 댓글');
equal((await D.call(`posts/${counted.data.id}/comments`)).status, 404, 'and its 댓글 are not listed to others');
equal((await A.call(`posts/${counted.data.id}/comments`)).status, 200, 'the author still reads them');

// 8. 신고 of a 댓글.
const target = await B.call(`posts/${postId}/comments`, 'POST', { body: '사기 의심 댓글' });
const report = await D.call('reports', 'POST', { commentId: target.data.id, reason: '사기·먹튀', details: '외부 링크로 유도' });
equal(report.status, 201, 'a report with commentId → 201');
refused(await D.call('reports', 'POST', { commentId: target.data.id, reason: '사기·먹튀', details: '다시' }), 409, '이미 신고한 댓글입니다.', 'one waiting report per 댓글');
equal((await D.call('reports', 'POST', { postId, reason: '허위 매물', details: '글 신고' })).status, 200, 'a 댓글 report does not block a report of the post');
refused(await B.call('reports', 'POST', { commentId: target.data.id, reason: '기타', details: '내 댓글' }), 400, '내 댓글은 신고할 수 없습니다.', 'the author cannot report their own 댓글');
const filed = (await manager('manage')).data.reports.find(r => r.comment_id === target.data.id);
equal([filed?.comment_body, filed?.post_id, filed?.comment_live], ['사기 의심 댓글', postId, 1], "the manager's 신고 list shows the 댓글 text with its post");
equal((await manager('comments/' + target.data.id, 'DELETE')).status, 200, 'the manager deletes the reported 댓글');
const after = (await manager('manage')).data.reports.find(r => r.comment_id === target.data.id);
equal([after?.comment_body, after?.comment_live], ['사기 의심 댓글', 0], 'the report keeps the text after the delete');

// 9. The 링크 차단 list; comment addresses are links in the app (no previews).
equal((await manager('manage/links', 'PUT', { domains: `blocked-${run}.example` })).status, 200, 'the manager blocks a domain');
try {
    refused(await D.call(`posts/${postId}/comments`, 'POST', { body: `여기서 거래해요 https://pay.blocked-${run}.example/x` }), 400, '등록할 수 없는 링크가 있습니다.', 'a 댓글 with a blocked domain → 400');
    const ok = await D.call(`posts/${postId}/comments`, 'POST', { body: '참고 https://example.com/guide' });
    equal(ok.status, 201, 'a 댓글 with an ordinary address is saved');
    refused(await D.call('comments/' + ok.data.id, 'PATCH', { body: `www.blocked-${run}.example` }), 400, '등록할 수 없는 링크가 있습니다.', 'an edit adding a blocked domain → 400');
    const shown = (await comments(guest, postId)).find(c => c.id === ok.data.id);
    check(shown && !('cards' in shown) && !('link_cards' in shown), 'a 댓글 carries no link previews');
} finally { await manager('manage/links', 'PUT', { domains: '' }); }

// 10. 내 거래 '댓글'.
const mine = (await D.call('me/comments?page=1')).data;
check(mine.comments.length > 0 && mine.comments.every(c => typeof c.title === 'string' && c.post_id) && mine.comments[0].created_at >= mine.comments[mine.comments.length - 1].created_at, "내 거래 '댓글' lists D's 댓글 newest first with post titles");
check(!mine.comments.some(c => c.post_id === counted.data.id), 'a post hidden from D is left out');
for (let i = 0; i < 20; i++) await manager(`posts/${spam.data.id}/comments`, 'POST', { body: '페이지 ' + i });
const page1 = (await manager('me/comments?page=1')).data, page2 = (await manager('me/comments?page=2')).data;
equal([page1.comments.length, page1.hasMore, page2.page], [20, true, 2], "내 거래 '댓글' pages by 20 with '더 보기'");

// 11. Deleting the post removes its 댓글.
equal((await A.call('posts/' + postId, 'DELETE')).status, 200, 'A deletes the post');
equal((await guest(`posts/${postId}/comments`)).status, 404, 'GET comments of a deleted post → 404');
equal(sql(`SELECT COUNT(*) AS n FROM comments WHERE post_id=${postId}`)[0].n, 0, 'the comment rows are gone');

console.log(`PASS comments (${checks} checks)`);
