import { db, fail, requireUser, requireManager, json, body, textField, memberColumns, withMember, isSuspended, MANAGER_ID, WITHDRAWN_NAME } from './http';
import { REPORT_REASONS } from '../shared/market';
import { kstDayStart } from '../shared/membership';
import { decorate, endOffersStatements, parse, postSelect, OFFERS_HIDDEN_TEXT } from './posts';
import { ensureChat, messageStatements } from './chat';
import { notifyOne } from './notifications';
import { manageMembers } from './membership';
import { clearBlockedCache } from './unfurl';
import { BLOCKED_DOMAINS_MAX, parseBlockedDomains } from '../shared/links';
import { deleteReview, deleteTrade } from './reviews';
import { manageServices, decideService } from './services';
import { storageMode, counterValue, DB_LIMIT_BYTES, DB_PHOTO_STOP, KV_SITE_BYTES, D1_SITE_BYTES, R2_SITE_BYTES, R2_SITE_DAILY_UPLOADS, R2_WARN_BYTES } from './storage';

// One 신고 row: the reporter's name line, and for a member report the reported member's (탈퇴회원 once
// they left, with whether they are under 이용 정지 now).
function reportRow(row: any) {
    const { target_deleted_at, target_suspended_until, ...rest } = row;
    const out: Record<string, any> = withMember(withMember(rest), 'target_');
    if (!out.target_user_id) {
        for (const key of ['target_nickname', 'target_role', 'target_grade', 'target_grade_expires_at', 'target_grade_trial', 'target_badges']) delete out[key];
        return out;
    }
    delete out.target_grade_expires_at;
    if (target_deleted_at) { out.target_nickname = WITHDRAWN_NAME; out.target_deleted = true; }
    out.target_suspended = isSuspended(target_suspended_until);
    return out;
}

// The photo stores and the database: what each holds, its limit, the day's R2 puts and KV deletes.
async function storageReport() {
    const now = Date.now();
    const r = await db().batch([
        db().prepare('SELECT storage,bytes,rows FROM upload_totals'),
        db().prepare("SELECT key,value FROM settings WHERE key IN ('sys:r2_site_bytes','sys:r2_puts','sys:kv_deletes')"),
        db().prepare('SELECT COUNT(*) AS n FROM kv_trash'),
    ]);
    const totals = new Map((r[0].results as { storage: string; bytes: number; rows: number }[]).map(t => [t.storage, t]));
    const settings = new Map((r[1].results as { key: string; value: string }[]).map(x => [x.key, x.value]));
    const stop = Number(settings.get('sys:r2_site_bytes'));
    const bytes = (s: string) => Number(totals.get(s)?.bytes) || 0;
    return {
        mode: storageMode(), dbBytes: Number(r[2].meta.size_after) || 0, dbLimit: DB_LIMIT_BYTES, dbPhotoStop: DB_PHOTO_STOP,
        r2Bytes: bytes('r2'), r2Limit: stop > 0 ? stop : R2_SITE_BYTES, r2Warn: R2_WARN_BYTES, r2UploadsToday: counterValue(settings.get('sys:r2_puts'), now), r2DailyUploads: R2_SITE_DAILY_UPLOADS,
        // KV holds the keys still waiting in kv_trash too (upload_totals 'kv_trash', 0023).
        kvBytes: bytes('kv') + bytes('kv_trash'), kvLimit: KV_SITE_BYTES, kvTrash: Number((r[2].results[0] as { n: number }).n) || 0, kvDeletesToday: counterValue(settings.get('sys:kv_deletes'), now),
        d1PhotoBytes: bytes('d1'), d1SiteBytes: D1_SITE_BYTES,
    };
}

