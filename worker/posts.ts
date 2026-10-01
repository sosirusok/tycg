import { env } from 'cloudflare:workers';
import { db, fail, currentUser, requireUser, json, body, limit, textField, memberColumns, withMember, setting, WITHDRAWN_NAME } from './http';
import {
    CATEGORIES, TRADE_KINDS, DETAIL_FIELDS, BUYER_DETAIL_FIELDS, ACCOUNT_CHOICES, RECORD_PREFERENCES, NICK_RANKS, SKIN_TAGS,
    FULL_SET, LEGACY_SKELETON, LATEST_SEASON, categoriesForKind, normalizeTrade, validTags, choiceAllowed, skinsForWord, expandSkins,
    type DetailField, type SeasonTag, type User,
} from '../shared/market';
import { perksOf, kstDayStart, titleKey } from '../shared/membership';

const HOUR = 3600000, DAY = 86400000;

// "15:40" on the Korean clock, rounded up to the minute so the time shown is never early.
export function clock(t: number) {
    const d = new Date(Math.ceil(t / 60000) * 60000 + 9 * HOUR);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

// The same-title key. A title with no letters or digits ('!!') keeps its symbols, so it never
// shares the empty key of rows that the daily cleanup has not filled in yet.
export const postTitleKey = (title: string) => titleKey(title) || '#' + title.normalize('NFKC').replace(/\s+/g, '');

// Test only: POST_LIMITS=relaxed lifts the open-post, daily-post and same-title caps, and only for
// requests to 127.0.0.1 or localhost, so the API suites can create many posts. Bump caps still apply.
function relaxedLimits(req: Request) {
    const host = new URL(req.url).hostname;
    return (env as Partial<Env>).POST_LIMITS === 'relaxed' && (host === '127.0.0.1' || host === 'localhost');
}

export const postSelect = `SELECT p.*,u.nickname,u.role,u.deleted_at AS author_deleted_at,${memberColumns('u', 'author_')} FROM posts p JOIN users u ON u.id=p.author_id`;

export const parse = (s: string, fallback: any) => { try { return JSON.parse(s); } catch { return fallback; } };

export async function latestSeason() {
    const v = Number(await setting('latest_season'));
    return Number.isInteger(v) && v >= LATEST_SEASON && v <= 200 ? v : LATEST_SEASON;
}

async function rawPost(id: string | number) { return db().prepare(postSelect + ' WHERE p.id=?').bind(id).first<any>(); }

// Other members get 404 for a post the manager hid, and for a 대리(진행) post whose author
// no longer holds 대리 인증 (the board list uses the same rule). The author and the manager still see both.
export async function visiblePost(id: unknown, u: User | null) {
    if (typeof id !== 'string' && typeof id !== 'number') fail(404, '게시글을 찾을 수 없습니다.');
    const p = await rawPost(id);
    const privileged = !!p && (p.author_id === u?.id || u?.role === 'manager');
    const lostProxy = !!p && p.kind === 'proxy_offer' && p.role !== 'manager' && !parse(p.author_badges_json, []).includes('proxy');
    if (!p || !privileged && (p.hidden || lostProxy)) fail(404, '게시글을 찾을 수 없습니다.');
    return p;
}

type Viewer = Pick<User, 'id' | 'role'> | null | undefined;

// The struck prices shown: only strictly falling prices above the current one (60, 50, 40 shows
// ~~60~~ ~~50~~ 40). The Worker stores history that way already; this read-time filter also covers
// rows the previous Worker recorded (it kept rises too), without deleting anything in a migration.
export function shownPriceHistory(history: { price: number; changed_at: number }[], price: number | null) {
    const kept: typeof history = [];
    let floor = price ?? -Infinity;
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].price > floor) { kept.unshift(history[i]); floor = history[i].price; }
    }
    return kept;
}

