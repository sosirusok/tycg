import { db, fail, requireUser, requireActive, json, body, limit, textField, memberColumns, withMember } from './http';
import { MEMBER_REPORT_REASONS, priceText, type User } from '../shared/market';
import { amount, parse, visiblePost, OFFERS_ENDED_TEXT } from './posts';
import { blocked, ensureChat, guardedMessageStatements } from './chat';

// Badge and grade columns for a listed member, without the grade's end date.
export function publicMember(row: any, prefix = '') {
    const m = withMember(row, prefix);
    delete m[prefix + 'grade_expires_at'];
    return m;
}

// Drafts, saved searches, blocks, reports, notices and price offers.
export async function communityHandler(req: Request, p: string[]): Promise<Response | null> {
    const method = req.method;
    if (p[0] === 'drafts') {
        const u = await requireUser(req), key = p[1] || 'new';
        if (!/^(new|\d+)$/.test(key)) fail(400, '임시저장 위치를 확인해 주세요.');
        if (method === 'GET') {
            const d = await db().prepare('SELECT content,updated_at FROM drafts WHERE user_id=? AND draft_key=?').bind(u.id, key).first<any>();
            return json({ draft: d ? { ...parse(d.content, {}), savedAt: d.updated_at } : null });
        }
        if (method === 'PUT') {
            const b = await body(req);
            const count = await db().prepare('SELECT COUNT(*) AS n FROM drafts WHERE user_id=?').bind(u.id).first<any>();
            if (count.n >= 100 && !await db().prepare('SELECT 1 FROM drafts WHERE user_id=? AND draft_key=?').bind(u.id, key).first()) fail(409, '임시저장은 100개까지입니다.');
            await db().prepare('INSERT INTO drafts(user_id,draft_key,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,draft_key) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at').bind(u.id, key, JSON.stringify(b), Date.now()).run();
            return json({ ok: true });
        }
        if (method === 'DELETE') {
            await db().prepare('DELETE FROM drafts WHERE user_id=? AND draft_key=?').bind(u.id, key).run();
            return json({ ok: true });
        }
    }
    if (p[0] === 'searches') {
        const u = await requireUser(req);
        if (method === 'GET') {
            const r = await db().prepare('SELECT id,name,query FROM saved_searches WHERE user_id=? ORDER BY created_at DESC').bind(u.id).all();
            return json({ searches: r.results });
        }
        if (method === 'POST') {
            const b = await body(req), name = textField(b.name, 1, 32, '검색 이름'), q = textField(b.query, 1, 12000, '검색 조건');
            const count = await db().prepare('SELECT COUNT(*) AS n FROM saved_searches WHERE user_id=?').bind(u.id).first<any>();
            if (count.n >= 20) fail(409, '검색은 최대 20개까지 저장할 수 있습니다.');
            await db().prepare('INSERT INTO saved_searches(id,user_id,name,query,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(), u.id, name, q, Date.now()).run();
            return json({ ok: true });
        }
        if (method === 'DELETE' && p[1]) {
            await db().prepare('DELETE FROM saved_searches WHERE id=? AND user_id=?').bind(p[1], u.id).run();
            return json({ ok: true });
        }
    }
    if (p[0] === 'blocks') {
        const u = await requireUser(req);
        if (method === 'GET') {
            const r = await db().prepare(`SELECT b.target_id,u.nickname,${memberColumns('u')} FROM blocks b JOIN users u ON u.id=b.target_id WHERE b.user_id=?`).bind(u.id).all();
            return json({ blocks: r.results.map(row => publicMember(row)) });
        }
        if (method === 'POST') {
            const b = await body(req);
            if (typeof b.userId !== 'string' || b.userId === u.id) fail(400, '회원을 확인해 주세요.');
            if (!await db().prepare('SELECT id FROM users WHERE id=?').bind(b.userId).first()) fail(404, '회원을 찾을 수 없습니다.');
            if (b.active) await db().prepare('INSERT OR IGNORE INTO blocks(user_id,target_id,created_at) VALUES(?,?,?)').bind(u.id, b.userId, Date.now()).run();
            else await db().prepare('DELETE FROM blocks WHERE user_id=? AND target_id=?').bind(u.id, b.userId).run();
            return json({ ok: true });
        }
    }
    if (p[0] === 'reports' && method === 'POST') {
        const u = await requireUser(req);
        await limit('report:' + u.id, 8, 3600000);
        const b = await body(req);
        if (b.postId === undefined && b.userId !== undefined) return reportMember(u, b);
        const post = await visiblePost(b.postId, u), reason = textField(b.reason, 2, 50, '신고 사유'), detail = textField(b.details, 1, 1000, '신고 설명');
        if (await db().prepare("SELECT id FROM reports WHERE post_id=? AND reporter_id=? AND status='pending'").bind(post.id, u.id).first()) fail(409, '이미 신고한 글입니다.');
        await db().prepare('INSERT INTO reports(post_id,reporter_id,reason,details,created_at) VALUES(?,?,?,?,?)').bind(post.id, u.id, reason, detail, Date.now()).run();
        return json({ ok: true });
    }
    if (p[0] === 'notices' && method === 'GET') {
        const r = await db().prepare('SELECT * FROM notices ORDER BY created_at DESC LIMIT 30').all();
        return json({ notices: r.results });
    }
    if (p[0] === 'offers') return offersHandler(req, p);
    return null;
}

// 신고 of a member from the chat header or their profile: {userId, conversationId?, reason, details}.
// A report naming a chat must come from one of its two members about the other one, so the manager
// can read that chat as the evidence. One waiting report per reporter and member.
async function reportMember(u: User, b: any) {
    if (typeof b.userId !== 'string' || b.userId === u.id) fail(400, '회원을 확인해 주세요.');
    const target = await db().prepare('SELECT id,role FROM users WHERE id=?').bind(b.userId).first<{ id: string; role: string }>();
    if (!target) fail(404, '회원을 찾을 수 없습니다.');
    if (target.role === 'manager') fail(400, '매니저는 신고할 수 없습니다.');
    if (!(MEMBER_REPORT_REASONS as readonly unknown[]).includes(b.reason)) fail(400, '신고 사유를 확인해 주세요.');
    const detail = textField(b.details, 1, 1000, '신고 설명');
    let conversationId: string | null = null;
    if (b.conversationId !== undefined && b.conversationId !== null) {
        const c = typeof b.conversationId === 'string' ? await db().prepare('SELECT user_a,user_b FROM conversations WHERE id=?').bind(b.conversationId).first<{ user_a: string; user_b: string }>() : null;
        if (!c || !((c.user_a === u.id && c.user_b === target.id) || (c.user_b === u.id && c.user_a === target.id))) fail(403, '신고할 채팅을 확인해 주세요.');
        conversationId = b.conversationId;
    }
    // The duplicate check is repeated inside the insert, so two taps at once file one report.
    const r = await db().prepare("INSERT INTO reports(post_id,target_user_id,conversation_id,reporter_id,reason,details,created_at) SELECT NULL,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM reports WHERE target_user_id=? AND reporter_id=? AND status='pending')")
        .bind(target.id, conversationId, u.id, b.reason, detail, Date.now(), target.id, u.id).run();
    if (!r.meta.changes) fail(409, '이미 신고한 회원입니다.');
    return json({ ok: true }, 201);
}

async function offersHandler(req: Request, p: string[]) {
    const method = req.method, u = await requireUser(req);
    if (method === 'GET') {
        const r = await db().prepare(`SELECT o.*,p.title,p.hidden,s.nickname AS sender_name,t.nickname AS recipient_name,${memberColumns('s', 'sender_')},${memberColumns('t', 'recipient_')} FROM offers o JOIN posts p ON p.id=o.post_id JOIN users s ON s.id=o.sender_id JOIN users t ON t.id=o.recipient_id WHERE o.sender_id=? OR o.recipient_id=? ORDER BY o.created_at DESC LIMIT 100`).bind(u.id, u.id).all();
        return json({ offers: r.results.map(row => publicMember(publicMember(row, 'sender_'), 'recipient_')) });
    }
    if (method === 'POST' && !p[1]) {
        requireActive(u);
        await limit('offer:' + u.id, 20, 600000);
        const b = await body(req), post = await visiblePost(b.postId, u);
        if (post.kind !== 'sell') fail(400, '판매 글에만 제시할 수 있습니다.');
        // Only the manager and the author can reach a hidden post; say why it takes no offers.
        if (post.hidden) fail(409, post.hidden_reason === '탈퇴' ? '탈퇴한 회원의 글입니다.' : '숨김 처리된 글입니다.');
        if (post.status !== 'open') fail(409, '제시를 받지 않는 글입니다.');
        if (!post.accepts_offers && post.price_mode !== 'offer') fail(400, '제시를 받지 않는 글입니다.');
        if (post.author_id === u.id) fail(400, '내 글에는 제시할 수 없습니다.');
        // An author under 이용 정지 cannot accept a 제시 (their posts are off every list meanwhile).
        if (await db().prepare('SELECT 1 FROM users WHERE id=? AND suspended_until>?').bind(post.author_id, Date.now()).first()) fail(409, '이용 제한 회원의 글입니다.');
        const n = amount(b.amount, false), note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : '';
        if (n === null || n < 1000) fail(400, '제시가는 1,000원 이상입니다.');
        if (await db().prepare("SELECT id FROM offers WHERE post_id=? AND sender_id=? AND status='pending'").bind(post.id, u.id).first()) fail(409, '대기 중인 제시를 먼저 취소해 주세요.');
        const chat = await ensureChat(u.id, post.author_id), id = crypto.randomUUID(), now = Date.now();
        const result = await db().batch([
            db().prepare("INSERT INTO offers(id,post_id,sender_id,recipient_id,conversation_id,amount,note,created_at,updated_at) SELECT ?,p.id,?,p.author_id,?,?,?,?,? FROM posts p WHERE p.id=? AND p.kind='sell' AND p.hidden=0 AND p.status='open' AND (p.accepts_offers=1 OR p.price_mode='offer') AND NOT EXISTS(SELECT 1 FROM blocks WHERE (user_id=? AND target_id=p.author_id) OR (target_id=? AND user_id=p.author_id)) AND NOT EXISTS(SELECT 1 FROM offers WHERE post_id=p.id AND sender_id=? AND status='pending')")
                .bind(id, u.id, chat, n, note, now, now, post.id, u.id, u.id, u.id),
            db().prepare("INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,created_at) SELECT ?,?,?,'offer',?,? WHERE EXISTS(SELECT 1 FROM offers WHERE id=?)").bind(chat, u.id, '가격 제시', id, now, id),
            db().prepare('UPDATE conversations SET updated_at=? WHERE id=?').bind(now, chat),
        ]);
        if (!result[0].meta.changes) fail(409, '이미 제시했거나 글이 바뀌었습니다.');
        return json({ id, chatId: chat }, 201);
    }
    if (method === 'PATCH' && p[1]) {
        const b = await body(req), offer = await db().prepare('SELECT * FROM offers WHERE id=? AND (sender_id=? OR recipient_id=?)').bind(p[1], u.id, u.id).first<any>();
        if (!offer) fail(404, '제시를 찾을 수 없습니다.');
        if (offer.status !== 'pending') fail(409, '이미 처리된 제시입니다.');
        const action = b.action;
        if (!['accepted', 'declined', 'withdrawn'].includes(action)) fail(400, '잘못된 요청입니다.');
        if (action === 'withdrawn' ? offer.sender_id !== u.id : offer.recipient_id !== u.id) fail(403, '권한이 없습니다.');
        // Accepting reserves the post and writes to the buyer, so a seller under 이용 정지 cannot;
        // declining and withdrawing still close a 제시.
        if (action === 'accepted') requireActive(u);
        if (action === 'accepted' && await blocked(offer.sender_id, offer.recipient_id)) fail(403, '차단된 회원의 제시는 수락할 수 없습니다.');
        const now = Date.now();
        // The decision leaves a line in the chat, written only when this request made the change
        // (the offer carries this decision's status and time), so a lost race adds nothing.
        const text = action === 'accepted' ? `제시 수락 · ${priceText(offer.amount)}. 글이 예약중으로 바뀌었습니다.`
            : action === 'declined' ? `제시 거절 · ${priceText(offer.amount)}` : `제시 취소 · ${priceText(offer.amount)}`;
        const notice = guardedMessageStatements(offer.conversation_id, u.id, text, 'system', offer.id, 'EXISTS(SELECT 1 FROM offers WHERE id=? AND status=? AND updated_at=?)', [offer.id, action, now], now);
        if (action === 'accepted') {
            const othersPending = "post_id=? AND status='pending' AND EXISTS(SELECT 1 FROM offers x WHERE x.id=? AND x.status='accepted')";
            const r = await db().batch([
                db().prepare("UPDATE offers SET status='accepted',updated_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM posts WHERE id=offers.post_id AND status='open' AND hidden=0) AND NOT EXISTS(SELECT 1 FROM offers x WHERE x.post_id=offers.post_id AND x.status='accepted')").bind(now, offer.id),
                db().prepare("UPDATE posts SET status='reserved',updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM offers WHERE id=? AND status='accepted')").bind(now, offer.post_id, offer.id),
                // The other buyers' pending offers end (마감, as on any status change); each of their chats
                // gets the 마감 line from the seller and moves up, before the UPDATE that ends the offers they select.
                db().prepare(`INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) SELECT DISTINCT conversation_id,?,?,'system',NULL,'[]',? FROM offers WHERE ${othersPending}`)
                    .bind(u.id, OFFERS_ENDED_TEXT, now, offer.post_id, offer.id),
                db().prepare(`UPDATE conversations SET updated_at=? WHERE id IN (SELECT conversation_id FROM offers WHERE ${othersPending})`).bind(now, offer.post_id, offer.id),
                db().prepare(`UPDATE offers SET status='cancelled',updated_at=? WHERE ${othersPending}`).bind(now, offer.post_id, offer.id),
                ...notice,
            ]);
            if (!r[0].meta.changes) fail(409, '다른 제시를 이미 수락했거나 글 상태가 바뀌었습니다.');
        } else {
            const r = await db().batch([
                db().prepare("UPDATE offers SET status=?,updated_at=? WHERE id=? AND status='pending'").bind(action, now, offer.id),
                ...notice,
            ]);
            if (!r[0].meta.changes) fail(409, '이미 처리된 제시입니다.');
        }
        return json({ ok: true });
    }
    fail(405, '지원하지 않는 요청입니다.');
}
