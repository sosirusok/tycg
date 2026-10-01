import type { ReactNode } from 'react';
import { Heart } from 'lucide-react';
import { toast } from 'sonner';
import {
    KIND_ICONS, KIND_NAMES, accountSummary, categoryName, exchangeLabel, listingPrice, priceLabel, priceText, relativeTime, statusName, tagName,
    type Post, type SeasonTag,
} from '../../shared/market';
import { Link, navigate } from '../lib/router';
import { api, errorText, imageUrl } from '../lib/api';
import { useApp } from '../app/state';
import { CIcon, DataItems, NameLine } from './ui';
import { titleTier } from '../../shared/membership';

export function postSummary(post: Post) {
    const d = post.details;
    if (post.category === 'account') return accountSummary(d);
    if (post.category === 'clan') return [d.clanName, d.clanLevel ? `${d.clanLevel}렙 클랜` : '', d.clanMembers ? `${d.clanMembers}명` : ''].filter(Boolean);
    if (post.category === 'goods_coupon') return [d.goodsName || d.couponName, d.quantity ? `${d.quantity}개` : '', d.condition].filter(Boolean);
    if (post.kind === 'proxy_request' || post.kind === 'proxy_offer') return [d.current, d.target, d.schedule].filter(Boolean);
    return [];
}

// What an exchange post wants in return, in the same short form as the offered side:
// the ladder seasons and the other conditions, kept apart so the detail page can show them on two lines.
export function wantedSummary(post: Pick<Post, 'details' | 'wanted_tags'>): [string[], string[]] {
    const d = post.details;
    if (d.wantedCategory !== 'account') return [[], [categoryName(d.wantedCategory || 'account')]];
    const unprefixed: Record<string, string> = {};
    for (const [k, v] of Object.entries(d)) if (k.startsWith('wanted') && k !== 'wantedCategory') unprefixed[k[6].toLowerCase() + k.slice(7)] = v;
    const tags = post.wanted_tags || [];
    return [[...tags.slice(0, 2).map(tagName), ...(tags.length > 2 ? [`외 ${tags.length - 2}개 시즌`] : [])], accountSummary(unprefixed)];
}

// 제목 강조 (WP48) on list surfaces: t0 일반 회색, t1 플러스 and the 무료 체험 검정, t2 프리미엄 굵게,
// t3 엘리트·관리자·매니저 굵게·파랑, from the author's current grade; any completed post is t-closed.
export function titleClass(post: Pick<Post, 'status' | 'author_grade' | 'role'>) {
    return post.status === 'closed' ? 't-closed' : 't' + titleTier(post.author_grade, post.role);
}

// Cards show the first few data items of a spec line; the post itself lists everything.
const CARD_ITEMS = 4;


// The category, or for an exchange post what is traded for what ('계정에서 클랜 구함').
export function subjectLabel(post: Pick<Post, 'kind' | 'category' | 'details'>) {
    return post.kind === 'exchange' ? exchangeLabel(post.category, post.details.wantedCategory) : categoryName(post.category);
}

export function tradeLabel(post: Pick<Post, 'kind' | 'category' | 'details'>) {
    return post.kind === 'exchange' ? exchangeLabel(post.category, post.details.wantedCategory) : `${KIND_NAMES[post.kind]} · ${categoryName(post.category)}`;
}

