import { db, requireUser, json } from './http';
import { perksOf, rulesOf, kstDayStart } from '../shared/membership';
import { FEATURED_MINE, walletJson } from './posts';
import { photoBytesSql } from './files';
import { storageMode, userLimit } from './storage';

// Unlimited values (the manager) become null.
const finite = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === Infinity ? null : v])) as { [K in keyof T]: T[K] | null };

// The member's grade benefits, the cafe rules every member shares and what is used now, for the
// 끌올 gauge ('끌올 3/4 · 1:20 후 충전') on the detail page, the editor, 내 글 and the profile.
export async function usageHandler(req: Request) {
    const u = await requireUser(req), perks = perksOf(u), now = Date.now(), dayStart = kstDayStart(now), mode = storageMode();
    const [counts, featured] = await db().batch([
        db().prepare(`SELECT u.bump_tokens,u.bump_at,
            (SELECT COUNT(*) FROM post_events WHERE user_id=u.id AND kind='post' AND created_at>=?) AS posts,
            (SELECT COUNT(*) FROM post_events WHERE user_id=u.id AND kind='fresh' AND created_at>=?) AS fresh,
            (SELECT COUNT(*) FROM posts WHERE author_id=u.id AND status!='closed') AS open,
            (SELECT COUNT(*) FROM post_auto pa JOIN posts q ON q.id=pa.post_id WHERE pa.user_id=u.id AND pa.bump=1 AND q.status!='closed' AND q.hidden=0) AS auto_on,
            (SELECT bump_on FROM automation WHERE user_id=u.id) AS auto_switch,${photoBytesSql(mode)} AS photo_bytes FROM users u WHERE u.id=?`).bind(dayStart, dayStart, u.id),
        db().prepare(`SELECT id,title,kind FROM posts WHERE ${FEATURED_MINE} ORDER BY featured_at DESC`).bind(u.id),
    ]);
    const c = counts.results[0] as { bump_tokens: number; bump_at: number; posts: number; fresh: number; open: number; auto_on: number; auto_switch: number | null; photo_bytes: number };
    // The editor's '사진 용량 12.3MB/100MB' (KV and D1 only; the same as GET uploads/usage).
    const photos = { storage: mode, used: Number(c.photo_bytes) || 0, limit: u.role === 'manager' ? null : userLimit(mode) };
    // 자동 끌올 (WP61 final shape): autoEveryMinutes is null without 자동 끌올, and autoBump is the profile's
    // '자동 끌올 3/5' (the member's listed open posts, max null for every post; enabled: the 자동 끌올 switch).
    const auto = perks.autoBumpPosts ? { on: Number(c.auto_on) || 0, max: Number.isFinite(perks.autoBumpPosts) ? perks.autoBumpPosts : null, enabled: c.auto_switch === null || !!c.auto_switch } : null;
    return json({
        grade: u.grade, perks: { ...finite(perks), autoEveryMinutes: perks.autoBumpPosts ? perks.autoEveryMinutes : null }, rules: finite(rulesOf(u)),
        ...walletJson(c, perks, now),
        openPosts: c.open, postsToday: c.posts, freshToday: c.fresh, featured: featured.results, photos, autoBump: auto,
    });
}
