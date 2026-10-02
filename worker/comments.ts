import { db, fail, currentUser, requireUser, requireActive, json, body, limit, textField, memberColumns, withMember, WITHDRAWN_NAME } from './http';
import { REPORT_REASONS, type User } from '../shared/market';
import { SITE_RULES, kstDayStart } from '../shared/membership';
import { visiblePost } from './posts';
import { unused } from './files';
import { notifyOne } from './notifications';
import { assertNoBlockedLinks } from './unfurl';

// 댓글·답글 (WP55), the same for every grade (Naver cafe parity): 3,000 characters and 1 photo each, one
// level of 답글, a '작성자' tag, 신고, and nothing from members blocked either way. Bodies are plain text;
// the app turns addresses into links (자동 링크, no previews) and a blocked domain refuses the save.
// Comments stay open on a completed post (questions about a past sale).

export const COMMENT_MAX = 3000;
export const COMMENT_PAGE = 50;
export const MY_COMMENTS_PAGE = 20;
export const COMMENTS_PER_DAY = SITE_RULES.commentsPerDay;
export const COMMENT_TEXT = {
    empty: '댓글 내용을 입력해 주세요.',
    tooLong: '댓글은 3,000자까지입니다.',
    nested: '답글에는 답글을 달 수 없습니다.',
    reported: '이미 신고한 댓글입니다.',
    daily: `도배 방지: 오늘 댓글은 ${COMMENTS_PER_DAY}개까지입니다.`,
    notFound: '댓글을 찾을 수 없습니다.',
    blocked: '차단된 회원입니다.',
    photo: '올릴 수 없는 사진입니다. 다시 선택해 주세요.',
} as const;

function commentBody(v: unknown) {
    const text = typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : '';
    if (!text) fail(400, COMMENT_TEXT.empty);
    if (text.length > COMMENT_MAX) fail(400, COMMENT_TEXT.tooLong);
    return text;
}

type Row = {
    id: number; post_id: number; parent_id: number | null; author_id: string; body: string; image_id: string | null; created_at: number; updated_at: number | null; deleted_at: number | null;
    nickname: string; role: string; author_deleted_at: number | null; grade_info: string | null; badges_json: string | null;
};
const ROW_SQL = `SELECT c.id,c.post_id,c.parent_id,c.author_id,c.body,c.image_id,c.created_at,c.updated_at,c.deleted_at,u.nickname,u.role,u.deleted_at AS author_deleted_at,${memberColumns('u')}
    FROM comments c JOIN users u ON u.id=c.author_id`;
// Leaves out comments by members the viewer blocked or who blocked the viewer (bind the viewer twice).
const NOT_BLOCKED = 'NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.target_id=c.author_id) OR (b.user_id=c.author_id AND b.target_id=?))';

// One row on screen. A deleted 댓글 (kept for its 답글) shows only its place: no author, body or photo.
function shown(r: Row, postAuthor: string) {
    if (r.deleted_at !== null) return { id: r.id, parent_id: r.parent_id, deleted: true, created_at: r.created_at };
    const m = withMember(r as Row & Record<string, any>) as Record<string, any>;
    const left = !!r.author_deleted_at;
    return {
        id: r.id, parent_id: r.parent_id, body: r.body, image: r.image_id, created_at: r.created_at, edited: r.updated_at !== null,
        author_id: r.author_id, nickname: left ? WITHDRAWN_NAME : r.nickname, role: r.role, author_deleted: left,
        author_grade: left ? 'normal' : m.grade, author_grade_trial: left ? false : m.grade_trial, author_badges: left ? [] : m.badges,
        is_post_author: r.author_id === postAuthor, deleted: false,
    };
}

