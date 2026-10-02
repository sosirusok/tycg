import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { KIND_ICONS, KIND_NAMES, listingPrice, type Post } from '../../shared/market';
import { AD_TEXT, PROVIDER_TEXT, gradeInfo, kstDate } from '../../shared/membership';
import { navigate } from '../lib/router';
import { useApp } from '../app/state';
import { MODAL_DAY_KEY } from '../app/TrialPopup';
import { Icon } from './ui';
import { adHref } from './AdCard';
import { listPhoto, subjectLabel } from './PostCard';
import { ProviderMini, openProviderChat, type ProviderItem } from './ProviderCard';

// One item of the card (GET /api/home card): an 엘리트 ad post or a listed 엘리트·관리자 provider of the
// '중개/가측' tab (WP66), each eligible member weighted the same by the server.
export type CardItem = { post: Post } | { provider: ProviderItem };
const keyOf = (x: CardItem) => 'post' in x ? String(x.post.id) : 'u:' + x.provider.id;

// The home bottom ad card (WP53): one 엘리트 ad from card (WP66: ad posts and 엘리트·관리자 providers), which GET
// /api/home already sent (no extra request) and which never holds a post of the '엘리트 매물' row. It shows only while that row is off
// screen, so the two ad areas never share a screen and the card never covers the row. Not a modal: no
// overlay, no focus trap, X closes it. The rules live in this browser only (localStorage, every access in
// try/catch; blocked storage means no card):
// - at most once per KST day, never on the first-ever visit's day or the member's sign-up day;
// - never on a day a site modal showed ('modal-day', which the trial popup sets);
// - 3 closes in a row rest it for 7 days; the same post not again within 3 days;
// - never the viewer's own post, never for the manager, never the manager's posts.
// It appears 5 seconds after the page opens or on the first scroll (once the row is off screen), and
// leaves with the home page.
const KEY = 'home-ad';
const DAY = 86400000, REST_MS = 7 * DAY, SAME_POST_MS = 3 * DAY, CLOSES_TO_REST = 3, DELAY_MS = 5000;
type State = { first?: string; day?: string; closes?: number; restUntil?: number; seen?: Record<string, number> };

function load(): State | null {
    try { const v = JSON.parse(localStorage.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return null; }
}
function save(s: State) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked: nothing is remembered */ }
}
function modalDay() {
    try { return localStorage.getItem(MODAL_DAY_KEY); } catch { return null; }
}
// Whether the home '엘리트 매물' row (Home's EliteShelf) is on screen now.
function rowInView() {
    const row = document.querySelector('.elite-row');
    if (!row) return false;
    const r = row.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
}

// The item to show today, or null (and the first-visit day stamped on the very first visit).
function choose(items: CardItem[], me: { id: string; role: string; created_at: number } | null, now: number): CardItem | null {
    const state = load();
    if (!state) return null;
    const today = kstDate(now);
    if (!state.first) { save({ ...state, first: today }); return null; }
    if (state.first === today || state.day === today) return null;
    if (me?.role === 'manager' || (me && kstDate(me.created_at) === today)) return null;
    if (modalDay() === today || (state.restUntil && now < state.restUntil)) return null;
    const seen = state.seen || {};
    return items.find(x => !((seen[keyOf(x)] || 0) > now - SAME_POST_MS) && ('post' in x
        ? x.post.author_id !== me?.id && x.post.role !== 'manager' && gradeInfo(x.post.author_grade).rank >= 3
        : x.provider.id !== me?.id && gradeInfo(x.provider.grade).rank >= 3)) || null;
}

export function HomeAdCard({ items }: { items: CardItem[] | null }) {
    const { me, ready, requireLogin } = useApp();
    const [pick, setPick] = useState<CardItem | null>(null), [shown, setShown] = useState(false), [covered, setCovered] = useState(false);
    useEffect(() => {
        if (!ready || !items) return;
        setPick(choose(items, me, Date.now()));
    }, [ready, !!items, me?.id]);
    // 5 seconds after the page opens or the first scroll, whichever comes first, while no dialog is open
    // and the '엘리트 매물' row is off screen.
    useEffect(() => {
        if (!pick || shown) return;
        let timer = 0;
        const show = () => {
            window.removeEventListener('scroll', show);
            clearTimeout(timer);
            if (document.querySelector('[role=dialog]') || rowInView()) { timer = window.setTimeout(show, 1000); return; }
            const now = Date.now(), today = kstDate(now), state = load();
            // A modal opened meanwhile (the trial popup): no card today.
            if (!state || modalDay() === today) { setPick(null); return; }
            const seen = Object.fromEntries(Object.entries(state.seen || {}).filter(([, t]) => t > now - SAME_POST_MS));
            save({ ...state, day: today, seen: { ...seen, [keyOf(pick)]: now } });
            setShown(true);
        };
        timer = window.setTimeout(show, DELAY_MS);
        window.addEventListener('scroll', show, { passive: true });
        return () => { clearTimeout(timer); window.removeEventListener('scroll', show); };
    }, [pick, shown]);
    // Once shown, the card steps aside (hidden, not closed) while the row is back on screen.
    useEffect(() => {
        if (!shown) return;
        const check = () => setCovered(rowInView());
        check();
        window.addEventListener('scroll', check, { passive: true });
        window.addEventListener('resize', check);
        return () => { window.removeEventListener('scroll', check); window.removeEventListener('resize', check); };
    }, [shown]);
    if (!pick || !shown) return null;
    const close = () => {
        const state = load() || {}, closes = (state.closes || 0) + 1;
        save(closes >= CLOSES_TO_REST ? { ...state, closes: 0, restUntil: Date.now() + REST_MS } : { ...state, closes });
        setShown(false);
        setPick(null);
    };
    const open = () => {
        const state = load();
        if (state) save({ ...state, closes: 0 });
        if ('post' in pick) void navigate(adHref(pick.post.id));
        else openProviderChat(pick.provider, pick.provider.type || 'broker', requireLogin);
    };
    // A provider: the gold mini card that opens the chat with the 문의 template (WP66 item 12).
    if ('provider' in pick) return <aside className={'home-ad home-ad-provider' + (covered ? ' is-covered' : '')} aria-label={PROVIDER_TEXT.tab}>
        <button type="button" className="home-ad-body" onClick={open}>
            <ProviderMini p={pick.provider} ad={AD_TEXT.label} />
        </button>
        <button type="button" className="home-ad-x" aria-label="닫기" onClick={close}><X size={18} /></button>
    </aside>;
    const post = pick.post, { thumbSrc } = listPhoto(post);
    return <aside className={'home-ad' + (covered ? ' is-covered' : '')} aria-label={AD_TEXT.home}>
        <button type="button" className="home-ad-body" onClick={open}>
            <span className="home-ad-media">
                {thumbSrc ? <img src={thumbSrc} alt="" /> : <Icon name={KIND_ICONS[post.kind]} size={32} />}
                <span className="home-ad-tag">{AD_TEXT.label}</span>
            </span>
            <span className="home-ad-text">
                <span className="home-ad-meta">{AD_TEXT.home} · {KIND_NAMES[post.kind]} · {subjectLabel(post)}</span>
                <span className="home-ad-title">{post.title}</span>
                <span className="home-ad-price"><b>{listingPrice(post)}</b><span>{post.nickname}</span></span>
            </span>
        </button>
        <button type="button" className="home-ad-x" aria-label="닫기" onClick={close}><X size={18} /></button>
    </aside>;
}
