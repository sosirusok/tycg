import { db, MANAGER_ID } from './http';
import { unused } from './files';
import { deletePhoto } from './storage';
import { ensureChat, messageStatements } from './chat';
import { postTitleKey } from './posts';
import { gradeInfo } from '../shared/membership';

const DAY = 86400000;

// "10월 7일" on the Korean calendar.
const monthDay = (t: number) => new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

// Daily housekeeping (cron in wrangler.jsonc): expired sessions, finished rate-limit
// windows, post events older than the caps look back, posts the previous Worker wrote
// without bumped_at or title_key, grade-end reminders, and photos that no post, chat
// message or draft has used for a day.
export async function cleanup(now = Date.now()) {
    await db().batch([
        db().prepare('DELETE FROM sessions WHERE expires_at<?').bind(now),
        db().prepare('DELETE FROM rate_limits WHERE reset_at<?').bind(now),
        // The daily caps look back to KST midnight and the deleted-title wait at most 6 hours.
        db().prepare('DELETE FROM post_events WHERE created_at<?').bind(now - 2 * DAY),
        db().prepare('UPDATE posts SET bumped_at=created_at WHERE bumped_at=0'),
    ]);
    // SQLite has no NFKC, so the same-title keys of older posts are computed here.
    for (let round = 0; round < 5; round++) {
        const r = await db().prepare("SELECT id,title FROM posts WHERE title_key='' LIMIT 200").all<{ id: number; title: string }>();
        if (r.results.length) await db().batch(r.results.map(p => db().prepare("UPDATE posts SET title_key=? WHERE id=? AND title=? AND title_key=''").bind(postTitleKey(p.title), p.id, p.title)));
        if (r.results.length < 200) break;
    }
    const reminded = await remindGradeEnds(now);
    let removed = 0;
    for (let round = 0; round < 5; round++) {
        const r = await db().prepare(`SELECT id,storage FROM uploads WHERE created_at<? AND ${unused} LIMIT 100`).bind(now - DAY).all<{ id: string; storage: 'r2' | 'd1' }>();
        for (const u of r.results) {
            // The row goes first and only while still unused, so a photo attached meanwhile is kept.
            const d = await db().prepare(`DELETE FROM uploads WHERE id=? AND ${unused}`).bind(u.id).run();
            if (!d.meta.changes) continue;
            await deletePhoto(u.id, u.storage);
            removed++;
        }
        if (r.results.length < 100) break;
    }
    return { removed, reminded };
}

// A 6-month grade that ends within 7 days gets one manager chat message. A renewal moves the end
// date, so the grant is reminded again before the new date. Grants outlived by another grant of the
// same or a higher grade are skipped. Best-effort per member: ensureChat throws when the member
// blocked the manager, and the grant is still marked, so one member never stops the loop or gets
// retried every day.
async function remindGradeEnds(now: number) {
    const r = await db().prepare(`SELECT g.id,g.user_id,g.grade,g.expires_at FROM user_grades g
        WHERE g.expires_at>? AND g.expires_at<=? AND (g.reminded_at IS NULL OR g.reminded_at<g.expires_at-?)
        AND NOT EXISTS(SELECT 1 FROM user_grades o WHERE o.user_id=g.user_id AND o.id!=g.id AND o.rank>=g.rank AND (o.expires_at IS NULL OR o.expires_at>g.expires_at))
        ORDER BY g.expires_at LIMIT 50`).bind(now, now + 7 * DAY, 7 * DAY).all<{ id: number; user_id: string; grade: string; expires_at: number }>();
    let sent = 0;
    for (const g of r.results) {
        try {
            const text = `${gradeInfo(g.grade).name} 등급이 ${monthDay(g.expires_at)}에 끝납니다. 연장은 인증/등급 신청에서 6개월을 다시 신청해 주세요.`;
            await db().batch(messageStatements(await ensureChat(MANAGER_ID, g.user_id), MANAGER_ID, text, 'system'));
            sent++;
        } catch (e) {
            console.warn('Grade reminder not sent', e instanceof Error ? e.message : 'unknown');
        }
        try { await db().prepare('UPDATE user_grades SET reminded_at=? WHERE id=?').bind(now, g.id).run(); }
        catch (e) { console.warn('Grade reminder not marked', e instanceof Error ? e.message : 'unknown'); }
    }
    return sent;
}
