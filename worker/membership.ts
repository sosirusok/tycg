import { blockedDomains } from './unfurl';
import { db, fail, requireUser, requireActive, requireManager, json, body, limit, initManager, isManager, isSuspended, memberColumns, withMember, setting, random, storedHash, textField, trialWindow, trialOpen, clearTrialCache, MANAGER_ID, WITHDRAWN } from './http';
import { storageMode } from './storage';
import { notifyOne } from './notifications';
import { ensureChat, messageStatements, guardedMessageStatements } from './chat';
import { latestSeason } from './posts';
import { memberTrades, memberTradesStatement, memberTradeCountsStatement } from './reviews';
import { enrolStatements } from './automation';
import { adFillStatement } from './ads';
import {
    AUTO_TEXT, GRADES, PERKS, PURCHASABLE_GRADES, addMonths, applicationTitle, badgeInfo, gradeInfo, isBadge, isGrade, planInfo,
    type ApplicationKind, type BadgeId, type GradeId, type PlanId, type TrialState,
} from '../shared/membership';
import { SUSPEND_DAYS, SUSPEND_FOREVER, suspendDaysLabel, type User } from '../shared/market';

export async function siteConfig() {
    await initManager();
    const manager = await db().prepare('SELECT id,nickname FROM users WHERE id=?').bind(MANAGER_ID).first<any>();
    // The guest home band '가입하면 플러스 7일 무료' shows while the trial window is open.
    const w = await trialWindow(), open = trialOpen(w);
    // storage ('r2', 'kv' or 'd1') sets how far the browser shrinks photos before upload (WP45).
    // blockedLinks: the manager's 링크 차단 list, so stored links to those hosts render as plain text (WP48).
    return { latestSeason: await latestSeason(), paymentNotice: await setting('payment_notice') || '', manager: manager || null, trial: { open, endsAt: open ? w.end : null }, storage: storageMode(), blockedLinks: await blockedDomains() };
}

const DAY = 86400000;

// The member's own 플러스 무료 체험 state: when it ends, whether the sign-up popup is still due
// (trial running, still the member's grade, and never closed), whether the one-time end band is due (the trial ended, no grade
// replaced it and the band was not closed yet; closing sets reminded_at=-1 on the trial row, and the
// cron's end 알림 sets -2, which keeps the band), and whether the
// per-address cap kept the trial from this account (trial_at=-1, shown for a day after sign-up; a
// closed-window sign-up is -2 and never reads as capped).
export async function trialState(u: User, capped = false): Promise<TrialState> {
    const now = Date.now();
    const r = await db().prepare(`SELECT u.trial_at,u.trial_popup_at,u.created_at,t.expires_at,t.reminded_at FROM users u
        LEFT JOIN user_grades t ON t.user_id=u.id AND t.source='trial' WHERE u.id=? ORDER BY t.id DESC LIMIT 1`).bind(u.id).first<any>();
    if (!r) return { endsAt: null, popup: false, ended: false, capped };
    const has = r.expires_at !== null && r.expires_at !== undefined;
    return {
        endsAt: has ? r.expires_at : null,
        // Only while the trial is the member's grade: a paid or manager grade of the same or a higher rank
        // (엘리트 given during the trial) never shows the trial event popup.
        popup: has && r.trial_popup_at === null && r.expires_at > now && !!u.grade_trial,
        ended: has && r.expires_at <= now && r.reminded_at !== -1 && gradeInfo(u.grade).rank === 0,
        capped: capped || (r.trial_at === -1 && r.created_at > now - DAY),
    };
}

// POST me/trial-popup (the popup was closed or '첫 글 쓰기' was tapped) and POST me/trial-ended-seen
// (the end band was closed). Both only stamp the member's own rows.
export async function trialMeHandler(req: Request, p: string[]): Promise<Response | null> {
    if (req.method !== 'POST' || (p[1] !== 'trial-popup' && p[1] !== 'trial-ended-seen') || p[2]) return null;
    const u = await requireUser(req), now = Date.now();
    if (p[1] === 'trial-popup') await db().prepare('UPDATE users SET trial_popup_at=? WHERE id=? AND trial_popup_at IS NULL').bind(now, u.id).run();
    else await db().prepare("UPDATE user_grades SET reminded_at=-1 WHERE user_id=? AND source='trial' AND expires_at<=?").bind(u.id, now).run();
    return json({ ok: true });
}

