import { Fragment, type ReactNode } from 'react';
import { findLinks, type LinkCard as Card } from '../../shared/links';
import { navigate } from '../lib/router';
import { useApp } from '../app/state';
import { LinkCard, inAppPath } from './LinkCard';

// One line of text with its addresses as links (자동 링크, WP48). The visible text is the address
// itself; links open in a new tab with rel 'noopener noreferrer nofollow ugc', and the site's own posts
// open in the app. Blocked and look-alike hosts stay plain text (findLinks leaves them out).
function linked(line: string, blocked: string[], key: string): { nodes: ReactNode[]; urls: string[] } {
    const links = findLinks(line, { blocked, selfHost: typeof location === 'undefined' ? undefined : location.host });
    const nodes: ReactNode[] = [];
    let at = 0;
    links.forEach((l, i) => {
        if (l.start > at) nodes.push(line.slice(at, l.start));
        const text = line.slice(l.start, l.end), local = inAppPath(l.url);
        nodes.push(local
            ? <a key={key + i} className="autolink" href={local} onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); void navigate(local); }}>{text}</a>
            : <a key={key + i} className="autolink" href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc">{text}</a>);
        at = l.end;
    });
    if (at < line.length) nodes.push(line.slice(at));
    return { nodes, urls: links.map(l => l.url) };
}

// Plain text (the post body, a chat bubble, a comment) with 자동 링크, and the post's 링크 미리보기 cards
// (at most 3) each directly under the first line holding its address. Line breaks are kept as text, so
// the surrounding element keeps white-space: pre-wrap.
export function RichBody({ text, cards = [] }: { text: string; cards?: Card[] }) {
    const { config } = useApp();
    const blocked = config.blockedLinks || [];
    const lines = text.split('\n'), placed = new Set<string>();
    return <>{lines.map((line, i) => {
        const { nodes, urls } = linked(line, blocked, i + ':');
        const here = cards.filter(c => !placed.has(c.url) && urls.includes(c.url));
        here.forEach(c => placed.add(c.url));
        const last = i === lines.length - 1;
        // A card is a block, so it breaks the line itself; the line's own break is then left out.
        return <Fragment key={i}>{nodes}{here.length ? here.map(c => <LinkCard key={c.url} card={c} />) : !last && '\n'}</Fragment>;
    })}</>;
}
