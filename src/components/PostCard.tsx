import { Heart } from 'lucide-react';
import { toast } from 'sonner';
import {
    KIND_NAMES, KIND_ICONS, STATUS_NAMES, accountSummary, categoryName, exchangeLabel, listingPrice, priceLabel, priceText, relativeTime, tagName,
    type Post, type SeasonTag,
} from '../../shared/market';
import { Link, navigate } from '../lib/router';
import { api, errorText, imageUrl } from '../lib/api';
import { useApp } from '../app/state';
import { CIcon, NameLine } from './ui';

export function postSummary(post: Post) {
    const d = post.details;
    if (post.category === 'account') return accountSummary(d);
    if (post.category === 'clan') return [d.clanName, d.clanLevel ? `${d.clanLevel}렙 클랜` : '', d.clanMembers ? `${d.clanMembers}명` : ''].filter(Boolean);
    if (post.category === 'goods_coupon') return [d.goodsName || d.couponName, d.quantity ? `${d.quantity}개` : '', d.condition].filter(Boolean);
    if (post.kind === 'proxy_request' || post.kind === 'proxy_offer') return [d.current, d.target, d.schedule].filter(Boolean);
    return [];
}

// What an exchange post wants in return, in the same short form as the offered side.
export function wantedSummary(post: Pick<Post, 'details' | 'wanted_tags'>) {
    const d = post.details;
    if (d.wantedCategory !== 'account') return [categoryName(d.wantedCategory || 'account')];
    const unprefixed: Record<string, string> = {};
    for (const [k, v] of Object.entries(d)) if (k.startsWith('wanted') && k !== 'wantedCategory') unprefixed[k[6].toLowerCase() + k.slice(7)] = v;
    const tags = post.wanted_tags || [];
    return [...tags.slice(0, 2).map(tagName), ...(tags.length > 2 ? [`외 ${tags.length - 2}개 시즌`] : []), ...accountSummary(unprefixed)];
}

export function tradeLabel(post: Pick<Post, 'kind' | 'category' | 'details'>) {
    return post.kind === 'exchange' ? exchangeLabel(post.category, post.details.wantedCategory) : `${KIND_NAMES[post.kind]} · ${categoryName(post.category)}`;
}

// Sale price with every earlier 즉거가 struck through, oldest first. Exchange posts have
// no price, so the slot shows what the author wants in return.
export function PriceLine({ post, large = false }: { post: Post; large?: boolean }) {
    if (post.kind === 'exchange') {
        const wanted = wantedSummary(post);
        return <div className={'price price-exchange' + (large ? ' price-lg' : '')}>
            <span className="price-label">원하는 {categoryName(post.details.wantedCategory || 'account')}</span>
            <span className="price-want">{wanted.length > 1 || post.details.wantedCategory !== 'account' ? wanted.join(' · ') : '본문 참고'}</span>
        </div>;
    }
    const history = post.kind === 'sell' ? post.price_history || [] : [];
    const offer = post.kind === 'sell' && post.details.currentOffer ? Number(post.details.currentOffer) : null;
    return <div className={'price' + (large ? ' price-lg' : '')}>
        <span className="price-label">{priceLabel(post.kind)}</span>
        <span className="price-values">
            {history.map((h, i) => <del key={i} title={new Date(h.changed_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' 변경 전'}>{priceText(h.price)}</del>)}
            <strong>{post.kind === 'buy' && post.price !== null ? priceText(post.price) : listingPrice(post)}</strong>
        </span>
        {offer !== null && <span className="price-offer">현젯 <b>{priceText(offer)}</b></span>}
    </div>;
}

function orderedTags(tags: SeasonTag[], highlight: SeasonTag[]) {
    const hit = (t: SeasonTag) => highlight.some(h => h.tier === t.tier && h.season === t.season);
    return [...tags].sort((a, b) => Number(hit(b)) - Number(hit(a)) || b.season - a.season);
}

export function PostCard({ post, highlight = [], onChange }: { post: Post; highlight?: SeasonTag[]; onChange?: () => void }) {
    const { me, requireLogin } = useApp();
    const href = '/posts/' + post.id;
    const tags = orderedTags(post.tags, highlight);
    const summary = postSummary(post);
    // Logged-out members log in first; the heart is then saved for the post they clicked.
    const favorite = () => requireLogin(u => { if (u.id !== post.author_id) void save(); });
    async function save() {
        try {
            await api(`posts/${post.id}/favorite`, 'POST', { active: !post.favorite });
            toast(post.favorite ? '찜 해제' : '찜 완료');
            onChange?.();
        } catch (e) { toast.error(errorText(e)); }
    }
    return <article className={'post-card' + (post.status === 'closed' ? ' is-closed' : '')}>
        <div className="post-card-body" onClick={e => { if (!(e.target as HTMLElement).closest('a,button')) void navigate(href); }}>
            <div className="post-card-meta">
                <CIcon name={KIND_ICONS[post.kind]} size={18} />
                <span>{tradeLabel(post)}</span>
                {post.status !== 'open' && <span className={'status status-' + post.status}>{STATUS_NAMES[post.status]}</span>}
            </div>
            <h3 className="post-card-title"><Link to={href}>{post.title}</Link></h3>
            {(tags.length > 0 || summary.length > 0) && <div className="post-card-specs">
                {tags.slice(0, 3).map(t => <span className="tag" key={t.tier + t.season}>{tagName(t)}</span>)}
                {tags.length > 3 && <span className="tag">+{tags.length - 3}</span>}
                {summary.length > 0 && <span className="spec">{summary.slice(0, 4).join(' · ')}</span>}
            </div>}
            <div className="post-card-bottom">
                <PriceLine post={post} />
                <div className="post-card-author">
                    <NameLine nickname={post.nickname} grade={post.author_grade} role={post.role} badges={post.author_badges} />
                    <span className="muted small nowrap">{relativeTime(post.created_at)}</span>
                </div>
            </div>
        </div>
        {post.images[0] && <Link to={href} className="post-card-thumb" tabIndex={-1} aria-hidden="true"><img src={imageUrl(post.images[0])} alt="" loading="lazy" /></Link>}
        {me?.id !== post.author_id && <button type="button" className={'post-card-fav' + (post.favorite ? ' on' : '')} aria-pressed={!!post.favorite} aria-label={post.favorite ? '찜 해제' : '찜하기'} onClick={favorite}>
            <Heart size={20} fill={post.favorite ? 'currentColor' : 'none'} />
        </button>}
    </article>;
}
