import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Bell, BellRing, PenLine, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react';
import { toast } from 'sonner';
import {
    ACCOUNT_CHOICES, KIND_ICONS, KIND_NAMES, NICK_TYPES, PHANTOM_HINT, PHANTOM_LABEL, PHANTOM_MAX, TRADE_KINDS, categoriesForKind, categoryName, choiceLabel, isTradeKind, manToWon, parseList, priceLabel, priceText, rankText, skinTags, validTags, wonToMan,
    type Post, type SeasonTag, type TradeKind,
} from '../../shared/market';
import { api, errorText } from '../lib/api';
import { navigate, takeScrollRestore, useLocation, withParams } from '../lib/router';
import { useApp } from '../app/state';
import { CIcon, EmptyState, Modal, SkeletonRows } from '../components/ui';
import { PostCard } from '../components/PostCard';
import { AdBox } from '../components/AdBox';
import { AD_TEXT, ALERT_TEXT } from '../../shared/membership';
import { groupLadders } from '../../shared/ladder';
import { IntegerInput, NickTypePicker, RankPicker, SeasonPicker, Segmented, SkinPicker } from '../components/Pickers';

const PAGE_SIZE = 16;

// 같은 회원 글 접기 (WP53): on a board page each member shows 2 rows; the rest fold into one line
// '좀비사냥꾼 글 N개 더' right under the 2nd row, which opens them in place. The manager's posts never fold, and
// the server's order, counts and paging stay as they are.
type Folded = { post: Post } | { more: string; name: string; count: number };
const FOLD_AFTER = 2;
function foldRows(posts: Post[], open: Set<string>): Folded[] {
    const seen = new Map<string, number>(), total = new Map<string, number>();
    for (const p of posts) total.set(p.author_id, (total.get(p.author_id) || 0) + 1);
    const out: Folded[] = [];
    for (const p of posts) {
        const n = (seen.get(p.author_id) || 0) + 1, keep = p.role === 'manager' || open.has(p.author_id);
        seen.set(p.author_id, n);
        if (n <= FOLD_AFTER || keep) out.push({ post: p });
        // The fold line sits right under the member's 2nd row and names them, so two folds in a row
        // never read as the same member.
        if (n === FOLD_AFTER && !keep && total.get(p.author_id)! > FOLD_AFTER) out.push({ more: p.author_id, name: p.nickname || '', count: total.get(p.author_id)! - FOLD_AFTER });
    }
    return out;
}
// The server counts up to 300 posts (more shows '300+'); paging then stops at the last full page.
const COUNT_CAP = 300;

// Lists already seen in this tab, per member and query (the 20 most recent). Back and tab
// switches render from here at once while a background request checks for changes.
type ListData = { posts: Post[]; total: number; capped?: boolean; ads?: Post[]; counts?: Record<string, number> };
const listCache = new Map<string, ListData>();
function cacheGet(key: string) {
    const hit = listCache.get(key);
    if (hit) { listCache.delete(key); listCache.set(key, hit); }
    return hit;
}
function cachePut(key: string, data: ListData) {
    listCache.delete(key);
    listCache.set(key, data);
    while (listCache.size > 20) listCache.delete(listCache.keys().next().value!);
}

type Ctx = { kind: TradeKind | 'all'; category: string; wanted: string };

// Saved searches (GET /searches, 20 per member for every grade), read once per member per page load
// and kept here so moving between tabs does not ask again. The stored query is the board's own
// canonical query without the page, compared with its keys sorted. alert: the search sends 새 글 알림
// (WP54); keyword: it holds only the tab, category and word (키워드·게시판 알림, every grade).
type Saved = { id: string; name: string; query: string; alert?: boolean; keyword?: boolean };
let savedCache: { user: string; list: Saved[] } | null = null;
const searchKey = (q: string | URLSearchParams) => { const p = new URLSearchParams(q); p.delete('page'); p.sort(); return p.toString(); };
// The name is the filter chips in order, within the server's 32 characters.
const searchName = (labels: string[]) => { const name = labels.join(', '); return name.length > 32 ? name.slice(0, 31) + '…' : name; };

// Only parameters that mean something for the current tab reach the API. closed=1 (or only) stays in
// the address only; without it the request asks for posts still in progress (active=1).
function allowedKeys(ctx: Ctx) {
    const { kind, category } = ctx;
    // old=1 is '오래된 글 보기': posts not bumped in the last 30 days too.
    const keys = ['kind', 'category', 'q', 'closed', 'page', 'sort', 'badge', 'old'];
    if (kind === 'all') return ['q', 'closed', 'page', 'badge', 'old'];
    if (kind === 'exchange') keys.push('wantedCategory');
    if (kind === 'exchange' && ctx.wanted === 'account') keys.push('wantedTags', 'wantedOwnerCountOfMine', 'wantedNicknameChars', 'wantedNicknameRank', 'wantedMyNicknameType', 'wantedMyRecord', 'wantedMyPhantom');
    if (kind !== 'exchange') keys.push('min', 'max');
    if (category === 'account' || category === 'ladder') keys.push('tags', 'match');
    if (category === 'account') keys.push('skinTags', 'nicknameChars', 'nicknameRank', ...(kind === 'buy' ? ['ownerCountOfMine', 'myRecord', 'myNicknameType', 'myPhantom'] : ['nicknameTypes', 'maxOwners', 'recordStatus', 'phantom', ...CONDITION_KEYS]));
    return keys;
}

