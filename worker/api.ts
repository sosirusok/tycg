import {
    db, fail, ApiError, initManager, currentUser, requireUser, json, body, csrf, limit, storedHash, verifyPassword, random,
    digest, tokenOf, sessionCookie, memberColumns, tradeStats, liveReview, withMember, nicknameField, nicknameKey, assertNicknameFree, isLegacyHash, isSuspended, DUMMY_HASH,
    MANAGER_USERNAME, SESSION_DAYS, WITHDRAWN_NAME, trialWindow, trialOpen, grantTrial,
} from './http';
import { postsHandler } from './posts';
import { filesHandler } from './files';
import { chatHandler } from './chat';
import { communityHandler } from './community';
import { membershipHandler, trialState, trialMeHandler } from './membership';
import { kstDate, type TrialState } from '../shared/membership';
import { manageHandler } from './manage';
import { allowKvTestFailure } from './storage';
import { usageHandler } from './perks';
import { reviewsHandler } from './reviews';
import { homeHandler } from './home';
import { servicesHandler } from './services';
import { meterOn, localRequest, metered, meterHeaders } from './meter';
import { notificationsHandler } from './notifications';
import { automationHandler } from './automation';

async function discardUnreadBody(req: Request) {
    // Drain bounded rejected payloads before responding so workerd can reuse the connection.
    if (!req.body || req.bodyUsed) return;
    const reader = req.body.getReader();
    try {
        let bytes = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 6 * 1024 * 1024) { await reader.cancel(); break; }
        }
    } catch { /* A disconnected client must not replace the API response. */ }
    finally { reader.releaseLock(); }
}

const DAY = 86400000;

// An unknown id or a withdrawn member (empty stored hash) still costs one hash at the current
// iteration count, so the response time does not reveal which ids exist. An empty stored hash
// must not reach verifyPassword: it would take the 100,000-iteration legacy path.
async function passwordMatches(password: unknown, row: { salt: string; password_hash: string } | null | undefined) {
    const stored = row?.password_hash || '';
    const ok = await verifyPassword(typeof password === 'string' ? password : '', stored ? row!.salt : 'invalid-user-constant-salt', stored || DUMMY_HASH);
    return !!stored && ok;
}

const passwordRow = (id: string) => db().prepare('SELECT salt,password_hash FROM users WHERE id=?').bind(id).first<{ salt: string; password_hash: string }>();

// Wrong passwords answer 400, not 401: the app treats every 401 as an ended session.
async function changePassword(req: Request) {
    const u = await requireUser(req);
    await limit('pw:' + u.id, 10, 600000);
    const b = await body(req);
    if (!await passwordMatches(b.current, await passwordRow(u.id))) fail(400, '현재 비밀번호가 맞지 않습니다.');
    if (typeof b.next !== 'string' || b.next.length < 8 || b.next.length > 128 || b.next === b.current) fail(400, '새 비밀번호는 8~128자, 현재와 다르게 입력해 주세요.');
    const salt = random();
    // Every other device is signed out; this one keeps its session.
    await db().batch([
        db().prepare('UPDATE users SET password_hash=?,salt=? WHERE id=?').bind(await storedHash(b.next, salt), salt, u.id),
        db().prepare('DELETE FROM sessions WHERE user_id=? AND token!=?').bind(u.id, await digest(tokenOf(req))),
    ]);
    return json({ ok: true });
}

