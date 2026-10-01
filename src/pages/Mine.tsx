import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { toast } from 'sonner';
import { KIND_ICONS, STATUS_NAMES, exchangeLabel, listingPrice, priceText, relativeTime, suspendUntilText, type Post } from '../../shared/market';
import { APPLICATION_STATUS_NAMES, applicationTitle, type Application } from '../../shared/membership';
import { api, errorText, imageUrl } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { useApp } from '../app/state';
import { CIcon, EmptyState, NameLine, SkeletonRows, Tabs } from '../components/ui';
import { PostCard } from '../components/PostCard';
import { TradeSheet } from '../components/TradeSheet';
import { WalletGauge, bumpReadyAt, useMinuteClock, walletNow, type Usage, type Wallet } from '../components/Wallet';

const TABS = [
    { id: 'posts', label: '내 글' }, { id: 'favorites', label: '찜한 글' }, { id: 'offers', label: '가격 제시' },
    { id: 'recent', label: '최근 본 글' }, { id: 'applications', label: '신청 내역' }, { id: 'blocks', label: '차단' },
] as const;
type TabId = typeof TABS[number]['id'];
const PAGE_SIZE = 40;
const isPostTab = (t: TabId) => t === 'posts' || t === 'favorites' || t === 'recent';

type Offer = {
    id: string; post_id: number; title: string; amount: number; status: string; sender_id: string; sender_name: string; recipient_name: string; conversation_id: string; created_at: number;
    sender_grade: string; sender_grade_trial?: boolean; sender_badges: string[]; recipient_grade: string; recipient_grade_trial?: boolean; recipient_badges: string[];
};
const OFFER_STATUS: Record<string, string> = { pending: '대기', accepted: '수락', declined: '거절', withdrawn: '취소', cancelled: '마감' };

// Every post carries bump_count; the author's own list asks for fav_count and chat_count too (counts=1).
type OwnPost = Post & { bump_count?: number; fav_count?: number; chat_count?: number };
// 찜한 글: a sale whose 즉거가 fell after it was saved (from: the price then, to: now). The card's price
// line already strikes the earlier 즉거가, so the meta line shows only the tag.
type SavedPost = Post & { price_drop?: { from: number; to: number } };
const priceDrop = (p: SavedPost) => p.price_drop && <span className="tag tag-drop">가격 내림</span>;
type ListState = { tab: TabId; items: any[]; total: number; page: number };

const HOUR = 3600000;
// '15:40' on the Korean clock, rounded up to the minute like the server's message.
function kstClock(t: number) {
    const d = new Date(Math.ceil(t / 60000) * 60000 + 9 * HOUR);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}
const uniquePosts = (list: Post[]) => [...new Map(list.map(p => [p.id, p])).values()];

// 끌올 in the same states as the detail page: the wallet ('3/4'), or '15:40부터 가능' (the latest of
// the same-post gap, 새 글 우선 and, with an empty wallet, the next refill).
// `closeOnly`: a 대리(진행) post without 대리 인증, or any post under 이용 정지 (only 거래완료 is allowed).
function bumpState(post: OwnPost, usage: Usage | null, closeOnly: boolean, now: number) {
    if (!usage || post.status !== 'open' || post.hidden || closeOnly) return { disabled: true, hint: '' };
    const ready = bumpReadyAt(post, usage, now);
    if (ready) return { disabled: true, hint: `${kstClock(ready)}부터 가능` };
    const w = walletNow(usage, now);
    return { disabled: false, hint: w ? `${w.tokens}/${w.max}` : '' };
}

