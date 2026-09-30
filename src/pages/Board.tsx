import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { PenLine, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react';
import {
    KIND_ICONS, KIND_NAMES, RECORD_PREFERENCES, TIERS, categoriesForKind, categoryName, isTradeKind, manToWon, priceText, skinTags, validTags, wonToMan,
    type Post, type SeasonTag, type TradeKind,
} from '../../shared/market';
import { api, errorText } from '../lib/api';
import { navigate, useLocation, withParams } from '../lib/router';
import { useApp } from '../app/state';
import { CIcon, EmptyState, Modal, SkeletonRows } from '../components/ui';
import { PostCard } from '../components/PostCard';
import { RankPicker, SeasonPicker, Segmented, SkinPicker } from '../components/Pickers';

const TAB_ORDER: TradeKind[] = ['buy', 'sell', 'exchange', 'proxy_request', 'proxy_offer'];
const PAGE_SIZE = 16;

type Ctx = { kind: TradeKind | 'all'; category: string; wanted: string };

// Only parameters that mean something for the current tab reach the API.
function allowedKeys({ kind, category }: Ctx) {
    const keys = ['kind', 'category', 'q', 'active', 'page', 'sort'];
    if (kind === 'all') return ['q', 'active', 'page'];
    if (kind === 'exchange') keys.push('wantedCategory');
    if (kind !== 'exchange') keys.push('min', 'max');
    if (category === 'account' || category === 'ladder') keys.push('tags', 'match');
    if (category === 'account') keys.push('skinTags', 'nicknameChars', 'nicknameRank', ...(kind === 'buy' ? ['ownerCountOfMine', 'recordPreference'] : ['maxOwners', 'recordStatus', 'phantom']));
    return keys;
}

function readTags(raw: string | null): SeasonTag[] {
    try { const v = JSON.parse(raw || '[]'); return validTags(v, 999) ? v : []; } catch { return []; }
}

// Number field that commits after the user stops typing (or on Enter / blur).
function LazyNumber({ value, onCommit, placeholder, unit, max, step = '1', label }: { value: string; onCommit: (v: string) => void; placeholder: string; unit?: string; max?: number; step?: string; label: string }) {
    const [draft, setDraft] = useState(value);
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => { setDraft(value); }, [value]);
    const commit = (v: string) => { clearTimeout(timer.current); if (v !== value) onCommit(v); };
    return <div className={unit ? 'input-unit' : undefined}>
        <input className="input" inputMode="decimal" type="number" min="0" max={max} step={step} placeholder={placeholder} aria-label={label} value={draft}
            onChange={e => { const v = e.target.value; setDraft(v); clearTimeout(timer.current); timer.current = setTimeout(() => commit(v), 700); }}
            onBlur={() => commit(draft)} onKeyDown={e => { if (e.key === 'Enter') commit(draft); }} />
        {unit && <span>{unit}</span>}
    </div>;
}

