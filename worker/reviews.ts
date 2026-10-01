import { REVIEW_DAYS, REVIEW_TAGS, REVIEW_TEXT_MAX, type User } from '../shared/market';
import { db, fail, requireUser, requireActive, json, body, limit, memberColumns, withMember, liveReview, isSuspended, WITHDRAWN, WITHDRAWN_NAME } from './http';
import { parse, visiblePost } from './posts';
import { blocked, guardedMessageStatements } from './chat';

// 거래 기록 and 거래 후기 (WP23, WP43). When a post is completed, its author names the member they traded
// with from the post's partners (or that member asks for the record themselves); that writes one
// pending trade (one per post, trades.author_id = the requester) and a '거래 확인 요청' card in their
// chat. The other member answers '확인' (the trade counts on both profiles) or '거래 아님' (the row is
// deleted and logged in trade_log for the manager). Their 후기 also confirms it. A pending request
// expires after 7 days at read time; a post takes at most 3 requests, within 7 days of 완료. Each
// side leaves one 후기 within 30 days. The manager can remove a 후기 or a whole trade; the rows stay
// (removed_at), so neither can be written again.

const DAY = 86400000;
const PAGE_SIZE = 20;
const ANSWER_DAYS = 7;
const ASK_LIMIT = 3;
// The lines a trade leaves in the chat of its two members.
export const TRADE_ASK_TEXT = '거래 확인 요청';
export const TRADE_CONFIRMED_TEXT = '거래 확인 완료';
export const TRADE_DENIED_TEXT = '거래 아님';

type Partner = Record<string, any> & { id: string; conversation_id: string; accepted_amount: number | null; chat_at: number };

