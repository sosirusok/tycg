// 같은 매물 on the Worker (WP44): building a post's print, reading the author's prints for the matcher,
// and the cross-account check that raises one pending '같은 매물 (자동)' report and never blocks.
// The matching itself is pure (shared/listing.ts) and runs in JS over at most PRINTS_READ rows.
import { db, hex, MANAGER_ID } from './http';
import { listingFields, photoKeys, fieldsHashInput, sameListing, postTitleKey, type Print, type ListingFields, type Match } from '../shared/listing';
import type { SeasonTag } from '../shared/market';

const DAY = 86400000;
// The matcher reads the author's newest prints of the same kind, open or gone within 7 days.
export const PRINTS_READ = 300;
export const PRINT_DAYS = 7;
export const AUTO_REPORT = '같은 매물 (자동)';
// An image used by this many members (the author included) is a shared banner or price table: no flag.
const SHARED_IMAGE_OWNERS = 3;

export type UploadHash = { id: string; hash: string | null; src_hash: string | null };
export type NewPrint = Print & { fields_hash: string | null; uploads: UploadHash[] };

const parse = (s: string | null | undefined, fallback: any) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

export async function fieldsHash(f: ListingFields | null) {
    const input = fieldsHashInput(f);
    return input ? hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))).slice(0, 32) : null;
}

// The print of a post being written: details is the stored JSON text, images the upload ids in order,
// uploads the author's upload rows with their hashes.
export async function buildPrint(v: { kind: string; category: string; title: string; details: string; tags: SeasonTag[]; wantedTags: SeasonTag[]; images: string },
    uploads: UploadHash[]): Promise<NewPrint> {
    const fields = listingFields(v.kind, v.category, parse(v.details, {}), v.tags);
    const images: string[] = parse(v.images, []);
    const photos = photoKeys(images, new Map(uploads.map(u => [u.id, u])));
    return { kind: v.kind, category: v.category, title_key: postTitleKey(v.title), fields, photos, fields_hash: await fieldsHash(fields), uploads };
}

export type PrintRow = {
    post_id: number; category: string; title_key: string; fields: string | null; photos: string; anchor_at: number | null; gone_at: number | null;
    gone_hidden: number; gone_reason: string; status: string | null; hidden: number | null; title: string | null; thumb: string | null; price: number | null; price_mode: string | null;
    bumped_at: number | null; created_at: number | null; bump_count: number | null; seller_id: string | null; buyer_id: string | null; removed_at: number | null;
};

// The author's prints of one kind: open ones, and gone ones within 7 days, with the live post (status,
// hidden, place) and the trade recorded on it. Newest PRINTS_READ.
export function printsStatement(userId: string, kind: string, now: number) {
    return db().prepare(`SELECT pp.post_id,pp.category,pp.title_key,pp.fields,pp.photos,pp.anchor_at,pp.gone_at,pp.hidden AS gone_hidden,pp.hidden_reason AS gone_reason,
        p.status,p.hidden,p.title,json_extract(p.images,'$[0]') AS thumb,p.price,p.price_mode,p.bumped_at,p.created_at,p.bump_count,t.seller_id,t.buyer_id,t.removed_at
        FROM post_prints pp LEFT JOIN posts p ON p.id=pp.post_id LEFT JOIN trades t ON t.post_id=pp.post_id
        WHERE pp.user_id=? AND pp.kind=? AND (pp.gone_at IS NULL OR pp.gone_at>?) ORDER BY pp.post_id DESC LIMIT ${PRINTS_READ}`).bind(userId, kind, now - PRINT_DAYS * DAY);
}

const rowPrint = (kind: string, r: PrintRow): Print => ({
    kind, category: r.category,
    // Backfilled rows of posts written before title_key existed take the key from the live title.
    title_key: r.title_key || (r.title ? postTitleKey(r.title) : ''),
    fields: parse(r.fields, null), photos: parse(r.photos, []),
});
const isOpen = (r: PrintRow) => r.gone_at === null && !!r.status && r.status !== 'closed';

// The open (or manager-hidden) post that is the same listing, else the gone listing (completed or
// deleted within 7 days) with the latest place. excludeId leaves out the post being edited.
export function findMatch(p: NewPrint, rows: PrintRow[], excludeId?: number) {
    let open: { row: PrintRow; match: Match } | null = null, gone: { row: PrintRow; match: Match } | null = null;
    for (const row of rows) {
        if (row.post_id === excludeId) continue;
        const live = isOpen(row);
        if (!live && (row.gone_at === null || row.anchor_at === null)) continue;
        if (live && open) continue;
        if (!live && gone && gone.row.anchor_at! >= row.anchor_at!) continue;
        const match = sameListing(p, rowPrint(p.kind, row));
        if (!match) continue;
        if (live) open = { row, match };
        else gone = { row, match };
    }
    return { open, gone };
}

