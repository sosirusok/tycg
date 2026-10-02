import { CLAN_MIN_SEASON, clanTierName, type SeasonTag } from '../../shared/market';
import { clanTiersDesc, groupLadders, type LadderGroup, type LadderHidden } from '../../shared/ladder';
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

// The groups of a ladder: personal tiers, or the clan tiers (클랜 래더, WP70: '모든 시즌 클랜 챔피언',
// '클랜 골드 28~32시즌') from the manager's first clan-ladder season.
export function useLadderGroups(tags: SeasonTag[] | undefined, hidden: LadderHidden | null | undefined, clan = false) {
    const { config } = useApp();
    return groupLadders(tags, clan ? null : hidden, config.latestSeason, clan ? clanTiersDesc(config.clanMinSeason ?? CLAN_MIN_SEASON) : undefined);
}
// The color class of a tier pill or chip: personal tiers 'tier-master', clan tiers 'clan-tier-gold'.
export const tierClass = (tier: string, clan = false) => (clan ? 'clan-tier-' : 'tier-') + tier;

// A post's ladders as one tier-colored pill per tier, highest tier first (never one chip per season).
// highlight (the board's ladder filter) puts its tiers first; max shows that many pills and '+N' for the
// rest (cards). bare leaves out the wrapper, so the pills sit in the parent's own row (card specs). lead:
// a pill shown first and counted in max (the clan's 현재 클랜 티어 on cards).
export function LadderTags({ tags, hidden, highlight, max, bare = false, className = '', clan = false, lead }: {
    tags?: SeasonTag[]; hidden?: LadderHidden | null; highlight?: SeasonTag[]; max?: number; bare?: boolean; className?: string; clan?: boolean; lead?: string;
}) {
    let groups = useLadderGroups(tags, hidden, clan);
    if (!groups.length && !lead) return null;
    if (highlight?.length) {
        const hit = new Set(highlight.map(h => h.tier));
        groups = [...groups.filter(g => hit.has(g.tier)), ...groups.filter(g => !hit.has(g.tier))];
    }
    const room = max ? Math.max(0, max - (lead ? 1 : 0)) : groups.length;
    const shown = groups.slice(0, room), rest = groups.length - shown.length;
    const pills = <>
        {lead && <ClanTierPill tier={lead} current />}
        {shown.map(g => <span key={g.tier} className={'ladder-pill ' + tierClass(g.tier, clan)}><LadderPillText group={g} /></span>)}
        {rest > 0 && <span className="tag">+{rest}</span>}
    </>;
    return bare ? pills : <div className={'ladder-tags' + (className ? ' ' + className : '')}>{pills}</div>;
}

// 현재 클랜 티어 (WP70) as one pill in the clan color: '클랜 골드' under its own title, '현재 클랜 골드' on cards
// (current), next to the clan ladder pills.
export function ClanTierPill({ tier, current = false }: { tier: string; current?: boolean }) {
    const name = clanTierName(tier);
    return name ? <span className={'ladder-pill ' + tierClass(tier, true)}><b>{current ? '현재 클랜 ' : '클랜 '}{name}</b></span> : null;
}

// Whether a post has anything for LadderTags to show.
export const hasLadder = (tags?: SeasonTag[], hidden?: LadderHidden | null) => !!tags?.length || Object.values(hidden || {}).some(n => n > 0);

// 특징 태그 (WP70) as small gray chips: '#불새상류'. max shows that many and '+N' for the rest.
export function FeatureTags({ tags, max, className = '' }: { tags: string[]; max?: number; className?: string }) {
    if (!tags.length) return null;
    const shown = max ? tags.slice(0, max) : tags;
    return <div className={'feature-tags' + (className ? ' ' + className : '')}>
        {shown.map(t => <span key={t} className="feature-tag">#{t}</span>)}
        {tags.length > shown.length && <span className="feature-tag">+{tags.length - shown.length}</span>}
    </div>;
}
