import { db, fail, requireUser, requireManager, json, body, textField, memberColumns, withMember, MANAGER_ID } from './http';
import { REPORT_REASONS } from '../shared/market';
import { decorate, endOffersStatements, postSelect } from './posts';
import { ensureChat, messageStatements } from './chat';
import { manageMembers } from './membership';

// Every /api/manage/* route is manager-only: requireManager (role 'manager') runs before any
// route below or in manageMembers. There is no moderator role, and a member's grade, including
// 관리자, grants no access here.
export async function manageHandler(req: Request, p: string[], url: URL): Promise<Response | null> {
    const method = req.method, u = await requireUser(req);
    requireManager(u);
    if (!p[1] && method === 'GET') {
        const r = await db().batch([
            db().prepare(`SELECT r.*,p.title,p.hidden,u.nickname,${memberColumns('u')} FROM reports r LEFT JOIN posts p ON p.id=r.post_id JOIN users u ON u.id=r.reporter_id ORDER BY r.created_at DESC LIMIT 100`),
            // Posts hidden by 회원 탈퇴 are not moderation work, so they stay out of 숨긴 글.
            db().prepare(postSelect + " WHERE p.hidden=1 AND p.hidden_reason!='탈퇴' ORDER BY p.updated_at DESC LIMIT 100"),
            db().prepare("SELECT COUNT(*) AS n FROM applications WHERE status='pending'"),
        ]);
        return json({ reports: r[0].results.map(row => withMember(row as any)), hidden: await decorate(r[1].results, u), pendingApplications: (r[2].results[0] as any).n });
    }
    // Hiding keeps updated_at, stores an optional report reason for the author, and ends the post's
    // open offers. Unhiding clears the reason.
    if (p[1] === 'visibility' && method === 'POST') {
        const b = await body(req), hidden = b.hidden ? 1 : 0, reason = hidden && typeof b.reason === 'string' ? b.reason : '';
        if (reason && !(REPORT_REASONS as readonly string[]).includes(reason)) fail(400, '숨김 사유를 확인해 주세요.');
        if (typeof b.postId !== 'number' && typeof b.postId !== 'string') fail(404, '게시글을 찾을 수 없습니다.');
        const post = await db().prepare('SELECT p.id,p.author_id,p.title,p.hidden,p.hidden_reason,u.deleted_at FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=?').bind(b.postId).first<any>();
        if (!post) fail(404, '게시글을 찾을 수 없습니다.');
        // A post hidden by 회원 탈퇴 stays hidden, and its '탈퇴' reason is never overwritten.
        if (post.deleted_at || post.hidden_reason === '탈퇴') fail(409, '탈퇴한 회원의 글입니다.');
        const now = Date.now();
        await db().batch([
            db().prepare('UPDATE posts SET hidden=?,hidden_reason=? WHERE id=?').bind(hidden, reason, post.id),
            ...hidden ? endOffersStatements(post.id, post.author_id, "status IN('pending','accepted')", [], now) : [],
        ]);
        // The author hears about it in their chat with the manager. Best-effort: the author may have
        // blocked the manager (ensureChat then throws 403), and a failed notice never undoes the change.
        if (post.author_id !== MANAGER_ID && post.hidden !== hidden) {
            const text = hidden ? `‘${post.title}’ 글이 숨김 처리되었습니다.${reason ? ' 사유: ' + reason : ''}` : `‘${post.title}’ 글이 다시 공개되었습니다.`;
            try { await db().batch(messageStatements(await ensureChat(MANAGER_ID, post.author_id), MANAGER_ID, text, 'system')); }
            catch (e) { console.warn('Hide notice not sent', e instanceof Error ? e.message : 'unknown'); }
        }
        return json({ ok: true });
    }
    if (p[1] === 'report' && method === 'POST') {
        const b = await body(req);
        await db().prepare('UPDATE reports SET status=? WHERE id=?').bind(b.status === 'pending' ? 'pending' : 'resolved', b.id).run();
        return json({ ok: true });
    }
    if (p[1] === 'notice') {
        if (method === 'DELETE' && p[2]) {
            await db().prepare('DELETE FROM notices WHERE id=?').bind(p[2]).run();
            return json({ ok: true });
        }
        if (method === 'POST' || method === 'PUT') {
            const b = await body(req), title = textField(b.title, 2, 100, '공지 제목'), content = textField(b.body, 1, 10000, '공지 내용');
            if (method === 'PUT' && p[2]) await db().prepare('UPDATE notices SET title=?,body=?,updated_at=? WHERE id=?').bind(title, content, Date.now(), p[2]).run();
            else await db().prepare('INSERT INTO notices(title,body,created_at,updated_at) VALUES(?,?,?,?)').bind(title, content, Date.now(), Date.now()).run();
            return json({ ok: true });
        }
    }
    return manageMembers(req, u, p, url);
}