// Sale price with earlier 즉거가 struck through, oldest first: cards show the last two, the
// detail page (large) shows all of them. The server sends only prices above the current one.
// Exchange posts have no price, so the slot shows what the author wants in return.
// A completed post with a confirmed trade shows '거래가 25만원' instead of the listed price (WP51); the
// author, the two members of the trade and the manager also see '확인 대기' or '확인 완료'.
export function PriceLine({ post, large = false }: { post: Post; large?: boolean }) {
    const dealState = post.deal_state && <span className={'tag deal-state' + (post.deal_state === 'confirmed' ? ' tag-line' : '')}>{post.deal_state === 'confirmed' ? '확인 완료' : '확인 대기'}</span>;
    if (post.status === 'closed' && post.deal_price !== undefined && post.kind !== 'exchange') return <div className={'price price-deal' + (large ? ' price-lg' : '')}>
        <span className="price-label">거래가</span>
        <span className="price-values"><strong>{priceText(post.deal_price)}</strong></span>
        {dealState}
    </div>;
    if (post.kind === 'exchange') {
        const [ladder, conditions] = wantedSummary(post);
        const lines = large ? [ladder, conditions].filter(l => l.length) : [[...ladder, ...conditions].slice(0, CARD_ITEMS)].filter(l => l.length);
        return <div className={'price price-exchange' + (large ? ' price-lg' : '')}>
            <span className="price-label">원하는 {categoryName(post.details.wantedCategory || 'account')}</span>
            {lines.length ? lines.map((line, i) => <span key={i} className="price-want"><DataItems items={line} /></span>) : <span className="price-want">내용 참고</span>}
            {dealState}
        </div>;
    }
    const all = post.kind === 'sell' ? (post.price_history || []).filter(h => h.price !== post.price) : [];
    const history = large ? all : all.slice(-2);
    const offer = post.kind === 'sell' && post.details.currentOffer ? Number(post.details.currentOffer) : null;
    // A buy post reads 'MAX 30만원' in one piece, so it has no separate label.
    return <div className={'price' + (large ? ' price-lg' : '')}>
        {post.kind !== 'buy' && <span className="price-label">{priceLabel(post.kind)}</span>}
        <span className="price-values">
            {history.map((h, i) => <del key={i} title={new Date(h.changed_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' 변경 전'}>{priceText(h.price)}</del>)}
            <strong>{listingPrice(post)}</strong>
        </span>
        {offer !== null && <span className="price-offer">현젯 <b>{priceText(offer)}</b></span>}
        {dealState}
    </div>;
}

function orderedTags(tags: SeasonTag[], highlight: SeasonTag[]) {
    const hit = (t: SeasonTag) => highlight.some(h => h.tier === t.tier && h.season === t.season);
    return [...tags].sort((a, b) => Number(hit(b)) - Number(hit(a)) || b.season - a.season);
}

// Time shown on a row: the last 끌올 for a bumped post (or a relist at its place), else when it was
// written. A new post placed ahead of now (새 글 우선) never reads '끌올 방금 전'.
export function postTime(p: Pick<Post, 'created_at' | 'bumped_at' | 'bump_count'>, now = Date.now()) {
    return (p.bump_count || 0) > 0 && p.bumped_at && p.bumped_at <= now ? '끌올 ' + relativeTime(p.bumped_at) : relativeTime(p.created_at);
}

// The 대표 photo of a list row (WP46): the inline thumbnail the editor made (no image request), else
// the photo itself; count is how many photos the post has (lists carry only the 대표).
export function listPhoto(post: Pick<Post, 'images' | 'thumb' | 'photo_count'>) {
    const thumb = post.images[0] as string | undefined;
    return { thumb, thumbSrc: post.thumb || (thumb ? imageUrl(thumb) : ''), count: post.photo_count ?? post.images.length };
}

// showKind adds the board name as a plain-text prefix ('[판매] 계정') for mixed lists; a list of
// one board passes false. hideAuthor drops the author line on a member's own profile lists.
// flag goes at the end of the meta line (찜한 글's '가격 내림').
export function PostCard({ post, highlight = [], onChange, showKind = true, hideAuthor = false, flag }: { post: Post; highlight?: SeasonTag[]; onChange?: () => void; showKind?: boolean; hideAuthor?: boolean; flag?: ReactNode }) {
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
    const { thumb, thumbSrc, count } = listPhoto(post);
    const fav = me?.id !== post.author_id && <button type="button" className={'post-card-fav' + (post.favorite ? ' on' : '')} aria-pressed={!!post.favorite} aria-label={post.favorite ? '찜 해제' : '찜하기'} onClick={favorite}>
        <Heart size={thumb ? 18 : 20} fill={post.favorite ? 'currentColor' : 'none'} />
    </button>;
    // Flat row: text on the left, the photo on the right. The heart sits on the photo's corner,
    // or in the row's top-right corner when there is no photo.
    return <article className={'post-card' + (post.status === 'closed' ? ' is-closed' : '') + (thumb ? ' has-thumb' : '')}>
        <div className="post-card-body" onClick={e => { if (!(e.target as HTMLElement).closest('a,button')) void navigate(href); }}>
            <div className="post-card-meta">
                <span className="post-card-kind">{showKind ? `[${KIND_NAMES[post.kind]}] ${subjectLabel(post)}` : subjectLabel(post)}</span>
                <span className="post-card-time">{postTime(post)}</span>
                {post.status === 'closed' && <span className="status status-closed">{statusName(post.kind, post.status)}</span>}
                {!!post.hidden && <span className="status status-hidden">숨김</span>}
                {post.appraised && <span className="appraised-tag">가측 {priceText(post.appraised.price)}</span>}
                {flag}
            </div>
            <h3 className={'post-card-title ' + titleClass(post)}><Link to={href}>{post.title}</Link></h3>
            {(tags.length > 0 || summary.length > 0) && <div className="post-card-specs">
                {tags.slice(0, 3).map(t => <span className="tag" key={t.tier + t.season}>{tagName(t)}</span>)}
                {tags.length > 3 && <span className="tag">+{tags.length - 3}</span>}
                {summary.length > 0 && <span className="spec"><DataItems items={summary.slice(0, CARD_ITEMS)} /></span>}
            </div>}
            <div className="post-card-bottom">
                <PriceLine post={post} />
                {!hideAuthor && <div className="post-card-author">
                    <NameLine nickname={post.nickname} grade={post.author_grade} trial={post.author_grade_trial} role={post.role} badges={post.author_badges} compact />
                </div>}
            </div>
        </div>
        {thumb ? <div className="post-card-side">
            <Link to={href} className="post-card-thumb" tabIndex={-1} aria-hidden="true"><img src={thumbSrc} alt="" loading="lazy" />{count >= 2 && <span className="photo-count">{count}</span>}</Link>
            {fav}
        </div> : fav}
    </article>;
}

// 운영진 가측가 under the price on the detail page (WP65): '운영진 가측 12만원 · 10월 3일', brand text, no fill.
export function AppraisedLine({ post }: { post: Pick<Post, 'appraised'> }) {
    if (!post.appraised) return null;
    const day = new Date(post.appraised.at).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });
    return <p className="appraised-line">운영진 가측 {priceText(post.appraised.price)} · {day}</p>;
}

