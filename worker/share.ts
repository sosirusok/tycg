import { db, countedTrade } from './http';
import { KIND_NAMES, categoryName, closedLabel, exchangeLabel, normalizeTrade, priceText } from '../shared/market';

// 공유 (WP59): /p/:id is the address a member shares (Detail '공유'). Workers Static Assets sends /p/*
// here first (run_worker_first in wrangler.jsonc). The answer is the app's own index.html with the post
// in <title> and the og: tags, so KakaoTalk and other link previews (their crawlers read only the HTML)
// show '[판매] 제목', the price line and the 대표 photo; the app then replaces the address with /posts/:id.
// A hidden, deleted or unknown post, and a 대리(진행) post whose author lost 대리 인증, keep the site's
// default tags from index.html. One D1 read per request, nothing written.
const DESCRIPTION_MAX = 80;

type ShareRow = { id: number; kind: string; category: string; title: string; price: number | null; status: string; details: string; images: string; deal_price: number | null };

// What a guest may see, as visiblePost decides for a viewer who is neither the author nor the manager.
const shareRow = (id: number) => db().prepare(`SELECT p.id,p.kind,p.category,p.title,p.price,p.status,p.details,p.images,
        (SELECT t.price FROM trades t WHERE t.post_id=p.id AND ${countedTrade('t')}) AS deal_price
    FROM posts p JOIN users u ON u.id=p.author_id
    WHERE p.id=? AND p.hidden=0 AND u.deleted_at IS NULL
        AND (p.kind!='proxy_offer' OR u.role='manager' OR EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=p.author_id AND b.badge='proxy'))`).bind(id).first<ShareRow>();

const parse = (s: string, fallback: any) => { try { return JSON.parse(s); } catch { return fallback; } };

// The main price item of a post: '즉거가 35만원', 'MAX 30만원', '희망 가격 3만원', or the exchange line.
function priceItem(kind: string, category: string, price: number | null, d: Record<string, string>) {
    if (kind === 'exchange') return exchangeLabel(category, d.wantedCategory);
    if (kind === 'buy') return 'MAX ' + (price === null ? '미정' : priceText(price));
    if (kind === 'sell') return price === null ? '가격 제시' : '즉거가 ' + priceText(price);
    return price === null ? '가격 협의' : (kind === 'proxy_request' ? '희망 가격 ' : '가격 ') + priceText(price);
}

// og:description, at most 80 characters: an open post reads '계정 · 즉거가 35만원 · 현젯 25만원' (or 'MAX 30만원',
// or '계정에서 클랜 구함'); a completed one its closed label, with the 거래가 of a counted trade ('판매완료 ·
// 거래가 25만원') or else the price it was listed at.
export function shareDescription(r: Pick<ShareRow, 'kind' | 'category' | 'price' | 'status' | 'details' | 'deal_price'>) {
    const { kind, category } = normalizeTrade(r.kind, r.category);
    const raw = parse(r.details, {}), d: Record<string, string> = raw && typeof raw === 'object' ? raw : {};
    const items: string[] = [];
    if (r.status === 'closed') {
        items.push(closedLabel(kind), r.deal_price !== null && kind !== 'exchange' ? '거래가 ' + priceText(r.deal_price) : priceItem(kind, category, r.price, d));
    } else if (kind === 'exchange') items.push(priceItem(kind, category, r.price, d));
    else {
        items.push(categoryName(category), priceItem(kind, category, r.price, d));
        const offer = kind === 'sell' ? Number(d.currentOffer) : NaN;
        if (Number.isFinite(offer) && offer > 0) items.push('현젯 ' + priceText(offer));
    }
    const text = items.join(' · ');
    return text.length > DESCRIPTION_MAX ? text.slice(0, DESCRIPTION_MAX - 1) + '…' : text;
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sharePage(req: Request, assets: Fetcher): Promise<Response> {
    const url = new URL(req.url);
    // index.html itself (the single-page-application answer for '/'), asked without the browser's
    // validators: the page sent below differs from the file.
    const page = await assets.fetch(new Request(new URL('/', url).toString(), { method: 'GET' }));
    const m = /^\/p\/(\d{1,12})\/?$/.exec(url.pathname);
    if (!m || !page.ok || !(page.headers.get('content-type') || '').includes('text/html')) return page;
    let row: ShareRow | null = null;
    try { row = await shareRow(Number(m[1])); }
    catch (e) { console.warn('Share tags not read', e instanceof Error ? e.message : 'unknown'); }
    if (!row) return page;
    const { kind } = normalizeTrade(row.kind, row.category);
    const title = `[${KIND_NAMES[kind]}] ${row.title}`, description = shareDescription(row);
    const images = parse(row.images, []), cover = Array.isArray(images) && typeof images[0] === 'string' ? images[0] : '';
    // og:url is the share address; og:image the 대표 (images[0]), served by GET /api/images/:id while the post is public.
    const extra = `<meta property="og:url" content="${attr(`${url.origin}/p/${row.id}`)}" />`
        + (cover ? `<meta property="og:image" content="${attr(`${url.origin}/api/images/${encodeURIComponent(cover)}`)}" />` : '');
    const out = new HTMLRewriter()
        .on('title', { element(e) { e.setInnerContent(title); } })
        .on('meta[property="og:title"]', { element(e) { e.setAttribute('content', title); } })
        .on('meta[property="og:description"]', { element(e) { e.setAttribute('content', description); } })
        .on('meta[name="description"]', { element(e) { e.setAttribute('content', description); } })
        .on('meta[property="og:url"]', { element(e) { e.remove(); } })
        .on('meta[property="og:image"]', { element(e) { e.remove(); } })
        .on('head', { element(e) { e.append(extra, { html: true }); } })
        .transform(page);
    const res = new Response(out.body, out);
    res.headers.delete('ETag');
    res.headers.set('Cache-Control', 'no-cache');
    return res;
}
