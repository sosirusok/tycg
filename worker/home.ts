import { db, currentUser, json } from './http';
import { categoriesForKind } from '../shared/market';
import { baseFilters, bumpBackfill, decorate, postSelect, LIST_WINDOW } from './posts';
import { hash01, homeAdsStatement, pickHome, stripAdRank, ROTATE_MS } from './ads';
import { popupProviders, popupStatement, type ProviderItem } from './providers';

// The home shelves, in the order Home.tsx shows them. 판매 has category chips (?category=, default
// the first one); the other shelves show every category.
const SHELVES = ['sell', 'buy', 'proxy_offer'] as const;
const SHELF_SIZE = 6;

// GET /api/home (WP42): the whole home page in one request and one batch, instead of five requests.
// Each shelf is the board's first page in 최신순 (active posts in the 30-day window, size 6, no count);
// '엘리트 매물' (WP53) is up to 6 ads of 엘리트 and above, one per advertiser, rotated every 10 minutes
// (the home bottom card picks from cardAds: up to 3 other slot posts, never a post of the row); and the
// 4 newest notices.
// The home bottom card (WP53) also shows listed 엘리트 and 관리자 providers of the '중개/가측' tab (WP66): card
// holds up to 6 items, one per member, in an order seeded per 10 minutes where every eligible member (an
// advertiser of cardAds or a provider) weighs the same; a member with more than one item shows one of them.
const CARD_ITEMS = 6;
type CardItem = { post: Record<string, unknown> } | { provider: ProviderItem };
function cardMix(posts: Record<string, any>[], providers: ProviderItem[], now: number): CardItem[] {
    const seed = `${Math.floor(now / ROTATE_MS)}:home-card`, byMember = new Map<string, CardItem[]>();
    const add = (id: string, x: CardItem) => { const list = byMember.get(id); if (list) list.push(x); else byMember.set(id, [x]); };
    for (const p of posts) add(String(p.author_id), { post: p });
    for (const p of providers) add(p.id, { provider: p });
    return [...byMember.entries()].sort((a, b) => hash01(seed + ':' + b[0]) - hash01(seed + ':' + a[0])).slice(0, CARD_ITEMS)
        .map(([id, list]) => list[Math.floor(hash01(seed + ':pick:' + id) * list.length)]);
}

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
        popupStatement(u, now),
    ])).slice(backfill.length);
    // One decorate for every post on the page (tags, 찜, price history in one batch).
    const rows = r.slice(0, SHELVES.length + 1).map(x => x.results as any[]);
    const home = pickHome(rows[SHELVES.length], now);
    rows[SHELVES.length] = stripAdRank(home.row);
    rows.push(stripAdRank(home.card));
    const all = await decorate(rows.flat(), u);
    let at = 0;
    const [sell, buy, proxy_offer, ads, cardAds] = rows.map(list => all.slice(at, at += list.length));
    // cardAds: for the home bottom card only (never a post of the row); card: the same posts mixed with the providers.
    const card = cardMix(cardAds, popupProviders(r[SHELVES.length + 2].results as any[], now), now);
    return json({ shelves: { sell, buy, proxy_offer }, sellCategory, ads, cardAds, card, notices: r[SHELVES.length + 1].results });
}
