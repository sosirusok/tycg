import { useEffect, useState } from 'react';
import type { StatsLevel } from '../../shared/membership';

// GET /me/usage (and the 끌올 response): the 끌올 지갑. Null wallet fields are the manager's (no wallet).
export type Wallet = { bumpTokens: number | null; bumpMax: number | null; bumpRefillMin: number | null; nextRefillAt: number | null };
export type Usage = Wallet & {
    // stats and profilePins: 판매 통계 and 대표 글 (WP63).
    perks: { bumpMax: number | null; bumpRefillMinutes: number | null; bumpGapMinutes: number | null; adSlots: number | null; stats?: StatsLevel; profilePins?: number | null };
    rules: { photosPerPost: number | null; openPosts: number | null; postsPerDay: number | null; freshPerDay?: number | null };
    // featured: the member's 광고 slot posts now (WP53, '광고 2/3 · 자동').
    openPosts: number; postsToday: number; freshToday?: number; featured: { id: number; title: string; kind?: string }[];
    // The member's photo space in the current store (WP45); limit null for the manager.
    photos?: { storage: 'r2' | 'kv' | 'd1'; used: number; limit: number | null };
    // 자동 끌올 (WP61): the member's listed open posts and the grade's count (null: every post); none below 플러스.
    autoBump?: { on: number; max: number | null; enabled: boolean } | null;
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

// '15:40' on the Korean clock, rounded up to the minute like the server's messages.
export function kstClock(t: number) {
    const d = new Date(Math.ceil(t / 60000) * 60000 + 9 * 3600000);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
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
    const w = walletNow(usage, now);
    const refill = w && w.tokens < 1 ? w.nextRefillAt || 0 : 0;
    const at = Math.max(postBlockedUntil(post, usage, now), refill);
    return at > now ? at : 0;
}
// The post's own blockers only (the same-post gap and 새 글 우선), without the wallet. 0 when none.
export function postBlockedUntil(post: BumpPost, usage: Usage, now: number) {
    const gap = (usage.perks.bumpGapMinutes || 0) * 60000;
    const bumped = post.bumped_at || post.created_at;
    const at = Math.max((post.bump_count ? bumped : post.created_at) + gap, bumped);
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

// '끌올 3/5 · 1:20 후 충전', or '끌올 5/5' when full. Nothing for the manager. extra is one more item at the
// end, so the line keeps at most 3 items.
export function WalletGauge({ usage, now, className, extra }: { usage: Usage; now: number; className?: string; extra?: string }) {
    const w = walletNow(usage, now);
    if (!w) return null;
    return <p className={'wallet-gauge' + (className ? ' ' + className : '')}>
        <b>끌올 {w.tokens}/{w.max}</b>{w.nextRefillAt !== null && <span> · {countdown(w.nextRefillAt - now)} 후 충전</span>}{extra && <span> · {extra}</span>}
    </p>;
}


// The profile's third item (WP61): '자동 끌올 3/5', '자동 끌올 12개' (every post) or '자동 끌올 꺼짐'.
export function autoItem(usage: Usage | null) {
    const a = usage?.autoBump;
    if (!a) return undefined;
    if (!a.enabled) return '자동 끌올 꺼짐';
    return a.max === null ? `자동 끌올 ${a.on}개` : `자동 끌올 ${a.on}/${a.max}`;
}