// 작성자 인증 filter: posts whose author holds the badge.
const BADGE_FILTERS = ['identity', 'proxy', 'credit'] as const;
const BADGE_FILTER_NAMES: Record<string, string> = { identity: '본인 인증', proxy: '대리 인증', credit: '신용인' };
const BADGE_CHIP_NAMES: Record<string, string> = { identity: '본인 인증 회원', proxy: '대리 인증 회원', credit: '신용인' };
// 계정 조건 in cafe words. 전비변 가능 sets both 비변 and 전변 (the server also counts 영전 as 전변 가능).
const CONDITIONS: { label: string; values: Record<string, string> }[] = [
    { label: '전비변 가능', values: { passwordChange: '가능', phoneChange: '가능' } },
    { label: '보멜 없음', values: { backupEmail: '없음' } },
    { label: '미통', values: { integrated: '미통합' } },
];
const CONDITION_KEYS = ['passwordChange', 'phoneChange', 'backupEmail', 'integrated'];
const conditionOn = (params: URLSearchParams, c: typeof CONDITIONS[number]) => Object.entries(c.values).every(([k, v]) => params.get(k) === v);
const conditionOff = (c: typeof CONDITIONS[number]) => Object.fromEntries(Object.keys(c.values).map(k => [k, '']));
const MY_RECORDS = ['무전적', '전적 있음'] as const;

// 닉 종류 filter values: a JSON list in the address (like 우대 스킨).
const readTypes = (raw: string | null) => parseList(raw || '', NICK_TYPES);

function readTags(raw: string | null): SeasonTag[] {
    try { const v = JSON.parse(raw || '[]'); return validTags(v, 999) ? v : []; } catch { return []; }
}

// Number field that commits after the user stops typing (or on Enter / blur). Integer fields are
// IntegerInput (leading digits only, within min and max).
function LazyNumber({ value, onCommit, placeholder, unit, max, min = 0, integer = false, step = '1', label }: { value: string; onCommit: (v: string) => void; placeholder: string; unit?: string; max?: number; min?: number; integer?: boolean; step?: string; label: string }) {
    const [draft, setDraft] = useState(value);
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => { setDraft(value); }, [value]);
    const commit = (v: string) => { clearTimeout(timer.current); if (v !== value) onCommit(v); };
    const change = (v: string) => { setDraft(v); clearTimeout(timer.current); timer.current = setTimeout(() => commit(v), 700); };
    const common = { className: 'input', placeholder, 'aria-label': label, onBlur: () => commit(draft), onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') commit(draft); } };
    return <div className={unit ? 'input-unit' : undefined}>
        {integer ? <IntegerInput {...common} value={draft} onChange={change} max={max} min={min} />
            : <input {...common} type="number" inputMode="decimal" min="0" max={max} step={step} autoComplete="off" value={draft} onChange={e => change(e.target.value)} />}
        {unit && <span>{unit}</span>}
    </div>;
}

