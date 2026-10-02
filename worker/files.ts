import { Buffer } from 'node:buffer';
import { db, fail, currentUser, requireUser, json, limit, body, ApiError } from './http';
import type { User } from '../shared/market';
import { SITE_RULES, perksOf, walletOf } from '../shared/membership';
import {
    putPhoto, getPhoto, removeRowStatements, deleteR2Photo, photoLimit, photoLimitText, storageMode, dbSize, testDbBytes, testStorage, userLimit, userLimitText, utcDate, counterValue,
    D1_USER_BYTES, D1_SITE_BYTES, DB_PHOTO_STOP, KV_SITE_BYTES, R2_SITE_BYTES, R2_SITE_DAILY_UPLOADS, STORAGE_FULL, DAILY_FULL, type Storage,
} from './storage';

// Upload rows one member may hold: every open post full of photos. Bytes are the real limit
// (1GB on R2, 100MB on KV, 30MB on D1).
const UPLOAD_ROWS = SITE_RULES.openPosts * SITE_RULES.photosPerPost;

// A photo is "in use" while a post, a chat message, a 댓글 (WP55), one of the owner's drafts or a member's
// 프로필 사진 (WP59) references it.
export const unused = "NOT EXISTS(SELECT 1 FROM post_images pi WHERE pi.upload_id=uploads.id) AND NOT EXISTS(SELECT 1 FROM message_images mi WHERE mi.upload_id=uploads.id) AND NOT EXISTS(SELECT 1 FROM comments c WHERE c.image_id=uploads.id) AND NOT EXISTS(SELECT 1 FROM drafts d,json_each(d.content,'$.images') j WHERE d.user_id=uploads.owner_id AND j.value=uploads.id) AND NOT EXISTS(SELECT 1 FROM users av WHERE av.avatar_id=uploads.id)";

const HEX64 = /^[0-9a-f]{64}$/;

// The author's open posts that use these uploads ('‘제목’ 글에 있는 사진입니다.' in the editor), with
// how many photos each post has and when it can be bumped (bumpAt, null: now; the same rule as the 409
// 같은 매물 sheet: its own gap, its 새 글 우선 hour and the wallet refill).
type UsedRow = { upload_id: string; id: number; title: string; photos: number; bumped_at: number; created_at: number; bump_count: number; bump_tokens: number; bump_at: number };
function usedInStatement(ownerId: string, uploadsSql: string, args: unknown[]) {
    return db().prepare(`SELECT pi.upload_id,p.id,p.title,json_array_length(p.images) AS photos,p.bumped_at,p.created_at,p.bump_count,w.bump_tokens,w.bump_at
        FROM post_images pi JOIN posts p ON p.id=pi.post_id JOIN users w ON w.id=p.author_id
        WHERE pi.upload_id IN (${uploadsSql}) AND p.author_id=? AND p.status!='closed' LIMIT 200`).bind(...args, ownerId);
}
function usedInMap(rows: UsedRow[], u: User, now: number) {
    const perks = perksOf(u), out: Record<string, { id: number; title: string; photos: number; bumpAt: number | null }[]> = {};
    for (const r of rows) {
        const wallet = walletOf(r.bump_tokens, r.bump_at, perks, now);
        const gapEnd = (r.bump_count ? r.bumped_at : r.created_at) + perks.bumpGapMinutes * 60000;
        const t = Math.max(gapEnd, r.bumped_at > now ? r.bumped_at : 0, wallet.tokens < 1 && wallet.nextRefillAt ? wallet.nextRefillAt : 0);
        (out[r.upload_id] ||= []).push({ id: r.id, title: r.title, photos: Number(r.photos) || 0, bumpAt: t > now ? t : null });
    }
    return out;
}

function sniff(bytes: Uint8Array) {
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
    const text = (a: number, b: number) => new TextDecoder().decode(bytes.slice(a, b));
    if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
    return '';
}

