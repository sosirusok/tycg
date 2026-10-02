import { env, waitUntil } from 'cloudflare:workers';
import { ApiError, db, fail, limit, setting } from './http';
import { KIND_NAMES, categoryName, listingPrice, type TradeKind } from '../shared/market';
import { linkPreviewAllowed } from '../shared/membership';
import {
    BLOCKED_LINK_ERROR, blockedIn, distinctLinks, findLinks, isBlocked, lookalike, onDomain, ownPostId, parseBlockedDomains, safeUrl, type LinkCard,
} from '../shared/links';

// 링크 미리보기 (WP48). Cards are built only when a post is saved (POST and PUT /posts) by a 플러스 or
// higher author with the post's switch on, for the first 3 distinct addresses, and stored on the post
// (posts.link_cards), so readers cost no extra request. There is no public unfurl endpoint, no
// view-time fetch and no image proxy: card images come only from i.ytimg.com and *.kakaocdn.net.

const HOUR = 3600000, DAY = 24 * HOUR;
const OK_TTL = 7 * DAY, FAIL_TTL = DAY;
const MAX_CARDS = 3;
// Each address costs at most 3 fetches (the first request and 2 redirects), so a save makes at most 9
// subrequests, under the Workers Free 50.
const MAX_HOPS = 3;
const HEAD_BYTES = 64 * 1024;
const SAVE_WAIT_MS = 2500;
const UA = 'ZombiegoMarketPreview/1.0';
const SITE_NAME = '좀비고 거래소';

// The manager's blocklist (settings 'sys:blocked_link_domains'), cached for 60 s per isolate; the
// manager's save clears it.
let blockedCache: { list: string[]; at: number } | null = null;
export function clearBlockedCache() { blockedCache = null; }
export async function blockedDomains(): Promise<string[]> {
    const now = Date.now();
    if (blockedCache && now - blockedCache.at < 60000) return blockedCache.list;
    const list = parseBlockedDomains(await setting('sys:blocked_link_domains'));
    blockedCache = { list, at: now };
    return list;
}

export const selfHostOf = (req: Request) => new URL(req.url).host;

// 400 '등록할 수 없는 링크가 있습니다.' when any text links a blocked host (posts, comments, chat).
export async function assertNoBlockedLinks(req: Request, ...texts: (string | null | undefined)[]) {
    if (!texts.some(t => t && /https?:\/\/|www\./i.test(t))) return;
    const blocked = await blockedDomains();
    if (!blocked.length) return;
    if (texts.some(t => t && blockedIn(t, blocked, selfHostOf(req)).length)) fail(400, BLOCKED_LINK_ERROR);
}

// true when the text links a blocked host (the automatic chat answers skip themselves instead of failing
// the member's message, so a domain blocked later also stops texts already saved).
export async function hasBlockedLinks(req: Request, text: string) {
    if (!/https?:\/\/|www\./i.test(text)) return false;
    const blocked = await blockedDomains();
    return blocked.length > 0 && blockedIn(text, blocked, selfHostOf(req)).length > 0;
}

// The cards GET /posts/:id returns: only while the author's current grade allows previews and the
// post's switch is on, and only cards whose address still occurs (as a live link) in the body. Cards of
// this site's own posts are rebuilt from the linked posts now (one read of at most 3 ids), so a post that
// was hidden or that others cannot open drops its card, and the title and price are current.
export async function shownCards(req: Request, post: { body: string; link_preview?: number | null; link_cards?: string | null }, grade: string | null | undefined, role: string | null | undefined): Promise<LinkCard[]> {
    if (!linkPreviewAllowed(grade, role) || post.link_preview === 0 || !post.link_cards || post.link_cards === '[]') return [];
    let cards: unknown;
    try { cards = JSON.parse(post.link_cards); } catch { return []; }
    if (!Array.isArray(cards) || !cards.length) return [];
    const selfHost = selfHostOf(req);
    const live = new Set(findLinks(post.body, { blocked: await blockedDomains(), selfHost }).map(l => l.url));
    const kept = (cards as LinkCard[]).filter(c => c && typeof c.url === 'string' && live.has(c.url)).slice(0, MAX_CARDS);
    const ownIds = kept.map(c => ownPostId(c.url, selfHost)).filter((id): id is number => id !== null);
    if (!ownIds.length) return kept;
    const rows = await ownPostRows(ownIds);
    return kept.flatMap(c => {
        const id = ownPostId(c.url, selfHost);
        if (id === null) return [c];
        const row = rows.get(id);
        return row ? [{ ...ownCard(row, new URL(c.url)), url: c.url }] : [];
    });
}

