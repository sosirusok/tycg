import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { User } from '../../shared/market';
import { LATEST_SEASON } from '../../shared/market';
import type { ApplicationKind, PlanId } from '../../shared/membership';
import { toast } from 'sonner';
import { LOGIN_REQUIRED, UNAUTHORIZED_EVENT, api, errorText } from '../lib/api';
import { navigate } from '../lib/router';

export type SiteConfig = { latestSeason: number; paymentNotice: string; manager: { id: string; nickname: string } | null };
export type ApplyPreset = { kind: ApplicationKind; target: string; plan?: PlanId };

type AppState = {
    me: User | null;
    ready: boolean;
    config: SiteConfig;
    unread: number;
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
    finishAuth: (u: User) => void;
    apply: ApplyPreset | 'open' | null;
    openApply: (preset?: ApplyPreset) => void;
    closeApply: () => void;
    logout: () => Promise<void>;
};

const Ctx = createContext<AppState>(null!);
const memberKey = (u: User) => JSON.stringify([u.id, u.nickname, u.bio, u.role, u.grade, u.grade_expires_at, u.badges, u.suspended_until]);
export const useApp = () => useContext(Ctx);

// The tab title: '(2) 판매 · 좀비고 거래소' while two chats are unread.
const SITE_NAME = '좀비고 거래소';
let pageTitle = SITE_NAME, unreadCount = 0;
const applyTitle = () => { document.title = (unreadCount > 0 ? `(${unreadCount}) ` : '') + pageTitle; };
export function setPageTitle(name: string) {
    pageTitle = name ? `${name} · ${SITE_NAME}` : SITE_NAME;
    applyTitle();
}

const defaultConfig: SiteConfig = { latestSeason: LATEST_SEASON, paymentNotice: '', manager: null };

export function AppProvider({ children }: { children: ReactNode }) {
    const [me, setMe] = useState<User | null>(null);
    const [ready, setReady] = useState(false);
    const [config, setConfig] = useState<SiteConfig>(defaultConfig);
    const [unread, setUnread] = useState(0);
    const [authMode, setAuthMode] = useState<'' | 'login' | 'register'>('');
    const [apply, setApply] = useState<ApplyPreset | 'open' | null>(null);
    const pending = useRef<((u: User) => void) | null>(null);

    // Keeps the same object when nothing changed, so effects that depend on `me` do not rerun.
    const updateMe = useCallback((next: User | null) => {
        setMe(prev => prev && next && memberKey(prev) === memberKey(next) ? prev : next);
    }, []);
    const refreshMe = useCallback(async () => {
        const d = await api<{ user: User | null }>('auth/me');
        updateMe(d.user);
    }, [updateMe]);
    const refreshConfig = useCallback(() => { api<SiteConfig>('config').then(setConfig).catch(() => {}); }, []);

    useEffect(() => {
        Promise.all([refreshMe(), api<SiteConfig>('config').then(setConfig)]).catch(() => {}).finally(() => setReady(true));
    }, [refreshMe]);

    const signedIn = !!me;
    // The unread count also brings the member's current badges and grade, so a grant
    // from the manager appears without reloading the page.
    const refreshUnread = useCallback(() => {
        if (!signedIn) { setUnread(0); return; }
        api<{ unread: number; user: User }>('chats/unread').then(d => { setUnread(d.unread); updateMe(d.user); }).catch(() => {});
    }, [signedIn, updateMe]);

    // Every 30 s while the tab is visible (keeps Worker requests low), and when the tab comes back.
    useEffect(() => {
        if (!signedIn) { setUnread(0); return; }
        refreshUnread();
        const timer = setInterval(() => { if (!document.hidden) refreshUnread(); }, 30000);
        const onVisible = () => { if (!document.hidden) refreshUnread(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
    }, [signedIn, refreshUnread]);

    useEffect(() => { unreadCount = unread; applyTitle(); }, [unread]);

    // api() reports a 401 (the session ended or was signed out elsewhere): sign out on the page too.
    const meRef = useRef(me);
    meRef.current = me;
    useEffect(() => {
        const onUnauthorized = () => {
            if (!meRef.current) return;
            meRef.current = null;
            setMe(null);
            setUnread(0);
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

    const finishAuth = useCallback((u: User) => {
        setMe(u);
        setAuthMode('');
        const next = pending.current;
        pending.current = null;
        if (next) setTimeout(() => next(u), 0);
    }, []);

    const logout = useCallback(async () => {
        try { await api('auth/logout', 'POST', {}); setMe(null); void navigate('/'); toast('로그아웃 완료'); }
        catch (e) { toast.error(errorText(e)); }
    }, []);

    const value = useMemo<AppState>(() => ({
        me, ready, config, unread, setMe, refreshMe, refreshUnread, refreshConfig, requireLogin,
        authMode, openAuth: setAuthMode, closeAuth: () => { pending.current = null; setAuthMode(''); }, finishAuth,
        apply, openApply: preset => setApply(preset || 'open'), closeApply: () => setApply(null), logout,
    }), [me, ready, config, unread, refreshMe, refreshUnread, refreshConfig, requireLogin, authMode, finishAuth, apply, logout]);

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