// The manager's '플러스 무료 체험' card: the window, how many members got a trial, how many are in
// one now and how many applied for a grade after it. PUT {end} moves the end (KST time between now
// and 90 days ahead); PUT {close: true, endRunning} closes the window now and, with endRunning, ends
// every running trial too. The start never moves.
async function manageTrial(req: Request) {
    const now = Date.now();
    if (req.method === 'PUT') {
        const b = await body(req);
        const end = b.close === true ? now - 1 : Number(b.end);
        if (b.close !== true && (!Number.isInteger(end) || end < now || end > now + 90 * DAY)) fail(400, '종료일은 지금부터 90일 안으로 정해 주세요.');
        await db().batch([
            // 지금 마감 on a window that already ended keeps the earlier end (it only ends running trials).
            db().prepare(`INSERT INTO settings(key,value,updated_at) VALUES('sys:trial_end',?,?) ON CONFLICT(key) DO UPDATE SET
                value=CASE WHEN ? AND CAST(settings.value AS INTEGER)<CAST(excluded.value AS INTEGER) THEN settings.value ELSE excluded.value END,updated_at=excluded.updated_at`).bind(String(end), now, b.close === true ? 1 : 0),
            ...b.close === true && b.endRunning === true ? [db().prepare("UPDATE user_grades SET expires_at=? WHERE source='trial' AND expires_at>?").bind(now, now)] : [],
        ]);
        clearTrialCache();
    }
    const w = await trialWindow(true);
    const r = await db().prepare(`SELECT (SELECT COUNT(*) FROM users WHERE trial_at>0) AS granted,
        (SELECT COUNT(*) FROM user_grades t WHERE t.source='trial' AND t.expires_at>?
            AND NOT EXISTS(SELECT 1 FROM user_grades g WHERE g.user_id=t.user_id AND g.source='manager' AND g.rank>=1 AND (g.expires_at IS NULL OR g.expires_at>?))) AS active,
        (SELECT COUNT(DISTINCT a.user_id) FROM applications a JOIN users u ON u.id=a.user_id WHERE u.trial_at>0 AND a.kind='grade' AND a.created_at>=u.trial_at) AS applied`).bind(now, now).first<any>();
    return json({
        start: Number.isFinite(w.start) ? w.start : null, end: Number.isFinite(w.end) ? w.end : null, open: trialOpen(w, now),
        granted: r?.granted ?? 0, active: r?.active ?? 0, applied: r?.applied ?? 0,
    });
}

// Only the manager grants grades (the DB triggers in 0009_manager_only refuse any other granted_by).
// A grant fills the 끌올 지갑 to the cap the member has once it is written (the granted grade's, or a
// higher grade the member already holds). It runs only when the grant row was written at this time,
// so a refused grant fills nothing. Expiry and 회수 write nothing: the next read clamps the wallet.
async function walletFill(userId: string, grade: GradeId, by: string, now: number) {
    const r = await db().prepare('SELECT MAX(rank) AS rank FROM user_grades WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)').bind(userId, now).first<{ rank: number | null }>();
    const held = GRADES.find(g => g.rank === Number(r?.rank || 0))?.id || 'normal';
    const bumpMax = Math.max(PERKS[grade].bumpMax, PERKS[held].bumpMax);
    const top = gradeInfo(held).rank > gradeInfo(grade).rank ? held : grade;
    const granted = 'EXISTS(SELECT 1 FROM user_grades WHERE user_id=? AND grade=? AND granted_by=? AND granted_at=?)', grantedArgs = [userId, grade, by, now];
    return {
        bumpMax,
        wallet: db().prepare(`UPDATE users SET bump_tokens=?,bump_at=? WHERE id=? AND ${granted}`).bind(bumpMax, now, userId, ...grantedArgs),
        // 자동 끌올 (WP52) is turned on with the grant: the row and the newest open posts up to the count of
        // the highest grade the member then holds.
        auto: enrolStatements(userId, top, now, granted, grantedArgs, true),
        // 광고 (WP53): the member's newest open posts fill the grade's ad slots at once.
        ads: Array.from({ length: PERKS[top].adSlots }, () => adFillStatement(userId, PERKS[top].adSlots, now, granted, grantedArgs)),
    };
}

