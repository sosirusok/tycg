import { env } from 'cloudflare:workers';
import { db, fail, currentUser, requireUser, requireActive, json, body, limit, textField, memberColumns, tradeStatsStatement, tradeStatsOf, withMember, isSuspended, setting, mayHaveBlocks, digest, WITHDRAWN_NAME } from './http';
import {
    CATEGORIES, TRADE_KINDS, DETAIL_FIELDS, BUYER_DETAIL_FIELDS, PHANTOM_MAX, ACCOUNT_CHOICES, RECORD_PREFERENCES, NICK_RANKS, NICK_TYPES, SKIN_TAGS,
    FULL_SET, LEGACY_SKELETON, LATEST_SEASON, TIERS, WANTED_NICK_TYPES_FIELD, categoriesForKind, normalizeTrade, validTags, choiceAllowed, skinsForWord, expandSkins, priceText, statusName, matchQuery,
    type DetailField, type SeasonTag, type User,
} from '../shared/market';
import { AD_TEXT, BULK_MAX, BULK_TEXT, GRADES, MANAGER_PERKS, MATCH_TEXT, PERKS, PIN_TEXT, SITE_RULES, STATS_RANK, perksOf, rulesOf, kstDayStart, gapText, walletOf, type Perks } from '../shared/membership';
import { ASK_LIMIT, planTrade } from './reviews';
import { postTitleKey, sameText, type Match } from '../shared/listing';
import { assertNoBlockedLinks, shownCards, unfurlOnSave } from './unfurl';
import { STYLE_ERROR, shownStyle, styleRank, validate as validateStyle } from '../shared/richtext';
import { favoritesNotify, notifyStatement } from './notifications';
import { bulkAuto, newPostEnrolStatements, postAutoHandler, postAutoOf } from './automation';
import { MATCH_SCAN, pairSql, reachable } from './match';
import { AD_CANDIDATES, BOX_MIN_OPEN, BOX_SIZE, adFillStatement, adFilters, adSelect, adTrimStatement, adWhere, boxSeed, pickSimilar, rotate, similarStatement, stripAdRank } from './ads';
import { buildPrint, printsStatement, findMatch, crossStatements, crossHit, printUpsert, reportStatement, soldTo, type PrintRow, type UploadHash, type NewPrint } from './prints';

const HOUR = 3600000;
const DAY = 24 * HOUR;
// Board and home lists show posts bumped in the last 30 days (WP42); '오래된 글 보기' (old=1), a search,
// a profile, 내 글, 찜 and 최근 본 글 cover every post.
export const LIST_WINDOW = 30 * DAY;
// Counts stop at 301 rows: the board shows '300+' and pages up to the last full page.
export const COUNT_CAP = 300;
// 인기순 (WP63): open posts bumped in the last 7 days, the newest 400 of them, pages 1-5.
const POPULAR_DAYS = 7, POPULAR_CANDIDATES = 400, POPULAR_PAGES = 5;