// The cross-account reads (only when the post has photo hashes or a fields hash): other members'
// uploads with one of this post's hashes, with the post each is in and its recorded trade; and other
// members' prints with the same account fields, open or gone within 7 days.
export function crossStatements(p: NewPrint, userId: string, now: number) {
    const keys = [...new Set(p.uploads.flatMap(u => [u.hash, u.src_hash]).filter((v): v is string => !!v))];
    return {
        keys,
        statements: [
            ...keys.length ? [db().prepare(`SELECT u2.owner_id,u2.hash,u2.src_hash,pi.post_id,p.author_id,p.hidden,p.status,t.buyer_id
                FROM uploads u2 LEFT JOIN post_images pi ON pi.upload_id=u2.id LEFT JOIN posts p ON p.id=pi.post_id LEFT JOIN trades t ON t.post_id=p.id AND t.removed_at IS NULL
                WHERE u2.owner_id!=? AND (u2.hash IN (SELECT value FROM json_each(?)) OR u2.src_hash IN (SELECT value FROM json_each(?))) LIMIT 300`)
                .bind(userId, JSON.stringify(keys), JSON.stringify(keys))] : [],
            ...p.fields_hash ? [db().prepare(`SELECT pp.post_id,pp.user_id,pp.hidden AS gone_hidden,p.hidden,t.buyer_id
                FROM post_prints pp LEFT JOIN posts p ON p.id=pp.post_id LEFT JOIN trades t ON t.post_id=pp.post_id AND t.removed_at IS NULL
                WHERE pp.fields_hash=? AND pp.user_id!=? AND (pp.gone_at IS NULL OR pp.gone_at>?) ORDER BY pp.post_id DESC LIMIT 20`)
                .bind(p.fields_hash, userId, now - PRINT_DAYS * DAY)] : [],
        ],
    };
}

type UploadHit = { owner_id: string; hash: string | null; src_hash: string | null; post_id: number | null; author_id: string | null; hidden: number | null; status: string | null; buyer_id: string | null };
type FieldsHit = { post_id: number; user_id: string; gone_hidden: number; hidden: number | null; buyer_id: string | null };

// The report details for the best cross-account hit, or null. Resales (the other post's trade names
// this member as buyer), hidden posts and images used by 3 or more members are left out.
export function crossHit(p: NewPrint, userId: string, results: { keys: string[]; uploads?: UploadHit[]; prints?: FieldsHit[] }) {
    const uploads = results.uploads || [];
    const owners = new Map<string, Set<string>>();
    for (const r of uploads) for (const k of [r.hash, r.src_hash]) if (k && results.keys.includes(k)) {
        if (!owners.has(k)) owners.set(k, new Set([userId]));
        owners.get(k)!.add(r.owner_id);
    }
    const common = (k: string) => (owners.get(k)?.size || 0) >= SHARED_IMAGE_OWNERS;
    const byPost = new Map<number, Set<string>>();
    for (const r of uploads) {
        if (r.post_id === null || r.author_id === null || r.author_id === userId || r.hidden) continue;
        if (r.status === 'closed' && r.buyer_id === userId) continue;
        for (const k of [r.hash, r.src_hash]) if (k && results.keys.includes(k) && !common(k)) {
            if (!byPost.has(r.post_id)) byPost.set(r.post_id, new Set());
            byPost.get(r.post_id)!.add(k);
        }
    }
    let best: { id: number; n: number } | null = null;
    for (const [id, keys] of byPost) {
        const n = p.uploads.filter(u => (u.hash && keys.has(u.hash)) || (u.src_hash && keys.has(u.src_hash))).length;
        if (n && (!best || n > best.n)) best = { id, n };
    }
    if (best) return `다른 회원 글 #${best.id} · 같은 사진 ${best.n}장`;
    const same = (results.prints || []).find(r => !(r.hidden ?? r.gone_hidden) && r.buyer_id !== userId);
    return same ? `다른 회원 글 #${same.post_id} · 같은 계정 정보` : null;
}

// One pending '같은 매물 (자동)' report by the manager about the member, unless one is already pending.
// postSql selects the post id (the new post's lookup, or '?' with the id bound).
export function reportStatement(postSql: string, postArgs: unknown[], userId: string, details: string, now: number) {
    return db().prepare(`INSERT INTO reports(post_id,target_user_id,reporter_id,reason,details,status,created_at)
        SELECT n.id,?,'${MANAGER_ID}','${AUTO_REPORT}',?,'pending',? FROM ${postSql} n WHERE n.id IS NOT NULL AND EXISTS(SELECT 1 FROM users WHERE id='${MANAGER_ID}')
        AND NOT EXISTS(SELECT 1 FROM reports WHERE target_user_id=? AND reason='${AUTO_REPORT}' AND status='pending')`)
        .bind(userId, details, now, ...postArgs, userId);
}

// Writes the print of a post (insert or replace), selected by postSql the same way.
export function printUpsert(postSql: string, postArgs: unknown[], userId: string, p: NewPrint) {
    return db().prepare(`INSERT INTO post_prints(post_id,user_id,kind,category,title_key,fields,fields_hash,photos) SELECT n.id,?,?,?,?,?,?,? FROM ${postSql} n WHERE n.id IS NOT NULL
        ON CONFLICT(post_id) DO UPDATE SET user_id=excluded.user_id,kind=excluded.kind,category=excluded.category,title_key=excluded.title_key,fields=excluded.fields,fields_hash=excluded.fields_hash,photos=excluded.photos`)
        .bind(userId, p.kind, p.category, p.title_key, JSON.stringify(p.fields), p.fields_hash, JSON.stringify(p.photos), ...postArgs);
}

// Whether a relist of this gone listing names a recorded sale of the author's: the trade names the
// author as seller and someone else as buyer.
export const soldTo = (row: PrintRow, userId: string) => row.seller_id === userId && !!row.buyer_id && row.buyer_id !== userId && row.removed_at === null ? row.buyer_id : null;