export async function decorate(rows: any[], viewer?: Viewer) {
    if (!rows.length) return [];
    const ids = JSON.stringify(rows.map(p => p.id));
    const [tags, wantedTags, favs, histories] = await db().batch([
        db().prepare('SELECT post_id,tier,season FROM post_seasons WHERE post_id IN (SELECT value FROM json_each(?)) ORDER BY season DESC').bind(ids),
        db().prepare('SELECT post_id,tier,season FROM post_wanted_seasons WHERE post_id IN (SELECT value FROM json_each(?)) ORDER BY season DESC').bind(ids),
        db().prepare('SELECT post_id FROM favorites WHERE user_id=? AND post_id IN (SELECT value FROM json_each(?))').bind(viewer?.id || '', ids),
        db().prepare('SELECT post_id,price,changed_at FROM post_price_history WHERE post_id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(ids),
    ]);
    return rows.map(row => {
        const p = withMember(row, 'author_');
        // When a 6-month grade ends is private to the member and the manager.
        delete p.author_grade_expires_at;
        // Why the manager hid a post is shown to its author and the manager only.
        if (p.author_id !== viewer?.id && viewer?.role !== 'manager') delete p.hidden_reason;
        const featured = p.featured_at !== null && p.featured_at !== undefined;
        delete p.featured_at;
        delete p.title_key;
        // A withdrawn author is shown as plain 탈퇴회원 (the stored nickname has a random suffix).
        const authorDeleted = !!p.author_deleted_at;
        delete p.author_deleted_at;
        if (authorDeleted) p.nickname = WITHDRAWN_NAME;
        return {
            ...p, ...normalizeTrade(p.kind, p.category),
            price_mode: p.price_mode === 'legacy' ? (p.price === null ? 'negotiate' : 'fixed') : p.price_mode,
            details: parse(p.details, {}), images: parse(p.images, []),
            tags: tags.results.filter((t: any) => t.post_id === p.id).map((t: any) => ({ tier: t.tier, season: t.season })),
            wanted_tags: wantedTags.results.filter((t: any) => t.post_id === p.id).map((t: any) => ({ tier: t.tier, season: t.season })),
            favorite: favs.results.some((f: any) => f.post_id === p.id),
            price_history: p.kind === 'sell' ? shownPriceHistory(histories.results.filter((h: any) => h.post_id === p.id).map((h: any) => ({ price: h.price, changed_at: h.changed_at })), p.price) : [],
            featured,
            author_deleted: authorDeleted,
        };
    });
}

// Price history holds only strictly falling prices above the current one: edits 60, 50, 40 show
// ~~60~~ ~~50~~ 40, and a rise drops the entries at or below the new price. Both statements go
// before the posts UPDATE in the same batch (D1 batches are transactional), so the INSERT reads the
// actual previous price and concurrent edits never record a stale client value.
export function priceHistoryStatements(postId: number, newKind: string, newPrice: number | null, now: number) {
    return [
        // Also runs when the old price was 가격 제시 (null), so no struck entry equals the new price.
        ...newKind === 'sell' && newPrice !== null ? [db().prepare('DELETE FROM post_price_history WHERE post_id=? AND price<=?').bind(postId, newPrice)] : [],
        db().prepare("INSERT INTO post_price_history(post_id,price,changed_at) SELECT id,price,? FROM posts WHERE id=? AND kind='sell' AND ?='sell' AND price IS NOT NULL AND ? IS NOT NULL AND price>?")
            .bind(now, postId, newKind, newPrice, newPrice),
    ];
}

// Offers a status change ends: 거래완료 ends the pending offers and keeps the accepted one (the deal
// happened); back to 거래중 ends the accepted one (the deal fell through) and keeps the pending ones.
// 예약중 ends none. Bind the new status twice.
export const STATUS_ENDS_OFFERS = "((status='pending' AND ?='closed') OR (status='accepted' AND ?='open'))";
export const OFFERS_ENDED_TEXT = '글 상태가 바뀌어 제시가 마감되었습니다.';

// Cancels the post's offers that match `condition` and leaves a notice in each of their chats.
// The notice and the chat bump come first, because they select the offers the UPDATE then cancels.
// The post author sends the notice: they are a member of every such chat, also when the manager hides the post.
export function endOffersStatements(postId: number, authorId: string, condition: string, args: unknown[], now: number) {
    return [
        db().prepare(`INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) SELECT DISTINCT conversation_id,?,?,'system',NULL,'[]',? FROM offers WHERE post_id=? AND ${condition}`)
            .bind(authorId, OFFERS_ENDED_TEXT, now, postId, ...args),
        db().prepare(`UPDATE conversations SET updated_at=? WHERE id IN (SELECT conversation_id FROM offers WHERE post_id=? AND ${condition})`).bind(now, postId, ...args),
        db().prepare(`UPDATE offers SET status='cancelled',updated_at=? WHERE post_id=? AND ${condition}`).bind(now, postId, ...args),
    ];
}

export function amount(v: any, optional = true) {
    if (v === null || v === '' || v === undefined) {
        if (optional) return null;
        fail(400, '가격을 입력해 주세요.');
    }
    if ((typeof v !== 'number' && typeof v !== 'string') || (typeof v === 'string' && !/^\d+$/.test(v.trim()))) fail(400, '가격은 숫자로 입력해 주세요.');
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0 || n > 1000000000) fail(400, '가격은 0~10억 원의 정수로 입력해 주세요.');
    return n;
}

function numericDetail(details: Record<string, string>, key: string, label: string, min: number, max: number) {
    if (!details[key]) return;
    if (!/^\d+$/.test(details[key]) || Number(details[key]) < min || Number(details[key]) > max) fail(400, `${label}: ${min}~${max} 사이 숫자로 입력해 주세요.`);
    details[key] = String(Number(details[key]));
}

function selectedDetails(details: Record<string, string>, key: string, allowed: readonly string[], label: string, includeLegacySet = false) {
    if (!details[key]) return;
    const chosen = parse(details[key], null);
    if (!Array.isArray(chosen) || chosen.length > allowed.length || chosen.some(v => typeof v !== 'string' || !allowed.includes(v))) fail(400, `${label}: 확인해 주세요.`);
    if (includeLegacySet && chosen.includes(FULL_SET) && !chosen.includes(LEGACY_SKELETON)) chosen.push(LEGACY_SKELETON);
    details[key] = JSON.stringify([...new Set(chosen)]);
}

// Error labels come from the same field lists the editor shows, so they cannot drift apart.
const fieldLabel = (fields: DetailField[], id: string) => fields.find(f => f.id === id)?.label || id;

function validateBuyerDetails(details: Record<string, string>, prefix = '') {
    const key = (name: string) => prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name;
    const label = (name: string) => fieldLabel(BUYER_DETAIL_FIELDS, name);
    numericDetail(details, key('maxOwners'), label('maxOwners'), 1, 9999);
    numericDetail(details, key('nicknameCharsMin'), label('nicknameCharsMin'), 1, 20);
    numericDetail(details, key('nicknameCharsMax'), label('nicknameCharsMax'), 1, 20);
    if (details[key('nicknameCharsMin')] && details[key('nicknameCharsMax')] && Number(details[key('nicknameCharsMin')]) > Number(details[key('nicknameCharsMax')]))
        fail(400, '닉네임 최소 글자 수가 최대 글자 수보다 클 수 없습니다.');
    if (details[key('recordPreference')] && !RECORD_PREFERENCES.includes(details[key('recordPreference')] as typeof RECORD_PREFERENCES[number]))
        fail(400, `${label('recordPreference')}: 확인해 주세요.`);
    selectedDetails(details, key('nicknameRanks'), NICK_RANKS, label('nicknameRanks'));
    selectedDetails(details, key('skinTags'), SKIN_TAGS, label('skinTags'), true);
}

export const canOfferProxy = (u: User) => u.role === 'manager' || u.badges.includes('proxy');
const uniqueTags = (list: SeasonTag[]) => [...new Map(list.map(t => [t.tier + ':' + t.season, { tier: t.tier, season: t.season }])).values()];

// SQL filter for one season table: any (or all) of the chosen tier-season pairs.
function seasonFilter(table: string, tags: SeasonTag[], all: boolean) {
    return (all ? '(SELECT COUNT(*)' : 'EXISTS (SELECT 1') + ` FROM ${table} s JOIN json_each(?) j ON s.tier=json_extract(j.value,'$.tier') AND s.season=json_extract(j.value,'$.season') WHERE s.post_id=p.id)` + (all ? '=' + tags.length : '');
}

