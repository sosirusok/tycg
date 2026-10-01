import type { User } from '../shared/market';
import { priceText } from '../shared/market';
import { SERVICE_NAMES, gradePriority, kstMonth, nextKstMonthStart, serviceCouponsOf, type Coupons, type ServiceKind } from '../shared/membership';
import { db, fail, requireUser, requireActive, json, body, limit, memberColumns, withMember, initManager, isManager, nicknameKey, MANAGER_ID, WITHDRAWN_NAME } from './http';
import { blocked, ensureChat, guardedMessageStatements, UNREAD_RECOUNT } from './chat';
import { visiblePost } from './posts';

// 중개·가측 신청 (WP65). 중개: the manager (운영진) checks the account and the handover between two
// members; 가측: the manager appraises what an account is worth. Both are manual work the manager does
// from the manager chat, like 인증/등급 신청. The site never takes, holds or moves money.
// Free coupons per KST calendar month (serviceCouponsOf: 플러스 1, 프리미엄 5, 엘리트·관리자 무제한, 체험 0)
// are shared between the two kinds; without one a request is still taken as 유료 (the manager names the
// fee in the chat). One open request per kind per member is the fair-use guard, the same for every
// grade, plus a ceiling of 10 filed requests a day (refused attempts never count). The manager handles
// open requests by grade (gradePriority), then oldest first.

const DAY = 86400000;
const NOTE_MAX = 200;
const DAILY_MAX = 10;
export const PRICE_MIN = 1000;
export const PRICE_MAX = 100000000;
const OPEN_TEXT: Record<ServiceKind, string> = { broker: '진행 중인 중개 신청이 있습니다.', appraise: '진행 중인 가측 신청이 있습니다.' };
const DAILY_TEXT = `중개·가측 신청은 하루 ${DAILY_MAX}번까지입니다.`;
const PARTNER_OPEN_TEXT = '상대가 이미 중개를 신청했습니다.';

// Free coupons used this month: the month's coupon requests that are open or done (a cancelled one
// gives its coupon back). Bind the member's id and the month key.
const USED_SQL = "(SELECT COUNT(*) FROM service_requests WHERE user_id=? AND month=? AND coupon=1 AND status IN ('open','done'))";
export function couponsUsedStatement(userId: string, now = Date.now()) {
    return db().prepare(`SELECT ${USED_SQL} AS n`).bind(userId, kstMonth(now));
}
// The coupons object (services/me, me/usage): a grade granted mid-month gets its full monthly count at
// once, and a lower grade's limit applies to what is left (never negative).
export function couponsOf(u: User, used: number, now = Date.now()): Coupons {
    const cap = serviceCouponsOf(u);
    const finite = Number.isFinite(cap);
    return { limit: finite ? cap : null, used, left: finite ? Math.max(0, cap - used) : null, resetsAt: nextKstMonthStart(now) };
}

const noteField = (v: unknown) => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') fail(400, '메모를 확인해 주세요.');
    const note = v.trim();
    if (note.length > NOTE_MAX) fail(400, `메모: ${NOTE_MAX}자 이내로 입력해 주세요.`);
    return note;
};

// The guards a new request must pass, as SQL bound to guardArgs: no open request of the kind, fewer than
// DAILY_MAX filed in the last 24 hours, and for 중개 no open 중개 the partner filed for the same post naming
// this member (one request per trade). The insert repeats them, so a race is refused as well.
function requestGuards(userId: string, kind: ServiceKind, postId: number, partnerId: string | null, now: number) {
    const open = "EXISTS(SELECT 1 FROM service_requests WHERE user_id=? AND kind=? AND status='open')";
    const daily = '(SELECT COUNT(*) FROM service_requests WHERE user_id=? AND created_at>?)';
    const swapped = "EXISTS(SELECT 1 FROM service_requests WHERE user_id=? AND kind='broker' AND status='open' AND post_id=? AND partner_id=?)";
    return {
        open: [open, [userId, kind]] as const,
        daily: [daily, [userId, now - DAY]] as const,
        swapped: partnerId ? [swapped, [partnerId, postId, userId]] as const : null,
    };
}
// Fails with the reason a guard refuses (checked before the insert, and again when a race refused it).
async function refuseIfGuarded(g: ReturnType<typeof requestGuards>, kind: ServiceKind) {
    const r = await db().prepare(`SELECT ${g.open[0]} AS open,${g.daily[0]} AS daily${g.swapped ? `,${g.swapped[0]} AS swapped` : ''}`)
        .bind(...g.open[1], ...g.daily[1], ...g.swapped ? g.swapped[1] : []).first<{ open: number; daily: number; swapped?: number }>();
    if (r?.open) fail(409, OPEN_TEXT[kind]);
    if (r?.swapped) fail(409, PARTNER_OPEN_TEXT);
    if ((r?.daily ?? 0) >= DAILY_MAX) fail(429, DAILY_TEXT);
}

