// 같은 매물 (WP44, decisions item 1a): the listing memory every post keeps in post_prints, and the
// matcher that says whether two prints describe the same listing. Pure, shared by the Worker (create,
// edit, the daily fill) and the unit checks in tests/verify-dup.mjs.
//
// Only exact signals count: a photo's hash, the canonical listing fields and the title key. Fuzzy
// titles, body text and perceptual image hashes are left out on purpose (false positives on vendors'
// accounts and on same-screen game screenshots).
import { LEGACY_SKELETON, FULL_SET, NICK_TYPES, SKIN_TAGS, parseList, type SeasonTag } from './market';
import { titleKey } from './membership';

// m: how the fields compare. 'acct': an account offered (판매, 교환) with distinctive fields that can
// match and supporting fields that can only contradict. 'want': 구매 and 대리(구함), where the whole
// filled map must be equal. 'key': one naming field (클랜명, 상품명/쿠폰명, 대리(진행) 종목). 'none': 기타.
export type ListingFields = { m: 'acct' | 'want' | 'key' | 'none'; d: Record<string, string>; s: Record<string, string> };
// One print as the matcher sees it. photos: up to 12 entries, one per photo, each the photo's keys
// (16 hex characters of the compressed file's and of the original's SHA-256, or 'u:<upload id>' when the
// photo has no hash).
export type Print = { kind: string; category: string; title_key: string; fields: ListingFields | null; photos: string[][] };
export type Match = { why: 'photos' | 'fields' | 'title'; photos?: number; names?: string[] };

export const PRINT_PHOTOS = 12;
// A photo key is this many hex characters of the SHA-256.
export const PHOTO_KEY = 16;

// Distinctive account fields, in the order sameText names them.
const DISTINCTIVE: [string, string][] = [
    ['ladder', '래더'], ['skins', '스킨'], ['phantom', '팬텀'], ['humanSkins', '인간 스킨'], ['zombieSkins', '좀비 스킨'],
    ['level', '레벨'], ['labLevel', '연구실'], ['closet', '옷장'], ['gas', '가스'], ['minerals', '미네랄'],
    ['rides', '라이드'], ['emblems', '엠블럼'], ['nick', '닉네임'],
];
const NUMBERS = ['phantom', 'humanSkins', 'zombieSkins', 'level', 'labLevel', 'closet', 'gas', 'minerals'];
const SUPPORTING_CHOICES = ['ownerCount', 'recordStatus', 'integrated', 'passwordChange', 'phoneChange', 'backupEmail'];
const SUPPORTING_TEXT = ['joined', 'accountType', 'progress'];
// The naming field(s) of a 'key' listing, with the names sameText uses.
const KEY_FIELDS: Record<string, [string, string][]> = {
    clan: [['clanName', '클랜명']],
    goods_coupon: [['couponName', '쿠폰명'], ['goodsName', '상품명']],
    proxy: [['mode', '종목']],
};
const WANT_NAMES: Record<string, string> = {
    ladder: '래더', skinTags: '스킨', maxOwners: '대주 수', recordPreference: '전적', nicknameCharsMin: '닉네임 글자 수', nicknameCharsMax: '닉네임 글자 수',
    nicknameRanks: '닉 등급', wantedNicknameTypes: '닉 종류', phantomMin: '팬텀', mode: '종목', current: '현재', target: '목표',
};

// The same-title key. A title with no letters or digits ('!!') keeps its symbols, so it never
// shares the empty key of rows that the daily cleanup has not filled in yet.
export const postTitleKey = (title: string) => titleKey(title) || '#' + title.normalize('NFKC').replace(/\s+/g, '');

