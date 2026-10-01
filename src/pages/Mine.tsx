import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { toast } from 'sonner';
import { KIND_ICONS, closedLabel, exchangeLabel, listingPrice, priceText, relativeTime, suspendUntilText, type Post } from '../../shared/market';
import { AD_TEXT, APPLICATION_STATUS_NAMES, AUTO_TEXT, applicationTitle, gradeInfo, type Application } from '../../shared/membership';
import { api, errorText, imageUrl } from '../lib/api';
import { Link, navigate, useLocation } from '../lib/router';
import { useApp } from '../app/state';
import { CIcon, EmptyState, NameLine, SkeletonRows, Tabs } from '../components/ui';
import { PostCard } from '../components/PostCard';
import { CompleteSheet, type SheetPost } from '../components/CompleteSheet';
import { WalletGauge, bumpReadyAt, postBlockedUntil, useMinuteClock, walletNow, type Usage, type Wallet } from '../components/Wallet';
import { remindText, setBumpRemind } from '../components/AutoSheet';
import { Auto } from './Auto';

// '자동화' (WP52) shows for 플러스 and up (the 체험 too) and the manager.
const TABS = [
    { id: 'posts', label: '내 글' }, { id: 'auto', label: '자동화' }, { id: 'favorites', label: '찜한 글' }, { id: 'offers', label: '가격 제시' },
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
// traded: a completed post that holds a trade record. askable: '거래 기록 요청' can still be sent for it
// (not hidden, no live record, under the post's 3 requests).
// auto: in the 자동 끌올 list (the '자동' chip); remind_at: a pending '끌올 가능' 알림 (WP52).
// 광고 (WP53): featured is a slot post now, featured_pin 1 '광고 고정' / -1 '광고 빼기', promo_views the
// first views that came from an ad.
type OwnPost = Post & { bump_count?: number; fav_count?: number; chat_count?: number; traded?: boolean; askable?: boolean; auto?: boolean; remind_at?: number | null;
    featured?: boolean; featured_pin?: number; promo_views?: number };
// 찜한 글: a sale whose 즉거가 fell after it was saved (from: the price then, to: now). The card's price
// line already strikes the earlier 즉거가, so the meta line shows only the tag.
type SavedPost = Post & { price_drop?: { from: number; to: number } };
const priceDrop = (p: SavedPost) => p.price_drop && <span className="tag tag-drop">가격 내림</span>;
// capped: the count stopped at 301 ('300+'); full: the last page came back full (there may be more).
type ListState = { tab: TabId; items: any[]; total: number; page: number; capped?: boolean; full?: boolean };

const HOUR = 3600000;
// '15:40' on the Korean clock, rounded up to the minute like the server's message.
function kstClock(t: number) {
    const d = new Date(Math.ceil(t / 60000) * 60000 + 9 * HOUR);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}
const uniquePosts = (list: Post[]) => [...new Map(list.map(p => [p.id, p])).values()];

// 끌올 in the same states as the detail page: the wallet ('3/4'), or '15:40부터 가능' (the latest of
// the same-post gap, 새 글 우선 and, with an empty wallet, the next refill).
// `closeOnly`: a 대리(진행) post without 대리 인증, or any post under 이용 정지 (only 완료 is allowed).
function bumpState(post: OwnPost, usage: Usage | null, closeOnly: boolean, now: number) {
    if (!usage || post.status !== 'open' || post.hidden || closeOnly) return { disabled: true, hint: '', title: undefined as string | undefined, remind: false };
    const ready = bumpReadyAt(post, usage, now);
    // A pending '끌올 가능' 알림 (WP52): '15:40 알림 예정'.
    if (ready && post.remind_at && post.remind_at > now) return { disabled: true, hint: remindText(post.remind_at), title: remindText(post.remind_at), remind: false };
    // With only the wallet empty, every row would repeat the same time: the gauge above the list says
    // it once, and the button keeps the time as its title. A row with its own blocker shows the time.
    // A waiting button sets the '끌올 가능' 알림 (WP52).
    if (ready) return { disabled: false, hint: postBlockedUntil(post, usage, now) ? `${kstClock(ready)}부터 가능` : '', title: `${kstClock(ready)}부터 가능`, remind: true };
    const w = walletNow(usage, now);
    return { disabled: false, hint: w ? `${w.tokens}/${w.max}` : '', title: undefined, remind: false };
}

// A row of 내 글: photo, title, status, price, how many viewed, saved and chatted, then 끌올 and the one
// 완료 button with the kind's closed label (WP43), which opens the 완료 sheet.
function SellerRow({ post, usage, now, busy, closeOnly, suspended, onBump, onRemind, onComplete, onAd }: {
    post: OwnPost; usage: Usage | null; now: number; busy: boolean; closeOnly: boolean; suspended: boolean; onBump: () => void; onRemind: () => void; onComplete: () => void; onAd: (pin: boolean) => void;
}) {
    const href = '/posts/' + post.id, thumb = post.images[0];
    const bump = bumpState(post, usage, closeOnly, now);
    const price = post.kind === 'exchange' ? exchangeLabel(post.category, post.details.wantedCategory) : listingPrice(post);
    const closed = post.status === 'closed';
    // A post completed as '사이트 밖 거래 · 기록 없음' can still get its record within 7 days (the same sheet).
    // 광고 (WP53): 프리미엄 and above; the row menu pins or removes an open post.
    const adSlots = usage?.perks.adSlots || 0, adMenu = adSlots > 0 && !closed && !post.hidden && !closeOnly;
    const recordable = closed && post.traded === false && post.askable !== false && !suspended && !post.hidden && (post.closed_at ?? 0) > now - 7 * 24 * HOUR;
    return <li className={'seller-row' + (post.status === 'closed' ? ' is-closed' : '')}>
        <Link to={href} className="seller-thumb" tabIndex={-1} aria-hidden="true">{thumb ? <img src={imageUrl(thumb)} alt="" loading="lazy" /> : <CIcon name={KIND_ICONS[post.kind]} size={28} />}</Link>
        <div className="seller-main">
            <Link to={href} className="seller-title">{post.title}</Link>
            <div className="seller-meta">
                {closed && <span className="status status-closed">{closedLabel(post.kind)}</span>}
                {!!post.hidden && <span className="status status-hidden">숨김</span>}
                {post.auto && !closed && <span className="tag tag-auto">자동</span>}
                {post.featured && !closed && !post.hidden && adSlots > 0 && <span className="tag tag-line">{AD_TEXT.label}</span>}
                <b>{price}</b>
            </div>
            <span className="seller-stats">조회 {post.view_count || 0} · 찜 {post.fav_count || 0} · 채팅 {post.chat_count || 0}{(adSlots > 0 || !!post.promo_views) && ` · ${AD_TEXT.views(post.promo_views || 0)}`}</span>
        </div>
        <div className="seller-actions">
            {!closed && <button type="button" className={'btn btn-line btn-sm seller-bump' + (bump.remind ? ' is-waiting' : '')} disabled={bump.disabled || busy} title={bump.title} aria-description={bump.title} onClick={bump.remind ? onRemind : onBump}><span>끌올</span>{bump.hint && <small className="bump-hint">{bump.hint}</small>}</button>}
            {!closed && <button type="button" className="btn btn-line btn-sm seller-status" disabled={busy} onClick={onComplete}>{closedLabel(post.kind)}</button>}
            {recordable && <button type="button" className="btn btn-line btn-sm seller-status" onClick={onComplete}>거래 기록 요청</button>}
            {adMenu && <DropdownMenu.Root modal={false}>
                <DropdownMenu.Trigger className="icon-btn seller-more" aria-label="더보기" disabled={busy}><MoreHorizontal size={20} /></DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                    <DropdownMenu.Content className="menu" align="end" sideOffset={6}>
                        {post.featured_pin !== 1 && <DropdownMenu.Item className="menu-item" onSelect={() => onAd(true)}>{AD_TEXT.pin}</DropdownMenu.Item>}
                        {post.featured_pin !== -1 && <DropdownMenu.Item className="menu-item" onSelect={() => onAd(false)}>{AD_TEXT.unpin}</DropdownMenu.Item>}
                    </DropdownMenu.Content>
                </DropdownMenu.Portal>
            </DropdownMenu.Root>}
        </div>
    </li>;
}

export default function Mine({ tab: raw }: { tab?: string }) {
    const { me, ready, requireLogin, openApply } = useApp();
    const { params } = useLocation();
    // 자동화 is for 플러스 and up (the 체험 too) and the manager.
    const autoTab = !!me && (me.role === 'manager' || gradeInfo(me.grade).rank >= 1);
    const tabs = TABS.filter(t => t.id !== 'auto' || autoTab);
    const tab: TabId = tabs.some(t => t.id === raw) ? raw as TabId : 'posts';
    // 내 글 ?stale=1: the listed posts untouched for 7 days (the weekly 알림), with '모두 계속'.
    const stale = tab === 'posts' && params.get('stale') === '1';
    const [rev, setRev] = useState(0);
    const [data, setData] = useState<ListState | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [usage, setUsage] = useState<Usage | null>(null), [busy, setBusy] = useState<number | null>(null), [now, setNow] = useState(Date.now());
    const [clock] = useMinuteClock();
    // The 완료 sheet for a row, as on the detail page (WP43).
    const [tradePost, setTradePost] = useState<SheetPost | null>(null);
    // How many pages of the current tab are on screen, so a reload keeps them.
    const loaded = useRef<{ tab: TabId; page: number }>({ tab, page: 1 });
    useEffect(() => { if (ready && !me) requireLogin(); }, [ready, me, requireLogin]);
    const pagePath = (t: TabId, n: number) => 'posts?' + new URLSearchParams({ ...(t === 'posts' ? { author: me!.id, counts: '1', ...stale ? { stale: '1' } : {} } : { scope: t }), size: String(PAGE_SIZE), page: String(n) });
    useEffect(() => {
        if (!me) return;
        let alive = true;
        const pages = isPostTab(tab) && loaded.current.tab === tab ? loaded.current.page : 1;
        if (tab === 'auto') { setData({ tab, items: [], total: 0, page: 1 }); return () => { alive = false; }; }
        const load: Promise<Omit<ListState, 'tab'>> = isPostTab(tab)
            ? Promise.all(Array.from({ length: pages }, (_, i) => api<{ posts: Post[]; total: number; capped?: boolean }>(pagePath(tab, i + 1))))
                .then(rs => ({ items: uniquePosts(rs.flatMap(r => r.posts)), total: rs[rs.length - 1].total, page: pages, capped: !!rs[rs.length - 1].capped, full: rs[rs.length - 1].posts.length === PAGE_SIZE }))
            : api<any>(tab).then(d => ({ items: d.offers || d.applications || d.blocks || [], total: 0, page: 1 }));
        load.then(r => { if (alive) { loaded.current = { tab, page: r.page }; setData({ tab, ...r }); } })
            .catch(e => { if (alive) { toast.error(errorText(e)); loaded.current = { tab, page: 1 }; setData({ tab, items: [], total: 0, page: 1 }); } });
        return () => { alive = false; };
    }, [tab, me?.id, rev, stale]);
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
            const d = await api<{ posts: Post[]; total: number; capped?: boolean }>(pagePath(current, next));
            setData(prev => prev && prev.tab === current ? {
                ...prev, items: uniquePosts([...prev.items, ...d.posts]), page: next,
                // An empty page means the list shrank meanwhile: stop offering more.
                total: d.posts.length ? d.total : prev.items.length, capped: !!d.capped && !!d.posts.length, full: d.posts.length === PAGE_SIZE,
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
    async function remind(post: OwnPost) {
        const at = await setBumpRemind(post.id);
        if (at) patchPost(post.id, { remind_at: at });
    }
    // '광고 고정' / '광고 빼기' (WP53): other rows can gain or lose their slot, so the list and the header reload.
    async function setAd(post: OwnPost, pin: boolean) {
        try {
            const d = await api<{ replaced: { id: number; title: string } | null }>(`posts/${post.id}/feature`, 'PUT', { active: pin });
            toast(pin ? `${AD_TEXT.pin} 완료` : `${AD_TEXT.unpin} 완료`);
            if (d.replaced) toast(`‘${d.replaced.title}’ ${AD_TEXT.pin} 해제`);
            setRev(n => n + 1);
            void loadUsage();
        } catch (e) { toast.error(errorText(e)); }
    }
    async function keepAll() {
        try { await api('me/automation/continue', 'POST', {}); void navigate('/me/posts', { replace: true }); }
        catch (e) { toast.error(errorText(e)); }
    }
    const moreButton = data && data.tab === tab && isPostTab(tab) && (data.items.length < data.total || (data.capped && data.full))
        && <button type="button" className="btn btn-line more-btn" disabled={loadingMore} onClick={more}>더 보기</button>;

    return <div className="container page">
        <h1 className="page-title">내 거래</h1>
        <div className="mt-16"><Tabs label="내 거래 메뉴" value={tab} onChange={t => void navigate('/me/' + t, { replace: true })} items={tabs} /></div>
        <div className="mt-24">
            {items === null ? <SkeletonRows count={3} />
                : tab === 'auto' ? <Auto />
                : tab === 'posts' ? <>
                    {stale && <div className="auto-stale mine-stale">
                        <span>{AUTO_TEXT.staleCount(items.length)}</span>
                        <button type="button" className="btn btn-line btn-sm" onClick={() => void keepAll()}>모두 계속</button>
                    </div>}
                    {suspended ? <p className="mine-usage">이용 정지 중입니다. ({suspendUntilText(me.suspended_until!)})</p> : usage && <WalletGauge usage={usage} now={now} className="mine-usage" />}
                    {!suspended && !!usage?.perks.adSlots && <p className="wallet-gauge mine-ad">{AD_TEXT.header(usage.featured.length, usage.perks.adSlots)}</p>}
                    {items.length ? <><ul className="seller-list">{(items as OwnPost[]).map(p => <SellerRow key={p.id} post={p} usage={usage} now={now} busy={busy === p.id}
                        closeOnly={suspended || (p.kind === 'proxy_offer' && !manager && !me.badges.includes('proxy'))} suspended={suspended} onBump={() => void bumpPost(p)} onRemind={() => void remind(p)} onAd={pin => void setAd(p, pin)}
                        onComplete={() => setTradePost({ id: p.id, kind: p.kind, title: p.title, price: p.price, price_mode: p.price_mode, status: p.status, thumb: p.images[0] ?? null, hidden: !!p.hidden })} />)}</ul>
                    {moreButton}</> : <EmptyState icon="file" title="작성한 글이 없습니다" action={<Link to="/write" className="btn btn-primary">글쓰기</Link>} />}
                </>
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
        <CompleteSheet post={tradePost} suspended={suspended} onClose={() => setTradePost(null)} onDone={chatId => {
            if (tradePost?.status === 'closed') { if (chatId) patchPost(tradePost.id, { traded: true }); }
            else if (tradePost) patchPost(tradePost.id, { status: 'closed', closed_at: Date.now(), traded: !!chatId });
            void loadUsage();
        }} />
    </div>;
}