// Offers 회원 탈퇴 ends: the member's pending offers and the ones on their posts, plus accepted ones
// whose post is not 거래완료 yet (a finished deal keeps its accepted offer). Bind the member's id twice.
const WITHDRAW_ENDS_OFFERS = "(sender_id=? OR post_id IN (SELECT id FROM posts WHERE author_id=?)) AND (status='pending' OR (status='accepted' AND EXISTS(SELECT 1 FROM posts p WHERE p.id=offers.post_id AND p.status!='closed')))";
// 회원 탈퇴 keeps the row, so chats, offers and reports keep their links, but frees the id and
// nickname, removes the password, bio and saved data, hides every post and ends open offers and
// applications. Grade and badge rows stay as the manager's record of each grant; memberColumns
// shows none of them for a withdrawn member, and only the manager ever writes them.
// Each chat with an ended offer gets one line from the post author, as endOffersStatements does;
// the lines and the post change come before the UPDATE that cancels the offers they select.
async function withdraw(req: Request) {
    const u = await requireUser(req);
    if (u.role === 'manager') fail(403, '매니저 계정은 탈퇴할 수 없습니다.');
    await limit('pw:' + u.id, 10, 600000);
    const b = await body(req);
    if (!await passwordMatches(b.password, await passwordRow(u.id))) fail(400, '비밀번호가 맞지 않습니다.');
    const now = Date.now();
    const line = (text: string, where: string, args: unknown[]) => db().prepare(`INSERT INTO messages(conversation_id,sender_id,body,type,reference_id,attachments,created_at) SELECT conversation_id,MIN(recipient_id),?,'system',NULL,'[]',? FROM offers WHERE ${where} GROUP BY conversation_id`).bind(text, now, ...args);
    await db().batch([
        // The key is never NULL, so ensureNicknameKeys does not walk withdrawn members; real keys have no '#'.
        db().prepare(`UPDATE users SET username='deleted_'||lower(hex(randomblob(6))),nickname='${WITHDRAWN_NAME}'||lower(hex(randomblob(4))),nickname_key='#deleted:'||id,prev_nickname='',nickname_changed_at=NULL,password_hash='',salt='',bio='',deleted_at=? WHERE id=?`).bind(now, u.id),
        ...['sessions', 'favorites', 'history', 'saved_searches', 'drafts'].map(table => db().prepare(`DELETE FROM ${table} WHERE user_id=?`).bind(u.id)),
        line('회원 탈퇴로 제시가 마감되었습니다.', WITHDRAW_ENDS_OFFERS, [u.id, u.id]),
        db().prepare(`UPDATE conversations SET updated_at=? WHERE id IN (SELECT conversation_id FROM offers WHERE ${WITHDRAW_ENDS_OFFERS})`).bind(now, u.id, u.id),
        db().prepare("UPDATE posts SET hidden=1,hidden_reason='탈퇴' WHERE author_id=?").bind(u.id),
        db().prepare(`UPDATE offers SET status='cancelled',updated_at=? WHERE ${WITHDRAW_ENDS_OFFERS}`).bind(now, u.id, u.id),
        db().prepare("UPDATE applications SET status='cancelled',updated_at=? WHERE user_id=? AND status='pending'").bind(now, u.id),
        // Open 중개·가측 신청 end too (WP65), so the manager's list keeps no request of a member who left.
        db().prepare("UPDATE service_requests SET status='cancelled',decided_at=? WHERE user_id=? AND status='open'").bind(now, u.id),
        // Trade records still waiting for an answer that involve the member end (WP43).
        db().prepare('DELETE FROM trades WHERE (seller_id=? OR buyer_id=?) AND confirmed_at IS NULL AND author_id IS NOT NULL AND removed_at IS NULL').bind(u.id, u.id),
    ]);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, '', 0) });
}

// 플러스 무료 체험 at sign-up, while the window is open. At most 5 trials per hashed address per KST
// day (the counter is only read here, so a 6th sign-up is never refused); a capped account is marked
// trial_at=-1 so the catch-up in currentUser never grants it later. A sign-up while the window is
// closed is marked -2 (a separate marker, so it never reads as capped), so moving the end date later (종료일 변경 after 지금 마감) never hands
// trials to those accounts through the catch-up, which has no per-address cap. The catch-up is only
// for sign-ups the previous Worker served (trial_at stays NULL there). Sign-up never fails because of
// the trial. Returns whether the cap applied.
async function signUpTrial(id: string, ip: string, createdAt: number) {
    try {
        if (!trialOpen(await trialWindow(true), createdAt)) {
            await db().prepare('UPDATE users SET trial_at=-2 WHERE id=? AND trial_at IS NULL').bind(id).run();
            return false;
        }
        try { await limit('trial-ip:' + ip + ':' + kstDate(createdAt), 5, DAY); }
        catch (e) {
            if (!(e instanceof ApiError && e.status === 429)) throw e;
            await db().prepare('UPDATE users SET trial_at=-1 WHERE id=? AND trial_at IS NULL').bind(id).run();
            return true;
        }
        await grantTrial(id, Date.now());
    } catch (e) { console.warn('Trial not granted', e instanceof Error ? e.message : 'unknown'); }
    return false;
}