const text = (v: unknown) => typeof v === 'string' ? titleKey(v) : '';
const num = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v.trim()) ? String(Number(v.trim())) : text(v);
// A JSON list stored in details, sorted, as one value ('' when empty).
function list(raw: unknown) {
    if (typeof raw !== 'string' || !raw) return '';
    try {
        const v: unknown = JSON.parse(raw);
        return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean))].sort().join(',') : text(raw);
    } catch { return text(raw); }
}
// The ladder as one value: 'master:18,master:29'. 시즌 비공개 (WP68) adds 'master:h2' (2 hidden 마스터
// emblems), so a ladder without hidden emblems keeps the value earlier prints stored.
const ladderOf = (tags: SeasonTag[] | undefined, hidden?: Record<string, number> | null) => [...new Set([
    ...(tags || []).map(t => `${t.tier}:${t.season}`),
    ...Object.entries(hidden || {}).filter(([, n]) => Number.isInteger(n) && n > 0).map(([tier, n]) => `${tier}:h${n}`),
])].sort().join(',');
// 우대 스킨 as the detail page shows them: the full skeleton set implies its legacy single skin.
function skinsOf(raw: unknown) {
    const tags = parseList(typeof raw === 'string' ? raw : '', SKIN_TAGS);
    return tags.filter(v => v !== LEGACY_SKELETON || !tags.includes(FULL_SET)).sort().join(',');
}
const filled = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

// The canonical listing fields of a post: what its 거래 구분, 세부 분류, details, season tags, 시즌 비공개
// (hidden, WP68: 판매 and the offered side of 교환 only) and 클랜 래더 (clan, WP70: a clan post's own seasons)
// say. 특징 태그 (details.featureTags) and 현재 클랜 티어 (details.clanTier) come with the details; new fields
// stay empty on older posts, so earlier prints keep matching.
export function listingFields(kind: string, category: string, details: Record<string, string>, seasons: SeasonTag[] = [], hidden?: Record<string, number> | null, clan: SeasonTag[] = []): ListingFields {
    const d = details || {};
    if (kind === 'buy' || kind === 'proxy_request') {
        const want: Record<string, string> = { ladder: ladderOf(seasons), clanLadder: ladderOf(clan) };
        for (const [k, v] of Object.entries(d)) {
            if (k === 'currentOffer') continue;
            want[k] = typeof v === 'string' && v.trim().startsWith('[') ? list(v) : num(v);
        }
        return { m: 'want', d: filled(want), s: {} };
    }
    if (category === 'account') {
        const nick = [num(d.nicknameChars), parseList(d.nicknameTypes, NICK_TYPES).sort().join(','), text(d.nicknameRank)];
        const dist: Record<string, string> = {
            ladder: ladderOf(seasons, hidden), skins: skinsOf(d.skinTags),
            ...Object.fromEntries(NUMBERS.map(k => [k, num(d[k])])),
            rides: text(d.rides), emblems: text(d.emblems),
            nick: nick.some(Boolean) ? nick.join('|') : '',
        };
        const sup: Record<string, string> = {
            ...Object.fromEntries(SUPPORTING_CHOICES.map(k => [k, k === 'ownerCount' ? num(d[k]) : typeof d[k] === 'string' ? d[k].trim() : ''])),
            ...Object.fromEntries(SUPPORTING_TEXT.map(k => [k, text(d[k])])),
            // 특징 태그 can only contradict: a seller's own words, never enough to call two posts the same.
            tags: list(d.featureTags),
        };
        return { m: 'acct', d: filled(dist), s: filled(sup) };
    }
    const keys = KEY_FIELDS[kind === 'proxy_offer' ? 'proxy' : category];
    if (!keys) return { m: 'none', d: {}, s: {} };
    const key: Record<string, string> = {}, rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(d)) {
        // The wanted side of 교환 describes another listing, so it never decides or contradicts.
        if (k === 'currentOffer' || k.startsWith('wanted')) continue;
        (keys.some(([id]) => id === k) ? key : rest)[k] = typeof v === 'string' && v.trim().startsWith('[') ? list(v) : num(v);
    }
    // The clan's own 클랜 래더 (WP70) supports the 클랜명 like the other clan fields.
    if (category === 'clan') rest.clanLadder = ladderOf(clan);
    return { m: 'key', d: filled(key), s: filled(rest) };
}

// Whether a field both prints filled differs (distinctive or supporting). Fields of different modes or
// 세부 분류 never contradict: they describe different things.
function contradicts(a: ListingFields | null, b: ListingFields | null) {
    if (!a || !b || a.m !== b.m) return false;
    const all = (f: ListingFields) => ({ ...f.d, ...f.s });
    const x = all(a), y = all(b);
    return Object.keys(x).some(k => k in y && x[k] !== y[k]);
}

// The equal distinctive fields of two account prints, in DISTINCTIVE order.
function equalDistinctive(a: ListingFields, b: ListingFields) {
    return DISTINCTIVE.filter(([k]) => k in a.d && a.d[k] === b.d[k]).map(([, name]) => name);
}

