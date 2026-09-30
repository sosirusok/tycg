export class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

export const UNAUTHORIZED_EVENT = 'zg:unauthorized';
export const LOGIN_REQUIRED = '로그인이 필요합니다.';

// Every 401 means the session is gone, except a login attempt's (a wrong id or password).
// AppProvider listens and signs the member out on the page.
function sessionEnded(path: string) {
    if (path !== 'auth/login') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

export async function api<T = any>(path: string, method = 'GET', data?: unknown): Promise<T> {
    let response: Response;
    try {
        response = await fetch('/api/' + path, {
            method,
            credentials: 'same-origin',
            headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: data === undefined ? undefined : JSON.stringify(data),
        });
    } catch {
        throw new ApiError(0, '인터넷 연결을 확인해 주세요.');
    }
    let body: any, parsed = true;
    try { body = await response.json(); } catch { parsed = false; }
    // Right before the throw, so the caller's own error toast comes first (AppProvider skips a duplicate).
    if (response.status === 401) sessionEnded(path);
    if (!parsed) throw new ApiError(response.status, '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    if (!response.ok) throw new ApiError(response.status, body?.error || '요청을 처리하지 못했습니다.');
    return body as T;
}

export const errorText = (e: unknown) => e instanceof Error ? e.message : '다시 시도해 주세요.';

// Resizes photos in the browser before upload. Most results are 100–400 KB WebP,
// which fits both R2 and the D1 fallback (1.4 MB per photo).
async function compress(file: File): Promise<Blob> {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('JPG, PNG, WebP 사진만 올릴 수 있습니다.');
    if (file.size > 20 * 1024 * 1024) throw new Error('20MB 이하의 사진을 선택해 주세요.');
    let bitmap: ImageBitmap;
    try { bitmap = await createImageBitmap(file); }
    catch { throw new Error('사진을 열 수 없습니다. JPG, PNG, WebP 사진인지 확인해 주세요.'); }
    let edge = 1600, quality = 0.85, blob: Blob | null = null;
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

export async function uploadPhoto(file: File): Promise<string> {
    const blob = await compress(file);
    let response: Response;
    try {
        response = await fetch('/api/uploads', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob });
    } catch {
        throw new ApiError(0, '인터넷 연결을 확인해 주세요.');
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) sessionEnded('uploads');
    if (!response.ok) throw new ApiError(response.status, body.error || '사진을 올리지 못했습니다.');
    return body.id;
}

export const imageUrl = (id: string) => '/api/images/' + id;
