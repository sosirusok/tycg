import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { User } from '../../shared/market';
import { LATEST_SEASON } from '../../shared/market';
import type { ApplicationKind, PlanId, TrialState } from '../../shared/membership';
import { toast } from 'sonner';
import { LOGIN_REQUIRED, UNAUTHORIZED_EVENT, api, errorText, setPhotoStorage, type PhotoStorage } from '../lib/api';
import { navigate } from '../lib/router';

export type SiteConfig = { latestSeason: number; paymentNotice: string; manager: { id: string; nickname: string } | null; trial?: { open: boolean; endsAt: number | null }; storage?: PhotoStorage; blockedLinks?: string[] };
export type ApplyPreset = { kind: ApplicationKind; target: string; plan?: PlanId };

type AppState = {
    me: User | null;
    ready: boolean;
    // The member's own 플러스 무료 체험 state (auth/me and the sign-up response); null for guests.
    trial: TrialState | null;
    setTrial: (t: TrialState | null) => void;
    config: SiteConfig;
    unread: number;
    // Unread 알림 (WP50), from the same poll as the chat count.
    alerts: number;
    setAlerts: (n: number | ((n: number) => number)) => void;
    setMe: (u: User | null) => void;
    refreshMe: () => Promise<void>;
    refreshUnread: () => void;
    refreshConfig: () => void;
    // Runs `next` right away when signed in; otherwise opens the login dialog and runs it
    // after login with the member who just signed in.
    requireLogin: (next?: (u: User) => void) => boolean;
    authMode: '' | 'login' | 'register';
    openAuth: (mode: 'login' | 'register') => void;
    closeAuth: () => void;
    finishAuth: (u: User, trial?: TrialState | null) => void;
    apply: ApplyPreset | 'open' | null;
    openApply: (preset?: ApplyPreset) => void;
    closeApply: () => void;
    logout: () => Promise<void>;
};

const Ctx = createContext<AppState>(null!);
const memberKey = (u: User) => JSON.stringify([u.id, u.nickname, u.bio, u.role, u.grade, u.grade_expires_at, u.grade_trial, u.badges, u.suspended_until]);
export const useApp = () => useContext(Ctx);

// The tab title: '(2) 판매 · 좀비고 거래소' while two chats and 알림 together are unread.
const SITE_NAME = '좀비고 거래소';
let pageTitle = SITE_NAME, unreadCount = 0;
const applyTitle = () => { document.title = (unreadCount > 0 ? `(${unreadCount}) ` : '') + pageTitle; };
export function setPageTitle(name: string) {
    pageTitle = name ? `${name} · ${SITE_NAME}` : SITE_NAME;
    applyTitle();
}

// Adaptive polling (WP42): every 30 s while the member did something in the last 5 minutes, then
// every 120 s, and nothing after 30 idle minutes or while the tab is hidden, until the member comes
// back (pointer, keys, focus or the tab shown again), which also polls at once.
const POLL_ACTIVE = 30000, POLL_IDLE = 120000, ACTIVE_FOR = 5 * 60000, STOP_AFTER = 30 * 60000;
let lastActive = Date.now();
const sleepers = new Set<() => void>();
function markActive() {
    lastActive = Date.now();
    if (!document.hidden && sleepers.size) [...sleepers].forEach(wake => wake());
}
if (typeof window !== 'undefined') {
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) window.addEventListener(type, markActive, { passive: true, capture: true });
    window.addEventListener('focus', markActive);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) markActive(); });
}

// Calls `poll` on that schedule while `enabled`; the first call is up to the caller.
export function useAdaptivePoll(poll: () => void, enabled: boolean) {
    const ref = useRef(poll);
    ref.current = poll;
    useEffect(() => {
        if (!enabled) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const schedule = () => {
            const idle = Date.now() - lastActive;
            timer = setTimeout(tick, idle < ACTIVE_FOR ? POLL_ACTIVE : POLL_IDLE);
        };
        const tick = () => {
            timer = undefined;
            if (document.hidden || Date.now() - lastActive > STOP_AFTER) { sleepers.add(wake); return; }
            ref.current();
            schedule();
        };
        const wake = () => {
            sleepers.delete(wake);
            ref.current();
            if (timer === undefined) schedule();
        };
        schedule();
        return () => { if (timer !== undefined) clearTimeout(timer); sleepers.delete(wake); };
    }, [enabled]);
}

const defaultConfig: SiteConfig = { latestSeason: LATEST_SEASON, paymentNotice: '', manager: null };