// A row of 내 글: photo, title, status, price, how many saved it and chatted, then 끌올 and 상태.
function SellerRow({ post, usage, now, busy, closeOnly, onBump, onStatus }: {
    post: OwnPost; usage: Usage | null; now: number; busy: boolean; closeOnly: boolean; onBump: () => void; onStatus: (status: string) => void;
}) {
    const href = '/posts/' + post.id, thumb = post.images[0];
    const bump = bumpState(post, usage, closeOnly, now);
    const price = post.kind === 'exchange' ? exchangeLabel(post.category, post.details.wantedCategory) : listingPrice(post);
    // Without 대리 인증 a 대리(진행) post, and under 이용 정지 any post, can only be closed (the server refuses the rest).
    const statuses = Object.entries(STATUS_NAMES).filter(([k]) => !closeOnly || k === post.status || k === 'closed');
    return <li className={'seller-row' + (post.status === 'closed' ? ' is-closed' : '')}>
        <Link to={href} className="seller-thumb" tabIndex={-1} aria-hidden="true">{thumb ? <img src={imageUrl(thumb)} alt="" loading="lazy" /> : <CIcon name={KIND_ICONS[post.kind]} size={28} />}</Link>
        <div className="seller-main">
            <Link to={href} className="seller-title">{post.title}</Link>
            <div className="seller-meta">
                <span className={'status status-' + post.status}>{STATUS_NAMES[post.status]}</span>
                {!!post.hidden && <span className="status status-hidden">숨김</span>}
                <b>{price}</b>
            </div>
            <span className="seller-stats">찜 {post.fav_count || 0} · 채팅 {post.chat_count || 0}</span>
        </div>
        <div className="seller-actions">
            <button type="button" className="btn btn-line btn-sm seller-bump" disabled={bump.disabled || busy} onClick={onBump}><span>끌올</span>{bump.hint && <small className="bump-hint">{bump.hint}</small>}</button>
            <DropdownMenu.Root modal={false}>
                <DropdownMenu.Trigger className="btn btn-line btn-sm seller-status" disabled={busy}>상태<ChevronDown size={15} /></DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                    <DropdownMenu.Content className="menu status-menu" align="end" sideOffset={6}>
                        <DropdownMenu.RadioGroup value={post.status} onValueChange={onStatus}>
                            {statuses.map(([k, v]) => <DropdownMenu.RadioItem key={k} value={k} className="menu-item">{v}<DropdownMenu.ItemIndicator className="menu-check"><Check size={16} /></DropdownMenu.ItemIndicator></DropdownMenu.RadioItem>)}
                        </DropdownMenu.RadioGroup>
                    </DropdownMenu.Content>
                </DropdownMenu.Portal>
            </DropdownMenu.Root>
        </div>
    </li>;
}

