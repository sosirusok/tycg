import { REVIEW_DAYS, REVIEW_CARD_TEXT, REVIEW_TAGS, REVIEW_TEXT_MAX, type User } from '../shared/market';
import { db, fail, requireUser, requireActive, json, body, limit, memberColumns, withMember, liveReview, WITHDRAWN, WITHDRAWN_NAME } from './http';
import { parse, visiblePost } from './posts';
import { blocked, guardedMessageStatements } from './chat';

// 거래 후기 (WP23). Once a post is 거래완료, its author names the member they traded with from the
// post's partners; that writes one trade (one per post) and a '거래 후기 남기기' card in their chat.
// The other member confirms the trade by leaving their 후기: only then does the trade count on both
// profiles and may the author review them, so a member who never traded cannot be named into a
// trade count or an 아쉬워요. Each side leaves one 후기 within 30 days. The manager can remove a 후기
// or a whole trade; the rows stay (removed_at), so neither can be written again.

const DAY = 86400000;
const PAGE_SIZE = 20;
// The line the other member's first 후기 leaves in the chat: the trade counts now and the author may review.
export const TRADE_CONFIRMED_TEXT = '거래가 확인되었습니다.';

type Partner = Record<string, any> & { id: string; conversation_id: string; accepted_amount: number | null };

// The members the author can name for a post: everyone whose chat with the author holds this post's
// card (a chat opened from 채팅하기), and the sender of the accepted 제시 (a chat opened from 제시하기 has
// no card), who comes first. A 제시 that was declined, withdrawn or ended does not make a partner.
// Members who left and pairs where either side blocked the other are not listed.
async function partnersOf(post: { id: number; author_id: string }): Promise<Partner[]> {
    const r = await db().prepare(`SELECT u.id,u.nickname,u.role,${memberColumns('u')},c.id AS conversation_id,
            (SELECT o.amount FROM offers o WHERE o.conversation_id=c.id AND o.post_id=? AND o.status='accepted' LIMIT 1) AS accepted_amount
        FROM conversations c JOIN users u ON u.id=CASE WHEN c.user_a=? THEN c.user_b ELSE c.user_a END
        WHERE (c.user_a=? OR c.user_b=?) AND u.deleted_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=c.user_a AND b.target_id=c.user_b) OR (b.user_id=c.user_b AND b.target_id=c.user_a))
            AND (EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.type='listing' AND m.reference_id=?)
                OR EXISTS(SELECT 1 FROM offers o WHERE o.conversation_id=c.id AND o.post_id=? AND o.status='accepted'))
        ORDER BY accepted_amount IS NULL, c.updated_at DESC LIMIT 50`)
        .bind(post.id, post.author_id, post.author_id, post.author_id, String(post.id), post.id).all<any>();
    return r.results.map(row => {
        const m = withMember(row) as Partner;
        delete m.grade_expires_at;
        return m;
    });
}

async function authorPost(id: string, u: User) {
    const post = await visiblePost(id, u);
    if (post.author_id !== u.id) fail(403, '권한이 없습니다.');
    return post;
}

// A removed trade is returned too: it still holds the post's one trade.
async function tradeOf(postId: number) {
    return db().prepare('SELECT id,post_id,seller_id,buyer_id,price,created_at,(confirmed_at IS NOT NULL) AS confirmed,(removed_at IS NOT NULL) AS removed FROM trades WHERE post_id=?').bind(postId).first<any>();
}

const blockedPair = 'NOT EXISTS(SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?))';

// POST /posts/:id/trade {partnerId}: the post must be 거래완료 and the partner one of its partners.
// The seller is the author of a 판매, 교환 or 대리(진행) post and the partner of a 구매 or 대리(구함) post.
// The price is the accepted 제시, else the post's price. The trade and the chat card are one batch;
// the card is written only when the trade was (a second trade for the post is refused by UNIQUE).
// A blocked pair cannot be named, like every other write into their chat.
async function createTrade(req: Request, u: User, postId: string) {
    requireActive(u);
    await limit('trade:' + u.id, 20, 600000);
    const post = await authorPost(postId, u), b = await body(req);
    if (post.status !== 'closed') fail(409, '거래완료 글만 거래한 회원을 정할 수 있습니다.');
    if (typeof b.partnerId !== 'string') fail(400, '거래한 회원을 확인해 주세요.');
    if (await blocked(u.id, b.partnerId)) fail(403, '차단된 회원입니다.');
    const partner = (await partnersOf(post)).find(x => x.id === b.partnerId);
    if (!partner) fail(400, '거래한 회원을 확인해 주세요.');
    const authorBuys = post.kind === 'buy' || post.kind === 'proxy_request';
    const sellerId = authorBuys ? partner.id : u.id, buyerId = authorBuys ? u.id : partner.id;
    const price: number | null = partner.accepted_amount ?? post.price ?? null;
    const id = crypto.randomUUID(), now = Date.now();
    const r = await db().batch([
        db().prepare(`INSERT OR IGNORE INTO trades(id,post_id,seller_id,buyer_id,price,created_at,author_id) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM posts WHERE id=? AND status='closed') AND ${blockedPair}`)
            .bind(id, post.id, sellerId, buyerId, price, now, u.id, post.id, u.id, partner.id, partner.id, u.id),
        ...guardedMessageStatements(partner.conversation_id, u.id, REVIEW_CARD_TEXT, 'review', id, 'EXISTS(SELECT 1 FROM trades WHERE id=?)', [id], now),
    ]);
    if (!r[0].meta.changes) {
        if (await tradeOf(post.id)) fail(409, '이미 거래한 회원을 정한 글입니다.');
        if (await blocked(u.id, partner.id)) fail(403, '차단된 회원입니다.');
        fail(409, '거래완료 글만 거래한 회원을 정할 수 있습니다.');
    }
    return json({ trade: { id, post_id: post.id, seller_id: sellerId, buyer_id: buyerId, price, created_at: now, author_id: u.id, confirmed: 0 }, chatId: partner.conversation_id }, 201);
}

