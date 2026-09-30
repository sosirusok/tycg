import { db, fail, requireUser, json, body, limit, initManager, memberColumns, withMember, setting, random, storedHash, MANAGER_ID } from './http';
import { ensureChat, messageStatements, guardedMessageStatements } from './chat';
import { latestSeason } from './posts';
import {
    PURCHASABLE_GRADES, addMonths, applicationTitle, badgeInfo, gradeInfo, isBadge, isGrade, planInfo,
    type ApplicationKind, type BadgeId, type GradeId, type PlanId,
} from '../shared/membership';
import type { User } from '../shared/market';

export async function siteConfig() {
    await initManager();
    const manager = await db().prepare('SELECT id,nickname FROM users WHERE id=?').bind(MANAGER_ID).first<any>();
    return { latestSeason: await latestSeason(), paymentNotice: await setting('payment_notice') || '', manager: manager || null };
}

// A 6-month grant extends an unexpired grant of the same grade instead of overlapping it.
// With a guard, the grant is written only if that SQL condition holds when the batch runs.
export async function grantGradeStatements(userId: string, grade: GradeId, plan: PlanId, by: string, applicationId: string | null, now = Date.now(), guard = '1', guardArgs: unknown[] = []) {
    const info = gradeInfo(grade);
    let expires: number | null = null;
    if (plan === '6m') {
        const current = await db().prepare('SELECT MAX(expires_at) AS until FROM user_grades WHERE user_id=? AND grade=? AND expires_at>?').bind(userId, grade, now).first<any>();
        expires = addMonths(Math.max(now, current?.until || 0), 6);
    }
    return { expires, statement: db().prepare(`INSERT INTO user_grades(user_id,grade,rank,expires_at,granted_by,granted_at,application_id) SELECT ?,?,?,?,?,?,? WHERE ${guard}`).bind(userId, grade, info.rank, expires, by, now, applicationId, ...guardArgs) };
}

function dateLabel(t: number) {
    return new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });
}

async function permanentRank(userId: string) {
    const r = await db().prepare('SELECT MAX(rank) AS rank FROM user_grades WHERE user_id=? AND expires_at IS NULL').bind(userId).first<any>();
    return Number(r?.rank || 0);
}

const DECIDED = 'EXISTS(SELECT 1 FROM applications WHERE id=? AND decision_id=?)';

// The status change carries a new decision id. The grant and the chat message are
// guarded by that id, so when two decisions overlap only the first one takes effect.
async function decide(u: User, app: any, action: 'approve' | 'reject', note: string) {
    const now = Date.now(), decision = crypto.randomUUID(), args = [app.id, decision];
    const statements: D1PreparedStatement[] = [
        db().prepare("UPDATE applications SET status=?,note=?,decided_by=?,decided_at=?,updated_at=?,decision_id=? WHERE id=? AND status='pending'").bind(action === 'approve' ? 'approved' : 'rejected', note, u.id, now, now, decision, app.id),
    ];
    let message = '';
    if (action === 'approve') {
        if (app.kind === 'badge') {
            statements.push(db().prepare(`INSERT OR IGNORE INTO user_badges(user_id,badge,granted_by,granted_at) SELECT ?,?,?,? WHERE ${DECIDED}`).bind(app.user_id, app.target, u.id, now, ...args));
            message = `${badgeInfo(app.target)?.name} 지급 완료`;
        } else {
            const { expires, statement } = await grantGradeStatements(app.user_id, app.target, app.plan, u.id, app.id, now, DECIDED, args);
            statements.push(statement);
            message = `${gradeInfo(app.target).name} 등급 지급 완료${expires ? ` (${dateLabel(expires)}까지)` : ' (영구)'}`;
        }
    } else {
        message = `반려: ${applicationTitle(app)}${note ? ` (사유: ${note})` : ''}`;
    }
    if (app.conversation_id) statements.push(...guardedMessageStatements(app.conversation_id, u.id, message, 'system', app.id, DECIDED, args, now));
    const r = await db().batch(statements);
    if (!r[0].meta.changes) fail(409, '이미 처리된 신청입니다.');
}