async function authHandler(req: Request, p: string[]) {
    const method = req.method;
    if (p[1] === 'me' && method === 'GET') {
        const user = await currentUser(req);
        return json({ user, trial: user ? await trialState(user) : null });
    }
    if (method !== 'POST') fail(405, '지원하지 않는 요청입니다.');
    if (p[1] === 'logout') {
        await db().prepare('DELETE FROM sessions WHERE token=?').bind(await digest(tokenOf(req))).run();
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }
    if (p[1] === 'password') return changePassword(req);
    if (p[1] === 'withdraw') return withdraw(req);
    const b = await body(req), username = typeof b.username === 'string' ? b.username.toLowerCase().trim() : '';
    if (!/^[a-z0-9_]{4,24}$/.test(username)) fail(400, '아이디는 영문 소문자, 숫자, _ 4~24자로 입력해 주세요.');
    if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 128) fail(400, '비밀번호는 8~128자로 입력해 주세요.');
    // Limits are per address, and per id from each address, so nobody can lock
    // another member (such as the manager) out by failing logins on purpose.
    const ip = await digest(req.headers.get('cf-connecting-ip') || 'local');
    await limit('auth-ip:' + ip, 40, 600000);
    await limit('auth-user:' + username + ':' + ip, 15, 600000);
    await initManager();
    let id: string, capped = false;
    if (p[1] === 'register') {
        // 'deleted_' ids are what 회원 탈퇴 leaves behind.
        if (username === MANAGER_USERNAME || username.startsWith('deleted_')) fail(409, '이미 사용 중인 아이디입니다.');
        const nickname = nicknameField(b.nickname), key = nicknameKey(nickname);
        await assertNicknameFree(nickname, '');
        const salt = random(), hash = await storedHash(b.password, salt);
        id = crypto.randomUUID();
        const createdAt = Date.now();
        try {
            // The key is checked again inside the insert, so two look-alike sign-ups at once cannot both pass.
            const r = await db().prepare('INSERT INTO users (id,username,nickname,nickname_key,password_hash,salt,role,bio,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM users WHERE nickname_key=?)')
                .bind(id, username, nickname, key, hash, salt, 'member', '', createdAt, key).run();
            if (!r.meta.changes) fail(409, '비슷한 닉네임이 이미 있습니다.');
        } catch (e) {
            if (String(e).includes('UNIQUE')) fail(409, String(e).includes('users.nickname') ? '이미 사용 중인 닉네임입니다.' : '이미 사용 중인 아이디입니다.');
            throw e;
        }
        capped = await signUpTrial(id, ip, createdAt);
    } else if (p[1] === 'login') {
        const found = await db().prepare('SELECT id,salt,password_hash FROM users WHERE username=?').bind(username).first<any>();
        if (!await passwordMatches(b.password, found)) fail(401, '아이디 또는 비밀번호가 맞지 않습니다.');
        id = found.id;
        // Older 100,000-iteration hashes are replaced once the password is known.
        if (isLegacyHash(found.password_hash)) await db().prepare('UPDATE users SET password_hash=? WHERE id=?').bind(await storedHash(b.password, found.salt), id).run();
    } else fail(404, '페이지를 찾을 수 없습니다.');
    const token = random();
    await db().batch([
        db().prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()),
        db().prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').bind(await digest(token), id, Date.now() + SESSION_DAYS * 86400000),
    ]);
    const user = withMember(await db().prepare(`SELECT u.id,u.username,u.nickname,u.role,u.bio,u.created_at,${memberColumns('u')} FROM users u WHERE u.id=?`).bind(id).first<any>());
    // The session already exists: a failed trial read must not turn the sign-in into an error.
    let trial: TrialState;
    try { trial = await trialState(user, capped); }
    catch (e) {
        console.warn('Trial state not read', e instanceof Error ? e.message : 'unknown');
        trial = { endsAt: user.grade_trial ? user.grade_expires_at ?? null : null, popup: !!user.grade_trial, ended: false, capped };
    }
    return json({ user, trial }, 200, { 'Set-Cookie': sessionCookie(req, token) });
}

