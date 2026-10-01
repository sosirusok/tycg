import { env } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { db, fail } from './http';

// Photos go to R2 when a bucket is bound. Otherwise they are kept in D1 as base64
// text so the site works on an account without R2. D1 rows are limited to 2 MB,
// and base64 adds a third, so D1 photos are capped at 1.4 MB.
export const D1_PHOTO_LIMIT = 1_400_000;
// D1 space for photos without R2: per member and for the whole site (the Free plan database holds 500 MB).
export const D1_USER_BYTES = 30 * 1024 * 1024;
export const D1_SITE_BYTES = 300 * 1024 * 1024;
// R2 space per member (tier table: 1GB). The R2 free tier is 10GB for the whole site.
export const R2_USER_BYTES = 1024 * 1024 * 1024;
export type Storage = 'r2' | 'd1';

function bucket() { return (env as Partial<Env>).BUCKET; }

export function storageMode(): Storage { return bucket() ? 'r2' : 'd1'; }
export function photoLimit() { return bucket() ? 5 * 1024 * 1024 : D1_PHOTO_LIMIT; }
export function photoLimitText() { return bucket() ? '5MB' : '1.4MB'; }

// The uploads row must already exist when D1 storage is used (foreign key).
export async function putPhoto(id: string, bytes: Uint8Array, mime: string, storage: Storage) {
    if (storage === 'r2') {
        const b = bucket();
        if (!b) fail(503, '사진 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
        await b.put('uploads/' + id, bytes, { httpMetadata: { contentType: mime } });
        return;
    }
    if (bytes.byteLength > D1_PHOTO_LIMIT) fail(413, '사진 한 장은 1.4MB 이하여야 합니다.');
    await db().prepare('INSERT INTO upload_blobs (id,data) VALUES (?,?)').bind(id, Buffer.from(bytes).toString('base64')).run();
}

export async function getPhoto(id: string, storage: Storage): Promise<BodyInit | null> {
    if (storage === 'r2') return (await bucket()?.get('uploads/' + id))?.body ?? null;
    const row = await db().prepare('SELECT data FROM upload_blobs WHERE id=?').bind(id).first<{ data: string }>();
    return row ? new Uint8Array(Buffer.from(row.data, 'base64')) : null;
}

export async function deletePhoto(id: string, storage: Storage) {
    if (storage === 'r2') await bucket()?.delete('uploads/' + id);
    else await db().prepare('DELETE FROM upload_blobs WHERE id=?').bind(id).run();
}
