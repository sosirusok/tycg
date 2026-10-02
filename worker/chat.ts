import { fillTemplate, suspendUntilText, type User } from '../shared/market';
import { CHAT_AUTO_TEXT, MATCH_TEXT, awayWindow, managerChatOrder, perksOf } from '../shared/membership';
import {
    db, fail, requireUser, requireActive, json, body, limit, memberColumns, paidRankSql, withMember, isManager, isSuspended, ApiError, MANAGER_ID, WITHDRAWN, WITHDRAWN_NAME,
    currentUserWith, digest, random, tokenOf,
} from './http';
import { parse, postStatement, visiblePost, visibleTo } from './posts';
import { ASK_LIMIT, askCount } from './reviews';
import { assertNoBlockedLinks, blockedDomainsStatement, hasBlockedLinks, primeBlockedDomains } from './unfurl';
import { ALERTS_COUNT_SQL } from './notifications';
import { pushAfter, pushSubsStatement, type Sub } from './push';
import { localRequest } from './meter';

export async function blocked(a: string, b: string) {
    return !!await db().prepare('SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)').bind(a, b, b, a).first();
}

export async function chatMember(id: string, uid: string) {
    const c = await db().prepare('SELECT * FROM conversations WHERE id=? AND (user_a=? OR user_b=?)').bind(id, uid, uid).first<any>();
    if (!c) fail(404, '대화를 찾을 수 없습니다.');
    return c;
}

export async function ensureChat(a: string, b: string) {
    if (a === b) fail(400, '자신과는 채팅할 수 없습니다.');
    const partner = await db().prepare('SELECT deleted_at FROM users WHERE id=?').bind(b).first<{ deleted_at: number | null }>();
    if (!partner) fail(404, '회원을 찾을 수 없습니다.');
    if (partner.deleted_at) fail(404, WITHDRAWN);
    if (await blocked(a, b)) fail(403, '차단된 회원입니다.');
    const pair = [a, b].sort(), now = Date.now();
    await db().prepare('INSERT OR IGNORE INTO conversations(id,user_a,user_b,created_at,updated_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(), ...pair, now, now).run();
    return (await db().prepare('SELECT id FROM conversations WHERE user_a=? AND user_b=?').bind(...pair).first<any>()).id as string;
}

// Unread messages per side (0019_read_budget: a_unread for user_a, b_unread for user_b), recounted
// from the messages_unread index. A trigger adds one per new message whichever path inserts it; the
// recount in the same UPDATE as updated_at also heals counts the previous Worker left behind.
const recount = (side: 'a' | 'b') => `(SELECT COUNT(*) FROM messages um WHERE um.conversation_id=conversations.id AND um.sender_id!=conversations.user_${side} AND um.read_at IS NULL AND um.type!='listing')`;
export const UNREAD_RECOUNT = `a_unread=${recount('a')},b_unread=${recount('b')}`;

// Inserts a message (and its photo links) and bumps the conversation in one transaction.
export function messageStatements(conversationId: string, senderId: string, text: string, type = 'text', referenceId: string | null = null, attachments: string[] = [], at = Date.now()) {
    return [
        db().prepare('INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) VALUES(?,?,?,?,?,?,?)').bind(conversationId, senderId, text, type, referenceId, JSON.stringify(attachments), at),
        ...attachments.length ? [db().prepare('INSERT OR IGNORE INTO message_images(message_id,upload_id) SELECT (SELECT MAX(id) FROM messages WHERE conversation_id=? AND sender_id=?),value FROM json_each(?)').bind(conversationId, senderId, JSON.stringify(attachments))] : [],
        db().prepare(`UPDATE conversations SET updated_at=?,${UNREAD_RECOUNT} WHERE id=?`).bind(at, conversationId),
    ];
}

// A text-only message that is written only when `guard` (an SQL condition) holds when the batch runs.
export function guardedMessageStatements(conversationId: string, senderId: string, text: string, type: string, referenceId: string | null, guard: string, args: unknown[], at = Date.now()) {
    return [
        db().prepare(`INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) SELECT ?,?,?,?,?,'[]',? WHERE ${guard}`).bind(conversationId, senderId, text, type, referenceId, at, ...args),
        db().prepare(`UPDATE conversations SET updated_at=?,${UNREAD_RECOUNT} WHERE id=? AND ${guard}`).bind(at, conversationId, ...args),
    ];
}

// The trades between the two members of a chat (WP23, WP43) with their 후기, for its '거래 확인 요청' cards. A
// chat is the one conversation of its pair, so the trades of the pair are the ones whose card is here.
// A removed 후기 keeps only who wrote it (the card of its author then says it was removed).
function pairTradeStatements(userA: string, userB: string) {
    const pair = '(t.seller_id=? AND t.buyer_id=?) OR (t.seller_id=? AND t.buyer_id=?)', args = [userA, userB, userB, userA];
    return [
        db().prepare(`SELECT t.id,t.post_id,t.seller_id,t.buyer_id,t.created_at,t.author_id,t.price,COALESCE(NULLIF(t.kind,''),p.kind) AS kind,(t.confirmed_at IS NOT NULL OR t.author_id IS NULL) AS confirmed,(t.removed_at IS NOT NULL) AS removed,COALESCE(NULLIF(t.title,''),p.title) AS title
            FROM trades t LEFT JOIN posts p ON p.id=t.post_id WHERE ${pair}`).bind(...args),
        db().prepare(`SELECT r.id,r.trade_id,r.author_id,r.target_id,r.good,CASE WHEN r.removed_at IS NULL THEN r.tags ELSE '[]' END AS tags,CASE WHEN r.removed_at IS NULL THEN r.text ELSE '' END AS text,
            r.created_at,(r.removed_at IS NOT NULL) AS removed FROM reviews r JOIN trades t ON t.id=r.trade_id WHERE ${pair}`).bind(...args),
    ];
}
function pairTrades(trades: D1Result, reviews: D1Result) {
    return trades.results.map((t: any) => ({ ...t, reviews: reviews.results.filter((v: any) => v.trade_id === t.id).map((v: any) => ({ ...v, tags: parse(v.tags, []) })) }));
}

// Offer rows written before the 제시 wording still hold '가격 제안', so the preview names the type instead.
const preview = "(SELECT CASE WHEN m.type='offer' THEN '가격 제시' WHEN m.body='' AND m.attachments!='[]' THEN '사진' ELSE m.body END FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1)";

// Partner details in chat lists; when a 6-month grade ends stays private. A withdrawn partner is
// shown as plain 탈퇴회원 with `deleted`, so the room can close its composer.
// The post a chat is about: the one on its latest post card, or on its latest 제시 when that came later
// (a chat started with 제시하기 has no post card).
const aboutPost = (c: string) => `(SELECT CASE WHEN m.type='listing' THEN CAST(m.reference_id AS INTEGER) ELSE (SELECT o.post_id FROM offers o WHERE o.id=m.reference_id) END
    FROM messages m WHERE m.conversation_id=${c} AND m.type IN ('listing','offer') ORDER BY m.id DESC LIMIT 1)`;

// That post for the bar pinned under the room header. A post the viewer can no longer see (deleted, hidden) gives null.
async function chatListing(conversationId: string, u: User) {
    const ref = await db().prepare(`SELECT ${aboutPost('?')} AS post_id`).bind(conversationId).first<{ post_id: number | null }>();
    if (!ref?.post_id) return null;
    try {
        const p = await visiblePost(ref.post_id, u), details = parse(p.details, {} as Record<string, unknown>);
        const closedAt = p.status === 'closed' ? p.closed_at ?? p.updated_at : null;
        // canAsk: '거래 기록 요청' is still possible on this completed post (within 7 days, not hidden, under
        // the 3 asks a post has), so the room hides the button once it would only fail.
        const canAsk = closedAt !== null && closedAt > Date.now() - 7 * 86400000 && !p.hidden && await askCount(p.id) < ASK_LIMIT;
        return {
            id: p.id, title: p.title, kind: p.kind, category: p.category, price: p.price, status: p.status === 'closed' ? 'closed' : 'open', closed_at: closedAt, author_id: p.author_id, canAsk, hidden: !!p.hidden,
            price_mode: p.price_mode === 'legacy' ? (p.price === null ? 'negotiate' : 'fixed') : p.price_mode,
            thumb: (parse(p.images, []) as string[])[0] ?? null,
            currentOffer: details.currentOffer ? Number(details.currentOffer) || null : null,
        };
    } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
    }
}

