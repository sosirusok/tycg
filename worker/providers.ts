import { env } from 'cloudflare:workers';
import type { User } from '../shared/market';
import {
    GRADES, PLUS_PAGE, PREMIUM_SHOWN, PROVIDER_INTRO_MAX, PROVIDER_ONLINE_MS, PROVIDER_ROTATE_MS, PROVIDER_SEEN_DAYS, PROVIDER_TEXT,
    introShown, isProviderType, kstDate, type BadgeId, type GradeId, type ProviderType,
} from '../shared/membership';
import { hasContact } from '../shared/links';
import { db, fail, currentUser, requireUser, requireActive, json, body, limit } from './http';
import { hash01 } from './ads';
import { localRequest } from './meter';

// 중개/가측 tab (WP66). GET /api/providers?type=broker|appraiser[&page=N] lists the members holding that 인증 by
// grade block; PUT /api/providers/me/:type {intro?, active?} edits the member's own card. The listing reads
// provider_profiles and each member's users row only (the grade, 인증 and 후기 copies on the profile row are
// kept by the 0036 triggers), in one D1 call: about 2 rows per listed member.

const DAY = 86400000, KST = 9 * 3600000;
// A grant row as copied on the profile: [rank, expires_at].
type GradeCopy = [number, number | null];
type Row = { user_id: string; intro: string; grades: string; badges: string; review_count: number; nickname: string; avatar_thumb: string | null; avatar_id: string | null; last_seen_at: number | null; type?: string };
export type ProviderItem = {
    id: string; nickname: string; avatar: string | null; avatarId: string | null; grade: GradeId; intro: string; online: boolean; lastSeenAt: number | null;
    badges: BadgeId[]; reviewCount: number; type?: ProviderType;
};

// Test only: X-Test-Now stands in for the clock on one local request when TEST_HOOKS=on (the 3-hour rotation).
function nowOf(req: Request) {
    if ((env as Partial<Env>).TEST_HOOKS === 'on' && localRequest(req)) {
        const v = Number(req.headers.get('X-Test-Now'));
        if (Number.isFinite(v) && v > 0) return v;
    }
    return Date.now();
}

// The rotation seed: the KST date and the 3-hour block of the day ('2026-10-02:3').
export const rotationSeed = (now: number) => `${kstDate(now)}:${Math.floor(((now + KST) % DAY) / PROVIDER_ROTATE_MS)}`;

const parse = <T>(raw: string | null | undefined, fallback: T): T => { try { const v = JSON.parse(raw || ''); return v ?? fallback; } catch { return fallback; } };
// The member's best manager grant that has not ended (never the 무료 체험: only manager rows are copied).
export function rankOf(grades: string, now: number) {
    let rank = 0;
    for (const g of parse<GradeCopy[]>(grades, [])) if (Array.isArray(g) && (g[1] === null || g[1] > now)) rank = Math.max(rank, Number(g[0]) || 0);
    return rank;
}
const gradeOfRank = (rank: number): GradeId => GRADES.find(g => g.rank === rank)?.id || 'normal';

// The card fields, the 소개 cut to the grade's length (the stored text is kept whole).
function item(r: Row, rank: number, now: number): ProviderItem {
    const badges = parse<string[]>(r.badges, []).filter((b): b is BadgeId => b === 'identity' || b === 'credit');
    return {
        id: r.user_id, nickname: r.nickname, avatar: r.avatar_thumb || null, avatarId: r.avatar_thumb ? r.avatar_id : null, grade: gradeOfRank(rank),
        intro: [...r.intro].slice(0, introShown(rank)).join(''), online: !!r.last_seen_at && r.last_seen_at > now - PROVIDER_ONLINE_MS, lastSeenAt: r.last_seen_at,
        // 본인 and 신용인 in BADGES order.
        badges: (['identity', 'credit'] as BadgeId[]).filter(b => badges.includes(b)), reviewCount: Number(r.review_count) || 0,
    };
}