// ---- Text cleanup -------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d' };
function decodeEntities(s: string) {
    return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, e: string) => {
        if (e[0] === '#') {
            const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
        }
        return ENTITIES[e.toLowerCase()] ?? all;
    });
}
// Entities decoded, line breaks to spaces, control and bidi characters removed, clamped in code points.
export function cleanText(raw: string | null | undefined, max: number) {
    if (!raw) return '';
    const s = decodeEntities(raw).replace(/[\r\n\t]+/g, ' ').replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    return chars.length > max ? chars.slice(0, max).join('').trimEnd() : s;
}

const domainOf = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, '');
const imageAllowed = (u: URL) => u.protocol === 'https:' && (u.hostname === 'i.ytimg.com' || u.hostname.endsWith('.kakaocdn.net'));

// ---- HTML head parsing ------------------------------------------------------------------------

function attributes(tag: string) {
    const out: Record<string, string> = {};
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tag))) {
        const k = m[1].toLowerCase();
        if (!(k in out)) out[k] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return out;
}

// og:title, og:description, og:site_name, og:image and <title> from the head (regex only, no DOM).
export function parseHead(head: string, page: URL): LinkCard | null {
    const meta: Record<string, string> = {};
    for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
        const a = attributes(m[0]);
        const key = (a.property || a.name || '').toLowerCase();
        if (['og:title', 'og:description', 'og:site_name', 'og:image', 'description'].includes(key) && !(key in meta) && typeof a.content === 'string') meta[key] = a.content;
    }
    const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
    const title = cleanText(meta['og:title'] || titleTag, 100);
    if (!title) return null;
    let image: string | undefined;
    if (meta['og:image']) {
        try {
            const u = new URL(decodeEntities(meta['og:image']).trim(), page);
            if (imageAllowed(u) && u.href.length <= 1000) image = u.href;
        } catch { /* no image */ }
    }
    return {
        url: '', site: cleanText(meta['og:site_name'], 40) || domainOf(page), domain: domainOf(page), title,
        description: cleanText(meta['og:description'] || meta.description, 160), ...image ? { image } : {},
    };
}

// ---- Fetching ---------------------------------------------------------------------------------

type FetchContext = { selfHost: string; testOrigin: string | null; blocked: readonly string[] };

// Test only: PREVIEW_TEST_ORIGIN sends every preview fetch to a local fixture server
// (<origin>/<host><path>), and only for saves served on 127.0.0.1. The address checks and the redirect
// rules stay the production ones.
function testOrigin(req: Request) {
    const origin = (env as Partial<Env>).PREVIEW_TEST_ORIGIN;
    return origin && new URL(req.url).hostname === '127.0.0.1' ? origin.replace(/\/+$/, '') : null;
}
const target = (u: URL, c: FetchContext) => c.testOrigin ? `${c.testOrigin}/${u.hostname}${u.pathname}${u.search}` : u.href;

// Reads at most `max` bytes as UTF-8, stopping early once `stop` (lowercase) appears.
async function readLimited(res: Response, max: number, stop?: string) {
    const reader = res.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder('utf-8');
    let text = '', size = 0;
    try {
        while (size < max) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = value.byteLength > max - size ? value.subarray(0, max - size) : value;
            size += chunk.byteLength;
            text += decoder.decode(chunk, { stream: true });
            if (stop && text.toLowerCase().includes(stop)) break;
        }
        text += decoder.decode();
    } finally { reader.cancel().catch(() => {}); }
    return text;
}

const REDIRECTS = [301, 302, 303, 307, 308];