// POST /trades/:id/review {good, tags, text}: once by the seller and once by the buyer, within 30 days.
// The member the author named reviews first; that 후기 confirms the trade (it then counts, the author may
// review, and their chat gets '거래가 확인되었습니다.'). A 후기 the manager removed still blocks a second one.
async function createReview(req: Request, u: User, tradeId: string) {
    requireActive(u);
    await limit('review:' + u.id, 20, 600000);
    const t = await db().prepare('SELECT id,seller_id,buyer_id,author_id,confirmed_at,created_at FROM trades WHERE id=? AND removed_at IS NULL').bind(tradeId).first<any>();
    if (!t) fail(404, '거래를 찾을 수 없습니다.');
    if (u.id !== t.seller_id && u.id !== t.buyer_id) fail(403, '거래한 회원만 후기를 남길 수 있습니다.');
    const now = Date.now();
    if (now > t.created_at + REVIEW_DAYS * DAY) fail(409, `후기는 거래 후 ${REVIEW_DAYS}일 안에 남길 수 있습니다.`);
    // Trades recorded before the confirm step have no author_id and need no confirmation.
    const confirming = !!t.author_id && u.id !== t.author_id && t.confirmed_at === null;
    if (t.author_id && u.id === t.author_id && t.confirmed_at === null) fail(409, '상대가 거래를 확인하면 후기를 남길 수 있습니다.');
    const b = await body(req);
    if (typeof b.good !== 'boolean') fail(400, '좋아요 또는 아쉬워요를 골라 주세요.');
    const allowed: readonly string[] = REVIEW_TAGS[b.good ? 'good' : 'bad'];
    const raw: unknown = b.tags ?? [];
    if (!Array.isArray(raw) || raw.some(x => !allowed.includes(x)) || new Set(raw).size !== raw.length) fail(400, '후기 항목을 확인해 주세요.');
    // Stored in the REVIEW_TAGS order, so every card and profile row lists them the same way.
    const tags = allowed.filter(x => raw.includes(x));
    if (b.text !== undefined && b.text !== null && typeof b.text !== 'string') fail(400, '후기 내용을 확인해 주세요.');
    // One line: line breaks and runs of spaces become one space.
    const text = typeof b.text === 'string' ? b.text.replace(/\s+/g, ' ').trim() : '';
    if (text.length > REVIEW_TEXT_MAX) fail(400, `후기 내용: ${REVIEW_TEXT_MAX}자 이내로 입력해 주세요.`);
    const targetId: string = u.id === t.seller_id ? t.buyer_id : t.seller_id;
    if ((await db().prepare('SELECT deleted_at FROM users WHERE id=?').bind(targetId).first<{ deleted_at: number | null }>())?.deleted_at) fail(404, WITHDRAWN);
    const statements = [db().prepare('INSERT OR IGNORE INTO reviews(trade_id,author_id,target_id,good,tags,text,created_at) VALUES(?,?,?,?,?,?,?)')
        .bind(t.id, u.id, targetId, b.good ? 1 : 0, JSON.stringify(tags), text, now)];
    if (confirming) {
        // The pair has one chat (the card's); the line is written only by the request that confirmed,
        // and not into a chat the pair has blocked since.
        const pair = [t.seller_id, t.buyer_id].sort();
        const chat = await db().prepare('SELECT id FROM conversations WHERE user_a=? AND user_b=?').bind(...pair).first<{ id: string }>();
        statements.push(db().prepare('UPDATE trades SET confirmed_at=? WHERE id=? AND confirmed_at IS NULL AND removed_at IS NULL AND EXISTS(SELECT 1 FROM reviews WHERE trade_id=? AND author_id=? AND created_at=?)')
            .bind(now, t.id, t.id, u.id, now));
        if (chat) statements.push(...guardedMessageStatements(chat.id, u.id, TRADE_CONFIRMED_TEXT, 'system', null, `EXISTS(SELECT 1 FROM trades WHERE id=? AND confirmed_at=?) AND ${blockedPair}`, [t.id, now, ...pair, pair[1], pair[0]], now));
    }
    const r = await db().batch(statements);
    if (!r[0].meta.changes) fail(409, '이미 후기를 남겼습니다.');
    return json({ review: { id: r[0].meta.last_row_id, trade_id: t.id, author_id: u.id, target_id: targetId, good: b.good ? 1 : 0, tags, text, created_at: now }, confirmed: confirming ? !!r[1].meta.changes : t.confirmed_at !== null || !t.author_id }, 201);
}