// 접속 중 first, then everyone else; inside each group the seeded rotation (FNV-1a of id and seed), so every
// listed member takes the top place equally often over time and the order holds while the seed holds.
export function fairOrder<T extends { id: string; online: boolean }>(list: T[], seed: string) {
    const key = new Map(list.map(p => [p.id, hash01(p.id + ':' + seed)]));
    return [...list].sort((a, b) => Number(b.online) - Number(a.online) || key.get(b.id)! - key.get(a.id)! || (a.id < b.id ? -1 : 1));
}

// The listing rule in SQL: '받는 중' on, the 인증 of this kind held, a member who is not withdrawn, not
// suspended and seen in the last 14 days, and no block either way with the viewer. canProvide's grade part
// (a 플러스 or higher grant from the manager) is read from the grade copies in JS.
function listedSql(viewer: User | null, now: number) {
    const sql = `pp.active=1 AND instr(pp.badges,'"'||pp.type||'"')>0 AND u.deleted_at IS NULL AND u.role!='manager'
        AND (u.suspended_until IS NULL OR u.suspended_until<=?) AND u.last_seen_at>?`
        + (viewer ? ' AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.target_id=pp.user_id) OR (b.user_id=pp.user_id AND b.target_id=?))' : '');
    return { sql, args: [now, now - PROVIDER_SEEN_DAYS * DAY, ...viewer ? [viewer.id, viewer.id] : []] };
}
const COLUMNS = 'pp.user_id,pp.type,pp.intro,pp.grades,pp.badges,pp.review_count,u.nickname,u.avatar_thumb,u.avatar_id,u.last_seen_at';

// GET /providers?type=broker|appraiser[&page=N]: {elite, premium, plus, plusMore, page, seed, mine}. Page 1 has
// every block (엘리트 and 관리자 all, 프리미엄 the first 60 in the rotation, 플러스 the first 120); page N > 1 only the
// next 120 플러스. mine: the viewer's own card (their 인증 of this kind) with whether it is listed and why not.
async function listProviders(req: Request, url: URL) {
    const type = url.searchParams.get('type') || 'broker';
    if (!isProviderType(type)) fail(400, '종류를 확인해 주세요.');
    const page = Math.min(Math.max(Math.trunc(Number(url.searchParams.get('page'))) || 1, 1), 100);
    const viewer = await currentUser(req), now = nowOf(req), seed = rotationSeed(now);
    const w = listedSql(viewer, now);
    const holds = !!viewer && viewer.badges.includes(type);
    const r = await db().batch([
        db().prepare(`SELECT ${COLUMNS} FROM provider_profiles pp INDEXED BY provider_profiles_list JOIN users u ON u.id=pp.user_id WHERE pp.type=? AND ${w.sql}`).bind(type, ...w.args),
        ...holds ? [db().prepare('SELECT intro,active FROM provider_profiles WHERE user_id=? AND type=?').bind(viewer!.id, type)] : [],
    ]);
    const blocks: Record<'elite' | 'premium' | 'plus', ProviderItem[]> = { elite: [], premium: [], plus: [] };
    for (const row of r[0].results as Row[]) {
        const rank = rankOf(row.grades, now);
        if (rank < 1) continue;
        blocks[rank >= 3 ? 'elite' : rank === 2 ? 'premium' : 'plus'].push(item(row, rank, now));
    }
    const elite = fairOrder(blocks.elite, seed), premium = fairOrder(blocks.premium, seed).slice(0, PREMIUM_SHOWN), plusAll = fairOrder(blocks.plus, seed);
    const plus = plusAll.slice((page - 1) * PLUS_PAGE, page * PLUS_PAGE);
    let mine: { intro: string; active: boolean; listed: boolean; reason: '' | 'grade' | 'off' } | null = null;
    const own = holds ? r[1].results[0] as { intro: string; active: number } | undefined : undefined;
    if (viewer && own) {
        const listed = [...blocks.elite, ...blocks.premium, ...blocks.plus].some(p => p.id === viewer.id);
        mine = { intro: own.intro, active: !!own.active, listed, reason: listed ? '' : !own.active ? 'off' : 'grade' };
    }
    return json({ type, page, seed, elite: page === 1 ? elite : [], premium: page === 1 ? premium : [], plus, plusMore: plusAll.length > page * PLUS_PAGE, mine },
        200, { 'Cache-Control': 'private, max-age=30' });
}

