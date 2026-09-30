import { useEffect, useState, type FormEvent } from 'react';
import { ChevronRight, PenLine, Search } from 'lucide-react';
import { KIND_ICONS, KIND_NAMES, TRADE_KINDS, categoriesForKind, dateText, relativeTime, tagName, type Post, type TradeKind } from '../../shared/market';
import { api } from '../lib/api';
import { Link, navigate, withParams } from '../lib/router';
import { useApp } from '../app/state';
import { CIcon, NameLine } from '../components/ui';
import { PriceLine, postSummary, tradeLabel } from '../components/PostCard';


type Notice = { id: number; title: string; body: string; created_at: number };

function MiniCard({ post }: { post: Post }) {
    const summary = postSummary(post);
    const tags = post.tags.slice(0, 2).map(tagName);
    return <Link to={'/posts/' + post.id} className="mini-card">
        <div className="post-card-meta"><CIcon name={KIND_ICONS[post.kind]} size={18} /><span>{tradeLabel(post)}</span></div>
        <h3>{post.title}</h3>
        {(tags.length > 0 || summary.length > 0) && <div className="post-card-specs">{tags.map(t => <span className="tag" key={t}>{t}</span>)}{summary.length > 0 && <span className="spec">{summary.slice(0, 2).join(' · ')}</span>}</div>}
        <PriceLine post={post} />
        <div className="post-card-author"><NameLine nickname={post.nickname} grade={post.author_grade} role={post.role} badges={post.author_badges} /><span className="muted small nowrap">{relativeTime(post.created_at)}</span></div>
    </Link>;
}

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

export function Home() {
    const { openApply, requireLogin, me } = useApp();
    const [q, setQ] = useState('');
    const [notices, setNotices] = useState<Notice[]>([]);
    useEffect(() => { api<{ notices: Notice[] }>('notices').then(d => setNotices(d.notices.slice(0, 4))).catch(() => {}); }, []);
    const search = (e: FormEvent) => { e.preventDefault(); void navigate(withParams('/trade', { q: q.trim() })); };
    const proxyReady = me?.role === 'manager' || me?.badges.includes('proxy');

    return <div className="home">
        <section className="container hero">
            <h1>어떤 거래를 찾으세요?</h1>
            <form className="hero-search" onSubmit={search} role="search">
                <label className="search-input grow"><Search size={20} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="스킨, 제목, 닉네임 (예: 악주, 뱀동)" aria-label="거래 검색" /></label>
                <button type="button" className="btn btn-soft hero-write" onClick={() => requireLogin(() => void navigate('/write'))}><PenLine size={18} />거래 등록</button>
            </form>
            <nav className="quick-row" aria-label="거래 종류">
                {TRADE_KINDS.map(kind => <Link key={kind} to={withParams('/trade', { kind })} className="quick-item"><CIcon name={KIND_ICONS[kind]} size={44} /><span>{KIND_NAMES[kind]}</span></Link>)}
                <Link to="/guide" className="quick-item"><CIcon name="megaphone" size={44} /><span>공지</span></Link>
                <button type="button" className="quick-item" onClick={() => openApply()}><CIcon name="check-mark-button" size={44} /><span>인증/등급</span></button>
            </nav>
        </section>

        <div className="container">
            <button type="button" className="promo" onClick={() => proxyReady ? void navigate('/write?kind=proxy_offer&category=ladder') : openApply({ kind: 'badge', target: 'proxy' })}>
                <span className="promo-text">
                    <span className="promo-eyebrow">대리(진행) 게시판</span>
                    <strong>{proxyReady ? '대리 인증 완료' : '대리(진행) 글쓰기는 대리 인증 필요'}</strong>
                </span>
                <span className="promo-cta">{proxyReady ? '진행 글 쓰기' : '대리 인증 신청'}<ChevronRight size={18} /></span>
                <CIcon name={proxyReady ? 'check-mark-button' : KIND_ICONS.proxy_offer} size={84} />
            </button>

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