export default function Mine({ tab: raw }: { tab?: string }) {
    const { me, ready, requireLogin, openApply } = useApp();
    const tab: TabId = TABS.some(t => t.id === raw) ? raw as TabId : 'posts';
    const [rev, setRev] = useState(0);
    const [data, setData] = useState<ListState | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [usage, setUsage] = useState<Usage | null>(null), [busy, setBusy] = useState<number | null>(null), [now, setNow] = useState(Date.now());
    const [clock] = useMinuteClock();
    // '거래한 회원' after a post is set to 거래완료 here, as on the detail page (WP23).
    const [tradePost, setTradePost] = useState<number | null>(null);
    // How many pages of the current tab are on screen, so a reload keeps them.
    const loaded = useRef<{ tab: TabId; page: number }>({ tab, page: 1 });
    useEffect(() => { if (ready && !me) requireLogin(); }, [ready, me, requireLogin]);
    const pagePath = (t: TabId, n: number) => 'posts?' + new URLSearchParams({ ...(t === 'posts' ? { author: me!.id, counts: '1' } : { scope: t }), size: String(PAGE_SIZE), page: String(n) });
    useEffect(() => {
        if (!me) return;
        let alive = true;
        const pages = isPostTab(tab) && loaded.current.tab === tab ? loaded.current.page : 1;
        const load: Promise<Omit<ListState, 'tab'>> = isPostTab(tab)
            ? Promise.all(Array.from({ length: pages }, (_, i) => api<{ posts: Post[]; total: number }>(pagePath(tab, i + 1))))
                .then(rs => ({ items: uniquePosts(rs.flatMap(r => r.posts)), total: rs[rs.length - 1].total, page: pages }))
            : api<any>(tab).then(d => ({ items: d.offers || d.applications || d.blocks || [], total: 0, page: 1 }));
        load.then(r => { if (alive) { loaded.current = { tab, page: r.page }; setData({ tab, ...r }); } })
            .catch(e => { if (alive) { toast.error(errorText(e)); loaded.current = { tab, page: 1 }; setData({ tab, items: [], total: 0, page: 1 }); } });
        return () => { alive = false; };
    }, [tab, me?.id, rev]);
    // 내 글 header (the 끌올 gauge '끌올 3/4 · 1:20 후 충전') and the 끌올 states of the rows.
    const loadUsage = () => api<Usage>('me/usage').then(setUsage).catch(() => setUsage(null));
    useEffect(() => { if (me && tab === 'posts') void loadUsage(); }, [tab, me?.id, me?.grade]);
    // A waiting 끌올 turns on by itself when its time comes; the gauge counts down once a minute.
    useEffect(() => { if (tab === 'posts') setNow(clock); }, [clock, tab]);

    if (!me) return <div className="container page"><EmptyState icon="lock" title="로그인이 필요합니다" action={<button className="btn btn-primary" onClick={() => requireLogin()}>로그인</button>} /></div>;
    const items = data?.tab === tab ? data.items : null;
    const manager = me.role === 'manager';
    const suspended = !!me.suspended_until && me.suspended_until > now;

    async function unblock(id: string) {
        try { await api('blocks', 'POST', { userId: id, active: false }); toast('차단 해제'); setRev(n => n + 1); } catch (e) { toast.error(errorText(e)); }
    }
    // '더 보기' adds the next page under the rows already shown.
    async function more() {
        if (!data || data.tab !== tab || loadingMore) return;
        setLoadingMore(true);
        const next = data.page + 1, current = tab;
        try {
            const d = await api<{ posts: Post[]; total: number }>(pagePath(current, next));
            setData(prev => prev && prev.tab === current ? {
                ...prev, items: uniquePosts([...prev.items, ...d.posts]), page: next,
                // An empty page means the list shrank meanwhile: stop offering more.
                total: d.posts.length ? d.total : prev.items.length,
            } : prev);
            if (loaded.current.tab === current) loaded.current = { tab: current, page: next };
        } catch (e) { toast.error(errorText(e)); }
        finally { setLoadingMore(false); }
    }
    const patchPost = (id: number, change: Partial<OwnPost>) => setData(prev => prev && { ...prev, items: prev.items.map((p: OwnPost) => p.id === id ? { ...p, ...change } : p) });
    async function bumpPost(post: OwnPost) {
        if (busy !== null) return;
        setBusy(post.id);
        try {
            const d = await api<Wallet & { bumpedAt: number }>(`posts/${post.id}/bump`, 'POST', {});
            patchPost(post.id, { bumped_at: d.bumpedAt, bump_count: (post.bump_count || 0) + 1 });
            setUsage(u => u && { ...u, bumpTokens: d.bumpTokens, bumpMax: d.bumpMax, bumpRefillMin: d.bumpRefillMin, nextRefillAt: d.nextRefillAt });
            toast('끌올 완료');
            setNow(Date.now());
        } catch (e) { toast.error(errorText(e)); }
        finally { setBusy(null); void loadUsage(); }
    }
    async function setStatus(post: OwnPost, status: string) {
        if (busy !== null || status === post.status) return;
        setBusy(post.id);
        try {
            await api(`posts/${post.id}/status`, 'PATCH', { status });
            patchPost(post.id, { status });
            toast(`상태 변경: ${STATUS_NAMES[status]}`);
            if (status === 'closed' && !suspended) setTradePost(post.id);
        } catch (e) { toast.error(errorText(e)); }
        finally { setBusy(null); void loadUsage(); }
    }
    const moreButton = data && data.tab === tab && isPostTab(tab) && data.items.length < data.total
        && <button type="button" className="btn btn-line more-btn" disabled={loadingMore} onClick={more}>더 보기</button>;

    return <div className="container page">
        <h1 className="page-title">내 거래</h1>
        <div className="mt-16"><Tabs label="내 거래 메뉴" value={tab} onChange={t => void navigate('/me/' + t, { replace: true })} items={[...TABS]} /></div>
        <div className="mt-24">
            {items === null ? <SkeletonRows count={3} />
                : tab === 'posts' ? (items.length ? <>
                    {suspended ? <p className="mine-usage">이용 정지 중입니다. ({suspendUntilText(me.suspended_until!)})</p> : usage && <WalletGauge usage={usage} now={now} className="mine-usage" />}
                    <ul className="seller-list">{(items as OwnPost[]).map(p => <SellerRow key={p.id} post={p} usage={usage} now={now} busy={busy === p.id}
                        closeOnly={suspended || (p.kind === 'proxy_offer' && !manager && !me.badges.includes('proxy'))} onBump={() => void bumpPost(p)} onStatus={s => void setStatus(p, s)} />)}</ul>
                    {moreButton}
                </> : <EmptyState icon="file" title="작성한 글이 없습니다" action={<Link to="/write" className="btn btn-primary">글쓰기</Link>} />)
                : (tab === 'favorites' || tab === 'recent') ? (items.length ? <><div className="post-list">{(items as SavedPost[]).map(p => <PostCard key={p.id} post={p} flag={tab === 'favorites' ? priceDrop(p) : undefined} onChange={() => setRev(n => n + 1)} />)}</div>{moreButton}</>
                    : <EmptyState icon="file" title={tab === 'favorites' ? '찜한 글이 없습니다' : '최근 본 글이 없습니다'} action={<Link to="/trade?kind=buy" className="btn btn-line">거래 둘러보기</Link>} />)
                : tab === 'offers' ? (items.length ? <ul className="simple-list">{(items as Offer[]).map(o => <li key={o.id}>
                    <span className="grow"><Link to={'/posts/' + o.post_id} className="strong-link">{o.title}</Link><span className="muted small">{o.sender_id === me.id ? <>보낸 제시 · <NameLine nickname={o.recipient_name} grade={o.recipient_grade} trial={o.recipient_grade_trial} badges={o.recipient_badges} /></> : <>받은 제시 · <NameLine nickname={o.sender_name} grade={o.sender_grade} trial={o.sender_grade_trial} badges={o.sender_badges} /></>}<span className="nowrap">{' '}· {relativeTime(o.created_at)}</span></span></span>
                    <b>{priceText(o.amount)}</b><span className="event-status">{OFFER_STATUS[o.status] || o.status}</span>
                    <Link to={'/chat/' + o.conversation_id} className="btn btn-line btn-xs">채팅</Link>
                </li>)}</ul> : <EmptyState icon="message" title="제시 내역이 없습니다" />)
                : tab === 'applications' ? (items.length ? <ul className="simple-list">{(items as Application[]).map(a => <li key={a.id}>
                    <span className="grow"><strong>{applicationTitle(a)}</strong><span className="muted small">{relativeTime(a.created_at)}{a.note ? ` · ${a.note}` : ''}</span></span>
                    <span className={'event-status st-' + a.status}>{APPLICATION_STATUS_NAMES[a.status]}</span>
                    {a.conversation_id && <Link to={'/chat/' + a.conversation_id} className="btn btn-line btn-xs">채팅</Link>}
                </li>)}</ul> : <EmptyState icon="file" title="신청 내역이 없습니다" action={me.role !== 'manager' ? <button className="btn btn-primary" onClick={() => openApply()}>인증/등급 신청하기</button> : undefined} />)
                : (items.length ? <ul className="simple-list">{items.map((b: { target_id: string; nickname: string; grade: string; grade_trial?: boolean; badges: string[] }) => <li key={b.target_id}><span className="grow"><Link to={'/profile/' + b.target_id} className="strong-link"><NameLine nickname={b.nickname} grade={b.grade} trial={b.grade_trial} badges={b.badges} /></Link></span><button type="button" className="btn btn-line btn-xs" onClick={() => unblock(b.target_id)}>차단 해제</button></li>)}</ul>
                    : <EmptyState title="차단한 회원이 없습니다" />)}
        </div>
        <TradeSheet postId={tradePost} onClose={() => setTradePost(null)} />
    </div>;
}