// "15:40" on the Korean clock, rounded up to the minute so the time shown is never early.
export function clock(t: number) {
    const d = new Date(Math.ceil(t / 60000) * 60000 + 9 * HOUR);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

export { postTitleKey };

// Test only: POST_LIMITS=relaxed lifts the open-post and daily-post caps, 같은 매물 and the 새 글
// allowance (new posts go to now), and only for requests to 127.0.0.1 or localhost, so the API suites
// can create many posts. Bump caps still apply.
function relaxedLimits(req: Request) {
    const host = new URL(req.url).hostname;
    return (env as Partial<Env>).POST_LIMITS === 'relaxed' && (host === '127.0.0.1' || host === 'localhost');
}

// posts.thumb: 'data:image/webp;base64,…', at most 6,000 characters.
const THUMB_RE = /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/;
const THUMB_MAX = 6000;

export const postSelect = `SELECT p.*,u.nickname,u.role,u.deleted_at AS author_deleted_at,${memberColumns('u', 'author_')} FROM posts p JOIN users u ON u.id=p.author_id`;

export const parse = (s: string, fallback: any) => { try { return JSON.parse(s); } catch { return fallback; } };
// 내 글: the list row with its 자동 끌올 state (WP52).
const ownSelect = postSelect.replace(' FROM posts p ', ',(SELECT json_array(pa.bump,pa.bump_remind) FROM post_auto pa WHERE pa.post_id=p.id) AS own_auto FROM posts p ');

export async function latestSeason() {
    const v = Number(await setting('latest_season'));
    return Number.isInteger(v) && v >= LATEST_SEASON && v <= 200 ? v : LATEST_SEASON;
}

// One post also carries the author's '최근 접속' for the detail page's author box (lists leave it out);
// GET /posts/:id adds the trade counts (tradeStats).
// It also carries the join date and the nickname change (WP51); decorate keeps the earlier nickname
// only while the change is under 90 days old. The author box shows the 64px 프로필 사진 inline (WP59).
const onePostSelect = postSelect.replace(' FROM posts p ', `,u.last_seen_at AS author_last_seen_at,u.created_at AS author_created_at,u.prev_nickname AS author_prev_nickname,u.nickname_changed_at AS author_nickname_changed_at,u.avatar_thumb AS author_avatar_thumb FROM posts p `);
async function rawPost(id: string | number) { return db().prepare(onePostSelect + ' WHERE p.id=?').bind(id).first<any>(); }

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

const NICKNAME_SHOWN_MS = 90 * 86400000;
// A pending trade request expires after 7 days (reviews.ts ANSWER_DAYS).
const DEAL_ANSWER_MS = 7 * 86400000;

// Lists (full false) carry only the 대표 (images[0]) and photo_count (WP46); GET /posts/:id and the
// price edit that returns the post (full true) carry every photo.
export async function decorate(rows: any[], viewer?: Viewer, full = false) {
    if (!rows.length) return [];
    const ids = JSON.stringify(rows.map(p => p.id));
    // 완료 거래가 (WP51): one read of trades by post_id (unique) for the completed posts on the page only.
    const closedIds = rows.filter(p => p.status === 'closed').map(p => p.id);
    const [tags, wantedTags, favs, histories, deals] = await db().batch([
        db().prepare('SELECT post_id,tier,season FROM post_seasons WHERE post_id IN (SELECT value FROM json_each(?)) ORDER BY season DESC').bind(ids),
        db().prepare('SELECT post_id,tier,season FROM post_wanted_seasons WHERE post_id IN (SELECT value FROM json_each(?)) ORDER BY season DESC').bind(ids),
        db().prepare('SELECT post_id FROM favorites WHERE user_id=? AND post_id IN (SELECT value FROM json_each(?))').bind(viewer?.id || '', ids),
        db().prepare('SELECT post_id,price,changed_at FROM post_price_history WHERE post_id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(ids),
        ...closedIds.length ? [db().prepare('SELECT post_id,price,seller_id,buyer_id,created_at,(confirmed_at IS NOT NULL OR author_id IS NULL) AS confirmed FROM trades WHERE post_id IN (SELECT value FROM json_each(?)) AND removed_at IS NULL')
            .bind(JSON.stringify(closedIds))] : [],
    ]);
    const now = Date.now();
    return rows.map(row => {
        const p = withMember(row, 'author_');
        // When a 6-month grade ends is private to the member and the manager.
        delete p.author_grade_expires_at;
        // Why the manager hid a post is shown to its author and the manager only.
        if (p.author_id !== viewer?.id && viewer?.role !== 'manager') delete p.hidden_reason;
        const featured = p.featured_at !== null && p.featured_at !== undefined;
        delete p.featured_at;
        // 광고 (WP53): '광고 고정/빼기' and '광고 유입 12' are the author's (and the manager's) only.
        if (p.author_id !== viewer?.id && viewer?.role !== 'manager') { delete p.featured_pin; delete p.promo_views; }
        // 대표 글 (WP63): a member's list says which posts show as 대표 (pinned); when the author pinned one
        // (also a pin a lower grade no longer shows, for '대표 글 해제') is the author's own.
        if ('pinned' in p) p.pinned = !!p.pinned;
        if (p.author_id !== viewer?.id) delete p.profile_pin_at;
        delete p.ad_rank;
        delete p.title_key;
        // 링크 미리보기 (WP48): lists carry neither field; GET /posts/:id adds the cards it may show
        // (shownCards) and the author's switch.
        delete p.link_cards;
        if (full) p.link_preview = p.link_preview !== 0;
        else delete p.link_preview;
        // 글자 꾸미기 (WP49): the detail only, filtered by the author's current grade, and only while the
        // ranges still belong to this exact body (n, h); lists never carry it.
        const style = full ? shownStyle(p.body_style, p.body, styleRank(p.author_grade, p.role)) : null;
        delete p.body_style;
        if (full) p.body_style = style;
        // A withdrawn author is shown as plain 탈퇴회원 (the stored nickname has a random suffix).
        const authorDeleted = !!p.author_deleted_at;
        delete p.author_deleted_at;
        if (authorDeleted) { p.nickname = WITHDRAWN_NAME; delete p.author_last_seen_at; delete p.author_trade_count; delete p.author_deal_sum; delete p.author_good_count; delete p.author_created_at; delete p.author_avatar_thumb; }
        else if ('author_avatar_thumb' in p && !p.author_avatar_thumb) delete p.author_avatar_thumb;
        // '이전 닉네임: {닉}' (WP51): only while the nickname changed within 90 days, as on the profile.
        if ('author_nickname_changed_at' in p) {
            if (authorDeleted || !p.author_prev_nickname || !(p.author_nickname_changed_at > now - NICKNAME_SHOWN_MS)) delete p.author_prev_nickname;
            delete p.author_nickname_changed_at;
        }
        // 완료 거래가 (WP51): everyone sees the 거래가 of a confirmed trade; the author, the two members of the
        // trade and the manager also see a pending one, with deal_state '확인 대기' or '확인 완료'. A pending
        // request older than 7 days reads as none (it expired).
        const deal: any = p.status === 'closed' ? deals?.results.find((t: any) => t.post_id === p.id) : undefined;
        if (deal && (deal.confirmed || deal.created_at >= now - DEAL_ANSWER_MS)) {
            const involved = !!viewer && (viewer.id === p.author_id || viewer.id === deal.seller_id || viewer.id === deal.buyer_id || viewer.role === 'manager');
            if (deal.confirmed && deal.price !== null) p.deal_price = deal.price;
            if (involved) {
                if (deal.price !== null) p.deal_price = deal.price;
                p.deal_state = deal.confirmed ? 'confirmed' : 'pending';
            }
        }
        // A legacy 예약중 reads as 진행중 (WP43: two states).
        if (p.status !== 'closed') p.status = 'open';
        // The WP65 운영진 가측가 columns stay in the table (additive migrations) but are never shown (WP66).
        delete p.appraised_price; delete p.appraised_at;
        const parsed = parse(p.images, []), images: string[] = Array.isArray(parsed) ? parsed : [];
        return {
            ...p, ...normalizeTrade(p.kind, p.category),
            price_mode: p.price_mode === 'legacy' ? (p.price === null ? 'negotiate' : 'fixed') : p.price_mode,
            details: parse(p.details, {}), images: full ? images : images.slice(0, 1), photo_count: images.length,
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

// 찜 가격 내림 (WP50): one 알림 per member who saved the post, written only while the post is an open,
// visible 판매 post whose 즉거가 is above the new one. It goes before the posts UPDATE in the same batch,
// so it reads the price the change replaces.
export function priceDropNotify(postId: number, authorId: string, title: string, newPrice: number, now: number) {
    return favoritesNotify('fav_price', postId, authorId, `가격 내림 · ${title} ${priceText(newPrice)}`, now,
        "EXISTS(SELECT 1 FROM posts WHERE id=? AND kind='sell' AND status!='closed' AND hidden=0 AND price IS NOT NULL AND price>?)", [postId, newPrice]);
}

// 완료 (WP43) ends the pending offers; an accepted one survives only when its sender is the member the
// author named as the partner (bind that id, or null for none).
export const COMPLETE_ENDS_OFFERS = "(status='pending' OR (status='accepted' AND sender_id IS NOT ?))";
export const OFFERS_ENDED_TEXT = '글이 완료되어 제시가 마감되었습니다.';
// The line when the manager hides the post.
export const OFFERS_HIDDEN_TEXT = '글이 숨김 처리되어 제시가 마감되었습니다.';

// Cancels the post's offers that match `condition` and leaves a notice in each of their chats.
// The notice and the chat bump come first, because they select the offers the UPDATE then cancels.
// The post author sends the notice: they are a member of every such chat, also when the manager hides the post.
export function endOffersStatements(postId: number, authorId: string, condition: string, args: unknown[], now: number, text = OFFERS_ENDED_TEXT) {
    return [
        db().prepare(`INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) SELECT DISTINCT conversation_id,?,?,'system',NULL,'[]',? FROM offers WHERE post_id=? AND ${condition}`)
            .bind(authorId, text, now, postId, ...args),
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
    numericDetail(details, key('phantomMin'), label('phantomMin'), 0, PHANTOM_MAX);
    numericDetail(details, key('nicknameCharsMin'), label('nicknameCharsMin'), 1, 20);
    numericDetail(details, key('nicknameCharsMax'), label('nicknameCharsMax'), 1, 20);
    if (details[key('nicknameCharsMin')] && details[key('nicknameCharsMax')] && Number(details[key('nicknameCharsMin')]) > Number(details[key('nicknameCharsMax')]))
        fail(400, '닉네임 최소 글자 수가 최대 글자 수보다 클 수 없습니다.');
    if (details[key('recordPreference')] && !RECORD_PREFERENCES.includes(details[key('recordPreference')] as typeof RECORD_PREFERENCES[number]))
        fail(400, `${label('recordPreference')}: 확인해 주세요.`);
    selectedDetails(details, key('nicknameRanks'), NICK_RANKS, label('nicknameRanks'));
    // One key on 구매 and on the wanted side of 교환, so no prefix.
    selectedDetails(details, WANTED_NICK_TYPES_FIELD.id, NICK_TYPES, WANTED_NICK_TYPES_FIELD.label);
    selectedDetails(details, key('skinTags'), SKIN_TAGS, label('skinTags'), true);
}

export const canOfferProxy = (u: User) => u.role === 'manager' || u.badges.includes('proxy');
const uniqueTags = (list: SeasonTag[]) => [...new Map(list.map(t => [t.tier + ':' + t.season, { tier: t.tier, season: t.season }])).values()];

// SQL filter for one season table: any (or all) of the chosen tier-season pairs.
function seasonFilter(table: string, tags: SeasonTag[], all: boolean) {
    return (all ? '(SELECT COUNT(*)' : 'EXISTS (SELECT 1') + ` FROM ${table} s JOIN json_each(?) j ON s.tier=json_extract(j.value,'$.tier') AND s.season=json_extract(j.value,'$.season') WHERE s.post_id=p.id)` + (all ? '=' + tags.length : '');
}

// Tier words as cafe titles write them ('28챌', '30ㄷㅇ', '현플', '28시즌 다이아몬드').
const TIER_WORDS: Record<string, string> = {
    다이아몬드: 'diamond', 다이아: 'diamond', 다야: 'diamond', ㄷㅇ: 'diamond',
    플래티넘: 'platinum', 플래: 'platinum', 플레: 'platinum', 플: 'platinum',
    챌린저: 'challenger', 챌: 'challenger', 챔피언: 'champion', 챔: 'champion', 마스터: 'master', 마: 'master',
    골드: 'gold', 골: 'gold', 실버: 'silver', 실: 'silver', 브론즈: 'bronze', 브: 'bronze', 아이언: 'iron',
};
const TIER_SHORTHAND = new RegExp(`^(현|\\d{1,2})\\s*(?:시즌\\s*)?(${Object.keys(TIER_WORDS).join('|')})$`);
// A bare tier word as the whole search finds every season of that tier; one syllable ('마', '골')
// or jamo ('ㄷㅇ') alone stays a plain text search.
const BARE_TIER_WORDS = ['다이아몬드', '다이아', '다야', '플래티넘', '플래', '챌린저', '챔피언', '마스터', '골드', '실버', '브론즈', '아이언'];

// The ladder a whole search names: '28챌' is 28시즌 챌린저, '현플' the latest season's 플래티넘,
// '다야' any season of 다이아몬드. A season outside the tier's range names nothing. The latest
// season (latestSeason) is read only for a search that has the shorthand's shape (needsSeason).
export function tierSearch(q: string, latest: number): { tier: string; season: number | null } | null {
    if (BARE_TIER_WORDS.includes(q)) return { tier: TIER_WORDS[q], season: null };
    const m = TIER_SHORTHAND.exec(q);
    if (!m) return null;
    const tier = TIERS.find(t => t.id === TIER_WORDS[m[2]])!, season = m[1] === '현' ? latest : Number(m[1]);
    return season >= tier.min && season <= latest ? { tier: tier.id, season } : null;
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
    let fields: DetailField[] = category === 'account' && b.kind === 'buy' ? [...BUYER_DETAIL_FIELDS, WANTED_NICK_TYPES_FIELD] : DETAIL_FIELDS[category];
    if (b.kind === 'exchange') {
        if (!['account', 'clan'].includes(b.details?.wantedCategory)) fail(400, '구하는 교환 대상을 선택해 주세요.');
        fields = [...fields, { id: 'wantedCategory', label: '구하는 대상' }];
        if (b.details.wantedCategory === 'account') fields = [...fields, ...BUYER_DETAIL_FIELDS.map(f => ({ ...f, id: 'wanted' + f.id[0].toUpperCase() + f.id.slice(1) })), WANTED_NICK_TYPES_FIELD];
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
        numericDetail(details, 'phantom', label('phantom'), 0, PHANTOM_MAX);
        selectedDetails(details, 'nicknameTypes', NICK_TYPES, label('nicknameTypes'));
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
    // The same cap for every member; an edit may keep the photos a post already has.
    const maxPhotos = Math.max(SITE_RULES.photosPerPost, existing ? parse(existing.images, []).length : 0);
    if (images.length > maxPhotos) fail(400, `사진은 한 글에 ${maxPhotos}장까지입니다.`);
    // The photo hashes come along for the post's print (같은 매물, WP44).
    let uploads: UploadHash[] = [];
    if (images.length) {
        uploads = (await db().prepare('SELECT id,hash,src_hash FROM uploads WHERE owner_id=? AND id IN(SELECT value FROM json_each(?))').bind(u.id, JSON.stringify(images)).all<UploadHash>()).results;
        if (uploads.length !== images.length) fail(403, '본인이 올린 사진만 쓸 수 있습니다.');
    }
    // The inline list thumbnail (WP45): a small WebP data URI the editor makes from the 대표 photo. Left out
    // on an edit, it stays while the 대표 is the same; a post without photos has none.
    let thumb: string | null | undefined = undefined;
    if (b.thumb === null || b.thumb === '') thumb = null;
    else if (b.thumb !== undefined) {
        if (typeof b.thumb !== 'string' || b.thumb.length > THUMB_MAX || !THUMB_RE.test(b.thumb)) fail(400, '사진을 다시 선택해 주세요.');
        thumb = b.thumb;
    }
    if (thumb === undefined && existing) thumb = images[0] && images[0] === parse(existing.images, [])[0] ? existing.thumb ?? null : null;
    if (!images.length) thumb = null;
    // The status is never taken from the form (WP43): a new post starts 진행중, an edit keeps it, and only
    // PATCH /posts/:id/status completes a post.
    // 링크 미리보기 (WP48): on by default; an edit that leaves it out keeps the post's switch.
    const linkPreview = b.link_preview === undefined ? (existing ? existing.link_preview !== 0 : true) : !!b.link_preview;
    // 글자 꾸미기 (WP49): ranges over the body as sent, checked against the author's grade, shifted to the
    // trimmed body. An edit that leaves body_style out keeps the stored ranges while they still match.
    let bodyStyle = '';
    if (b.body_style === undefined) {
        if (existing?.body_style && shownStyle(existing.body_style, content, 3)) bodyStyle = existing.body_style;
    } else {
        const checked = validateStyle(b.body_style, b.body, styleRank(u.grade, u.role));
        if (!checked.ok) fail(400, STYLE_ERROR);
        bodyStyle = checked.style ? JSON.stringify(checked.style) : '';
    }
    return { linkPreview: linkPreview ? 1 : 0, bodyStyle, thumb: thumb ?? null, kind: b.kind, title, content, category, tags, wantedTags, price, mode, details: JSON.stringify(details), images: JSON.stringify(images), accepts: b.kind === 'sell' && (b.accepts_offers || mode === 'offer') ? 1 : 0, uploads };
}

// The filters every list shares: the manager's hidden posts, members under 이용 정지 (boards, search,
// 찜, profile lists and both promotion boxes leave them out until the suspension ends; authors still see
// their own list), the authors the viewer blocked (boards only) and 대리(진행) posts whose author lost
// 대리 인증. None of them joins users, so a count reads posts only.
export const SUSPENDED_AUTHORS = 'p.author_id NOT IN (SELECT id FROM users WHERE suspended_until>?)';
export function baseFilters(u: User | null, author: string | null, now: number) {
    const where: string[] = [], values: unknown[] = [];
    if (!u || author !== u.id) {
        where.push('p.hidden=0', SUSPENDED_AUTHORS);
        values.push(now);
    }
    if (author) { where.push('p.author_id=?'); values.push(author); }
    // (Only for a member who blocked someone: the check probes blocks once per post read.)
    else if (u && mayHaveBlocks(u)) { where.push('p.author_id NOT IN (SELECT target_id FROM blocks WHERE user_id=?)'); values.push(u.id); }
    where.push("(p.kind!='proxy_offer' OR p.author_id=? OR EXISTS(SELECT 1 FROM users ur WHERE ur.id=p.author_id AND ur.role='manager') OR EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=p.author_id AND b.badge='proxy'))");
    values.push(u?.id || '');
    return { where, values };
}

// Posts the previous Worker wrote during a deploy have bumped_at=0 and would sort last. For the
// first hour of each isolate, every list copies created_at into them first, in the same batch as the
// list (an indexed UPDATE that usually changes nothing), so rows the previous Worker writes while
// both versions still serve are covered too. The daily cleanup does the same.
let isolateStart = 0;
export function bumpBackfill(now: number) {
    isolateStart ||= now;
    return now - isolateStart < HOUR ? [db().prepare('UPDATE posts SET bumped_at=created_at WHERE bumped_at=0')] : [];
}

// The search word's SQL (WP54), shared by the board search and the 키워드 알림 cron, so an 알림 never
// promises posts the board will not show. Each argument is an SQL expression: word is the lowered word,
// wordNs the lowered word without spaces, skins a JSON list of the skins the word names (null: none) and
// ladder a condition on p.id for a ladder the whole word names (null: none). An empty word matches
// every post (instr(x,'') is 1). Joins users u (the author's nickname).
export function qClause(word: string, wordNs: string, skins: string | null, ladder: string | null) {
    return `(instr(lower(p.title),${word})>0 OR instr(lower(p.body),${word})>0 OR instr(lower(replace(p.details,' ','')),${wordNs})>0 OR instr(lower(u.nickname),${word})>0`
        + (skins ? ` OR EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(p.details,'$.skinTags'),'[]')) own JOIN json_each(${skins}) w ON own.value=w.value) OR EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(p.details,'$.wantedSkinTags'),'[]')) own JOIN json_each(${skins}) w ON own.value=w.value)` : '')
        + (ladder ? ` OR ${ladder}` : '') + ')';
}
// The board search's bound form: q is bound 4 times, the skins twice, then the ladder.
export const BOARD_Q = { word: 'lower(?)', wordNs: "lower(replace(?,' ',''))", skins: '?' };
export const ladderSql = (season: boolean) => `p.id IN (SELECT post_id FROM post_seasons WHERE tier=?${season ? ' AND season=?' : ''})`;
// The search word as the board reads it (trimmed, at most 100 characters).
export const searchWord = (raw: string | null | undefined) => (raw || '').trim().slice(0, 100);

// Whether a query needs the latest season (a ladder shorthand such as '현플', or season tags).
export const needsSeason = (s: URLSearchParams) => TIER_SHORTHAND.test(searchWord(s.get('q'))) || !!s.get('tags') || !!s.get('wantedTags');

// Every filter of a board query (WP54: shared by the board list and the 조건 알림 cron): the shared
// base filters (baseFilters, with the viewer), the tab, category and state, the search word and every
// field filter. Not here: scope (찜, 최근 본 글), 내 글 'stale', the 30-day board window and the order.
// A bad value throws 400 as the board always did. latest: the latest season (needsSeason).
export function buildPostFilter(s: URLSearchParams, u: Pick<User, 'id' | 'role'> | null, latest: number, now: number, author: string | null = null) {
    const { where, values } = baseFilters(u as User | null, author, now) as { where: string[]; values: any[] };
    for (const [param, col, allowed] of [['kind', 'kind', TRADE_KINDS], ['category', 'category', CATEGORIES.map(c => c.id)], ['status', 'status', ['open', 'closed']]] as [string, string, string[]][]) {
        const v = s.get(param);
        if (v && allowed.includes(v)) { where.push('p.' + col + '=?'); values.push(v); }
    }
    // A legacy link asking for 예약중 lists the posts still in progress.
    if (s.get('status') === 'reserved') where.push("p.status!='closed'");
    if (s.get('active') === '1') where.push("p.status!='closed'");
    if (s.get('mode') && ['fixed', 'offer', 'negotiate'].includes(s.get('mode')!)) {
        where.push("(CASE WHEN p.price_mode='legacy' THEN CASE WHEN p.price IS NULL THEN 'negotiate' ELSE 'fixed' END ELSE p.price_mode END)=?");
        values.push(s.get('mode'));
    }
    const q = searchWord(s.get('q'));
    if (q) {
        // A skin's short name or in-game name (악주, 뱀동, 악몽의 주인 …) also finds posts that list that skin.
        const skins = skinsForWord(q);
        // A whole search that names a ladder ('28챌', '현플', '다야') also finds posts with that ladder record.
        const ladder = tierSearch(q, latest);
        where.push(qClause(BOARD_Q.word, BOARD_Q.wordNs, skins.length ? BOARD_Q.skins : null, ladder ? ladderSql(ladder.season !== null) : null));
        values.push(q, q, q, q);
        if (skins.length) values.push(JSON.stringify(skins), JSON.stringify(skins));
        if (ladder) values.push(ladder.tier, ...ladder.season === null ? [] : [ladder.season]);
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
    for (const [key, path, max] of [['level', 'level', 999], ['skins', 'humanSkins', 9999], ['gas', 'gas', 1000000000], ['minerals', 'minerals', 1000000000], ['phantom', 'phantom', PHANTOM_MAX]] as [string, string, number][]) {
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
    // "My account" 스킨 수: buyers who set no minimum or a minimum my 팬텀 % reaches. myPhantom is for
    // 구매, wantedMyPhantom for the wanted side of 교환.
    for (const [param, key] of [['myPhantom', 'phantomMin'], ['wantedMyPhantom', 'wantedPhantomMin']]) {
        const mine = queryInteger(param, 0, PHANTOM_MAX);
        if (mine === null) continue;
        where.push(`(json_extract(p.details,'$.${key}') IS NULL OR CAST(json_extract(p.details,'$.${key}') AS INTEGER)<=?)`);
        values.push(mine);
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
    // 닉 종류 on 판매 and the offered side of 교환: posts with any chosen type. Takes a JSON list or
    // comma-separated words (nicknameTypes=여사,귀욤).
    const typesParam = s.get('nicknameTypes');
    if (typesParam) {
        const chosen = typesParam.trim().startsWith('[') ? parse(typesParam, null) : typesParam.split(',').map(v => v.trim()).filter(Boolean);
        if (!Array.isArray(chosen) || chosen.length > NICK_TYPES.length || chosen.some(v => typeof v !== 'string' || !(NICK_TYPES as readonly string[]).includes(v))) fail(400, '닉 종류 검색 조건을 확인해 주세요.');
        if (chosen.length) {
            where.push("EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(p.details,'$.nicknameTypes'),'[]')) own JOIN json_each(?) w ON own.value=w.value)");
            values.push(JSON.stringify([...new Set(chosen)]));
        }
    }
    // "My account" 닉 종류: buyers who chose no type or chose mine. myNicknameType is for 구매,
    // wantedMyNicknameType for the wanted side of 교환; both read wantedNicknameTypes.
    for (const param of ['myNicknameType', 'wantedMyNicknameType']) {
        const v = s.get(param);
        if (!v) continue;
        if (!(NICK_TYPES as readonly string[]).includes(v)) fail(400, '닉 종류 검색 조건을 확인해 주세요.');
        where.push("(json_array_length(COALESCE(json_extract(p.details,'$.wantedNicknameTypes'),'[]'))=0 OR EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(p.details,'$.wantedNicknameTypes'),'[]')) WHERE value=?))");
        values.push(v);
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
        if (!validTags(tags, latest)) fail(400, '검색 시즌을 확인해 주세요.');
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
    return { where, values, q };
}

async function listPosts(req: Request, url: URL) {
    const now = Date.now(), backfill = bumpBackfill(now);
    const u = await currentUser(req), s = url.searchParams;
    const author = s.get('author');
    const { where, values, q } = buildPostFilter(s, u, needsSeason(s) ? await latestSeason() : LATEST_SEASON, now, author);
    const scope = s.get('scope');
    if (scope === 'favorites' || scope === 'recent') {
        if (!u) fail(401, '로그인이 필요합니다.');
        where.push(`p.id IN(SELECT post_id FROM ${scope === 'favorites' ? 'favorites' : 'history'} WHERE user_id=?)`);
        values.push(u.id);
    }
    // 내 글 'stale=1' (the weekly '자동 끌올 글 12개 확인 필요' 알림, WP52): the author's listed open posts
    // untouched for 7 days.
    if (u && author === u.id && s.get('stale') === '1') {
        where.push("p.status!='closed' AND COALESCE(p.touched_at,p.updated_at)<=? AND p.id IN (SELECT post_id FROM post_auto WHERE user_id=? AND bump=1)");
        values.push(now - 7 * DAY, u.id);
    }
    // The 30-day window for boards (see LIST_WINDOW); old=1 is '오래된 글 보기'.
    if (!q && !author && !scope && s.get('old') !== '1') { where.push('p.bumped_at>?'); values.push(now - LIST_WINDOW); }
    // 최신순 follows 끌올; created_at stays the time the post was written.
    const sort = s.get('sort');
    // 인기순 (WP63, every grade, boards and search): the open posts bumped in the last 7 days, the newest
    // POPULAR_CANDIDATES of them by 끌올, ordered by 찜 count, then views (cheap to inflate, so only a tie
    // breaker), then the latest 끌올; pages 1-5 only.
    const popular = sort === 'popular' && !author && !scope;
    if (popular) { where.push("p.status!='closed'", 'p.bumped_at>?'); values.push(now - POPULAR_DAYS * DAY); }
    let order = sort === 'price-low' ? 'p.price IS NULL,p.price ASC' : sort === 'price-high' ? 'p.price IS NULL,p.price DESC' : 'p.bumped_at DESC';
    if (scope === 'recent') order = '(SELECT created_at FROM history WHERE post_id=p.id AND user_id=?) DESC';
    // A member's list (profile, 내 글) says which posts are shown 대표 글 (WP63); the profile in 최신순 lists
    // them first, the newest pin first.
    const pinRows = !!author && !scope;
    if (pinRows && !q && (!sort || sort === 'latest') && s.get('counts') !== '1') order = 'pinned DESC,CASE WHEN pinned THEN p.profile_pin_at END DESC,p.bumped_at DESC';
    const size = Math.max(1, Math.min(40, Math.floor(Number(s.get('size')) || 16)));
    const clause = ' WHERE ' + where.join(' AND '), page = Math.max(1, Math.min(10000, Math.floor(Number(s.get('page')) || 1)));
    // 내 글 (counts=1) also reads each row's 자동 끌올 state (WP52), one primary-key lookup per row.
    const ownCounts = !!u && author === u.id && !scope && s.get('counts') === '1';
    const select = (ownCounts ? ownSelect : postSelect).replace(' FROM posts p ', `${pinRows ? `,${pinnedSql()} AS pinned` : ''} FROM posts p `);
    const listSql = popular
        ? `SELECT * FROM (${select}${clause} ORDER BY p.bumped_at DESC,p.id DESC LIMIT ${POPULAR_CANDIDATES}) c ORDER BY (SELECT COUNT(*) FROM favorites f WHERE f.post_id=c.id) DESC,c.view_count DESC,c.bumped_at DESC,c.id DESC LIMIT ? OFFSET ?`
        : `${select}${clause} ORDER BY ${order},p.id DESC LIMIT ? OFFSET ?`;
    // Board '광고 매물' box (WP53): page 1 of a tab in 최신순, in the 진행중 view (the board's default; with
    // 거래완료 included there is no box), with the page's own filters, when the tab holds more than 16
    // 진행중 posts (the list's own count). The list below keeps its order, counts and paging; the box leaves
    // out posts already in the first 5 rows. ads=none (or the older featured=none) asks for the list alone.
    const noBox = s.get('ads') === 'none' || s.get('featured') === 'none';
    const activeOnly = s.get('active') === '1' || s.get('status') === 'open' || s.get('status') === 'reserved';
    const withAds = page === 1 && (!sort || sort === 'latest') && TRADE_KINDS.includes(s.get('kind') as typeof TRADE_KINDS[number]) && !author && !scope && !noBox && activeOnly;
    // A search across every tab also returns how many results each tab has.
    const withCounts = !!q && !TRADE_KINDS.includes(s.get('kind') as typeof TRADE_KINDS[number]);
    // The count stops at 301 rows (capped: '300+'; the profile and 내 글 keep paging while pages come back
    // full) and joins users only for a search (it matches nicknames).
    const countCap = ` LIMIT ${COUNT_CAP + 1}`;
    const ad = adWhere(now, 2), adBase = withAds ? adFilters(where, values) : null;
    const r = (await db().batch([
        ...backfill,
        db().prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM posts p${q ? ' JOIN users u ON u.id=p.author_id' : ''}${clause}${countCap})`).bind(...values),
        db().prepare(listSql).bind(...values, ...(scope === 'recent' ? [u!.id] : []), popular && page > POPULAR_PAGES ? 0 : size, (page - 1) * size),
        ...withCounts ? [db().prepare('SELECT p.kind,COUNT(*) AS count FROM posts p JOIN users u ON u.id=p.author_id' + clause + ' GROUP BY p.kind').bind(...values)] : [],
        ...adBase ? [db().prepare(`${adSelect()} WHERE ${ad.sql} AND ${adBase.where.join(' AND ')} ORDER BY p.featured_at DESC LIMIT ${AD_CANDIDATES}`).bind(now, ...ad.args, ...adBase.values)] : [],
    ])).slice(backfill.length);
    const counts = withCounts ? Object.fromEntries(TRADE_KINDS.map(k => [k, (r[2].results as any[]).find(row => row.kind === k)?.count || 0])) : undefined;
    const counted = Number((r[0].results[0] as any).count) || 0, total = popular ? Math.min(counted, POPULAR_PAGES * size) : counted;
    let ads: any[] | undefined;
    if (withAds) {
        const top = new Set((r[1].results as any[]).slice(0, 5).map(p => p.id));
        ads = total > BOX_MIN_OPEN ? stripAdRank(rotate((r[r.length - 1].results as any[]).filter(p => !top.has(p.id)), boxSeed(now, s), BOX_SIZE)) : [];
    }
    // One decorate for the page and the box (tags, 찜 and price history in one batch).
    const decorated = await decorate([...r[1].results, ...ads || []], u);
    const posts = decorated.slice(0, r[1].results.length), adCards = ads ? decorated.slice(r[1].results.length) : undefined;
    if (scope === 'favorites') await addPriceDrops(posts, u!.id);
    // The author's own list (내 글, which asks with counts=1) also shows how many members saved each
    // post and started a chat from it. The profile lists do not ask, so they skip these reads.
    if (ownCounts) await addOwnCounts(posts);
    return json({ posts, total, page, size, ...total > COUNT_CAP ? { capped: true } : {}, ...counts ? { counts } : {}, ...adCards ? { ads: adCards } : {} });
}

// 찜한 글: a sale whose 즉거가 is below the price the member saw when saving it carries price_drop
// {from, to}. The favorite keeps that price (saved_price). Favorites saved before it existed (or by
// the previous Worker during a deploy) fall back to the history: each row holds the price before one
// change, so the first row written after the favorite is the price then, unless it rose in between
// (a rise records nothing). A rise deletes the rows at or below the new price, so a price back at or
// above `from` shows no drop either way.
async function addPriceDrops(posts: any[], userId: string) {
    const sells = posts.filter(p => p.kind === 'sell' && p.price !== null && p.status !== 'closed');
    if (!sells.length) return;
    const ids = JSON.stringify(sells.map(p => p.id));
    const [saved, history] = await db().batch([
        db().prepare('SELECT post_id,saved_price FROM favorites WHERE user_id=? AND post_id IN (SELECT value FROM json_each(?))').bind(userId, ids),
        db().prepare('SELECT h.post_id,h.price FROM post_price_history h JOIN favorites f ON f.post_id=h.post_id AND f.user_id=? WHERE h.post_id IN (SELECT value FROM json_each(?)) AND h.changed_at>f.created_at AND f.saved_price IS NULL ORDER BY h.id').bind(userId, ids),
    ]);
    for (const p of sells) {
        const from = (saved.results as { post_id: number; saved_price: number | null }[]).find(f => f.post_id === p.id)?.saved_price
            ?? (history.results as { post_id: number; price: number }[]).find(h => h.post_id === p.id)?.price;
        if (typeof from === 'number' && from > p.price) p.price_drop = { from, to: p.price };
    }
}

// fav_count: favorites of the post. chat_count: chats opened from the post (a 'listing' message
// carries the post id in reference_id). One grouped read each for the whole page, on the
// favorites_post and messages_listing indexes (migration 0010_trade_count_indexes).
async function addOwnCounts(posts: any[]) {
    if (!posts.length) return;
    const ids = JSON.stringify(posts.map(p => p.id)), weekAgo = Date.now() - 7 * DAY;
    const recent = JSON.stringify(posts.filter(p => p.status === 'closed' && (p.closed_at ?? p.updated_at) > weekAgo).map(p => p.id));
    const [favs, chats, trades, asked] = await db().batch([
        db().prepare('SELECT post_id AS id,COUNT(*) AS n FROM favorites WHERE post_id IN (SELECT value FROM json_each(?)) GROUP BY post_id').bind(ids),
        db().prepare("SELECT CAST(reference_id AS INTEGER) AS id,COUNT(DISTINCT conversation_id) AS n FROM messages WHERE type='listing' AND reference_id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) GROUP BY reference_id").bind(ids),
        // traded: the completed post holds a trade record (confirmed, removed or still waiting), so 내 글
        // offers '거래 기록 요청' only on the others (within 7 days of 완료).
        db().prepare(`SELECT post_id AS id FROM trades WHERE post_id IN (SELECT value FROM json_each(?)) AND (confirmed_at IS NOT NULL OR removed_at IS NOT NULL OR author_id IS NULL OR created_at>?)`)
            .bind(ids, weekAgo),
        // askable: '거래 기록 요청' is left (ASK_LIMIT per post, on the trade_log_post index), read only for
        // the posts completed in the last 7 days (the only ones that can ask).
        db().prepare("SELECT post_id AS id FROM trade_log WHERE post_id IN (SELECT value FROM json_each(?)) AND event='ask' GROUP BY post_id HAVING COUNT(*)>=?").bind(recent, ASK_LIMIT),
    ]);
    const count = (rows: any[], id: number) => Number(rows.find(row => Number(row.id) === id)?.n) || 0;
    const traded = new Set((trades.results as { id: number }[]).map(t => Number(t.id)));
    const spent = new Set((asked.results as { id: number }[]).map(t => Number(t.id)));
    for (const p of posts) {
        p.fav_count = count(favs.results, p.id);
        p.chat_count = count(chats.results, p.id);
        // The '자동' chip and a pending '끌올 가능' 알림 (WP52), read with the list (own_auto: [bump, bump_remind]).
        const auto = parse(p.own_auto ?? 'null', null) as [number, number] | null;
        delete p.own_auto;
        p.auto = !!auto?.[0];
        p.remind_at = auto?.[1] || null;
        if (p.status === 'closed') { p.traded = traded.has(p.id); p.askable = !p.hidden && !p.traded && !spent.has(p.id); }
    }
}

// 끌올: moves an open post to the top of 최신순 and spends 1 from the member's 끌올 지갑 (users
// bump_tokens and bump_at; see walletOf). One batch: the post moves only while the wallet holds 1,
// the same-post gap has passed and the post is not ahead of now (새 글 우선); the wallet and the
// event are written only when the post moved at exactly this time. Parallel taps therefore spend at
// most what the wallet holds. The manager has no wallet and no gap.
const WALLET_NOW = 'MIN(?, bump_tokens+CAST((?-bump_at)/? AS INTEGER))';
async function bumpPost(u: User, post: any) {
    if (post.kind === 'proxy_offer' && !canOfferProxy(u)) fail(403, '대리(진행) 글은 대리 인증 회원만 끌올할 수 있습니다.');
    const perks = perksOf(u), now = Date.now(), gapMs = perks.bumpGapMinutes * 60000;
    const capped = Number.isFinite(perks.bumpMax), M = capped ? perks.bumpMax : 0, R = perks.bumpRefillMinutes * 60000;
    const moved = 'EXISTS(SELECT 1 FROM posts WHERE id=? AND bumped_at=?)';
    // 광고 (WP53): a 끌올 makes the post the member's newest ad slot (unless '광고 빼기').
    const ads = perks.adSlots;
    const r = await db().batch([
        db().prepare(`UPDATE posts SET bumped_at=?,bump_count=bump_count+1,touched_at=?,featured_at=CASE WHEN ?>0 AND featured_pin>=0 THEN ? ELSE featured_at END
            WHERE id=? AND author_id=? AND status='open' AND hidden=0 AND bumped_at<=?
            AND (CASE WHEN bump_count=0 THEN created_at ELSE bumped_at END)<=?${capped ? ` AND (SELECT ${WALLET_NOW} FROM users WHERE id=?)>=1` : ''}`)
            .bind(now, now, ads, now, post.id, u.id, now, now - gapMs, ...capped ? [M, now, R, u.id] : []),
        ...ads ? [adTrimStatement(u.id, ads)] : [],
        // A pending '끌올 가능' 알림 is no longer needed.
        db().prepare(`UPDATE post_auto SET bump_remind=0 WHERE post_id=? AND bump_remind>0 AND ${moved}`).bind(post.id, post.id, now),
        ...capped ? [db().prepare(`UPDATE users SET bump_tokens=${WALLET_NOW}-1,
            bump_at=CASE WHEN bump_tokens+CAST((?-bump_at)/? AS INTEGER)>=? THEN ? ELSE bump_at+CAST((?-bump_at)/? AS INTEGER)*? END
            WHERE id=? AND ${moved}`).bind(M, now, R, now, R, M, now, now, R, R, u.id, post.id, now)] : [],
        db().prepare(`INSERT INTO post_events(user_id,post_id,kind,created_at) SELECT ?,?,'bump',? WHERE ${moved}`).bind(u.id, post.id, now, post.id, now),
        db().prepare('SELECT bump_tokens,bump_at FROM users WHERE id=?').bind(u.id),
    ]);
    const stored = r[r.length - 1].results[0] as { bump_tokens: number; bump_at: number };
    if (!r[0].meta.changes) {
        const row = await db().prepare('SELECT status,hidden,bumped_at,created_at,bump_count FROM posts WHERE id=?').bind(post.id).first<any>();
        if (!row || row.status !== 'open' || row.hidden) fail(409, '거래중인 글만 끌올할 수 있습니다.');
        // Several blockers can hold at once; the message names the one that ends last, the same time
        // the 끌올 button shows ('15:40부터 가능'), so retrying at that time works.
        const w = walletOf(stored.bump_tokens, stored.bump_at, perks, now);
        const priorityEnd = row.bumped_at > now ? row.bumped_at : 0;
        const gapEnd = (row.bump_count ? row.bumped_at : row.created_at) + gapMs;
        const refillAt = w.tokens < 1 && w.nextRefillAt ? w.nextRefillAt : 0;
        const latest = Math.max(priorityEnd, gapEnd, refillAt);
        if (refillAt && refillAt === latest) fail(429, `끌올이 없습니다. ${clock(refillAt)}에 1개 충전됩니다.`);
        if (priorityEnd && priorityEnd === latest) fail(429, `새 글 우선 중인 글은 ${clock(priorityEnd)}부터 끌올할 수 있습니다.`);
        if (gapEnd > now) fail(429, `같은 글은 ${gapText(perks.bumpGapMinutes)}마다 끌올할 수 있습니다. (${clock(gapEnd)}부터 가능)`);
        fail(429, '잠시 후 다시 시도해 주세요.');
    }
    return json({ bumpedAt: now, nextBumpAt: now + gapMs, ...walletJson(stored, perks, now) });
}

// The wallet fields of GET me/usage and the 끌올 response (null for the manager: no wallet).
export function walletJson(stored: { bump_tokens: number; bump_at: number } | undefined, perks: Perks, now: number) {
    if (!Number.isFinite(perks.bumpMax)) return { bumpTokens: null, bumpMax: null, bumpRefillMin: null, nextRefillAt: null };
    const w = walletOf(stored?.bump_tokens ?? 0, stored?.bump_at ?? 0, perks, now);
    return { bumpTokens: w.tokens, bumpMax: perks.bumpMax, bumpRefillMin: perks.bumpRefillMinutes, nextRefillAt: w.nextRefillAt };
}

// 대표 글 (WP63): the author's allowance now, perks.profilePins of the current grade (the 체험 counts as 플러스,
// the manager as 엘리트), as SQL on the author id expression. Only the newest pins up to it show (pinnedSql),
// so a lower grade hides the older pins and deletes nothing.
const NOW_SQL = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const pinAllowanceSql = (author: string) => `(SELECT CASE WHEN pu.role='manager' THEN ${MANAGER_PERKS.profilePins} ELSE CASE COALESCE((SELECT MAX(g.rank) FROM user_grades g
    WHERE g.user_id=pu.id AND (g.expires_at IS NULL OR g.expires_at>${NOW_SQL})),0) ${GRADES.map(g => `WHEN ${g.rank} THEN ${PERKS[g.id].profilePins}`).join(' ')} ELSE 0 END END FROM users pu WHERE pu.id=${author})`;
// Whether row p is one of its author's shown 대표 글: pinned, visible, and fewer newer visible pins than
// the allowance (posts_profile_pin). The CASE reads nothing more for a post that is not pinned.
export const pinnedSql = (p = 'p') => `(CASE WHEN ${p}.profile_pin_at IS NULL OR ${p}.hidden!=0 THEN 0 ELSE (SELECT COUNT(*) FROM posts pq WHERE pq.author_id=${p}.author_id
    AND pq.profile_pin_at>${p}.profile_pin_at AND pq.hidden=0)<${pinAllowanceSql(`${p}.author_id`)} END)`;
// PUT /posts/:id/pin {active} (WP63): 대표 글 on the profile, 플러스 1, 프리미엄 3, 엘리트 and up 5. The count
// (the member's other visible pins, shown or not) is checked inside the UPDATE, so parallel taps cannot pass
// it; '대표 글 해제' always works, also on a pin a lower grade no longer shows.
async function pinPost(req: Request, u: User, post: any) {
    const b = await body(req);
    if (typeof b.active !== 'boolean') fail(400, '설정을 확인해 주세요.');
    if (!b.active) {
        await db().prepare('UPDATE posts SET profile_pin_at=NULL WHERE id=? AND author_id=?').bind(post.id, u.id).run();
        return json({ pinned: false });
    }
    const max = perksOf(u).profilePins;
    if (!max) fail(403, PIN_TEXT.off);
    if (post.hidden) fail(409, '숨김 처리된 글은 대표 글로 고정할 수 없습니다.');
    const r = await db().prepare(`UPDATE posts SET profile_pin_at=? WHERE id=? AND author_id=? AND hidden=0
        AND (SELECT COUNT(*) FROM posts q WHERE q.author_id=? AND q.profile_pin_at IS NOT NULL AND q.hidden=0 AND q.id!=?)<?`).bind(Date.now(), post.id, u.id, u.id, post.id, max).run();
    if (!r.meta.changes) fail(403, PIN_TEXT.full(max));
    return json({ pinned: true });
}

// The member's ad posts now (me/usage '광고 2/3 · 자동'): the slot posts that are open and visible.
export const FEATURED_MINE = "author_id=? AND featured_at IS NOT NULL AND featured_pin>=0 AND status='open' AND hidden=0";
// PUT /posts/:id/feature (WP53): {active:true} '광고 고정' keeps the post in a slot (a pin beyond the
// grade's slots unpins the member's oldest pin, which goes back to automatic); {active:false} '광고 빼기'
// keeps it out of the ads and frees its slot for the newest automatic post. 프리미엄 and above only.
async function featurePost(req: Request, u: User, post: any) {
    const b = await body(req), slots = perksOf(u).adSlots, now = Date.now(), active = !!b.active;
    if (!slots) fail(403, AD_TEXT.error);
    if (active) {
        if (post.kind === 'proxy_offer' && !canOfferProxy(u)) fail(403, '대리(진행) 글은 대리 인증 회원만 광고할 수 있습니다.');
        if (post.status !== 'open' || post.hidden) fail(409, AD_TEXT.open);
    }
    const pins = "author_id=? AND featured_pin=1 AND status='open' AND hidden=0";
    const replaced = active
        ? (await db().prepare(`SELECT id,title FROM posts WHERE ${pins} AND id!=? ORDER BY featured_at DESC LIMIT -1 OFFSET ?`).bind(u.id, post.id, slots - 1).all<{ id: number; title: string }>()).results
        : [];
    const r = await db().batch([
        active ? db().prepare("UPDATE posts SET featured_pin=1,featured_at=? WHERE id=? AND status='open' AND hidden=0").bind(now, post.id)
            : db().prepare('UPDATE posts SET featured_pin=-1,featured_at=NULL WHERE id=?').bind(post.id),
        ...replaced.length ? [db().prepare('UPDATE posts SET featured_pin=0 WHERE id IN (SELECT value FROM json_each(?)) AND featured_pin=1').bind(JSON.stringify(replaced.map(x => x.id)))] : [],
        adTrimStatement(u.id, slots),
        ...active ? [] : [adFillStatement(u.id, slots, now)],
        db().prepare(`SELECT COUNT(*) AS n FROM posts WHERE ${FEATURED_MINE}`).bind(u.id),
    ]);
    if (active && !r[0].meta.changes) fail(409, AD_TEXT.open);
    return json({
        pinned: active, featured: active, slots, used: Number((r[r.length - 1].results[0] as any)?.n) || 0,
        replaced: replaced.length ? { id: replaced[0].id, title: replaced[0].title } : null,
    });
}

// Quick 즉거가 and 현젯 change for a 판매 post, without the editor. It never bumps the post.
// currentOffer '' or null removes 현젯.
async function patchPrice(req: Request, u: User, post: any) {
    if (post.kind !== 'sell') fail(400, '판매 글만 가격을 수정할 수 있습니다.');
    if (post.status === 'closed') fail(409, '완료된 글은 수정할 수 없습니다.');
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
        ...hasPrice && price !== null ? [priceDropNotify(post.id, post.author_id, post.title, price, now)] : [],
        db().prepare(`UPDATE posts SET ${sets.join(',')},updated_at=?,touched_at=? WHERE id=? AND kind='sell'`).bind(...args, now, now, post.id),
    ]);
    return json({ post: (await decorate([await rawPost(post.id)], u, true))[0] });
}

// PATCH /posts/:id/status {status:'closed', partnerId?, amount?} (WP43): 완료 is final and one batch.
// The post closes (closed_at, and its 광고 slot ends), its pending 제시 end (an accepted one survives
// only when its sender is the partner named), and with a partner the pending trade record and its
// '거래 확인 요청' card follow, guarded on this very completion (and on the post not being hidden). Under
// 이용 정지, or on a post the manager has hidden, the post can still be completed, without a trade
// record. 'open' (and a legacy 'reserved') is a no-op on an open post.
async function completePost(req: Request, u: User, post: any) {
    const b = await body(req);
    if (!['open', 'reserved', 'closed'].includes(b.status)) fail(400, '거래 상태를 확인해 주세요.');
    if (b.status !== 'closed') {
        if (post.status === 'closed') fail(409, '완료된 글은 되돌릴 수 없습니다.');
        return json({ ok: true });
    }
    if (post.status === 'closed') fail(409, '이미 완료된 글입니다.');
    const now = Date.now();
    const withPartner = !isSuspended(u.suspended_until, now) && !post.hidden && typeof b.partnerId === 'string' && !!b.partnerId;
    if (withPartner) await limit('trade:' + u.id, 20, 600000);
    const guard = 'EXISTS(SELECT 1 FROM posts WHERE id=? AND closed_at=?)', guardArgs = [post.id, now];
    // The record also needs the post visible: hiding it while this request runs blocks the record.
    const tradeGuard = 'EXISTS(SELECT 1 FROM posts WHERE id=? AND closed_at=? AND hidden=0)';
    const plan = withPartner ? await planTrade({ ...post, status: 'closed', closed_at: now }, u, b.partnerId, b.amount, now, tradeGuard, guardArgs) : null;
    const keep = plan ? b.partnerId : null;
    const r = await db().batch([
        // updated_at stays the last edit of the listing; closed_at is the completion.
        db().prepare("UPDATE posts SET status='closed',closed_at=?,featured_at=NULL WHERE id=? AND status!='closed'").bind(now, post.id),
        ...endOffersStatements(post.id, post.author_id, `${COMPLETE_ENDS_OFFERS} AND ${guard}`, [keep, ...guardArgs], now),
        ...plan ? plan.statements : [],
        // '판매완료 · 제목' (WP50) to every member who saved the post, guarded on this very completion; the
        // member named as the partner gets the trade request instead.
        favoritesNotify('fav_closed', post.id, post.author_id, `${statusName(post.kind, 'closed')} · ${post.title}`, now, 'EXISTS(SELECT 1 FROM posts WHERE id=? AND closed_at=? AND hidden=0) AND x.user_id IS NOT ?', [...guardArgs, typeof b.partnerId === 'string' && b.partnerId ? b.partnerId : null]),
        // 광고 (WP53): the freed slot takes the member's newest automatic open post.
        ...perksOf(u).adSlots ? [adFillStatement(u.id, perksOf(u).adSlots, now, guard, guardArgs)] : [],
        // 자동 가격 내리기 (WP56) ends with 완료 (a delete removes the row with the post).
        db().prepare(`UPDATE post_auto SET drop_on=0 WHERE post_id=? AND drop_on=1 AND ${guard}`).bind(post.id, ...guardArgs),
    ]);
    if (!r[0].meta.changes) fail(409, '이미 완료된 글입니다.');
    // r[0] is the post, then the three statements that end the 제시, then the plan's DELETE and INSERT.
    const recorded = plan ? !!r[5].meta.changes : false;
    return json({ ok: true, closed_at: now, ...plan ? { trade: recorded ? plan.trade : null, chatId: plan.chatId } : {} });
}

// Guests counted in this isolate today: hashed address + post id → the KST day (no D1 write). At most
// 5,000 entries, the oldest dropped first.
const guestViews = new Map<string, number>();
const GUEST_VIEWS_MAX = 5000;

// 판매 통계 (WP63): whether the post's author keeps views by the hour ('trend' and up: 프리미엄, 엘리트,
// 관리자 and the manager; never the 체험), from the author columns of postSelect.
export const keepsViews = (post: { role?: string | null; author_grade_info?: string | null }) =>
    STATS_RANK[perksOf({ role: post.role, grade: parse(post.author_grade_info ?? 'null', null)?.grade }).stats] >= STATS_RANK.trend;

// One 조회: a member counts once per 6 hours per post (the 최근 본 글 row it also refreshes, which
// moved here from POST /view; the 100-row trim runs on 1 view in 10), a guest once per address, post
// and KST day in this isolate. Returns 1 when the view counted. A counted view that came from an ad
// (?from=ad, WP53) also counts as '광고 유입'. With `hourly` (keepsViews) the counted view is also added
// to post_views for the hour (WP63); other posts cost no extra write.
async function countView(req: Request, u: User | null, postId: number, fromAd = false, hourly = false): Promise<number> {
    const now = Date.now(), promo = fromAd ? 1 : 0;
    const viewRow = (guard: string, args: unknown[]) => db().prepare(`INSERT INTO post_views(post_id,hour,n) SELECT ?,?,1 WHERE ${guard}
        ON CONFLICT(post_id,hour) DO UPDATE SET n=n+1`).bind(postId, Math.floor(now / HOUR), ...args);
    if (u) {
        // The 6-hour test reads history before this batch refreshes it.
        const fresh = 'NOT EXISTS(SELECT 1 FROM history WHERE user_id=? AND post_id=? AND created_at>?)', freshArgs = [u.id, postId, now - 6 * HOUR];
        const r = await db().batch([
            db().prepare(`UPDATE posts SET view_count=view_count+1,promo_views=promo_views+? WHERE id=? AND ${fresh}`).bind(promo, postId, ...freshArgs),
            ...hourly ? [viewRow(fresh, freshArgs)] : [],
            db().prepare('INSERT INTO history(user_id,post_id,created_at) VALUES(?,?,?) ON CONFLICT(user_id,post_id) DO UPDATE SET created_at=excluded.created_at').bind(u.id, postId, now),
            ...Math.random() < 0.1 ? [db().prepare('DELETE FROM history WHERE user_id=? AND post_id NOT IN(SELECT post_id FROM history WHERE user_id=? ORDER BY created_at DESC LIMIT 100)').bind(u.id, u.id)] : [],
        ]);
        return r[0].meta.changes ? 1 : 0;
    }
    const key = (await digest('view:' + (req.headers.get('CF-Connecting-IP') || ''))).slice(0, 24) + ':' + postId, day = kstDayStart(now);
    if (guestViews.get(key) === day) return 0;
    guestViews.delete(key);
    guestViews.set(key, day);
    while (guestViews.size > GUEST_VIEWS_MAX) guestViews.delete(guestViews.keys().next().value!);
    await db().batch([
        db().prepare('UPDATE posts SET view_count=view_count+1,promo_views=promo_views+? WHERE id=?').bind(promo, postId),
        ...hourly ? [viewRow('EXISTS(SELECT 1 FROM posts WHERE id=?)', [postId])] : [],
    ]);
    return 1;
}

export async function postsHandler(req: Request, p: string[], url: URL): Promise<Response> {
    const method = req.method;
    if (method === 'GET' && !p[1]) return listPosts(req, url);
    if (p[1] && method === 'GET' && !p[2]) {
        const u = await currentUser(req), post = await visiblePost(p[1], u);
        // 조회수 (WP45): the detail page asks with view=1 once per post and KST day; the author never counts.
        if (url.searchParams.get('view') === '1' && post.author_id !== u?.id) {
            post.view_count = (Number(post.view_count) || 0) + await countView(req, u, post.id, url.searchParams.get('from') === 'ad', keepsViews(post));
        }
        // '거래 12회 · 거금 340만원 · 후기 좋아요 9' (WP43) for the author box (none for a withdrawn author),
        // and under a completed post '비슷한 매물' (WP53): other advertisers' open posts of the same tab, in
        // the same batch. An open post never carries ads (its seller keeps the buyer).
        const now = Date.now(), closed = post.status === 'closed';
        // The viewer's 구독 of the author (WP54) rides the same batch, and so does '찜 12' (WP59: every
        // favorite of the post, on the favorites_post index), read last.
        const followRead = !!u && u.id !== post.author_id && !post.author_deleted_at;
        const reads = [...!post.author_deleted_at ? [tradeStatsStatement(post.author_id)] : [], ...closed ? [similarStatement(post, u, now)] : [],
            ...followRead ? [db().prepare('SELECT EXISTS(SELECT 1 FROM follows WHERE user_id=? AND target_id=?) AS f,follow_allowed AS a FROM users WHERE id=?').bind(u!.id, post.author_id, post.author_id)] : [],
            db().prepare('SELECT COUNT(*) AS n FROM favorites WHERE post_id=?').bind(post.id)];
        const got = await db().batch(reads);
        const favCount = Number((got.pop()!.results[0] as { n: number } | undefined)?.n) || 0;
        const follow = followRead ? got.pop()!.results[0] as { f: number; a: number } | undefined : undefined;
        if (!post.author_deleted_at) {
            const stats = tradeStatsOf(got[0].results as any[]);
            Object.assign(post, { author_trade_count: stats.trade_count, author_deal_sum: stats.deal_sum, author_good_count: stats.good_count });
        }
        const similar = closed ? stripAdRank(pickSimilar(got[got.length - 1].results as any[], post, now)) : [];
        const all = await decorate([post, ...similar], u, true);
        const out = all[0];
        // Lists carry only the 대표 photo; the ad cards are list rows.
        if (closed) out.ads = all.slice(1).map(a => ({ ...a, images: a.images.slice(0, 1), link_preview: undefined, body_style: undefined }));
        out.link_cards = await shownCards(req, post, out.author_grade, out.role);
        // The author's '자동 끌올' switch and a pending '끌올 가능' 알림 (WP52).
        if (u && u.id === post.author_id) out.auto = await postAutoOf(post, u);
        if (follow) { out.author_followed = !!follow.f; out.author_follow_allowed = !!follow.a; }
        out.fav_count = favCount;
        return json({ post: out });
    }
    const u = await requireUser(req);
    await limit('post:' + u.id, 50, 60000);
    // 내 글 일괄 변경 (WP58).
    if (p[1] === 'bulk' && !p[2] && method === 'POST') return bulkPosts(req, u);
    const existing = p[1] ? await visiblePost(p[1], u) : null;
    if (p[2] === 'favorite' && method === 'POST') {
        const b = await body(req);
        // The price the member saw is kept with the favorite, for 찜한 글's '가격 내림'.
        if (b.active) await db().prepare('INSERT OR IGNORE INTO favorites(user_id,post_id,created_at,saved_price) SELECT ?,id,?,price FROM posts WHERE id=?').bind(u.id, Date.now(), existing.id).run();
        else await db().prepare('DELETE FROM favorites WHERE user_id=? AND post_id=?').bind(u.id, existing.id).run();
        return json({ ok: true });
    }
    // The pre-WP45 view call, kept for one release (pages loaded before the deploy); the detail page now
    // sends GET posts/:id?view=1.
    if (p[2] === 'view' && method === 'POST') {
        if (existing.author_id !== u.id) await countView(req, u, existing.id, false, keepsViews(existing));
        return json({ ok: true });
    }
    if (existing && existing.author_id !== u.id && (u.role !== 'manager' || method !== 'DELETE')) fail(403, '권한이 없습니다.');
    // The list behind a '맞는 구매 글' 알림 (WP58).
    if (p[2] === 'matches' && method === 'GET') return matchesOf(u, existing, url);
    if (method === 'DELETE' && existing) {
        await db().prepare('DELETE FROM posts WHERE id=?').bind(existing.id).run();
        return json({ ok: true });
    }
    // 이용 정지 stops writing, 끌올, 광고 고정·빼기 and price changes; closing (거래완료) or deleting a post still works.
    if ((p[2] === 'bump' && method === 'POST') || (p[2] === 'feature' && method === 'PUT') || (p[2] === 'price' && method === 'PATCH') || (!p[2] && (method === 'POST' || method === 'PUT'))) requireActive(u);
    if (p[2] === 'bump' && method === 'POST') return bumpPost(u, existing);
    if (p[2] === 'feature' && method === 'PUT') return featurePost(req, u, existing);
    if (p[2] === 'price' && method === 'PATCH') return patchPrice(req, u, existing);
    if (p[2] === 'status' && method === 'PATCH') return completePost(req, u, existing);
    if (p[2] === 'auto' && method === 'PUT') return postAutoHandler(req, u, existing);
    // 대표 글 (WP63).
    if (p[2] === 'pin' && !p[3] && method === 'PUT') return pinPost(req, u, existing);
    if (!['POST', 'PUT'].includes(method) || p[2]) fail(405, '지원하지 않는 요청입니다.');
    if (method === 'POST' && p[1] || method === 'PUT' && !existing) fail(400, '게시글 번호를 확인해 주세요.');
    // A completed post is read-only (WP43): delete, 다시 올리기 and 복사해서 새 글 stay.
    if (existing && existing.status === 'closed') fail(409, '완료된 글은 수정할 수 없습니다.');
    const v = await validatePost(await body(req), u, existing), now = Date.now();
    // A link to a host the manager blocked refuses the save (WP48); titles are never linked.
    await assertNoBlockedLinks(req, v.content);
    // The manager and POST_LIMITS=relaxed (local tests) skip every rule: caps, 같은 매물, the allowance.
    const strict = u.role !== 'manager' && !relaxedLimits(req);
    const print = await buildPrint(v, v.uploads);
    const res = existing ? await editPost(u, existing, v, print, now, strict) : await createPost(u, v, print, now, strict);
    // 링크 미리보기 (WP48): built only here, after a successful save, for 플러스 and up.
    if (res.status === 200 || res.status === 201) {
        const id = existing ? existing.id : (await res.clone().json() as { id: number }).id;
        await unfurlOnSave(req, id, v.content, u, !!v.linkPreview);
    }
    return res;
}

// 내 글 일괄 변경 (WP58): POST posts/bulk {action, ids} with at most BULK_MAX own posts, for every grade.
// Each action is a fixed number of set-based statements in one batch (never one per post, so 30 posts stay
// inside the Free plan's 50 queries a request), and the answer names what happened to every id:
// {done: [ids], skipped: [{id, reason}]}, each reason the message the single-post route gives.
// - bump: the posts that can be bumped, oldest bumped first, 1 끌올 each while the wallet holds; the
//   UPDATE re-checks the gap, 새 글 우선 and the wallet inside the batch, so parallel requests never
//   overspend. {all: true} instead of ids is '모두 끌올': every open post of the member until the wallet is
//   empty; its skipped list starts with the most useful reason (the wallet, else the soonest post).
// - close: 완료 without a trade record (one can still be asked for within 7 days, as after '사이트 밖 거래'):
//   pending and accepted 제시 end with their line, 찜 members hear '판매완료 · 제목', 광고 and 가격 내리기 end.
// - delete: as the single route. auto {on}: the 선택 bar's [자동 끌올] (엘리트 and up, worker/automation.ts).
type BulkRow = { id: number; author_id: string; kind: string; status: string; hidden: number; bumped_at: number; created_at: number; bump_count: number };
type Skip = { id: number; reason: string };
async function bulkPosts(req: Request, u: User) {
    const b = await body(req), now = Date.now(), action = b.action;
    if (!['bump', 'close', 'delete', 'auto'].includes(action)) fail(400, BULK_TEXT.action);
    const all = action === 'bump' && b.all === true;
    let ids: number[] = [];
    if (!all) {
        if (!Array.isArray(b.ids) || !b.ids.length) fail(400, BULK_TEXT.none);
        if (b.ids.length > BULK_MAX) fail(400, BULK_TEXT.max);
        if (b.ids.some((x: unknown) => !Number.isSafeInteger(x) || (x as number) < 1)) fail(400, '게시글 번호를 확인해 주세요.');
        ids = [...new Set(b.ids as number[])];
    }
    if (action === 'auto' && typeof b.on !== 'boolean') fail(400, '설정을 확인해 주세요.');
    // 이용 정지 stops 끌올 and 자동 끌올; closing and deleting still work, as on one post.
    if (action === 'bump' || action === 'auto') requireActive(u);
    const cols = 'SELECT id,author_id,kind,status,hidden,bumped_at,created_at,bump_count FROM posts';
    const [rowsR, walletR] = await db().batch([
        all ? db().prepare(`${cols} INDEXED BY posts_author_status WHERE author_id=? AND status='open' AND hidden=0 ORDER BY bumped_at,id LIMIT 300`).bind(u.id)
            : db().prepare(`${cols} WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)),
        db().prepare('SELECT bump_tokens,bump_at FROM users WHERE id=?').bind(u.id),
    ]);
    const rows = new Map((rowsR.results as BulkRow[]).map(r => [r.id, r]));
    if (all) ids = [...rows.keys()];
    const skipped: Skip[] = [], mine: BulkRow[] = [];
    for (const id of ids) {
        const r = rows.get(id);
        if (!r || (r.author_id !== u.id && r.hidden)) skipped.push({ id, reason: '게시글을 찾을 수 없습니다.' });
        else if (r.author_id !== u.id) skipped.push({ id, reason: '권한이 없습니다.' });
        else mine.push(r);
    }
    const list = (posts: BulkRow[]) => JSON.stringify(posts.map(r => r.id));
    if (action === 'bump') return bulkBump(u, mine, skipped, walletR.results[0] as { bump_tokens: number; bump_at: number }, now);
    if (action === 'close') return bulkClose(u, mine, skipped, now);
    // done keeps the order of the request.
    if (action === 'auto') {
        const changed = new Set(mine.length ? await bulkAuto(u, list(mine), b.on, now) : []);
        for (const r of mine) if (!changed.has(r.id)) skipped.push({ id: r.id, reason: '거래중인 글만 자동 끌올할 수 있습니다.' });
        return json({ done: mine.filter(r => changed.has(r.id)).map(r => r.id), skipped });
    }
    const r = mine.length ? await db().prepare('DELETE FROM posts WHERE id IN (SELECT value FROM json_each(?)) AND author_id=? RETURNING id').bind(list(mine), u.id).all<{ id: number }>() : null;
    const deleted = new Set(r ? r.results.map(x => x.id) : []);
    for (const m of mine) if (!deleted.has(m.id)) skipped.push({ id: m.id, reason: '게시글을 찾을 수 없습니다.' });
    return json({ done: mine.filter(m => deleted.has(m.id)).map(m => m.id), skipped });
}

async function bulkBump(u: User, mine: BulkRow[], skipped: Skip[], stored: { bump_tokens: number; bump_at: number }, now: number) {
    const perks = perksOf(u), gapMs = perks.bumpGapMinutes * 60000;
    const ready: BulkRow[] = [], later: (Skip & { at: number })[] = [];
    for (const r of mine) {
        if (r.status !== 'open' || r.hidden) { skipped.push({ id: r.id, reason: '거래중인 글만 끌올할 수 있습니다.' }); continue; }
        if (r.kind === 'proxy_offer' && !canOfferProxy(u)) { skipped.push({ id: r.id, reason: '대리(진행) 글은 대리 인증 회원만 끌올할 수 있습니다.' }); continue; }
        // As bumpPost words it: the blocker that ends last (새 글 우선 or the same-post gap).
        const priorityEnd = r.bumped_at > now ? r.bumped_at : 0, gapEnd = (r.bump_count ? r.bumped_at : r.created_at) + gapMs;
        if (priorityEnd && priorityEnd >= gapEnd) later.push({ id: r.id, reason: `새 글 우선 중인 글은 ${clock(priorityEnd)}부터 끌올할 수 있습니다.`, at: priorityEnd });
        else if (gapEnd > now) later.push({ id: r.id, reason: `같은 글은 ${gapText(perks.bumpGapMinutes)}마다 끌올할 수 있습니다. (${clock(gapEnd)}부터 가능)`, at: gapEnd });
        else ready.push(r);
    }
    const chosen = ready.sort((x, y) => x.bumped_at - y.bumped_at || x.id - y.id).slice(0, BULK_MAX);
    const capped = Number.isFinite(perks.bumpMax), M = capped ? perks.bumpMax : 0, R = perks.bumpRefillMinutes * 60000, ads = perks.adSlots;
    const ids = JSON.stringify(chosen.map(r => r.id));
    const moved = 'SELECT id FROM posts WHERE id IN (SELECT value FROM json_each(?)) AND author_id=? AND bumped_at=?', movedArgs = [ids, u.id, now];
    // The posts move in the order of the list (oldest first) while the wallet holds; the wallet then
    // spends exactly as many as moved, and each gets its 'bump' event.
    const r = chosen.length ? await db().batch([
        db().prepare(`UPDATE posts SET bumped_at=?,bump_count=bump_count+1,touched_at=?,featured_at=CASE WHEN ?>0 AND featured_pin>=0 THEN ? ELSE featured_at END
            WHERE id IN (SELECT id FROM (SELECT q.id,ROW_NUMBER() OVER (ORDER BY j.key) AS rn FROM json_each(?) j JOIN posts q ON q.id=j.value
                WHERE q.author_id=? AND q.status='open' AND q.hidden=0 AND q.bumped_at<=? AND (CASE WHEN q.bump_count=0 THEN q.created_at ELSE q.bumped_at END)<=?)
                ${capped ? `WHERE rn<=(SELECT ${WALLET_NOW} FROM users WHERE id=?)` : ''})`)
            .bind(now, now, ads, now, ids, u.id, now, now - gapMs, ...capped ? [M, now, R, u.id] : []),
        ...ads ? [adTrimStatement(u.id, ads)] : [],
        db().prepare(`UPDATE post_auto SET bump_remind=0 WHERE post_id IN (${moved}) AND bump_remind>0`).bind(...movedArgs),
        ...capped ? [db().prepare(`UPDATE users SET bump_tokens=${WALLET_NOW}-(SELECT COUNT(*) FROM (${moved})),
            bump_at=CASE WHEN bump_tokens+CAST((?-bump_at)/? AS INTEGER)>=? THEN ? ELSE bump_at+CAST((?-bump_at)/? AS INTEGER)*? END
            WHERE id=? AND EXISTS(${moved})`).bind(M, now, R, ...movedArgs, now, R, M, now, now, R, R, u.id, ...movedArgs)] : [],
        db().prepare(`INSERT INTO post_events(user_id,post_id,kind,created_at) SELECT ?,id,'bump',? FROM (${moved})`).bind(u.id, now, ...movedArgs),
        db().prepare(moved).bind(...movedArgs),
        db().prepare('SELECT bump_tokens,bump_at FROM users WHERE id=?').bind(u.id),
    ]) : null;
    // done in the order they went (oldest first).
    const movedIds = new Set(r ? (r[r.length - 2].results as { id: number }[]).map(x => x.id) : []);
    const done = chosen.filter(x => movedIds.has(x.id)).map(x => x.id);
    const after = r ? r[r.length - 1].results[0] as { bump_tokens: number; bump_at: number } : stored;
    const w = walletOf(after.bump_tokens, after.bump_at, perks, now);
    const empty = w.tokens < 1 && w.nextRefillAt ? `끌올이 없습니다. ${clock(w.nextRefillAt)}에 1개 충전됩니다.` : '잠시 후 다시 시도해 주세요.';
    const wallet = ready.filter(x => !done.includes(x.id)).map(x => ({ id: x.id, reason: empty }));
    return json({ done, skipped: [...wallet, ...later.sort((x, y) => x.at - y.at).map(({ id, reason }) => ({ id, reason })), ...skipped], ...walletJson(after, perks, now) });
}

async function bulkClose(u: User, mine: BulkRow[], skipped: Skip[], now: number) {
    const open = mine.filter(r => r.status !== 'closed'), perks = perksOf(u);
    for (const r of mine) if (r.status === 'closed') skipped.push({ id: r.id, reason: '이미 완료된 글입니다.' });
    const closed = 'SELECT id FROM posts WHERE id IN (SELECT value FROM json_each(?)) AND author_id=? AND closed_at=?', closedArgs = [JSON.stringify(open.map(r => r.id)), u.id, now];
    // No partner is named, so an accepted 제시 ends too (COMPLETE_ENDS_OFFERS with null), the line first.
    const ended = `post_id IN (${closed}) AND status IN ('pending','accepted')`;
    const names = JSON.stringify(Object.fromEntries(TRADE_KINDS.map(k => [k, statusName(k, 'closed')])));
    const r = open.length ? await db().batch([
        db().prepare("UPDATE posts SET status='closed',closed_at=?,featured_at=NULL WHERE id IN (SELECT value FROM json_each(?)) AND author_id=? AND status!='closed'").bind(now, closedArgs[0], u.id),
        db().prepare(`INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) SELECT DISTINCT conversation_id,?,?,'system',NULL,'[]',? FROM offers WHERE ${ended}`).bind(u.id, OFFERS_ENDED_TEXT, now, ...closedArgs),
        db().prepare(`UPDATE conversations SET updated_at=? WHERE id IN (SELECT conversation_id FROM offers WHERE ${ended})`).bind(now, ...closedArgs),
        db().prepare(`UPDATE offers SET status='cancelled',updated_at=? WHERE ${ended}`).bind(now, ...closedArgs),
        notifyStatement('fav_closed', `SELECT f.user_id,CAST(f.post_id AS TEXT) AS ref,f.post_id,p.author_id AS actor_id,COALESCE(json_extract(?,'$.'||p.kind),'')||' · '||p.title AS text
            FROM favorites f JOIN posts p ON p.id=f.post_id WHERE f.post_id IN (${closed}) AND p.hidden=0`, [names, ...closedArgs], now),
        db().prepare(`UPDATE post_auto SET drop_on=0 WHERE post_id IN (${closed}) AND drop_on=1`).bind(...closedArgs),
        // 광고 (WP53): each freed slot takes the member's newest automatic open post.
        ...Array.from({ length: perks.adSlots }, () => adFillStatement(u.id, perks.adSlots, now)),
        db().prepare(closed).bind(...closedArgs),
    ]) : null;
    const closedIds = new Set(r ? (r[r.length - 1].results as { id: number }[]).map(x => x.id) : []);
    const done = open.filter(o => closedIds.has(o.id)).map(o => o.id);
    for (const o of open) if (!closedIds.has(o.id)) skipped.push({ id: o.id, reason: '이미 완료된 글입니다.' });
    return json({ done, skipped });
}

// GET posts/:id/matches?from=<post id> (WP58): the posts of the other side that match the member's own open
// 판매 or 구매 post (worker/match.ts), from the 알림's first match on (MATCH_SCAN ids, as the 알림함 counts
// them), or without from in the board's 30 days; newest first, at most 20, as list rows.
async function matchesOf(u: User, own: any, url: URL) {
    if (own.kind !== 'sell' && own.kind !== 'buy') fail(400, MATCH_TEXT.kinds);
    const now = Date.now(), from = Number(url.searchParams.get('from')), byId = Number.isSafeInteger(from) && from > 0;
    const range = byId ? 'p.id>=? AND p.id<?' : 'p.kind=? AND p.category=? AND p.bumped_at>?';
    const args = byId ? [from, from + MATCH_SCAN] : [own.kind === 'sell' ? 'buy' : 'sell', own.category, now - LIST_WINDOW];
    const r = await db().prepare(`${postSelect} JOIN posts o ON o.id=? AND o.status='open' AND o.hidden=0 WHERE ${range} AND p.relist=0 AND p.status!='closed'
        AND ${pairSql('o', 'p')} AND ${reachable('o.author_id', String(now))} ORDER BY p.bumped_at DESC,p.id DESC LIMIT 20`).bind(own.id, ...args).all();
    // The own post comes along for the sheet's title and its '게시판에서 보기' link (the same board query as
    // the '맞는 구매 글' link).
    const [mine, ...posts] = await decorate([own, ...r.results as any[]], u);
    return json({ posts, own: { id: mine.id, kind: mine.kind, title: mine.title, query: matchQuery(mine)?.query ?? null } });
}

type Valid = Awaited<ReturnType<typeof validatePost>>;
const isWant = (kind: string) => kind === 'buy' || kind === 'proxy_request';

// 409 for a new post (or an edit) that is the same listing as one of the author's open posts: which
// post, what is the same ('사진 3장'), and when it can be bumped (null: now, or hidden by the manager,
// which the author fixes by editing it). The editor keeps the draft and offers that post's 끌올.
function duplicate(kind: string, row: PrintRow, match: Match, perks: Perks, wallet: { tokens: number; nextRefillAt: number | null }, now: number) {
    const hidden = !!row.hidden;
    const error = hidden ? '숨김 처리된 같은 매물 글이 있습니다. 그 글을 수정해 주세요.'
        : match.why === 'title' ? '같은 제목의 거래중 글이 있습니다. 그 글을 끌올해 주세요.'
        : isWant(kind) ? '같은 조건의 거래중 글이 있습니다. 그 글을 끌올해 주세요.'
        : '같은 매물의 거래중 글이 있습니다. 그 글을 끌올해 주세요.';
    let bumpAt: number | null = null;
    if (!hidden) {
        // The latest of the post's own gap, its 새 글 우선 and the wallet refill, as bumpPost words it.
        const gapEnd = (row.bump_count ? row.bumped_at! : row.created_at!) + perks.bumpGapMinutes * 60000;
        const priorityEnd = row.bumped_at! > now ? row.bumped_at! : 0;
        const refillAt = wallet.tokens < 1 && wallet.nextRefillAt ? wallet.nextRefillAt : 0;
        const t = Math.max(gapEnd, priorityEnd, refillAt);
        bumpAt = t > now ? t : null;
    }
    return json({ error, dup: { id: row.post_id, title: row.title, thumb: row.thumb, price: row.price, price_mode: row.price_mode, kind, why: match.why, same: sameText(match), bumpAt, hidden } }, 409);
}

// The cross-account results of a pre-check batch, after the statements that come before them.
function crossResults(r: D1Result[], from: number, cross: ReturnType<typeof crossStatements>, print: NewPrint) {
    let i = from;
    return { keys: cross.keys, uploads: cross.keys.length ? r[i++].results as any[] : undefined, prints: print.fields_hash ? r[i].results as any[] : undefined };
}

// A new post (decisions item 1). One pre-check batch reads the caps, the wallet, the author's prints of
// this kind and (with hashes or account fields) the cross-account hits; matching runs in JS.
// - The same listing open (or hidden) → 409, the only refusal.
// - The same listing completed or deleted within 7 days → a relist (relist=1, bump_count=1): its old
//   place inside the listing's 끌올 gap ('old'), else 1 끌올 ('bump'), else below the latest top time
//   ('last', the stepped placement of the allowance, never above the old place).
// - Otherwise the 새 글 allowance: the first SITE_RULES.freshPerDay new posts of the KST day go 1 hour
//   ahead of now ('fresh': 새 글 우선, no 끌올 meanwhile); from the next one 1 끌올 ('bump'), or with the
//   wallet empty T − refill × (1 + new posts since T) below the latest 'fresh'/'bump' time T ('last').
// Every choice is one CASE inside the guarded INSERT, and the wallet and the events follow only when the
// post landed exactly there, so parallel creates cannot overspend (one D1 transaction).
async function createPost(u: User, v: Valid, print: NewPrint, now: number, strict: boolean) {
    const rules = rulesOf(u), perks = perksOf(u), dayStart = kstDayStart(now), gapMs = perks.bumpGapMinutes * 60000;
    const M = strict ? perks.bumpMax : 0, R = perks.bumpRefillMinutes * 60000, key = print.title_key;
    let relist: PrintRow | null = null, report: string | null = null, sold: string | null = null;
    if (strict) {
        const cross = crossStatements(print, u.id, now);
        const r = await db().batch([
            db().prepare(`SELECT u.bump_tokens,u.bump_at,(SELECT COUNT(*) FROM posts WHERE author_id=u.id AND status!='closed') AS openCount,
                (SELECT COUNT(*) FROM post_events WHERE user_id=u.id AND kind='post' AND created_at>=?) AS postsToday FROM users u WHERE u.id=?`).bind(dayStart, u.id),
            printsStatement(u.id, v.kind, now),
            ...cross.statements,
        ]);
        const c = r[0].results[0] as { bump_tokens: number; bump_at: number; openCount: number; postsToday: number };
        // Anti-flood ceilings, the same for every member (SITE_RULES): 거래중 posts (hidden included) and
        // new posts today (deleting one does not give it back).
        if (c.openCount >= rules.openPosts) fail(429, `도배 방지: 거래중 글은 ${rules.openPosts}개까지입니다. 거래완료로 바꾸거나 삭제해 주세요.`);
        if (c.postsToday >= rules.postsPerDay) fail(429, `도배 방지: 오늘 새 글은 ${rules.postsPerDay}개까지입니다.`);
        const { open, gone } = findMatch(print, r[1].results as PrintRow[]);
        if (open) return duplicate(v.kind, open.row, open.match, perks, walletOf(c.bump_tokens, c.bump_at, perks, now), now);
        relist = gone?.row || null;
        // A relist of a listing the author recorded as sold flags possible 회수 (the buyer is named on the
        // trade), when its photos or fields match (a title alone is too weak to flag).
        if (relist && gone && gone.match.why !== 'title' && soldTo(relist, u.id)) sold = `거래완료 글 #${relist.post_id} (구매자 지정) · 같은 매물`;
        report = crossHit(print, u.id, crossResults(r, 2, cross, print));
    }
    // The insert repeats both counts so parallel requests cannot pass them. The follow-up rows select
    // the new post's id and insert nothing when the insert was refused.
    const guard = strict ? "(SELECT COUNT(*) FROM posts WHERE author_id=? AND status!='closed')<? AND (SELECT COUNT(*) FROM post_events WHERE user_id=? AND kind='post' AND created_at>=?)<?" : '1';
    const newPost = '(SELECT id FROM posts WHERE author_id=? AND created_at=? AND title_key=? ORDER BY id DESC LIMIT 1)', newArgs = [u.id, now, key];
    const freshCount = "(SELECT COUNT(*) FROM post_events WHERE user_id=? AND kind='fresh' AND created_at>=?)", freshArgs = [u.id, dayStart];
    const walletNow = `(SELECT ${WALLET_NOW} FROM users WHERE id=?)`, walletArgs = [M, now, R, u.id];
    // Below the latest top time T of the last 2 days, one refill interval per new post since T; NULL
    // without a top time.
    const stepped = `(SELECT top.t-?*(1+(SELECT COUNT(*) FROM post_events WHERE user_id=? AND kind='post' AND created_at>top.t))
        FROM (SELECT MAX(created_at) AS t FROM post_events WHERE user_id=? AND kind IN ('fresh','bump') AND created_at>?) top WHERE top.t IS NOT NULL)`;
    const steppedArgs = [R, u.id, u.id, now - 48 * HOUR];
    const old = !!relist && now < relist.anchor_at! + gapMs;
    const [placeSql, placeArgs] = !strict ? ['?', [now]]
        // With the wallet empty a relist never rises above the listing's own place (review fix: reposts
        // must not beat 끌올).
        : relist ? [`CASE WHEN ? THEN ? WHEN ${walletNow}>=1 THEN ? ELSE MIN(COALESCE(${stepped},?),?) END`, [old ? 1 : 0, relist.anchor_at, ...walletArgs, now, ...steppedArgs, relist.anchor_at, relist.anchor_at]]
        : [`CASE WHEN ${freshCount}<? THEN ? WHEN ${walletNow}>=1 THEN ? ELSE COALESCE(${stepped},?) END`, [...freshArgs, rules.freshPerDay, now + HOUR, ...walletArgs, now, ...steppedArgs, now]];
    // A relist of a listing the manager had hidden is created hidden, with the reason kept.
    const hidden = relist?.gone_hidden ? 1 : 0, hiddenReason = hidden ? relist!.gone_reason + ' (같은 매물 다시 등록)' : '';
    // The events of this very create, read through post_events_user (user, kind, created_at): post_events
    // has no post_id index. eventArgs binds them.
    const spent = `EXISTS(SELECT 1 FROM post_events WHERE user_id=? AND kind='bump' AND created_at=? AND post_id=${newPost})`;
    const fresh = `EXISTS(SELECT 1 FROM post_events WHERE user_id=? AND kind='fresh' AND created_at=? AND post_id=${newPost})`, eventArgs = [u.id, now, ...newArgs];
    const r = await db().batch([
        // 광고 (WP53): a new post is the member's newest ad slot (featured_at), trimmed to the grade's slots below.
        db().prepare(`INSERT INTO posts(author_id,kind,title,body,price,status,category,price_mode,accepts_offers,details,images,thumb,created_at,updated_at,touched_at,bumped_at,title_key,bump_count,relist,hidden,hidden_reason,link_preview,body_style,featured_at)
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${placeSql},?,?,?,?,?,?,?,? WHERE ${guard}`)
            .bind(u.id, v.kind, v.title, v.content, v.price, 'open', v.category, v.mode, v.accepts, v.details, v.images, v.thumb, now, now, now, ...placeArgs, key,
                relist ? 1 : 0, relist ? 1 : 0, hidden, hiddenReason, v.linkPreview, v.bodyStyle, perks.adSlots ? now : null, ...strict ? [u.id, rules.openPosts, u.id, dayStart, rules.postsPerDay] : []),
        ...v.tags.map(t => db().prepare(`INSERT INTO post_seasons(post_id,tier,season) SELECT id,?,? FROM ${newPost} WHERE id IS NOT NULL`).bind(t.tier, t.season, ...newArgs)),
        ...v.wantedTags.map(t => db().prepare(`INSERT INTO post_wanted_seasons(post_id,tier,season) SELECT id,?,? FROM ${newPost} WHERE id IS NOT NULL`).bind(t.tier, t.season, ...newArgs)),
        db().prepare(`INSERT INTO post_images(post_id,upload_id) SELECT n.id,j.value FROM ${newPost} n,json_each(?) j WHERE n.id IS NOT NULL`).bind(...newArgs, v.images),
        ...strict ? [
            // A free new post: placed exactly 1 hour ahead (only a non-relist can be).
            ...relist ? [] : [db().prepare(`INSERT INTO post_events(user_id,post_id,kind,created_at) SELECT ?,n.id,'fresh',? FROM ${newPost} n WHERE n.id IS NOT NULL
                AND EXISTS(SELECT 1 FROM posts WHERE id=n.id AND bumped_at=?) AND ${freshCount}<?`).bind(u.id, now, ...newArgs, now + HOUR, ...freshArgs, rules.freshPerDay)],
            // 1 끌올 spent: the post landed at now (never for an 'old' relist, which stays at its place).
            db().prepare(`INSERT INTO post_events(user_id,post_id,kind,created_at) SELECT ?,n.id,'bump',? FROM ${newPost} n WHERE n.id IS NOT NULL AND ?=0
                AND EXISTS(SELECT 1 FROM posts WHERE id=n.id AND bumped_at=?) AND NOT ${fresh} AND ${walletNow}>=1`)
                .bind(u.id, now, ...newArgs, old ? 1 : 0, now, ...eventArgs, ...walletArgs),
            db().prepare(`UPDATE users SET bump_tokens=${WALLET_NOW}-1,
                bump_at=CASE WHEN bump_tokens+CAST((?-bump_at)/? AS INTEGER)>=? THEN ? ELSE bump_at+CAST((?-bump_at)/? AS INTEGER)*? END
                WHERE id=? AND ${spent}`).bind(M, now, R, now, R, M, now, now, R, R, u.id, ...eventArgs),
        ] : [],
        db().prepare(`INSERT INTO post_events(user_id,post_id,kind,title_key,created_at) SELECT ?,id,'post',?,? FROM ${newPost} WHERE id IS NOT NULL`).bind(u.id, key, now, ...newArgs),
        printUpsert(newPost, newArgs, u.id, print),
        // 자동 끌올 (WP52): the new post joins the list while the grade has room.
        ...newPostEnrolStatements(u, newPost, newArgs, now),
        ...sold ? [reportStatement(newPost, newArgs, u.id, sold, now, `거래완료 글 #${relist!.post_id} %`)] : [],
        ...report ? [reportStatement(newPost, newArgs, u.id, report, now)] : [],
        // The buyer named on the sale hears that the same listing is up again (WP50), when it is visible.
        ...sold ? [notifyStatement('same_listing', `SELECT ? AS user_id,? AS ref,n.id AS post_id,? AS actor_id,? AS text FROM ${newPost} n
            WHERE n.id IS NOT NULL AND EXISTS(SELECT 1 FROM posts WHERE id=n.id AND hidden=0)`, [soldTo(relist!, u.id), String(relist!.post_id), u.id, `‘${relist!.title || v.title}’ 글과 같은 매물이 다시 올라왔습니다.`, ...newArgs], now)] : [],
        ...perks.adSlots ? [adTrimStatement(u.id, perks.adSlots)] : [],
        db().prepare(`SELECT ${spent} AS bump,${fresh} AS fresh,(SELECT bumped_at FROM posts WHERE id=${newPost}) AS bumped_at,(SELECT bump_tokens FROM users WHERE id=?) AS bump_tokens,(SELECT bump_at FROM users WHERE id=?) AS bump_at`)
            .bind(...eventArgs, ...eventArgs, ...newArgs, u.id, u.id),
    ]);
    if (!r[0].meta.changes) fail(429, '잠시 후 다시 시도해 주세요.');
    const out = r[r.length - 1].results[0] as { bump: number; fresh: number; bumped_at: number; bump_tokens: number; bump_at: number };
    // placed: 'fresh' (one of today's free new posts), 'bump' (spent 1 끌올), 'old' (a relist back at its
    // place) or 'last' (wallet empty: below the latest top time). The manager and POST_LIMITS=relaxed
    // always get 'fresh', at now.
    const placed = !strict ? 'fresh' : out.bump ? 'bump' : old ? 'old' : out.fresh ? 'fresh' : 'last';
    // When this post can be bumped: its gap (from its place for a relist), and not during 새 글 우선.
    const bumpAt = Math.max((relist ? out.bumped_at : now) + gapMs, out.bumped_at);
    return json({ id: r[0].meta.last_row_id, placed, bumpedAt: out.bumped_at, bumpAt, relist: !!relist, hidden: !!hidden, ...strict ? walletJson(out, perks, now) : {} }, 201);
}

// An edit never bumps and never changes the status (a post completed meanwhile is left as it is). It
// runs the same matcher without the post itself: the same listing open → the same 409; a post under 24
// hours old edited into a listing gone within 7 days moves to that listing's place (relist=1), which
// closes the 'fresh decoy, then edit' trick.
async function editPost(u: User, existing: any, v: Valid, print: NewPrint, now: number, strict: boolean) {
    const perks = perksOf(u);
    let move: PrintRow | null = null, report: string | null = null;
    if (strict) {
        const cross = crossStatements(print, u.id, now);
        const r = await db().batch([
            db().prepare('SELECT bump_tokens,bump_at FROM users WHERE id=?').bind(u.id),
            printsStatement(u.id, v.kind, now),
            ...cross.statements,
        ]);
        const w = r[0].results[0] as { bump_tokens: number; bump_at: number };
        const { open, gone } = findMatch(print, r[1].results as PrintRow[], existing.id);
        if (open) return duplicate(v.kind, open.row, open.match, perks, walletOf(w.bump_tokens, w.bump_at, perks, now), now);
        if (gone && existing.created_at > now - DAY) move = gone.row;
        report = crossHit(print, u.id, crossResults(r, 2, cross, print));
    }
    const key = print.title_key, self = "(SELECT id FROM posts WHERE id=? AND status!='closed')";
    await db().batch([
        ...priceHistoryStatements(existing.id, v.kind, v.price, now),
        ...v.kind === 'sell' && v.price !== null ? [priceDropNotify(existing.id, existing.author_id, v.title, v.price, now)] : [],
        db().prepare(`UPDATE posts SET kind=?,title=?,title_key=?,body=?,price=?,category=?,price_mode=?,accepts_offers=?,details=?,images=?,thumb=?,link_preview=?,body_style=?,updated_at=?,touched_at=?,
            bumped_at=CASE WHEN ? THEN MIN(bumped_at,?) ELSE bumped_at END,relist=CASE WHEN ? THEN 1 ELSE relist END,bump_count=CASE WHEN ? THEN MAX(bump_count,1) ELSE bump_count END
            WHERE id=? AND status!='closed'`)
            .bind(v.kind, v.title, key, v.content, v.price, v.category, v.mode, v.accepts, v.details, v.images, v.thumb, v.linkPreview, v.bodyStyle, now, now, move ? 1 : 0, move?.anchor_at ?? 0, move ? 1 : 0, move ? 1 : 0, existing.id),
        db().prepare('DELETE FROM post_seasons WHERE post_id=?').bind(existing.id),
        ...v.tags.map(t => db().prepare('INSERT INTO post_seasons(post_id,tier,season) VALUES(?,?,?)').bind(existing.id, t.tier, t.season)),
        db().prepare('DELETE FROM post_wanted_seasons WHERE post_id=?').bind(existing.id),
        ...v.wantedTags.map(t => db().prepare('INSERT INTO post_wanted_seasons(post_id,tier,season) VALUES(?,?,?)').bind(existing.id, t.tier, t.season)),
        db().prepare('DELETE FROM post_images WHERE post_id=?').bind(existing.id),
        db().prepare('INSERT INTO post_images(post_id,upload_id) SELECT ?,value FROM json_each(?)').bind(existing.id, v.images),
        printUpsert(self, [existing.id], existing.author_id, print),
        ...report ? [reportStatement(self, [existing.id], u.id, report, now)] : [],
    ]);
    return json({ id: existing.id, ...move ? { moved: true, notice: '같은 매물이라 이전 자리로 옮겼습니다.' } : {} });
}
