import { Fragment, type ReactNode } from 'react';
import { findLinks, type LinkCard as Card } from '../../shared/links';
import type { Mark } from '../../shared/richtext';
import { navigate } from '../lib/router';
import { useApp } from '../app/state';
import { LinkCard, inAppPath } from './LinkCard';

// 글자 꾸미기 (WP49): each code is one fixed class (pages.css); 가운데 정렬 is a block per line. Links keep
// their own color, so 글자색 and 배경 강조 do not apply inside them.
const LINK_IGNORED = new Set(['c1', 'c2', 'c3', 'h']);

// [from, to) of the body, split where a mark starts or ends; a piece with marks is a span with their classes.
function pieces(text: string, from: number, to: number, marks: Mark[], inLink: boolean, key: string): ReactNode[] {
    if (!marks.length) return [text.slice(from, to)];
    const cuts = new Set([from, to]);
    for (const [a, b] of marks) { if (a > from && a < to) cuts.add(a); if (b > from && b < to) cuts.add(b); }
    const points = [...cuts].sort((x, y) => x - y), out: ReactNode[] = [];
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        const cls = marks.filter(m => m[0] <= a && m[1] >= b && m[2] !== 'ac' && !(inLink && LINK_IGNORED.has(m[2]))).map(m => 'rt-' + m[2]).join(' ');
        out.push(cls ? <span key={key + a} className={cls}>{text.slice(a, b)}</span> : text.slice(a, b));
    }
    return out;
}

// One line of text with its addresses as links (자동 링크, WP48). The visible text is the address
// itself; links open in a new tab with rel 'noopener noreferrer nofollow ugc', and the site's own posts
// open in the app. Blocked and look-alike hosts stay plain text (findLinks leaves them out). inert
// (the 꾸미기 sheet) shows links without making them clickable, so text can be selected over them.
function linked(text: string, lo: number, hi: number, marks: Mark[], blocked: string[], key: string, inert: boolean): { nodes: ReactNode[]; urls: string[] } {
    const line = text.slice(lo, hi);
    const links = findLinks(line, { blocked, selfHost: typeof location === 'undefined' ? undefined : location.host });
    const nodes: ReactNode[] = [];
    let at = 0;
    links.forEach((l, i) => {
        if (l.start > at) nodes.push(...pieces(text, lo + at, lo + l.start, marks, false, key + 't' + i + ':'));
        const inner = pieces(text, lo + l.start, lo + l.end, marks, true, key + 'l' + i + ':'), local = inAppPath(l.url);
        nodes.push(inert
            ? <span key={key + i} className="autolink">{inner}</span>
            : local
            ? <a key={key + i} className="autolink" href={local} onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); void navigate(local); }}>{inner}</a>
            : <a key={key + i} className="autolink" href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc">{inner}</a>);
        at = l.end;
    });
    if (at < line.length) nodes.push(...pieces(text, lo + at, hi, marks, false, key + 'e:'));
    return { nodes, urls: links.map(l => l.url) };
}

// Plain text (the post body, a chat bubble, a comment) with 자동 링크, the post's 링크 미리보기 cards
// (at most 3) each directly under the first line holding its address, and the post's 글자 꾸미기 marks.
// Line breaks are kept as text, so the surrounding element keeps white-space: pre-wrap, and every
// character of the text is one text node in order (the 꾸미기 sheet maps selections by it). No style
// attribute and no HTML: classes only.
export function RichBody({ text, cards = [], marks = [], inert = false }: { text: string; cards?: Card[]; marks?: Mark[]; inert?: boolean }) {
    const { config } = useApp();
    const blocked = config.blockedLinks || [];
    const lines = text.split('\n'), placed = new Set<string>(), centers = marks.filter(m => m[2] === 'ac');
    let lo = 0;
    return <>{lines.map((line, i) => {
        const start = lo, end = lo + line.length;
        lo = end + 1;
        const { nodes, urls } = linked(text, start, end, marks, blocked, i + ':', inert);
        const here = inert ? [] : cards.filter(c => !placed.has(c.url) && urls.includes(c.url));
        here.forEach(c => placed.add(c.url));
        const last = i === lines.length - 1;
        // A card is a block, so it breaks the line itself; the line's own break is then left out.
        const br = here.length || last ? null : '\n';
        const centered = end > start && centers.some(m => m[0] <= start && m[1] >= end);
        // A centered line is a block holding its own break (a trailing break adds no empty line).
        if (centered) return <Fragment key={i}><div className="rt-center">{nodes}{br}</div>{here.map(c => <LinkCard key={c.url} card={c} />)}</Fragment>;
        return <Fragment key={i}>{nodes}{here.length ? here.map(c => <LinkCard key={c.url} card={c} />) : br}</Fragment>;
    })}</>;
}
