import { useId, useRef, useState, type InputHTMLAttributes } from 'react';
import { X } from 'lucide-react';
import { NICK_RANKS, SKIN_OPTIONS, TIERS, seasonsOf, tagName, type SeasonTag } from '../../shared/market';
import { useApp } from '../app/state';
import { useMoreRight } from './ui';

// One chip row of the nine tiers; the open tier shows its season checkboxes below, e.g. 마스터 → 17 … 32시즌.
export function SeasonPicker({ value, onChange, showPicked = true }: { value: SeasonTag[]; onChange: (v: SeasonTag[]) => void; showPicked?: boolean }) {
    const { config } = useApp();
    const [open, setOpen] = useState<string | null>(() => TIERS.find(t => value.some(v => v.tier === t.id))?.id ?? null);
    const has = (tier: string, season: number) => value.some(t => t.tier === tier && t.season === season);
    const toggle = (tier: string, season: number) => onChange(has(tier, season) ? value.filter(t => !(t.tier === tier && t.season === season)) : [...value, { tier, season }]);
    const tier = TIERS.find(t => t.id === open);
    const seasons = tier ? seasonsOf(tier, config.latestSeason) : [];
    const all = !!tier && value.filter(t => t.tier === tier.id).length === seasons.length;
    const row = useMoreRight<HTMLDivElement>();
    return <div className="season-picker">
        <div ref={row.ref} className={'chip-scroll tier-chips' + (row.more ? ' has-more' : '')} role="group" aria-label="티어" onScroll={row.measure}>
            {TIERS.map(t => {
                const count = value.filter(v => v.tier === t.id).length;
                return <button type="button" key={t.id} className="chip chip-sm" aria-pressed={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>{t.name}{count ? <b>{count}</b> : null}</button>;
            })}
        </div>
        {tier && <div className="season-panel">
            <div className="season-head">
                <span>{tier.name} · {tier.min}~{config.latestSeason}시즌</span>
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

// Each picker gets its own radio group, so two pickers on one screen (내 닉 and 닉) never uncheck each other.
export function RankPicker({ value, onChange, multiple = false }: { value: string[]; onChange: (v: string[]) => void; multiple?: boolean }) {
    const group = useId();
    return <div className="seg" role="group" aria-label="닉 등급">
        {NICK_RANKS.map(rank => <label key={rank}>
            <input type={multiple ? 'checkbox' : 'radio'} name={multiple ? undefined : group} checked={value.includes(rank)}
                onChange={() => onChange(multiple ? (value.includes(rank) ? value.filter(v => v !== rank) : [...value, rank]) : (value.includes(rank) ? [] : [rank]))}
                onClick={e => { if (!multiple && value.includes(rank)) { e.preventDefault(); onChange([]); } }} />
            {rank}
        </label>)}
    </div>;
}

export function Segmented<T extends string>({ options, value, onChange, name, allowEmpty = true, label }: { options: readonly T[]; value: string; onChange: (v: T | '') => void; name: string; allowEmpty?: boolean; label?: (v: T) => string }) {
    // name is the group's label only; the radio group name is unique per instance.
    const group = useId();
    return <div className="seg" role="radiogroup" aria-label={name}>
        {options.map(option => <label key={option}>
            <input type="radio" name={group} checked={value === option} onChange={() => onChange(option)}
                onClick={e => { if (allowEmpty && value === option) { e.preventDefault(); onChange(''); } }} />
            {label ? label(option) : option}
        </label>)}
    </div>;
}

// Whole-number field: a text input with the number keypad (a number input reports '' for '2.' and
// accepts 'e'). Only the leading digits count, so the first other character ends the number: typing
// '2.5' leaves 2 and '1e5' leaves 1, because digits typed right after it are ignored until the member
// deletes or replaces something. Leading zeros go and the value stays within min and max.
type IntegerProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'> & { value: string; onChange: (v: string) => void; max?: number; min?: number };
export function IntegerInput({ value, onChange, max, min = 0, onFocus, onBlur, ...rest }: IntegerProps) {
    const ended = useRef(false);
    return <input {...rest} type="text" inputMode="numeric" autoComplete="off" value={value}
        onFocus={e => { ended.current = false; onFocus?.(e); }}
        onBlur={e => { ended.current = false; onBlur?.(e); }}
        onChange={e => {
            const raw = e.target.value;
            if (ended.current && value && raw.length > value.length && raw.startsWith(value)) return;
            const digits = raw.match(/^\d*/)?.[0] ?? '';
            ended.current = digits.length > 0 && digits.length < raw.length;
            let v = digits.replace(/^0+(?=\d)/, '');
            if (v && max !== undefined && Number(v) > max) v = String(max);
            if (v && Number(v) < min) v = '';
            onChange(v);
        }} />;
}
