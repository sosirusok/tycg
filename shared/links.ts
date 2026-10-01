// 자동 링크 (WP48): one function for the post body, comments and chat, on the Worker and in the app.
// Only http(s) and www. addresses with an ASCII host become links; the visible text is always the
// address itself. Look-alike brand hosts, IP literals, credentials, other ports, local names and the
// manager's blocked domains stay plain text.

export type FoundLink = { start: number; end: number; url: string };
// A link preview card stored on the post (posts.link_cards): url is the normalized address.
export type LinkCard = { url: string; site: string; domain: string; title: string; description: string; image?: string };

export const LINK_MAX = 2000;
// The manager's blocklist (settings 'sys:blocked_link_domains'): one domain per line, at most 200.
export const BLOCKED_DOMAINS_MAX = 200;
export const BLOCKED_LINK_ERROR = '등록할 수 없는 링크가 있습니다.';

// Brand words and the real domains they live on. A host holding the word anywhere else is a look-alike.
const BRANDS: [string, string[]][] = [
    ['kakao', ['kakao.com', 'kakaocorp.com', 'kakaocdn.net', 'kakaopay.com', 'kakaobank.com', 'kakaogames.com']],
    ['naver', ['naver.com', 'naver.me', 'navercorp.com', 'naver.net']],
    ['nexon', ['nexon.com', 'nexon.co.kr', 'nexon.net']],
    ['thecheat', ['thecheat.co.kr']],
    ['toss', ['toss.im', 'toss.me', 'tossbank.com', 'tosspayments.com', 'tossinvest.com']],
    ['youtube', ['youtube.com', 'youtu.be', 'youtube-nocookie.com']],
];

// host is the domain itself or one of its subdomains.
export const onDomain = (host: string, domain: string) => host === domain || host.endsWith('.' + domain);

export function lookalike(host: string) {
    const h = host.toLowerCase();
    return BRANDS.some(([word, real]) => h.includes(word) && !real.some(d => onDomain(h, d)));
}

// One domain per line, lowercased, without a scheme, path or leading '*.' / 'www.'; invalid lines dropped.
export function parseBlockedDomains(raw: string | null | undefined) {
    const out: string[] = [];
    for (const line of (raw || '').split(/\r?\n/)) {
        const d = line.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
        if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && d.length <= 253 && !out.includes(d)) out.push(d);
        if (out.length >= BLOCKED_DOMAINS_MAX) break;
    }
    return out;
}
export const isBlocked = (host: string, blocked: readonly string[]) => blocked.some(d => onDomain(host.toLowerCase(), d));

const IPV4ISH = /^[\d.]+$/;
// A real top-level domain: letters only (punycode TLDs and numbers are refused).
const TLD = /^[a-z]{2,63}$/;

// The production rule for any address a link or a preview fetch may point at. selfHost (the site's
// own host, e.g. '127.0.0.1:8790' locally) is always accepted so the site's own post links work.
export function safeUrl(raw: string, selfHost?: string): URL | null {
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    if (selfHost && u.host === selfHost) return u;
    if (u.port && u.port !== '80' && u.port !== '443') return null;
    const host = u.hostname.toLowerCase();
    if (host.startsWith('[') || IPV4ISH.test(host) || !host.includes('.')) return null;
    const labels = host.split('.');
    if (!TLD.test(labels[labels.length - 1]) || labels.some(l => !l || l.startsWith('xn--'))) return null;
    if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return null;
    return u;
}

// URL characters (RFC 3986) after the scheme; the run ends at the first other character.
const URL_CHAR = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;
const HOST_CHAR = /[A-Za-z0-9.-]/;
const START = /https?:\/\/|www\./gi;
const NON_ASCII_LETTER = /[^\x00-\x7F]/;
const LETTER = /\p{L}/u;

function trimEnd(s: string) {
    for (;;) {
        const last = s[s.length - 1];
        if (!last) return s;
        if (".,;:!?'\"*".includes(last)) { s = s.slice(0, -1); continue; }
        if (last === ')' && s.split('(').length < s.split(')').length) { s = s.slice(0, -1); continue; }
        if (last === ']' && s.split('[').length < s.split(']').length) { s = s.slice(0, -1); continue; }
        return s;
    }
}

export type FindOptions = { blocked?: readonly string[]; selfHost?: string };

// The links in a text, in order. Each one's visible text is text.slice(start, end); url is the
// normalized address (www. gets https://).
export function findLinks(text: string, options: FindOptions = {}): FoundLink[] {
    const out: FoundLink[] = [];
    if (!text) return out;
    START.lastIndex = 0;
    let m: RegExpExecArray | null;
    let from = 0;
    while ((m = START.exec(text))) {
        const start = m.index;
        if (start < from) continue;
        // Inside a word or another address ('xwww.', 'a.www.') is not a start.
        const before = text[start - 1];
        if (before && /[A-Za-z0-9.@/_-]/.test(before)) continue;
        let end = start + m[0].length;
        while (end < text.length && URL_CHAR.test(text[end])) end++;
        const raw = trimEnd(text.slice(start, end));
        end = start + raw.length;
        from = Math.max(end, start + m[0].length);
        START.lastIndex = from;
        if (raw.length <= m[0].length || raw.length > LINK_MAX) continue;
        // The host as written; a non-ASCII letter right after it (a mixed-script host) means no link.
        const hostStart = start + (m[0].toLowerCase() === 'www.' ? 0 : m[0].length);
        let hostEnd = hostStart;
        while (hostEnd < text.length && HOST_CHAR.test(text[hostEnd])) hostEnd++;
        const next = text[hostEnd];
        if (next && NON_ASCII_LETTER.test(next) && LETTER.test(next)) continue;
        if (text.slice(start + m[0].length, end).includes('@')) {
            // user:pass@host (or any @ before the path) is never a link.
            const authority = text.slice(start + m[0].length, end).split(/[/?#]/)[0];
            if (authority.includes('@')) continue;
        }
        const href = m[0].toLowerCase() === 'www.' ? 'https://' + raw : raw;
        const u = safeUrl(href, options.selfHost);
        if (!u) continue;
        const host = u.hostname.toLowerCase();
        if (!(options.selfHost && u.host === options.selfHost) && (lookalike(host) || (options.blocked && isBlocked(host, options.blocked)))) continue;
        out.push({ start, end, url: u.href });
    }
    return out;
}

// Hosts in the text that the blocklist names (the Worker refuses the save when there is any).
export function blockedIn(text: string, blocked: readonly string[], selfHost?: string) {
    if (!blocked.length || !text) return [];
    return findLinks(text, { selfHost }).map(l => new URL(l.url).hostname).filter(h => isBlocked(h, blocked));
}

// The first `max` distinct addresses, in order.
export function distinctLinks(text: string, options: FindOptions = {}, max = 3) {
    const seen: string[] = [];
    for (const l of findLinks(text, options)) if (!seen.includes(l.url)) { seen.push(l.url); if (seen.length >= max) break; }
    return seen;
}

// The site's own post a link points at (/posts/:id or /p/:id), or null.
export function ownPostId(url: string, selfHost: string) {
    try {
        const u = new URL(url);
        if (u.host !== selfHost) return null;
        const m = /^\/(?:posts|p)\/(\d{1,12})\/?$/.exec(u.pathname);
        return m ? Number(m[1]) : null;
    } catch { return null; }
}
