import {
    db, fail, ApiError, initManager, currentUser, requireUser, json, body, csrf, limit, storedHash, verifyPassword, random,
    digest, tokenOf, sessionCookie, memberColumns, withMember, nicknameField, nicknameKey, assertNicknameFree, isLegacyHash, DUMMY_HASH,
    MANAGER_USERNAME, SESSION_DAYS, WITHDRAWN_NAME,
} from './http';
import { postsHandler } from './posts';
import { filesHandler } from './files';
import { chatHandler } from './chat';
import { communityHandler } from './community';
import { membershipHandler } from './membership';
import { manageHandler } from './manage';
import { usageHandler } from './perks';

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
// An accepted offer the member sent holds another member's post at 예약중; that post goes back to 거래중.
const WITHDRAW_RESERVED = "sender_id=? AND status='accepted' AND EXISTS(SELECT 1 FROM posts p WHERE p.id=offers.post_id AND p.status='reserved')";

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
        line('회원 탈퇴로 제시가 마감되었습니다. 글이 거래중으로 바뀌었습니다.', WITHDRAW_RESERVED, [u.id]),
        line('회원 탈퇴로 제시가 마감되었습니다.', `${WITHDRAW_ENDS_OFFERS} AND NOT (${WITHDRAW_RESERVED})`, [u.id, u.id, u.id]),
        db().prepare(`UPDATE conversations SET updated_at=? WHERE id IN (SELECT conversation_id FROM offers WHERE ${WITHDRAW_ENDS_OFFERS})`).bind(now, u.id, u.id),
        db().prepare(`UPDATE posts SET status='open',updated_at=? WHERE id IN (SELECT post_id FROM offers WHERE ${WITHDRAW_RESERVED})`).bind(now, u.id),
        db().prepare("UPDATE posts SET hidden=1,hidden_reason='탈퇴' WHERE author_id=?").bind(u.id),
        db().prepare(`UPDATE offers SET status='cancelled',updated_at=? WHERE ${WITHDRAW_ENDS_OFFERS}`).bind(now, u.id, u.id),
        db().prepare("UPDATE applications SET status='cancelled',updated_at=? WHERE user_id=? AND status='pending'").bind(now, u.id),
    ]);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, '', 0) });
}

async function authHandler(req: Request, p: string[]) {
    const method = req.method;
    if (p[1] === 'me' && method === 'GET') return json({ user: await currentUser(req) });
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
    let id: string;
    if (p[1] === 'register') {
        // 'deleted_' ids are what 회원 탈퇴 leaves behind.
        if (username === MANAGER_USERNAME || username.startsWith('deleted_')) fail(409, '이미 사용 중인 아이디입니다.');
        const nickname = nicknameField(b.nickname), key = nicknameKey(nickname);
        await assertNicknameFree(nickname, '');
        const salt = random(), hash = await storedHash(b.password, salt);
        id = crypto.randomUUID();
        try {
            // The key is checked again inside the insert, so two look-alike sign-ups at once cannot both pass.
            const r = await db().prepare('INSERT INTO users (id,username,nickname,nickname_key,password_hash,salt,role,bio,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM users WHERE nickname_key=?)')
                .bind(id, username, nickname, key, hash, salt, 'member', '', Date.now(), key).run();
            if (!r.meta.changes) fail(409, '비슷한 닉네임이 이미 있습니다.');
        } catch (e) {
            if (String(e).includes('UNIQUE')) fail(409, String(e).includes('users.nickname') ? '이미 사용 중인 닉네임입니다.' : '이미 사용 중인 아이디입니다.');
            throw e;
        }
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
    const user = await db().prepare(`SELECT u.id,u.username,u.nickname,u.role,u.bio,u.created_at,${memberColumns('u')} FROM users u WHERE u.id=?`).bind(id).first<any>();
    return json({ user: withMember(user) }, 200, { 'Set-Cookie': sessionCookie(req, token) });
}

async function usersHandler(req: Request, p: string[]) {
    const method = req.method;
    if (method === 'GET') {
        const viewer = await currentUser(req);
        // Counts skip 대리(진행) posts whose author lost 대리 인증, as the board list does (the author still counts them).
        const listed = "p.author_id=u.id AND p.hidden=0 AND (p.kind!='proxy_offer' OR u.role='manager' OR p.author_id=? OR EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=p.author_id AND b.badge='proxy'))";
        const row = await db().prepare(`SELECT u.id,u.nickname,u.prev_nickname,u.nickname_changed_at,u.deleted_at,u.role,u.bio,u.created_at,u.last_seen_at,${memberColumns('u')},(SELECT COUNT(*) FROM posts p WHERE ${listed}) AS postCount,(SELECT COUNT(*) FROM posts p WHERE ${listed} AND p.status='closed') AS closedCount FROM users u WHERE u.id=?`)
            .bind(viewer?.id || '', viewer?.id || '', p[1]).first<any>();
        if (!row) fail(404, '회원을 찾을 수 없습니다.');
        const { prev_nickname, nickname_changed_at, deleted_at, ...rest } = row;
        // A withdrawn member is only a name: no bio, grade, badges, counts or chat.
        if (deleted_at) return json({ user: { id: row.id, nickname: WITHDRAWN_NAME, role: row.role, bio: '', created_at: row.created_at, grade: 'normal', grade_expires_at: null, badges: [], postCount: 0, closedCount: 0, last_seen_at: null, deleted: true } });
        const user: Record<string, unknown> = withMember(rest);
        // The nickname before the latest change stays on the profile for 90 days.
        if (prev_nickname && nickname_changed_at > Date.now() - 90 * DAY) user.prev_nickname = prev_nickname;
        // The member sees when their nickname can change again (30 days after the last change).
        if (viewer?.id === user.id && nickname_changed_at && nickname_changed_at + 30 * DAY > Date.now()) user.nickname_next_at = nickname_changed_at + 30 * DAY;
        if (viewer?.id !== user.id && viewer?.role !== 'manager') user.grade_expires_at = null;
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

export async function handleApi(req: Request) {
    try {
        const url = new URL(req.url), p = url.pathname.slice(5).split('/').filter(Boolean), method = req.method;
        if (method !== 'GET') csrf(req);
        switch (p[0]) {
            case 'auth': return await authHandler(req, p);
            case 'users': if (p[1]) return await usersHandler(req, p); break;
            case 'stats': if (method === 'GET') return await stats(); break;
            case 'health': return json({ ok: !!await db().prepare('SELECT 1 AS ok').first() });
            case 'posts': return await postsHandler(req, p, url);
            case 'uploads': case 'images': { const r = await filesHandler(req, p); if (r) return r; break; }
            case 'chats': { const r = await chatHandler(req, p, url); if (r) return r; break; }
            case 'config': case 'applications': { const r = await membershipHandler(req, p); if (r) return r; break; }
            case 'manage': { const r = await manageHandler(req, p, url); if (r) return r; break; }
            case 'me': if (p[1] === 'usage' && method === 'GET') return await usageHandler(req); break;
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