// 채팅 자동화 (WP57): the partner's automatic answer to a member's message, written in the same batch.
// - 자리 비움 (엘리트 and up): one per chat per away window (reference 'away:' + the window's start).
// - 첫 문의 자동 안내 (프리미엄 and up): about one of the partner's open posts, once per post per chat, and
//   only while the partner wrote nothing in the chat for 24 hours (an away reply in this batch counts, so
//   one message gets at most one automatic answer; a system line under the partner's name, such as
//   '제시 자동 거절', does not).
// A text that links a host on the manager's blocklist is not sent (checked on save and here).
// Never in a chat with the manager or with an application, never from or to a member under 이용 정지,
// and only here (a member's own message): system lines, 제시, post cards and automatic answers never get
// one, so two members' automatic answers cannot set each other off. A block refuses the message before.
type AutoPartner = { deleted_at: number | null; role: string; suspended_until: number | null; grade: string | null; first_on: number | null; first_text: string | null;
    away_on: number | null; away_from: number | null; away_to: number | null; away_text: string | null; away_until: number | null };
const AUTO_GUARD = "NOT EXISTS(SELECT 1 FROM applications ap WHERE ap.conversation_id=?)";
// about: the chat's post when the caller already read it (null: none; undefined: read it here). extra: one
// more condition for every answer (채팅 전송, WP69: the member's message was written by this batch).
async function autoReplyStatements(req: Request, conversationId: string, sender: User, partnerId: string, other: AutoPartner, post: any, now: number,
    about?: any, extra: { sql: string; args: unknown[] } = { sql: '1', args: [] }) {
    if (isManager(sender) || other.role === 'manager' || isSuspended(other.suspended_until) || isSuspended(sender.suspended_until)) return [];
    const perks = perksOf({ role: other.role, grade: other.grade || 'normal' }), out: D1PreparedStatement[] = [];
    const away = perks.awayReply ? awayWindow(other, now) : null;
    const awayText = other.away_text || CHAT_AUTO_TEXT.awayDefault;
    if (away !== null && !await hasBlockedLinks(req, awayText)) {
        out.push(...guardedMessageStatements(conversationId, partnerId, awayText, 'auto', 'away:' + away,
            `${AUTO_GUARD} AND NOT EXISTS(SELECT 1 FROM messages am WHERE am.conversation_id=? AND am.type='auto' AND am.reference_id=?) AND ${extra.sql}`, [conversationId, conversationId, 'away:' + away, ...extra.args], now));
    }
    if (perks.firstReply && other.first_on) {
        // The post this message is about: the one it carries, else the chat's latest post card or 제시.
        about = post ?? (about === undefined ? await db().prepare(`SELECT * FROM posts WHERE id=${aboutPost('?')}`).bind(conversationId).first<any>() : about);
        if (about && about.author_id === partnerId && about.status !== 'closed' && !about.hidden) {
            const details = parse(about.details, {} as Record<string, unknown>);
            const text = fillTemplate(other.first_text || CHAT_AUTO_TEXT.firstDefault, { title: about.title, kind: about.kind, price: about.price_mode === 'offer' ? null : about.price, currentOffer: Number(details.currentOffer) || null });
            if (text && !await hasBlockedLinks(req, text)) out.push(...guardedMessageStatements(conversationId, partnerId, text, 'auto', String(about.id),
                `${AUTO_GUARD} AND NOT EXISTS(SELECT 1 FROM messages am WHERE am.conversation_id=? AND am.type='auto' AND am.reference_id=?)
                    AND NOT EXISTS(SELECT 1 FROM messages sm WHERE sm.conversation_id=? AND sm.sender_id=? AND sm.created_at>? AND sm.type!='system') AND ${extra.sql}`,
                [conversationId, conversationId, String(about.id), conversationId, partnerId, now - 86400000, ...extra.args], now));
        }
    }
    return out;
}

