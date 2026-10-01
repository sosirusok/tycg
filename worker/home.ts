import { db, currentUser, json } from './http';
import { categoriesForKind } from '../shared/market';
import { baseFilters, bumpBackfill, decorate, postSelect, LIST_WINDOW } from './posts';
import { homeAdsStatement, pickHome, stripAdRank } from './ads';

// The home shelves, in the order Home.tsx shows them. 판매 has category chips (?category=, default
// the first one); the other shelves show every category.
const SHELVES = ['sell', 'buy', 'proxy_offer'] as const;
const SHELF_SIZE = 6;

// GET /api/home (WP42): the whole home page in one request and one batch, instead of five requests.
// Each shelf is the board's first page in 최신순 (active posts in the 30-day window, size 6, no count);
// '엘리트 매물' (WP53) is up to 6 ads of 엘리트 and above, one per advertiser, rotated every 10 minutes
// (the home bottom card picks from the same list); and the 4 newest notices.
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
    const r = (await db().batch([
        ...backfill,
        ...SHELVES.map(shelf),
        homeAdsStatement(u, now),
        db().prepare('SELECT id,title,created_at FROM notices ORDER BY created_at DESC LIMIT 4'),
    ])).slice(backfill.length);
    // One decorate for every post on the page (tags, 찜, price history in one batch).
    const rows = r.slice(0, SHELVES.length + 1).map(x => x.results as any[]);
    rows[SHELVES.length] = stripAdRank(pickHome(rows[SHELVES.length], now));
    const all = await decorate(rows.flat(), u);
    let at = 0;
    const [sell, buy, proxy_offer, ads] = rows.map(list => all.slice(at, at += list.length));
    return json({ shelves: { sell, buy, proxy_offer }, sellCategory, ads, notices: r[SHELVES.length + 1].results });
}