async function validatePost(b: any, u: User, existing?: any) {
    const title = textField(b.title, 2, 100, '제목'), content = textField(b.body, 1, 10000, '내용');
    if (!TRADE_KINDS.includes(b.kind)) fail(400, '거래 구분을 선택해 주세요.');
    const category = b.category || categoriesForKind(b.kind)[0].id;
    if (!categoriesForKind(b.kind).some(c => c.id === category)) fail(400, '세부 분류를 선택해 주세요.');
    // 대리(진행) is limited to members with 대리 인증, for new posts and for edits.
    if (b.kind === 'proxy_offer' && !canOfferProxy(u)) fail(403, '대리(진행) 글은 대리 인증 회원만 쓸 수 있습니다.');
    const latest = await latestSeason();
    if (!validTags(b.tags, latest)) fail(400, '티어와 시즌을 확인해 주세요.');
    const tags = category === 'account' || category === 'ladder' ? uniqueTags(b.tags) : [];
    const wantedRaw = b.wantedTags ?? [];
    if (!validTags(wantedRaw, latest)) fail(400, '원하는 래더의 티어와 시즌을 확인해 주세요.');
    const wantedTags = b.kind === 'exchange' && b.details?.wantedCategory === 'account' ? uniqueTags(wantedRaw) : [];
    // Price meaning is determined by the trade kind, never by a stale form's mode.
    const price = b.kind === 'exchange' ? null : amount(b.price);
    if (b.kind === 'sell' && price !== null && price < 1000) fail(400, '즉거가는 1,000원 이상입니다.');
    const mode = price !== null ? 'fixed' : b.kind === 'sell' ? 'offer' : 'negotiate';
    const details: Record<string, string> = {};
    let fields: DetailField[] = category === 'account' && b.kind === 'buy' ? BUYER_DETAIL_FIELDS : DETAIL_FIELDS[category];
    if (b.kind === 'exchange') {
        if (!['account', 'clan'].includes(b.details?.wantedCategory)) fail(400, '구하는 교환 대상을 선택해 주세요.');
        fields = [...fields, { id: 'wantedCategory', label: '구하는 대상' }];
        if (b.details.wantedCategory === 'account') fields = [...fields, ...BUYER_DETAIL_FIELDS.map(f => ({ ...f, id: 'wanted' + f.id[0].toUpperCase() + f.id.slice(1) }))];
    }
    if (b.kind === 'sell') fields = [...fields, { id: 'currentOffer', label: '현젯', type: 'number' }];
    for (const f of fields) {
        const raw = b.details?.[f.id];
        if (raw === undefined || raw === '') continue;
        if (typeof raw !== 'string' || raw.length > 500) fail(400, `${f.label}: 500자 이내로 입력해 주세요.`);
        const v = raw.trim();
        if (!v) continue;
        details[f.id] = v;
    }
    if (category === 'account' && b.kind !== 'buy') {
        for (const [key, f] of Object.entries(ACCOUNT_CHOICES)) {
            if (details[key] && !choiceAllowed(key, details[key])) fail(400, `${f.label}: 확인해 주세요.`);
        }
        const label = (id: string) => fieldLabel(DETAIL_FIELDS.account, id);
        numericDetail(details, 'ownerCount', label('ownerCount'), 1, 9999);
        numericDetail(details, 'nicknameChars', label('nicknameChars'), 1, 20);
        numericDetail(details, 'phantom', label('phantom'), 0, 5000);
        selectedDetails(details, 'skinTags', SKIN_TAGS, label('skinTags'), true);
    }
    if (category === 'account' && b.kind === 'buy') validateBuyerDetails(details);
    if (b.kind === 'exchange' && details.wantedCategory === 'account') validateBuyerDetails(details, 'wanted');
    // Runs after the range checks above so a bounded field reports its own range.
    for (const f of fields) {
        if (f.type === 'number' && details[f.id] && (!/^\d+$/.test(details[f.id]) || Number(details[f.id]) > 1000000000)) fail(400, `${f.label}: 숫자로 입력해 주세요.`);
    }
    if (details.currentOffer) details.currentOffer = String(amount(details.currentOffer, false));
    if (details.currentOffer && Number(details.currentOffer) < 1000) fail(400, '현젯은 1,000원 이상입니다.');
    if (b.kind === 'sell' && price !== null && details.currentOffer && Number(details.currentOffer) >= price) fail(400, '현젯은 즉거가보다 낮게 입력해 주세요.');
    // This retired free-text field has no input anymore. Keep the seller's original data on edits.
    if (category === 'account' && b.kind !== 'buy' && existing?.category === 'account') {
        const legacySkins = parse(existing.details, {}).rareSkins;
        if (typeof legacySkins === 'string' && legacySkins) details.rareSkins = legacySkins;
    }
    const images = b.images || [];
    if (!Array.isArray(images) || images.some(x => typeof x !== 'string') || new Set(images).size !== images.length) fail(400, '사진을 확인해 주세요.');
    // The cap follows the author's grade; an edit may keep the photos a post already has after a grade ends.
    const maxPhotos = Math.max(perksOf(u).photos, existing ? parse(existing.images, []).length : 0);
    if (images.length > maxPhotos) fail(400, `사진은 한 글에 ${maxPhotos}장까지입니다.`);
    if (images.length) {
        const r = await db().prepare('SELECT id FROM uploads WHERE owner_id=? AND id IN(SELECT value FROM json_each(?))').bind(u.id, JSON.stringify(images)).all();
        if (r.results.length !== images.length) fail(403, '본인이 올린 사진만 쓸 수 있습니다.');
    }
    const status = b.status || 'open';
    if (!['open', 'reserved', 'closed'].includes(status)) fail(400, '거래 상태를 확인해 주세요.');
    return { kind: b.kind, title, content, category, tags, wantedTags, price, mode, details: JSON.stringify(details), images: JSON.stringify(images), status, accepts: b.kind === 'sell' && (b.accepts_offers || mode === 'offer') ? 1 : 0 };
}

// Promoted posts shown now: open, not hidden, bumped in the last 72 hours and within the author's
// slots for their grade when the list is read (프리미엄 1, 엘리트 and above 3, the manager 3), newest
// featured first. A grade that ended loses its slots at once; nothing is deleted.
function featuredCte(now: number) {
    return {
        sql: `WITH f AS (SELECT p.id,ROW_NUMBER() OVER (PARTITION BY p.author_id ORDER BY p.featured_at DESC) AS n,
            CASE WHEN u.role='manager' THEN 3 ELSE (SELECT MAX(g.rank) FROM user_grades g WHERE g.user_id=p.author_id AND (g.expires_at IS NULL OR g.expires_at>?)) END AS r
            FROM posts p JOIN users u ON u.id=p.author_id WHERE p.featured_at IS NOT NULL AND p.status='open' AND p.hidden=0 AND p.bumped_at>?),
            shown AS (SELECT id,r FROM f WHERE n<=CASE WHEN r>=3 THEN 3 WHEN r=2 THEN 1 ELSE 0 END) `,
        args: [now, now - 72 * HOUR],
    };
}

