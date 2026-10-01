import { env } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { db, fail } from './http';
import { countR2, countKv, localRequest } from './meter';

// Photos have three stores (decisions item 6):
// - R2 when a bucket is bound: the long-term store (10GB free).
// - KV when only the PHOTOS namespace is bound (deploy.yml finds or creates it while R2 is off): 1GB on
//   the Free plan with 1,000 writes and 1,000 deletes a day, so a failed put falls back to D1 and deletes
//   go through kv_trash under a daily budget.
// - D1 as the last fallback: base64 text in upload_blobs. D1 rows are limited to 2 MB and base64 adds a
//   third, so D1 (and KV) photos are capped at 1.4 MB.
// uploads.storage says where each photo is, so a site that changes mode keeps serving older photos, and
// the R2 mover (cleanup.ts) copies D1 and KV photos into R2 once a bucket is bound.
export const D1_PHOTO_LIMIT = 1_400_000;
const MB = 1024 * 1024, GB = 1024 * MB;
// D1 space for photos: per member and for the whole site (the Free plan database holds 500 MB). D1
// photo writes also stop once the whole database passes DB_PHOTO_STOP.
export const D1_USER_BYTES = 30 * MB;
export const D1_SITE_BYTES = 300 * MB;
export const DB_LIMIT_BYTES = 500 * MB;
export const DB_PHOTO_STOP = 420 * MB;
// KV space per member and for the whole site (KV Free stores 1GB).
export const KV_USER_BYTES = 100 * MB;
export const KV_SITE_BYTES = 950 * MB;
// R2 space per member (tier table: 1GB), and the site guards that keep any bill under $1 a month: at most
// 25,000 photo puts a UTC day, and a stop at 20GB the manager can move (settings 'sys:r2_site_bytes').
export const R2_USER_BYTES = GB;
export const R2_SITE_DAILY_UPLOADS = 25_000;
export const R2_SITE_BYTES = 20 * GB;
export const R2_WARN_BYTES = [8 * GB, 9.5 * GB];
export type Storage = 'r2' | 'kv' | 'd1';

export const STORAGE_FULL = '사진 저장 공간이 부족합니다. 매니저에게 문의해 주세요.';
export const DAILY_FULL = '오늘 사진 올리기 한도를 넘었습니다. 매니저에게 문의해 주세요.';

const vars = () => env as Partial<Env>;
const bucket = () => vars().BUCKET;
const photos = () => vars().PHOTOS;
export const hasBucket = () => !!bucket();
export const hasKv = () => !!photos();

export function storageMode(): Storage { return bucket() ? 'r2' : photos() ? 'kv' : 'd1'; }
export function photoLimit(mode = storageMode()) { return mode === 'r2' ? 5 * MB : D1_PHOTO_LIMIT; }
export function photoLimitText(mode = storageMode()) { return mode === 'r2' ? '5MB' : '1.4MB'; }
// '사진 용량(1인 100MB)' for each store's per-member budget.
export const userLimit = (mode: Storage) => mode === 'r2' ? R2_USER_BYTES : mode === 'kv' ? KV_USER_BYTES : D1_USER_BYTES;
export const userLimitText = (mode: Storage) => mode === 'r2' ? '1GB' : mode === 'kv' ? '100MB' : '30MB';

// Test only (local requests, or scheduled runs, with the var set by scripts/test-local.mjs; deploys never
// set it): KV_TEST_FAIL=on makes every KV put and delete throw, as on a day past the Free plan's limits.
let kvFailAllowed = false;
export function allowKvTestFailure(req: Request | null) { kvFailAllowed = vars().KV_TEST_FAIL === 'on' && (!req || localRequest(req)); }
function kvTestFailure() { if (kvFailAllowed && vars().KV_TEST_FAIL === 'on') throw new Error('KV test failure'); }

const kvKey = (id: string) => 'uploads/' + id;