// POST /services {kind, postId, partnerId? | partnerNickname?, note?}.
async function createRequest(req: Request, u: User) {
    if (isManager(u)) fail(400, '매니저 계정은 신청할 수 없습니다.');
    requireActive(u);
    // Attempts only guard against floods; filed requests are counted by refuseIfGuarded (10 a day).
    await limit('service-try:' + u.id, 30, 600000);
    const b = await body(req);
    const kind: ServiceKind = b.kind === 'broker' || b.kind === 'appraise' ? b.kind : fail(400, '신청 종류를 확인해 주세요.');
    const note = noteField(b.note);
    const post = await visiblePost(b.postId, u);
    if (post.status === 'closed' || post.hidden) fail(409, '진행중인 글만 신청할 수 있습니다.');
    let partner: { id: string; nickname: string } | null = null;
    if (kind === 'appraise') {
        if (post.author_id !== u.id) fail(403, '가측은 내 글만 신청할 수 있습니다.');
        if (!['sell', 'exchange'].includes(post.kind) || post.category !== 'account') fail(400, '가측은 판매·교환 계정 글만 신청할 수 있습니다.');
    } else {
        // The other side of the trade: the post author's chat partner, or the author for anyone else.
        // A nickname is matched the way sign-up keeps nicknames apart (nickname_key).
        const byId = typeof b.partnerId === 'string' && b.partnerId;
        const byName = typeof b.partnerNickname === 'string' && b.partnerNickname.trim();
        if (!byId && !byName) fail(400, '거래 상대를 확인해 주세요.');
        partner = await db().prepare(`SELECT id,nickname FROM users WHERE ${byId ? 'id=?' : '(nickname_key=? OR nickname=?)'} AND deleted_at IS NULL AND role!='manager' LIMIT 1`)
            .bind(...byId ? [byId] : [nicknameKey(byName as string), byName]).first<{ id: string; nickname: string }>();
        if (!partner || partner.id === u.id) fail(404, '거래 상대를 찾을 수 없습니다.');
        if (post.author_id !== u.id && post.author_id !== partner.id) fail(400, '이 글의 작성자와의 거래만 중개를 신청할 수 있습니다.');
        const pair = [u.id, partner.id].sort();
        if (!await db().prepare('SELECT 1 FROM conversations WHERE user_a=? AND user_b=?').bind(...pair).first()) fail(409, '거래 상대와의 채팅이 없습니다.');
        if (await blocked(u.id, partner.id)) fail(409, '차단된 회원과는 중개를 신청할 수 없습니다.');
    }
    const now = Date.now(), month = kstMonth(now), cap = serviceCouponsOf(u);
    const g = requestGuards(u.id, kind, post.id, partner?.id ?? null, now);
    await refuseIfGuarded(g, kind);
    if (!await initManager()) fail(503, '매니저 계정이 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.');
    const chatId = await ensureChat(u.id, MANAGER_ID);
    // coupon=1 while one is left, decided inside the insert (Infinity: always; 0: never).
    const couponExpr = !Number.isFinite(cap) ? '1' : cap <= 0 ? '0' : `CASE WHEN ${USED_SQL}<? THEN 1 ELSE 0 END`;
    const couponArgs = !Number.isFinite(cap) || cap <= 0 ? [] : [u.id, month, cap];
    // '[가측 신청] 글 제목\n무료 쿠폰 사용 (이번 달 3/5 남음)' or '[중개 신청] 글 제목 · 상대 닉네임\n유료 (수수료는 매니저가 안내)',
    // with what is left read after the insert (left/limit, as on the sheet), plus the note on its own line.
    const head = `[${SERVICE_NAMES[kind]} 신청] ${post.title}${partner ? ` · 상대 ${partner.nickname}` : ''}\n`;
    const freeExpr = !Number.isFinite(cap) ? "'무료 쿠폰 사용 (무제한)'" : `'무료 쿠폰 사용 (이번 달 '||MAX(0,${cap}-${USED_SQL})||'/${cap} 남음)'`;
    const freeArgs = Number.isFinite(cap) ? [u.id, month] : [];
    const tail = note ? `\n메모: ${note}` : '';
    const mine = "EXISTS(SELECT 1 FROM service_requests WHERE user_id=? AND kind=? AND status='open' AND created_at=?)";
    const guard = `NOT ${g.open[0]} AND ${g.daily[0]}<${DAILY_MAX}${g.swapped ? ` AND NOT ${g.swapped[0]}` : ''}`;
    const guardArgs = [...g.open[1], ...g.daily[1], ...g.swapped ? g.swapped[1] : []];
    const r = await db().batch([
        db().prepare(`INSERT OR IGNORE INTO service_requests(user_id,kind,post_id,partner_id,month,coupon,note,created_at) SELECT ?,?,?,?,?,${couponExpr},?,?
            WHERE ${guard}`)
            .bind(u.id, kind, post.id, partner?.id ?? null, month, ...couponArgs, note, now, ...guardArgs),
        db().prepare(`INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at)
            SELECT ?,?,?||CASE WHEN r.coupon=1 THEN ${freeExpr} ELSE '유료 (수수료는 매니저가 안내)' END||?,'system',NULL,'[]',? FROM service_requests r
            WHERE r.user_id=? AND r.kind=? AND r.status='open' AND r.created_at=?`)
            .bind(chatId, u.id, head, ...freeArgs, tail, now, u.id, kind, now),
        db().prepare(`UPDATE conversations SET updated_at=?,${UNREAD_RECOUNT} WHERE id=? AND ${mine}`).bind(now, chatId, u.id, kind, now),
    ]);
    if (!r[0].meta.changes) { await refuseIfGuarded(g, kind); fail(409, OPEN_TEXT[kind]); }
    const [row, used] = await db().batch([
        db().prepare("SELECT * FROM service_requests WHERE user_id=? AND kind=? AND status='open'").bind(u.id, kind),
        couponsUsedStatement(u.id, now),
    ]);
    return json({ request: row.results[0], chatId, coupons: couponsOf(u, Number((used.results[0] as { n: number }).n) || 0, now) }, 201);
}

