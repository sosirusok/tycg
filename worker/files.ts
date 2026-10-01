import { db, fail, currentUser, requireUser, json, limit } from './http';
import { SITE_RULES } from '../shared/membership';
import { putPhoto, getPhoto, deletePhoto, photoLimit, photoLimitText, storageMode, D1_USER_BYTES, D1_SITE_BYTES } from './storage';

// Upload rows one member may hold: every open post full of photos.
const UPLOAD_ROWS = SITE_RULES.openPosts * SITE_RULES.photosPerPost;

// A photo is "in use" while a post, a chat message or one of the owner's drafts references it.
export const unused = "NOT EXISTS(SELECT 1 FROM post_images pi WHERE pi.upload_id=uploads.id) AND NOT EXISTS(SELECT 1 FROM message_images mi WHERE mi.upload_id=uploads.id) AND NOT EXISTS(SELECT 1 FROM drafts d,json_each(d.content,'$.images') j WHERE d.user_id=uploads.owner_id AND j.value=uploads.id)";

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
        // Anti-flood only, the same for every member (SITE_RULES): 120 per 10 minutes, 300 per day.
        await limit('upload:' + u.id, SITE_RULES.uploadsPer10Min, 600000);
        await limit('upload-day:' + u.id, SITE_RULES.uploadsPerDay, 86400000);
        const storage = storageMode();
        // Photos that no post, chat or draft uses are removed a day after upload (see cleanup.ts).
        const mine = await db().prepare("SELECT COUNT(*) AS n,COALESCE(SUM(CASE WHEN storage='d1' THEN size ELSE 0 END),0) AS d1 FROM uploads WHERE owner_id=?").bind(u.id).first<any>();
        // A row ceiling far above any real use (every open post full of photos); storage size is the real limit.
        if (mine.n >= UPLOAD_ROWS) fail(409, '사진 업로드 한도를 넘었습니다. 안 쓰는 사진은 하루 뒤 정리됩니다.');
        const bytes = await readBody(req, photoLimit());
        const mime = sniff(bytes);
        if (!mime) fail(400, 'JPG, PNG, WebP 사진을 선택해 주세요.');
        if (storage === 'd1') {
            // Without R2, photos share the database's 500 MB, so each member and the whole site have a budget.
            if (mine.d1 + bytes.byteLength > D1_USER_BYTES) fail(409, '사진 용량(1인 30MB)을 넘었습니다. 안 쓰는 사진은 하루 뒤 정리됩니다.');
            const site = await db().prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM uploads WHERE storage='d1'").first<any>();
            if (site.bytes + bytes.byteLength > D1_SITE_BYTES) fail(507, '사이트의 사진 저장 공간이 가득 찼습니다. 매니저에게 알려 주세요.');
        }
        const id = crypto.randomUUID();
        await db().prepare('INSERT INTO uploads(id,owner_id,mime,size,storage,created_at) VALUES(?,?,?,?,?,?)').bind(id, u.id, mime, bytes.byteLength, storage, Date.now()).run();
        try { await putPhoto(id, bytes, mime, storage); }
        catch (e) { await db().prepare('DELETE FROM uploads WHERE id=?').bind(id).run(); throw e; }
        return json({ id }, 201);
    }
    if (p[0] === 'images' && p[1] && method === 'GET') {
        const m = await db().prepare('SELECT * FROM uploads WHERE id=?').bind(p[1]).first<any>();
        if (!m) fail(404, '사진을 찾을 수 없습니다.');
        const publicImage = await db().prepare('SELECT 1 FROM post_images pi JOIN posts p ON p.id=pi.post_id WHERE pi.upload_id=? AND p.hidden=0 LIMIT 1').bind(p[1]).first();
        if (!publicImage) {
            const u = await currentUser(req);
            const allowed = u && (u.id === m.owner_id || u.role === 'manager' || await db().prepare('SELECT 1 FROM message_images mi JOIN messages msg ON msg.id=mi.message_id JOIN conversations c ON c.id=msg.conversation_id WHERE mi.upload_id=? AND (c.user_a=? OR c.user_b=?) LIMIT 1').bind(p[1], u.id, u.id).first());
            if (!allowed) fail(404, '사진을 찾을 수 없습니다.');
        }
        const data = await getPhoto(p[1], m.storage);
        if (!data) fail(404, '사진을 찾을 수 없습니다.');
        // A photo id never changes content. Public photos may be kept by the browser for a day.
        return new Response(data, { headers: { 'Content-Type': m.mime, 'Cache-Control': publicImage ? 'private, max-age=86400' : 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    return null;
}