export function AppProvider({ children }: { children: ReactNode }) {
    const [me, setMe] = useState<User | null>(null);
    const [ready, setReady] = useState(false);
    const [trial, setTrial] = useState<TrialState | null>(null);
    const [config, setSiteConfig] = useState<SiteConfig>(defaultConfig);
    // The photo store decides how far photos are shrunk before upload (lib/api compress).
    const setConfig = useCallback((c: SiteConfig) => { setPhotoStorage(c.storage); setSiteConfig(c); }, []);
    const [unread, setUnread] = useState(0);
    const [alerts, setAlerts] = useState(0);
    const [authMode, setAuthMode] = useState<'' | 'login' | 'register'>('');
    const [apply, setApply] = useState<ApplyPreset | 'open' | null>(null);
    const pending = useRef<((u: User) => void) | null>(null);

    // Keeps the same object when nothing changed, so effects that depend on `me` do not rerun.
    const updateMe = useCallback((next: User | null) => {
        setMe(prev => prev && next && memberKey(prev) === memberKey(next) ? prev : next);
    }, []);
    const refreshMe = useCallback(async () => {
        const d = await api<{ user: User | null; trial?: TrialState | null }>('auth/me');
        updateMe(d.user);
        setTrial(d.trial ?? null);
    }, [updateMe]);
    const refreshConfig = useCallback(() => { api<SiteConfig>('config').then(setConfig).catch(() => {}); }, [setConfig]);

    useEffect(() => {
        Promise.all([refreshMe(), api<SiteConfig>('config').then(setConfig)]).catch(() => {}).finally(() => setReady(true));
    }, [refreshMe]);

    const signedIn = !!me;
    // The unread count also brings the member's current badges and grade, so a grant
    // from the manager appears without reloading the page.
    const refreshUnread = useCallback(() => {
        if (!signedIn) { setUnread(0); setAlerts(0); return; }
        api<{ unread: number; alerts?: number; user: User }>('chats/unread').then(d => { setUnread(d.unread); setAlerts(d.alerts || 0); updateMe(d.user); }).catch(() => {});
    }, [signedIn, updateMe]);

    // At sign-in, then on the adaptive schedule above (keeps Worker requests low).
    useEffect(() => {
        if (!signedIn) { setUnread(0); setAlerts(0); return; }
        refreshUnread();
    }, [signedIn, refreshUnread]);
    useAdaptivePoll(refreshUnread, signedIn);

    useEffect(() => { unreadCount = unread + alerts; applyTitle(); }, [unread, alerts]);

    // api() reports a 401 (the session ended or was signed out elsewhere): sign out on the page too.
    const meRef = useRef(me);
    meRef.current = me;
    useEffect(() => {
        const onUnauthorized = () => {
            if (!meRef.current) return;
            meRef.current = null;
            setMe(null);
            setTrial(null);
            setUnread(0);
            setAlerts(0);
            setAuthMode('login');
            // The failed action usually shows the same message already; one toast is enough.
            setTimeout(() => {
                if (!toast.getToasts().some(t => 'title' in t && t.title === LOGIN_REQUIRED)) toast.error(LOGIN_REQUIRED);
            }, 0);
        };
        window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
        return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    }, []);

    const requireLogin = useCallback((next?: (u: User) => void) => {
        if (me) { next?.(me); return true; }
        pending.current = next || null;
        setAuthMode('login');
        return false;
    }, [me]);

    const finishAuth = useCallback((u: User, t?: TrialState | null) => {
        setMe(u);
        setTrial(t ?? null);
        setAuthMode('');
        const next = pending.current;
        pending.current = null;
        if (next) setTimeout(() => next(u), 0);
    }, []);

    const logout = useCallback(async () => {
        try { await api('auth/logout', 'POST', {}); setMe(null); setTrial(null); void navigate('/'); toast('로그아웃 완료'); }
        catch (e) { toast.error(errorText(e)); }
    }, []);

    const value = useMemo<AppState>(() => ({
        me, ready, trial, setTrial, config, unread, alerts, setAlerts, setMe, refreshMe, refreshUnread, refreshConfig, requireLogin,
        authMode, openAuth: setAuthMode, closeAuth: () => { pending.current = null; setAuthMode(''); }, finishAuth,
        apply, openApply: preset => setApply(preset || 'open'), closeApply: () => setApply(null), logout,
    }), [me, ready, trial, config, unread, alerts, refreshMe, refreshUnread, refreshConfig, requireLogin, authMode, finishAuth, apply, logout]);

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
