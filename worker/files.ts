import { db, fail, currentUser, requireUser, json, limit, body } from './http';
import { SITE_RULES } from '../shared/membership';
import { putPhoto, getPhoto, deletePhoto, photoLimit, photoLimitText, storageMode, D1_USER_BYTES, D1_SITE_BYTES, R2_USER_BYTES } from './storage';

// Upload rows one member may hold: every open post full of photos. Bytes are the real limit
// (R2_USER_BYTES, or D1_USER_BYTES without R2).
const UPLOAD_ROWS = SITE_RULES.openPosts * SITE_RULES.photosPerPost;

// A photo is "in use" while a post, a chat message or one of the owner's drafts references it.
export const unused = "NOT EXISTS(SELECT 1 FROM post_images pi WHERE pi.upload_id=uploads.id) AND NOT EXISTS(SELECT 1 FROM message_images mi WHERE mi.upload_id=uploads.id) AND NOT EXISTS(SELECT 1 FROM drafts d,json_each(d.content,'$.images') j WHERE d.user_id=uploads.owner_id AND j.value=uploads.id)";

const HEX64 = /^[0-9a-f]{64}$/;

// The author's open posts that use these uploads ('‘제목’ 글에 있는 사진입니다.' in the editor), with
// how many photos each post has.
type UsedRow = { upload_id: string; id: number; title: string; photos: number };
function usedInStatement(ownerId: string, uploadsSql: string, args: unknown[]) {
    return db().prepare(`SELECT pi.upload_id,p.id,p.title,json_array_length(p.images) AS photos FROM post_images pi JOIN posts p ON p.id=pi.post_id
        WHERE pi.upload_id IN (${uploadsSql}) AND p.author_id=? AND p.status!='closed' LIMIT 200`).bind(...args, ownerId);
}
function usedInMap(rows: UsedRow[]) {
    const out: Record<string, { id: number; title: string; photos: number }[]> = {};
    for (const r of rows) (out[r.upload_id] ||= []).push({ id: r.id, title: r.title, photos: Number(r.photos) || 0 });
    return out;
}

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
    // The member's own photos with one of these hashes (the browser's SHA-256 of the original files it
    // was given, WP44): {found: {hash: upload id}, usedIn: {upload id: posts}}. Matched files are neither
    // compressed nor uploaded again, and the match counts as a use for the unused-photo cleanup.
    if (p[0] === 'uploads' && p[1] === 'lookup' && !p[2] && method === 'POST') {
        const u = await requireUser(req), b = await body(req);
        const hashes = Array.isArray(b.hashes) ? [...new Set(b.hashes.filter((h: unknown): h is string => typeof h === 'string' && HEX64.test(h)))].slice(0, 100) : [];
        if (!hashes.length) return json({ found: {}, usedIn: {} });
        const list = JSON.stringify(hashes), now = Date.now();
        const mine = 'owner_id=? AND (src_hash IN (SELECT value FROM json_each(?)) OR hash IN (SELECT value FROM json_each(?)))';
        const [touched, used] = await db().batch([
            db().prepare(`UPDATE uploads SET touched_at=? WHERE ${mine} RETURNING id,hash,src_hash`).bind(now, u.id, list, list),
            usedInStatement(u.id, `SELECT id FROM uploads WHERE ${mine}`, [u.id, list, list]),
        ]);
        const found: Record<string, string> = {};
        for (const r of touched.results as { id: string; hash: string | null; src_hash: string | null }[]) {
            for (const h of [r.src_hash, r.hash]) if (h && hashes.includes(h) && !found[h]) found[h] = r.id;
        }
        return json({ found, usedIn: usedInMap(used.results as UsedRow[]) });
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
        // users.upload_rows and upload_bytes are kept by triggers on uploads (0018_upload_totals), so this
        // reads one row instead of every upload the member holds. The manager has only the site limits.
        const mine = await db().prepare('SELECT upload_rows AS n,upload_bytes AS bytes FROM users WHERE id=?').bind(u.id).first<{ n: number; bytes: number }>();
        const member = u.role !== 'manager';
        // A row ceiling far above any real use (every open post full of photos); storage size is the real limit.
        if (member && mine && mine.n >= UPLOAD_ROWS) fail(409, '사진 업로드 한도를 넘었습니다. 안 쓰는 사진은 하루 뒤 정리됩니다.');
        const bytes = await readBody(req, photoLimit());
        const mime = sniff(bytes);
        if (!mime) fail(400, 'JPG, PNG, WebP 사진을 선택해 주세요.');
        if (storage === 'r2' && member && mine && mine.bytes + bytes.byteLength > R2_USER_BYTES) fail(409, '사진 용량(1인 1GB)을 넘었습니다. 안 쓰는 사진은 하루 뒤 정리됩니다.');
        if (storage === 'd1') {
            // Without R2, photos share the database's 500 MB, so each member and the whole site have a budget.
            // Only in this mode is the member's D1 sum read (it stays small: 30MB of photos at most).
            const d1 = member ? await db().prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM uploads WHERE owner_id=? AND storage='d1'").bind(u.id).first<{ bytes: number }>() : null;
            if (d1 && d1.bytes + bytes.byteLength > D1_USER_BYTES) fail(409, '사진 용량(1인 30MB)을 넘었습니다. 안 쓰는 사진은 하루 뒤 정리됩니다.');
            const site = await db().prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM uploads WHERE storage='d1'").first<any>();
            if (site.bytes + bytes.byteLength > D1_SITE_BYTES) fail(507, '사이트의 사진 저장 공간이 가득 찼습니다. 매니저에게 알려 주세요.');
        }
        // X-Photo-Hash '<compressed>,<original>' (SHA-256 hex, computed by the browser) is advisory: a
        // malformed header is ignored. The same original again returns the stored photo (reused) with no
        // storage write; the unique index on (owner, original) decides between parallel uploads.
        const header = /^([0-9a-f]{64}),([0-9a-f]{64})$/.exec(req.headers.get('X-Photo-Hash') || '');
        const id = crypto.randomUUID(), now = Date.now();
        const inserted = await db().prepare(`INSERT INTO uploads(id,owner_id,mime,size,storage,created_at,hash,src_hash) VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(owner_id,src_hash) WHERE src_hash IS NOT NULL DO NOTHING`).bind(id, u.id, mime, bytes.byteLength, storage, now, header?.[1] ?? null, header?.[2] ?? null).run();
        if (!inserted.meta.changes) {
            const [prev, used] = await db().batch([
                db().prepare('UPDATE uploads SET touched_at=? WHERE owner_id=? AND src_hash=? RETURNING id').bind(now, u.id, header![2]),
                usedInStatement(u.id, 'SELECT id FROM uploads WHERE owner_id=? AND src_hash=?', [u.id, header![2]]),
            ]);
            const reused = (prev.results[0] as { id: string } | undefined)?.id;
            if (!reused) fail(409, '잠시 후 다시 시도해 주세요.');
            return json({ id: reused, reused: true, usedIn: usedInMap(used.results as UsedRow[])[reused] || [] }, 200);
        }
        try { await putPhoto(id, bytes, mime, storage); }
        catch (e) { await db().prepare('DELETE FROM uploads WHERE id=?').bind(id).run(); throw e; }
        return json({ id, usedIn: [] }, 201);
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
