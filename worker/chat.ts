import { db, fail, requireUser, json, body, limit, memberColumns, withMember } from './http';
import { parse, visiblePost } from './posts';

export async function blocked(a: string, b: string) {
    return !!await db().prepare('SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)').bind(a, b, b, a).first();
}

export async function chatMember(id: string, uid: string) {
    const c = await db().prepare('SELECT * FROM conversations WHERE id=? AND (user_a=? OR user_b=?)').bind(id, uid, uid).first<any>();
    if (!c) fail(404, '대화를 찾을 수 없습니다.');
    return c;
}

export async function ensureChat(a: string, b: string) {
    if (a === b) fail(400, '다른 회원과 대화할 수 있습니다.');
    if (!await db().prepare('SELECT id FROM users WHERE id=?').bind(b).first()) fail(404, '회원을 찾을 수 없습니다.');
    if (await blocked(a, b)) fail(403, '차단된 회원과는 대화하거나 제안할 수 없습니다.');
    const pair = [a, b].sort(), now = Date.now();
    await db().prepare('INSERT OR IGNORE INTO conversations(id,user_a,user_b,created_at,updated_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(), ...pair, now, now).run();
    return (await db().prepare('SELECT id FROM conversations WHERE user_a=? AND user_b=?').bind(...pair).first<any>()).id as string;
}

// Inserts a message (and its photo links) and bumps the conversation in one transaction.
export function messageStatements(conversationId: string, senderId: string, text: string, type = 'text', referenceId: string | null = null, attachments: string[] = [], at = Date.now()) {
    return [
        db().prepare('INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) VALUES(?,?,?,?,?,?,?)').bind(conversationId, senderId, text, type, referenceId, JSON.stringify(attachments), at),
        ...attachments.length ? [db().prepare('INSERT OR IGNORE INTO message_images(message_id,upload_id) SELECT (SELECT MAX(id) FROM messages WHERE conversation_id=? AND sender_id=?),value FROM json_each(?)').bind(conversationId, senderId, JSON.stringify(attachments))] : [],
        db().prepare('UPDATE conversations SET updated_at=? WHERE id=?').bind(at, conversationId),
    ];
}

// A text-only message that is written only when `guard` (an SQL condition) holds when the batch runs.
export function guardedMessageStatements(conversationId: string, senderId: string, text: string, type: string, referenceId: string | null, guard: string, args: unknown[], at = Date.now()) {
    return [
        db().prepare(`INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) SELECT ?,?,?,?,?,'[]',? WHERE ${guard}`).bind(conversationId, senderId, text, type, referenceId, at, ...args),
        db().prepare(`UPDATE conversations SET updated_at=? WHERE id=? AND ${guard}`).bind(at, conversationId, ...args),
    ];
}

const preview = "(SELECT CASE WHEN m.body='' AND m.attachments!='[]' THEN '사진' ELSE m.body END FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1)";

// Partner details in chat lists; when a 6-month grade ends stays private.
function partner(row: any) {
    const m = withMember(row);
    delete m.grade_expires_at;
    return m;
}

export async function chatHandler(req: Request, p: string[], url: URL): Promise<Response | null> {
    const method = req.method, u = await requireUser(req);
    // Polled on every page for the header badge. It also returns the member's current
    // badges and grade so a grant shows up without reloading the page.
    if (p[1] === 'unread' && method === 'GET') {
        const r = await db().prepare('SELECT COUNT(*) AS n FROM conversations c JOIN messages m ON m.conversation_id=c.id AND m.sender_id!=? AND m.read_at IS NULL WHERE c.user_a=? OR c.user_b=?').bind(u.id, u.id, u.id).first<any>();
        return json({ unread: r?.n || 0, user: u });
    }
    if (!p[1] && method === 'GET') {
        const r = await db().prepare(`SELECT c.id,c.updated_at,u.id AS partner_id,u.nickname,u.role,${memberColumns('u')},${preview} AS last_message,
            (SELECT COUNT(*) FROM messages WHERE conversation_id=c.id AND sender_id!=? AND read_at IS NULL) AS unread,
            (SELECT COUNT(*) FROM applications a WHERE a.conversation_id=c.id AND a.status='pending') AS pending_applications
            FROM conversations c JOIN users u ON u.id=CASE WHEN c.user_a=? THEN c.user_b ELSE c.user_a END WHERE c.user_a=? OR c.user_b=? ORDER BY c.updated_at DESC LIMIT 100`)
            .bind(u.id, u.id, u.id, u.id).all();
        return json({ chats: r.results.map(partner) });
    }
    if (!p[1] && method === 'POST') {
        await limit('chat-new:' + u.id, 30, 60000);
        const b = await body(req);
        if (typeof b.userId !== 'string') fail(400, '회원을 확인해 주세요.');
        let post: any;
        if (b.postId) {
            post = await visiblePost(b.postId, u);
            if (post.author_id !== b.userId) fail(400, '게시글 작성자를 확인해 주세요.');
        }
        const id = await ensureChat(u.id, b.userId);
        if (post) {
            const exists = await db().prepare("SELECT id FROM messages WHERE conversation_id=? AND type='listing' AND reference_id=?").bind(id, String(post.id)).first();
            if (!exists) await db().batch(messageStatements(id, u.id, post.title, 'listing', String(post.id)));
        }
        return json({ id });
    }
    if (p[1] && !p[2] && method === 'GET') {
        const c = await chatMember(p[1], u.id), partnerId = c.user_a === u.id ? c.user_b : c.user_a;
        const other = await db().prepare(`SELECT u.id,u.nickname,u.role,u.created_at,${memberColumns('u')} FROM users u WHERE u.id=?`).bind(partnerId).first<any>();
        return json({ chat: { id: c.id, partner: other ? partner(other) : null, blocked: await blocked(c.user_a, c.user_b) } });
    }
    if (p[1] && p[2] === 'messages') {
        const c = await chatMember(p[1], u.id);
        if (method === 'GET') {
            const after = url.searchParams.has('after'), cursor = after ? (Number(url.searchParams.get('after')) || 0) : (Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER);
            const [r, seen, offers, applications] = await db().batch([
                db().prepare('SELECT id,sender_id,body,type,reference_id,attachments,created_at,read_at FROM messages WHERE conversation_id=? AND id' + (after ? '>' : '<') + '? ORDER BY id ' + (after ? 'ASC' : 'DESC') + ' LIMIT 100').bind(p[1], cursor),
                db().prepare('SELECT MAX(id) AS last_id FROM messages WHERE conversation_id=? AND sender_id=? AND read_at IS NOT NULL').bind(p[1], u.id),
                db().prepare('SELECT o.*,p.title FROM offers o JOIN posts p ON p.id=o.post_id WHERE o.conversation_id=?').bind(p[1]),
                db().prepare('SELECT a.*,u.nickname FROM applications a JOIN users u ON u.id=a.user_id WHERE a.conversation_id=? ORDER BY a.created_at').bind(p[1]),
            ]);
            const messages = r.results.map((m: any) => ({ ...m, attachments: parse(m.attachments, []) }));
            return json({
                messages: after ? messages : messages.reverse(), offers: offers.results, applications: applications.results,
                hasMore: r.results.length === 100, readThrough: (seen.results[0] as any)?.last_id || 0, blocked: await blocked(c.user_a, c.user_b),
            });
        }
        if (method === 'POST') {
            if (await blocked(c.user_a, c.user_b)) fail(403, '차단된 회원과는 메시지를 주고받을 수 없습니다.');
            await limit('message:' + u.id, 60, 60000);
            const b = await body(req);
            const images: unknown = b.images ?? [];
            if (!Array.isArray(images) || images.length > 6 || images.some(x => typeof x !== 'string') || new Set(images).size !== images.length) fail(400, '사진은 한 번에 6장까지 보낼 수 있습니다.');
            const text = typeof b.body === 'string' ? b.body.trim() : '';
            if (text.length > 2000) fail(400, '메시지는 2000자 이내로 입력해 주세요.');
            if (!text && !images.length) fail(400, '메시지를 입력해 주세요.');
            if (images.length) {
                const r = await db().prepare('SELECT id FROM uploads WHERE owner_id=? AND id IN(SELECT value FROM json_each(?))').bind(u.id, JSON.stringify(images)).all();
                if (r.results.length !== images.length) fail(403, '본인이 올린 사진만 보낼 수 있습니다.');
            }
            const r = await db().batch(messageStatements(p[1], u.id, text, 'text', null, images as string[]));
            return json({ id: r[0].meta.last_row_id }, 201);
        }
    }
    if (p[1] && p[2] === 'read' && method === 'POST') {
        await chatMember(p[1], u.id);
        const b = await body(req);
        if (!Number.isSafeInteger(b.lastId)) fail(400, '메시지 번호를 확인해 주세요.');
        await db().prepare('UPDATE messages SET read_at=? WHERE conversation_id=? AND sender_id!=? AND read_at IS NULL AND id<=?').bind(Date.now(), p[1], u.id, b.lastId).run();
        return json({ ok: true });
    }
    return null;
}
