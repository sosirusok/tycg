import { useState } from 'react';
import { ownPostId, type LinkCard as Card } from '../../shared/links';
import { navigate } from '../lib/router';

// The app path for one of the site's own post links (/posts/:id or /p/:id), or null.
export function inAppPath(url: string) {
    if (typeof location === 'undefined') return null;
    const id = ownPostId(url, location.host);
    return id === null ? null : '/posts/' + id;
}

// 링크 미리보기 card (WP48) under the line holding its address. The whole card is one link, with the
// same rel and target as the address itself; the site's own posts open in the app. The image comes
// only from i.ytimg.com or *.kakaocdn.net (the Worker keeps no other), without a referrer; a broken
// image is hidden and the card stays a text card.
export function LinkCard({ card }: { card: Card }) {
    const [broken, setBroken] = useState(false);
    const local = inAppPath(card.url);
    const site = card.site && card.site !== card.domain ? `${card.site} · ${card.domain}` : card.domain;
    return <a className="link-card" href={local ?? card.url} {...local ? {} : { target: '_blank', rel: 'noopener noreferrer nofollow ugc' }}
        onClick={local ? e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); void navigate(local); } : undefined}>
        {card.image && !broken && <span className="link-card-image"><img src={card.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} /></span>}
        <span className="link-card-text">
            <span className="link-card-site">{site}</span>
            <span className="link-card-title">{card.title}</span>
            {card.description && <span className="link-card-desc">{card.description}</span>}
        </span>
    </a>;
}
