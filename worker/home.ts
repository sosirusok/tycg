import { db, currentUser, json } from './http';
import { categoriesForKind } from '../shared/market';
import { baseFilters, bumpBackfill, decorate, featuredCte, featuredSelect, postSelect, LIST_WINDOW } from './posts';

// The home shelves, in the order Home.tsx shows them. 판매 has category chips (?category=, default
// the first one); the other shelves show every category.
const SHELVES = ['sell', 'buy', 'proxy_offer'] as const;
const SHELF_SIZE = 6;

// GET /api/home (WP42): the whole home page in one request and one batch, instead of five requests.
// Each shelf is the board's first page in 최신순 (active posts in the 30-day window, size 6, no count);
// '추천 매물' is the featured posts of 엘리트 and above; and the 4 newest notices.
export async function homeHandler(req: Request, url: URL) {
    const now = Date.now(), u = await currentUser(req);
    const wanted = url.searchParams.get('category');
    const sellCategory = categoriesForKind('sell').some(c => c.id === wanted) ? wanted! : categoriesForKind('sell')[0].id;
    const base = baseFilters(u, null, now);
    const backfill = bumpBackfill(now);
    const shelf = (kind: string) => {
        const where = [...base.where, 'p.kind=?', "p.status!='closed'", 'p.bumped_at>?'], values = [...base.values, kind, now - LIST_WINDOW];
        if (kind === 'sell') { where.push('p.category=?'); values.push(sellCategory); }
        return db().prepare(`${postSelect} WHERE ${where.join(' AND ')} ORDER BY p.bumped_at DESC,p.id DESC LIMIT ${SHELF_SIZE}`).bind(...values);
    };
    const cte = featuredCte(now);
    const r = (await db().batch([
        ...backfill,
        ...SHELVES.map(shelf),
        db().prepare(`${cte.sql}${featuredSelect} WHERE ${base.where.join(' AND ')} AND s.r>=3 ORDER BY p.bumped_at DESC,p.id DESC LIMIT ${SHELF_SIZE}`).bind(...cte.args, ...base.values),
        db().prepare('SELECT id,title,created_at FROM notices ORDER BY created_at DESC LIMIT 4'),
    ])).slice(backfill.length);
    // One decorate for every post on the page (tags, 찜, price history in one batch).
    const rows = r.slice(0, SHELVES.length + 1).map(x => x.results as any[]);
    const all = await decorate(rows.flat(), u);
    let at = 0;
    const [sell, buy, proxy_offer, featured] = rows.map(list => all.slice(at, at += list.length));
    return json({ shelves: { sell, buy, proxy_offer }, sellCategory, featured, notices: r[SHELVES.length + 1].results });
}