// Card for the home shelves (a horizontal row that scrolls sideways).
// href: the link (the home '엘리트 매물' row passes '?from=ad', WP53).
export function MiniCard({ post, href = '/posts/' + post.id }: { post: Post; href?: string }) {
    const summary = postSummary(post);
    const tags = post.tags.slice(0, 2).map(tagName);
    const { thumb, thumbSrc, count } = listPhoto(post);
    const head = <>
        <div className="post-card-meta"><CIcon name={KIND_ICONS[post.kind]} size={18} /><span>{tradeLabel(post)}</span><span className="post-card-time">{postTime(post)}</span></div>
        <h3 className={'mini-card-title ' + titleClass(post)}>{post.title}</h3>
        {(tags.length > 0 || summary.length > 0) && <div className="post-card-specs">{tags.map(t => <span className="tag" key={t}>{t}</span>)}{summary.length > 0 && <span className="spec"><DataItems items={summary.slice(0, 2)} /></span>}</div>}
    </>;
    // With a photo the text and the 64px 대표 sit side by side (grid 1fr 64px); without one it stays text only.
    return <Link to={href} className={'mini-card' + (post.status === 'closed' ? ' is-closed' : '')}>
        {thumb ? <div className="mini-card-top"><div className="mini-card-text">{head}</div>
            <span className="mini-card-thumb"><img src={thumbSrc} alt="" loading="lazy" />{count >= 2 && <span className="photo-count">{count}</span>}</span></div> : head}
        <PriceLine post={post} />
        {/* The time sits on the meta line, as on PostCard, so the author row holds only the name line. */}
        <div className="post-card-author"><NameLine nickname={post.nickname} grade={post.author_grade} trial={post.author_grade_trial} role={post.role} badges={post.author_badges} compact /></div>
    </Link>;
}