// GET posts/:id/comments?page=1: 50 top-level 댓글 a page in 등록순, each followed by its 답글.
async function listComments(req: Request, postId: string, url: URL) {
    const u = await currentUser(req), post = await visiblePost(postId, u);
    const page = Number(url.searchParams.get('page') || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) fail(400, '페이지를 확인해 주세요.');
    const viewer = u?.id || '';
    const filter = u ? ' AND ' + NOT_BLOCKED : '', args = u ? [viewer, viewer] : [];
    const top = `SELECT c.id FROM comments c WHERE c.post_id=? AND c.parent_id IS NULL${filter} ORDER BY c.id LIMIT ? OFFSET ?`;
    const topArgs = [post.id, ...args, COMMENT_PAGE + 1, (page - 1) * COMMENT_PAGE];
    const [parents, replies] = await db().batch([
        db().prepare(`${ROW_SQL} WHERE c.id IN (${top}) ORDER BY c.id`).bind(...topArgs),
        db().prepare(`${ROW_SQL} WHERE c.parent_id IN (SELECT id FROM (${top}) LIMIT ?) AND c.post_id=?${filter} ORDER BY c.id`).bind(...topArgs, COMMENT_PAGE, post.id, ...args),
    ]);
    const rows = parents.results as Row[], hasMore = rows.length > COMMENT_PAGE;
    const byParent = new Map<number, Row[]>();
    for (const r of replies.results as Row[]) byParent.set(r.parent_id!, [...byParent.get(r.parent_id!) || [], r]);
    const comments = [];
    for (const r of rows.slice(0, COMMENT_PAGE)) {
        const kids = byParent.get(r.id) || [];
        // A deleted 댓글 whose 답글 are all hidden from this viewer is left out.
        if (r.deleted_at !== null && !kids.length) continue;
        comments.push(shown(r, post.author_id), ...kids.map(k => shown(k, post.author_id)));
    }
    return json({ comments, hasMore, page, count: Number(post.comment_count) || 0 });
}

