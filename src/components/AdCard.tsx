import { useState } from 'react';
import { Heart } from 'lucide-react';
import { toast } from 'sonner';
import { KIND_ICONS, listingPrice, type Post } from '../../shared/market';
import { AD_TEXT } from '../../shared/membership';
import { api, errorText } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { useApp } from '../app/state';
import { Icon } from './ui';
import { listPhoto, postTime, subjectLabel } from './PostCard';

// 광고 (WP53). Every ad is one of the member's own open posts; links carry ?from=ad, so a first view
// from an ad counts as '광고 유입' on the author's 내 글.
export const adHref = (id: number) => `/posts/${id}?from=ad`;

// One ad row: the 대표 photo, '계정 · 끌올 3분 전', the title on one line, then the price and the
// nickname, with the heart on the right (grid 56px | 1fr | 36px).
export function AdCard({ post }: { post: Post }) {
    const { me, requireLogin } = useApp();
    const [saved, setSaved] = useState(!!post.favorite);
    const href = adHref(post.id), { thumbSrc } = listPhoto(post);
    const favorite = () => requireLogin(async u => {
        if (u.id === post.author_id) return;
        try { await api(`posts/${post.id}/favorite`, 'POST', { active: !saved }); toast(saved ? '찜 해제' : '찜 완료'); setSaved(!saved); }
        catch (e) { toast.error(errorText(e)); }
    });
    return <div className="ad-row" onClick={e => { if (!(e.target as HTMLElement).closest('a,button')) void navigate(href); }}>
        <Link to={href} className="ad-thumb" tabIndex={-1} aria-hidden="true">{thumbSrc ? <img src={thumbSrc} alt="" loading="lazy" /> : <Icon name={KIND_ICONS[post.kind]} size={24} />}</Link>
        <div className="ad-text">
            <span className="ad-meta">{subjectLabel(post)} · {postTime(post)}</span>
            <Link to={href} className="ad-title">{post.title}</Link>
            <span className="ad-bottom"><b>{listingPrice(post)}</b><span className="ad-nick">{post.nickname}</span></span>
        </div>
        {me?.id !== post.author_id ? <button type="button" className={'ad-fav' + (saved ? ' on' : '')} aria-pressed={saved} aria-label={saved ? '찜 해제' : '찜하기'} onClick={favorite}>
            <Heart size={20} fill={saved ? 'currentColor' : 'none'} />
        </button> : <span />}
    </div>;
}

// A titled group of ad rows with the '광고' label on the right ('광고 매물' on the board, '비슷한 매물'
// under a completed post). Every row is a real open post; nothing here changes list order.
export function AdSection({ title, posts, className = '' }: { title: string; posts: Post[]; className?: string }) {
    if (!posts.length) return null;
    return <section className={'ad-box ' + className} aria-label={title}>
        <div className="ad-head"><h2>{title}</h2><span className="ad-label">{AD_TEXT.label}</span></div>
        {posts.map(p => <AdCard key={p.id} post={p} />)}
    </section>;
}
