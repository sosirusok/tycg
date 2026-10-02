import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronRight, Search, X } from 'lucide-react';
import { KIND_ICONS, KIND_NAMES, TRADE_KINDS, categoriesForKind, dateText, type Post, type TradeKind } from '../../shared/market';
import { AD_TEXT, TRIAL_KEEPS, gradeInfo } from '../../shared/membership';
import { api } from '../lib/api';
import { Link, navigate, withParams } from '../lib/router';
import { useApp } from '../app/state';
import { CIcon } from '../components/ui';
import { MiniCard } from '../components/PostCard';
import { adHref } from '../components/AdCard';
import { HomeAdCard } from '../components/HomeAdCard';


type Notice = { id: number; title: string; created_at: number };

type HomeData = { shelves: Record<'sell' | 'buy' | 'proxy_offer', Post[]>; sellCategory: string; ads: Post[]; cardAds?: Post[]; notices: Notice[] };

// One shelf of the home page. Its first posts come with GET /api/home; a category chip (판매) asks
// the board list for that category.
function Shelf({ title, kind, withCategories = false, empty, initial, initialCategory }: { title: string; kind: TradeKind; withCategories?: boolean; empty: string; initial: Post[] | null; initialCategory?: string }) {
    const { requireLogin, openApply } = useApp();
    const [category, setCategory] = useState(withCategories ? initialCategory || categoriesForKind(kind)[0].id : '');
    const [picked, setPicked] = useState<{ category: string; posts: Post[] | null } | null>(null);
    useEffect(() => {
        if (!picked || picked.posts !== null) return;
        let alive = true;
        api<{ posts: Post[] }>('posts?' + new URLSearchParams({ kind, active: '1', size: '6', category: picked.category }))
            .then(d => { if (alive) setPicked({ category: picked.category, posts: d.posts }); }).catch(() => { if (alive) setPicked({ category: picked.category, posts: [] }); });
        return () => { alive = false; };
    }, [kind, picked]);
    const pick = (id: string) => {
        setCategory(id);
        setPicked(id === (initialCategory || categoriesForKind(kind)[0].id) ? null : { category: id, posts: null });
    };
    const posts = picked ? picked.posts : initial;
    return <section className="section">
        <div className="section-head">
            <h2 className="section-title">{title}</h2>
            <Link to={withParams('/trade', { kind, category })} className="more-link">더보기<ChevronRight size={16} /></Link>
        </div>
        {withCategories && <div className="chip-scroll shelf-chips">{categoriesForKind(kind).map(c => <button key={c.id} type="button" className="chip chip-sm" aria-pressed={category === c.id} onClick={() => pick(c.id)}>{c.name}</button>)}</div>}
        {posts === null ? <div className="card-grid">{[0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: 190 }} />)}</div>
            : posts.length ? <div className="card-grid">{posts.map(p => <MiniCard key={p.id} post={p} />)}</div>
            : <div className="shelf-empty"><p>{empty}</p><button type="button" className="btn btn-line btn-sm" onClick={() => requireLogin(u => {
                if (kind === 'proxy_offer' && u.role !== 'manager' && !u.badges.includes('proxy')) openApply({ kind: 'badge', target: 'proxy' });
                else void navigate(withParams('/write', { kind, category }));
            })}>글쓰기</button></div>}
    </section>;
}

// '엘리트 매물' (WP53): up to 6 ads of 엘리트 members (and above), one per member, rotated every 10
// minutes by the server. The row is left out while there are none.
function EliteShelf({ posts }: { posts: Post[] }) {
    if (!posts.length) return null;
    return <section className="section elite-row" aria-label={AD_TEXT.home}>
        <div className="section-head"><h2 className="section-title">{AD_TEXT.home}</h2><span className="ad-label">{AD_TEXT.label}</span></div>
        <div className="card-grid">{posts.map(p => <MiniCard key={p.id} post={p} href={adHref(p.id)} />)}</div>
    </section>;
}

// The home band once a 플러스 무료 체험 has ended (shown once: closing it stamps the trial row).
function TrialEndBand() {
    const { trial, setTrial, openApply } = useApp();
    const close = () => {
        if (trial) setTrial({ ...trial, ended: false });
        api('me/trial-ended-seen', 'POST', {}).catch(() => {});
    };
    return <section className="home-band" aria-label="플러스 무료 체험">
        <span className="home-band-text">
            <strong>플러스 무료 체험이 끝났습니다.</strong>
            <span>{TRIAL_KEEPS}</span>
        </span>
        <button type="button" className="btn btn-primary btn-sm home-band-cta" onClick={() => openApply({ kind: 'grade', target: 'plus', plan: 'permanent' })}>플러스 신청</button>
        <button type="button" className="home-band-x" aria-label="닫기" onClick={close}><X size={20} /></button>
    </section>;
}