async function usersHandler(req: Request, p: string[]) {
    const method = req.method;
    if (method === 'GET') {
        const viewer = await currentUser(req);
        // Counts skip 대리(진행) posts whose author lost 대리 인증, and every post of a member under 이용 정지,
        // as the board list does (the author still counts them).
        const listed = "p.author_id=u.id AND p.hidden=0 AND (p.kind!='proxy_offer' OR u.role='manager' OR p.author_id=? OR EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=p.author_id AND b.badge='proxy'))"
            + ' AND (p.author_id=? OR u.suspended_until IS NULL OR u.suspended_until<=?)';
        const listedArgs = [viewer?.id || '', viewer?.id || '', Date.now()];
        // How many 후기 the 후기 tab holds; the trade counts come from tradeStats.
        const row = await db().prepare(`SELECT u.id,u.nickname,u.prev_nickname,u.nickname_changed_at,u.deleted_at,u.suspended_until,u.role,u.bio,u.created_at,u.last_seen_at,${memberColumns('u')},(SELECT COUNT(*) FROM posts p WHERE ${listed}) AS postCount,(SELECT COUNT(*) FROM posts p WHERE ${listed} AND p.status='closed') AS closedCount,
            (SELECT COUNT(*) FROM reviews rv WHERE rv.target_id=u.id AND ${liveReview('rv')}) AS review_count FROM users u WHERE u.id=?`)
            .bind(...listedArgs, ...listedArgs, p[1]).first<any>();
        if (!row) fail(404, '회원을 찾을 수 없습니다.');
        const { prev_nickname, nickname_changed_at, deleted_at, suspended_until, review_count, ...rest } = row;
        // A withdrawn member is only a name: no bio, grade, badges, counts or chat.
        if (deleted_at) return json({ user: { id: row.id, nickname: WITHDRAWN_NAME, role: row.role, bio: '', created_at: row.created_at, grade: 'normal', grade_expires_at: null, badges: [], postCount: 0, closedCount: 0, tradeCount: 0, dealSum: 0, goodCount: 0, reviewCount: 0, last_seen_at: null, deleted: true } });
        // '거래 12회 · 거금 340만원 · 후기 좋아요 9' (WP43): confirmed trades, deduped per counterpart and 30 days.
        const stats = await tradeStats(row.id);
        const user: Record<string, unknown> = { ...withMember(rest), tradeCount: stats.trade_count, dealSum: stats.deal_sum, goodCount: stats.good_count, reviewCount: review_count };
        // The nickname before the latest change stays on the profile for 90 days.
        if (prev_nickname && nickname_changed_at > Date.now() - 90 * DAY) user.prev_nickname = prev_nickname;
        // The member sees when their nickname can change again (30 days after the last change).
        if (viewer?.id === user.id && nickname_changed_at && nickname_changed_at + 30 * DAY > Date.now()) user.nickname_next_at = nickname_changed_at + 30 * DAY;
        if (viewer?.id !== user.id && viewer?.role !== 'manager') user.grade_expires_at = null;
        // 이용 정지: others see only that the member is restricted; the member and the manager see until when.
        if (isSuspended(suspended_until)) {
            user.suspended = true;
            if (viewer?.id === user.id || viewer?.role === 'manager') user.suspended_until = suspended_until;
        }
        // Whether the viewer blocked this member, for the profile's block button.
        if (viewer) user.blocked = !!await db().prepare('SELECT 1 FROM blocks WHERE user_id=? AND target_id=?').bind(viewer.id, user.id).first();
        return json({ user });
    }
    const u = await requireUser(req);
    if (u.id !== p[1]) fail(403, '본인 프로필만 수정할 수 있습니다.');
    if (method !== 'PUT') fail(405, '지원하지 않는 요청입니다.');
    const b = await body(req);
    // An unchanged nickname is kept even if it predates the current nickname rules.
    const nickname = b.nickname === u.nickname ? u.nickname : nicknameField(b.nickname, u.role === 'manager');
    const bio = typeof b.bio === 'string' ? b.bio.trim().slice(0, 300) : '';
    if (nickname === u.nickname) {
        await db().prepare('UPDATE users SET bio=? WHERE id=?').bind(bio, u.id).run();
        return json({ ok: true });
    }
    // A member may change their nickname once every 30 days; the first change after sign-up is always allowed.
    // (The manager's nickname is fixed, so nicknameField never lets the manager reach this point.)
    const now = Date.now(), key = nicknameKey(nickname);
    const refuseTooSoon = async () => {
        const r = await db().prepare('SELECT nickname_changed_at FROM users WHERE id=?').bind(u.id).first<{ nickname_changed_at: number | null }>();
        const next = (r?.nickname_changed_at || 0) + 30 * DAY;
        if (next > now) fail(409, `닉네임은 30일에 한 번 바꿀 수 있습니다. (${new Date(next).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' })}부터 가능)`);
    };
    await refuseTooSoon();
    await assertNicknameFree(nickname, u.id);
    try {
        // Both rules are checked again inside the update, so two changes at once cannot both pass.
        const r = await db().prepare('UPDATE users SET prev_nickname=nickname,nickname=?,nickname_key=?,nickname_changed_at=?,bio=? WHERE id=? AND (nickname_changed_at IS NULL OR nickname_changed_at<=?) AND NOT EXISTS(SELECT 1 FROM users WHERE nickname_key=? AND id!=?)')
            .bind(nickname, key, now, bio, u.id, now - 30 * DAY, key, u.id).run();
        if (!r.meta.changes) {
            await refuseTooSoon();
            fail(409, '비슷한 닉네임이 이미 있습니다.');
        }
    } catch (e) {
        if (String(e).includes('UNIQUE')) fail(409, '이미 사용 중인 닉네임입니다.');
        throw e;
    }
    return json({ ok: true });
}

