import {
    db, fail, ApiError, initManager, currentUser, requireUser, json, body, csrf, limit, storedHash, verifyPassword, random,
    digest, tokenOf, sessionCookie, memberColumns, withMember, nicknameField, isLegacyHash, DUMMY_HASH, MANAGER_USERNAME, SESSION_DAYS,
} from './http';
import { postsHandler } from './posts';
import { filesHandler } from './files';
import { chatHandler } from './chat';
import { communityHandler } from './community';
import { membershipHandler } from './membership';
import { manageHandler } from './manage';

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

async function authHandler(req: Request, p: string[]) {
    const method = req.method;
    if (p[1] === 'me' && method === 'GET') return json({ user: await currentUser(req) });
    if (method !== 'POST') fail(405, '지원하지 않는 요청입니다.');
    if (p[1] === 'logout') {
        await db().prepare('DELETE FROM sessions WHERE token=?').bind(await digest(tokenOf(req))).run();
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }
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
        if (username === MANAGER_USERNAME) fail(409, '이미 사용 중인 아이디입니다.');
        const nickname = nicknameField(b.nickname);
        const salt = random();
        id = crypto.randomUUID();
        try {
            await db().prepare('INSERT INTO users (id,username,nickname,password_hash,salt,role,bio,created_at) VALUES (?,?,?,?,?,?,?,?)')
                .bind(id, username, nickname, await storedHash(b.password, salt), salt, 'member', '', Date.now()).run();
        } catch (e) {
            if (String(e).includes('UNIQUE')) fail(409, String(e).includes('users.nickname') ? '이미 사용 중인 닉네임입니다.' : '이미 사용 중인 아이디입니다.');
            throw e;
        }
    } else if (p[1] === 'login') {
        const found = await db().prepare('SELECT id,salt,password_hash FROM users WHERE username=?').bind(username).first<any>();
        // Unknown ids still run one hash of the current cost so response time does not reveal which ids exist.
        const ok = await verifyPassword(b.password, found?.salt || 'invalid-user-constant-salt', found?.password_hash || DUMMY_HASH);
        if (!found || !ok) fail(401, '아이디 또는 비밀번호가 맞지 않습니다.');
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
        const row = await db().prepare(`SELECT u.id,u.nickname,u.role,u.bio,u.created_at,${memberColumns('u')},(SELECT COUNT(*) FROM posts WHERE author_id=u.id AND hidden=0) AS postCount,(SELECT COUNT(*) FROM posts WHERE author_id=u.id AND hidden=0 AND status='closed') AS closedCount FROM users u WHERE u.id=?`).bind(p[1]).first<any>();
        if (!row) fail(404, '회원을 찾을 수 없습니다.');
        const user = withMember(row);
        if (viewer?.id !== user.id && viewer?.role !== 'manager') user.grade_expires_at = null;
        return json({ user });
    }
    const u = await requireUser(req);
    if (u.id !== p[1]) fail(403, '본인 프로필만 수정할 수 있습니다.');
    if (method !== 'PUT') fail(405, '지원하지 않는 요청입니다.');
    const b = await body(req);
    // An unchanged nickname is kept even if it predates the current nickname rules.
    const nickname = b.nickname === u.nickname ? u.nickname : nicknameField(b.nickname, u.role === 'manager');
    const bio = typeof b.bio === 'string' ? b.bio.trim().slice(0, 300) : '';
    try {
        await db().prepare('UPDATE users SET nickname=?,bio=? WHERE id=?').bind(nickname, bio, u.id).run();
    } catch (e) {
        if (String(e).includes('UNIQUE')) fail(409, '이미 사용 중인 닉네임입니다.');
        throw e;
    }
    return json({ ok: true });
}

async function stats() {
    await initManager();
    const r = await db().batch([
        db().prepare('SELECT COUNT(*) AS count FROM users'),
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