// One line of at most 25 characters with no address or phone number.
function introField(v: unknown) {
    if (typeof v !== 'string') fail(400, PROVIDER_TEXT.introBad);
    const intro = v.replace(/\s+/g, ' ').trim();
    if (hasContact(intro)) fail(400, PROVIDER_TEXT.introBad);
    if ([...intro].length > PROVIDER_INTRO_MAX) fail(400, PROVIDER_TEXT.introLong);
    return intro;
}

// PUT /providers/me/:type {intro?, active?}: only with the 인증 of that kind. The row exists from the grant
// (the 0036 trigger); a missing one is created here with its copies.
async function editMine(req: Request, type: ProviderType) {
    const u = await requireUser(req);
    requireActive(u);
    if (!u.badges.includes(type)) fail(403, PROVIDER_TEXT.noBadge);
    await limit('provider-edit:' + u.id, 30, 600000);
    const b = await body(req);
    const intro = b.intro === undefined ? null : introField(b.intro);
    const active = b.active === undefined ? null : b.active ? 1 : 0;
    const now = Date.now();
    await db().prepare(`INSERT INTO provider_profiles(user_id,type,intro,active,updated_at,grades,elite_until,badges,review_count)
        SELECT ?,?,COALESCE(?,''),COALESCE(?,1),?,
            (SELECT json_group_array(json_array(g.rank,g.expires_at)) FROM user_grades g WHERE g.user_id=? AND g.source='manager'),
            COALESCE((SELECT MAX(COALESCE(g.expires_at,9000000000000000)) FROM user_grades g WHERE g.user_id=? AND g.source='manager' AND g.rank>=3),0),
            (SELECT json_group_array(b.badge) FROM user_badges b WHERE b.user_id=?),
            (SELECT COUNT(*) FROM reviews rv WHERE rv.target_id=? AND rv.removed_at IS NULL AND EXISTS(SELECT 1 FROM trades lt WHERE lt.id=rv.trade_id AND lt.removed_at IS NULL))
        WHERE EXISTS(SELECT 1 FROM user_badges WHERE user_id=? AND badge=?)
        ON CONFLICT(user_id,type) DO UPDATE SET intro=COALESCE(?,intro),active=COALESCE(?,active),updated_at=excluded.updated_at`)
        .bind(u.id, type, intro, active, now, u.id, u.id, u.id, u.id, u.id, type, intro, active).run();
    const row = await db().prepare('SELECT intro,active FROM provider_profiles WHERE user_id=? AND type=?').bind(u.id, type).first<{ intro: string; active: number }>();
    if (!row) fail(403, PROVIDER_TEXT.noBadge);
    return json({ intro: row.intro, active: !!row.active });
}

export async function providersHandler(req: Request, p: string[], url: URL): Promise<Response | null> {
    if (!p[1] && req.method === 'GET') return listProviders(req, url);
    if (p[1] === 'me' && p[2] && !p[3] && req.method === 'PUT') {
        if (!isProviderType(p[2])) fail(400, '종류를 확인해 주세요.');
        return editMine(req, p[2]);
    }
    return null;
}

// The home popup's providers (WP66 item 12): listed 엘리트 and 관리자 members of both kinds, read through the
// partial index of members holding 엘리트 or 관리자 now. At most 60 rows.
export function popupStatement(viewer: User | null, now: number) {
    const w = listedSql(viewer, now);
    return db().prepare(`SELECT ${COLUMNS} FROM provider_profiles pp INDEXED BY provider_profiles_elite JOIN users u ON u.id=pp.user_id WHERE pp.elite_until>? AND ${w.sql} LIMIT 60`).bind(now, ...w.args);
}
export function popupProviders(rows: Row[], now: number): ProviderItem[] {
    const out: ProviderItem[] = [];
    for (const row of rows) {
        const rank = rankOf(row.grades, now);
        if (rank >= 3) out.push({ ...item(row, rank, now), type: row.type as ProviderType });
    }
    return out;
}
