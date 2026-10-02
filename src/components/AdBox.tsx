import type { Post } from '../../shared/market';
import { AD_TEXT } from '../../shared/membership';
import { AdSection } from './AdCard';

// The board's '광고 매물' box (WP53): page 1 in 최신순 only, when the tab with the viewer's filters holds
// more than 16 진행중 posts (the server decides and rotates every 10 minutes, one card per advertiser).
// 3 rows on desktop, 2 on phones (CSS). A card whose post already sits in the first 5 list rows is
// dropped here too, so the same post never shows twice on one screen.
export function AdBox({ ads, list }: { ads: Post[] | undefined; list: Post[] }) {
    const top = new Set(list.slice(0, 5).map(p => p.id));
    const shown = (ads || []).filter(p => !top.has(p.id)).slice(0, 3);
    return <AdSection title={AD_TEXT.box} posts={shown} className="ad-board" />;
}