async function stats() {
    await initManager();
    const r = await db().batch([
        db().prepare('SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL'),
        db().prepare('SELECT COUNT(*) AS count FROM posts WHERE hidden=0'),
        db().prepare("SELECT kind,category,COUNT(*) AS count FROM posts WHERE hidden=0 AND status!='closed' GROUP BY kind,category"),
    ]);
    const categories = r[2].results as any[];
    const byCategory = new Map<string, number>();
    for (const c of categories) byCategory.set(c.category, (byCategory.get(c.category) || 0) + c.count);
    return json({
        members: (r[0].results[0] as any).count, posts: (r[1].results[0] as any).count,
        categories: [...byCategory].map(([category, count]) => ({ category, count })), kinds: categories,
    });
}

// With the test meter on (READ_BUDGET=on, requests to 127.0.0.1 or localhost only), the response
// carries X-Rows-Read, X-Rows-Written, X-D1-Calls and X-D1-Statements for the whole request.
export async function handleApi(req: Request) {
    allowKvTestFailure(req);
    if (!meterOn() || !localRequest(req)) return route(req);
    const { result, meter } = await metered(() => route(req));
    for (const [k, v] of Object.entries(meterHeaders(meter))) result.headers.set(k, v);
    return result;
}

async function route(req: Request): Promise<Response> {
    try {
        const url = new URL(req.url), p = url.pathname.slice(5).split('/').filter(Boolean), method = req.method;
        if (method !== 'GET') csrf(req);
        switch (p[0]) {
            case 'auth': return await authHandler(req, p);
            case 'users': {
                // users/:id/reviews (WP23) is the 후기 tab and users/:id/trades (WP51) the 거래 기록 tab; users/:id is the profile.
                if (p[2] === 'reviews' || p[2] === 'trades') { const r = await reviewsHandler(req, p, url); if (r) return r; break; }
                if (p[1]) return await usersHandler(req, p);
                break;
            }
            case 'stats': if (method === 'GET') return await stats(); break;
            // The whole home page (shelves, 추천 매물, notices) in one request (WP42).
            case 'home': if (method === 'GET' && !p[1]) return await homeHandler(req, url); break;
            case 'health': return json({ ok: !!await db().prepare('SELECT 1 AS ok').first() });
            case 'posts': {
                // posts/:id/partners and posts/:id/trade (WP23: 거래한 회원 after 거래완료).
                if (p[2] === 'partners' || p[2] === 'trade') { const r = await reviewsHandler(req, p, url); if (r) return r; break; }
                return await postsHandler(req, p, url);
            }
            case 'uploads': case 'images': { const r = await filesHandler(req, p); if (r) return r; break; }
            case 'chats': { const r = await chatHandler(req, p, url); if (r) return r; break; }
            case 'config': case 'applications': { const r = await membershipHandler(req, p); if (r) return r; break; }
            case 'manage': { const r = await manageHandler(req, p, url); if (r) return r; break; }
            case 'me': {
                if (p[1] === 'usage' && method === 'GET') return await usageHandler(req);
                // 자동화 tab (WP52).
                if (p[1] === 'automation') { const a = await automationHandler(req, p); if (a) return a; break; }
                const r = await trialMeHandler(req, p);
                if (r) return r;
                break;
            }
            // 알림함 (WP50).
            case 'notifications': { const r = await notificationsHandler(req, p, url); if (r) return r; break; }
            case 'trades': { const r = await reviewsHandler(req, p, url); if (r) return r; break; }
            // 중개·가측 신청 (WP65).
            case 'services': { const r = await servicesHandler(req, p); if (r) return r; break; }
            default: { const r = await communityHandler(req, p); if (r) return r; }
        }
        fail(404, '요청을 찾을 수 없습니다.');
    } catch (e) {
        if (e instanceof ApiError) return json({ error: e.message }, e.status);
        console.error('Market request failed', e instanceof Error ? e.message : 'unknown');
        return json({ error: '서버 연결이 원활하지 않습니다. 잠시 후 다시 시도해 주세요.' }, 503);
    } finally {
        await discardUnreadBody(req);
    }
}