// GET /users/:id/reviews?page=N: the 후기 a member received, newest first, 20 per page. A member who
// left shows none; a 후기 whose author left is kept under 탈퇴회원 (the count and the list agree). A 후기
// the manager removed, or one of a removed trade, is left out.
async function listReviews(userId: string, url: URL) {
    const page = Math.min(Math.max(Math.trunc(Number(url.searchParams.get('page'))) || 1, 1), 500);
    const shown = `EXISTS(SELECT 1 FROM users t WHERE t.id=r.target_id AND t.deleted_at IS NULL) AND ${liveReview('r')}`;
    const [rows, count] = await db().batch([
        db().prepare(`SELECT r.id,r.trade_id,r.author_id,r.target_id,r.good,r.tags,r.text,r.created_at,a.nickname,a.role,a.deleted_at,${memberColumns('a')}
            FROM reviews r LEFT JOIN users a ON a.id=r.author_id WHERE r.target_id=? AND ${shown} ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?`).bind(userId, PAGE_SIZE, (page - 1) * PAGE_SIZE),
        db().prepare(`SELECT COUNT(*) AS n FROM reviews r WHERE r.target_id=? AND ${shown}`).bind(userId),
    ]);
    const reviews = rows.results.map((row: any) => {
        const { deleted_at, ...rest } = row;
        const m: Record<string, any> = withMember(rest);
        delete m.grade_expires_at;
        m.tags = parse(m.tags, []);
        if (deleted_at || !m.nickname) { m.nickname = WITHDRAWN_NAME; m.author_deleted = true; m.grade = 'normal'; m.badges = []; }
        return m;
    });
    return json({ reviews, total: (count.results[0] as any)?.n || 0, page });
}

// The manager's view of a member's trades (latest 20, removed ones left out), for the member panel.
export function memberTradesStatement(userId: string) {
    return db().prepare(`SELECT t.id,t.post_id,t.created_at,(t.confirmed_at IS NOT NULL OR t.author_id IS NULL) AS confirmed,p.title,o.nickname AS partner_nickname,o.deleted_at AS partner_deleted_at
        FROM trades t LEFT JOIN posts p ON p.id=t.post_id LEFT JOIN users o ON o.id=CASE WHEN t.seller_id=? THEN t.buyer_id ELSE t.seller_id END
        WHERE (t.seller_id=? OR t.buyer_id=?) AND t.removed_at IS NULL ORDER BY t.created_at DESC LIMIT 20`).bind(userId, userId, userId);
}
export function memberTrades(rows: any[]) {
    return rows.map(({ partner_deleted_at, ...t }) => ({ ...t, partner_nickname: partner_deleted_at || !t.partner_nickname ? WITHDRAWN_NAME : t.partner_nickname }));
}

// DELETE /manage/reviews/:id and /manage/trades/:id, called from manageHandler after requireManager.
// Both keep the row (removed_at), so the 후기 cannot be written again and the post cannot get another trade.
export async function deleteReview(id: string) {
    const r = await db().prepare('UPDATE reviews SET removed_at=? WHERE id=? AND removed_at IS NULL').bind(Date.now(), id).run();
    if (!r.meta.changes) fail(404, '후기를 찾을 수 없습니다.');
    return json({ ok: true });
}
export async function deleteTrade(id: string) {
    const r = await db().prepare('UPDATE trades SET removed_at=? WHERE id=? AND removed_at IS NULL').bind(Date.now(), id).run();
    if (!r.meta.changes) fail(404, '거래를 찾을 수 없습니다.');
    return json({ ok: true });
}

// posts/:id/partners, posts/:id/trade, trades/:id/review and users/:id/reviews.
export async function reviewsHandler(req: Request, p: string[], url: URL): Promise<Response | null> {
    const method = req.method;
    if (p[0] === 'users' && p[1] && p[2] === 'reviews' && !p[3] && method === 'GET') return listReviews(p[1], url);
    if (p[0] === 'posts' && p[1] && p[2] === 'partners' && !p[3] && method === 'GET') {
        const u = await requireUser(req), post = await authorPost(p[1], u);
        const [partners, trade] = await Promise.all([partnersOf(post), tradeOf(post.id)]);
        return json({ partners, trade: trade || null });
    }
    if (p[0] === 'posts' && p[1] && p[2] === 'trade' && !p[3] && method === 'POST') return createTrade(req, await requireUser(req), p[1]);
    if (p[0] === 'trades' && p[1] && p[2] === 'review' && !p[3] && method === 'POST') return createReview(req, await requireUser(req), p[1]);
    return null;
}
