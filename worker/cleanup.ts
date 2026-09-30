import { db } from './http';
import { unused } from './files';
import { deletePhoto } from './storage';

const DAY = 86400000;

// Daily housekeeping (cron in wrangler.jsonc): expired sessions, finished rate-limit
// windows, and photos that no post, chat message or draft has used for a day.
export async function cleanup(now = Date.now()) {
    await db().batch([
        db().prepare('DELETE FROM sessions WHERE expires_at<?').bind(now),
        db().prepare('DELETE FROM rate_limits WHERE reset_at<?').bind(now),
    ]);
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
    return { removed };
}
