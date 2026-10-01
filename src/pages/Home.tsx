import { useEffect, useState, type FormEvent } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { KIND_ICONS, KIND_NAMES, TRADE_KINDS, categoriesForKind, dateText, type Post, type TradeKind } from '../../shared/market';
import { gradeInfo } from '../../shared/membership';
import { api } from '../lib/api';
import { Link, navigate, withParams } from '../lib/router';
import { useApp } from '../app/state';
import { CIcon } from '../components/ui';
import { MiniCard } from '../components/PostCard';


type Notice = { id: number; title: string; body: string; created_at: number };

function Shelf({ title, kind, withCategories = false, empty }: { title: string; kind: TradeKind; withCategories?: boolean; empty: string }) {
    const { requireLogin, openApply } = useApp();
    const [category, setCategory] = useState(withCategories ? categoriesForKind(kind)[0].id : '');
    const [posts, setPosts] = useState<Post[] | null>(null);
    useEffect(() => {
        let alive = true;
        setPosts(null);
        api<{ posts: Post[] }>('posts?' + new URLSearchParams({ kind, active: '1', size: '6', ...(category ? { category } : {}) }))
            .then(d => { if (alive) setPosts(d.posts); }).catch(() => { if (alive) setPosts([]); });
        return () => { alive = false; };
    }, [kind, category]);
    return <section className="section">
        <div className="section-head">
            <h2 className="section-title">{title}</h2>
            <Link to={withParams('/trade', { kind, category })} className="more-link">더보기<ChevronRight size={16} /></Link>
        </div>
        {withCategories && <div className="chip-scroll shelf-chips">{categoriesForKind(kind).map(c => <button key={c.id} type="button" className="chip chip-sm" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>{c.name}</button>)}</div>}
        {posts === null ? <div className="card-grid">{[0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: 190 }} />)}</div>
            : posts.length ? <div className="card-grid">{posts.map(p => <MiniCard key={p.id} post={p} />)}</div>
            : <div className="shelf-empty"><p>{empty}</p><button type="button" className="btn btn-line btn-sm" onClick={() => requireLogin(u => {
                if (kind === 'proxy_offer' && u.role !== 'manager' && !u.badges.includes('proxy')) openApply({ kind: 'badge', target: 'proxy' });
                else void navigate(withParams('/write', { kind, category }));
            })}>글쓰기</button></div>}
    </section>;
}

// '추천 매물': posts that 엘리트 members (and the manager) put on the home page, across every board.
// The row is left out while there are none.
function FeaturedShelf() {
    const [posts, setPosts] = useState<Post[]>([]);
    useEffect(() => {
        let alive = true;
        api<{ posts: Post[] }>('posts?featured=home&size=6').then(d => { if (alive) setPosts(d.posts); }).catch(() => {});
        return () => { alive = false; };
    }, []);
    if (!posts.length) return null;
    return <section className="section">
        <div className="section-head"><h2 className="section-title">추천 매물</h2></div>
        <div className="card-grid">{posts.map(p => <MiniCard key={p.id} post={p} />)}</div>
    </section>;
}

export function Home() {
    const { me, ready } = useApp();
    const [q, setQ] = useState('');
    const [notices, setNotices] = useState<Notice[]>([]);
    useEffect(() => { api<{ notices: Notice[] }>('notices').then(d => setNotices(d.notices.slice(0, 4))).catch(() => {}); }, []);
    const search = (e: FormEvent) => { e.preventDefault(); void navigate(withParams('/trade', { q: q.trim() })); };
    // The grade promo is for guests and members below 프리미엄; it waits for the session check so a
    // 프리미엄 member never sees it flash.
    const promo = ready && me?.role !== 'manager' && gradeInfo(me?.grade).rank < 2;

    return <div className="home">
        <section className="container hero">
            <h1>어떤 거래를 찾으세요?</h1>
            <form className="hero-search" onSubmit={search} role="search">
                <label className="search-input grow"><Search size={20} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="스킨, 제목, 닉네임 (예: 악주, 뱀동)" aria-label="거래 검색" /></label>
            </form>
            <nav className="quick-row" aria-label="거래 종류">
                {TRADE_KINDS.map(kind => <Link key={kind} to={withParams('/trade', { kind })} className="quick-item"><CIcon name={KIND_ICONS[kind]} size={40} /><span>{KIND_NAMES[kind]}</span></Link>)}
            </nav>
        </section>

        <div className="container">
            {promo && <Link to="/guide#grade" className="promo">
                <span className="promo-text">
                    <span className="promo-eyebrow">등급 혜택</span>
                    <strong>프리미엄부터 게시판 상단 노출</strong>
                </span>
                <span className="promo-cta">혜택 보기<ChevronRight size={18} /></span>
            </Link>}

            <FeaturedShelf />
            <Shelf title="판매 최신글" kind="sell" withCategories empty="등록된 글이 없습니다." />
            <Shelf title="구매 최신글" kind="buy" empty="등록된 글이 없습니다." />
            <Shelf title="대리(진행) 최신글" kind="proxy_offer" empty="등록된 글이 없습니다." />

            <section className="section">
                <div className="section-head"><h2 className="section-title">공지사항</h2><Link to="/guide" className="more-link">더보기<ChevronRight size={16} /></Link></div>
                {notices.length ? <ol className="notice-list">{notices.map((n, i) => <li key={n.id}><Link to={'/guide#notice-' + n.id}><b>{i + 1}</b><span className="grow">{n.title}</span><span className="muted small nowrap">{dateText(n.created_at)}</span></Link></li>)}</ol>
                    : <p className="muted">등록된 공지가 없습니다.</p>}
            </section>
        </div>
    </div>;
}
