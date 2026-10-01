import { db, requireUser, json } from './http';
import { perksOf, rulesOf, kstDayStart } from '../shared/membership';
import { FEATURED_MINE, walletJson } from './posts';

// Unlimited values (the manager) become null.
const finite = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === Infinity ? null : v])) as { [K in keyof T]: T[K] | null };

// The member's grade benefits, the cafe rules every member shares and what is used now, for the
// 끌올 gauge ('끌올 3/4 · 1:20 후 충전') on the detail page, the editor, 내 글 and the profile.
export async function usageHandler(req: Request) {
    const u = await requireUser(req), perks = perksOf(u), now = Date.now(), dayStart = kstDayStart(now);
    const [counts, featured] = await db().batch([
        db().prepare(`SELECT u.bump_tokens,u.bump_at,
            (SELECT COUNT(*) FROM post_events WHERE user_id=u.id AND kind='post' AND created_at>=?) AS posts,
            (SELECT COUNT(*) FROM posts WHERE author_id=u.id AND status!='closed') AS open FROM users u WHERE u.id=?`).bind(dayStart, u.id),
        db().prepare(`SELECT id,title,kind FROM posts WHERE ${FEATURED_MINE} ORDER BY featured_at DESC`).bind(u.id),
    ]);
    const c = counts.results[0] as { bump_tokens: number; bump_at: number; posts: number; open: number };
    return json({
        grade: u.grade, perks: finite(perks), rules: finite(rulesOf(u)),
        ...walletJson(c, perks, now),
        openPosts: c.open, postsToday: c.posts, featured: featured.results,
    });
}
