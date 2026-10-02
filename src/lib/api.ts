export class ApiError extends Error {
    // data: the whole error body, for refusals that carry more than the message (같은 매물's dup).
    constructor(public status: number, message: string, public data?: any) { super(message); }
}

export const UNAUTHORIZED_EVENT = 'zg:unauthorized';
export const LOGIN_REQUIRED = '로그인이 필요합니다.';

// Every 401 means the session is gone, except a login attempt's (a wrong id or password).
// AppProvider listens and signs the member out on the page.
function sessionEnded(path: string) {
    if (path !== 'auth/login') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

// signal: a request the caller may cancel (the chat room's long poll, WP69); a cancelled one rejects with
// the AbortError itself, never an ApiError.
export async function api<T = any>(path: string, method = 'GET', data?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
    const signal = options?.signal;
    let response: Response;
    try {
        response = await fetch('/api/' + path, {
            method,
            credentials: 'same-origin',
            headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: data === undefined ? undefined : JSON.stringify(data),
            signal,
        });
    } catch (e) {
        if (signal?.aborted) throw e;
        throw new ApiError(0, '인터넷 연결을 확인해 주세요.');
    }
    let body: any, parsed = true;
    try { body = await response.json(); } catch { parsed = false; }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // Right before the throw, so the caller's own error toast comes first (AppProvider skips a duplicate).
    if (response.status === 401) sessionEnded(path);
    if (!parsed) throw new ApiError(response.status, '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    if (!response.ok) throw new ApiError(response.status, body?.error || '요청을 처리하지 못했습니다.', body);
    return body as T;
}

export const errorText = (e: unknown) => e instanceof Error ? e.message : '다시 시도해 주세요.';

// Where the site keeps photos (GET /api/config storage, WP45): R2 takes larger files than KV and D1.
export type PhotoStorage = 'r2' | 'kv' | 'd1';
let photoStorage: PhotoStorage = 'r2';
export function setPhotoStorage(mode: PhotoStorage | undefined) { if (mode === 'r2' || mode === 'kv' || mode === 'd1') photoStorage = mode; }

// Resizes photos in the browser before upload: long side 1600px WebP q0.85 with R2, 1280px q0.8 with KV
// and D1 (most results are 13-85KB), which fits KV and D1's 1.4 MB per photo.
async function compress(file: File): Promise<Blob> {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('JPG, PNG, WebP 사진만 올릴 수 있습니다.');
    if (file.size > 20 * 1024 * 1024) throw new Error('20MB 이하의 사진을 선택해 주세요.');
    let bitmap: ImageBitmap;
    try { bitmap = await createImageBitmap(file); }
    catch { throw new Error('사진을 열 수 없습니다. JPG, PNG, WebP 사진인지 확인해 주세요.'); }
    const r2 = photoStorage === 'r2';
    let edge = r2 ? 1600 : 1280, quality = r2 ? 0.85 : 0.8, blob: Blob | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        const ratio = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
        canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob && blob.type !== 'image/webp') blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= 1_300_000) break;
        edge = Math.round(edge * 0.8);
        quality = Math.max(0.6, quality - 0.08);
    }
    bitmap.close();
    if (!blob) throw new Error('사진을 처리하지 못했습니다.');
    return blob;
}

// The inline list thumbnail (WP45): a 176px square (cover crop) WebP data URI of the 대표 photo, q0.6;
// over 6,000 characters it tries q0.4, then 144px. Null when the browser cannot make WebP or the photo
// does not load (the list then shows the photo itself).
export async function makeThumb(id: string): Promise<string | null> {
    try {
        const img = new Image();
        img.decoding = 'async';
        img.src = imageUrl(id);
        await img.decode();
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        if (!side) return null;
        // Busy photos step down further (120px, then 96px) before the list falls back to the full photo.
        for (const [size, q] of [[176, 0.6], [176, 0.4], [144, 0.4], [120, 0.4], [96, 0.3]] as const) {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = size;
            canvas.getContext('2d')!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
            const uri = canvas.toDataURL('image/webp', q);
            if (!uri.startsWith('data:image/webp;base64,')) return null;
            if (uri.length <= 6000) return uri;
        }
        return null;
    } catch { return null; }
}

// The author's open posts a photo is already in (같은 매물, WP44).
// bumpAt: when that post can be bumped (null: now).
export type UsedIn = { id: number; title: string; photos: number; bumpAt?: number | null };
export type Uploaded = { id: string; reused?: boolean; usedIn: UsedIn[] };