function Group({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
    return <div className="filter-group"><h4>{title}</h4>{children}{hint && <p className="field-hint">{hint}</p>}</div>;
}

function Filters({ ctx, params, update }: { ctx: Ctx; params: URLSearchParams; update: (v: Record<string, string>) => void }) {
    const { kind, category } = ctx;
    const buying = kind === 'buy', account = category === 'account';
    const tags = readTags(params.get('tags'));
    const money = (key: string) => wonToMan(params.get(key) ? Number(params.get(key)) : null);
    const setMoney = (key: string, v: string) => { const won = manToWon(v); update({ [key]: won === null || Number.isNaN(won) ? '' : String(won) }); };
    if (kind === 'all') return <Group title="거래 상태"><label className="switch"><input type="checkbox" checked={params.get('active') === '1'} onChange={e => update({ active: e.target.checked ? '1' : '' })} />거래완료 제외</label></Group>;
    return <>
        {account && buying && <Group title="내 계정으로 찾기" hint="내 계정 조건을 넣으면 받아 줄 구매 글만 보여요.">
            <div className="grid-gap-8">
                <LazyNumber label="내 계정 대주 수" value={params.get('ownerCountOfMine') || ''} onCommit={v => update({ ownerCountOfMine: v })} placeholder="내 계정 대주 수" unit="대주" max={9999} />
                <LazyNumber label="내 닉네임 글자 수" value={params.get('nicknameChars') || ''} onCommit={v => update({ nicknameChars: v })} placeholder="내 닉네임 글자 수" unit="글자" max={20} />
                <RankPicker value={params.get('nicknameRank') ? [params.get('nicknameRank')!] : []} onChange={v => update({ nicknameRank: v[0] || '' })} />
            </div>
        </Group>}
        {account && buying && <Group title="전적 조건"><Segmented name="전적 조건" options={RECORD_PREFERENCES} value={params.get('recordPreference') || ''} onChange={v => update({ recordPreference: v })} /></Group>}
        {(account || category === 'ladder') && <Group title={buying ? '원하는 래더' : category === 'ladder' ? '래더 시즌' : '래더 기록'} hint={tags.length > 1 ? undefined : '티어를 누르고 시즌을 고르세요. 하나라도 맞으면 보여줘요.'}>
            <SeasonPicker value={tags} onChange={v => update({ tags: v.length ? JSON.stringify(v) : '', match: v.length > 1 ? params.get('match') || '' : '' })} />
            {tags.length > 1 && <label className="switch mt-12"><input type="checkbox" checked={params.get('match') === 'all'} onChange={e => update({ match: e.target.checked ? 'all' : '' })} />선택한 시즌을 모두 가진 글만</label>}
        </Group>}
        {account && <Group title={buying ? '원하는 우대 스킨' : '보유 우대 스킨'}>
            <SkinPicker value={skinTags(params.get('skinTags') || '')} onChange={v => update({ skinTags: v.length ? JSON.stringify(v) : '' })} />
        </Group>}
        {account && !buying && <Group title="닉네임">
            <div className="grid-gap-8">
                <LazyNumber label="닉네임 글자 수" value={params.get('nicknameChars') || ''} onCommit={v => update({ nicknameChars: v })} placeholder="글자 수" unit="글자" max={20} />
                <RankPicker value={params.get('nicknameRank') ? [params.get('nicknameRank')!] : []} onChange={v => update({ nicknameRank: v[0] || '' })} />
            </div>
        </Group>}
        {account && !buying && <Group title="대주 · 전적">
            <div className="grid-gap-8">
                <LazyNumber label="최대 대주 수" value={params.get('maxOwners') || ''} onCommit={v => update({ maxOwners: v })} placeholder="몇 대주 이하" unit="대주 이하" max={9999} />
                <Segmented name="전적" options={['무전적', '전적 있음'] as const} value={params.get('recordStatus') || ''} onChange={v => update({ recordStatus: v })} />
            </div>
        </Group>}
        {account && !buying && <Group title="팬텀">
            <LazyNumber label="최소 팬텀 %" value={params.get('phantom') || ''} onCommit={v => update({ phantom: v })} placeholder="몇 % 이상" unit="% 이상" max={5000} />
        </Group>}
        {kind !== 'exchange' && <Group title={kind === 'sell' ? '즉거가' : buying ? '최대 예산' : '비용'}>
            <div className="range">
                <LazyNumber label="최소 금액 (만원)" value={money('min')} onCommit={v => setMoney('min', v)} placeholder="최소" unit="만원" step="0.1" />
                <span>~</span>
                <LazyNumber label="최대 금액 (만원)" value={money('max')} onCommit={v => setMoney('max', v)} placeholder="최대" unit="만원" step="0.1" />
            </div>
        </Group>}
        <Group title="거래 상태"><label className="switch"><input type="checkbox" checked={params.get('active') === '1'} onChange={e => update({ active: e.target.checked ? '1' : '' })} />거래완료 제외</label></Group>
    </>;
}

function activeChips(ctx: Ctx, params: URLSearchParams, update: (v: Record<string, string>) => void) {
    const chips: { key: string; label: string; clear: () => void }[] = [];
    const add = (key: string, label: string) => { if (params.get(key)) chips.push({ key, label, clear: () => update({ [key]: '' }) }); };
    add('q', `‘${params.get('q')}’`);
    const tags = readTags(params.get('tags'));
    for (const tier of TIERS) {
        const seasons = tags.filter(t => t.tier === tier.id).map(t => t.season).sort((a, b) => a - b);
        if (seasons.length) chips.push({ key: 'tier-' + tier.id, label: `${tier.name} ${seasons.join(', ')}시즌`, clear: () => { const rest = tags.filter(t => t.tier !== tier.id); update({ tags: rest.length ? JSON.stringify(rest) : '', match: rest.length > 1 ? params.get('match') || '' : '' }); } });
    }
    for (const skin of skinTags(params.get('skinTags') || '')) chips.push({ key: 'skin-' + skin, label: skin, clear: () => { const rest = skinTags(params.get('skinTags') || '').filter(v => v !== skin); update({ skinTags: rest.length ? JSON.stringify(rest) : '' }); } });
    const buying = ctx.kind === 'buy';
    add('nicknameChars', `${buying ? '내 닉 ' : '닉 '}${params.get('nicknameChars')}글자`);
    add('nicknameRank', `${buying ? '내 닉 ' : '닉 '}${params.get('nicknameRank')}`);
    add('maxOwners', `${params.get('maxOwners')}대주 이하`);
    add('ownerCountOfMine', `내 계정 ${params.get('ownerCountOfMine')}대주`);
    add('recordStatus', params.get('recordStatus') || '');
    add('phantom', `팬텀 ${params.get('phantom')}% 이상`);
    add('recordPreference', params.get('recordPreference') || '');
    add('min', `${priceText(Number(params.get('min')))} 이상`);
    add('max', `${priceText(Number(params.get('max')))} 이하`);
    add('active', '거래완료 제외');
    return chips;
}

export function Board() {
    const { params } = useLocation();
    const { me, requireLogin, openApply } = useApp();
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
    const queryString = query.toString();

    const [data, setData] = useState<{ key: string; posts: Post[]; total: number; error: string } | null>(null);
    const [reload, setReload] = useState(0), [sheet, setSheet] = useState(false);
    const [q, setQ] = useState(params.get('q') || '');
    useEffect(() => { setQ(params.get('q') || ''); }, [params]);
    useEffect(() => {
        let alive = true;
        api<{ posts: Post[]; total: number }>('posts?' + queryString)
            .then(d => { if (alive) setData({ key: queryString, posts: d.posts, total: d.total, error: '' }); })
            .catch(e => { if (alive) setData({ key: queryString, posts: [], total: 0, error: errorText(e) }); });
        return () => { alive = false; };
    }, [queryString, reload, me?.id]);

    const update = (values: Record<string, string>) => {
        const next = new URLSearchParams(query);
        next.delete('page');
        for (const [k, v] of Object.entries(values)) v ? next.set(k, v) : next.delete(k);
        void navigate('/trade?' + next.toString(), { replace: true });
    };
    const switchTo = (nextKind: TradeKind | 'all', nextCategory?: string, nextWanted?: string) => {
        const p: Record<string, string> = {};
        if (nextKind !== 'all') {
            p.kind = nextKind;
            const cats = categoriesForKind(nextKind);
            p.category = nextCategory && cats.some(c => c.id === nextCategory) ? nextCategory : cats[0].id;
            if (nextKind === 'exchange') p.wantedCategory = nextWanted || 'account';
        }
        if (params.get('q')) p.q = params.get('q')!;
        if (params.get('active')) p.active = '1';
        void navigate(withParams('/trade', p));
    };
    const clearAll = () => switchTo(kind, category, wanted);
    const page = Math.max(1, Number(params.get('page')) || 1);
    const loading = !data || data.key !== queryString;
    const chips = activeChips(ctx, query, update);
    const writeHref = kind === 'all' ? '/write' : withParams('/write', { kind, category, wantedCategory: kind === 'exchange' ? wanted : '' });
    const proxyLocked = kind === 'proxy_offer' && !(me?.role === 'manager' || me?.badges.includes('proxy'));
    const compose = () => requireLogin(() => {
        if (kind === 'proxy_offer' && !(me?.role === 'manager' || me?.badges.includes('proxy'))) openApply({ kind: 'badge', target: 'proxy' });
        else void navigate(writeHref);
    });
    const submit = (e: FormEvent) => { e.preventDefault(); update({ q: q.trim() }); };
    const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;
    const title = kind === 'all' ? (params.get('q') ? '검색 결과' : '전체 거래') : KIND_NAMES[kind];
    const highlight = readTags(query.get('tags'));

    return <div className="container page board">
        <div className="board-head">
            <h1 className="page-title">{title}</h1>
            <button type="button" className="btn btn-primary btn-sm" onClick={compose}><PenLine size={16} />{kind === 'all' ? '글쓰기' : `${KIND_NAMES[kind]} 글쓰기`}</button>
        </div>
        <div className="tabs kind-tabs" role="tablist" aria-label="거래 구분">
            {kind === 'all' && <button type="button" role="tab" className="tab" aria-selected>전체</button>}
            {TAB_ORDER.map(k => <button type="button" role="tab" key={k} className="tab" aria-selected={kind === k} onClick={() => switchTo(k)}><CIcon name={KIND_ICONS[k]} size={22} />{KIND_NAMES[k]}</button>)}
        </div>
        {kind !== 'all' && <div className="board-sub">
            {kind === 'exchange' ? <div className="exchange-pick">
                <select className="select" aria-label="내놓는 대상" value={category} onChange={e => switchTo(kind, e.target.value, wanted)}>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                <span>에서</span>
                <select className="select" aria-label="구하는 대상" value={wanted} onChange={e => switchTo(kind, category, e.target.value)}>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                <span>구함</span>
            </div> : <div className="chip-scroll">{categories.map(c => <button type="button" key={c.id} className="chip" aria-pressed={category === c.id} onClick={() => switchTo(kind, c.id)}>{c.name}</button>)}</div>}
        </div>}
        {proxyLocked && <div className="board-notice"><CIcon name="video-game" size={28} /><span>대리(진행) 글은 <b>대리 인증</b>을 받은 회원만 올릴 수 있어요.</span><button type="button" className="btn btn-line btn-sm" onClick={() => openApply({ kind: 'badge', target: 'proxy' })}>대리 인증 신청</button></div>}

        <div className="board-layout">
            <aside className="filter-panel" aria-label="필터">
                <div className="filter-head"><strong>필터</strong><button type="button" className="btn btn-text small" onClick={clearAll}><RotateCcw size={14} />초기화</button></div>
                <Filters ctx={ctx} params={query} update={update} />
            </aside>
            <section aria-label="거래 목록">
                <div className="list-top">
                    <form className="search-input" role="search" onSubmit={submit}>
                        <Search size={20} />
                        <input value={q} onChange={e => setQ(e.target.value)} placeholder={kind === 'all' ? '제목, 스킨, 닉네임으로 검색' : `${KIND_NAMES[kind]} 글에서 검색`} aria-label="검색어" />
                        {q && <button type="button" className="icon-btn" aria-label="검색어 지우기" onClick={() => { setQ(''); update({ q: '' }); }}><X size={18} /></button>}
                    </form>
                    <button type="button" className="btn btn-line filter-open" onClick={() => setSheet(true)}><SlidersHorizontal size={18} />필터{chips.length > 0 && <b className="filter-count">{chips.length}</b>}</button>
                </div>
                {chips.length > 0 && <div className="active-filters">{chips.map(c => <button type="button" key={c.key} onClick={c.clear} aria-label={c.label + ' 해제'}>{c.label}<X size={13} /></button>)}<button type="button" className="clear" onClick={clearAll}>전체 해제</button></div>}
                <div className="list-meta">
                    <p aria-live="polite">{loading ? '불러오는 중' : <><b>{data!.total.toLocaleString()}</b>건</>}</p>
                    {kind !== 'all' && kind !== 'exchange' && <select className="select" aria-label="정렬" value={query.get('sort') || 'latest'} onChange={e => update({ sort: e.target.value === 'latest' ? '' : e.target.value })}>
                        <option value="latest">최신순</option><option value="price-low">낮은 가격순</option><option value="price-high">높은 가격순</option>
                    </select>}
                </div>
                {loading ? <SkeletonRows />
                    : data!.error ? <EmptyState icon="warning" title="목록을 불러오지 못했어요" text={data!.error} action={<button className="btn btn-line" onClick={() => setReload(n => n + 1)}>다시 시도</button>} />
                    : data!.posts.length ? <div className="post-list">{data!.posts.map(p => <PostCard key={p.id} post={p} highlight={highlight} onChange={() => setReload(n => n + 1)} />)}</div>
                    : <EmptyState icon={kind === 'all' ? 'magnifying-glass-tilted-left' : KIND_ICONS[kind]} title={chips.length ? '조건에 맞는 글이 없어요' : '아직 올라온 글이 없어요'}
                        text={chips.length ? '필터를 줄이거나 검색어를 바꿔 보세요.' : kind === 'all' ? undefined : `${KIND_NAMES[kind]} · ${kind === 'exchange' ? `${categoryName(category)}에서 ${categoryName(wanted)} 구함` : categoryName(category)} 첫 글을 올려 보세요.`}
                        action={chips.length ? <button className="btn btn-line" onClick={clearAll}>필터 초기화</button> : <button className="btn btn-primary" onClick={compose}>글쓰기</button>} />}
                {totalPages > 1 && <nav className="pager" aria-label="페이지">
                    <button type="button" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>이전</button>
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => Math.max(1, Math.min(page - 2, totalPages - 4)) + i).map(n => <button type="button" key={n} aria-current={n === page ? 'page' : undefined} onClick={() => update({ page: n === 1 ? '' : String(n) })}>{n}</button>)}
                    <button type="button" disabled={page >= totalPages} onClick={() => update({ page: String(page + 1) })}>다음</button>
                </nav>}
            </section>
        </div>
        <Modal open={sheet} onClose={() => setSheet(false)} title="필터" footer={<><button className="btn btn-line" onClick={clearAll}>초기화</button><button className="btn btn-primary" onClick={() => setSheet(false)}>{loading ? '결과 보기' : `${data!.total.toLocaleString()}건 보기`}</button></>}>
            <div className="sheet-filters"><Filters ctx={ctx} params={query} update={update} /></div>
        </Modal>
    </div>;
}