// The manager's list reads at most this many unread chats besides the 100 newest (WP60).
const UNREAD_FIRST = 200;

function partner(row: any) {
    const { deleted_at, suspended_until, ...rest } = row;
    const m: Record<string, unknown> = withMember(rest);
    delete m.grade_expires_at;
    // 프로필 사진 (WP59): the 64px copy inline, so the list and the room header make no image request.
    if (!m.avatar_thumb || deleted_at) delete m.avatar_thumb;
    if (deleted_at) { m.nickname = WITHDRAWN_NAME; m.deleted = true; delete m.last_seen_at; }
    // The room shows '이용 제한 회원입니다' over a partner under 이용 정지 (the end date stays private).
    else if (isSuspended(suspended_until)) m.suspended = true;
    return m;
}

// ---- 채팅 즉시 전송과 실시간 수신 (WP69) ------------------------------------------------------------------

// A room's message columns; cid only on the reader's own messages, so the room can match its 낙관적 전송.
// Bind the reader's id first.
const MESSAGE_COLUMNS = 'id,sender_id,body,type,reference_id,attachments,created_at,read_at,CASE WHEN sender_id=? THEN cid END AS cid';
// The newest of the member's own messages the other side has read: the room's '1' goes away up to it.
// Marking read goes in id order, so it is the member's newest message below their oldest unread one: a
// seek in messages_unread, then a short walk back from there (an index on the sender would also be taken
// by the unread recount, which must keep reading unread rows only). Bind: conversation, member, twice.
const readThroughSql = (conv: string, me: string) => `COALESCE((SELECT rm.id FROM messages rm WHERE rm.conversation_id=${conv} AND rm.sender_id=${me}
    AND rm.id<COALESCE((SELECT MIN(um.id) FROM messages um WHERE um.conversation_id=${conv} AND um.sender_id=${me} AND um.read_at IS NULL),9007199254740991) ORDER BY rm.id DESC LIMIT 1),0)`;
type Conv = { id: string; user_a: string; user_b: string };
const roomMessage = (m: any) => ({ ...m, attachments: parse(m.attachments, []) });

