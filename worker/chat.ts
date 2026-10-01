import type { User } from '../shared/market';
import { db, fail, requireUser, requireActive, json, body, limit, memberColumns, withMember, isManager, isSuspended, ApiError, MANAGER_ID, WITHDRAWN, WITHDRAWN_NAME } from './http';
import { parse, visiblePost } from './posts';

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

// The trades between the two members of a chat (WP23) with their 후기, for its '거래 후기 남기기' cards. A
// chat is the one conversation of its pair, so the trades of the pair are the ones whose card is here.
// A removed 후기 keeps only who wrote it (the card of its author then says it was removed).
function pairTradeStatements(userA: string, userB: string) {
    const pair = '(t.seller_id=? AND t.buyer_id=?) OR (t.seller_id=? AND t.buyer_id=?)', args = [userA, userB, userB, userA];
    return [
        db().prepare(`SELECT t.id,t.post_id,t.seller_id,t.buyer_id,t.created_at,t.author_id,(t.confirmed_at IS NOT NULL OR t.author_id IS NULL) AS confirmed,(t.removed_at IS NOT NULL) AS removed,p.title
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
        return {
            id: p.id, title: p.title, kind: p.kind, price: p.price, status: p.status, author_id: p.author_id,
            price_mode: p.price_mode === 'legacy' ? (p.price === null ? 'negotiate' : 'fixed') : p.price_mode,
            thumb: (parse(p.images, []) as string[])[0] ?? null,
            currentOffer: details.currentOffer ? Number(details.currentOffer) || null : null,
        };
    } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
    }
}

function partner(row: any) {
    const { deleted_at, suspended_until, ...rest } = row;
    const m: Record<string, unknown> = withMember(rest);
    delete m.grade_expires_at;
    if (deleted_at) { m.nickname = WITHDRAWN_NAME; m.deleted = true; delete m.last_seen_at; }
    // The room shows '이용 제한 회원입니다' over a partner under 이용 정지 (the end date stays private).
    else if (isSuspended(suspended_until)) m.suspended = true;
    return m;
}

export async function chatHandler(req: Request, p: string[], url: URL): Promise<Response | null> {
    const method = req.method, u = await requireUser(req);
    // Polled on every page for the header badge. It also returns the member's current
    // badges and grade so a grant shows up without reloading the page. The post card written
    // before a first message is not a message of its own, so it never counts as unread.
    // The sum of the member's side of the unread counters, read from the partial indexes that hold
    // only chats with something unread.
    if (p[1] === 'unread' && method === 'GET') {
        const r = await db().prepare('SELECT (SELECT COALESCE(SUM(a_unread),0) FROM conversations WHERE user_a=? AND a_unread>0)+(SELECT COALESCE(SUM(b_unread),0) FROM conversations WHERE user_b=? AND b_unread>0) AS n')
            .bind(u.id, u.id).first<{ n: number }>();
        return json({ unread: r?.n || 0, user: u });
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
        const r = await db().prepare(`SELECT c.id,c.updated_at,u.id AS partner_id,u.nickname,u.role,u.deleted_at,${memberColumns('u')},${preview} AS last_message,
            CASE WHEN c.user_a=? THEN c.a_unread ELSE c.b_unread END AS unread,
            (SELECT COUNT(*) FROM applications a WHERE a.conversation_id=c.id AND a.status='pending') AS pending_applications,
            lp.title AS last_post_title,json_extract(lp.images,'$[0]') AS last_post_thumb
            FROM (SELECT id FROM (SELECT id,updated_at FROM conversations WHERE user_a=? AND updated_at>? UNION ALL SELECT id,updated_at FROM conversations WHERE user_b=? AND updated_at>?) mine
                WHERE EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=mine.id)
                ${filter ? "AND EXISTS(SELECT 1 FROM applications a WHERE a.conversation_id=mine.id AND a.status='pending')" : ''} ORDER BY updated_at DESC LIMIT 100) picked
            CROSS JOIN conversations c ON c.id=picked.id
            JOIN users u ON u.id=CASE WHEN c.user_a=? THEN c.user_b ELSE c.user_a END
            LEFT JOIN posts lp ON lp.id=${aboutPost('c.id')} AND (lp.author_id=? OR ?='manager' OR (lp.hidden=0 AND (lp.kind!='proxy_offer'
                OR EXISTS(SELECT 1 FROM users au WHERE au.id=lp.author_id AND au.role='manager') OR EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=lp.author_id AND b.badge='proxy'))))
            ORDER BY c.updated_at DESC`)
            .bind(u.id, u.id, since, u.id, since, u.id, u.id, u.role).all();
        return json({ chats: r.results.map(partner), at });
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
        const other = await db().prepare(`SELECT u.id,u.nickname,u.role,u.created_at,u.deleted_at,u.last_seen_at,u.suspended_until,${memberColumns('u')} FROM users u WHERE u.id=?`).bind(partnerId).first<any>();
        return json({ chat: { id: c.id, partner: other ? partner(other) : null, blocked: await blocked(c.user_a, c.user_b), listing: await chatListing(c.id, u) } });
    }
    if (p[1] && p[2] === 'messages') {
        const c = await chatMember(p[1], u.id);
        if (method === 'GET') {
            const after = url.searchParams.has('after'), cursor = after ? (Number(url.searchParams.get('after')) || 0) : (Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER);
            // The trades of the pair (WP23) for the '거래 후기 남기기' cards are read on the first load and when the
            // room asks (?trades=1, after its member writes a 후기); a 4-second poll reads them only when it
            // brings a card or a system line (a trade confirmed), so the polls of a quiet chat skip them.
            const withTrades = (!after && !url.searchParams.has('before')) || url.searchParams.get('trades') === '1';
            const results = await db().batch([
                db().prepare('SELECT id,sender_id,body,type,reference_id,attachments,created_at,read_at FROM messages WHERE conversation_id=? AND id' + (after ? '>' : '<') + '? ORDER BY id ' + (after ? 'ASC' : 'DESC') + ' LIMIT 100').bind(p[1], cursor),
                db().prepare('SELECT MAX(id) AS last_id FROM messages WHERE conversation_id=? AND sender_id=? AND read_at IS NOT NULL').bind(p[1], u.id),
                // post_current_offer is the post's 현젯 now, so the room hides '현젯으로 표시' on the 제시 it already shows.
                db().prepare("SELECT o.*,p.title,p.kind AS post_kind,p.price AS post_price,p.author_id AS post_author_id,CAST(json_extract(p.details,'$.currentOffer') AS INTEGER) AS post_current_offer FROM offers o JOIN posts p ON p.id=o.post_id WHERE o.conversation_id=?").bind(p[1]),
                db().prepare('SELECT a.*,u.nickname FROM applications a JOIN users u ON u.id=a.user_id WHERE a.conversation_id=? ORDER BY a.created_at').bind(p[1]),
                ...withTrades ? pairTradeStatements(c.user_a, c.user_b) : [],
            ]);
            const [r, seen, offers, applications] = results;
            let tradeRows = withTrades ? results.slice(4) : null;
            if (!tradeRows && r.results.some((m: any) => m.type === 'review' || m.type === 'system')) tradeRows = await db().batch(pairTradeStatements(c.user_a, c.user_b));
            const messages = r.results.map((m: any) => ({ ...m, attachments: parse(m.attachments, []) }));
            return json({
                messages: after ? messages : messages.reverse(), offers: offers.results, applications: applications.results, ...tradeRows ? { trades: pairTrades(tradeRows[0], tradeRows[1]) } : {},
                hasMore: r.results.length === 100, readThrough: (seen.results[0] as any)?.last_id || 0, blocked: await blocked(c.user_a, c.user_b),
            });
        }
        if (method === 'POST') {
            const partnerId = c.user_a === u.id ? c.user_b : c.user_a;
            // A member under 이용 정지 writes only to the manager (to appeal).
            if (partnerId !== MANAGER_ID) requireActive(u);
            // Nobody can write to a member who left; their side of the chat stays readable.
            if ((await db().prepare('SELECT deleted_at FROM users WHERE id=?').bind(partnerId).first<{ deleted_at: number | null }>())?.deleted_at) fail(404, WITHDRAWN);
            if (await blocked(c.user_a, c.user_b)) fail(403, '차단된 회원입니다.');
            await limit('message:' + u.id, 60, 60000);
            const b = await body(req);
            const images: unknown = b.images ?? [];
            if (!Array.isArray(images) || images.length > 6 || images.some(x => typeof x !== 'string') || new Set(images).size !== images.length) fail(400, '사진은 한 번에 6장까지 보낼 수 있습니다.');
            const text = typeof b.body === 'string' ? b.body.trim() : '';
            if (text.length > 2000) fail(400, '메시지는 2000자 이내로 입력해 주세요.');
            if (!text && !images.length) fail(400, '메시지를 입력해 주세요.');
            if (images.length) {
                const r = await db().prepare('SELECT id FROM uploads WHERE owner_id=? AND id IN(SELECT value FROM json_each(?))').bind(u.id, JSON.stringify(images)).all();
                if (r.results.length !== images.length) fail(403, '본인이 올린 사진만 보낼 수 있습니다.');
            }
            // A message sent about a post (the first one after 채팅하기) is preceded by that post's card,
            // unless the chat's latest card already shows it. Asking about B and then A again gives A, B, A,
            // so the latest card is always the post being discussed.
            let post: any = null;
            if (b.postId !== undefined && b.postId !== null) {
                post = await visiblePost(b.postId, u);
                if (post.author_id !== partnerId) fail(400, '게시글 작성자를 확인해 주세요.');
            }
            const now = Date.now(), ref = post ? String(post.id) : '';
            const r = await db().batch([
                ...post ? [db().prepare("INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) SELECT ?,?,?,'listing',?,'[]',? WHERE COALESCE((SELECT reference_id FROM messages WHERE conversation_id=? AND type='listing' ORDER BY id DESC LIMIT 1),'')!=?")
                    .bind(p[1], u.id, post.title, ref, now, p[1], ref)] : [],
                ...messageStatements(p[1], u.id, text, 'text', null, images as string[], now),
            ]);
            return json({ id: r[post ? 1 : 0].meta.last_row_id }, 201);
        }
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