// A 6-month grant extends the member's unexpired 6-month row of the same grade by 6 months instead
// of adding a second row, so one 회수 removes the whole period. A grade already held permanently
// is not granted again. The new end date is computed here from the row as read, so the statement
// runs only while that row still ends at the date read (`precondition`); two grants at once then
// cannot both write the same date and lose a paid period. With a guard, the grant is written only
// if that SQL condition holds too when the batch runs.
export async function grantGradeStatements(userId: string, grade: GradeId, plan: PlanId, by: string, applicationId: string | null, now = Date.now(), guard = '1', guardArgs: unknown[] = []) {
    if (by !== MANAGER_ID) fail(403, '등급은 매니저만 지급할 수 있습니다.');
    const info = gradeInfo(grade);
    const wallet = await walletFill(userId, grade, by, now);
    if (await db().prepare('SELECT 1 FROM user_grades WHERE user_id=? AND grade=? AND expires_at IS NULL LIMIT 1').bind(userId, grade).first()) fail(409, '이미 영구 등급입니다.');
    const noPermanent = 'NOT EXISTS(SELECT 1 FROM user_grades WHERE user_id=? AND grade=? AND expires_at IS NULL)';
    if (plan === '6m') {
        // Only paid rows: a running 플러스 체험 row is never extended (user_grades_trial_no_extend).
        const existing = await db().prepare("SELECT id,expires_at FROM user_grades WHERE user_id=? AND grade=? AND expires_at>? AND source='manager' ORDER BY expires_at DESC LIMIT 1").bind(userId, grade, now).first<{ id: number; expires_at: number }>();
        if (existing) {
            const expires = addMonths(existing.expires_at, 6);
            const precondition = `EXISTS(SELECT 1 FROM user_grades WHERE id=? AND expires_at=? AND source='manager') AND ${noPermanent}`, preArgs = [existing.id, existing.expires_at, userId, grade];
            return {
                expires, precondition, preArgs, ...wallet,
                statement: db().prepare(`UPDATE user_grades SET expires_at=?,granted_by=?,granted_at=?,application_id=COALESCE(?,application_id) WHERE id=? AND expires_at=? AND ${noPermanent} AND ${guard}`)
                    .bind(expires, by, now, applicationId, existing.id, existing.expires_at, userId, grade, ...guardArgs),
            };
        }
    }
    const expires = plan === '6m' ? addMonths(now, 6) : null;
    // A new row only while the member still has no permanent row of this grade and, for 6 months,
    // no unexpired 6-month row that should be extended instead.
    const precondition = noPermanent + (plan === '6m' ? " AND NOT EXISTS(SELECT 1 FROM user_grades WHERE user_id=? AND grade=? AND expires_at>? AND source='manager')" : '');
    const preArgs = [userId, grade, ...plan === '6m' ? [userId, grade, now] : []];
    return {
        expires, precondition, preArgs, ...wallet,
        statement: db().prepare(`INSERT INTO user_grades(user_id,grade,rank,expires_at,granted_by,granted_at,application_id) SELECT ?,?,?,?,?,?,? WHERE ${precondition} AND ${guard}`)
            .bind(userId, grade, info.rank, expires, by, now, applicationId, ...preArgs, ...guardArgs),
    };
}

const GRADE_CHANGED = '등급이 방금 바뀌었습니다. 다시 시도해 주세요.';