function Group({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
    return <div className="filter-group"><h4>{title}</h4>{children}{hint && <p className="field-hint">{hint}</p>}</div>;
}

// '내 계정으로 찾기' on 구매 and on the wanted side of 교환: buyers' posts that my account fits.
function MyAccount({ params, update, prefix }: { params: URLSearchParams; update: (v: Record<string, string>) => void; prefix: '' | 'wanted' }) {
    const key = (name: string) => prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name;
    const owners = key('ownerCountOfMine'), chars = key('nicknameChars'), rank = key('nicknameRank'), record = key('myRecord'), type = key('myNicknameType'), phantom = key('myPhantom');
    return <Group title="내 계정으로 찾기" hint="내 계정 조건에 맞는 글만 표시">
        <div className="grid-gap-8">
            <LazyNumber label="내 계정 대주 수" value={params.get(owners) || ''} onCommit={v => update({ [owners]: v })} placeholder="내 계정 대주 수" unit="대주" integer min={1} max={9999} />
            <LazyNumber label="내 계정 팬텀 %" value={params.get(phantom) || ''} onCommit={v => update({ [phantom]: v })} placeholder="내 계정 팬텀 %" unit="%" integer max={PHANTOM_MAX} />
            <Segmented name="내 계정 전적" options={MY_RECORDS} value={params.get(record) || ''} onChange={v => update({ [record]: v })} />
            <LazyNumber label="내 닉네임 글자 수" value={params.get(chars) || ''} onCommit={v => update({ [chars]: v })} placeholder="내 닉네임 글자 수" unit="글자" integer min={1} max={20} />
            <RankPicker value={params.get(rank) ? [params.get(rank)!] : []} onChange={v => update({ [rank]: v[0] || '' })} />
            <NickTypePicker value={params.get(type) ? [params.get(type)!] : []} onChange={v => update({ [type]: v[0] || '' })} />
        </div>
    </Group>;
}

// Order: 가격/MAX, 래더, 우대 스킨, 대주 · 전적, 닉네임, 스킨 수 (팬텀 %), 계정 조건, 작성자 인증.
function Filters({ ctx, params, update }: { ctx: Ctx; params: URLSearchParams; update: (v: Record<string, string>) => void }) {
    const { kind, category } = ctx;
    const buying = kind === 'buy', account = category === 'account', exchange = kind === 'exchange';
    const tags = readTags(params.get('tags'));
    const money = (key: string) => wonToMan(params.get(key) ? Number(params.get(key)) : null);
    const setMoney = (key: string, v: string) => { const won = manToWon(v); update({ [key]: won === null || Number.isNaN(won) ? '' : String(won) }); };
    const wantedTags = readTags(params.get('wantedTags'));
    return <>
        {!exchange && <Group title={priceLabel(kind)}>
            <div className="range">
                <LazyNumber label="최소 금액 (만원)" value={money('min')} onCommit={v => setMoney('min', v)} placeholder="최소" unit="만원" step="0.1" />
                <span>~</span>
                <LazyNumber label="최대 금액 (만원)" value={money('max')} onCommit={v => setMoney('max', v)} placeholder="최대" unit="만원" step="0.1" />
            </div>
        </Group>}
        {exchange && ctx.wanted === 'account' && <>
            <h3 className="filter-section">상대가 구하는 계정</h3>
            <MyAccount params={params} update={update} prefix="wanted" />
            <Group title="구하는 래더" hint="하나라도 맞으면 표시">
                <SeasonPicker value={wantedTags} onChange={v => update({ wantedTags: v.length ? JSON.stringify(v) : '' })} />
            </Group>
        </>}
        {exchange && (account || category === 'ladder') && <h3 className="filter-section">상대가 내놓는 {categoryName(category)}</h3>}
        {(account || category === 'ladder') && <Group title={buying ? '원하는 래더' : category === 'ladder' ? '래더 시즌' : '래더 기록'} hint={tags.length > 1 ? undefined : '하나라도 맞으면 표시'}>
            <SeasonPicker value={tags} onChange={v => update({ tags: v.length ? JSON.stringify(v) : '', match: v.length > 1 ? params.get('match') || '' : '' })} />
            {tags.length > 1 && <label className="switch mt-12"><input type="checkbox" checked={params.get('match') === 'all'} onChange={e => update({ match: e.target.checked ? 'all' : '' })} />선택한 시즌 모두 포함</label>}
        </Group>}
        {account && <Group title="우대 스킨">
            <SkinPicker compact value={skinTags(params.get('skinTags') || '')} onChange={v => update({ skinTags: v.length ? JSON.stringify(v) : '' })} />
        </Group>}
        {account && buying && <MyAccount params={params} update={update} prefix="" />}
        {account && !buying && <Group title="대주 · 전적">
            <div className="grid-gap-8">
                <LazyNumber label="최대 대주 수" value={params.get('maxOwners') || ''} onCommit={v => update({ maxOwners: v })} placeholder="몇 대주 이하" unit="대주 이하" integer min={1} max={9999} />
                <Segmented name="전적" options={MY_RECORDS} value={params.get('recordStatus') || ''} onChange={v => update({ recordStatus: v })} />
            </div>
        </Group>}
        {account && !buying && <Group title="닉네임">
            <div className="grid-gap-8">
                <LazyNumber label="닉네임 글자 수" value={params.get('nicknameChars') || ''} onCommit={v => update({ nicknameChars: v })} placeholder="글자 수" unit="글자" integer min={1} max={20} />
                <RankPicker value={params.get('nicknameRank') ? [params.get('nicknameRank')!] : []} onChange={v => update({ nicknameRank: v[0] || '' })} />
                <NickTypePicker multiple value={readTypes(params.get('nicknameTypes'))} onChange={v => update({ nicknameTypes: v.length ? JSON.stringify(v) : '' })} />
            </div>
        </Group>}
        {account && !buying && <Group title={PHANTOM_LABEL} hint={PHANTOM_HINT}>
            <LazyNumber label="최소 팬텀 %" value={params.get('phantom') || ''} onCommit={v => update({ phantom: v })} placeholder="몇 % 이상" unit="% 이상" integer max={PHANTOM_MAX} />
        </Group>}
        {account && !buying && <Group title="계정 조건">
            <div className="chip-row condition-chips" role="group" aria-label="계정 조건">
                {CONDITIONS.map(c => { const on = conditionOn(params, c); return <button type="button" key={c.label} className="chip chip-sm" aria-pressed={on} onClick={() => update(on ? conditionOff(c) : c.values)}>{c.label}</button>; })}
            </div>
        </Group>}
        <Group title="작성자 인증">
            {/* 대리(진행) lists only 대리 인증 holders already, so that option would filter nothing there. */}
            <Segmented name="작성자 인증" options={ctx.kind === 'proxy_offer' ? BADGE_FILTERS.filter(b => b !== 'proxy') : BADGE_FILTERS} label={v => BADGE_FILTER_NAMES[v]} value={params.get('badge') || ''} onChange={v => update({ badge: v })} />
        </Group>
    </>;
}

function activeChips(ctx: Ctx, params: URLSearchParams, update: (v: Record<string, string>) => void, latest: number) {
    const chips: { key: string; label: string; clear: () => void }[] = [];
    const add = (key: string, label: string) => { if (params.get(key)) chips.push({ key, label, clear: () => update({ [key]: '' }) }); };
    add('q', `‘${params.get('q')}’`);
    if (params.get('closed') === 'only') chips.push({ key: 'closed', label: '거래완료만', clear: () => update({ closed: '' }) });
    const tags = readTags(params.get('tags'));
    // One chip per tier in the grouped form, highest tier first ('모든 시즌 마스터', '마스터 29~30시즌', WP68).
    for (const g of groupLadders(tags, null, latest)) {
        chips.push({ key: 'tier-' + g.tier, label: g.label, clear: () => { const rest = tags.filter(t => t.tier !== g.tier); update({ tags: rest.length ? JSON.stringify(rest) : '', match: rest.length > 1 ? params.get('match') || '' : '' }); } });
    }
    for (const skin of skinTags(params.get('skinTags') || '')) chips.push({ key: 'skin-' + skin, label: skin, clear: () => { const rest = skinTags(params.get('skinTags') || '').filter(v => v !== skin); update({ skinTags: rest.length ? JSON.stringify(rest) : '' }); } });
    // '구하는 래더 모든 시즌 챔피언 외 1': the first tier and how many other tiers.
    const wanted = groupLadders(readTags(params.get('wantedTags')), null, latest);
    if (wanted.length) chips.push({ key: 'wantedTags', label: '구하는 래더 ' + wanted[0].label + (wanted.length > 1 ? ` 외 ${wanted.length - 1}` : ''), clear: () => update({ wantedTags: '' }) });
    add('wantedOwnerCountOfMine', `내 계정 ${params.get('wantedOwnerCountOfMine')}대주`);
    add('wantedNicknameChars', `내 닉 ${params.get('wantedNicknameChars')}글자`);
    add('wantedNicknameRank', `내 닉 ${rankText([params.get('wantedNicknameRank') || ''])}`);
    add('wantedMyNicknameType', `내 닉 ${params.get('wantedMyNicknameType')}`);
    add('wantedMyRecord', `내 계정 ${params.get('wantedMyRecord')}`);
    add('wantedMyPhantom', `내 팬텀 ${params.get('wantedMyPhantom')}%`);
    const buying = ctx.kind === 'buy';
    add('nicknameChars', `${buying ? '내 닉 ' : '닉 '}${params.get('nicknameChars')}글자`);
    add('nicknameRank', `${buying ? '내 닉 ' : '닉 '}${rankText([params.get('nicknameRank') || ''])}`);
    add('myNicknameType', `내 닉 ${params.get('myNicknameType')}`);
    const types = readTypes(params.get('nicknameTypes'));
    for (const type of types) chips.push({ key: 'type-' + type, label: '닉 ' + type, clear: () => { const rest = types.filter(v => v !== type); update({ nicknameTypes: rest.length ? JSON.stringify(rest) : '' }); } });
    add('maxOwners', `${params.get('maxOwners')}대주 이하`);
    add('ownerCountOfMine', `내 계정 ${params.get('ownerCountOfMine')}대주`);
    add('recordStatus', params.get('recordStatus') || '');
    add('phantom', `팬텀 ${params.get('phantom')}% 이상`);
    add('myRecord', `내 계정 ${params.get('myRecord')}`);
    add('myPhantom', `내 팬텀 ${params.get('myPhantom')}%`);
    add('min', `${priceText(Number(params.get('min')))} 이상`);
    add('max', `${priceText(Number(params.get('max')))} 이하`);
    for (const c of CONDITIONS) if (conditionOn(params, c)) chips.push({ key: 'cond-' + c.label, label: c.label, clear: () => update(conditionOff(c)) });
    // A single condition from an older or typed address still shows, so it can be cleared.
    for (const key of CONDITION_KEYS) {
        const v = params.get(key);
        if (v && !CONDITIONS.some(c => key in c.values && conditionOn(params, c))) chips.push({ key, label: `${ACCOUNT_CHOICES[key].label}: ${choiceLabel(key, v)}`, clear: () => update({ [key]: '' }) });
    }
    const badge = params.get('badge');
    if (badge && BADGE_CHIP_NAMES[badge]) chips.push({ key: 'badge', label: BADGE_CHIP_NAMES[badge], clear: () => update({ badge: '' }) });
    return chips;
}

export function Board() {
    const { params } = useLocation();
    const { me, ready, config, requireLogin, openApply } = useApp();
    const rawKind = params.get('kind');
    const kind: TradeKind | 'all' = isTradeKind(rawKind) ? rawKind : 'all';
    const categories = kind === 'all' ? [] : categoriesForKind(kind);
    const category = kind === 'all' ? '' : categories.some(c => c.id === params.get('category')) ? params.get('category')! : categories[0].id;
    const wanted = params.get('wantedCategory') === 'clan' ? 'clan' : 'account';
    const ctx: Ctx = { kind, category, wanted };

    // Canonical query for the API: current tab + only the filters that apply to it.
    const query = new URLSearchParams();
    if (kind !== 'all') { query.set('kind', kind); query.set('category', category); }
    if (kind === 'exchange') query.set('wantedCategory', wanted);
    for (const key of allowedKeys(ctx)) { const v = params.get(key); if (v && !query.has(key)) query.set(key, v); }
    // Boards hide 거래완료 unless '거래완료 포함' is on (closed=1); closed=only lists 거래완료 alone
    // (the editor's '비슷한 거래완료 글').
    const closedOnly = query.get('closed') === 'only', closed = closedOnly || query.get('closed') === '1';
    const apiQuery = new URLSearchParams(query);
    apiQuery.delete('closed');
    if (closedOnly) apiQuery.set('status', 'closed');
    else if (!closed) apiQuery.set('active', '1');
    const queryString = apiQuery.toString();

    const cacheKey = (me?.id || '') + '|' + queryString;
    const [fetched, setFetched] = useState<(ListData & { key: string; error: string }) | null>(null);
    const cached = fetched?.key === cacheKey ? undefined : cacheGet(cacheKey);
    const data = fetched?.key === cacheKey ? fetched : cached ? { key: cacheKey, ...cached, error: '' } : null;
    const [reload, setReload] = useState(0), [sheet, setSheet] = useState(false);
    // Members whose folded rows were opened ('좀비사냥꾼 글 N개 더'); a new list folds again.
    const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
    useEffect(() => { setUnfolded(new Set()); }, [cacheKey]);
    const [saved, setSaved] = useState<Saved[]>(() => me && savedCache?.user === me.id ? savedCache.list : []), [savingSearch, setSavingSearch] = useState(false);
    useEffect(() => {
        if (!me) { setSaved([]); return; }
        if (savedCache?.user === me.id) { setSaved(savedCache.list); return; }
        let alive = true;
        api<{ searches: Saved[] }>('searches').then(d => { savedCache = { user: me.id, list: d.searches }; if (alive) setSaved(d.searches); }).catch(() => {});
        return () => { alive = false; };
    }, [me?.id]);
    // Follows the address (back/forward, chips) without overwriting what the member is typing.
    const urlQ = params.get('q') || '';
    const [q, setQ] = useState(urlQ);
    useEffect(() => { setQ(urlQ); }, [urlQ]);
    const tabsRef = useRef<HTMLDivElement>(null);
    // Brings the selected tab into view sideways only; scrollIntoView would also move the page
    // and undo the scroll position restored on Back.
    useEffect(() => {
        const bar = tabsRef.current, tab = bar?.querySelector('[aria-selected="true"]');
        if (!bar || !tab) return;
        const b = bar.getBoundingClientRect(), t = tab.getBoundingClientRect();
        if (t.left < b.left) bar.scrollLeft += t.left - b.left;
        else if (t.right > b.right) bar.scrollLeft += t.right - b.right;
    }, [kind]);
    // Waits for the session check, so a full page load asks for the list once.
    useEffect(() => {
        if (!ready) return;
        let alive = true;
        const key = cacheKey;
        api<ListData>('posts?' + queryString)
            .then(d => {
                if (!alive) return;
                const next: ListData = { posts: d.posts, total: d.total, capped: d.capped, ads: d.ads, counts: d.counts };
                const same = JSON.stringify(listCache.get(key)) === JSON.stringify(next);
                if (!same) cachePut(key, next);
                setFetched(prev => same && prev?.key === key ? prev : { key, ...(same ? listCache.get(key)! : next), error: '' });
            })
            .catch(e => {
                if (!alive) return;
                // A failed background check keeps the list already on screen.
                if (listCache.has(key)) return;
                setFetched({ key, posts: [], total: 0, error: errorText(e) });
            });
        return () => { alive = false; };
    }, [cacheKey, reload, ready]);

    const update = (values: Record<string, string>) => {
        const next = new URLSearchParams(query);
        next.delete('page');
        for (const [k, v] of Object.entries(values)) v ? next.set(k, v) : next.delete(k);
        void navigate('/trade?' + next.toString(), { replace: true });
    };
    // Page buttons add a history entry (so Back returns to the previous page) and go to the top of the list.
    const goPage = (n: number) => {
        const next = new URLSearchParams(query);
        n > 1 ? next.set('page', String(n)) : next.delete('page');
        void navigate('/trade?' + next.toString());
        window.scrollTo({ top: 0 });
    };
    const switchTo = (nextKind: TradeKind | 'all', nextCategory?: string, nextWanted?: string, keepSearch = true) => {
        const p: Record<string, string> = {};
        if (nextKind !== 'all') {
            p.kind = nextKind;
            const cats = categoriesForKind(nextKind);
            p.category = nextCategory && cats.some(c => c.id === nextCategory) ? nextCategory : cats[0].id;
            if (nextKind === 'exchange') p.wantedCategory = nextWanted || 'account';
        }
        if (keepSearch && params.get('q')) p.q = params.get('q')!;
        const keepClosed = params.get('closed');
        if (keepSearch && (keepClosed === '1' || keepClosed === 'only')) p.closed = keepClosed;
        void navigate(withParams('/trade', p));
    };
    // Resets every filter, including the search word and 거래완료 포함.
    const clearAll = () => { setQ(''); switchTo(kind, category, wanted, false); };
    const page = Math.max(1, Number(params.get('page')) || 1);
    const loading = !data;
    // Back to this list: return to where the member was once its rows are on screen.
    useLayoutEffect(() => {
        if (loading) return;
        const y = takeScrollRestore();
        if (y !== null) window.scrollTo(0, y);
    }, [loading, cacheKey]);
    const chips = activeChips(ctx, query, update, config.latestSeason);
    // Saved searches of this tab above the list; '이 조건 저장' next to the filter chips.
    const currentKey = searchKey(query);
    const tabSaved = saved.filter(v => (new URLSearchParams(v.query).get('kind') || 'all') === kind);
    const isSaved = saved.some(v => searchKey(v.query) === currentKey);
    async function refreshSaved() {
        const d = await api<{ searches: Saved[] }>('searches');
        if (me) savedCache = { user: me.id, list: d.searches };
        setSaved(d.searches);
    }
    async function saveSearch() {
        if (savingSearch) return;
        setSavingSearch(true);
        try { await api('searches', 'POST', { name: searchName(chips.map(c => c.label)), query: currentKey }); toast('저장 완료'); await refreshSaved(); }
        catch (e) { toast.error(errorText(e)); }
        finally { setSavingSearch(false); }
    }
    // The x deletes at once; the toast offers it back (saved again under the same name and query).
    async function deleteSearch(v: Saved) {
        try {
            await api('searches/' + v.id, 'DELETE');
            toast('삭제 완료', { action: { label: '되돌리기', onClick: () => void restoreSearch(v) } });
            await refreshSaved();
        } catch (e) { toast.error(errorText(e)); }
    }
    async function restoreSearch(v: Saved) {
        try { await api('searches', 'POST', { name: v.name, query: v.query, alert: !!v.alert }); await refreshSaved(); }
        catch (e) { toast.error(errorText(e)); }
    }
    // 새 글 알림 (WP54). The bell on a saved chip turns its 알림 on or off; '이 키워드 알림 받기' (after a
    // search) and the board header bell save the board's tab, category and word with the 알림 on, or
    // turn on the 알림 of the same saved search.
    const [alerting, setAlerting] = useState(false);
    async function setAlert(v: Saved, on: boolean) {
        if (alerting) return;
        setAlerting(true);
        try { await api('searches/' + v.id, 'PATCH', { alert: on }); toast(on ? ALERT_TEXT.on : ALERT_TEXT.off); await refreshSaved(); }
        catch (e) { toast.error(errorText(e)); }
        finally { setAlerting(false); }
    }
    const boardQuery = (word: string) => {
        const p = new URLSearchParams({ kind, category });
        if (kind === 'exchange') p.set('wantedCategory', wanted);
        if (word) p.set('q', word);
        return searchKey(p);
    };
    const searched = kind !== 'all' ? (params.get('q') || '').trim() : '';
    const keywordKey = searched ? boardQuery(searched) : '', boardKey = kind !== 'all' ? boardQuery('') : '';
    const keywordSaved = keywordKey ? saved.find(v => searchKey(v.query) === keywordKey) : undefined;
    const boardSaved = boardKey ? saved.find(v => searchKey(v.query) === boardKey) : undefined;
    function alertFor(key: string, name: string, existing: Saved | undefined, on: boolean) {
        requireLogin(async () => {
            if (existing) return setAlert(existing, on);
            if (alerting) return;
            setAlerting(true);
            try { await api('searches', 'POST', { name: name.length > 32 ? name.slice(0, 31) + '…' : name, query: key, alert: true }); toast(ALERT_TEXT.on); await refreshSaved(); }
            catch (e) { toast.error(errorText(e)); }
            finally { setAlerting(false); }
        });
    }
    const boardBellOn = !!boardSaved?.alert;
    const writeHref = kind === 'all' ? '/write' : withParams('/write', { kind, category, wantedCategory: kind === 'exchange' ? wanted : '' });
    const proxyLocked = kind === 'proxy_offer' && !(me?.role === 'manager' || me?.badges.includes('proxy'));
    const compose = () => requireLogin(u => {
        if (kind === 'proxy_offer' && !(u.role === 'manager' || u.badges.includes('proxy'))) openApply({ kind: 'badge', target: 'proxy' });
        else void navigate(writeHref);
    });
    const submit = (e: FormEvent) => { e.preventDefault(); update({ q: q.trim() }); };
    // Past the 300+ count the pager keeps going while pages come back full (as the profile and 내 글 do),
    // so every post of a busy board stays reachable.
    const full = !!data && !data.error && data.posts.length >= PAGE_SIZE;
    const totalPages = !data ? 0 : data.capped ? Math.max(Math.floor(COUNT_CAP / PAGE_SIZE), full ? page + 1 : page) : Math.ceil(data.total / PAGE_SIZE);
    const totalText = data ? (data.capped ? COUNT_CAP + '+' : data.total.toLocaleString()) : '';
    // Boards list the last 30 days; after the last page the member can go on into older posts, on the
    // same page number so the posts already seen stay on top. A search already covers every post.
    const showOld = !!data && !data.error && query.get('old') !== '1' && !query.get('q') && page >= totalPages;
    const openOld = () => { const next = new URLSearchParams(query); next.set('old', '1'); void navigate('/trade?' + next.toString()); };
    const title = kind === 'all' ? (params.get('q') ? '검색 결과' : '전체') : KIND_NAMES[kind];
    const highlight = readTags(query.get('tags'));

    const counts = kind === 'all' ? data?.counts : undefined;
    const filters = kind !== 'all';
    const exchangeSides = categories.map(c => c.id);

    return <div className="container page board">
        <div className="board-head">
            <h1 className="page-title">{title}</h1>
            <div className="board-head-tools">
                {kind !== 'all' && <button type="button" className={'icon-btn board-bell' + (boardBellOn ? ' is-on' : '')} aria-label={ALERT_TEXT.boardBell} aria-pressed={boardBellOn} title={`${KIND_NAMES[kind]} · ${categoryName(category)} ${ALERT_TEXT.boardBell}`} disabled={alerting}
                    onClick={() => alertFor(boardKey, `${KIND_NAMES[kind]} · ${categoryName(category)}`, boardSaved, !boardBellOn)}>{boardBellOn ? <BellRing size={20} /> : <Bell size={20} />}</button>}
                <button type="button" className="btn btn-line btn-sm board-write" onClick={compose}><PenLine size={16} />{kind === 'all' ? '글쓰기' : `${KIND_NAMES[kind]} 글쓰기`}</button>
            </div>
        </div>
        <div className="tabs kind-tabs" role="tablist" aria-label="거래 구분" ref={tabsRef}>
            {kind === 'all' && <button type="button" role="tab" className="tab" aria-selected>전체{counts && <b>{data!.total.toLocaleString()}</b>}</button>}
            {TRADE_KINDS.map(k => <button type="button" role="tab" key={k} className="tab" aria-selected={kind === k} onClick={() => switchTo(k)}>{KIND_NAMES[k]}{counts && <b className={counts[k] ? undefined : 'zero'}>{(counts[k] || 0).toLocaleString()}</b>}</button>)}
        </div>
        {kind !== 'all' && <div className="board-sub">
            {kind === 'exchange' ? <div className="exchange-pick">
                <Segmented name="내놓는 대상" options={exchangeSides} label={categoryName} allowEmpty={false} value={category} onChange={v => { if (v) switchTo(kind, v, wanted); }} />
                <span>에서</span>
                <Segmented name="구하는 대상" options={exchangeSides} label={categoryName} allowEmpty={false} value={wanted} onChange={v => { if (v) switchTo(kind, category, v); }} />
                <span>구함</span>
            </div> : <div className="chip-scroll">{categories.map(c => <button type="button" key={c.id} className="chip" aria-pressed={category === c.id} onClick={() => switchTo(kind, c.id)}>{c.name}</button>)}</div>}
        </div>}
        {proxyLocked && <div className="board-notice"><CIcon name={KIND_ICONS.proxy_offer} size={28} /><span>대리(진행) 글쓰기는 <b>대리 인증</b> 필요</span><button type="button" className="btn btn-line btn-sm" onClick={() => openApply({ kind: 'badge', target: 'proxy' })}>대리 인증 신청</button></div>}

        <div className={'board-layout' + (filters ? '' : ' no-filters')}>
            {filters && <aside className="filter-panel" aria-label="필터">
                <div className="filter-head"><strong>필터</strong><button type="button" className="btn btn-text small" onClick={clearAll}><RotateCcw size={14} />초기화</button></div>
                <Filters ctx={ctx} params={query} update={update} />
            </aside>}
            <section aria-label="거래 목록">
                <div className="list-top">
                    <form className="search-input" role="search" onSubmit={submit}>
                        <Search size={20} />
                        <input value={q} onChange={e => setQ(e.target.value)} placeholder={kind === 'all' ? '스킨, 제목, 닉네임 (예: 악주, 뱀동)' : `${KIND_NAMES[kind]} 글 검색`} aria-label="검색어" />
                        {q && <button type="button" className="icon-btn" aria-label="검색어 지우기" onClick={() => { setQ(''); update({ q: '' }); }}><X size={18} /></button>}
                    </form>
                    {filters && <button type="button" className="btn btn-line filter-open" onClick={() => setSheet(true)}><SlidersHorizontal size={18} />필터{chips.length > 0 && <b className="filter-count">{chips.length}</b>}</button>}
                </div>
                {tabSaved.length > 0 && <div className="chip-scroll saved-searches" role="group" aria-label="저장한 검색">
                    <span className="saved-label">저장한 검색</span>
                    {tabSaved.map(v => { const on = searchKey(v.query) === currentKey; return <span key={v.id} className={'saved-chip' + (on ? ' on' : '')}>
                        <button type="button" aria-pressed={on} title={v.name} onClick={() => { if (!on) void navigate('/trade?' + v.query); }}>{v.name}</button>
                        <button type="button" className={'saved-bell' + (v.alert ? ' is-on' : '')} aria-label={`${v.name} ${ALERT_TEXT.boardBell}`} aria-pressed={!!v.alert} disabled={alerting} onClick={() => void setAlert(v, !v.alert)}>{v.alert ? <BellRing size={13} /> : <Bell size={13} />}</button>
                        <button type="button" aria-label={v.name + ' 삭제'} onClick={() => void deleteSearch(v)}><X size={13} /></button>
                    </span>; })}
                </div>}
                {searched && !keywordSaved?.alert && <div className="keyword-alert"><button type="button" className="btn btn-line btn-sm" disabled={alerting} onClick={() => alertFor(keywordKey, searched, keywordSaved, true)}><Bell size={15} />{ALERT_TEXT.keywordButton}</button></div>}
                {chips.length > 0 && <div className="active-filters">{chips.map(c => <button type="button" key={c.key} onClick={c.clear} aria-label={c.label + ' 해제'}>{c.label}<X size={13} /></button>)}
                    {me && !isSaved && <button type="button" className="btn btn-line btn-xs save-search" disabled={savingSearch} onClick={() => void saveSearch()}>이 조건 저장</button>}
                    <button type="button" className="clear" onClick={clearAll}>전체 해제</button></div>}
                <div className="list-meta">
                    <p aria-live="polite">{loading ? '불러오는 중' : <><b>{totalText}</b>건</>}</p>
                    <div className="list-tools">
                        <label className="switch"><input type="checkbox" checked={closed} onChange={e => update({ closed: e.target.checked ? '1' : '' })} />거래완료 포함</label>
                        {kind !== 'all' && kind !== 'exchange' && <select className="select" aria-label="정렬" value={query.get('sort') || 'latest'} onChange={e => update({ sort: e.target.value === 'latest' ? '' : e.target.value })}>
                            <option value="latest">최신순</option><option value="price-low">낮은 가격순</option><option value="price-high">높은 가격순</option>
                        </select>}
                    </div>
                </div>
                {/* '광고 매물' (WP53, page 1, 최신순): separate from the list below, whose order, counts and pages do not change. */}
                {!loading && !data!.error && <AdBox ads={data!.ads} list={data!.posts} />}
                {loading ? <SkeletonRows />
                    : data!.error ? <EmptyState title="목록을 불러오지 못했습니다" text={data!.error} action={<div className="empty-actions"><button className="btn btn-line" onClick={() => setReload(n => n + 1)}>다시 시도</button><button className="btn btn-line" onClick={clearAll}>필터 초기화</button></div>} />
                    : data!.posts.length ? <div className="post-list">{foldRows(data!.posts, unfolded).map(row => 'post' in row
                        ? <PostCard key={row.post.id} post={row.post} showKind={kind === 'all'} highlight={highlight} onChange={() => setReload(n => n + 1)} />
                        : <button type="button" key={'more-' + row.more} className="fold-more" onClick={() => setUnfolded(prev => new Set(prev).add(row.more))}>{AD_TEXT.more(row.name, row.count)}</button>)}</div>
                    : <EmptyState icon={chips.length ? 'search' : 'file'} title={chips.length ? '검색 결과가 없습니다' : '등록된 글이 없습니다'}
                        action={chips.length ? <button className="btn btn-line" onClick={clearAll}>필터 초기화</button> : <button className="btn btn-line" onClick={compose}>글쓰기</button>} />}
                {totalPages > 1 && <nav className="pager" aria-label="페이지">
                    <button type="button" disabled={page <= 1} onClick={() => goPage(page - 1)}>이전</button>
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => Math.max(1, Math.min(page - 2, totalPages - 4)) + i).map(n => <button type="button" key={n} aria-current={n === page ? 'page' : undefined} onClick={() => goPage(n)}>{n}</button>)}
                    <button type="button" disabled={page >= totalPages} onClick={() => goPage(page + 1)}>다음</button>
                </nav>}
                {showOld && <div className="list-more"><button type="button" className="btn btn-line" onClick={openOld}>오래된 글 보기</button></div>}
            </section>
        </div>
        {filters && <Modal open={sheet} onClose={() => setSheet(false)} title="필터" footer={<><button className="btn btn-line" onClick={clearAll}>초기화</button><button className="btn btn-primary" onClick={() => setSheet(false)}>{loading ? '결과 보기' : `${totalText}건 보기`}</button></>}>
            <div className="sheet-filters"><Filters ctx={ctx} params={query} update={update} /></div>
        </Modal>}
    </div>;
}

