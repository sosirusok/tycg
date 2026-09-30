import { db, requireUser, requireManager, json, body, textField, memberColumns, withMember } from './http';
import { decorate, postSelect } from './posts';
import { manageMembers } from './membership';

export async function manageHandler(req: Request, p: string[], url: URL): Promise<Response | null> {
    const method = req.method, u = await requireUser(req);
    requireManager(u);
    if (!p[1] && method === 'GET') {
        const r = await db().batch([
            db().prepare(`SELECT r.*,p.title,p.hidden,u.nickname,${memberColumns('u')} FROM reports r LEFT JOIN posts p ON p.id=r.post_id JOIN users u ON u.id=r.reporter_id ORDER BY r.created_at DESC LIMIT 100`),
            db().prepare(postSelect + ' WHERE p.hidden=1 ORDER BY p.updated_at DESC LIMIT 100'),
            db().prepare("SELECT COUNT(*) AS n FROM applications WHERE status='pending'"),
        ]);
        return json({ reports: r[0].results.map(row => withMember(row as any)), hidden: await decorate(r[1].results, u.id), pendingApplications: (r[2].results[0] as any).n });
    }
    if (p[1] === 'visibility' && method === 'POST') {
        const b = await body(req);
        await db().batch([
            db().prepare('UPDATE posts SET hidden=?,updated_at=? WHERE id=?').bind(b.hidden ? 1 : 0, Date.now(), b.postId),
            db().prepare("UPDATE offers SET status='cancelled',updated_at=? WHERE post_id=? AND status IN('pending','accepted') AND ?=1").bind(Date.now(), b.postId, b.hidden ? 1 : 0),
        ]);
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