// One address, with manual redirects: every hop is checked again with the production rule (never to
// an IP, a local name, another port, a look-alike, a blocked host or the site's own host).
async function fetchPage(start: URL, c: FetchContext, accept: string): Promise<{ res: Response; url: URL } | null> {
    let url = start;
    const selfName = c.selfHost.split(':')[0].toLowerCase();
    for (let hop = 0; hop < MAX_HOPS; hop++) {
        const res = await fetch(target(url, c), { redirect: 'manual', signal: AbortSignal.timeout(3000), headers: { 'User-Agent': UA, Accept: accept } });
        if (REDIRECTS.includes(res.status)) {
            res.body?.cancel().catch(() => {});
            const location = res.headers.get('location');
            if (!location) return null;
            let next: URL | null;
            try { next = safeUrl(new URL(location, url).href); } catch { next = null; }
            if (!next) return null;
            const host = next.hostname.toLowerCase();
            if (host === selfName || lookalike(host) || isBlocked(host, c.blocked)) return null;
            url = next;
            continue;
        }
        if (!res.ok) { res.body?.cancel().catch(() => {}); return null; }
        return { res, url };
    }
    return null;
}

async function fetchCard(start: URL, c: FetchContext): Promise<LinkCard | null> {
    const page = await fetchPage(start, c, 'text/html');
    if (!page) return null;
    const type = page.res.headers.get('content-type') || '';
    const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(type)?.[1];
    if (!/^\s*text\/html\b/i.test(type) || (charset && !/^utf-?8$/i.test(charset))) { page.res.body?.cancel().catch(() => {}); return null; }
    const head = await readLimited(page.res, HEAD_BYTES, '</head>');
    const declared = /<meta\b[^>]*charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1];
    if (declared && !/^utf-?8$/i.test(declared)) return null;
    const card = parseHead(head, page.url);
    if (!card) return null;
    if (onDomain(domainOf(start), 'open.kakao.com')) card.site = '카카오톡 오픈채팅';
    return card;
}

