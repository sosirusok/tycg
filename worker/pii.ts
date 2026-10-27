import { env } from 'cloudflare:workers';
import { localRequest } from './meter';
import { INFO_FIELDS, type InfoField } from '../shared/membership';

// 네이버 회원 정보 (users.pii, 0065): 회원이름, 연락처 이메일, 출생연도 and 휴대전화번호 as Naver sent them at the
// member's latest Naver login, in one AES-GCM value: base64(12-byte iv | ciphertext) of JSON
// {name,email,phone(digits)}. The key is HKDF-SHA256 of PHONE_HASH_KEY (info 'zg-pii-v1'), so like the
// phone hash it is set once: a new PHONE_HASH_KEY makes earlier values unreadable until the next login writes them
// again. Local test servers (TEST_HOOKS=on, local requests) use a fixed key; anywhere else without the key nothing
// is stored. The values are never logged; only worker/info.ts decrypts them.
export type Pii = Record<InfoField, string | null>;

const enc = new TextEncoder();

async function piiKey(req: Request) {
    const v = env as Partial<Env>, secret = v.PHONE_HASH_KEY || (v.TEST_HOOKS === 'on' && localRequest(req) ? 'zg-phone-test' : '');
    if (!secret) return null;
    const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('zg-pii-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// The stored value of `pii`, or null when there is nothing to keep or no key (then a warning, never the values).
export async function sealPii(req: Request, pii: Pii) {
    if (INFO_FIELDS.every(f => pii[f] === null)) return null;
    const key = await piiKey(req);
    if (!key) { console.warn('PHONE_HASH_KEY is not set: member info is not stored'); return null; }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(pii))));
    const all = new Uint8Array(iv.length + ct.length);
    all.set(iv); all.set(ct, iv.length);
    let bin = '';
    for (const b of all) bin += String.fromCharCode(b);
    return btoa(bin);
}

// A reader for one request: the key is derived once, each value opens to its fields (null: none or unreadable).
export async function piiReader(req: Request) {
    const key = await piiKey(req);
    return async (value: string | null | undefined): Promise<Pii | null> => {
        if (!key || !value) return null;
        try {
            const all = Uint8Array.from(atob(value), c => c.charCodeAt(0));
            if (all.length < 29) return null;
            const d = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12))));
            return Object.fromEntries(INFO_FIELDS.map(f => [f, typeof d?.[f] === 'string' ? d[f] : null])) as Pii;
        } catch { return null; }
    };
}
