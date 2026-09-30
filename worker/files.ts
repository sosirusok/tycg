import { db, fail, currentUser, requireUser, json, limit } from './http';
import { putPhoto, getPhoto, deletePhoto, photoLimit, photoLimitText, storageMode } from './storage';

// A photo is "in use" while a post, a draft or a chat message references it.
const unused = "NOT EXISTS(SELECT 1 FROM posts p,json_each(p.images) j WHERE j.value=uploads.id) AND NOT EXISTS(SELECT 1 FROM drafts d,json_each(d.content,'$.images') j WHERE j.value=uploads.id) AND NOT EXISTS(SELECT 1 FROM messages m,json_each(m.attachments) j WHERE j.value=uploads.id)";

function sniff(bytes: Uint8Array) {
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
    const text = (a: number, b: number) => new TextDecoder().decode(bytes.slice(a, b));
    if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
    return '';
}

async function readBody(req: Request, max: number) {
    const declared = Number(req.headers.get('content-length'));
    const tooLarge = () => fail(413, `사진 한 장은 ${photoLimitText()} 이하여야 합니다.`);
    if (declared > max) tooLarge();
    const reader = req.body?.getReader();
    if (!reader) fail(400, '사진이 없습니다.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) { await reader.cancel(); tooLarge(); }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.length; }
    return bytes;
}

export async function filesHandler(req: Request, p: string[]): Promise<Response | null> {
    const method = req.method;
    if (p[0] === 'uploads' && !p[1] && method === 'GET') {
        const u = await requireUser(req);
        const r = await db().prepare(`SELECT id,size,created_at FROM uploads WHERE owner_id=? AND ${unused} ORDER BY created_at DESC LIMIT 600`).bind(u.id).all();
        return json({ uploads: r.results });
    }
    if (p[0] === 'uploads' && p[1] && method === 'DELETE') {
        const u = await requireUser(req);
        const r = await db().prepare(`SELECT id,storage FROM uploads WHERE id=? AND owner_id=? AND ${unused}`).bind(p[1], u.id).first<any>();
        if (!r) fail(409, '사용 중이거나 삭제 권한이 없는 사진입니다.');
        await deletePhoto(r.id, r.storage);
        await db().prepare('DELETE FROM uploads WHERE id=?').bind(r.id).run();
        return json({ ok: true });
    }
    if (p[0] === 'uploads' && !p[1] && method === 'POST') {
        const u = await requireUser(req);
        await limit('upload:' + u.id, 30, 600000);
        const count = await db().prepare('SELECT COUNT(*) AS n FROM uploads WHERE owner_id=?').bind(u.id).first<any>();
        if (count.n >= 600) fail(409, '업로드 한도에 도달했습니다. 사용하지 않는 사진을 정리해 주세요.');
        const bytes = await readBody(req, photoLimit());
        const mime = sniff(bytes);
        if (!mime) fail(400, 'JPG, PNG, WebP 사진을 선택해 주세요.');
        const id = crypto.randomUUID(), storage = storageMode();
        await db().prepare('INSERT INTO uploads(id,owner_id,mime,size,storage,created_at) VALUES(?,?,?,?,?,?)').bind(id, u.id, mime, bytes.byteLength, storage, Date.now()).run();
        try { await putPhoto(id, bytes, mime, storage); }
        catch (e) { await db().prepare('DELETE FROM uploads WHERE id=?').bind(id).run(); throw e; }
        return json({ id }, 201);
    }
    if (p[0] === 'images' && p[1] && method === 'GET') {
        const m = await db().prepare('SELECT * FROM uploads WHERE id=?').bind(p[1]).first<any>();
        if (!m) fail(404, '사진을 찾을 수 없습니다.');
        const publicImage = await db().prepare('SELECT 1 FROM posts p,json_each(p.images) j WHERE j.value=? AND p.hidden=0 LIMIT 1').bind(p[1]).first();
        if (!publicImage) {
            const u = await currentUser(req);
            const allowed = u && (u.id === m.owner_id || u.role === 'manager' || await db().prepare('SELECT 1 FROM messages msg JOIN conversations c ON c.id=msg.conversation_id,json_each(msg.attachments) j WHERE j.value=? AND (c.user_a=? OR c.user_b=?) LIMIT 1').bind(p[1], u.id, u.id).first());
            if (!allowed) fail(404, '사진을 찾을 수 없습니다.');
        }
        const data = await getPhoto(p[1], m.storage);
        if (!data) fail(404, '사진을 찾을 수 없습니다.');
        return new Response(data, { headers: { 'Content-Type': m.mime, 'Cache-Control': publicImage ? 'private, max-age=600' : 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    return null;
}