// The 등급 안내 띠 can be closed for 30 days (tier table: 보임, 닫기 30일), remembered in this browser only.
const PROMO_KEY = 'home-promo-closed', PROMO_HIDE_MS = 30 * 86400000;
function promoClosed() {
    try { const at = Number(localStorage.getItem(PROMO_KEY)); return at > 0 && Date.now() - at < PROMO_HIDE_MS; } catch { return false; }
}

export function Home() {
    const { me, ready, config, trial, openAuth } = useApp();
    const [q, setQ] = useState('');
    // The whole page in one request (GET /api/home), sent at once: the server reads the session from
    // the cookie, so it already follows the member's blocks. It is sent again only when the member
    // signs in or out on this page. A failed request shows empty shelves.
    const [home, setHome] = useState<HomeData | null>(null);
    const loadedFor = useRef<string | null>(null), requests = useRef(0);
    const viewer = ready ? me?.id || '' : null;
    useEffect(() => {
        if (loadedFor.current !== null && (viewer === null || viewer === loadedFor.current)) return;
        if (loadedFor.current === 'cookie' && viewer !== null) { loadedFor.current = viewer; return; }
        loadedFor.current = viewer ?? 'cookie';
        // Only the latest request may fill the page.
        const n = ++requests.current;
        api<HomeData>('home').then(d => { if (n === requests.current) setHome(d); })
            .catch(() => { if (n === requests.current) setHome({ shelves: { sell: [], buy: [], proxy_offer: [] }, sellCategory: '', ads: [], notices: [] }); });
    }, [viewer]);
    const notices = home?.notices || [];
    const search = (e: FormEvent) => { e.preventDefault(); void navigate(withParams('/trade', { q: q.trim() })); };
    // The grade promo is for guests and members below 프리미엄; it waits for the session check so a
    // 프리미엄 member never sees it flash.
    const promo = ready && me?.role !== 'manager' && gradeInfo(me?.grade).rank < 2;
    const [promoHidden, setPromoHidden] = useState(promoClosed);
    const closePromo = () => {
        setPromoHidden(true);
        try { localStorage.setItem(PROMO_KEY, String(Date.now())); } catch { /* storage blocked: hidden for this visit */ }
    };

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
            {me && trial?.ended ? <TrialEndBand />
                // Guests while the sign-up event runs: the band in the promo's place opens 회원가입.
                : ready && !me && config.trial?.open ? <button type="button" className="promo" onClick={() => openAuth('register')}>
                    <span className="promo-text">
                        <span className="promo-eyebrow">신규 가입 이벤트</span>
                        <strong>가입하면 플러스 7일 무료</strong>
                    </span>
                    <span className="promo-cta">회원가입<ChevronRight size={18} /></span>
                </button>
                : promo && !promoHidden && <div className="promo-wrap">
                    <Link to="/guide#grade" className="promo">
                        <span className="promo-text">
                            <span className="promo-eyebrow">등급 혜택</span>
                            <strong>{gradeInfo(me?.grade).rank >= 1 ? `프리미엄부터 ${AD_TEXT.box}` : '플러스부터 자동 끌올'}</strong>
                        </span>
                        <span className="promo-cta">혜택 보기<ChevronRight size={18} /></span>
                    </Link>
                    <button type="button" className="promo-x" aria-label="닫기" onClick={closePromo}><X size={18} /></button>
                </div>}

            <EliteShelf posts={home?.ads || []} />
            <Shelf key={'sell' + (home ? 1 : 0)} title="판매 최신글" kind="sell" withCategories empty="등록된 글이 없습니다." initial={home?.shelves.sell ?? null} initialCategory={home?.sellCategory} />
            <Shelf title="구매 최신글" kind="buy" empty="등록된 글이 없습니다." initial={home?.shelves.buy ?? null} />
            <Shelf title="대리(진행) 최신글" kind="proxy_offer" empty="등록된 글이 없습니다." initial={home?.shelves.proxy_offer ?? null} />

            <section className="section">
                <div className="section-head"><h2 className="section-title">공지사항</h2><Link to="/guide" className="more-link">더보기<ChevronRight size={16} /></Link></div>
                {notices.length ? <ol className="notice-list">{notices.map((n, i) => <li key={n.id}><Link to={'/guide#notice-' + n.id}><b>{i + 1}</b><span className="grow">{n.title}</span><span className="muted small nowrap">{dateText(n.created_at)}</span></Link></li>)}</ol>
                    : <p className="muted">등록된 공지가 없습니다.</p>}
            </section>
        </div>
        <HomeAdCard ads={home ? home.cardAds || [] : null} />
    </div>;
}
