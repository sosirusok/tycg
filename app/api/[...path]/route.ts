import { tradeHandler } from '@/lib/trade-server';
import { db, fail, ApiError, initManager, currentUser, requireUser, json, body, csrf, limit, textField, passwordHash, random, safeEqual, digest, tokenOf, sessionCookie } from '@/lib/server';
import { validTags, type SeasonTag } from '@/lib/market';
export const dynamic = 'force-dynamic';
const postSelect = 'SELECT p.*,u.nickname,u.role FROM posts p JOIN users u ON u.id=p.author_id';
async function tagsFor(posts: any[]) { if (!posts.length)
    return []; const rows = await db().prepare(`SELECT post_id,tier,season FROM post_seasons WHERE post_id IN (${posts.map(() => '?').join(',')}) ORDER BY season DESC`).bind(...posts.map(p => p.id)).all(); return posts.map(p => ({ ...p, tags: rows.results.filter(t => t.post_id === p.id).map(t => ({ tier: t.tier, season: t.season })) })); }
async function getPost(id: string) { return db().prepare(postSelect + ' WHERE p.id=?').bind(id).first<any>(); }
async function memberConversation(id: string, uid: string) { const c = await db().prepare('SELECT * FROM conversations WHERE id=? AND (user_a=? OR user_b=?)').bind(id, uid, uid).first<any>(); if (!c)
    fail(404, '대화를 찾을 수 없습니다.'); return c; }
async function handler(req: Request) {
    try {
        const url = new URL(req.url), p = url.pathname.slice(5).split('/').filter(Boolean), method = req.method;
        if (method !== 'GET')
            csrf(req);
        const trade = await tradeHandler(req, p, url);
        if (trade)
            return trade;
        if (p[0] === 'auth') {
            if (p[1] === 'me' && method === 'GET')
                return json({ user: await currentUser(req) });
            if (method !== 'POST')
                fail(405, '지원하지 않는 요청입니다.');
            if (p[1] === 'logout') {
                await db().prepare('DELETE FROM sessions WHERE token=?').bind(await digest(tokenOf(req))).run();
                return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, '', 0) });
            }
            const b = await body(req), username = typeof b.username === 'string' ? b.username.toLowerCase().trim() : '';
            if (!/^[a-z0-9_]{4,24}$/.test(username))
                fail(400, '아이디는 영문, 숫자, 밑줄로 4~24자까지 입력해 주세요.');
            if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 128)
                fail(400, '비밀번호는 8~128자로 입력해 주세요.');
            const ip = req.headers.get('cf-connecting-ip') || 'local';
            await limit('auth-ip:' + await digest(ip), 40, 600000);
            await limit('auth-user:' + username, 15, 600000);
            await initManager();
            let user: any;
            if (p[1] === 'register') {
                if (username === 'sosirusok')
                    fail(409, '이미 사용 중인 아이디입니다.');
                const nickname = textField(b.nickname, 2, 16, '닉네임');
                if (nickname === '우와오')
                    fail(409, '이미 사용 중인 닉네임입니다.');
                const salt = random(), id = crypto.randomUUID();
                try {
                    await db().prepare('INSERT INTO users (id,username,nickname,password_hash,salt,role,bio,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(id, username, nickname, await passwordHash(b.password, salt), salt, 'member', '', Date.now()).run();
                }
                catch (e) {
                    if (String(e).includes('UNIQUE'))
                        fail(409, '이미 사용 중인 아이디 또는 닉네임입니다.');
                    throw e;
                }
                user = { id, username, nickname, role: 'member', bio: '', created_at: Date.now() };
            }
            else if (p[1] === 'login') {
                const found = await db().prepare('SELECT * FROM users WHERE username=?').bind(username).first<any>();
                const hash = await passwordHash(b.password, found?.salt || 'invalid-user-constant-salt');
                if (!found || !safeEqual(hash, found.password_hash))
                    fail(401, '아이디 또는 비밀번호가 맞지 않습니다.');
                user = { id: found.id, username: found.username, nickname: found.nickname, role: found.role, bio: found.bio, created_at: found.created_at };
            }
            else
                fail(404, '페이지를 찾을 수 없습니다.');
            const token = random();
            await db().batch([db().prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()), db().prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').bind(await digest(token), user.id, Date.now() + 604800000)]);
            return json({ user }, 200, { 'Set-Cookie': sessionCookie(req, token) });
        }
        if (p[0] === 'users' && p[1]) {
            if (method === 'GET') {
                const user = await db().prepare('SELECT id,nickname,role,bio,created_at,(SELECT COUNT(*) FROM posts WHERE author_id=users.id) AS postCount FROM users WHERE id=?').bind(p[1]).first();
                if (!user)
                    fail(404, '회원을 찾을 수 없습니다.');
                return json({ user });
            }
            const u = await requireUser(req);
            if (u.id !== p[1])
                fail(403, '본인 프로필만 수정할 수 있습니다.');
            if (method !== 'PUT')
                fail(405, '지원하지 않는 요청입니다.');
            const b = await body(req), nickname = textField(b.nickname, 2, 16, '닉네임');
            if (u.role === 'manager' && nickname !== '우와오')
                fail(400, '매니저 닉네임은 우와오로 고정됩니다.');
            if (u.role !== 'manager' && nickname === '우와오')
                fail(409, '이미 사용 중인 닉네임입니다.');
            const bio = typeof b.bio === 'string' ? b.bio.trim().slice(0, 300) : '';
            try {
                await db().prepare('UPDATE users SET nickname=?,bio=? WHERE id=?').bind(nickname, bio, u.id).run();
            }
            catch (e) {
                if (String(e).includes('UNIQUE'))
                    fail(409, '이미 사용 중인 닉네임입니다.');
                throw e;
            }
            return json({ ok: true });
        }
        fail(404, '요청을 찾을 수 없습니다.');
    }
    catch (e) {
        if (e instanceof ApiError)
            return json({ error: e.message }, e.status);
        console.error('Market request failed', e instanceof Error ? e.message : 'unknown');
        return json({ error: '서버 연결이 원활하지 않습니다. 잠시 후 다시 시도해 주세요.' }, 503);
    }
}
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
