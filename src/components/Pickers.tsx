import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from 'react';
import { X } from 'lucide-react';
import { NICK_RANKS, NICK_TYPES, SKIN_OPTIONS, seasonsOf, type SeasonTag } from '../../shared/market';
import { HIDDEN_MAX, TIERS_DESC, groupLadders, type LadderHidden } from '../../shared/ladder';
import { useApp } from '../app/state';
import { useMoreRight } from './ui';
import { LadderPillText } from './LadderTags';

// The nine tiers as chips, highest first; a tier with picks wears its tier colors and its count. The open
// tier shows its season checkboxes, newest first (e.g. 마스터 → 32 … 17시즌), with 전체 선택 / 전체 해제.
// Under them, one row per picked tier in the grouped form ('모든 시즌 챔피언', '챌린저 23~32, 20시즌'): the
// row opens its tier, ✕ clears it (WP68). hidden and onHiddenChange (판매 and the offered side of 교환 only)
// add '<티어> 시즌 비공개' with a count to each tier panel.
export function SeasonPicker({ value, onChange, showPicked = true, hidden, onHiddenChange }: {
    value: SeasonTag[]; onChange: (v: SeasonTag[]) => void; showPicked?: boolean; hidden?: LadderHidden; onHiddenChange?: (v: LadderHidden) => void;
}) {
    const { config } = useApp();
    const latest = config.latestSeason;
    const hiddenOf = (tier: string) => (onHiddenChange && hidden?.[tier]) || 0;
    const [open, setOpen] = useState<string | null>(() => TIERS_DESC.find(t => value.some(v => v.tier === t.id) || hiddenOf(t.id))?.id ?? null);
    const has = (tier: string, season: number) => value.some(t => t.tier === tier && t.season === season);
    const toggle = (tier: string, season: number) => onChange(has(tier, season) ? value.filter(t => !(t.tier === tier && t.season === season)) : [...value, { tier, season }]);
    const setHidden = (tier: string, n: number) => {
        if (!onHiddenChange) return;
        const next = { ...hidden };
        if (n > 0) next[tier] = n; else delete next[tier];
        onHiddenChange(next);
    };
    const clearTier = (tier: string) => {
        if (value.some(t => t.tier === tier)) onChange(value.filter(t => t.tier !== tier));
        if (hiddenOf(tier)) setHidden(tier, 0);
    };
    const tier = TIERS_DESC.find(t => t.id === open);
    const seasons = tier ? seasonsOf(tier, latest).reverse() : [];
    const picked = tier ? value.filter(t => t.tier === tier.id).length : 0;
    const all = !!tier && seasons.length > 0 && seasons.every(season => has(tier.id, season));
    const groups = showPicked ? groupLadders(value, onHiddenChange ? hidden : null, latest) : [];
    const row = useMoreRight<HTMLDivElement>();
    return <div className="season-picker">
        <div ref={row.ref} className={'chip-scroll tier-chips' + (row.more ? ' has-more' : '')} role="group" aria-label="티어" onScroll={row.measure}>
            {TIERS_DESC.map(t => {
                const count = value.filter(v => v.tier === t.id).length + hiddenOf(t.id);
                return <button type="button" key={t.id} className={'chip chip-sm' + (count ? ' has-picks tier-' + t.id : '')} aria-pressed={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>{t.name}{count ? <b>{count}</b> : null}</button>;
            })}
        </div>
        {tier && <div className="season-panel">
            <div className="season-head">
                {all ? <strong>모든 시즌 {tier.name}</strong> : <span>{tier.name} · {tier.min}~{latest}시즌</span>}
                <span className="season-actions">
                    {!all && <button type="button" className="btn btn-text small" onClick={() => onChange([...value.filter(t => t.tier !== tier.id), ...seasons.map(season => ({ tier: tier.id, season }))])}>전체 선택</button>}
                    {picked > 0 && <button type="button" className="btn btn-text small" onClick={() => onChange(value.filter(t => t.tier !== tier.id))}>전체 해제</button>}
                </span>
            </div>
            <div className="season-grid">
                {seasons.map(season => <label key={season} className="season-box">
                    <input type="checkbox" checked={has(tier.id, season)} onChange={() => toggle(tier.id, season)} aria-label={`${season}시즌 ${tier.name}`} />
                    {season}시즌
                </label>)}
            </div>
            {onHiddenChange && <div className="season-hidden">
                <label className="check"><input type="checkbox" checked={hiddenOf(tier.id) > 0} onChange={e => setHidden(tier.id, e.target.checked ? Math.max(1, hiddenOf(tier.id)) : 0)} />{tier.name} 시즌 비공개</label>
                <HiddenCount key={tier.id} label={`${tier.name} 시즌 비공개 개수`} value={hiddenOf(tier.id)} onChange={n => setHidden(tier.id, n)} />
            </div>}
        </div>}
        {groups.length > 0 && <ul className="ladder-rows" aria-label="선택한 래더">
            {groups.map(g => <li key={g.tier} className="ladder-row">
                <button type="button" className={'ladder-pill tier-' + g.tier} onClick={() => setOpen(g.tier)}><LadderPillText group={g} /></button>
                <button type="button" className="ladder-clear" aria-label={g.label + ' 선택 해제'} onClick={() => clearTier(g.tier)}><X size={14} /></button>
            </li>)}
        </ul>}
    </div>;
}

// The 시즌 비공개 count, 1–99 개: typing keeps a draft, and an empty or 0 field goes back to the stored count
// when it loses focus. Disabled while the tier's checkbox is off.
function HiddenCount({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
    const [draft, setDraft] = useState(value ? String(value) : '');
    useEffect(() => { setDraft(value ? String(value) : ''); }, [value]);
    return <div className="input-unit">
        <IntegerInput className="input" aria-label={label} value={draft} min={1} max={HIDDEN_MAX} disabled={!value}
            onChange={v => { setDraft(v); if (v) onChange(Number(v)); }}
            onBlur={() => setDraft(value ? String(value) : '')} />
        <span>개</span>
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

// 닉 종류 as toggle chips. multiple picks any number (kept in list order); otherwise one at a time,
// and a second tap clears it.
export function NickTypePicker({ value, onChange, multiple = false }: { value: string[]; onChange: (v: string[]) => void; multiple?: boolean }) {
    const toggle = (type: string) => { const on = !value.includes(type); onChange(NICK_TYPES.filter(t => t === type ? on : multiple && value.includes(t))); };
    return <div className="chip-row nick-type-chips" role="group" aria-label="닉 종류">
        {NICK_TYPES.map(type => <button type="button" key={type} className="chip chip-sm" aria-pressed={value.includes(type)} onClick={() => toggle(type)}>{type}</button>)}
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
// accepts 'e'). Thousands separators and spaces are dropped first, so '1,400,000' typed or pasted
// gives 1400000, and full-width digits count as digits. After that only the leading digits count, so
// any other character ends the number: typing '2.5' leaves 2 and '1e5' leaves 1, because digits typed
// right after it are ignored until the member deletes or replaces something. Leading zeros go and the
// value stays within min and max.
type IntegerProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'> & { value: string; onChange: (v: string) => void; max?: number; min?: number };
export function IntegerInput({ value, onChange, max, min = 0, onFocus, onBlur, ...rest }: IntegerProps) {
    const ended = useRef(false);
    return <input {...rest} type="text" inputMode="numeric" autoComplete="off" value={value}
        onFocus={e => { ended.current = false; onFocus?.(e); }}
        onBlur={e => { ended.current = false; onBlur?.(e); }}
        onChange={e => {
            const raw = e.target.value.normalize('NFKC').replace(/[,\s]/g, '');
            if (ended.current && value && raw.length > value.length && raw.startsWith(value)) return;
            const digits = raw.match(/^\d*/)?.[0] ?? '';
            ended.current = digits.length > 0 && digits.length < raw.length;
            let v = digits.replace(/^0+(?=\d)/, '');
            if (v && max !== undefined && Number(v) > max) v = String(max);
            if (v && Number(v) < min) v = '';
            onChange(v);
        }} />;
}
