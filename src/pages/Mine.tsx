import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { priceText, relativeTime, type Post } from '../../shared/market';
import { APPLICATION_STATUS_NAMES, applicationTitle, type Application } from '../../shared/membership';
import { api, errorText } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { useApp } from '../app/state';
import { EmptyState, NameLine, SkeletonRows, Tabs } from '../components/ui';
import { PostCard } from '../components/PostCard';

const TABS = [
    { id: 'posts', label: '내 글' }, { id: 'favorites', label: '찜한 글' }, { id: 'offers', label: '가격 제시' },
    { id: 'recent', label: '최근 본 글' }, { id: 'applications', label: '신청 내역' }, { id: 'blocks', label: '차단' },
] as const;
type TabId = typeof TABS[number]['id'];

type Offer = {
    id: string; post_id: number; title: string; amount: number; status: string; sender_id: string; sender_name: string; recipient_name: string; conversation_id: string; created_at: number;
    sender_grade: string; sender_badges: string[]; recipient_grade: string; recipient_badges: string[];
};
const OFFER_STATUS: Record<string, string> = { pending: '대기', accepted: '수락', declined: '거절', withdrawn: '취소', cancelled: '마감' };

export default function Mine({ tab: raw }: { tab?: string }) {
    const { me, ready, requireLogin, openApply } = useApp();
    const tab: TabId = TABS.some(t => t.id === raw) ? raw as TabId : 'posts';
    const [rev, setRev] = useState(0);
    const [data, setData] = useState<{ tab: string; items: any[] } | null>(null);
    useEffect(() => { if (ready && !me) requireLogin(); }, [ready, me, requireLogin]);
    useEffect(() => {
        if (!me) return;
        let alive = true;
        const path = tab === 'posts' ? 'posts?' + new URLSearchParams({ author: me.id, size: '40' })
            : tab === 'favorites' || tab === 'recent' ? 'posts?' + new URLSearchParams({ scope: tab, size: '40' })
            : tab;
        api<any>(path).then(d => { if (alive) setData({ tab, items: d.posts || d.offers || d.applications || d.blocks || [] }); }).catch(e => { if (alive) { toast.error(errorText(e)); setData({ tab, items: [] }); } });
        return () => { alive = false; };
    }, [tab, me?.id, rev]);

    if (!me) return <div className="container page"><EmptyState icon="key" title="로그인이 필요합니다" action={<button className="btn btn-primary" onClick={() => requireLogin()}>로그인</button>} /></div>;
    const items = data?.tab === tab ? data.items : null;

    async function unblock(id: string) {
        try { await api('blocks', 'POST', { userId: id, active: false }); toast('차단 해제'); setRev(n => n + 1); } catch (e) { toast.error(errorText(e)); }
    }

    return <div className="container page">
        <h1 className="page-title">내 거래</h1>
        <div className="mt-16"><Tabs label="내 거래 메뉴" value={tab} onChange={t => void navigate('/me/' + t, { replace: true })} items={[...TABS]} /></div>
        <div className="mt-24">
            {items === null ? <SkeletonRows count={3} />
                : (tab === 'posts' || tab === 'favorites' || tab === 'recent') ? (items.length ? <div className="post-list">{(items as Post[]).map(p => <PostCard key={p.id} post={p} onChange={() => setRev(n => n + 1)} />)}</div>
                    : <EmptyState icon={tab === 'favorites' ? 'red-heart' : undefined} title={tab === 'posts' ? '작성한 글이 없습니다' : tab === 'favorites' ? '찜한 글이 없습니다' : '최근 본 글이 없습니다'} action={tab === 'posts' ? <Link to="/write" className="btn btn-primary">글쓰기</Link> : <Link to="/trade?kind=buy" className="btn btn-line">거래 둘러보기</Link>} />)
                : tab === 'offers' ? (items.length ? <ul className="simple-list">{(items as Offer[]).map(o => <li key={o.id}>
                    <span className="grow"><Link to={'/posts/' + o.post_id} className="strong-link">{o.title}</Link><span className="muted small">{o.sender_id === me.id ? <>보낸 제시 · <NameLine nickname={o.recipient_name} grade={o.recipient_grade} badges={o.recipient_badges} /></> : <>받은 제시 · <NameLine nickname={o.sender_name} grade={o.sender_grade} badges={o.sender_badges} /></>}<span className="nowrap">{'\u00a0'}· {relativeTime(o.created_at)}</span></span></span>
                    <b>{priceText(o.amount)}</b><span className="event-status">{OFFER_STATUS[o.status] || o.status}</span>
                    <Link to={'/chat/' + o.conversation_id} className="btn btn-line btn-xs">채팅</Link>
                </li>)}</ul> : <EmptyState icon="money-with-wings" title="제시 내역이 없습니다" />)
                : tab === 'applications' ? (items.length ? <ul className="simple-list">{(items as Application[]).map(a => <li key={a.id}>
                    <span className="grow"><strong>{applicationTitle(a)}</strong><span className="muted small">{relativeTime(a.created_at)}{a.note ? ` · ${a.note}` : ''}</span></span>
                    <span className={'event-status st-' + a.status}>{APPLICATION_STATUS_NAMES[a.status]}</span>
                    {a.conversation_id && <Link to={'/chat/' + a.conversation_id} className="btn btn-line btn-xs">채팅</Link>}
                </li>)}</ul> : <EmptyState icon="check-mark-button" title="신청 내역이 없습니다" action={me.role !== 'manager' ? <button className="btn btn-primary" onClick={() => openApply()}>인증/등급 신청하기</button> : undefined} />)
                : (items.length ? <ul className="simple-list">{items.map((b: { target_id: string; nickname: string; grade: string; badges: string[] }) => <li key={b.target_id}><span className="grow"><Link to={'/profile/' + b.target_id} className="strong-link"><NameLine nickname={b.nickname} grade={b.grade} badges={b.badges} /></Link></span><button type="button" className="btn btn-line btn-xs" onClick={() => unblock(b.target_id)}>차단 해제</button></li>)}</ul>
                    : <EmptyState icon="shield" title="차단한 회원이 없습니다" />)}
        </div>
    </div>;
}