// The uploads row must already exist when D1 storage is used (foreign key).
export async function putPhoto(id: string, bytes: Uint8Array, mime: string, storage: Storage) {
    if (storage === 'r2') {
        const b = bucket();
        if (!b) fail(503, '사진 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
        countR2();
        await b.put(kvKey(id), bytes, { httpMetadata: { contentType: mime } });
        return;
    }
    if (bytes.byteLength > D1_PHOTO_LIMIT) fail(413, '사진 한 장은 1.4MB 이하여야 합니다.');
    if (storage === 'kv') {
        const kv = photos();
        if (!kv) throw new Error('KV is not bound');
        countKv();
        kvTestFailure();
        await kv.put(kvKey(id), bytes);
        return;
    }
    await db().prepare('INSERT INTO upload_blobs (id,data) VALUES (?,?)').bind(id, Buffer.from(bytes).toString('base64')).run();
}

export async function getPhoto(id: string, storage: string): Promise<BodyInit | null> {
    if (storage === 'r2') { countR2(); return (await bucket()?.get(kvKey(id)))?.body ?? null; }
    if (storage === 'kv') {
        const kv = photos();
        if (!kv) return null;
        countKv();
        return await kv.get(kvKey(id), 'arrayBuffer');
    }
    const row = await db().prepare('SELECT data FROM upload_blobs WHERE id=?').bind(id).first<{ data: string }>();
    return row ? new Uint8Array(Buffer.from(row.data, 'base64')) : null;
}

// The bytes of a D1 photo (the R2 mover reads them from its own SELECT).
export const blobBytes = (data: string) => new Uint8Array(Buffer.from(data, 'base64'));
// Copies one photo into R2 (the mover).
export async function putR2(id: string, bytes: Uint8Array | ArrayBuffer, mime: string) {
    const b = bucket();
    if (!b) throw new Error('R2 is not bound');
    countR2();
    await b.put(kvKey(id), bytes, { httpMetadata: { contentType: mime } });
}
export async function getKv(id: string) {
    const kv = photos();
    if (!kv) return null;
    countKv();
    return kv.get(kvKey(id), 'arrayBuffer');
}

// The statements that remove one unused photo's row. A KV key is never deleted inline: it goes to
// kv_trash, which the daily cleanup drains under the KV delete budget. D1 bytes go with the row
// (upload_blobs ON DELETE CASCADE). An R2 object is deleted by the caller.
export function removeRowStatements(id: string, storage: string, now: number) {
    return [
        ...storage === 'kv' ? [db().prepare('INSERT OR IGNORE INTO kv_trash(id,created_at) VALUES(?,?)').bind(id, now)] : [],
        db().prepare('DELETE FROM uploads WHERE id=?').bind(id),
    ];
}

export async function deleteR2Photo(id: string) {
    if (!bucket()) return;
    countR2();
    await bucket()!.delete(kvKey(id));
}

// Removes many R2 photos in one call (R2 takes up to 1,000 keys per delete).
export async function deleteR2Photos(ids: string[]) {
    const b = bucket();
    if (!b || !ids.length) return;
    countR2();
    await b.delete(ids.map(kvKey));
}

// Deletes KV keys one by one, stopping at the first error (the daily limit, or KV_TEST_FAIL); returns
// the ids that were deleted.
export async function deleteKvKeys(ids: string[]) {
    const kv = photos(), done: string[] = [];
    if (!kv) return done;
    for (const id of ids) {
        try { countKv(); kvTestFailure(); await kv.delete(kvKey(id)); done.push(id); }
        catch (e) { console.warn('KV delete stopped', e instanceof Error ? e.message : 'unknown'); break; }
    }
    return done;
}

// The database size, from meta.size_after of the latest statement, kept 5 minutes per isolate.
let dbSizeCache: { bytes: number; at: number } | null = null;
export function dbSize(meta: { size_after?: number } | undefined, now = Date.now()) {
    const fresh = Number(meta?.size_after);
    if ((!dbSizeCache || now - dbSizeCache.at > 5 * 60000) && Number.isFinite(fresh) && fresh > 0) dbSizeCache = { bytes: fresh, at: now };
    return dbSizeCache?.bytes ?? 0;
}
// Test only: X-Test-Db-Bytes stands in for the database size on one local request when TEST_HOOKS=on
// (scripts/test-local.mjs; deploys never set it).
export function testDbBytes(req: Request) {
    if (vars().TEST_HOOKS !== 'on' || !localRequest(req)) return null;
    const v = Number(req.headers.get('X-Test-Db-Bytes'));
    return Number.isFinite(v) && v > 0 ? v : null;
}
// Test only, the same way: X-Test-Storage 'kv' or 'd1' stores one upload there although R2 is bound (the
// R2 mover's test needs KV rows on a server with a bucket).
export function testStorage(req: Request): Storage | null {
    if (vars().TEST_HOOKS !== 'on' || !localRequest(req)) return null;
    const v = req.headers.get('X-Test-Storage');
    return v === 'kv' && photos() ? 'kv' : v === 'd1' ? 'd1' : null;
}

// '<UTC date>:<n>' counters in settings (the KV delete budget, the R2 puts of the day). KV and R2 limits
// reset at 00:00 UTC.
export const utcDate = (now: number) => new Date(now).toISOString().slice(0, 10);
export function counterValue(value: string | null | undefined, now: number) {
    const [day, n] = String(value || '').split(':');
    return day === utcDate(now) ? Number(n) || 0 : 0;
}