// Badges too are granted only by the manager account.
function assertBadgeGranter(u: User) {
    if (!(u.id === MANAGER_ID && isManager(u))) fail(403, '인증은 매니저만 지급할 수 있습니다.');
}

function dateLabel(t: number) {
    return new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });
}

async function permanentRank(userId: string) {
    const r = await db().prepare('SELECT MAX(rank) AS rank FROM user_grades WHERE user_id=? AND expires_at IS NULL').bind(userId).first<any>();
    return Number(r?.rank || 0);
}

const DECIDED = 'EXISTS(SELECT 1 FROM applications WHERE id=? AND decision_id=?)';

// The member's chat line for a grade grant, from an approved application or the member panel.
const grantLine = (grade: string, expires: number | null, bumpMax: number) =>
    `${gradeInfo(grade).name} 등급 지급 완료${expires ? ` (${dateLabel(expires)}까지)` : ' (영구)'}\n끌올이 ${bumpMax}개로 충전되었습니다.\n${AUTO_TEXT.grant}`;

// The status change carries a new decision id. The grant and the chat message are
// guarded by that id, so when two decisions overlap only the first one takes effect.
async function decide(u: User, app: any, action: 'approve' | 'reject', note: string) {
    const now = Date.now(), decision = crypto.randomUUID(), args = [app.id, decision];
    // An approved grade is granted in the same batch, so the application changes only while the
    // grant's precondition holds too; otherwise nothing is written and the manager tries again.
    const grant = action === 'approve' && app.kind !== 'badge' ? await grantGradeStatements(app.user_id, app.target, app.plan, u.id, app.id, now, DECIDED, args) : null;
    const statements: D1PreparedStatement[] = [
        db().prepare(`UPDATE applications SET status=?,note=?,decided_by=?,decided_at=?,updated_at=?,decision_id=? WHERE id=? AND status='pending' AND ${grant ? grant.precondition : '1'}`)
            .bind(action === 'approve' ? 'approved' : 'rejected', note, u.id, now, now, decision, app.id, ...grant ? grant.preArgs : []),
    ];
    let message = '';
    if (action === 'approve') {
        if (app.kind === 'badge') {
            assertBadgeGranter(u);
            statements.push(db().prepare(`INSERT OR IGNORE INTO user_badges(user_id,badge,granted_by,granted_at) SELECT ?,?,?,? WHERE ${DECIDED}`).bind(app.user_id, app.target, u.id, now, ...args));
            message = `${badgeInfo(app.target)?.name} 지급 완료`;
        } else {
            statements.push(grant!.statement, grant!.wallet, ...grant!.auto, ...grant!.ads);
            message = grantLine(app.target, grant!.expires, grant!.bumpMax);
        }
    } else {
        message = `반려: ${applicationTitle(app)}${note ? ` (사유: ${note})` : ''}`;
    }
    if (app.conversation_id) statements.push(...guardedMessageStatements(app.conversation_id, u.id, message, 'system', app.id, DECIDED, args, now));
    // 알림함 (WP50): '신청 결과 · 프리미엄 등급 신청 지급 완료' (or '… 반려'), guarded by the same decision.
    statements.push(notifyOne('application', app.user_id, String(app.id), null, u.id, `신청 결과 · ${applicationTitle(app)} ${action === 'approve' ? '지급 완료' : '반려'}`, now, DECIDED, args));
    const r = await db().batch(statements);
    if (!r[0].meta.changes) {
        if (grant && (await db().prepare("SELECT status FROM applications WHERE id=?").bind(app.id).first<{ status: string }>())?.status === 'pending') fail(409, GRADE_CHANGED);
        fail(409, '이미 처리된 신청입니다.');
    }
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
        if (isManager(u)) fail(400, '매니저 계정은 신청할 수 없습니다.');
        requireActive(u);
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
        // Approving and rejecting are the manager's alone, whoever owns the application.
        if ((b.action === 'approve' || b.action === 'reject') && !isManager(u)) fail(403, '매니저만 처리할 수 있습니다.');
        const app = await db().prepare('SELECT * FROM applications WHERE id=?').bind(p[1]).first<any>();
        if (!app || (app.user_id !== u.id && !isManager(u))) fail(404, '신청을 찾을 수 없습니다.');
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
        if (!isManager(u)) fail(403, '매니저만 처리할 수 있습니다.');
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
// manageHandler has already called requireManager; the grant paths check again on their own.
export async function manageMembers(req: Request, u: User, p: string[], url: URL): Promise<Response | null> {
    const method = req.method;
    if (p[1] === 'trial' && !p[2] && (method === 'GET' || method === 'PUT')) {
        requireManager(u);
        return manageTrial(req);
    }
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
        if (filter === 'graded') where.push("EXISTS(SELECT 1 FROM user_grades g WHERE g.user_id=u.id AND (g.expires_at IS NULL OR g.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)))");
        const r = await db().prepare(`SELECT u.id,u.username,u.nickname,u.role,u.created_at,u.suspended_until,${memberColumns('u')},(SELECT COUNT(*) FROM posts WHERE author_id=u.id) AS postCount FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.created_at DESC LIMIT 100`).bind(...values).all();
        return json({ users: r.results.map(({ suspended_until, ...row }: any) => ({ ...withMember(row), suspended: isSuspended(suspended_until) })) });
    }
    if (p[1] === 'users' && p[2]) {
        const target = await db().prepare(`SELECT u.id,u.username,u.nickname,u.role,u.bio,u.created_at,u.deleted_at,u.suspended_until,u.suspend_reason,u.ad_off,${memberColumns('u')} FROM users u WHERE u.id=?`).bind(p[2]).first<any>();
        if (!target) fail(404, '회원을 찾을 수 없습니다.');
        if (!p[3] && method === 'GET') {
            const [grants, badges, apps, sanctions, trades, tradeCounts] = await db().batch([
                db().prepare('SELECT * FROM user_grades WHERE user_id=? ORDER BY granted_at DESC').bind(p[2]),
                db().prepare('SELECT * FROM user_badges WHERE user_id=?').bind(p[2]),
                db().prepare('SELECT * FROM applications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(p[2]),
                db().prepare('SELECT id,days,reason,created_at FROM sanctions WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 20').bind(p[2]),
                // The member's trades (WP23), so the manager can remove one that never happened.
                memberTradesStatement(p[2]),
                memberTradeCountsStatement(p[2]),
            ]);
            // A suspension that has ended reads as none.
            const user = withMember(target);
            if (!isSuspended(user.suspended_until)) { user.suspended_until = null; user.suspend_reason = ''; }
            return json({ user, grants: grants.results, badges: badges.results, applications: apps.results, sanctions: sanctions.results, trades: memberTrades(trades.results), tradeCounts: tradeCounts.results[0] });
        }
        // 이용 정지 {days: 3|7|30|0 (영구) | null (해제), reason}. The manager is never suspended. The member
        // hears about it in their chat with the manager, best-effort: a member who blocked the manager
        // (ensureChat then throws 403) or left is still suspended or cleared.
        if (p[3] === 'suspend' && !p[4] && method === 'POST') {
            requireManager(u);
            const b = await body(req);
            const days: number | null = b.days === null ? null : (SUSPEND_DAYS as readonly unknown[]).includes(b.days) ? b.days : fail(400, '정지 기간을 확인해 주세요.');
            if (target.role === 'manager') fail(400, '매니저 계정은 정지할 수 없습니다.');
            if (days !== null && target.deleted_at) fail(400, WITHDRAWN);
            if (days === null && !isSuspended(target.suspended_until)) fail(409, '이용 정지 중인 회원이 아닙니다.');
            const reason = days === null ? (typeof b.reason === 'string' ? b.reason.trim().slice(0, 100) : '') : textField(b.reason, 2, 100, '정지 사유');
            const now = Date.now(), until = days === null ? null : days === 0 ? SUSPEND_FOREVER : now + days * 86400000;
            await db().batch([
                db().prepare('UPDATE users SET suspended_until=?,suspend_reason=? WHERE id=?').bind(until, days === null ? '' : reason, target.id),
                db().prepare('INSERT INTO sanctions(user_id,days,reason,by_id,created_at) VALUES(?,?,?,?,?)').bind(target.id, days, reason, u.id, now),
            ]);
            const text = days === null ? '이용 정지 해제' : `이용 정지 ${suspendDaysLabel(days)} · 사유: ${reason}`;
            try { await db().batch(messageStatements(await ensureChat(MANAGER_ID, target.id), MANAGER_ID, text, 'system')); }
            catch (e) { console.warn('Suspension notice not sent', e instanceof Error ? e.message : 'unknown'); }
            return json({ ok: true, suspended_until: until });
        }
        // '광고 제외' (WP53): the member's posts are never shown as ads while it is on. The manager only.
        if (p[3] === 'ad-off' && !p[4] && method === 'POST') {
            requireManager(u);
            const b = await body(req);
            if (target.role === 'manager') fail(400, '매니저 계정은 광고에서 제외하지 않습니다.');
            await db().prepare('UPDATE users SET ad_off=? WHERE id=?').bind(b.active ? 1 : 0, target.id).run();
            return json({ ok: true, ad_off: !!b.active });
        }
        if (p[3] === 'badges' && method === 'POST') {
            assertBadgeGranter(u);
            const b = await body(req);
            if (!isBadge(b.badge)) fail(400, '인증 종류를 확인해 주세요.');
            if (b.active && target.deleted_at) fail(400, WITHDRAWN);
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
            if (target.deleted_at) fail(400, WITHDRAWN);
            const now = Date.now();
            const { statement, wallet, auto, ads, expires, bumpMax } = await grantGradeStatements(p[2], b.grade, plan, u.id, null, now);
            // The member hears about a direct grant in the manager chat too, written only when the
            // grant row was written at this time. A member who blocked the manager gets no line.
            const chatId = await ensureChat(p[2], MANAGER_ID).catch(() => null);
            const granted = 'EXISTS(SELECT 1 FROM user_grades WHERE user_id=? AND grade=? AND granted_by=? AND granted_at=?)';
            const line = chatId ? guardedMessageStatements(chatId, u.id, grantLine(b.grade, expires, bumpMax), 'system', null, granted, [p[2], b.grade, u.id, now], now) : [];
            if (!(await db().batch([statement, wallet, ...auto, ...ads, ...line]))[0].meta.changes) fail(409, GRADE_CHANGED);
            return json({ ok: true }, 201);
        }
        // A member who forgot their password gets a temporary one through the manager's chat.
        // It replaces the old password and signs the member out everywhere; it is shown only in this response.
        if (p[3] === 'password' && !p[4] && method === 'POST') {
            if (target.role === 'manager') fail(400, '매니저 계정에는 임시 비밀번호를 발급하지 않습니다.');
            if (target.deleted_at) fail(400, WITHDRAWN);
            const password = tempPassword(), salt = random();
            await db().batch([
                db().prepare('UPDATE users SET password_hash=?,salt=? WHERE id=?').bind(await storedHash(password, salt), salt, target.id),
                db().prepare('DELETE FROM sessions WHERE user_id=?').bind(target.id),
            ]);
            return json({ password });
        }
        // 회수 of an unexpired 6-month row also removes the member's other unexpired 6-month rows of
        // that grade. Earlier code added a row per renewal (0010_stacked_grades_merge folds those),
        // and the previous Worker may still add one while a deploy runs; one 회수 ends the period.
        if (p[3] === 'grades' && p[4] && method === 'DELETE') {
            const now = Date.now();
            const r = await db().prepare('DELETE FROM user_grades WHERE user_id=? AND (id=? OR (expires_at>? AND grade=(SELECT grade FROM user_grades WHERE id=? AND user_id=? AND expires_at>?)))')
                .bind(p[2], p[4], now, p[4], p[2], now).run();
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