// The members the author can name for a post: everyone whose chat with the author holds this post's
// card (a chat opened from 채팅하기) or a 제시 on it (a chat opened from 제시하기 has no card). The sender
// of the accepted 제시 comes first, then the latest chats; at most 50. Members who left and pairs where
// either side blocked the other are not listed.
async function partnersOf(post: { id: number; author_id: string }): Promise<Partner[]> {
    const r = await db().prepare(`SELECT u.id,u.nickname,u.role,${memberColumns('u')},c.id AS conversation_id,c.updated_at AS chat_at,u.suspended_until,
            (SELECT o.amount FROM offers o WHERE o.conversation_id=c.id AND o.post_id=? AND o.status='accepted' LIMIT 1) AS accepted_amount
        FROM conversations c JOIN users u ON u.id=CASE WHEN c.user_a=? THEN c.user_b ELSE c.user_a END
        WHERE (c.user_a=? OR c.user_b=?) AND u.deleted_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=c.user_a AND b.target_id=c.user_b) OR (b.user_id=c.user_b AND b.target_id=c.user_a))
            AND (EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.type='listing' AND m.reference_id=?)
                OR EXISTS(SELECT 1 FROM offers o WHERE o.conversation_id=c.id AND o.post_id=?))
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

// The post's one trade row, with its state at `now`: a removed one still holds the post's one trade;
// a pending one older than 7 days reads as expired (a new request replaces it).
async function tradeOf(postId: number, now = Date.now()) {
    const t = await db().prepare('SELECT id,post_id,seller_id,buyer_id,price,backing,kind,title,created_at,author_id,(confirmed_at IS NOT NULL OR author_id IS NULL) AS confirmed,(removed_at IS NOT NULL) AS removed FROM trades WHERE post_id=?').bind(postId).first<any>();
    if (t) t.expired = !t.confirmed && !t.removed && t.created_at < now - ANSWER_DAYS * DAY ? 1 : 0;
    return t;
}

const blockedPair = 'NOT EXISTS(SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?))';
const AMOUNT_MAX = 1000000000;
// The most an accepted 제시 can back on a post that never listed a price (decisions item 2, review fix):
// 30만원, about a typical account sale; a higher trade still counts, with 거금 capped there.
export const OFFER_BACKING_MAX = 300000;

// 거래가 (WP43): 1,000원 steps from 1,000원 to 10억; a priced 판매 caps at 즉거가 and a 구매 with a MAX at
// the MAX; 교환 stores none. Without one (an older client) it is the accepted 제시, else the post price.
function tradeAmount(post: any, raw: unknown, accepted: number | null): number | null {
    if (post.kind === 'exchange') return null;
    const cap = (post.kind === 'sell' || post.kind === 'buy') && post.price !== null ? post.price as number : null;
    if (raw === undefined || raw === null || raw === '') {
        const fallback: number | null = accepted ?? post.price ?? null;
        return fallback !== null && cap !== null ? Math.min(fallback, cap) : fallback;
    }
    if ((typeof raw !== 'number' && typeof raw !== 'string') || (typeof raw === 'string' && !/^\d+$/.test(raw.trim()))) fail(400, '거래가는 숫자로 입력해 주세요.');
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1000 || n > AMOUNT_MAX || n % 1000) fail(400, '거래가는 1,000원 단위로 1,000원부터 10억 원까지 입력해 주세요.');
    if (cap !== null && n > cap) fail(400, post.kind === 'sell' ? '거래가는 즉거가 이하로 입력해 주세요.' : '거래가는 MAX 이하로 입력해 주세요.');
    return n;
}

export type TradePlan = { id: string; statements: D1PreparedStatement[]; trade: Record<string, unknown>; chatId: string };

// Checks a trade record request and builds its statements: `u` is the requester (the post author naming
// `partnerId`, or a partner asking for themselves) and `post` the post as it will be once completed.
// The statements run only while `guard` holds (an SQL condition on the post, with `guardArgs`): the
// expired pending row goes, the trade is inserted with its snapshots and backing, and the 'ask' log
// row and the '거래 확인 요청' card follow only when the insert happened.
export async function planTrade(post: any, u: User, partnerId: unknown, rawAmount: unknown, now: number, guard: string, guardArgs: unknown[]): Promise<TradePlan> {
    const author = post.author_id === u.id;
    const partners = await partnersOf(post);
    const partner = author ? partners.find(x => x.id === partnerId) : partners.find(x => x.id === u.id);
    if (author && typeof partnerId !== 'string') fail(400, '거래한 회원을 확인해 주세요.');
    if (author && partnerId !== u.id && await blocked(u.id, partnerId as string)) fail(403, '차단된 회원입니다.');
    if (!partner) fail(author ? 400 : 403, author ? '거래한 회원을 확인해 주세요.' : '거래한 회원만 거래를 기록할 수 있습니다.');
    const otherId = author ? partner.id : post.author_id;
    if (author ? isSuspended(partner.suspended_until) : await db().prepare('SELECT 1 FROM users WHERE id=? AND suspended_until>?').bind(otherId, now).first()) fail(409, '이용 제한 회원과는 거래를 기록할 수 없습니다.');
    const existing = await tradeOf(post.id, now);
    if (existing && !existing.expired) fail(409, '이미 거래가 기록된 글입니다.');
    const asks = await db().prepare("SELECT COUNT(*) AS n FROM trade_log WHERE post_id=? AND event='ask'").bind(post.id).first<{ n: number }>();
    if ((asks?.n ?? 0) >= ASK_LIMIT) fail(429, '거래 기록 요청은 한 글에 3번까지입니다.');
    const price = tradeAmount(post, rawAmount, partner.accepted_amount);
    // The member who is not the post author: the seller of a 구매 or 대리(구함) post, else the buyer.
    const authorBuys = post.kind === 'buy' || post.kind === 'proxy_request';
    const sellerId = authorBuys ? partner.id : post.author_id, buyerId = authorBuys ? post.author_id : partner.id;
    const id = crypto.randomUUID(), cutoff = now - ANSWER_DAYS * DAY;
    // Backing: the highest price the post ever listed (the MAX of a 구매); without one, the partner's
    // 제시 that is accepted at this moment, capped at OFFER_BACKING_MAX (backing_offer=1, shown apart in
    // MemberPanel). A declined, withdrawn or released 제시 never backs anything, and an alt pair cannot
    // add more than the cap per trade through a no-price post.
    const listed = '(SELECT MAX(x) FROM (SELECT price AS x FROM posts WHERE id=? UNION ALL SELECT price FROM post_price_history WHERE post_id=?))';
    const offered = "(SELECT MIN(MAX(amount),?) FROM offers WHERE post_id=? AND sender_id=? AND status='accepted')";
    const backing = `COALESCE(${listed},${offered})`, backingOffer = `(${listed} IS NULL AND ${offered} IS NOT NULL)`;
    const backingArgs = [post.id, post.id, OFFER_BACKING_MAX, post.id, partner.id];
    const tags = '(SELECT json_group_array(json_object(\'tier\',tier,\'season\',season)) FROM post_seasons WHERE post_id=?)';
    const statements = [
        db().prepare(`DELETE FROM trades WHERE post_id=? AND confirmed_at IS NULL AND author_id IS NOT NULL AND removed_at IS NULL AND created_at<? AND ${guard}`).bind(post.id, cutoff, ...guardArgs),
        db().prepare(`INSERT OR IGNORE INTO trades(id,post_id,seller_id,buyer_id,price,created_at,author_id,kind,category,title,tags,backing,backing_offer)
            SELECT ?,?,?,?,?,?,?,?,?,?,COALESCE(${tags},'[]'),${backing},${backingOffer} WHERE ${guard} AND ${blockedPair}
                AND (SELECT COUNT(*) FROM trade_log WHERE post_id=? AND event='ask')<?`)
            .bind(id, post.id, sellerId, buyerId, price, now, u.id, post.kind, post.category, post.title, post.id, ...backingArgs, ...backingArgs, ...guardArgs, u.id, otherId, otherId, u.id, post.id, ASK_LIMIT),
        db().prepare("INSERT INTO trade_log(post_id,actor_id,target_id,event,created_at) SELECT ?,?,?,'ask',? WHERE EXISTS(SELECT 1 FROM trades WHERE id=?)").bind(post.id, u.id, otherId, now, id),
        ...guardedMessageStatements(partner.conversation_id, u.id, TRADE_ASK_TEXT, 'review', id, 'EXISTS(SELECT 1 FROM trades WHERE id=?)', [id], now),
    ];
    const trade = { id, post_id: post.id, seller_id: sellerId, buyer_id: buyerId, price, created_at: now, author_id: u.id, confirmed: 0 };
    return { id, statements, trade, chatId: partner.conversation_id };
}

// POST /posts/:id/trade {partnerId?, amount?} (거래 기록 요청): by the author naming a partner, or by a
// partner for themselves, on a completed, visible post within 7 days of 완료.
async function createTrade(req: Request, u: User, postId: string) {
    requireActive(u);
    await limit('trade:' + u.id, 20, 600000);
    const post = await visiblePost(postId, u), b = await body(req), now = Date.now();
    if (post.status !== 'closed') fail(409, '완료된 글만 거래를 기록할 수 있습니다.');
    if (post.hidden) fail(409, '숨김 처리된 글입니다.');
    if ((post.closed_at ?? post.updated_at) < now - ANSWER_DAYS * DAY) fail(409, '완료 후 7일이 지나 거래를 기록할 수 없습니다.');
    const plan = await planTrade(post, u, b.partnerId, b.amount, now, "EXISTS(SELECT 1 FROM posts WHERE id=? AND status='closed' AND hidden=0)", [post.id]);
    const r = await db().batch(plan.statements);
    if (!r[1].meta.changes) {
        if (await blocked(plan.trade.seller_id as string, plan.trade.buyer_id as string)) fail(403, '차단된 회원입니다.');
        fail(409, '이미 거래가 기록된 글입니다.');
    }
    return json({ trade: plan.trade, chatId: plan.chatId }, 201);
}

// POST /trades/:id/answer {confirm}: the member who did not ask answers within 7 days. '확인' counts the
// trade; '거래 아님' deletes the row (so the post may ask again, up to 3 times) and logs the denial.
async function answerTrade(req: Request, u: User, tradeId: string) {
    requireActive(u);
    await limit('trade:' + u.id, 20, 600000);
    const b = await body(req);
    if (typeof b.confirm !== 'boolean') fail(400, '잘못된 요청입니다.');
    const t = await db().prepare('SELECT id,post_id,seller_id,buyer_id,author_id,confirmed_at,removed_at,created_at FROM trades WHERE id=?').bind(tradeId).first<any>();
    if (!t || t.removed_at !== null) fail(404, '거래를 찾을 수 없습니다.');
    if (u.id !== t.seller_id && u.id !== t.buyer_id) fail(403, '거래 상대만 응답할 수 있습니다.');
    if (!t.author_id || t.confirmed_at !== null) fail(409, '이미 응답한 거래입니다.');
    if (u.id === t.author_id) fail(403, '거래 상대만 응답할 수 있습니다.');
    const now = Date.now();
    if (t.created_at < now - ANSWER_DAYS * DAY) fail(409, '확인 기간 7일이 지났습니다.');
    const pair = [t.seller_id, t.buyer_id].sort();
    const chat = await db().prepare('SELECT id FROM conversations WHERE user_a=? AND user_b=?').bind(...pair).first<{ id: string }>();
    const pending = 'id=? AND confirmed_at IS NULL AND removed_at IS NULL AND created_at>=?', pendingArgs = [t.id, now - ANSWER_DAYS * DAY];
    let r: D1Result[];
    if (b.confirm) {
        r = await db().batch([
            db().prepare(`UPDATE trades SET confirmed_at=? WHERE ${pending}`).bind(now, ...pendingArgs),
            ...chat ? guardedMessageStatements(chat.id, u.id, TRADE_CONFIRMED_TEXT, 'system', t.id, `EXISTS(SELECT 1 FROM trades WHERE id=? AND confirmed_at=?) AND ${blockedPair}`, [t.id, now, ...pair, pair[1], pair[0]], now) : [],
        ]);
    } else {
        // The log row and the line are written first, while the row they check still exists.
        const live = `EXISTS(SELECT 1 FROM trades WHERE ${pending})`;
        r = await db().batch([
            db().prepare(`INSERT INTO trade_log(post_id,actor_id,target_id,event,created_at) SELECT ?,?,?,'denied',? WHERE ${live}`).bind(t.post_id, u.id, t.author_id, now, ...pendingArgs),
            ...chat ? guardedMessageStatements(chat.id, u.id, TRADE_DENIED_TEXT, 'system', null, `${live} AND ${blockedPair}`, [...pendingArgs, ...pair, pair[1], pair[0]], now) : [],
            db().prepare(`DELETE FROM trades WHERE ${pending}`).bind(...pendingArgs),
        ]);
    }
    if (!r[0].meta.changes) fail(409, '이미 응답한 거래입니다.');
    return json({ ok: true, confirmed: b.confirm });
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
    // The member who did not ask may review a pending trade, which confirms it; the requester waits.
    const confirming = !!t.author_id && u.id !== t.author_id && t.confirmed_at === null;
    if (t.author_id && u.id === t.author_id && t.confirmed_at === null) fail(409, '거래 확인 후 후기를 남길 수 있습니다.');
    if (confirming && t.created_at < now - ANSWER_DAYS * DAY) fail(409, '확인 기간 7일이 지났습니다.');
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
        statements.push(db().prepare('UPDATE trades SET confirmed_at=? WHERE id=? AND confirmed_at IS NULL AND removed_at IS NULL AND created_at>=? AND EXISTS(SELECT 1 FROM reviews WHERE trade_id=? AND author_id=? AND created_at=?)')
            .bind(now, t.id, now - ANSWER_DAYS * DAY, t.id, u.id, now));
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

// The manager's view of a member's trades (latest 20, removed ones left out) with 거래가 and backing
// (backing_offer: it came from an accepted 제시),
// for the member panel; an expired pending request is left out too.
export function memberTradesStatement(userId: string, now = Date.now()) {
    return db().prepare(`SELECT t.id,t.post_id,t.created_at,t.price,t.backing,t.backing_offer,(t.confirmed_at IS NOT NULL OR t.author_id IS NULL) AS confirmed,COALESCE(NULLIF(t.title,''),p.title) AS title,o.nickname AS partner_nickname,o.deleted_at AS partner_deleted_at
        FROM trades t LEFT JOIN posts p ON p.id=t.post_id LEFT JOIN users o ON o.id=CASE WHEN t.seller_id=? THEN t.buyer_id ELSE t.seller_id END
        WHERE (t.seller_id=? OR t.buyer_id=?) AND t.removed_at IS NULL AND (t.confirmed_at IS NOT NULL OR t.author_id IS NULL OR t.created_at>=?) ORDER BY t.created_at DESC LIMIT 20`).bind(userId, userId, userId, now - ANSWER_DAYS * DAY);
}
export function memberTrades(rows: any[]) {
    return rows.map(({ partner_deleted_at, ...t }) => ({ ...t, partner_nickname: partner_deleted_at || !t.partner_nickname ? WITHDRAWN_NAME : t.partner_nickname }));
}
// '확인 거래 n · 확인 대기 n · 거래 아님 n': confirmed trades (not removed), requests still waiting, and
// the member's requests the other member answered with 거래 아님.
export function memberTradeCountsStatement(userId: string, now = Date.now()) {
    const mine = '(seller_id=? OR buyer_id=?) AND removed_at IS NULL';
    return db().prepare(`SELECT (SELECT COUNT(*) FROM trades WHERE ${mine} AND (confirmed_at IS NOT NULL OR author_id IS NULL)) AS confirmed,
        (SELECT COUNT(*) FROM trades WHERE ${mine} AND confirmed_at IS NULL AND author_id IS NOT NULL AND created_at>=?) AS pending,
        (SELECT COUNT(*) FROM trade_log WHERE target_id=? AND event='denied') AS denied`).bind(userId, userId, userId, userId, now - ANSWER_DAYS * DAY, userId);
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

// posts/:id/partners, posts/:id/trade, trades/:id/answer, trades/:id/review and users/:id/reviews.
export async function reviewsHandler(req: Request, p: string[], url: URL): Promise<Response | null> {
    const method = req.method;
    if (p[0] === 'users' && p[1] && p[2] === 'reviews' && !p[3] && method === 'GET') return listReviews(p[1], url);
    if (p[0] === 'posts' && p[1] && p[2] === 'partners' && !p[3] && method === 'GET') {
        const u = await requireUser(req), post = await authorPost(p[1], u);
        const [partners, trade] = await Promise.all([partnersOf(post), tradeOf(post.id)]);
        // Whether a partner is under 이용 정지 stays private; `restricted` only says the record cannot be asked.
        const now = Date.now();
        return json({ partners: partners.map(({ suspended_until, ...x }) => ({ ...x, ...isSuspended(suspended_until, now) ? { restricted: true } : {} })), trade: trade || null });
    }
    if (p[0] === 'posts' && p[1] && p[2] === 'trade' && !p[3] && method === 'POST') return createTrade(req, await requireUser(req), p[1]);
    if (p[0] === 'trades' && p[1] && p[2] === 'answer' && !p[3] && method === 'POST') return answerTrade(req, await requireUser(req), p[1]);
    if (p[0] === 'trades' && p[1] && p[2] === 'review' && !p[3] && method === 'POST') return createReview(req, await requireUser(req), p[1]);
    return null;
}
