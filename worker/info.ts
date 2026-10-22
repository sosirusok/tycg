import { db, fail, json, body, currentUser, requireUser, MANAGER_ID } from './http';
import { piiReader, type Pii } from './pii';
import { INFO_FIELDS, isInfoField, type InfoField } from '../shared/membership';
import type { User } from '../shared/market';

// 회원 정보 (users.pii, worker/pii.ts): the only routes that decrypt it, and every value they send.
//   GET me/info                       the member's own four fields
//   GET manage/info?q&page            the manager (manageHandler checks the role): every member who has not left
//   PUT manage/info-grants/:userId    the manager: {fields} a 관리자-grade member may see ([]: none)
//   GET member-info?q&page            a 관리자-grade member the manager allowed: only those fields; 403 for anyone
//                                     else, also once the grant is removed or the 관리자 grade ended
// Nothing else reads users.pii. auth/me names a 관리자's allowed field keys (infoFields), never a value.
const PAGE = 50;
const NO_ACCESS = '회원 정보를 볼 권한이 없습니다.';

// A current 관리자 grade (any row, so a 플러스 체험 never counts). `u` is the users alias; binds the time once.
const adminGrade = (u: string) => `EXISTS(SELECT 1 FROM user_grades ag WHERE ag.user_id=${u}.id AND ag.grade='admin' AND (ag.expires_at IS NULL OR ag.expires_at>?))`;

const fieldsOf = (raw: string | null | undefined): InfoField[] => {
    try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? INFO_FIELDS.filter(f => v.includes(f)) : []; } catch { return []; }
};

// The fields the viewer may see in member-info: a 관리자-grade member (never the manager) with a grant.
export async function infoFieldsOf(user: User | null): Promise<InfoField[]> {
    if (!user || user.role === 'manager' || user.grade !== 'admin') return [];
    const row = await db().prepare('SELECT fields FROM pii_grants WHERE user_id=?').bind(user.id).first<{ fields: string }>();
    return fieldsOf(row?.fields);
}

const pick = (pii: Pii | null, fields: readonly InfoField[]) => Object.fromEntries(fields.map(f => [f, pii?.[f] ?? null]));

// One page of members who have not left, newest first, with `fields` of each; q: part of the nickname.
async function members(req: Request, url: URL, fields: readonly InfoField[], withManager: boolean) {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 30), page = Math.max(1, Math.min(1000, Number(url.searchParams.get('page')) || 1));
    const where = ['u.deleted_at IS NULL'], args: unknown[] = [];
    if (!withManager) { where.push('u.id!=?'); args.push(MANAGER_ID); }
    if (q) { where.push("u.nickname LIKE ? ESCAPE '\\'"); args.push('%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%'); }
    const r = await db().prepare(`SELECT u.id,u.nickname,u.role,u.pii FROM users u WHERE ${where.join(' AND ')} ORDER BY u.created_at DESC,u.id LIMIT ? OFFSET ?`)
        .bind(...args, PAGE + 1, (page - 1) * PAGE).all<{ id: string; nickname: string; role: string; pii: string | null }>();
    const open = await piiReader(req), rows = r.results.slice(0, PAGE);
    const list = [];
    for (const m of rows) list.push({ id: m.id, nickname: m.nickname, role: m.role, ...pick(await open(m.pii), fields) });
    return { members: list, more: r.results.length > PAGE, page };
}

export async function meInfo(req: Request) {
    const u = await requireUser(req);
    const row = await db().prepare('SELECT pii FROM users WHERE id=?').bind(u.id).first<{ pii: string | null }>();
    const pii = await (await piiReader(req))(row?.pii);
    return json({ info: pii ? pick(pii, INFO_FIELDS) : null }, 200, { 'Cache-Control': 'no-store' });
}

export async function memberInfo(req: Request, url: URL) {
    const fields = await infoFieldsOf(await currentUser(req));
    if (!fields.length) fail(403, NO_ACCESS);
    return json({ fields, ...await members(req, url, fields, false) }, 200, { 'Cache-Control': 'no-store' });
}

// The manager's 회원 정보 tab: the members with all four fields, and the 관리자-grade members with their grants.
export async function manageInfo(req: Request, url: URL) {
    const list = await members(req, url, INFO_FIELDS, true);
    const admins = url.searchParams.get('page') && url.searchParams.get('page') !== '1' ? undefined
        : (await db().prepare(`SELECT u.id,u.nickname,g.fields FROM users u LEFT JOIN pii_grants g ON g.user_id=u.id WHERE u.deleted_at IS NULL AND u.role!='manager' AND ${adminGrade('u')} ORDER BY u.nickname LIMIT 200`)
            .bind(Date.now()).all<{ id: string; nickname: string; fields: string | null }>()).results.map(a => ({ id: a.id, nickname: a.nickname, fields: fieldsOf(a.fields) }));
    return json({ ...list, ...admins ? { admins } : {} }, 200, { 'Cache-Control': 'no-store' });
}

export async function manageInfoGrant(req: Request, userId: string) {
    const b = await body(req);
    if (!Array.isArray(b.fields) || b.fields.length > INFO_FIELDS.length || !b.fields.every(isInfoField)) fail(400, '열람 항목을 확인해 주세요.');
    const fields = INFO_FIELDS.filter(f => b.fields.includes(f));
    const target = await db().prepare(`SELECT u.id,${adminGrade('u')} AS admin FROM users u WHERE u.id=? AND u.deleted_at IS NULL AND u.role!='manager'`).bind(Date.now(), userId).first<{ id: string; admin: number }>();
    if (!target) fail(404, '회원을 찾을 수 없습니다.');
    if (!target.admin) fail(409, '관리자 등급 회원에게만 열람 권한을 줄 수 있습니다.');
    if (fields.length) await db().prepare('INSERT INTO pii_grants(user_id,fields,granted_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET fields=excluded.fields,granted_at=excluded.granted_at').bind(userId, JSON.stringify(fields), Date.now()).run();
    else await db().prepare('DELETE FROM pii_grants WHERE user_id=?').bind(userId).run();
    return json({ fields });
}
