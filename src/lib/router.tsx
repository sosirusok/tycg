import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

// A small history-based router: the app only needs path segments and query params.
type Guard = () => Promise<boolean> | boolean;
let leaveGuard: Guard | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

// Scroll positions live in each history entry's state ({ y }). The browser's own restoration is
// off because it runs before the list below has rendered; pages restore y themselves instead.
let restore: { href: string; y: number } | null = null;
if (typeof window !== 'undefined') {
    try { history.scrollRestoration = 'manual'; } catch { /* ignore */ }
    window.addEventListener('popstate', e => {
        const y = Number((e.state as { y?: unknown } | null)?.y);
        restore = { href: location.pathname + location.search, y: Number.isFinite(y) ? y : 0 };
        notify();
    });
}

// The scroll position to restore for the current address after Back/Forward, once; null otherwise.
export function takeScrollRestore(): number | null {
    if (!restore || restore.href !== location.pathname + location.search) return null;
    const { y } = restore;
    restore = null;
    return y;
}

export function setLeaveGuard(guard: Guard | null) { leaveGuard = guard; }

export async function navigate(to: string, options: { replace?: boolean; force?: boolean } = {}) {
    if (!options.force && leaveGuard && !(await leaveGuard())) return;
    const current = location.pathname + location.search;
    if (to === current) return;
    restore = null;
    if (options.replace) history.replaceState(history.state, '', to);
    else {
        // Remembers where the member was on the page being left, for Back.
        history.replaceState({ ...history.state, y: window.scrollY }, '');
        history.pushState({ y: 0 }, '', to);
        window.scrollTo(0, 0);
    }
    notify();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
const snapshot = () => location.pathname + location.search;

function parseHref(href: string) {
    const url = new URL(href, location.origin);
    return { path: url.pathname, search: url.search, params: url.searchParams, parts: url.pathname.split('/').filter(Boolean), href };
}
// One parsed object per address, so `params` and `parts` are stable effect dependencies.
let parsed: ReturnType<typeof parseHref> | null = null;

export function useLocation() {
    const href = useSyncExternalStore(subscribe, snapshot, snapshot);
    if (parsed?.href !== href) parsed = parseHref(href);
    return parsed;
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
    const click = (e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        void navigate(to);
    };
    return <a href={to} onClick={click} {...rest} />;
}

export function withParams(path: string, params: Record<string, string | undefined | null>) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
    const s = q.toString();
    return s ? `${path}?${s}` : path;
}