// Every /api/manage/* route is manager-only: requireManager (role 'manager') runs before any
// route below or in manageMembers. There is no moderator role, and a member's grade, including
// 관리자, grants no access here.
export async function manageHandler(req: Request, p: string[], url: URL): Promise<Response | null> {
    const method = req.method, u = await requireUser(req);
    requireManager(u);
    if (!p[1] && method === 'GET') {
        const r = await db().batch([
            // A member report (WP22) also names the reported member (target_*) and the chat it came from; a 댓글
            // report (WP55) carries the reported text (comment_body) and whether the 댓글 is still up.
            db().prepare(`SELECT r.*,p.title,p.hidden,CASE WHEN r.comment_id IS NOT NULL THEN EXISTS(SELECT 1 FROM comments c WHERE c.id=r.comment_id AND c.deleted_at IS NULL) END AS comment_live,u.nickname,${memberColumns('u')},t.nickname AS target_nickname,t.role AS target_role,t.deleted_at AS target_deleted_at,t.suspended_until AS target_suspended_until,${memberColumns('t', 'target_')}
                FROM reports r LEFT JOIN posts p ON p.id=r.post_id JOIN users u ON u.id=r.reporter_id LEFT JOIN users t ON t.id=r.target_user_id ORDER BY r.created_at DESC LIMIT 100`),
            // Posts hidden by 회원 탈퇴 are not moderation work, so they stay out of 숨긴 글.
            db().prepare(postSelect + " WHERE p.hidden=1 AND p.hidden_reason!='탈퇴' ORDER BY p.updated_at DESC LIMIT 100"),
            db().prepare("SELECT COUNT(*) AS n FROM applications WHERE status='pending'"),
            // 사용량: posts written yesterday (KST) as a relist of the same listing (같은 매물, WP44), on the
            // partial index posts_relist_created (0023).
            db().prepare('SELECT COUNT(*) AS n FROM posts WHERE created_at>=? AND created_at<? AND relist=1').bind(kstDayStart(Date.now()) - 86400000, kstDayStart(Date.now())),
            // The '중개·가측' tab's count (WP65).
            db().prepare("SELECT COUNT(*) AS n FROM service_requests WHERE status='open'"),
            // '자동 끌올 어제 46번 · 지연 120번' (WP52), written by the daily cron.
            db().prepare("SELECT value FROM settings WHERE key='sys:auto_stats'"),
            // The '비밀번호 재설정' tab's count (WP59).
            db().prepare("SELECT COUNT(*) AS n FROM reset_requests WHERE status='pending'"),
        ]);
        let auto: { done: number; delayed: number } | null = null;
        try { const v = JSON.parse((r[5].results[0] as { value: string } | undefined)?.value || 'null'); if (v) auto = { done: Number(v.done) || 0, delayed: Number(v.delayed) || 0 }; } catch { /* none yet */ }
        return json({ reports: r[0].results.map(row => reportRow(row)), hidden: await decorate(r[1].results, u), pendingApplications: (r[2].results[0] as any).n, openServices: (r[4].results[0] as any).n, pendingResets: (r[6].results[0] as any).n,
            usage: { relistsYesterday: (r[3].results[0] as any).n, autoYesterday: auto } });
    }
    // The chat a member report names, read-only, as the evidence: the latest 200 messages with who sent each.
    if (p[1] === 'reports' && p[2] && p[3] === 'messages' && !p[4] && method === 'GET') {
        const report = await db().prepare('SELECT conversation_id FROM reports WHERE id=?').bind(p[2]).first<{ conversation_id: string | null }>();
        if (!report?.conversation_id) fail(404, '신고된 채팅이 없습니다.');
        const r = await db().prepare(`SELECT m.id,m.sender_id,m.body,m.type,m.attachments,m.created_at,s.nickname,s.deleted_at FROM messages m JOIN users s ON s.id=m.sender_id
            WHERE m.conversation_id=? ORDER BY m.id DESC LIMIT 200`).bind(report.conversation_id).all<any>();
        return json({ messages: r.results.reverse().map(({ deleted_at, attachments, ...m }) => ({ ...m, nickname: deleted_at ? WITHDRAWN_NAME : m.nickname, photos: parse(attachments, []).length })) });
    }
    // Hiding keeps updated_at, stores an optional report reason for the author, and ends the post's
    // open offers. Unhiding clears the reason.
    if (p[1] === 'visibility' && method === 'POST') {
        const b = await body(req), hidden = b.hidden ? 1 : 0, reason = hidden && typeof b.reason === 'string' ? b.reason : '';
        if (reason && !(REPORT_REASONS as readonly string[]).includes(reason)) fail(400, '숨김 사유를 확인해 주세요.');
        if (typeof b.postId !== 'number' && typeof b.postId !== 'string') fail(404, '게시글을 찾을 수 없습니다.');
        const post = await db().prepare('SELECT p.id,p.author_id,p.title,p.hidden,p.hidden_reason,u.deleted_at FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=?').bind(b.postId).first<any>();
        if (!post) fail(404, '게시글을 찾을 수 없습니다.');
        // A post hidden by 회원 탈퇴 stays hidden, and its '탈퇴' reason is never overwritten.
        if (post.deleted_at || post.hidden_reason === '탈퇴') fail(409, '탈퇴한 회원의 글입니다.');
        const now = Date.now();
        await db().batch([
            db().prepare('UPDATE posts SET hidden=?,hidden_reason=? WHERE id=?').bind(hidden, reason, post.id),
            ...hidden ? endOffersStatements(post.id, post.author_id, "status IN('pending','accepted')", [], now, OFFERS_HIDDEN_TEXT) : [],
            // 알림함 (WP50): the author's row, only when this request hides a visible post.
            ...hidden && !post.hidden ? [notifyOne('hidden', post.author_id, String(post.id), post.id, u.id, `‘${post.title}’ 글이 숨김 처리되었습니다.${reason ? ' 사유: ' + reason : ''}`, now)] : [],
        ]);
        // The author hears about it in their chat with the manager. Best-effort: the author may have
        // blocked the manager (ensureChat then throws 403), and a failed notice never undoes the change.
        if (post.author_id !== MANAGER_ID && post.hidden !== hidden) {
            const text = hidden ? `‘${post.title}’ 글이 숨김 처리되었습니다.${reason ? ' 사유: ' + reason : ''}` : `‘${post.title}’ 글이 다시 공개되었습니다.`;
            try { await db().batch(messageStatements(await ensureChat(MANAGER_ID, post.author_id), MANAGER_ID, text, 'system')); }
            catch (e) { console.warn('Hide notice not sent', e instanceof Error ? e.message : 'unknown'); }
        }
        return json({ ok: true });
    }
    // 사용량 (WP45): the database size and the photo stores, for the Manage card.
    if (p[1] === 'storage' && !p[2] && method === 'GET') return json(await storageReport());
    // The R2 stop the manager can move (settings 'sys:r2_site_bytes'), in whole GB.
    if (p[1] === 'storage' && !p[2] && method === 'PUT') {
        const b = await body(req), gb = Number(b.r2LimitGB);
        if (!Number.isInteger(gb) || gb < 1 || gb > 1000) fail(400, '사진 저장 한도: 1~1000GB로 입력해 주세요.');
        await db().prepare("INSERT INTO settings(key,value,updated_at) VALUES('sys:r2_site_bytes',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
            .bind(String(gb * 1024 ** 3), Date.now()).run();
        return json(await storageReport());
    }
    // 링크 차단 (WP48): settings 'sys:blocked_link_domains', one domain per line (at most 200), edited in
    // 설정. Saving normalizes the lines (no scheme, path, 'www.' or '*.'); invalid lines are dropped.
    if (p[1] === 'links' && !p[2] && method === 'GET') {
        return json({ domains: parseBlockedDomains((await db().prepare("SELECT value FROM settings WHERE key='sys:blocked_link_domains'").first<{ value: string }>())?.value), max: BLOCKED_DOMAINS_MAX });
    }
    if (p[1] === 'links' && !p[2] && method === 'PUT') {
        const b = await body(req);
        if (typeof b.domains !== 'string' || b.domains.length > 20000) fail(400, '차단 주소: 확인해 주세요.');
        if (b.domains.split(/\r?\n/).filter((l: string) => l.trim()).length > BLOCKED_DOMAINS_MAX) fail(400, `차단 주소는 ${BLOCKED_DOMAINS_MAX}개까지입니다.`);
        const domains = parseBlockedDomains(b.domains);
        await db().prepare("INSERT INTO settings(key,value,updated_at) VALUES('sys:blocked_link_domains',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
            .bind(domains.join('\n'), Date.now()).run();
        clearBlockedCache();
        return json({ domains, max: BLOCKED_DOMAINS_MAX });
    }
    // 중개·가측 신청 (WP65): the open list by grade priority, and the manager's 완료 / 취소.
    if (p[1] === 'services' && !p[2] && method === 'GET') return manageServices(url);
    if (p[1] === 'services' && p[2] && !p[3] && method === 'PATCH') return decideService(req, u, p[2]);
    // A 후기 or a whole trade the manager removes (WP23), from the member panel.
    if (p[1] === 'reviews' && p[2] && !p[3] && method === 'DELETE') return deleteReview(p[2]);
    if (p[1] === 'trades' && p[2] && !p[3] && method === 'DELETE') return deleteTrade(p[2]);
    if (p[1] === 'report' && method === 'POST') {
        const b = await body(req);
        await db().prepare('UPDATE reports SET status=? WHERE id=?').bind(b.status === 'pending' ? 'pending' : 'resolved', b.id).run();
        return json({ ok: true });
    }
    if (p[1] === 'notice') {
        if (method === 'DELETE' && p[2]) {
            await db().prepare('DELETE FROM notices WHERE id=?').bind(p[2]).run();
            return json({ ok: true });
        }
        if (method === 'POST' || method === 'PUT') {
            const b = await body(req), title = textField(b.title, 2, 100, '공지 제목'), content = textField(b.body, 1, 10000, '공지 내용');
            if (method === 'PUT' && p[2]) await db().prepare('UPDATE notices SET title=?,body=?,updated_at=? WHERE id=?').bind(title, content, Date.now(), p[2]).run();
            else await db().prepare('INSERT INTO notices(title,body,created_at,updated_at) VALUES(?,?,?,?)').bind(title, content, Date.now(), Date.now()).run();
            return json({ ok: true });
        }
    }
    // 비밀번호 재설정 (WP59): the pending 비밀번호 찾기 requests, newest first, each with the member the id
    // names (none: '회원 없음'; a member who left counts as none) and whether they hold 본인 인증. The
    // manager issues a temporary password (POST manage/users/:id/password) and marks the request done.
    if (p[1] === 'reset-requests' && !p[2] && method === 'GET') {
        const r = await db().prepare(`SELECT r.id,r.username,r.contact,r.created_at,m.id AS user_id,m.nickname,m.role,
                EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=m.id AND b.badge='identity') AS identity
            FROM reset_requests r LEFT JOIN users m ON m.username=r.username AND m.deleted_at IS NULL
            WHERE r.status='pending' ORDER BY r.created_at DESC LIMIT 100`).all<any>();
        return json({ requests: r.results.map(row => ({ ...row, identity: !!row.identity })) });
    }
    if (p[1] === 'reset-requests' && p[2] && !p[3] && method === 'PATCH') {
        const r = await db().prepare("UPDATE reset_requests SET status='done',done_at=? WHERE id=? AND status='pending'").bind(Date.now(), p[2]).run();
        if (!r.meta.changes) fail(404, '요청을 찾을 수 없습니다.');
        return json({ ok: true });
    }
    // '프로필 사진 삭제' (WP59) from the member panel; the photo then falls to the unused-photo cleanup.
    if (p[1] === 'users' && p[2] && p[3] === 'avatar' && !p[4] && method === 'DELETE') {
        await db().prepare('UPDATE users SET avatar_id=NULL,avatar_thumb=NULL WHERE id=?').bind(p[2]).run();
        return json({ ok: true });
    }
    return manageMembers(req, u, p, url);
}
