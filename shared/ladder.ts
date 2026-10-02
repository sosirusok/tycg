// 래더 표시 (WP68): ladders read per tier, highest first, instead of one chip per season. Pure, shared by
// the web client (LadderTags, SeasonPicker, board chips), the Worker (search, 같은 매물 prints) and the unit
// checks in tests/verify-ladder.mjs.
//
// '모든 시즌 챔피언' when every season of the tier from its first season to the latest one is picked;
// otherwise '챌린저 23~32, 20, 18시즌' (consecutive seasons as low~high ranges, newest first). 시즌 비공개
// (hidden emblems of a known tier and unknown season, seller side only) adds ' · 시즌 비공개 2', or reads
// '마스터 시즌 비공개 2' without visible seasons.
import { CLAN_MIN_SEASON, CLAN_TIERS, LATEST_SEASON, TIERS, type SeasonTag } from './market';

// 시즌 비공개 per tier id: { master: 2 }.
export type LadderHidden = Record<string, number>;
export const HIDDEN_MAX = 99;

export type Tier = { readonly id: string; readonly name: string; readonly min: number };
// Every ladder display lists the highest tier first: 챔피언, 챌린저, 마스터 … 아이언.
export const TIERS_DESC = [...TIERS].reverse();
// 클랜 래더 (WP70): the clan tiers highest first, each from the first clan-ladder season, named '클랜 골드'
// so a pill reads '모든 시즌 클랜 챔피언' or '클랜 골드 28~32시즌'. short: the bare tier name for chips.
export const clanTiersDesc = (min = CLAN_MIN_SEASON): (Tier & { short: string; rank: string })[] =>
    [...CLAN_TIERS].reverse().map(t => ({ id: t.id, name: '클랜 ' + t.name, short: t.name, rank: t.rank, min }));

export type LadderGroup = {
    tier: string;
    name: string;
    // The picked seasons, newest first.
    seasons: number[];
    // Every season from the tier's first season to the latest one is picked.
    all: boolean;
    // '23~32, 20, 18' ('' without visible seasons).
    ranges: string;
    // 시즌 비공개 count (0: none).
    hidden: number;
    // The whole line: '모든 시즌 챔피언', '챌린저 23~32, 20, 18시즌', '마스터 18시즌 · 시즌 비공개 2', '마스터 시즌 비공개 2'.
    label: string;
};

// Seasons (any order) as ranges, newest first: [32 … 23, 20, 18] → '23~32, 20, 18'.
export function seasonRanges(seasons: number[]) {
    const sorted = [...new Set(seasons)].sort((a, b) => b - a), parts: string[] = [];
    for (let i = 0; i < sorted.length;) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] - 1) j++;
        parts.push(j === i ? String(sorted[i]) : `${sorted[j]}~${sorted[i]}`);
        i = j + 1;
    }
    return parts.join(', ');
}

export const hiddenText = (n: number) => `시즌 비공개 ${n}`;

// One group per tier with picks or hidden emblems, highest tier first. tiers lets another ladder (a clan
// ladder) reuse the grouping; a tier missing from it is left out.
export function groupLadders(tags: readonly SeasonTag[] | undefined, hidden?: LadderHidden | null, latest = LATEST_SEASON, tiers: readonly Tier[] = TIERS_DESC): LadderGroup[] {
    const groups: LadderGroup[] = [];
    for (const t of tiers) {
        const seasons = [...new Set((tags || []).filter(v => v.tier === t.id).map(v => v.season))].sort((a, b) => b - a);
        const count = hidden?.[t.id];
        const h = Number.isInteger(count) && count! > 0 ? count! : 0;
        if (!seasons.length && !h) continue;
        const span = Math.max(0, latest - t.min + 1);
        const all = span > 0 && seasons.length >= span && seasons.filter(s => s >= t.min && s <= latest).length === span;
        const ranges = seasonRanges(seasons);
        const head = all ? `모든 시즌 ${t.name}` : ranges ? `${t.name} ${ranges}시즌` : t.name;
        const label = !h ? head : seasons.length ? `${head} · ${hiddenText(h)}` : `${t.name} ${hiddenText(h)}`;
        groups.push({ tier: t.id, name: t.name, seasons, all, ranges, hidden: h, label });
    }
    return groups;
}

// The groups as plain text ('모든 시즌 챔피언, 마스터 18시즌'), for places that print one line.
export function ladderText(tags: readonly SeasonTag[] | undefined, hidden?: LadderHidden | null, latest = LATEST_SEASON) {
    return groupLadders(tags, hidden, latest).map(g => g.label).join(', ');
}

// The tiers a search filter covers completely (every season from the tier's first to the latest): the
// '모든 시즌 T' intent, which also finds 시즌 비공개 emblems of T (their season is unknown).
export function fullTiers(tags: readonly SeasonTag[], latest = LATEST_SEASON, tiers: readonly Tier[] = TIERS) {
    return tiers.filter(t => {
        const span = latest - t.min + 1;
        return span > 0 && new Set(tags.filter(v => v.tier === t.id && v.season >= t.min && v.season <= latest).map(v => v.season)).size === span;
    }).map(t => t.id);
}

// The API's ladderHidden: a plain object of known tier ids to whole numbers 1–99. Returns the map with
// its tiers in TIERS order, or null when anything is off.
export function validHidden(input: unknown): LadderHidden | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > TIERS.length) return null;
    const out: LadderHidden = {};
    for (const t of TIERS) {
        const v = (input as Record<string, unknown>)[t.id];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > HIDDEN_MAX) return null;
        out[t.id] = v;
    }
    return entries.every(([k]) => k in out) ? out : null;
}