// Field names that make two prints the same listing by fields, or null.
function fieldMatch(a: Print, b: Print): string[] | null {
    const x = a.fields, y = b.fields;
    if (!x || !y || x.m !== y.m || a.category !== b.category || x.m === 'none') return null;
    if (contradicts(x, y)) return null;
    if (x.m === 'acct') {
        const names = equalDistinctive(x, y);
        return names.length >= 3 ? names : null;
    }
    if (x.m === 'want') {
        const kx = Object.keys(x.d), ky = Object.keys(y.d);
        if (!kx.length || kx.length !== ky.length || kx.some(k => x.d[k] !== y.d[k])) return null;
        return [...new Set(kx.map(k => WANT_NAMES[k] || '조건'))];
    }
    const keys = KEY_FIELDS[a.kind === 'proxy_offer' ? 'proxy' : a.category] || [];
    const names = keys.filter(([k]) => x.d[k] && x.d[k] === y.d[k]).map(([, name]) => name);
    return names.length ? names : null;
}

// How many of a's photos share a key with b's photos.
export function sharedPhotos(a: string[][], b: string[][]) {
    const keys = new Set(b.flat());
    return a.filter(p => p.some(k => keys.has(k))).length;
}

// Whether a and b are the same listing, and why: more than half of the larger photo set shared (a single
// shared photo is ignored when a both-filled field differs, so a shop banner never decides), the
// listing fields, or the title key (ignored when a both-filled field differs).
export function sameListing(a: Print, b: Print): Match | null {
    const conflict = contradicts(a.fields, b.fields);
    const shared = sharedPhotos(a.photos, b.photos);
    if (shared && 2 * shared > Math.max(a.photos.length, b.photos.length) && !(shared === 1 && conflict)) return { why: 'photos', photos: shared };
    const names = fieldMatch(a, b);
    if (names) return { why: 'fields', names };
    if (a.title_key && a.title_key === b.title_key && !conflict) return { why: 'title' };
    return null;
}

// '사진 3장', '래더·스킨·팬텀' (at most 3 names) or '제목'.
export function sameText(m: Match) {
    if (m.why === 'photos') return `사진 ${m.photos}장`;
    if (m.why === 'fields') return (m.names || []).slice(0, 3).join('·');
    return '제목';
}

// An account listing with at least 4 distinctive fields gets a fields hash, for the cross-account
// check (other members' prints with the same account). Returns the text to hash, or null.
export function fieldsHashInput(f: ListingFields | null) {
    if (!f || f.m !== 'acct' || Object.keys(f.d).length < 4) return null;
    return JSON.stringify(f.d);
}

// The photo entries of a print from a post's upload ids and their hashes (full hex as stored in uploads).
export function photoKeys(images: string[], hashes: Map<string, { hash: string | null; src_hash: string | null }>) {
    return images.slice(0, PRINT_PHOTOS).map(id => {
        const h = hashes.get(id), keys = [h?.hash, h?.src_hash].filter((v): v is string => !!v).map(v => v.slice(0, PHOTO_KEY));
        return keys.length ? [...new Set(keys)] : ['u:' + id];
    });
}

// The fields hash: the first 32 hex characters of the SHA-256 of fieldsHashInput, or null.
export async function fieldsHash(f: ListingFields | null) {
    const input = fieldsHashInput(f);
    if (!input) return null;
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
    return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// One backfilled print (fields NULL) completed by the daily cleanup from its post's stored columns:
// canonical fields, fields hash, photo keys (the upload ids: those photos predate the hashes, and a relist
// reusing the same upload still matches) and title key. Pure, so its CPU cost is checked in Node
// (tests/verify-dup.mjs).
export type UnfilledPrint = { post_id: number; title_key: string; kind: string; category: string; title: string; details: string; images: string; tags: string | null };
const parseText = (s: string | null, fallback: any) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
export async function printFill(r: UnfilledPrint) {
    const fields = listingFields(r.kind, r.category, parseText(r.details, {}), parseText(r.tags, []));
    return { id: r.post_id, f: JSON.stringify(fields), h: await fieldsHash(fields), p: JSON.stringify(photoKeys(parseText(r.images, []), new Map())), k: r.title_key || postTitleKey(r.title) };
}