function youtubeId(u: URL) {
    const host = u.hostname.toLowerCase();
    let id: string | null = null;
    if (host === 'youtu.be') id = u.pathname.split('/')[1] || null;
    else if (onDomain(host, 'youtube.com')) id = u.pathname === '/watch' ? u.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([^/]+)/.exec(u.pathname)?.[1] || null;
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

async function youtubeCard(id: string, c: FetchContext): Promise<LinkCard | null> {
    const watch = 'https://www.youtube.com/watch?v=' + id;
    const page = await fetchPage(new URL('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(watch)), c, 'application/json');
    if (!page) return null;
    let data: any;
    try { data = JSON.parse(await readLimited(page.res, HEAD_BYTES)); } catch { return null; }
    const title = cleanText(typeof data?.title === 'string' ? data.title : '', 100);
    if (!title) return null;
    return { url: '', site: 'YouTube', domain: 'youtube.com', title, description: cleanText(typeof data.author_name === 'string' ? data.author_name : '', 160), image: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` };
}

// The site's own post, from the database (no fetch). A hidden or missing post gives no card.
// The own posts a card may show: those every member can open (visiblePost without the author's and the
// manager's own view): not hidden, the author not withdrawn, and a 대리(진행) post only while its author
// keeps 대리 인증.
type OwnRow = { id: number; title: string; kind: TradeKind; category: string; price: number | null; price_mode: string };
async function ownPostRows(ids: number[]): Promise<Map<number, OwnRow>> {
    const r = await db().prepare(`SELECT p.id,p.title,p.kind,p.category,p.price,p.price_mode FROM posts p JOIN users a ON a.id=p.author_id
        WHERE p.id IN (SELECT value FROM json_each(?)) AND p.hidden=0 AND a.deleted_at IS NULL
            AND (p.kind!='proxy_offer' OR a.role='manager' OR EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=a.id AND b.badge='proxy'))`)
        .bind(JSON.stringify([...new Set(ids)])).all<OwnRow>();
    return new Map(r.results.map(p => [Number(p.id), p]));
}
function ownCard(p: OwnRow, u: URL): LinkCard {
    const label = `${KIND_NAMES[p.kind] || '거래'} · ${categoryName(p.category)}`;
    return { url: '', site: SITE_NAME, domain: domainOf(u), title: cleanText(p.title, 100), description: p.kind === 'exchange' ? label : `${label} · ${listingPrice(p)}` };
}
async function ownPostCard(id: number, u: URL): Promise<LinkCard | null> {
    const p = (await ownPostRows([id])).get(id);
    return p ? ownCard(p, u) : null;
}

const isNaverCafe = (host: string) => host === 'naver.me' || host === 'cafe.naver.com' || host === 'm.cafe.naver.com';

// ---- Save-time build --------------------------------------------------------------------------

type CacheRow = { url: string; card: string; ok: number; fetched_at: number };

// Runs after POST or PUT /posts saved the post: builds the cards and stores them with
// UPDATE … WHERE id=? AND body=? (a later edit of the body wins). The save waits at most 2.5 s; the rest
// finishes in waitUntil. Never fails the save.
export async function unfurlOnSave(req: Request, postId: number, body: string, author: { id: string; grade?: string | null; role?: string | null }, linkPreview: boolean) {
    if (!linkPreview || !linkPreviewAllowed(author.grade, author.role)) return;
    if (!/https?:\/\/|www\./i.test(body)) return;
    const work = buildCards(req, postId, body, author.id).catch(e => console.warn('Link preview failed', e instanceof Error ? e.message : 'unknown'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([work.then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), SAVE_WAIT_MS); })]);
    if (timer !== undefined) clearTimeout(timer);
    if (!waited) {
        try { waitUntil(work); } catch { /* no execution context: the request already waited */ }
    }
}

async function buildCards(req: Request, postId: number, body: string, authorId: string) {
    const c: FetchContext = { selfHost: selfHostOf(req), testOrigin: testOrigin(req), blocked: await blockedDomains() };
    const urls = distinctLinks(body, { blocked: c.blocked, selfHost: c.selfHost }, MAX_CARDS);
    if (!urls.length) return;
    const now = Date.now();
    const cached = (await db().prepare('SELECT url,card,ok,fetched_at FROM link_cache WHERE url IN (SELECT value FROM json_each(?))').bind(JSON.stringify(urls)).all<CacheRow>()).results;
    const writes: { url: string; card: LinkCard | null }[] = [];
    const cards = await Promise.all(urls.map(async (url): Promise<LinkCard | null> => {
        const u = new URL(url), host = u.hostname.toLowerCase();
        const own = ownPostId(url, c.selfHost);
        if (own !== null) return withUrl(await ownPostCard(own, u), url);
        if (u.host === c.selfHost) return null;
        if (isNaverCafe(host)) return { url, site: '네이버 카페', domain: host, title: '네이버 카페 글', description: '' };
        const hit = cached.find(r => r.url === url);
        if (hit && now - hit.fetched_at < (hit.ok ? OK_TTL : FAIL_TTL)) {
            if (!hit.ok) return null;
            try { return withUrl(JSON.parse(hit.card), url); } catch { /* fetch again */ }
        }
        // Cache misses only: 30 per post and 30 per member an hour (a member editing many posts, or changing
        // a query string to miss the cache), then the card is skipped silently.
        try { await limit('unfurl:' + postId, 30, HOUR); await limit('unfurl-user:' + authorId, 30, HOUR); }
        catch (e) { if (e instanceof ApiError && e.status === 429) return null; throw e; }
        let card: LinkCard | null = null;
        try {
            const yt = youtubeId(u);
            card = yt ? await youtubeCard(yt, c) : await fetchCard(u, c);
        } catch { card = null; }
        writes.push({ url, card });
        return withUrl(card, url);
    }));
    const kept = cards.filter((x): x is LinkCard => !!x);
    const at = Date.now();
    await db().batch([
        ...writes.map(w => db().prepare('INSERT INTO link_cache(url,card,ok,fetched_at) VALUES(?,?,?,?) ON CONFLICT(url) DO UPDATE SET card=excluded.card,ok=excluded.ok,fetched_at=excluded.fetched_at')
            .bind(w.url, w.card ? JSON.stringify({ ...w.card, url: undefined }) : '{}', w.card ? 1 : 0, at)),
        db().prepare('UPDATE posts SET link_cards=? WHERE id=? AND body=?').bind(JSON.stringify(kept), postId, body),
    ]);
}

function withUrl(card: LinkCard | null, url: string): LinkCard | null {
    if (!card || typeof card !== 'object' || typeof card.title !== 'string') return null;
    return { url, site: String(card.site || ''), domain: String(card.domain || ''), title: card.title, description: String(card.description || ''), ...card.image ? { image: String(card.image) } : {} };
}
