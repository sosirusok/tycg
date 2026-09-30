import { db, requireUser, json } from './http';
import { perksOf, kstDayStart, type Perks } from '../shared/membership';

const DAY = 86400000;

// The member's grade benefits and how much of them is used today, for the counters on the detail
// page, the editor and 내 글 ('오늘 끌올 2/6', '거래중 글 4/20', '상단 노출 1/1').
// Unlimited values (the manager) are null.
export async function usageHandler(req: Request) {
    const u = await requireUser(req), perks = perksOf(u), now = Date.now(), dayStart = kstDayStart(now);
    const [counts, featured] = await db().batch([
        db().prepare(`SELECT (SELECT COUNT(*) FROM post_events WHERE user_id=? AND kind='bump' AND created_at>=?) AS bumps,
            (SELECT COUNT(*) FROM post_events WHERE user_id=? AND kind='post' AND created_at>=?) AS posts,
            (SELECT COUNT(*) FROM posts WHERE author_id=? AND status!='closed') AS open`).bind(u.id, dayStart, u.id, dayStart, u.id),
        db().prepare("SELECT id,title,kind FROM posts WHERE author_id=? AND featured_at IS NOT NULL AND status!='closed' ORDER BY featured_at DESC").bind(u.id),
    ]);
    const c = counts.results[0] as { bumps: number; posts: number; open: number };
    const limits = Object.fromEntries(Object.entries(perks).map(([k, v]) => [k, v === Infinity ? null : v])) as { [K in keyof Perks]: Perks[K] | null };
    return json({
        grade: u.grade, perks: limits,
        bumpsToday: c.bumps, bumpsLeft: Number.isFinite(perks.bumpsPerDay) ? Math.max(0, perks.bumpsPerDay - c.bumps) : null, resetAt: dayStart + DAY,
        openPosts: c.open, postsToday: c.posts, featured: featured.results,
    });
}
