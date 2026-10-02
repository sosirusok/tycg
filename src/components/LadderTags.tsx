import { groupLadders, type LadderGroup, type LadderHidden } from '../../shared/ladder';
import type { SeasonTag } from '../../shared/market';
import { useApp } from '../app/state';

// The text of one tier pill (WP68), the tier name in bold: '모든 시즌 챔피언', '챌린저 23~32, 20, 18시즌',
// '마스터 18시즌 · 시즌 비공개 2', '마스터 시즌 비공개 2'. It reads exactly as group.label.
export function LadderPillText({ group: g }: { group: LadderGroup }) {
    return <>
        {g.all ? <>모든 시즌 <b>{g.name}</b></> : <b>{g.name}</b>}
        {!g.all && g.ranges && <>{' '}{g.ranges}시즌</>}
        {g.hidden > 0 && <>{g.seasons.length ? ' · ' : ' '}시즌 비공개 {g.hidden}</>}
    </>;
}

// A post's ladders as one tier-colored pill per tier, highest tier first (never one chip per season).
// highlight (the board's ladder filter) puts its tiers first; max shows that many pills and '+N' for the
// rest (cards). bare leaves out the wrapper, so the pills sit in the parent's own row (card specs).
export function LadderTags({ tags, hidden, highlight, max, bare = false, className = '' }: {
    tags?: SeasonTag[]; hidden?: LadderHidden | null; highlight?: SeasonTag[]; max?: number; bare?: boolean; className?: string;
}) {
    const { config } = useApp();
    let groups = groupLadders(tags, hidden, config.latestSeason);
    if (!groups.length) return null;
    if (highlight?.length) {
        const hit = new Set(highlight.map(h => h.tier));
        groups = [...groups.filter(g => hit.has(g.tier)), ...groups.filter(g => !hit.has(g.tier))];
    }
    const shown = max ? groups.slice(0, max) : groups, rest = groups.length - shown.length;
    const pills = <>
        {shown.map(g => <span key={g.tier} className={'ladder-pill tier-' + g.tier}><LadderPillText group={g} /></span>)}
        {rest > 0 && <span className="tag">+{rest}</span>}
    </>;
    return bare ? pills : <div className={'ladder-tags' + (className ? ' ' + className : '')}>{pills}</div>;
}

// Whether a post has anything for LadderTags to show.
export const hasLadder = (tags?: SeasonTag[], hidden?: LadderHidden | null) => !!tags?.length || Object.values(hidden || {}).some(n => n > 0);
