import { useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { NICK_RANKS, SKIN_OPTIONS, TIERS, seasonsOf, tagName, type SeasonTag } from '../../shared/market';
import { useApp } from '../app/state';

// Tier rows that open into season checkboxes, e.g. 마스터 → 17 … 32시즌.
export function SeasonPicker({ value, onChange, showPicked = true }: { value: SeasonTag[]; onChange: (v: SeasonTag[]) => void; showPicked?: boolean }) {
    const { config } = useApp();
    const [open, setOpen] = useState<string | null>(() => value[0]?.tier ?? null);
    const has = (tier: string, season: number) => value.some(t => t.tier === tier && t.season === season);
    const toggle = (tier: string, season: number) => onChange(has(tier, season) ? value.filter(t => !(t.tier === tier && t.season === season)) : [...value, { tier, season }]);
    return <div className="season-picker">
        {TIERS.map(tier => {
            const seasons = seasonsOf(tier, config.latestSeason), count = value.filter(t => t.tier === tier.id).length, isOpen = open === tier.id;
            const all = count === seasons.length;
            return <div className="tier-row" key={tier.id} data-open={isOpen}>
                <button type="button" className="tier-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : tier.id)}>
                    <span className="tier-name">{tier.name}</span>
                    <span className="tier-range">{tier.min}~{config.latestSeason}시즌</span>
                    {count > 0 && <span className="tier-count">{count}</span>}
                    <ChevronDown size={18} className="chev" />
                </button>
                {isOpen && <div className="tier-body">
                    <div className="tier-tools">
                        <button type="button" className="btn btn-text small" onClick={() => onChange(all ? value.filter(t => t.tier !== tier.id) : [...value.filter(t => t.tier !== tier.id), ...seasons.map(season => ({ tier: tier.id, season }))])}>
                            {all ? '전체 해제' : '전체 선택'}
                        </button>
                    </div>
                    <div className="season-grid">
                        {seasons.map(season => <label key={season} className="season-box">
                            <input type="checkbox" checked={has(tier.id, season)} onChange={() => toggle(tier.id, season)} aria-label={`${season}시즌 ${tier.name}`} />
                            {season}시즌
                        </label>)}
                    </div>
                </div>}
            </div>;
        })}
        {showPicked && value.length > 0 && <div className="picked" aria-label="선택한 시즌">
            {[...value].sort((a, b) => b.season - a.season).map(t => <button type="button" key={t.tier + t.season} onClick={() => toggle(t.tier, t.season)} aria-label={tagName(t) + ' 선택 해제'}>{tagName(t)}<X size={12} /></button>)}
        </div>}
    </div>;
}

export function SkinPicker({ value, onChange, compact = false }: { value: string[]; onChange: (v: string[]) => void; compact?: boolean }) {
    const toggle = (name: string, on: boolean) => onChange(on ? [...new Set([...value, name])] : value.filter(v => v !== name));
    // Values saved by older versions stay visible so they can be removed.
    const legacy = value.filter(v => !(SKIN_OPTIONS as readonly string[]).includes(v));
    return <div className="grid-gap-8">
        {compact
            // Narrow filter column: toggle chips that size to the name instead of a two-column grid.
            ? <div className="chip-row skin-chips" role="group" aria-label="우대 스킨">
                {SKIN_OPTIONS.map(name => <button type="button" key={name} className="chip chip-sm" aria-pressed={value.includes(name)} onClick={() => toggle(name, !value.includes(name))}>{name}</button>)}
            </div>
            : <div className="choice-grid">
                {SKIN_OPTIONS.map(name => <label key={name} className="choice check">
                    <input type="checkbox" checked={value.includes(name)} onChange={e => toggle(name, e.target.checked)} />{name}
                </label>)}
            </div>}
        {legacy.length > 0 && <div className="picked">{legacy.map(name => <button type="button" key={name} onClick={() => toggle(name, false)}>{name}<X size={12} /></button>)}</div>}
    </div>;
}

export function RankPicker({ value, onChange, multiple = false }: { value: string[]; onChange: (v: string[]) => void; multiple?: boolean }) {
    return <div className="seg" role="group" aria-label="닉 등급">
        {NICK_RANKS.map(rank => <label key={rank}>
            <input type={multiple ? 'checkbox' : 'radio'} name={multiple ? undefined : 'nick-rank'} checked={value.includes(rank)}
                onChange={() => onChange(multiple ? (value.includes(rank) ? value.filter(v => v !== rank) : [...value, rank]) : (value.includes(rank) ? [] : [rank]))}
                onClick={e => { if (!multiple && value.includes(rank)) { e.preventDefault(); onChange([]); } }} />
            {rank}
        </label>)}
    </div>;
}

export function Segmented<T extends string>({ options, value, onChange, name, allowEmpty = true }: { options: readonly T[]; value: string; onChange: (v: T | '') => void; name: string; allowEmpty?: boolean }) {
    return <div className="seg" role="radiogroup" aria-label={name}>
        {options.map(option => <label key={option}>
            <input type="radio" name={name} checked={value === option} onChange={() => onChange(option)}
                onClick={e => { if (allowEmpty && value === option) { e.preventDefault(); onChange(''); } }} />
            {option}
        </label>)}
    </div>;
}