// The member's own requests with the post title and the partner's name.
const ownSelect = `SELECT r.id,r.kind,r.post_id,r.partner_id,r.coupon,r.status,r.price,r.note,r.created_at,r.decided_at,p.title AS post_title,
    CASE WHEN o.deleted_at IS NOT NULL THEN '${WITHDRAWN_NAME}' ELSE o.nickname END AS partner_nickname
    FROM service_requests r LEFT JOIN posts p ON p.id=r.post_id LEFT JOIN users o ON o.id=r.partner_id`;

// GET /services/me: {coupons, open, recent (the last 10)}.
async function myRequests(u: User) {
    const now = Date.now();
    const [open, recent, used] = await db().batch([
        db().prepare(`${ownSelect} WHERE r.user_id=? AND r.status='open' ORDER BY r.created_at`).bind(u.id),
        db().prepare(`${ownSelect} WHERE r.user_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 10`).bind(u.id),
        couponsUsedStatement(u.id, now),
    ]);
    return json({ coupons: couponsOf(u, Number((used.results[0] as { n: number }).n) || 0, now), open: open.results, recent: recent.results });
}

export async function servicesHandler(req: Request, p: string[]): Promise<Response | null> {
    const u = await requireUser(req);
    if (!p[1] && req.method === 'POST') return createRequest(req, u);
    if (p[1] === 'me' && !p[2] && req.method === 'GET') return myRequests(u);
    return null;
}

// GET /manage/services?status=open|all (manageHandler has called requireManager): open requests by
// grade priority (엘리트·관리자 1순위 … 일반·체험 4순위), then oldest first; 'all' is the latest 100.
export async function manageServices(url: URL) {
    const all = url.searchParams.get('status') === 'all';
    const r = await db().prepare(`SELECT r.*,CASE WHEN u.deleted_at IS NOT NULL THEN '${WITHDRAWN_NAME}' ELSE u.nickname END AS nickname,u.role,${memberColumns('u')},p.title AS post_title,p.status AS post_status,
            CASE WHEN o.deleted_at IS NOT NULL THEN '${WITHDRAWN_NAME}' ELSE o.nickname END AS partner_nickname,
            (SELECT c.id FROM conversations c WHERE c.user_a=MIN(r.user_id,'${MANAGER_ID}') AND c.user_b=MAX(r.user_id,'${MANAGER_ID}')) AS conversation_id
        FROM service_requests r JOIN users u ON u.id=r.user_id LEFT JOIN posts p ON p.id=r.post_id LEFT JOIN users o ON o.id=r.partner_id
        ${all ? '' : "WHERE r.status='open'"} ORDER BY r.created_at ${all ? 'DESC' : 'ASC'} LIMIT ${all ? 100 : 500}`).all<any>();
    const rows = r.results.map(row => {
        const m: Record<string, any> = withMember(row);
        delete m.grade_expires_at;
        m.priority = gradePriority(m.grade, m.grade_trial);
        return m;
    });
    if (!all) rows.sort((a, b) => a.priority - b.priority || a.created_at - b.created_at);
    return json({ requests: rows });
}

