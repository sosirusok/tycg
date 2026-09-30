import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { User } from '../../shared/market';
import { LATEST_SEASON } from '../../shared/market';
import type { ApplicationKind, PlanId } from '../../shared/membership';
import { api } from '../lib/api';

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
    // Runs `next` right away when signed in; otherwise opens the login dialog and runs it after.
    requireLogin: (next?: () => void) => boolean;
    authMode: '' | 'login' | 'register';
    openAuth: (mode: 'login' | 'register') => void;
    closeAuth: () => void;
    finishAuth: (u: User) => void;
    apply: ApplyPreset | 'open' | null;
    openApply: (preset?: ApplyPreset) => void;
    closeApply: () => void;
};

const Ctx = createContext<AppState>(null!);
export const useApp = () => useContext(Ctx);

const defaultConfig: SiteConfig = { latestSeason: LATEST_SEASON, paymentNotice: '', manager: null };

export function AppProvider({ children }: { children: ReactNode }) {
    const [me, setMe] = useState<User | null>(null);
    const [ready, setReady] = useState(false);
    const [config, setConfig] = useState<SiteConfig>(defaultConfig);
    const [unread, setUnread] = useState(0);
    const [authMode, setAuthMode] = useState<'' | 'login' | 'register'>('');
    const [apply, setApply] = useState<ApplyPreset | 'open' | null>(null);
    const pending = useRef<(() => void) | null>(null);

    const refreshMe = useCallback(async () => {
        const d = await api<{ user: User | null }>('auth/me');
        setMe(d.user);
    }, []);
    const refreshConfig = useCallback(() => { api<SiteConfig>('config').then(setConfig).catch(() => {}); }, []);

    useEffect(() => {
        Promise.all([refreshMe(), api<SiteConfig>('config').then(setConfig)]).catch(() => {}).finally(() => setReady(true));
    }, [refreshMe]);

    const refreshUnread = useCallback(() => {
        if (!me) { setUnread(0); return; }
        api<{ chats: { unread: number }[] }>('chats').then(d => setUnread(d.chats.reduce((n, c) => n + c.unread, 0))).catch(() => {});
    }, [me]);

    // Unread count: every 30 s while the tab is visible (keeps Worker requests low).
    useEffect(() => {
        if (!me) { setUnread(0); return; }
        refreshUnread();
        const timer = setInterval(() => { if (!document.hidden) refreshUnread(); }, 30000);
        const onVisible = () => { if (!document.hidden) refreshUnread(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
    }, [me, refreshUnread]);

    const requireLogin = useCallback((next?: () => void) => {
        if (me) { next?.(); return true; }
        pending.current = next || null;
        setAuthMode('login');
        return false;
    }, [me]);

    const finishAuth = useCallback((u: User) => {
        setMe(u);
        setAuthMode('');
        const next = pending.current;
        pending.current = null;
        if (next) setTimeout(next, 0);
    }, []);

    const value = useMemo<AppState>(() => ({
        me, ready, config, unread, setMe, refreshMe, refreshUnread, refreshConfig, requireLogin,
        authMode, openAuth: setAuthMode, closeAuth: () => { pending.current = null; setAuthMode(''); }, finishAuth,
        apply, openApply: preset => setApply(preset || 'open'), closeApply: () => setApply(null),
    }), [me, ready, config, unread, refreshMe, refreshUnread, refreshConfig, requireLogin, authMode, finishAuth, apply]);

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