async function readBody(req: Request, max: number, mode: Storage) {
    const declared = Number(req.headers.get('content-length'));
    const tooLarge = () => fail(413, `사진 한 장은 ${photoLimitText(mode)} 이하여야 합니다.`);
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

type Totals = Record<string, number>;
// Photos of a deleted post stay held (and counted) for 30 days (posts_delete_hold, 0022).
const fullUser = (mode: Storage) => `사진 용량(1인 ${userLimitText(mode)})을 넘었습니다. 안 쓰는 사진은 하루 뒤, 삭제한 글의 사진은 30일 뒤 정리됩니다.`;

// The D1 budgets: the member's 30MB (409, or 507 when D1 is only the KV fallback), the site's 300MB of
// D1 photos (the first site limit), then the whole database below 420MB of its 500MB (decisions item 6).
async function checkD1(req: Request, userId: string, member: boolean, size: number, totals: Totals, meta: { size_after?: number } | undefined, fallback: boolean) {
    const mine = member ? await db().prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM uploads WHERE owner_id=? AND storage='d1'").bind(userId).all<{ bytes: number }>() : null;
    if (mine && Number(mine.results[0]?.bytes) + size > D1_USER_BYTES) fail(fallback ? 507 : 409, fallback ? STORAGE_FULL : fullUser('d1'));
    if ((totals.d1 || 0) + size > D1_SITE_BYTES) fail(507, STORAGE_FULL);
    if ((testDbBytes(req) ?? dbSize(mine?.meta ?? meta)) > DB_PHOTO_STOP) fail(507, STORAGE_FULL);
}

// What the member's photos use in the current store (u: the users row), for the editor's '사진 용량
// 12.3MB/100MB' (KV and D1 only): the D1 photos in D1 mode, every photo otherwise. The manager has only the
// site limits (limit null).
export const photoBytesSql = (mode: Storage) => mode === 'd1' ? "(SELECT COALESCE(SUM(size),0) FROM uploads WHERE owner_id=u.id AND storage='d1')" : 'u.upload_bytes';
export async function photoUsage(userId: string, manager: boolean) {
    const mode = storageMode();
    const row = await db().prepare(`SELECT ${photoBytesSql(mode)} AS bytes FROM users u WHERE u.id=?`).bind(userId).first<{ bytes: number }>();
    return { storage: mode, used: Number(row?.bytes) || 0, limit: manager ? null : userLimit(mode) };
}

async function upload(req: Request) {
    const u = await requireUser(req);
    // Anti-flood only, the same for every member (SITE_RULES): 120 per 10 minutes, 300 per day.
    await limit('upload:' + u.id, SITE_RULES.uploadsPer10Min, 600000);
    await limit('upload-day:' + u.id, SITE_RULES.uploadsPerDay, 86400000);
    const member = u.role !== 'manager', now = Date.now(), today = utcDate(now);
    let mode: Storage = testStorage(req) ?? storageMode(), fallback = false;
    // Photos that no post, chat or draft uses are removed a day after upload (see cleanup.ts).
    // users.upload_rows/upload_bytes (0018) and upload_totals (0022) are kept by triggers on uploads, so
    // this reads a few rows instead of every upload. In R2 mode the same call reads the day's puts
    // (settings 'sys:r2_puts', '<UTC date>:<n>', counted after each stored photo below) and the manager's
    // stop ('sys:r2_site_bytes').
    const r = await db().batch([
        db().prepare('SELECT upload_rows AS n,upload_bytes AS bytes FROM users WHERE id=?').bind(u.id),
        db().prepare('SELECT storage,bytes FROM upload_totals'),
        ...mode === 'r2' ? [
            db().prepare("SELECT value FROM settings WHERE key='sys:r2_puts'"),
            db().prepare("SELECT value FROM settings WHERE key='sys:r2_site_bytes'"),
        ] : [],
    ]);
    const mine = r[0].results[0] as { n: number; bytes: number } | undefined;
    const totals: Totals = Object.fromEntries((r[1].results as { storage: string; bytes: number }[]).map(t => [t.storage, Number(t.bytes) || 0]));
    // A row ceiling far above any real use (every open post full of photos); storage size is the real limit.
    if (member && mine && mine.n >= UPLOAD_ROWS) fail(409, '사진 업로드 한도를 넘었습니다. 안 쓰는 사진은 하루 뒤 정리됩니다.');
    const bytes = await readBody(req, photoLimit(mode), mode);
    const mime = sniff(bytes);
    if (!mime) fail(400, 'JPG, PNG, WebP 사진을 선택해 주세요.');
    const size = bytes.byteLength;
    if (mode === 'r2') {
        if (member && mine && mine.bytes + size > userLimit('r2')) fail(409, fullUser('r2'));
        if (counterValue((r[2].results[0] as { value?: string } | undefined)?.value, now) >= R2_SITE_DAILY_UPLOADS) fail(507, DAILY_FULL);
        const stop = Number((r[3].results[0] as { value?: string } | undefined)?.value);
        if ((totals.r2 || 0) + size > (stop > 0 ? stop : R2_SITE_BYTES)) fail(507, STORAGE_FULL);
    } else if (mode === 'kv') {
        if (member && mine && mine.bytes + size > userLimit('kv')) fail(409, fullUser('kv'));
        // KV full for the site: D1 takes the photo if its budget allows. Keys waiting in kv_trash still
        // use KV space (upload_totals 'kv_trash', kept by triggers since 0023).
        if ((totals.kv || 0) + (totals.kv_trash || 0) + size > KV_SITE_BYTES) { mode = 'd1'; fallback = true; }
    }
    if (mode === 'd1') await checkD1(req, u.id, member, size, totals, r[r.length - 1].meta, fallback);
    // X-Photo-Hash '<compressed>,<original>' (SHA-256 hex, computed by the browser) is advisory: a
    // malformed header is ignored. The same original again returns the stored photo (reused) with no
    // storage write; the unique index on (owner, original) decides between parallel uploads.
    const header = /^([0-9a-f]{64}),([0-9a-f]{64})$/.exec(req.headers.get('X-Photo-Hash') || '');
    const id = crypto.randomUUID();
    const inserted = await db().prepare(`INSERT INTO uploads(id,owner_id,mime,size,storage,created_at,hash,src_hash) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_id,src_hash) WHERE src_hash IS NOT NULL DO NOTHING`).bind(id, u.id, mime, size, mode, now, header?.[1] ?? null, header?.[2] ?? null).run();
    if (!inserted.meta.changes) {
        const [prev, used] = await db().batch([
            db().prepare('UPDATE uploads SET touched_at=? WHERE owner_id=? AND src_hash=? RETURNING id').bind(now, u.id, header![2]),
            usedInStatement(u.id, 'SELECT id FROM uploads WHERE owner_id=? AND src_hash=?', [u.id, header![2]]),
        ]);
        const reused = (prev.results[0] as { id: string } | undefined)?.id;
        if (!reused) fail(409, '잠시 후 다시 시도해 주세요.');
        return json({ id: reused, reused: true, usedIn: usedInMap(used.results as UsedRow[], u, now)[reused] || [] }, 200);
    }
    const drop = () => db().prepare('DELETE FROM uploads WHERE id=?').bind(id).run();
    try {
        await putPhoto(id, bytes, mime, mode);
        // The day's R2 puts count only photos actually written (not refusals or reused photos).
        if (mode === 'r2') await db().prepare(`INSERT INTO settings(key,value,updated_at) VALUES('sys:r2_puts',?,?) ON CONFLICT(key) DO UPDATE SET
            value=CASE WHEN settings.value LIKE ? THEN ?||':'||(CAST(substr(settings.value,12) AS INTEGER)+1) ELSE excluded.value END,updated_at=excluded.updated_at`)
            .bind(today + ':1', now, today + ':%', today).run();
    }
    catch (e) {
        if (mode !== 'kv' || e instanceof ApiError) { await drop(); throw e; }
        // KV refused the put (for example the Free plan's 1,000 writes a day): D1 if its budget allows.
        console.warn('KV put failed, trying D1', e instanceof Error ? e.message : 'unknown');
        try {
            await checkD1(req, u.id, member, size, totals, r[r.length - 1].meta, true);
            await db().batch([
                db().prepare("UPDATE uploads SET storage='d1' WHERE id=?").bind(id),
                db().prepare('INSERT INTO upload_blobs (id,data) VALUES (?,?)').bind(id, Buffer.from(bytes).toString('base64')),
            ]);
        } catch (e2) { await drop(); throw e2; }
    }
    return json({ id, usedIn: [] }, 201);
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
        // {ids}: the editor's photos restored with a draft; only the posts they are in (no touch).
        if (Array.isArray(b.ids)) {
            const ids = [...new Set(b.ids.filter((v: unknown): v is string => typeof v === 'string' && v.length <= 64))].slice(0, 100);
            if (!ids.length) return json({ usedIn: {} });
            const used = await usedInStatement(u.id, 'SELECT value FROM json_each(?)', [JSON.stringify(ids)]).all<UsedRow>();
            return json({ usedIn: usedInMap(used.results, u, Date.now()) });
        }
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
        return json({ found, usedIn: usedInMap(used.results as UsedRow[], u, now) });
    }
    if (p[0] === 'uploads' && p[1] === 'usage' && !p[2] && method === 'GET') {
        const u = await requireUser(req);
        return json(await photoUsage(u.id, u.role === 'manager'));
    }
    if (p[0] === 'uploads' && p[1] && method === 'DELETE') {
        const u = await requireUser(req), now = Date.now();
        // A deleted post's photos are held for the manager (keep_until), so the member cannot remove them meanwhile.
        const r = await db().prepare(`SELECT id,storage FROM uploads WHERE id=? AND owner_id=? AND ${unused} AND COALESCE(keep_until,0)<?`).bind(p[1], u.id, now).first<any>();
        if (!r) fail(409, '사용 중이거나 삭제 권한이 없는 사진입니다.');
        await db().batch(removeRowStatements(r.id, r.storage, now));
        if (r.storage === 'r2') await deleteR2Photo(r.id);
        return json({ ok: true });
    }
    if (p[0] === 'uploads' && !p[1] && method === 'POST') return upload(req);
    if (p[0] === 'images' && p[1] && method === 'GET') {
        const m = await db().prepare('SELECT * FROM uploads WHERE id=?').bind(p[1]).first<any>();
        if (!m) fail(404, '사진을 찾을 수 없습니다.');
        // A 댓글 photo (WP55) is public while its post is, and a 프로필 사진 (WP59) while it is set.
        const publicImage = await db().prepare('SELECT 1 FROM post_images pi JOIN posts p ON p.id=pi.post_id WHERE pi.upload_id=? AND p.hidden=0 UNION ALL SELECT 1 FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.image_id=? AND p.hidden=0 UNION ALL SELECT 1 FROM users av WHERE av.avatar_id=? AND av.deleted_at IS NULL LIMIT 1').bind(p[1], p[1], p[1]).first();
        if (!publicImage) {
            const u = await currentUser(req);
            const allowed = u && (u.id === m.owner_id || u.role === 'manager' || await db().prepare('SELECT 1 FROM message_images mi JOIN messages msg ON msg.id=mi.message_id JOIN conversations c ON c.id=msg.conversation_id WHERE mi.upload_id=? AND (c.user_a=? OR c.user_b=?) LIMIT 1').bind(p[1], u.id, u.id).first());
            if (!allowed) fail(404, '사진을 찾을 수 없습니다.');
        }
        // A KV key may take up to 60 s to show at another location: the 404 is never cached (json() sends no-store).
        const data = await getPhoto(p[1], m.storage);
        if (!data) fail(404, '사진을 찾을 수 없습니다.');
        // A photo id never changes content, so photos of visible posts are kept by the browser for a year.
        // 'private' keeps them out of shared caches, so a photo stops being served once the manager hides
        // its post. Chat, draft and private photos are never stored.
        return new Response(data, { headers: { 'Content-Type': m.mime, 'Cache-Control': publicImage ? 'private, max-age=31536000, immutable' : 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    return null;
}
