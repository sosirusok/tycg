import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { KIND_ICONS, KIND_NAMES, listingPrice, type Post } from '../../shared/market';
import { AD_TEXT, gradeInfo, kstDate } from '../../shared/membership';
import { navigate } from '../lib/router';
import { useApp } from '../app/state';
import { MODAL_DAY_KEY } from '../app/TrialPopup';
import { CIcon } from './ui';
import { adHref } from './AdCard';
import { listPhoto, subjectLabel } from './PostCard';

// The home bottom ad card (WP53): one 엘리트 ad from the '엘리트 매물' list GET /api/home already sent
// (no extra request). Not a modal: no overlay, no focus trap, X closes it. The rules live in this
// browser only (localStorage, every access in try/catch; blocked storage means no card):
// - at most once per KST day, never on the first-ever visit's day or the member's sign-up day;
// - never on a day a site modal showed ('modal-day', which the trial popup sets);
// - 3 closes in a row rest it for 7 days; the same post not again within 3 days;
// - never the viewer's own post, never for the manager, never the manager's posts.
// It appears 5 seconds after the page opens or on the first scroll, and leaves with the home page.
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

// The post to show today, or null (and the first-visit day stamped on the very first visit).
function choose(ads: Post[], me: { id: string; role: string; created_at: number } | null, now: number): Post | null {
    const state = load();
    if (!state) return null;
    const today = kstDate(now);
    if (!state.first) { save({ ...state, first: today }); return null; }
    if (state.first === today || state.day === today) return null;
    if (me?.role === 'manager' || (me && kstDate(me.created_at) === today)) return null;
    if (modalDay() === today || (state.restUntil && now < state.restUntil)) return null;
    const seen = state.seen || {};
    return ads.find(p => p.author_id !== me?.id && p.role !== 'manager' && gradeInfo(p.author_grade).rank >= 3 && !((seen[p.id] || 0) > now - SAME_POST_MS)) || null;
}

export function HomeAdCard({ ads }: { ads: Post[] | null }) {
    const { me, ready } = useApp();
    const [pick, setPick] = useState<Post | null>(null), [shown, setShown] = useState(false);
    useEffect(() => {
        if (!ready || !ads) return;
        setPick(choose(ads, me, Date.now()));
    }, [ready, !!ads, me?.id]);
    // 5 seconds after the page opens or the first scroll, whichever comes first, while no dialog is open.
    useEffect(() => {
        if (!pick || shown) return;
        let timer = 0;
        const show = () => {
            window.removeEventListener('scroll', show);
            clearTimeout(timer);
            if (document.querySelector('[role=dialog]')) { timer = window.setTimeout(show, 1000); return; }
            const now = Date.now(), today = kstDate(now), state = load();
            // A modal opened meanwhile (the trial popup): no card today.
            if (!state || modalDay() === today) { setPick(null); return; }
            const seen = Object.fromEntries(Object.entries(state.seen || {}).filter(([, t]) => t > now - SAME_POST_MS));
            save({ ...state, day: today, seen: { ...seen, [pick.id]: now } });
            setShown(true);
        };
        timer = window.setTimeout(show, DELAY_MS);
        window.addEventListener('scroll', show, { passive: true });
        return () => { clearTimeout(timer); window.removeEventListener('scroll', show); };
    }, [pick, shown]);
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
        void navigate(adHref(pick.id));
    };
    const { thumbSrc } = listPhoto(pick);
    return <aside className="home-ad" aria-label={AD_TEXT.home}>
        <button type="button" className="home-ad-body" onClick={open}>
            <span className="home-ad-media">
                {thumbSrc ? <img src={thumbSrc} alt="" /> : <CIcon name={KIND_ICONS[pick.kind]} size={40} />}
                <span className="home-ad-tag">{AD_TEXT.label}</span>
            </span>
            <span className="home-ad-text">
                <span className="home-ad-meta">{AD_TEXT.home} · {KIND_NAMES[pick.kind]} · {subjectLabel(pick)}</span>
                <span className="home-ad-title">{pick.title}</span>
                <span className="home-ad-price"><b>{listingPrice(pick)}</b><span>{pick.nickname}</span></span>
            </span>
        </button>
        <button type="button" className="home-ad-x" aria-label="닫기" onClick={close}><X size={18} /></button>
    </aside>;
}
