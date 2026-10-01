import { useEffect, useState } from 'react';

// GET /me/usage (and the 끌올 response): the 끌올 지갑. Null wallet fields are the manager's (no wallet).
export type Wallet = { bumpTokens: number | null; bumpMax: number | null; bumpRefillMin: number | null; nextRefillAt: number | null };
export type Usage = Wallet & {
    perks: { bumpMax: number | null; bumpRefillMinutes: number | null; bumpGapMinutes: number | null; boardSlots: number | null; homeShelf: boolean | null };
    rules: { photosPerPost: number | null; openPosts: number | null; postsPerDay: number | null };
    openPosts: number; postsToday: number; featured: { id: number; title: string; kind?: string }[];
};

// The wallet now, from the values the server sent: each refill interval that passed since
// nextRefillAt adds one, up to the cap. Unlimited (the manager) when bumpTokens is null.
export function walletNow(w: Wallet, now: number): { tokens: number; max: number; nextRefillAt: number | null } | null {
    if (w.bumpTokens === null || w.bumpMax === null) return null;
    let tokens = w.bumpTokens, next = w.nextRefillAt;
    const R = (w.bumpRefillMin || 60) * 60000;
    if (next !== null && now >= next) {
        const k = Math.floor((now - next) / R) + 1;
        tokens = Math.min(w.bumpMax, tokens + k);
        next = tokens >= w.bumpMax ? null : next + k * R;
    }
    return { tokens, max: w.bumpMax, nextRefillAt: next };
}

// '1:20' until the next refill (hours:minutes, rounded up to the minute).
export function countdown(ms: number) {
    const m = Math.max(1, Math.ceil(ms / 60000));
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

type BumpPost = { bumped_at?: number; created_at: number; bump_count?: number };
// When the post can be bumped: the latest of the same-post gap end, the end of 새 글 우선 (a
// bumped_at ahead of now) and, with an empty wallet, the next refill. 0 when it can be bumped now.
export function bumpReadyAt(post: BumpPost, usage: Usage, now: number) {
    const gap = (usage.perks.bumpGapMinutes || 0) * 60000;
    const bumped = post.bumped_at || post.created_at;
    const gapEnd = (post.bump_count ? bumped : post.created_at) + gap;
    const w = walletNow(usage, now);
    const refill = w && w.tokens < 1 ? w.nextRefillAt || 0 : 0;
    const at = Math.max(gapEnd, bumped, refill);
    return at > now ? at : 0;
}

// Re-renders once a minute (the gauge's countdown and the waiting 끌올 buttons).
export function useMinuteClock() {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        // On the minute, so the countdown turns with the clock.
        let t = 0;
        const tick = () => { setNow(Date.now()); t = window.setTimeout(tick, 60000 - (Date.now() % 60000) + 50); };
        t = window.setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
        return () => clearTimeout(t);
    }, []);
    return [now, setNow] as const;
}

// '끌올 3/4 · 1:20 후 충전', or '끌올 4/4' when full. Nothing for the manager.
export function WalletGauge({ usage, now, className }: { usage: Usage; now: number; className?: string }) {
    const w = walletNow(usage, now);
    if (!w) return null;
    return <p className={'wallet-gauge' + (className ? ' ' + className : '')}>
        <b>끌올 {w.tokens}/{w.max}</b>{w.nextRefillAt !== null && <span> · {countdown(w.nextRefillAt - now)} 후 충전</span>}
    </p>;
}