// SHA-256 hex of a file, or null where the browser cannot compute it (the hashes are advisory).
export async function fileHash(file: Blob): Promise<string | null> {
    try {
        if (!globalThis.crypto?.subtle) return null;
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
}

// The member's own uploads of these originals: {found: {hash: upload id}, usedIn: {upload id: posts}}.
// A failed lookup finds nothing, and the photos are simply uploaded.
export async function lookupPhotos(hashes: string[]): Promise<{ found: Record<string, string>; usedIn: Record<string, UsedIn[]> }> {
    if (!hashes.length) return { found: {}, usedIn: {} };
    try { return await api('uploads/lookup', 'POST', { hashes: hashes.slice(0, 100) }); }
    catch { return { found: {}, usedIn: {} }; }
}

// Compresses and uploads one photo with X-Photo-Hash '<compressed>,<original>'. src: the original's
// hash when already computed. The server returns the stored photo when the same original was uploaded
// before (reused) and the author's open posts it is in.
export async function sendPhoto(file: File, src?: string | null): Promise<Uploaded> {
    const original = src === undefined ? await fileHash(file) : src;
    const blob = await compress(file);
    const out = original ? await fileHash(blob) : null;
    let response: Response;
    try {
        response = await fetch('/api/uploads', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type, ...original && out ? { 'X-Photo-Hash': out + ',' + original } : {} }, body: blob });
    } catch {
        throw new ApiError(0, '인터넷 연결을 확인해 주세요.');
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) sessionEnded('uploads');
    if (!response.ok) throw new ApiError(response.status, body.error || '사진을 올리지 못했습니다.');
    return { id: body.id, reused: !!body.reused, usedIn: body.usedIn || [] };
}

export async function uploadPhoto(file: File): Promise<string> {
    return (await sendPhoto(file)).id;
}

// 프로필 사진 (WP59): the picked photo cut to a centered 256px square for the upload, and its 64px copy as a
// data URI of at most 4,000 characters for lists and chat rows. WebP, or JPEG where the browser cannot
// make WebP (the server takes both).
async function makeAvatar(file: File): Promise<{ blob: Blob; thumb: string }> {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('JPG, PNG, WebP 사진만 올릴 수 있습니다.');
    if (file.size > 20 * 1024 * 1024) throw new Error('20MB 이하의 사진을 선택해 주세요.');
    let bitmap: ImageBitmap;
    try { bitmap = await createImageBitmap(file); }
    catch { throw new Error('사진을 열 수 없습니다. JPG, PNG, WebP 사진인지 확인해 주세요.'); }
    try {
        const side = Math.min(bitmap.width, bitmap.height);
        const square = (size: number) => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = size;
            canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
            return canvas;
        };
        const big = square(256);
        let blob = await new Promise<Blob | null>(resolve => big.toBlob(resolve, 'image/webp', 0.85));
        if (!blob || blob.type !== 'image/webp') blob = await new Promise<Blob | null>(resolve => big.toBlob(resolve, 'image/jpeg', 0.85));
        const small = square(64);
        let thumb = '';
        for (const q of [0.75, 0.5, 0.3]) {
            for (const type of ['image/webp', 'image/jpeg']) {
                const uri = small.toDataURL(type, q);
                if (uri.startsWith(`data:${type};base64,`) && uri.length <= 4000) { thumb = uri; break; }
            }
            if (thumb) break;
        }
        if (!blob || !thumb) throw new Error('사진을 다시 선택해 주세요.');
        return { blob, thumb };
    } finally { bitmap.close(); }
}

// Uploads the cut photo as it is (no second compression) and sets it: {avatar_id, avatar_thumb}.
export async function setAvatar(file: File): Promise<{ avatar_id: string; avatar_thumb: string }> {
    const { blob, thumb } = await makeAvatar(file);
    let response: Response;
    try { response = await fetch('/api/uploads', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob }); }
    catch { throw new ApiError(0, '인터넷 연결을 확인해 주세요.'); }
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) sessionEnded('uploads');
    if (!response.ok) throw new ApiError(response.status, body.error || '사진을 올리지 못했습니다.');
    return api('me/avatar', 'POST', { uploadId: body.id, thumb });
}

export const imageUrl = (id: string) => '/api/images/' + id;

// The image files of a paste or a drop (clipboardData.files, dataTransfer.files). Other files are
// left out; uploadPhoto still refuses image types other than JPG, PNG and WebP with its own message.
export const imageFiles = (files: FileList | null | undefined) => Array.from(files || []).filter(f => f.type.startsWith('image/'));
// Whether a drag carries files, so dragover can accept it (text and links are left alone).
export const dragsFiles = (types: readonly string[]) => types.includes('Files');
// A paste into a text field that carries text stays text: Excel and Word also put a picture of the
// copied cells on the clipboard, which must not replace them. Only a paste of pictures alone (a
// screenshot, a copied image) anywhere, or any paste outside a text field, becomes photos.
export function pastesText(target: EventTarget | null, data: DataTransfer | null) {
    const el = target instanceof HTMLElement ? target : null;
    const field = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    return field && !!data && Array.from(data.types).includes('text/plain');
}
// Shown when photos arrive while the previous ones are still uploading.
export const UPLOAD_BUSY = '사진을 올리는 중입니다.';