// PATCH /manage/services/:id {action:'done'|'cancel', price?, note?}: the manager's decision. 가측 완료
// stores the 가측가 on the post while it is open and visible (a completed post keeps the 가측가 it had); 중개 완료 marks the pair's trade record of that post (a later one is
// marked by the trades_brokered_on_insert trigger). Each decision leaves a line in the member's chat
// with the manager, unless the member blocked the manager.
export async function decideService(req: Request, u: User, id: string) {
    const b = await body(req);
    if (b.action !== 'done' && b.action !== 'cancel') fail(400, '처리 방식을 확인해 주세요.');
    const s = await db().prepare('SELECT r.*,p.title AS post_title FROM service_requests r LEFT JOIN posts p ON p.id=r.post_id WHERE r.id=?').bind(id).first<any>();
    if (!s) fail(404, '신청을 찾을 수 없습니다.');
    if (s.status !== 'open') fail(409, '이미 처리된 신청입니다.');
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '';
    let price: number | null = null;
    if (b.action === 'done' && s.kind === 'appraise') {
        const n = typeof b.price === 'number' ? b.price : typeof b.price === 'string' && /^\d+$/.test(b.price.trim()) ? Number(b.price) : NaN;
        if (!Number.isSafeInteger(n) || n < PRICE_MIN || n > PRICE_MAX) fail(400, '가측가는 1,000원~1억 원의 정수로 입력해 주세요.');
        price = n;
    }
    const now = Date.now(), status = b.action === 'done' ? 'done' : 'cancelled';
    const decided = 'EXISTS(SELECT 1 FROM service_requests WHERE id=? AND status=? AND decided_at=? AND decided_by=?)', decidedArgs = [s.id, status, now, u.id];
    // '[가측 완료] 글 제목\n12만원', '[중개 완료] 글 제목', '[가측 신청 취소] 글 제목\n무료 쿠폰을 돌려드렸습니다.'
    // (the coupon clause only when it comes back to this month's count), then the manager's note.
    const name = SERVICE_NAMES[s.kind as ServiceKind], title = s.post_title || '삭제된 글';
    const text = (b.action === 'cancel' ? `[${name} 신청 취소] ${title}${s.coupon && s.month === kstMonth(now) ? '\n무료 쿠폰을 돌려드렸습니다.' : ''}`
        : s.kind === 'appraise' ? `[가측 완료] ${title}\n${priceText(price)}` : `[중개 완료] ${title}`) + (note ? '\n' + note : '');
    let chatId: string | null = null;
    try { chatId = await ensureChat(MANAGER_ID, s.user_id); }
    catch (e) { console.warn('Service notice not sent', e instanceof Error ? e.message : 'unknown'); }
    const r = await db().batch([
        db().prepare("UPDATE service_requests SET status=?,price=?,decided_at=?,decided_by=? WHERE id=? AND status='open'").bind(status, price, now, u.id, s.id),
        ...status === 'done' && s.kind === 'appraise' && s.post_id !== null
            ? [db().prepare(`UPDATE posts SET appraised_price=?,appraised_at=? WHERE id=? AND status!='closed' AND hidden=0 AND ${decided}`).bind(price, now, s.post_id, ...decidedArgs)] : [],
        ...status === 'done' && s.kind === 'broker' && s.post_id !== null && s.partner_id
            ? [db().prepare(`UPDATE trades SET brokered=1 WHERE post_id=? AND ((seller_id=? AND buyer_id=?) OR (seller_id=? AND buyer_id=?)) AND ${decided}`)
                .bind(s.post_id, s.user_id, s.partner_id, s.partner_id, s.user_id, ...decidedArgs)] : [],
        ...chatId ? guardedMessageStatements(chatId, MANAGER_ID, text, 'system', null, decided, decidedArgs, now) : [],
    ]);
    if (!r[0].meta.changes) fail(409, '이미 처리된 신청입니다.');
    return json({ ok: true });
}