export async function membershipHandler(req: Request, p: string[]): Promise<Response | null> {
    const method = req.method;
    if (p[0] === 'config' && method === 'GET') return json(await siteConfig());
    if (p[0] !== 'applications') return null;
    const u = await requireUser(req);
    if (!p[1] && method === 'GET') {
        const r = await db().prepare('SELECT * FROM applications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(u.id).all();
        return json({ applications: r.results });
    }
    if (!p[1] && method === 'POST') {
        if (u.role === 'manager') fail(400, '매니저 계정은 신청할 수 없습니다.');
        await limit('apply:' + u.id, 30, 3600000);
        const b = await body(req);
        const kind: ApplicationKind = b.kind === 'grade' ? 'grade' : 'badge';
        let plan: PlanId | null = null;
        if (kind === 'badge') {
            if (!isBadge(b.target)) fail(400, '신청할 인증을 선택해 주세요.');
            if (u.badges.includes(b.target as BadgeId)) fail(409, '이미 받은 인증입니다.');
        } else {
            if (!isGrade(b.target) || !PURCHASABLE_GRADES.includes(b.target)) fail(400, '신청할 등급을 선택해 주세요.');
            if (!planInfo(b.target, b.plan)) fail(400, '기간을 선택해 주세요.');
            plan = b.plan;
            if (await permanentRank(u.id) >= gradeInfo(b.target).rank) fail(409, '이미 같은 등급 이상을 영구로 보유하고 있습니다.');
        }
        await initManager();
        if (!await db().prepare('SELECT 1 FROM users WHERE id=?').bind(MANAGER_ID).first()) fail(503, '매니저 계정이 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.');
        const chatId = await ensureChat(u.id, MANAGER_ID);
        const pending = await db().prepare("SELECT * FROM applications WHERE user_id=? AND kind=? AND target=? AND status='pending'").bind(u.id, kind, b.target).first<any>();
        if (pending) {
            // Changing the period of a pending grade request updates the same request.
            if (kind === 'grade' && pending.plan !== plan) {
                const now = Date.now(), updated = { ...pending, plan };
                await db().batch([
                    db().prepare("UPDATE applications SET plan=?,conversation_id=?,updated_at=? WHERE id=? AND status='pending'").bind(plan, chatId, now, pending.id),
                    ...messageStatements(chatId, u.id, applicationTitle(updated), 'application', pending.id, [], now),
                ]);
            } else if (pending.conversation_id !== chatId) {
                await db().prepare('UPDATE applications SET conversation_id=? WHERE id=?').bind(chatId, pending.id).run();
            }
            return json({ id: pending.id, chatId, created: false });
        }
        const id = crypto.randomUUID(), now = Date.now();
        const app = { id, kind, target: b.target, plan };
        try {
            await db().batch([
                db().prepare('INSERT INTO applications(id,user_id,kind,target,plan,status,conversation_id,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id, u.id, kind, b.target, plan, 'pending', chatId, '', now, now),
                ...messageStatements(chatId, u.id, applicationTitle(app), 'application', id, [], now),
            ]);
        } catch (e) {
            // A simultaneous request already opened the same application.
            if (!String(e).includes('UNIQUE')) throw e;
            const existing = await db().prepare("SELECT id FROM applications WHERE user_id=? AND kind=? AND target=? AND status='pending'").bind(u.id, kind, b.target).first<any>();
            if (!existing) throw e;
            return json({ id: existing.id, chatId, created: false });
        }
        return json({ id, chatId, created: true }, 201);
    }
    if (p[1] && method === 'PATCH') {
        const b = await body(req);
        const app = await db().prepare('SELECT * FROM applications WHERE id=?').bind(p[1]).first<any>();
        if (!app || (app.user_id !== u.id && u.role !== 'manager')) fail(404, '신청을 찾을 수 없습니다.');
        if (app.status !== 'pending') fail(409, '이미 처리된 신청입니다.');
        if (b.action === 'cancel') {
            if (app.user_id !== u.id) fail(403, '본인 신청만 취소할 수 있습니다.');
            const now = Date.now(), decision = crypto.randomUUID();
            const r = await db().batch([
                db().prepare("UPDATE applications SET status='cancelled',updated_at=?,decision_id=? WHERE id=? AND status='pending'").bind(now, decision, app.id),
                ...(app.conversation_id ? guardedMessageStatements(app.conversation_id, u.id, `신청 취소: ${applicationTitle(app)}`, 'system', app.id, DECIDED, [app.id, decision], now) : []),
            ]);
            if (!r[0].meta.changes) fail(409, '이미 처리된 신청입니다.');
            return json({ ok: true });
        }
        if (u.role !== 'manager') fail(403, '매니저만 처리할 수 있습니다.');
        if (b.action !== 'approve' && b.action !== 'reject') fail(400, '처리 방식을 확인해 주세요.');
        const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '';
        await decide(u, app, b.action, note);
        return json({ ok: true });
    }
    fail(405, '지원하지 않는 요청입니다.');
}

// Temporary passwords avoid look-alike characters (i, l, o, 0, 1). 248 is the largest multiple
// of 31 below 256, so every character is equally likely.
const TEMP_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function tempPassword(length = 10) {
    let out = '';
    while (out.length < length) {
        for (const byte of crypto.getRandomValues(new Uint8Array(16))) if (byte < 248 && out.length < length) out += TEMP_CHARS[byte % TEMP_CHARS.length];
    }
    return out;
}

// Manager-only member administration: search, badges, grades, applications and temporary passwords.
export async function manageMembers(req: Request, u: User, p: string[], url: URL): Promise<Response | null> {
    const method = req.method;
    if (p[1] === 'applications' && method === 'GET') {
        const status = url.searchParams.get('status');
        const where = status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status) ? 'WHERE a.status=?' : '';
        const stmt = db().prepare(`SELECT a.*,u.nickname,u.username,${memberColumns('u')} FROM applications a JOIN users u ON u.id=a.user_id ${where} ORDER BY a.status='pending' DESC,a.created_at DESC LIMIT 200`);
        const r = await (where ? stmt.bind(status) : stmt).all();
        return json({ applications: r.results.map(row => withMember(row as any)) });
    }
    if (p[1] === 'users' && !p[2] && method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 40);
        const filter = url.searchParams.get('filter');
        const where: string[] = [], values: any[] = [];
        if (q) { where.push('(instr(lower(u.nickname),lower(?))>0 OR instr(lower(u.username),lower(?))>0)'); values.push(q, q); }
        if (filter === 'badged') where.push('EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=u.id)');
        if (filter === 'graded') where.push("EXISTS(SELECT 1 FROM user_grades g WHERE g.user_id=u.id AND (g.expires_at IS NULL OR g.expires_at>strftime('%s','now')*1000))");
        const r = await db().prepare(`SELECT u.id,u.username,u.nickname,u.role,u.created_at,${memberColumns('u')},(SELECT COUNT(*) FROM posts WHERE author_id=u.id) AS postCount FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.created_at DESC LIMIT 100`).bind(...values).all();
        return json({ users: r.results.map(row => withMember(row as any)) });
    }
    if (p[1] === 'users' && p[2]) {
        const target = await db().prepare(`SELECT u.id,u.username,u.nickname,u.role,u.bio,u.created_at,u.deleted_at,${memberColumns('u')} FROM users u WHERE u.id=?`).bind(p[2]).first<any>();
        if (!target) fail(404, '회원을 찾을 수 없습니다.');
        if (!p[3] && method === 'GET') {
            const [grants, badges, apps] = await db().batch([
                db().prepare('SELECT * FROM user_grades WHERE user_id=? ORDER BY granted_at DESC').bind(p[2]),
                db().prepare('SELECT * FROM user_badges WHERE user_id=?').bind(p[2]),
                db().prepare('SELECT * FROM applications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(p[2]),
            ]);
            return json({ user: withMember(target), grants: grants.results, badges: badges.results, applications: apps.results });
        }
        if (p[3] === 'badges' && method === 'POST') {
            const b = await body(req);
            if (!isBadge(b.badge)) fail(400, '인증 종류를 확인해 주세요.');
            if (b.active) await db().prepare('INSERT OR IGNORE INTO user_badges(user_id,badge,granted_by,granted_at) VALUES(?,?,?,?)').bind(p[2], b.badge, u.id, Date.now()).run();
            else await db().prepare('DELETE FROM user_badges WHERE user_id=? AND badge=?').bind(p[2], b.badge).run();
            return json({ ok: true });
        }
        if (p[3] === 'grades' && !p[4] && method === 'POST') {
            const b = await body(req);
            if (!isGrade(b.grade) || b.grade === 'normal') fail(400, '등급을 확인해 주세요.');
            const plan: PlanId = b.plan === '6m' ? '6m' : 'permanent';
            if (plan === '6m' && !planInfo(b.grade, '6m')) fail(400, '이 등급은 6개월 기간이 없습니다.');
            if (target.role === 'manager') fail(400, '매니저 계정에는 등급을 지급하지 않습니다.');
            const { statement } = await grantGradeStatements(p[2], b.grade, plan, u.id, null);
            await statement.run();
            return json({ ok: true }, 201);
        }
        // A member who forgot their password gets a temporary one through the manager's chat.
        // It replaces the old password and signs the member out everywhere; it is shown only in this response.
        if (p[3] === 'password' && !p[4] && method === 'POST') {
            if (target.role === 'manager') fail(400, '매니저 계정에는 임시 비밀번호를 발급하지 않습니다.');
            if (target.deleted_at) fail(400, '탈퇴한 회원입니다.');
            const password = tempPassword(), salt = random();
            await db().batch([
                db().prepare('UPDATE users SET password_hash=?,salt=? WHERE id=?').bind(await storedHash(password, salt), salt, target.id),
                db().prepare('DELETE FROM sessions WHERE user_id=?').bind(target.id),
            ]);
            return json({ password });
        }
        if (p[3] === 'grades' && p[4] && method === 'DELETE') {
            const r = await db().prepare('DELETE FROM user_grades WHERE id=? AND user_id=?').bind(p[4], p[2]).run();
            if (!r.meta.changes) fail(404, '지급 내역을 찾을 수 없습니다.');
            return json({ ok: true });
        }
    }
    if (p[1] === 'settings' && method === 'PUT') {
        const b = await body(req), now = Date.now(), statements: D1PreparedStatement[] = [];
        if (typeof b.paymentNotice === 'string') {
            statements.push(db().prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('payment_notice', b.paymentNotice.trim().slice(0, 300), now));
        }
        if (b.latestSeason !== undefined) {
            const n = Number(b.latestSeason);
            if (!Number.isInteger(n) || n < 32 || n > 200) fail(400, '현재 시즌은 32 이상의 숫자로 입력해 주세요.');
            if (n < await latestSeason()) fail(400, '이미 등록된 시즌보다 낮출 수 없습니다.');
            statements.push(db().prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('latest_season', String(n), now));
        }
        if (statements.length) await db().batch(statements);
        return json(await siteConfig());
    }
    return null;
}