// What the room shows, in one batch: messages after or before a cursor (100), readThrough, the 제시 with
// their post, the applications, whether the pair is blocked, and the pair's trades when asked (or when the
// messages bring a card or a system line).
async function roomRead(c: Conv, me: string, o: { after?: number; before?: number; trades: boolean }) {
    const after = o.after !== undefined, cursor = after ? o.after! : o.before ?? Number.MAX_SAFE_INTEGER;
    const results = await db().batch([
        db().prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id=? AND id${after ? '>' : '<'}? ORDER BY id ${after ? 'ASC' : 'DESC'} LIMIT 100`).bind(me, c.id, cursor),
        db().prepare(`SELECT ${readThroughSql('?', '?')} AS last_id`).bind(c.id, me, c.id, me),
        // post_current_offer is the post's 현젯 now, so the room hides '현젯으로 표시' on the 제시 it already shows.
        db().prepare("SELECT o.*,p.title,p.kind AS post_kind,p.price AS post_price,p.author_id AS post_author_id,p.status AS post_status,CAST(json_extract(p.details,'$.currentOffer') AS INTEGER) AS post_current_offer FROM offers o JOIN posts p ON p.id=o.post_id WHERE o.conversation_id=?").bind(c.id),
        db().prepare('SELECT a.*,u.nickname FROM applications a JOIN users u ON u.id=a.user_id WHERE a.conversation_id=? ORDER BY a.created_at').bind(c.id),
        db().prepare('SELECT EXISTS(SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)) AS blocked').bind(c.user_a, c.user_b, c.user_b, c.user_a),
        ...o.trades ? pairTradeStatements(c.user_a, c.user_b) : [],
    ]);
    const [r, seen, offers, applications, block] = results;
    let tradeRows = o.trades ? results.slice(5) : null;
    if (!tradeRows && r.results.some((m: any) => m.type === 'review' || m.type === 'system')) tradeRows = await db().batch(pairTradeStatements(c.user_a, c.user_b));
    const messages = r.results.map(roomMessage);
    return {
        messages: after ? messages : messages.reverse(), offers: offers.results, applications: applications.results, ...tradeRows ? { trades: pairTrades(tradeRows[0], tradeRows[1]) } : {},
        hasMore: r.results.length === 100, readThrough: (seen.results[0] as any)?.last_id || 0, blocked: !!(block.results[0] as any)?.blocked,
    };
}

// Messages per member per minute, as before.
const MESSAGE_LIMIT = 60;
const CID = /^[A-Za-z0-9_-]{8,64}$/;
type RoomRow = AutoPartner & { id: string; partner_id: string; partner_row: string | null; blocked: number; sent: number; own_photos: number; last_id: number; about: string | null };

// The first call's own read, through the session row (the member's id is not known yet): the chat with the
// partner's row and 채팅 자동화 settings (WP57), the block, this minute's message count, the photos that
// are the member's own, the newest message id, and the post an automatic 첫 문의 answer would be about.
function roomStatement(token: string, now: number, chatId: string, images: string[]) {
    return db().prepare(`SELECT c.id,CASE WHEN c.user_a=s.user_id THEN c.user_b ELSE c.user_a END AS partner_id,pu.id AS partner_row,pu.deleted_at,pu.role,pu.suspended_until,
            (SELECT g.grade FROM user_grades g WHERE g.user_id=pu.id AND (g.expires_at IS NULL OR g.expires_at>?) ORDER BY g.rank DESC LIMIT 1) AS grade,
            a.first_on,a.first_text,a.away_on,a.away_from,a.away_to,a.away_text,a.away_until,
            EXISTS(SELECT 1 FROM blocks bk WHERE (bk.user_id=c.user_a AND bk.target_id=c.user_b) OR (bk.user_id=c.user_b AND bk.target_id=c.user_a)) AS blocked,
            COALESCE((SELECT rl.count FROM rate_limits rl WHERE rl.key='message:'||s.user_id AND rl.reset_at>?),0) AS sent,
            (SELECT COUNT(*) FROM uploads up WHERE up.owner_id=s.user_id AND up.id IN (SELECT value FROM json_each(?))) AS own_photos,
            (SELECT COALESCE(MAX(lm.id),0) FROM messages lm WHERE lm.conversation_id=c.id) AS last_id,
            CASE WHEN a.first_on=1 THEN (SELECT json_object('id',ap.id,'author_id',ap.author_id,'status',ap.status,'hidden',ap.hidden,'title',ap.title,'kind',ap.kind,'price',ap.price,'price_mode',ap.price_mode,'details',ap.details)
                FROM posts ap WHERE ap.id=${aboutPost('c.id')}) END AS about
        FROM sessions s JOIN conversations c ON c.id=? AND (c.user_a=s.user_id OR c.user_b=s.user_id)
        LEFT JOIN users pu ON pu.id=CASE WHEN c.user_a=s.user_id THEN c.user_b ELSE c.user_a END
        LEFT JOIN automation a ON a.user_id=pu.id
        WHERE s.token=? AND s.expires_at>?`).bind(now, now, JSON.stringify(images), chatId, token, now);
}

// POST chats/:id/messages {body, images, postId, cid, after}: two D1 calls. The first reads the session, the
// chat, the partner, the post and the link blocklist (stale cache only) together; the second is one batch
// that writes the message only while the chat, the partner, no block, no 이용 정지 and this minute's count
// still allow it (INSERT … SELECT … WHERE, so nothing slips in between), with its card, photos, counters,
// updated_at and automatic answers, and reads back the message (by cid), the messages after `after` and
// readThrough, so the room never reads again after sending. A repeated cid writes nothing and returns the
// first message (a retry or a double tap). The rules and their messages are the ones before WP69.
async function sendMessage(req: Request, chatId: string) {
    // The body goes into the first call (its photos and post); its own errors come after the access checks.
    let b: any = {}, bodyError: unknown = null;
    try { b = await body(req); } catch (e) { bodyError = e; }
    if (!b || typeof b !== 'object') b = {};
    const rawImages: unknown = b.images ?? [];
    const imagesOk = Array.isArray(rawImages) && rawImages.length <= 6 && rawImages.every(x => typeof x === 'string') && new Set(rawImages).size === rawImages.length;
    const images = imagesOk ? rawImages as string[] : [];
    const postRef: unknown = b.postId ?? undefined, postReadable = typeof postRef === 'string' || typeof postRef === 'number';
    const text = typeof b.body === 'string' ? b.body.trim() : '';
    const defer: D1PreparedStatement[] = [], links = blockedDomainsStatement();
    const { user: u, results } = await currentUserWith(req, (token, now) => [
        roomStatement(token, now, chatId, images),
        ...postReadable ? [postStatement(postRef as string | number)] : [],
        ...links ? [links] : [],
    ], defer);
    if (!u) fail(401, '로그인이 필요합니다.');
    const room = results[0].results[0] as RoomRow | undefined;
    if (!room) fail(404, '대화를 찾을 수 없습니다.');
    if (links) primeBlockedDomains((results[results.length - 1].results[0] as { value: string } | undefined)?.value ?? null);
    const me = u.id, partnerId = room.partner_id;
    // A member under 이용 정지 writes only to the manager (to appeal).
    if (partnerId !== MANAGER_ID) requireActive(u);
    // Nobody can write to a member who left; their side of the chat stays readable.
    if (room.deleted_at) fail(404, WITHDRAWN);
    if (room.blocked) fail(403, '차단된 회원입니다.');
    if (room.sent >= MESSAGE_LIMIT) fail(429, '요청이 많습니다. 잠시 후 다시 시도해 주세요.');
    if (bodyError) throw bodyError;
    if (!imagesOk) fail(400, '사진은 한 번에 6장까지 보낼 수 있습니다.');
    if (text.length > 2000) fail(400, '메시지는 2000자 이내로 입력해 주세요.');
    if (!text && !images.length) fail(400, '메시지를 입력해 주세요.');
    // A link to a host the manager blocked (WP48); the list is in the cache now.
    await assertNoBlockedLinks(req, text);
    if (images.length && room.own_photos !== images.length) fail(403, '본인이 올린 사진만 보낼 수 있습니다.');
    // A message sent about a post (the first one after 채팅하기) is preceded by that post's card,
    // unless the chat's latest card already shows it. Asking about B and then A again gives A, B, A,
    // so the latest card is always the post being discussed.
    // 자동 매칭 (WP58): '채팅 보내기' from a match (match: true) carries the sender's own open 판매 or 구매
    // post instead, for 엘리트 and up, perks.matchChats a day (that count is one more D1 call, on these
    // sends only).
    let post: any = null;
    if (postRef !== undefined) {
        if (!postReadable) fail(404, '게시글을 찾을 수 없습니다.');
        post = visibleTo(results[1].results[0], u);
        if (b.match === true) {
            const perks = perksOf(u);
            if (!perks.matchChats) fail(403, MATCH_TEXT.chatOff);
            if (post.author_id !== u.id || post.status === 'closed' || post.hidden || (post.kind !== 'sell' && post.kind !== 'buy')) fail(400, '게시글 작성자를 확인해 주세요.');
            await limit('matchchat:' + u.id, perks.matchChats, 86400000, MATCH_TEXT.chatMax(perks.matchChats));
        } else if (post.author_id !== partnerId) fail(400, '게시글 작성자를 확인해 주세요.');
    }
    const now = Date.now(), ref = post ? String(post.id) : '';
    const cid = typeof b.cid === 'string' && CID.test(b.cid) ? b.cid : 's' + random().slice(0, 30);
    const after = Number.isSafeInteger(b.after) && b.after >= 0 ? b.after as number : room.last_id;
    // Written by this batch: the member's message with this cid and this request's time.
    const written = { sql: 'EXISTS(SELECT 1 FROM messages wm WHERE wm.conversation_id=? AND wm.sender_id=? AND wm.cid=? AND wm.created_at=?)', args: [chatId, me, cid, now] };
    let about: any = null;
    try { about = room.about ? JSON.parse(room.about) : null; } catch { about = null; }
    const auto = room.partner_row ? await autoReplyStatements(req, chatId, u, partnerId, room, post, now, about, written) : [];
    const rateKey = 'message:' + me;
    const guard = ['EXISTS(SELECT 1 FROM conversations gc WHERE gc.id=? AND (gc.user_a=? OR gc.user_b=?))',
        'NOT EXISTS(SELECT 1 FROM users gp WHERE gp.id=? AND gp.deleted_at IS NOT NULL)',
        'NOT EXISTS(SELECT 1 FROM blocks gb WHERE (gb.user_id=? AND gb.target_id=?) OR (gb.user_id=? AND gb.target_id=?))',
        `COALESCE((SELECT gr.count FROM rate_limits gr WHERE gr.key=?),0)<=${MESSAGE_LIMIT}`,
        'NOT EXISTS(SELECT 1 FROM messages gm WHERE gm.conversation_id=? AND gm.sender_id=? AND gm.cid=?)',
        ...partnerId === MANAGER_ID ? [] : ['NOT EXISTS(SELECT 1 FROM users gs WHERE gs.id=? AND gs.suspended_until>?)']].join(' AND ');
    const guardArgs = [chatId, me, me, partnerId, me, partnerId, partnerId, me, rateKey, chatId, me, cid, ...partnerId === MANAGER_ID ? [] : [me, now]];
    // 웹 푸시 (WP64): the partner's devices come with this batch, so the push after the response reads nothing.
    const subs = pushSubsStatement(partnerId, written.sql, written.args);
    const r = await db().batch([
        ...defer,
        db().prepare('INSERT INTO rate_limits (key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END')
            .bind(rateKey, now + 60000, now, now),
        ...post ? [db().prepare(`INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) SELECT ?,?,?,'listing',?,'[]',? WHERE ${guard}
            AND COALESCE((SELECT reference_id FROM messages WHERE conversation_id=? AND type='listing' ORDER BY id DESC LIMIT 1),'')!=?`).bind(chatId, me, post.title, ref, now, ...guardArgs, chatId, ref)] : [],
        db().prepare(`INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at,cid) SELECT ?,?,?,'text',NULL,?,?,? WHERE ${guard}
            ON CONFLICT(conversation_id,sender_id,cid) WHERE cid IS NOT NULL DO NOTHING`).bind(chatId, me, text, JSON.stringify(images), now, cid, ...guardArgs),
        ...images.length ? [db().prepare('INSERT OR IGNORE INTO message_images(message_id,upload_id) SELECT m.id,j.value FROM messages m,json_each(?) j WHERE m.conversation_id=? AND m.sender_id=? AND m.cid=? AND m.created_at=?')
            .bind(JSON.stringify(images), chatId, me, cid, now)] : [],
        db().prepare(`UPDATE conversations SET updated_at=?,${UNREAD_RECOUNT} WHERE id=? AND ${written.sql}`).bind(now, chatId, ...written.args),
        // The author writing about their own open post keeps it in 자동 끌올 (WP52: touched_at).
        db().prepare(`UPDATE posts SET touched_at=? WHERE id=${aboutPost('?')} AND author_id=? AND status!='closed' AND ${written.sql}`).bind(now, chatId, me, ...written.args),
        ...auto,
        ...subs ? [subs] : [],
        db().prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id=? AND sender_id=? AND cid=?`).bind(me, chatId, me, cid),
        db().prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id=? AND id>? ORDER BY id LIMIT 100`).bind(me, chatId, after),
        // readThrough, and (only when there is no message) why the guard said no.
        db().prepare(`SELECT ${readThroughSql('?', '?')} AS read_through,x.sent,CASE WHEN x.sent THEN 0 ELSE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NOT NULL) END AS gone,
            CASE WHEN x.sent THEN 0 ELSE EXISTS(SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)) END AS blocked,
            CASE WHEN x.sent THEN 0 ELSE COALESCE((SELECT count FROM rate_limits WHERE key=?),0) END AS rate,
            CASE WHEN x.sent THEN NULL ELSE (SELECT suspended_until FROM users WHERE id=?) END AS suspended_until
            FROM (SELECT EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND sender_id=? AND cid=?) AS sent) x`)
            .bind(chatId, me, chatId, me, partnerId, me, partnerId, partnerId, me, rateKey, me, chatId, me, cid),
    ]);
    const [sent, fresh, state] = r.slice(-3), flags = state.results[0] as { read_through: number | null; gone: number; blocked: number; rate: number; suspended_until: number | null };
    const message = sent.results[0] as any;
    if (!message) {
        if (flags.gone) fail(404, WITHDRAWN);
        if (flags.blocked) fail(403, '차단된 회원입니다.');
        if (partnerId !== MANAGER_ID && isSuspended(flags.suspended_until)) fail(403, `이용 정지 중입니다. (${suspendUntilText(flags.suspended_until!)})`);
        if (flags.rate > MESSAGE_LIMIT) fail(429, '요청이 많습니다. 잠시 후 다시 시도해 주세요.');
        fail(409, '메시지를 보내지 못했습니다. 다시 보내 주세요.');
    }
    // 웹 푸시 (WP64): the partner's devices, after the response, for a message this request wrote.
    if (message.created_at === now) pushAfter(partnerId, subs ? r[r.length - 4].results as Sub[] : undefined);
    const messages = fresh.results.map(roomMessage);
    return json({ id: message.id, message: roomMessage(message), messages, hasMore: messages.length === 100, readThrough: flags.read_through || 0 }, 201);
}

// GET chats/:id/wait?after=<lastId>&read=<readThrough> (실시간 수신, long polling on the Free plan): answers at
// once when the room has messages after `after` or readThrough is no longer `read`, else holds the request
// and looks again every ~1.3 s (one 1-row read of the chat: updated_at moves with every message, and the
// partner's unread count drops when they read), returning the room's news (as GET messages?after, with the
// trades) as soon as either moves, or {changed: false} after 20 s. At most 16 D1 calls a request (the
// first look with the session, 14 more, the news), far under the 50 a request; nothing runs while it waits.
// The visit writes are left to the room's other requests. ?timeout=<seconds> (1-20) only on a local
// request (the tests).
const WAIT_MS = 20000, WAIT_LOOKS = 15, WAIT_STEP_MIN = 1200;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));
async function waitRoom(req: Request, chatId: string, url: URL) {
    const afterRaw = url.searchParams.get('after'), readRaw = url.searchParams.get('read');
    const after = afterRaw === null || afterRaw === '' ? NaN : Number(afterRaw), read = readRaw === null || readRaw === '' ? null : Number(readRaw);
    if (!Number.isSafeInteger(after) || after < 0 || (read !== null && (!Number.isSafeInteger(read) || read < 0))) fail(400, '메시지 번호를 확인해 주세요.');
    let hold = WAIT_MS;
    const t = url.searchParams.get('timeout');
    if (t !== null && localRequest(req)) { const n = Number(t); if (Number.isFinite(n) && n >= 1 && n <= 20) hold = n * 1000; }
    const raw = tokenOf(req);
    if (!raw) fail(401, '로그인이 필요합니다.');
    const start = Date.now(), token = await digest(raw);
    const first = await db().prepare(`SELECT s.user_id AS me,c.id,c.user_a,c.user_b,c.updated_at,CASE WHEN c.user_a=s.user_id THEN c.b_unread ELSE c.a_unread END AS partner_unread,
            (SELECT COALESCE(MAX(lm.id),0) FROM messages lm WHERE lm.conversation_id=c.id) AS last_id,${readThroughSql('c.id', 's.user_id')} AS read_through
        FROM sessions s LEFT JOIN conversations c ON c.id=? AND (c.user_a=s.user_id OR c.user_b=s.user_id) WHERE s.token=? AND s.expires_at>?`).bind(chatId, token, start).first<any>();
    if (!first) fail(401, '로그인이 필요합니다.');
    if (!first.id) fail(404, '대화를 찾을 수 없습니다.');
    const c: Conv = { id: first.id, user_a: first.user_a, user_b: first.user_b }, me = first.me as string, side = c.user_a === me ? 'b_unread' : 'a_unread';
    const news = async () => json({ ...await roomRead(c, me, { after, trades: true }), changed: true });
    if (first.last_id > after || (read !== null && (first.read_through || 0) !== read)) return news();
    const step = Math.max(WAIT_STEP_MIN, hold / WAIT_LOOKS);
    for (let k = 1; k < WAIT_LOOKS && k * step < hold; k++) {
        await sleep(start + k * step - Date.now());
        const row = await db().prepare(`SELECT updated_at,${side} AS partner_unread FROM conversations WHERE id=?`).bind(c.id).first<{ updated_at: number; partner_unread: number }>();
        if (!row || row.updated_at !== first.updated_at || row.partner_unread !== first.partner_unread) return news();
    }
    await sleep(start + hold - Date.now());
    return json({ messages: [], changed: false, readThrough: first.read_through || 0 });
}

export async function chatHandler(req: Request, p: string[], url: URL): Promise<Response | null> {
    // 채팅 전송 and 실시간 수신 (WP69) read the session inside their own D1 calls.
    if (p[1] && p[2] === 'messages' && !p[3] && req.method === 'POST') return sendMessage(req, p[1]);
    if (p[1] && p[2] === 'wait' && !p[3] && req.method === 'GET') return waitRoom(req, p[1], url);
    const method = req.method, u = await requireUser(req);
    // Polled on every page for the header badge. It also returns the member's current
    // badges and grade so a grant shows up without reloading the page. The post card written
    // before a first message is not a message of its own, so it never counts as unread.
    // The sum of the member's side of the unread counters, read from the partial indexes that hold
    // only chats with something unread.
    if (p[1] === 'unread' && method === 'GET') {
        // alerts: unread 알림 (WP50) for the header bell, in the same statement (at most 99 rows read).
        const r = await db().prepare(`SELECT (SELECT COALESCE(SUM(a_unread),0) FROM conversations WHERE user_a=? AND a_unread>0)+(SELECT COALESCE(SUM(b_unread),0) FROM conversations WHERE user_b=? AND b_unread>0) AS n,${ALERTS_COUNT_SQL} AS alerts`)
            .bind(u.id, u.id, u.id).first<{ n: number; alerts: number }>();
        return json({ unread: r?.n || 0, alerts: r?.alerts || 0, user: u });
    }
    if (!p[1] && method === 'GET') {
        // ?filter=applications (manager only): the chats with an application still waiting.
        const filter = url.searchParams.get('filter');
        if (filter && filter !== 'applications') fail(400, '채팅 목록 조건을 확인해 주세요.');
        if (filter && !isManager(u)) fail(403, '매니저만 사용할 수 있습니다.');
        // A chat with no messages yet (채팅하기 without sending) stays out of both lists until the first message.
        // The row also names the post the chat is about (title and first photo) while the viewer can see it,
        // by the same rule as visiblePost: not hidden, and a 대리(진행) post only while its author holds 대리 인증.
        // ?since=<ms> (the list's own polls) returns only the chats updated after that time, which the
        // page merges into the list it has. The 100 newest chats are picked first from the
        // (user_a|user_b, updated_at) indexes, so the details below are read for those rows only, and
        // each row's unread count is the member's side of the counters.
        const sinceRaw = url.searchParams.get('since'), since = sinceRaw === null ? 0 : Number(sinceRaw);
        if (!Number.isSafeInteger(since) || since < 0) fail(400, '채팅 목록 조건을 확인해 주세요.');
        const at = Date.now();
        // The manager's list (WP60, not the '신청 대기' view): unread chats first, by the member's paid rank
        // (priority: grants the manager made, so a 플러스 체험 counts as 일반), then the oldest unread message
        // (unread_since); read chats newest first (managerChatOrder, which the page also applies when it
        // merges a ?since= answer). Besides the 100 newest chats it reads up to UNREAD_FIRST unread ones,
        // the most pressing first, from the partial unread indexes.
        const ordered = isManager(u) && !filter;
        const unreadSince = (conv: string, sender: string) => `(SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id=${conv} AND m.sender_id=${sender} AND m.read_at IS NULL AND m.type!='listing')`;
        const waiting = ordered ? `UNION SELECT id FROM (SELECT q.id FROM (SELECT id,user_a,user_b FROM conversations WHERE user_a=? AND a_unread>0 AND updated_at>?
                UNION ALL SELECT id,user_a,user_b FROM conversations WHERE user_b=? AND b_unread>0 AND updated_at>?) q
                JOIN users o ON o.id=CASE WHEN q.user_a=? THEN q.user_b ELSE q.user_a END ORDER BY ${paidRankSql('o')} DESC,${unreadSince('q.id', 'o.id')} LIMIT ${UNREAD_FIRST})` : '';
        const r = await db().prepare(`SELECT c.id,c.updated_at,u.id AS partner_id,u.nickname,u.role,u.deleted_at,u.avatar_thumb,${memberColumns('u')},${preview} AS last_message,
            CASE WHEN c.user_a=? THEN c.a_unread ELSE c.b_unread END AS unread,
            (SELECT COUNT(*) FROM applications a WHERE a.conversation_id=c.id AND a.status='pending') AS pending_applications,
            lp.title AS last_post_title,json_extract(lp.images,'$[0]') AS last_post_thumb
            ${ordered ? `,${paidRankSql('u')} AS priority,${unreadSince('c.id', 'u.id')} AS unread_since` : ''}
            FROM (SELECT id FROM (SELECT id FROM (SELECT id,updated_at FROM conversations WHERE user_a=? AND updated_at>? UNION ALL SELECT id,updated_at FROM conversations WHERE user_b=? AND updated_at>?) mine
                WHERE EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=mine.id)
                ${filter ? "AND EXISTS(SELECT 1 FROM applications a WHERE a.conversation_id=mine.id AND a.status='pending')" : ''} ORDER BY updated_at DESC LIMIT 100) ${waiting}) picked
            CROSS JOIN conversations c ON c.id=picked.id
            JOIN users u ON u.id=CASE WHEN c.user_a=? THEN c.user_b ELSE c.user_a END
            LEFT JOIN posts lp ON lp.id=${aboutPost('c.id')} AND (lp.author_id=? OR ?='manager' OR (lp.hidden=0 AND (lp.kind!='proxy_offer'
                OR EXISTS(SELECT 1 FROM users au WHERE au.id=lp.author_id AND au.role='manager') OR EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=lp.author_id AND b.badge='proxy'))))
            ORDER BY c.updated_at DESC`)
            .bind(u.id, u.id, since, u.id, since, ...ordered ? [u.id, since, u.id, since, u.id] : [], u.id, u.id, u.role).all();
        const chats = r.results.map(partner);
        if (ordered) chats.sort((a: any, b: any) => managerChatOrder(a, b));
        return json({ chats, at });
    }
    // Opening a chat from a post only checks the post and makes sure the chat exists. The post's
    // card is written with the first message (see below), so an unused 채팅하기 notifies nobody.
    if (!p[1] && method === 'POST') {
        await limit('chat-new:' + u.id, 30, 60000);
        const b = await body(req);
        let partnerId: unknown = b.userId;
        if (b.postId !== undefined && b.postId !== null) {
            const post = await visiblePost(b.postId, u);
            partnerId ??= post.author_id;
            if (post.author_id !== partnerId) fail(400, '게시글 작성자를 확인해 주세요.');
        }
        if (typeof partnerId !== 'string') fail(400, '회원을 확인해 주세요.');
        return json({ id: await ensureChat(u.id, partnerId) });
    }
    if (p[1] && !p[2] && method === 'GET') {
        const c = await chatMember(p[1], u.id), partnerId = c.user_a === u.id ? c.user_b : c.user_a;
        // The room header also shows the partner's '최근 접속' (last_seen_at); the chat list leaves it out.
        const other = await db().prepare(`SELECT u.id,u.nickname,u.role,u.created_at,u.deleted_at,u.last_seen_at,u.suspended_until,u.avatar_thumb,${memberColumns('u')} FROM users u WHERE u.id=?`).bind(partnerId).first<any>();
        return json({ chat: { id: c.id, partner: other ? partner(other) : null, blocked: await blocked(c.user_a, c.user_b), listing: await chatListing(c.id, u) } });
    }
    if (p[1] && p[2] === 'messages' && method === 'GET') {
        const c = await chatMember(p[1], u.id);
        const after = url.searchParams.has('after'), before = url.searchParams.has('before');
        // The trades of the pair (WP23) for the '거래 후기 남기기' cards are read on the first load and when the
        // room asks (?trades=1, after its member writes a 후기); a later read takes them only when it brings a
        // card or a system line (a trade confirmed), so the reads of a quiet chat skip them.
        return json(await roomRead(c, u.id, {
            after: after ? Number(url.searchParams.get('after')) || 0 : undefined,
            before: !after && before ? Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER : undefined,
            trades: (!after && !before) || url.searchParams.get('trades') === '1',
        }));
    }
    if (p[1] && p[2] === 'read' && method === 'POST') {
        await chatMember(p[1], u.id);
        const b = await body(req);
        if (!Number.isSafeInteger(b.lastId)) fail(400, '메시지 번호를 확인해 주세요.');
        // The reader's side of the counter is recounted in the same batch (messages after lastId stay unread).
        const side = (c: 'a' | 'b') => `${c}_unread=CASE WHEN user_${c}=? THEN ${recount(c)} ELSE ${c}_unread END`;
        await db().batch([
            db().prepare('UPDATE messages SET read_at=? WHERE conversation_id=? AND sender_id!=? AND read_at IS NULL AND id<=?').bind(Date.now(), p[1], u.id, b.lastId),
            db().prepare(`UPDATE conversations SET ${side('a')},${side('b')} WHERE id=?`).bind(u.id, u.id, p[1]),
        ]);
        return json({ ok: true });
    }
    return null;
}