// POST posts/:id/comments {body, parentId?, imageId?}.
async function addComment(req: Request, postId: string) {
    const u = await requireUser(req);
    requireActive(u);
    const manager = u.role === 'manager';
    if (!manager) await limit('comment:' + u.id, SITE_RULES.commentsPer10Min, 600000);
    const post = await visiblePost(postId, u);
    // A hidden post (the author and the manager still open it) takes no new 댓글, except from the manager.
    if (post.hidden && !manager) fail(404, '게시글을 찾을 수 없습니다.');
    const b = await body(req), text = commentBody(b.body);
    const parentId = b.parentId === undefined || b.parentId === null ? null : b.parentId;
    if (parentId !== null && !Number.isSafeInteger(parentId)) fail(400, COMMENT_TEXT.notFound);
    const imageId = b.imageId === undefined || b.imageId === null || b.imageId === '' ? null : b.imageId;
    if (imageId !== null && (typeof imageId !== 'string' || imageId.length > 64)) fail(400, COMMENT_TEXT.photo);
    await assertNoBlockedLinks(req, text);
    const now = Date.now();
    const [parentRow, blockRow, photoRow, dayRow] = await db().batch([
        db().prepare('SELECT id,post_id,parent_id,author_id,deleted_at FROM comments WHERE id=?').bind(parentId ?? -1),
        db().prepare('SELECT 1 AS b FROM blocks WHERE (user_id=? AND target_id IN (?,(SELECT author_id FROM comments WHERE id=?))) OR (target_id=? AND user_id IN (?,(SELECT author_id FROM comments WHERE id=?))) LIMIT 1')
            .bind(u.id, post.author_id, parentId ?? -1, u.id, post.author_id, parentId ?? -1),
        db().prepare(`SELECT id FROM uploads WHERE id=? AND owner_id=? AND ${unused}`).bind(imageId ?? '', u.id),
        db().prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM comments WHERE author_id=? AND created_at>=? LIMIT ${COMMENTS_PER_DAY})`).bind(u.id, kstDayStart(now)),
    ]);
    const parent = parentRow.results[0] as { id: number; post_id: number; parent_id: number | null; author_id: string; deleted_at: number | null } | undefined;
    if (parentId !== null) {
        if (!parent || parent.post_id !== post.id || parent.deleted_at !== null) fail(404, COMMENT_TEXT.notFound);
        if (parent.parent_id !== null) fail(400, COMMENT_TEXT.nested);
    }
    if (blockRow.results.length && !manager) fail(403, COMMENT_TEXT.blocked);
    if (imageId !== null && !photoRow.results.length) fail(400, COMMENT_TEXT.photo);
    if (!manager && Number((dayRow.results[0] as { n: number }).n) >= COMMENTS_PER_DAY) fail(429, COMMENT_TEXT.daily);
    // The insert repeats the parent test, so a 댓글 deleted meanwhile takes no 답글.
    const parentOk = parentId === null ? '1' : 'EXISTS(SELECT 1 FROM comments p WHERE p.id=? AND p.post_id=? AND p.parent_id IS NULL AND p.deleted_at IS NULL)';
    const parentArgs = parentId === null ? [] : [parentId, post.id];
    const mine = '(SELECT id FROM comments WHERE author_id=? AND post_id=? AND created_at=? ORDER BY id DESC LIMIT 1)', mineArgs = [u.id, post.id, now];
    const landed = `EXISTS(SELECT 1 FROM comments WHERE id=${mine})`;
    // 알림 (WP50 notifyStatement): the post author hears of a new 댓글 or 답글 (one unread row per post), the
    // parent's author of a 답글 (one unread row per 댓글); never the writer, never across a block. The post
    // author who also wrote the parent gets the 답글 row only.
    const toAuthor = parentId === null || parent!.author_id !== post.author_id;
    const r = await db().batch([
        // The photo test is repeated too, so two 댓글 at once cannot share one photo.
        db().prepare(`INSERT INTO comments(post_id,author_id,parent_id,body,image_id,created_at) SELECT ?,?,?,?,?,? WHERE ${parentOk} AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM comments WHERE image_id=?))`)
            .bind(post.id, u.id, parentId, text, imageId, now, ...parentArgs, imageId, imageId),
        ...toAuthor ? [notifyOne('comment', post.author_id, String(post.id), post.id, u.id, `‘${post.title}’ 글 댓글 · ${u.nickname}`, now, landed, mineArgs)] : [],
        ...parentId !== null ? [notifyOne('reply', parent!.author_id, String(parentId), post.id, u.id, `내 댓글 답글 · ${u.nickname}`, now, landed, mineArgs)] : [],
        db().prepare('SELECT comment_count FROM posts WHERE id=?').bind(post.id),
    ]);
    if (!r[0].meta.changes) fail(404, COMMENT_TEXT.notFound);
    return json({ id: r[0].meta.last_row_id, count: Number((r[r.length - 1].results[0] as { comment_count: number } | undefined)?.comment_count) || 0 }, 201);
}

async function commentOf(id: string) {
    if (!/^\d{1,12}$/.test(id)) fail(404, COMMENT_TEXT.notFound);
    const c = await db().prepare('SELECT c.id,c.post_id,c.parent_id,c.author_id,c.deleted_at,p.author_id AS post_author_id,p.hidden FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.id=?').bind(id)
        .first<{ id: number; post_id: number; parent_id: number | null; author_id: string; deleted_at: number | null; post_author_id: string; hidden: number }>();
    if (!c || c.deleted_at !== null) fail(404, COMMENT_TEXT.notFound);
    return c;
}

// PATCH comments/:id {body} (the author only) and DELETE comments/:id (the author, the post's author or
// the manager). A 댓글 with 답글 is cleared and kept as '삭제된 댓글입니다.'; any other row goes, and a
// cleared 댓글 whose last 답글 goes is removed with it. posts.comment_count follows by trigger.
export async function commentsHandler(req: Request, p: string[]): Promise<Response | null> {
    const method = req.method;
    if (!p[1] || p[2]) return null;
    if (method === 'PATCH') {
        const u = await requireUser(req);
        requireActive(u);
        const c = await commentOf(p[1]);
        if (c.author_id !== u.id) fail(403, '권한이 없습니다.');
        if (c.hidden && u.role !== 'manager') fail(404, COMMENT_TEXT.notFound);
        const text = commentBody((await body(req)).body);
        await assertNoBlockedLinks(req, text);
        await db().prepare('UPDATE comments SET body=?,updated_at=? WHERE id=? AND deleted_at IS NULL').bind(text, Date.now(), c.id).run();
        return json({ ok: true });
    }
    if (method === 'DELETE') {
        const u = await requireUser(req);
        const c = await commentOf(p[1]);
        if (c.author_id !== u.id && c.post_author_id !== u.id && u.role !== 'manager') fail(403, '권한이 없습니다.');
        const hasReplies = 'EXISTS(SELECT 1 FROM comments r WHERE r.parent_id=comments.id)';
        const r = await db().batch([
            db().prepare(`UPDATE comments SET deleted_at=?,body='',image_id=NULL WHERE id=? AND deleted_at IS NULL AND ${hasReplies}`).bind(Date.now(), c.id),
            db().prepare(`DELETE FROM comments WHERE id=? AND NOT ${hasReplies}`).bind(c.id),
            ...c.parent_id !== null ? [db().prepare(`DELETE FROM comments WHERE id=? AND deleted_at IS NOT NULL AND NOT ${hasReplies}`).bind(c.parent_id)] : [],
            db().prepare('SELECT comment_count FROM posts WHERE id=?').bind(c.post_id),
        ]);
        return json({ ok: true, count: Number((r[r.length - 1].results[0] as { comment_count: number } | undefined)?.comment_count) || 0 });
    }
    return null;
}

// posts/:id/comments.
export async function postCommentsHandler(req: Request, p: string[], url: URL): Promise<Response | null> {
    if (!p[1] || p[3]) return null;
    if (req.method === 'GET') return listComments(req, p[1], url);
    if (req.method === 'POST') return addComment(req, p[1]);
    return null;
}

// GET me/comments?page=1: the member's own 댓글 and 답글, newest first, 20 a page, each with its post's
// title (only posts the member can still open).
export async function myComments(req: Request, url: URL) {
    const u = await requireUser(req);
    const page = Number(url.searchParams.get('page') || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 500) fail(400, '페이지를 확인해 주세요.');
    const r = await db().prepare(`SELECT c.id,c.post_id,c.parent_id,c.body,c.image_id,c.created_at,p.title FROM comments c JOIN posts p ON p.id=c.post_id
        WHERE c.author_id=? AND c.deleted_at IS NULL AND (p.hidden=0 OR p.author_id=? OR ?) ORDER BY c.created_at DESC,c.id DESC LIMIT ? OFFSET ?`)
        .bind(u.id, u.id, u.role === 'manager' ? 1 : 0, MY_COMMENTS_PAGE + 1, (page - 1) * MY_COMMENTS_PAGE).all<{ id: number; post_id: number; parent_id: number | null; body: string; image_id: string | null; created_at: number; title: string }>();
    return json({
        comments: r.results.slice(0, MY_COMMENTS_PAGE).map(c => ({ id: c.id, post_id: c.post_id, title: c.title, body: c.body, image: c.image_id, reply: c.parent_id !== null, created_at: c.created_at })),
        hasMore: r.results.length > MY_COMMENTS_PAGE, page,
    });
}

// POST reports {commentId, reason, details}: the post reasons; one waiting report per reporter and
// 댓글 (409 '이미 신고한 댓글입니다.'). The comment's text is kept with the report for the manager.
export async function reportComment(u: User, b: any) {
    if (!Number.isSafeInteger(b.commentId)) fail(404, COMMENT_TEXT.notFound);
    const c = await commentOf(String(b.commentId));
    // The reporter must be able to open the post and see the comment.
    await visiblePost(c.post_id, u);
    if (c.author_id === u.id) fail(400, '내 댓글은 신고할 수 없습니다.');
    if (!(REPORT_REASONS as readonly unknown[]).includes(b.reason)) fail(400, '신고 사유를 확인해 주세요.');
    const details = textField(b.details, 1, 1000, '신고 설명');
    // The duplicate check is repeated inside the insert, so two taps at once file one report.
    const r = await db().prepare(`INSERT INTO reports(post_id,comment_id,comment_body,reporter_id,reason,details,created_at)
        SELECT c.post_id,c.id,c.body,?,?,?,? FROM comments c WHERE c.id=? AND c.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM reports WHERE comment_id=c.id AND reporter_id=? AND status='pending')`)
        .bind(u.id, b.reason, details, Date.now(), c.id, u.id).run();
    if (!r.meta.changes) fail(409, COMMENT_TEXT.reported);
    return json({ ok: true }, 201);
}