// Posts the previous Worker wrote during a deploy have bumped_at=0 and would sort last. For the
// first hour of each isolate, every list copies created_at into them first, in the same batch as the
// list (an indexed UPDATE that usually changes nothing), so rows the previous Worker writes while
// both versions still serve are covered too. The daily cleanup does the same.
let isolateStart = 0;
function bumpBackfill(now: number) {
    isolateStart ||= now;
    return now - isolateStart < HOUR ? [db().prepare('UPDATE posts SET bumped_at=created_at WHERE bumped_at=0')] : [];
}

async function listPosts(req: Request, url: URL) {
    const backfill = bumpBackfill(Date.now());
    const u = await currentUser(req), s = url.searchParams, where: string[] = [], values: any[] = [];
    const author = s.get('author');
    // Authors see their own hidden posts in their own list; nobody else sees hidden posts in a list.
    if (!u || author !== u.id) where.push('p.hidden=0');
    for (const [param, col, allowed] of [['kind', 'kind', TRADE_KINDS], ['category', 'category', CATEGORIES.map(c => c.id)], ['status', 'status', ['open', 'reserved', 'closed']]] as [string, string, string[]][]) {
        const v = s.get(param);
        if (v && allowed.includes(v)) { where.push('p.' + col + '=?'); values.push(v); }
    }
    if (author) { where.push('p.author_id=?'); values.push(author); }
    // Boards skip the authors the viewer blocked; a blocked member's profile still lists their posts.
    else if (u) { where.push('p.author_id NOT IN (SELECT target_id FROM blocks WHERE user_id=?)'); values.push(u.id); }
    // 대리(진행) posts are listed only while the author holds 대리 인증 (authors still see their own).
    where.push("(p.kind!='proxy_offer' OR u.role='manager' OR p.author_id=? OR EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=p.author_id AND b.badge='proxy'))");
    values.push(u?.id || '');
    if (s.get('active') === '1') where.push("p.status!='closed'");
    if (s.get('mode') && ['fixed', 'offer', 'negotiate'].includes(s.get('mode')!)) {
        where.push("(CASE WHEN p.price_mode='legacy' THEN CASE WHEN p.price IS NULL THEN 'negotiate' ELSE 'fixed' END ELSE p.price_mode END)=?");
        values.push(s.get('mode'));
    }
    const q = s.get('q')?.trim().slice(0, 100);
    if (q) {
        // A skin's short name or in-game name (악주, 뱀동, 악몽의 주인 …) also finds posts that list that skin.
        const skins = skinsForWord(q);
        where.push("(instr(lower(p.title),lower(?))>0 OR instr(lower(p.body),lower(?))>0 OR instr(lower(replace(p.details,' ','')),lower(replace(?,' ','')))>0 OR instr(lower(u.nickname),lower(?))>0"
            + (skins.length ? " OR EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(p.details,'$.skinTags'),'[]')) own JOIN json_each(?) w ON own.value=w.value) OR EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(p.details,'$.wantedSkinTags'),'[]')) own JOIN json_each(?) w ON own.value=w.value)" : '') + ')');
        values.push(q, q, q, q);
        if (skins.length) values.push(JSON.stringify(skins), JSON.stringify(skins));
    }
    for (const [key, op] of [['min', '>='], ['max', '<=']]) {
        const n = s.get(key);
        if (n !== null && n !== '') { where.push('p.price' + op + '?'); values.push(amount(n, false)); }
    }
    const queryInteger = (key: string, min: number, max: number) => {
        const value = s.get(key);
        if (value === null || value === '') return null;
        if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) fail(400, '숫자 검색 조건을 확인해 주세요.');
        return Number(value);
    };
    // Minimums for account numbers. A bad value is a search error, never the price message.
    for (const [key, path, max] of [['level', 'level', 999], ['skins', 'humanSkins', 9999], ['gas', 'gas', 1000000000], ['minerals', 'minerals', 1000000000], ['phantom', 'phantom', 5000]] as [string, string, number][]) {
        const n = queryInteger(key, 0, max);
        if (n !== null) { where.push(`CAST(json_extract(p.details,'$.${path}') AS INTEGER)>=?`); values.push(n); }
    }
    const buying = s.get('kind') === 'buy';
    const nicknameChars = queryInteger('nicknameChars', 1, 20);
    if (nicknameChars !== null) {
        if (buying) {
            where.push("(json_extract(p.details,'$.nicknameCharsMin') IS NULL OR CAST(json_extract(p.details,'$.nicknameCharsMin') AS INTEGER)<=?) AND (json_extract(p.details,'$.nicknameCharsMax') IS NULL OR CAST(json_extract(p.details,'$.nicknameCharsMax') AS INTEGER)>=?)");
            values.push(nicknameChars, nicknameChars);
        } else {
            where.push("CAST(json_extract(p.details,'$.nicknameChars') AS INTEGER)=?");
            values.push(nicknameChars);
        }
    }
    const maxOwners = queryInteger('maxOwners', 1, 9999);
    if (maxOwners !== null) { where.push("CAST(json_extract(p.details,'$.ownerCount') AS INTEGER)<=?"); values.push(maxOwners); }
    const ownerCountOfMine = queryInteger('ownerCountOfMine', 1, 9999);
    if (ownerCountOfMine !== null) { where.push("(json_extract(p.details,'$.maxOwners') IS NULL OR CAST(json_extract(p.details,'$.maxOwners') AS INTEGER)>=?)"); values.push(ownerCountOfMine); }
    for (const [key, f] of Object.entries(ACCOUNT_CHOICES)) {
        const v = s.get(key);
        if (!v) continue;
        if (!choiceAllowed(key, v)) fail(400, `${f.label}: 확인해 주세요.`);
        if (buying && key === 'nicknameRank') where.push("(json_array_length(COALESCE(json_extract(p.details,'$.nicknameRanks'),'[]'))=0 OR EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(p.details,'$.nicknameRanks'),'[]')) WHERE value=?))");
        // 전변 가능 also finds 영전 accounts: the number goes with the account, so it can be changed.
        else if (key === 'phoneChange' && v === '가능') where.push(`json_extract(p.details,'$.phoneChange') IN (?,'영전')`);
        else where.push(`json_extract(p.details,'$.${key}')=?`);
        values.push(v);
    }
    for (const key of ['recordPreference', 'wantedRecordPreference']) {
        const v = s.get(key);
        if (!v) continue;
        if (!RECORD_PREFERENCES.includes(v as typeof RECORD_PREFERENCES[number])) fail(400, '전적 검색 조건을 확인해 주세요.');
        where.push(`json_extract(p.details,'$.${key}')=?`);
        values.push(v);
    }
    // "My account" record: 전적 있음 fits buyers who chose 전적 있어도 괜찮음 or left the record empty;
    // 무전적 fits every buyer, so it adds no condition. myRecord is for 구매, wantedMyRecord for 교환.
    for (const [param, key] of [['myRecord', 'recordPreference'], ['wantedMyRecord', 'wantedRecordPreference']]) {
        const v = s.get(param);
        if (!v) continue;
        if (v !== '무전적' && v !== '전적 있음') fail(400, '전적 검색 조건을 확인해 주세요.');
        if (v === '전적 있음') {
            where.push(`(json_extract(p.details,'$.${key}') IS NULL OR json_extract(p.details,'$.${key}')='' OR json_extract(p.details,'$.${key}')=?)`);
            values.push(RECORD_PREFERENCES[1]);
        }
    }
    const wantedCategory = s.get('wantedCategory');
    if (wantedCategory) {
        if (!['account', 'clan'].includes(wantedCategory)) fail(400, '구하는 교환 대상을 확인해 주세요.');
        where.push("json_extract(p.details,'$.wantedCategory')=?");
        values.push(wantedCategory);
    }
    // "My account" filters for the wanted side of an exchange, with the same meaning as on 구매.
    const wantedOwners = queryInteger('wantedOwnerCountOfMine', 1, 9999);
    if (wantedOwners !== null) { where.push("(json_extract(p.details,'$.wantedMaxOwners') IS NULL OR CAST(json_extract(p.details,'$.wantedMaxOwners') AS INTEGER)>=?)"); values.push(wantedOwners); }
    const wantedChars = queryInteger('wantedNicknameChars', 1, 20);
    if (wantedChars !== null) {
        where.push("(json_extract(p.details,'$.wantedNicknameCharsMin') IS NULL OR CAST(json_extract(p.details,'$.wantedNicknameCharsMin') AS INTEGER)<=?) AND (json_extract(p.details,'$.wantedNicknameCharsMax') IS NULL OR CAST(json_extract(p.details,'$.wantedNicknameCharsMax') AS INTEGER)>=?)");
        values.push(wantedChars, wantedChars);
    }
    const wantedRank = s.get('wantedNicknameRank');
    if (wantedRank) {
        if (!NICK_RANKS.includes(wantedRank as typeof NICK_RANKS[number])) fail(400, '닉 등급 검색 조건을 확인해 주세요.');
        where.push("(json_array_length(COALESCE(json_extract(p.details,'$.wantedNicknameRanks'),'[]'))=0 OR EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(p.details,'$.wantedNicknameRanks'),'[]')) WHERE value=?))");
        values.push(wantedRank);
    }
    for (const key of ['skinTags', 'wantedSkinTags', 'nicknameRanks', 'wantedNicknameRanks']) {
        if (!s.get(key)) continue;
        const chosen = parse(s.get(key)!, null), allowed: readonly string[] = key.endsWith('SkinTags') || key === 'skinTags' ? SKIN_TAGS : NICK_RANKS;
        if (!Array.isArray(chosen) || chosen.length > allowed.length || chosen.some(v => typeof v !== 'string' || !allowed.includes(v))) fail(400, '선택한 검색 조건을 확인해 주세요.');
        if (chosen.length) {
            where.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(p.details,'$.${key}'),'[]')) selected JOIN json_each(?) wanted ON selected.value=wanted.value)`);
            values.push(JSON.stringify(allowed === SKIN_TAGS ? expandSkins(chosen) : chosen));
        }
    }
    for (const [param, table] of [['tags', 'post_seasons'], ['wantedTags', 'post_wanted_seasons']]) {
        const raw = s.get(param);
        if (!raw) continue;
        const tags = parse(raw, null);
        if (!validTags(tags, await latestSeason())) fail(400, '검색 시즌을 확인해 주세요.');
        const unique = uniqueTags(tags);
        if (unique.length) {
            where.push(seasonFilter(table, unique, param === 'tags' && s.get('match') === 'all'));
            values.push(JSON.stringify(unique));
        }
    }
    const badge = s.get('badge');
    if (badge && ['proxy', 'identity', 'credit'].includes(badge)) {
        where.push('EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id=p.author_id AND b.badge=?)');
        values.push(badge);
    }
    const scope = s.get('scope');
    if (scope === 'favorites' || scope === 'recent') {
        if (!u) fail(401, '로그인이 필요합니다.');
        where.push(`p.id IN(SELECT post_id FROM ${scope === 'favorites' ? 'favorites' : 'history'} WHERE user_id=?)`);
        values.push(u.id);
    }
    // 최신순 follows 끌올; created_at stays the time the post was written.
    const sort = s.get('sort');
    let order = sort === 'price-low' ? 'p.price IS NULL,p.price ASC' : sort === 'price-high' ? 'p.price IS NULL,p.price DESC' : 'p.bumped_at DESC';
    if (scope === 'recent') order = '(SELECT created_at FROM history WHERE post_id=p.id AND user_id=?) DESC';
    const size = Math.max(1, Math.min(40, Math.floor(Number(s.get('size')) || 16)));
    const clause = ' WHERE ' + where.join(' AND '), page = Math.max(1, Math.min(10000, Math.floor(Number(s.get('page')) || 1)));
    const cte = featuredCte(Date.now());
    // Home '추천 매물': featured posts of 엘리트 and above across every tab, with the same hidden,
    // block and 대리 인증 rules as the boards.
    if (s.get('featured') === 'home') {
        const r = (await db().batch([...backfill, db().prepare(cte.sql + postSelect + clause + ' AND p.id IN (SELECT id FROM shown WHERE r>=3) ORDER BY p.bumped_at DESC,p.id DESC LIMIT ?').bind(...cte.args, ...values, Math.min(size, 6))])).at(-1)!;
        return json({ posts: await decorate(r.results, u), total: r.results.length, page: 1, size });
    }
    // Board '프리미엄 매물' box: page 1 of a tab in 최신순, with the page's own filters. The same
    // posts stay in the list, so counts and paging do not change.
    const withFeatured = page === 1 && (!sort || sort === 'latest') && TRADE_KINDS.includes(s.get('kind') as typeof TRADE_KINDS[number]) && !author && !scope;
    // A search across every tab also returns how many results each tab has.
    const withCounts = !!q && !TRADE_KINDS.includes(s.get('kind') as typeof TRADE_KINDS[number]);
    const r = (await db().batch([
        ...backfill,
        db().prepare('SELECT COUNT(*) AS count FROM posts p JOIN users u ON u.id=p.author_id' + clause).bind(...values),
        db().prepare(postSelect + clause + ' ORDER BY ' + order + ',p.id DESC LIMIT ? OFFSET ?').bind(...values, ...(scope === 'recent' ? [u!.id] : []), size, (page - 1) * size),
        ...withCounts ? [db().prepare('SELECT p.kind,COUNT(*) AS count FROM posts p JOIN users u ON u.id=p.author_id' + clause + ' GROUP BY p.kind').bind(...values)] : [],
        ...withFeatured ? [db().prepare(cte.sql + postSelect + clause + ' AND p.id IN (SELECT id FROM shown) ORDER BY p.bumped_at DESC,p.id DESC LIMIT 3').bind(...cte.args, ...values)] : [],
    ])).slice(backfill.length);
    const counts = withCounts ? Object.fromEntries(TRADE_KINDS.map(k => [k, (r[2].results as any[]).find(row => row.kind === k)?.count || 0])) : undefined;
    const featured = withFeatured ? await decorate(r[r.length - 1].results, u) : undefined;
    return json({ posts: await decorate(r[1].results, u), total: (r[0].results[0] as any).count, page, size, ...counts ? { counts } : {}, ...featured ? { featured } : {} });
}

// 끌올: moves an open post to the top of 최신순. The gap per post and the daily count (all of the
// member's posts, reset at KST midnight) are checked inside the UPDATE, so parallel taps cannot pass
// the caps. The manager has neither cap.
async function bumpPost(u: User, post: any) {
    if (post.kind === 'proxy_offer' && !canOfferProxy(u)) fail(403, '대리(진행) 글은 대리 인증 회원만 끌올할 수 있습니다.');
    const perks = perksOf(u), now = Date.now(), dayStart = kstDayStart(now), gapMs = perks.bumpGapHours * HOUR;
    const capped = Number.isFinite(perks.bumpsPerDay);
    const today = "(SELECT COUNT(*) FROM post_events WHERE user_id=? AND kind='bump' AND created_at>=?)";
    const r = await db().batch([
        db().prepare(`UPDATE posts SET bumped_at=?,bump_count=bump_count+1 WHERE id=? AND author_id=? AND status='open' AND hidden=0 AND bumped_at<=?${capped ? ` AND ${today}<?` : ''}`)
            .bind(now, post.id, u.id, now - gapMs, ...capped ? [u.id, dayStart, perks.bumpsPerDay] : []),
        db().prepare("INSERT INTO post_events(user_id,post_id,kind,created_at) SELECT ?,?,'bump',? WHERE EXISTS(SELECT 1 FROM posts WHERE id=? AND bumped_at=?)").bind(u.id, post.id, now, post.id, now),
        db().prepare(`SELECT ${today} AS n`).bind(u.id, dayStart),
    ]);
    if (!r[0].meta.changes) {
        const row = await db().prepare(`SELECT status,hidden,bumped_at,${today} AS n FROM posts WHERE id=?`).bind(u.id, dayStart, post.id).first<any>();
        if (!row || row.status !== 'open' || row.hidden) fail(409, '거래중인 글만 끌올할 수 있습니다.');
        if (row.bumped_at > now - gapMs) fail(429, `같은 글은 ${perks.bumpGapHours}시간마다 끌올할 수 있습니다. (${clock(row.bumped_at + gapMs)}부터 가능)`);
        if (capped && row.n >= perks.bumpsPerDay) fail(429, `오늘 끌올 ${perks.bumpsPerDay}번을 모두 썼습니다. 자정에 초기화됩니다.`);
        fail(429, '잠시 후 다시 시도해 주세요.');
    }
    const used = Number((r[2].results[0] as any)?.n) || 0;
    return json({
        bumpedAt: now, bumpsLeft: capped ? Math.max(0, perks.bumpsPerDay - used) : null, bumpsPerDay: capped ? perks.bumpsPerDay : null,
        nextBumpAt: now + gapMs, resetAt: dayStart + DAY,
    });
}

// 게시판 상단 노출 on or off. Turning one on while every slot is used drops the author's oldest
// featured posts in the same batch. Only open, non-hidden posts use a slot: a 예약중 or hidden post
// keeps its featured_at and returns to the box when it is 거래중 again (if a slot is free then).
// Which featured posts are shown is decided when lists are read (featuredCte), against the
// author's grade at that time.
export const FEATURED_MINE = "author_id=? AND featured_at IS NOT NULL AND status='open' AND hidden=0";
async function featurePost(req: Request, u: User, post: any) {
    const b = await body(req), perks = perksOf(u), now = Date.now(), active = !!b.active;
    const mine = FEATURED_MINE;
    if (active) {
        if (!perks.boardSlots) fail(403, '게시판 상단 노출은 프리미엄부터 가능합니다.');
        if (post.kind === 'proxy_offer' && !canOfferProxy(u)) fail(403, '대리(진행) 글은 대리 인증 회원만 상단에 노출할 수 있습니다.');
        if (post.status !== 'open' || post.hidden) fail(409, '거래중인 글만 상단에 노출할 수 있습니다.');
    }
    const dropped = active
        ? (await db().prepare(`SELECT id,title FROM posts WHERE ${mine} AND id!=? ORDER BY featured_at DESC LIMIT -1 OFFSET ?`).bind(u.id, post.id, perks.boardSlots - 1).all<{ id: number; title: string }>()).results
        : [];
    const openNow = "EXISTS(SELECT 1 FROM posts WHERE id=? AND status='open' AND hidden=0)";
    const r = await db().batch([
        ...dropped.length ? [db().prepare(`UPDATE posts SET featured_at=NULL WHERE id IN (SELECT value FROM json_each(?)) AND ${openNow}`).bind(JSON.stringify(dropped.map(d => d.id)), post.id)] : [],
        active ? db().prepare(`UPDATE posts SET featured_at=? WHERE id=? AND ${openNow}`).bind(now, post.id, post.id) : db().prepare('UPDATE posts SET featured_at=NULL WHERE id=?').bind(post.id),
        db().prepare(`SELECT COUNT(*) AS n FROM posts WHERE ${mine}`).bind(u.id),
    ]);
    if (active && !r[r.length - 2].meta.changes) fail(409, '거래중인 글만 상단에 노출할 수 있습니다.');
    return json({
        featured: active, slots: perks.boardSlots, used: Number((r[r.length - 1].results[0] as any)?.n) || 0,
        replaced: dropped.length ? { id: dropped[0].id, title: dropped[0].title } : null,
    });
}

// Quick 즉거가 and 현젯 change for a 판매 post, without the editor. It never bumps the post.
// currentOffer '' or null removes 현젯.
async function patchPrice(req: Request, u: User, post: any) {
    if (post.kind !== 'sell') fail(400, '판매 글만 가격을 수정할 수 있습니다.');
    const b = await body(req), now = Date.now();
    const hasPrice = b.price !== undefined, hasOffer = b.currentOffer !== undefined;
    if (!hasPrice && !hasOffer) fail(400, '가격을 입력해 주세요.');
    const price: number | null = hasPrice ? amount(b.price, false) : post.price;
    if (hasPrice && price! < 1000) fail(400, '즉거가는 1,000원 이상입니다.');
    const stored = parse(post.details, {}).currentOffer;
    const offer: number | null = hasOffer ? (b.currentOffer === '' || b.currentOffer === null ? null : amount(b.currentOffer, false)) : stored ? Number(stored) : null;
    if (hasOffer && offer !== null && offer < 1000) fail(400, '현젯은 1,000원 이상입니다.');
    if (price !== null && offer !== null && offer >= price) fail(400, '현젯은 즉거가보다 낮게 입력해 주세요.');
    const sets: string[] = [], args: unknown[] = [];
    if (hasPrice) { sets.push("price=?,price_mode='fixed'"); args.push(price); }
    if (hasOffer && offer === null) sets.push("details=json_remove(details,'$.currentOffer')");
    if (hasOffer && offer !== null) { sets.push("details=json_set(details,'$.currentOffer',?)"); args.push(String(offer)); }
    await db().batch([
        ...hasPrice ? priceHistoryStatements(post.id, 'sell', price, now) : [],
        db().prepare(`UPDATE posts SET ${sets.join(',')},updated_at=? WHERE id=? AND kind='sell'`).bind(...args, now, post.id),
    ]);
    return json({ post: (await decorate([await rawPost(post.id)], u))[0] });
}

export async function postsHandler(req: Request, p: string[], url: URL): Promise<Response> {
    const method = req.method;
    if (method === 'GET' && !p[1]) return listPosts(req, url);
    if (p[1] && method === 'GET' && !p[2]) {
        const u = await currentUser(req), post = await visiblePost(p[1], u);
        return json({ post: (await decorate([post], u))[0] });
    }
    const u = await requireUser(req);
    await limit('post:' + u.id, 50, 60000);
    const existing = p[1] ? await visiblePost(p[1], u) : null;
    if (p[2] === 'favorite' && method === 'POST') {
        const b = await body(req);
        if (b.active) await db().prepare('INSERT OR IGNORE INTO favorites(user_id,post_id,created_at) VALUES(?,?,?)').bind(u.id, existing.id, Date.now()).run();
        else await db().prepare('DELETE FROM favorites WHERE user_id=? AND post_id=?').bind(u.id, existing.id).run();
        return json({ ok: true });
    }
    if (p[2] === 'view' && method === 'POST') {
        await db().batch([
            db().prepare('INSERT INTO history(user_id,post_id,created_at) VALUES(?,?,?) ON CONFLICT(user_id,post_id) DO UPDATE SET created_at=excluded.created_at').bind(u.id, existing.id, Date.now()),
            db().prepare('DELETE FROM history WHERE user_id=? AND post_id NOT IN(SELECT post_id FROM history WHERE user_id=? ORDER BY created_at DESC LIMIT 100)').bind(u.id, u.id),
        ]);
        return json({ ok: true });
    }
    if (existing && existing.author_id !== u.id && (u.role !== 'manager' || method !== 'DELETE')) fail(403, '권한이 없습니다.');
    if (method === 'DELETE' && existing) {
        await db().prepare('DELETE FROM posts WHERE id=?').bind(existing.id).run();
        return json({ ok: true });
    }
    if (p[2] === 'bump' && method === 'POST') return bumpPost(u, existing);
    if (p[2] === 'feature' && method === 'PUT') return featurePost(req, u, existing);
    if (p[2] === 'price' && method === 'PATCH') return patchPrice(req, u, existing);
    if (p[2] === 'status' && method === 'PATCH') {
        const b = await body(req);
        if (!['open', 'reserved', 'closed'].includes(b.status)) fail(400, '거래 상태를 확인해 주세요.');
        if (existing.kind === 'proxy_offer' && b.status !== 'closed' && !canOfferProxy(u)) fail(403, '대리 인증이 없으면 대리(진행) 글은 거래완료로만 바꿀 수 있습니다.');
        const now = Date.now();
        await db().batch([
            // 거래완료 also ends 게시판 상단 노출.
            db().prepare("UPDATE posts SET status=?,updated_at=?,featured_at=CASE WHEN ?='closed' THEN NULL ELSE featured_at END WHERE id=?").bind(b.status, now, b.status, existing.id),
            ...endOffersStatements(existing.id, existing.author_id, STATUS_ENDS_OFFERS, [b.status, b.status], now),
        ]);
        return json({ ok: true });
    }
    if (!['POST', 'PUT'].includes(method) || p[2]) fail(405, '지원하지 않는 요청입니다.');
    if (method === 'POST' && p[1] || method === 'PUT' && !existing) fail(400, '게시글 번호를 확인해 주세요.');
    const v = await validatePost(await body(req), u, existing), now = Date.now(), key = postTitleKey(v.title);
    if (!existing) {
        // Caps by grade: 거래중·예약중 posts (hidden included), new posts today (deleting one does not
        // give it back), the same title as an open post of the same kind, and the same title as a
        // post deleted within the bump gap. A title that only matches 거래완료 posts is allowed.
        const perks = perksOf(u), strict = u.role !== 'manager' && !relaxedLimits(req), dayStart = kstDayStart(now);
        if (strict) {
            const gapMs = perks.bumpGapHours * HOUR;
            // The author's open posts from before title_key existed get their key now, so the
            // same-title rule sees them before the daily cleanup has run.
            const missing = await db().prepare("SELECT id,title FROM posts WHERE author_id=? AND status!='closed' AND title_key='' LIMIT 100").bind(u.id).all<{ id: number; title: string }>();
            if (missing.results.length) await db().batch(missing.results.map(p => db().prepare("UPDATE posts SET title_key=? WHERE id=? AND title=? AND title_key=''").bind(postTitleKey(p.title), p.id, p.title)));
            const c = await db().prepare(`SELECT (SELECT COUNT(*) FROM posts WHERE author_id=? AND status!='closed') AS openCount,
                (SELECT COUNT(*) FROM post_events WHERE user_id=? AND kind='post' AND created_at>=?) AS postsToday,
                EXISTS(SELECT 1 FROM posts WHERE author_id=? AND kind=? AND status!='closed' AND title_key=?) AS openDup,
                (SELECT MAX(e.created_at) FROM post_events e WHERE e.user_id=? AND e.kind='post' AND e.title_key=? AND e.created_at>? AND NOT EXISTS(SELECT 1 FROM posts WHERE id=e.post_id)) AS deletedAt`)
                .bind(u.id, u.id, dayStart, u.id, v.kind, key, u.id, key, now - gapMs).first<any>();
            if (c.openCount >= perks.openPosts) fail(429, `거래중·예약중 글은 ${perks.openPosts}개까지입니다. 거래완료로 바꾸거나 삭제해 주세요.`);
            if (c.postsToday >= perks.postsPerDay) fail(429, `오늘 새 글은 ${perks.postsPerDay}개까지입니다.`);
            if (c.openDup) fail(409, '같은 제목의 거래중 글이 있습니다. 그 글을 끌올해 주세요.');
            if (c.deletedAt) fail(429, `삭제한 글과 같은 제목은 ${clock(c.deletedAt + gapMs)}부터 다시 올릴 수 있습니다.`);
        }
        // The insert repeats both counts so parallel requests cannot pass them. The follow-up rows
        // select the new post's id and insert nothing when the insert was refused.
        const guard = strict ? "(SELECT COUNT(*) FROM posts WHERE author_id=? AND status!='closed')<? AND (SELECT COUNT(*) FROM post_events WHERE user_id=? AND kind='post' AND created_at>=?)<?" : '1';
        const newPost = '(SELECT id FROM posts WHERE author_id=? AND created_at=? AND title_key=? ORDER BY id DESC LIMIT 1)', newArgs = [u.id, now, key];
        const r = await db().batch([
            db().prepare(`INSERT INTO posts(author_id,kind,title,body,price,status,category,price_mode,accepts_offers,details,images,created_at,updated_at,bumped_at,title_key) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`)
                .bind(u.id, v.kind, v.title, v.content, v.price, v.status, v.category, v.mode, v.accepts, v.details, v.images, now, now, now, key, ...strict ? [u.id, perks.openPosts, u.id, dayStart, perks.postsPerDay] : []),
            ...v.tags.map(t => db().prepare(`INSERT INTO post_seasons(post_id,tier,season) SELECT id,?,? FROM ${newPost} WHERE id IS NOT NULL`).bind(t.tier, t.season, ...newArgs)),
            ...v.wantedTags.map(t => db().prepare(`INSERT INTO post_wanted_seasons(post_id,tier,season) SELECT id,?,? FROM ${newPost} WHERE id IS NOT NULL`).bind(t.tier, t.season, ...newArgs)),
            db().prepare(`INSERT INTO post_images(post_id,upload_id) SELECT n.id,j.value FROM ${newPost} n,json_each(?) j WHERE n.id IS NOT NULL`).bind(...newArgs, v.images),
            db().prepare(`INSERT INTO post_events(user_id,post_id,kind,title_key,created_at) SELECT ?,id,'post',?,? FROM ${newPost} WHERE id IS NOT NULL`).bind(u.id, key, now, ...newArgs),
        ]);
        if (!r[0].meta.changes) fail(429, '잠시 후 다시 시도해 주세요.');
        return json({ id: r[0].meta.last_row_id }, 201);
    }
    await db().batch([
        ...priceHistoryStatements(existing.id, v.kind, v.price, now),
        // Editing never bumps. 거래완료 ends 게시판 상단 노출.
        db().prepare("UPDATE posts SET kind=?,title=?,title_key=?,body=?,price=?,status=?,category=?,price_mode=?,accepts_offers=?,details=?,images=?,updated_at=?,featured_at=CASE WHEN ?='closed' THEN NULL ELSE featured_at END WHERE id=?")
            .bind(v.kind, v.title, key, v.content, v.price, v.status, v.category, v.mode, v.accepts, v.details, v.images, now, v.status, existing.id),
        db().prepare('DELETE FROM post_seasons WHERE post_id=?').bind(existing.id),
        ...v.tags.map(t => db().prepare('INSERT INTO post_seasons(post_id,tier,season) VALUES(?,?,?)').bind(existing.id, t.tier, t.season)),
        db().prepare('DELETE FROM post_wanted_seasons WHERE post_id=?').bind(existing.id),
        ...v.wantedTags.map(t => db().prepare('INSERT INTO post_wanted_seasons(post_id,tier,season) VALUES(?,?,?)').bind(existing.id, t.tier, t.season)),
        db().prepare('DELETE FROM post_images WHERE post_id=?').bind(existing.id),
        db().prepare('INSERT INTO post_images(post_id,upload_id) SELECT ?,value FROM json_each(?)').bind(existing.id, v.images),
        ...endOffersStatements(existing.id, existing.author_id, STATUS_ENDS_OFFERS, [v.status, v.status], now),
    ]);
    return json({ id: existing.id });
}
