'use client';
import { useState, useEffect } from 'react';
import { useSearchParams, usePathname } from 'next/navigation';
import { Search, SlidersHorizontal, PenLine, Heart, Bookmark, RotateCcw, X } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Pagination, PaginationContent, PaginationItem, PaginationLink } from '@/components/ui/pagination';
import { toast } from 'sonner';
import { TIERS, NICK_RANKS, accountSummary, skinTags, CATEGORIES, categoriesForKind, normalizeTrade, KIND_NAMES, STATUS_NAMES, relativeTime, type Post, type SeasonTag, validTags } from '@/lib/market';
import { SkinChoices } from './account-fields';
import { PriceDisplay } from './price-display';
import { api, errorMessage, Loading, EmptyState, TagBadges, SeasonPicker, useMarket, Role } from './shared';

const TRADE_TABS = ['buy', 'sell', 'exchange', 'proxy_request', 'proxy_offer'] as const;
const ACCOUNT_FILTERS = ['nicknameChars', 'nicknameRank', 'maxOwners', 'ownerCountOfMine', 'recordStatus', 'recordPreference'] as const;
const categoryName = (id: string) => CATEGORIES.find(c => c.id === id)?.name || id;

function resultSummary(post: Post) {
    const d = post.details;
    if (post.category === 'account') {
        return accountSummary(d).slice(0, 5);
    }
    if (post.category === 'clan') return [d.clanName, d.clanLevel ? '클랜 레벨 ' + d.clanLevel : '', d.clanMembers ? '인원 ' + d.clanMembers + '명' : ''].filter(Boolean);
    if (post.kind === 'proxy_request' || post.kind === 'proxy_offer') return [d.target, d.schedule].filter(Boolean);
    return [];
}

export function ListingRows({ posts, grid = false, onFavorite }: { posts: Post[]; grid?: boolean; onFavorite?: () => void; }) {
    const { go, me, login } = useMarket();
    const pathname = usePathname(), searchParams = useSearchParams();
    const returnTo = pathname + (searchParams.toString() ? '?' + searchParams.toString() : '');
    const postPath = (id: number) => '/posts/' + id + '?from=' + encodeURIComponent(returnTo);
    const openLink = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) { e.preventDefault(); go(href); } };
    const orderedTags = (post: Post) => {
        let chosen: SeasonTag[] = [];
        try { const parsed = JSON.parse(searchParams.get('tags') || '[]'); if (validTags(parsed)) chosen = parsed; } catch { /* Invalid stored search values are ignored. */ }
        return [...post.tags].sort((a, b) => Number(chosen.some(t => t.tier === b.tier && t.season === b.season)) - Number(chosen.some(t => t.tier === a.tier && t.season === a.season)));
    };
    async function favorite(p: Post) {
        if (!me) { login(); return; }
        try {
            await api('posts/' + p.id + '/favorite', 'POST', { active: !p.favorite });
            p.favorite = !p.favorite;
            onFavorite?.();
            toast.success(p.favorite ? '찜에 저장했습니다.' : '찜을 해제했습니다.');
        } catch (e) { toast.error(errorMessage(e)); }
    }
    return <div className={grid ? 'market-results results-grid' : 'market-results results-list'}>{posts.map(p => <article className={'trade-result' + (p.images[0] ? ' has-photo' : '')} key={p.id}>
        {p.images[0] && <a className="result-image" href={postPath(p.id)} onClick={e => openLink(e, postPath(p.id))} aria-label={p.title + ' 상세 보기'}><img src={'/api/images/' + p.images[0]} alt="" loading="lazy" /></a>}
        <div className="result-body">
            <div className="result-eyebrow"><span className={'kind-badge ' + p.kind}>{KIND_NAMES[p.kind]}</span><span>{p.kind === 'exchange' ? categoryName(p.category) + '에서 ' + categoryName(p.details.wantedCategory || 'account') + ' 구함' : categoryName(p.category)}</span>{p.status !== 'open' && <span className={'status-badge ' + p.status}>{STATUS_NAMES[p.status]}</span>}</div>
            <a className="result-title" href={postPath(p.id)} onClick={e => openLink(e, postPath(p.id))}>{p.title}</a>
            <div className="result-price"><PriceDisplay post={p} compact /></div>
            <div className="result-conditions"><TagBadges tags={orderedTags(p)} limit={grid ? 2 : 3} /><div className="result-specs">{resultSummary(p).map(v => <span key={v}>{v}</span>)}</div></div>
            <div className="result-person"><button onClick={() => go('/profile/' + p.author_id)}>{p.nickname}</button>{p.role === 'manager' && <Role role={p.role} />}<time dateTime={new Date(p.created_at).toISOString()}>{relativeTime(p.created_at)}</time></div>
        </div>
        <button className={'result-favorite ' + (p.favorite ? 'hearted' : '')} aria-label={p.favorite ? '찜 해제' : '찜하기'} aria-pressed={p.favorite} onClick={() => favorite(p)}><Heart size={19} fill={p.favorite ? 'currentColor' : 'none'} /></button>
    </article>)}</div>;
}

export function Board() {
    const rawParams = useSearchParams(), { go, me, login, revision } = useMarket();
    const [result, setResult] = useState<{ key: string; posts: Post[]; total: number; error: string }>({ key: '', posts: [], total: 0, error: '' });
    const [filters, setFilters] = useState(''), [filterOpen, setFilterOpen] = useState(false), [refresh, setRefresh] = useState(0), [save, setSave] = useState(false), [name, setName] = useState('');
    const rawKind = rawParams.get('kind') || 'sell';
    const normalized = normalizeTrade(rawKind, rawParams.get('category') || 'account');
    const kind = normalized.kind, categories = categoriesForKind(kind);
    const category = categories.some(c => c.id === normalized.category) ? normalized.category : categories[0].id;
    const effectiveParams = new URLSearchParams(rawParams.toString());
    effectiveParams.set('kind', kind); effectiveParams.set('category', category);
    if (kind !== 'exchange') effectiveParams.delete('wantedCategory');
    const page = Math.max(1, Number(rawParams.get('page')) || 1);
    const isAccount = category === 'account', isBuying = kind === 'buy', isExchange = kind === 'exchange';
    const wantedCategory = rawParams.get('wantedCategory') === 'clan' ? 'clan' : 'account';
    if (isExchange) effectiveParams.set('wantedCategory', wantedCategory);
    const hasLadder = isAccount || category === 'ladder';
    const allowedParams = new Set(['kind', 'category', 'q', 'active', 'page', ...(isExchange ? ['wantedCategory'] : ['min', 'max', 'sort']), ...(hasLadder ? ['tags', 'match'] : []), ...(isAccount ? ['skinTags', 'nicknameChars', 'nicknameRank', ...(isBuying ? ['ownerCountOfMine', 'recordPreference'] : ['maxOwners', 'recordStatus'])] : [])]);
    for (const key of Array.from(effectiveParams.keys())) if (!allowedParams.has(key)) effectiveParams.delete(key);
    const params = effectiveParams, query = effectiveParams.toString();
    const appliedTags = (() => { try { const value = JSON.parse(params.get('tags') || '[]'); return validTags(value) ? value : []; } catch { return []; } })();
    const [account, setAccount] = useState<Record<string, string>>({}), [wantedSkins, setWantedSkins] = useState<string[]>([]);
    const searchTerm = params.get('q') || '';
    const [queryDraft, setQueryDraft] = useState({ searchTerm, value: searchTerm });
    const q = queryDraft.searchTerm === searchTerm ? queryDraft.value : searchTerm;
    const setQ = (value: string) => setQueryDraft({ searchTerm, value });
    const [min, setMin] = useState(''), [max, setMax] = useState(''), [match, setMatch] = useState('any'), [tags, setTags] = useState<SeasonTag[]>([]), [activeOnly, setActiveOnly] = useState(false);
    const accountKeys = isBuying ? ['nicknameChars', 'nicknameRank', 'ownerCountOfMine', 'recordPreference'] : ['nicknameChars', 'nicknameRank', 'maxOwners', 'recordStatus'];
    const filterChoices = [...(isAccount ? [{ key: 'account', label: '계정 조건' }] : []), ...(hasLadder ? [{ key: 'ladder', label: '래더' }] : []), ...(isAccount ? [{ key: 'skin', label: '스킨' }] : []), ...(!isExchange ? [{ key: 'price', label: isBuying ? '구매 예산' : '가격' }] : []), ...(!isAccount && isExchange ? [{ key: 'status', label: '거래 상태' }] : [])];
    const syncDraft = () => {
        setActiveOnly(params.get('active') === '1');
        setAccount(Object.fromEntries(ACCOUNT_FILTERS.map(key => [key, params.get(key) || ''])));
        setWantedSkins(skinTags(params.get('skinTags') || ''));
        setMin(params.get('min') || ''); setMax(params.get('max') || ''); setMatch(params.get('match') || 'any');
        try { const value = JSON.parse(params.get('tags') || '[]'); setTags(validTags(value) ? value : []); } catch { setTags([]); }
    };
    const requestKey = JSON.stringify([query, revision, refresh, me?.id]);
    const loading = result.key !== requestKey, posts = result.posts, total = result.total, error = result.error;
    useEffect(() => {
        let active = true;
        api('posts?' + query).then(data => { if (active) setResult({ key: requestKey, posts: data.posts, total: data.total, error: '' }); }).catch(e => { if (active) setResult({ key: requestKey, posts: [], total: 0, error: errorMessage(e) }); });
        return () => { active = false; };
    }, [query, requestKey]);

    const update = (values: Record<string, string>) => { const next = new URLSearchParams(effectiveParams); next.delete('page'); Object.entries(values).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key)); go('/?' + next); };
    const switchContext = (nextKind: typeof TRADE_TABS[number], nextCategory?: string, nextWanted?: string) => {
        const allowed = categoriesForKind(nextKind), target = nextCategory && allowed.some(c => c.id === nextCategory) ? nextCategory : allowed[0].id;
        const next = new URLSearchParams({ kind: nextKind, category: target });
        if (nextKind === 'exchange') next.set('wantedCategory', nextWanted || 'account');
        if (params.get('q')) next.set('q', params.get('q')!);
        if (params.get('active')) next.set('active', '1');
        go('/?' + next);
    };
    const clearAll = () => { const next = new URLSearchParams({ kind, category }); if (isExchange) next.set('wantedCategory', wantedCategory); go('/?' + next); };
    const openFilter = (key?: string) => { syncDraft(); setFilters(key || filterChoices[0].key); setFilterOpen(true); };
    const resetDraft = () => { setTags([]); setMatch('any'); setWantedSkins([]); setAccount({}); setMin(''); setMax(''); setActiveOnly(false); };
    const apply = () => {
        const integer = (value: string, lower = 0, upper = 1000000000) => value === '' || /^\d+$/.test(value) && Number(value) >= lower && Number(value) <= upper;
        if (!integer(min) || !integer(max) || min && max && Number(min) > Number(max)) { setFilters('price'); toast.error('금액은 0~10억 원으로, 최대 금액이 최소 금액 이상이 되게 입력해 주세요.'); return; }
        if (!integer(account.nicknameChars || '', 1, 20)) { setFilters('account'); toast.error('닉네임 글자 수는 1~20으로 입력해 주세요.'); return; }
        if (!integer(account.maxOwners || '', 1, 9999) || !integer(account.ownerCountOfMine || '', 1, 9999)) { setFilters('account'); toast.error('대주 수는 1~9999의 정수로 입력해 주세요.'); return; }
        update({ ...Object.fromEntries(ACCOUNT_FILTERS.map(key => [key, isAccount && accountKeys.includes(key) ? account[key] || '' : ''])), min: isExchange ? '' : min, max: isExchange ? '' : max, mode: '', level: '', skins: '', gas: '', minerals: '', firstOwner: '', integrated: '', passwordChange: '', phoneChange: '', match: hasLadder && tags.length ? match : '', tags: hasLadder && tags.length ? JSON.stringify(tags) : '', skinTags: isAccount && wantedSkins.length ? JSON.stringify(wantedSkins) : '', active: activeOnly ? '1' : '' });
        setFilterOpen(false);
    };
    const writeParams = new URLSearchParams({ kind, category }); if (isExchange) writeParams.set('wantedCategory', wantedCategory);
    const writeUrl = '/write?' + writeParams;
    const compose = () => me ? go(writeUrl) : login(writeUrl);
    const chips: { key: string; label: string; remove: () => void }[] = [];
    const addChip = (key: string, label: string) => { if (params.get(key)) chips.push({ key, label, remove: () => update({ [key]: '' }) }); };
    addChip('active', '거래완료 제외'); addChip('q', '검색: ' + params.get('q'));
    addChip('min', Number(params.get('min')).toLocaleString() + '원 이상'); addChip('max', Number(params.get('max')).toLocaleString() + '원 이하');
    TIERS.forEach(t => { const group = appliedTags.filter(value => value.tier === t.id); if (group.length) chips.push({ key: t.id, label: t.name + ' ' + group.map(value => value.season).sort((a, b) => a - b).join(', ') + '시즌', remove: () => { const next = appliedTags.filter(value => value.tier !== t.id); update({ tags: next.length ? JSON.stringify(next) : '', match: next.length ? params.get('match') || 'any' : '' }); } }); });
    skinTags(params.get('skinTags') || '').forEach(value => chips.push({ key: value, label: value, remove: () => { const next = skinTags(params.get('skinTags') || '').filter(item => item !== value); update({ skinTags: next.length ? JSON.stringify(next) : '' }); } }));
    addChip('nicknameChars', (isBuying ? '내 닉 ' : '닉 ') + params.get('nicknameChars') + '글자'); addChip('nicknameRank', '닉 ' + params.get('nicknameRank'));
    addChip('maxOwners', params.get('maxOwners') + '대주 이하'); addChip('ownerCountOfMine', '내 계정 ' + params.get('ownerCountOfMine') + '대주');
    addChip('recordStatus', params.get('recordStatus') || ''); addChip('recordPreference', params.get('recordPreference') || '');
    const filterCount = appliedTags.length + skinTags(params.get('skinTags') || '').length + accountKeys.filter(key => params.get(key)).length + ['min', 'max', 'active'].filter(key => params.get(key)).length;
    const draftCount = tags.length + wantedSkins.length + accountKeys.filter(key => account[key]).length + [min, max].filter(Boolean).length + Number(activeOnly);
    const hasSearchFilters = chips.length > 0;
    async function saveSearch(e: React.FormEvent) {
        e.preventDefault();
        try { await api('searches', 'POST', { name, query: effectiveParams.toString() }); setSave(false); setName(''); toast.success('검색 조건을 저장했습니다.'); } catch (e) { toast.error(errorMessage(e)); }
    }
    function updatePage(nextPage: number) { const next = new URLSearchParams(effectiveParams); next.set('page', String(nextPage)); go('/?' + next); }
    return <>
        <section className="v9-board-heading"><h1>거래</h1><button className="primary v9-desktop-write" onClick={compose}><PenLine size={17} />등록하기</button></section>
        <section className="v7-market" aria-label="거래 목록">
            <Tabs value={kind} onValueChange={value => switchContext(value as typeof TRADE_TABS[number])}><TabsList className="v7-kind-tabs" aria-label="거래 구분">{TRADE_TABS.map(value => <TabsTrigger value={value} key={value}>{KIND_NAMES[value]}</TabsTrigger>)}</TabsList></Tabs>
            {isExchange ? <div className="v9-exchange-category"><label><span>내놓는 대상</span><select aria-label="내놓는 대상" value={category} onChange={e => switchContext(kind, e.target.value, wantedCategory)}>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span className="v9-exchange-word">에서</span><label><span>구하는 대상</span><select aria-label="구하는 대상" value={wantedCategory} onChange={e => switchContext(kind, category, e.target.value)}>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><strong>구함</strong></div> : <div className="v9-category-row" aria-label="거래 품목">{categories.map(item => <button key={item.id} aria-pressed={category === item.id} onClick={() => switchContext(kind, item.id)}>{item.name}</button>)}</div>}
            <div className="v9-search-row"><form className="v7-search" onSubmit={e => { e.preventDefault(); update({ q: q.trim() }); }}><Search size={20} aria-hidden="true" /><input aria-label="거래 검색" placeholder="제목과 내용 검색" value={q} onChange={e => setQ(e.target.value)} />{q && <button type="button" className="v7-search-clear" aria-label="검색어 지우기" onClick={() => { setQ(''); update({ q: '' }); }}><X size={18} /></button>}<button type="submit" className="v7-search-submit">검색</button></form>{(!isExchange || isAccount) && <button className={'v7-filter-button' + (filterCount ? ' has-filters' : '')} onClick={() => openFilter()} aria-haspopup="dialog"><SlidersHorizontal size={18} />조건{filterCount > 0 && <b>{filterCount}</b>}</button>}</div>
            {chips.length > 0 && <div className="v7-applied">{chips.map(chip => <button key={chip.key} className="v7-filter-chip" onClick={chip.remove} aria-label={chip.label + ' 조건 해제'}>{chip.label}<X size={14} /></button>)}<button className="v7-clear" onClick={clearAll}>초기화</button><button className="v7-save" onClick={() => me ? setSave(true) : login(() => setSave(true))}><Bookmark size={16} />조건 저장</button></div>}
            <div className="v7-list-meta"><p aria-live="polite">{loading ? '불러오는 중' : <><b>{total.toLocaleString()}</b>건</>}</p><div className="v9-list-options"><label className="v9-active-only"><Checkbox checked={params.get('active') === '1'} onCheckedChange={checked => update({ active: checked === true ? '1' : '' })} />거래완료 제외</label>{!isExchange && <select aria-label="정렬" value={params.get('sort') || 'latest'} onChange={e => update({ sort: e.target.value })}><option value="latest">최신순</option><option value="price-low">낮은 {isBuying ? '예산' : '가격'}순</option><option value="price-high">높은 {isBuying ? '예산' : '가격'}순</option></select>}</div></div>
            {loading ? <Loading /> : error ? <EmptyState title="목록을 불러오지 못했습니다" description={error}><button className="secondary" onClick={() => setRefresh(value => value + 1)}>다시 시도</button></EmptyState> : posts.length ? <ListingRows posts={posts} onFavorite={() => setRefresh(value => value + 1)} /> : <div className="v7-empty"><Search size={27} aria-hidden="true" /><h2>{hasSearchFilters ? '조건에 맞는 거래가 없습니다' : '아직 등록된 거래가 없습니다'}</h2>{hasSearchFilters && <p>검색어나 조건을 바꿔 보세요.</p>}<div>{hasSearchFilters && <button className="secondary" onClick={clearAll}>조건 초기화</button>}<button className="primary" onClick={compose}>{KIND_NAMES[kind]} 등록하기</button></div></div>}
            {total > 16 && <Pagination className="market-pagination"><PaginationContent><PaginationItem><button className="secondary" disabled={page <= 1} onClick={() => updatePage(page - 1)}>이전</button></PaginationItem>{Array.from({ length: Math.min(5, Math.ceil(total / 16)) }, (_, i) => Math.max(1, Math.min(page - 2, Math.ceil(total / 16) - 4)) + i).map(n => <PaginationItem key={n}><PaginationLink href="#" isActive={n === page} onClick={e => { e.preventDefault(); updatePage(n); }}>{n}</PaginationLink></PaginationItem>)}<PaginationItem><button className="secondary" disabled={page * 16 >= total} onClick={() => updatePage(page + 1)}>다음</button></PaginationItem></PaginationContent></Pagination>}
        </section>
        <button className="v7-mobile-write" onClick={compose}><PenLine size={19} />등록하기</button>
        <Dialog open={filterOpen} onOpenChange={setFilterOpen}><DialogContent className="v7-filter-drawer"><div className="v7-filter-heading"><DialogTitle>{KIND_NAMES[kind]} 조건</DialogTitle><DialogDescription>{isExchange ? categoryName(category) + '에서 ' + categoryName(wantedCategory) + ' 구함' : categoryName(category)}</DialogDescription></div><Tabs value={filterChoices.some(item => item.key === filters) ? filters : filterChoices[0].key} onValueChange={setFilters} className="v7-filter-shell"><TabsList className="v7-filter-tabs">{filterChoices.map(item => <TabsTrigger key={item.key} value={item.key}>{item.label}</TabsTrigger>)}</TabsList><div className="v7-filter-body">
            {isAccount && <><TabsContent value="account"><h3 className="v7-field-title">{isBuying ? '내 계정에 맞는 구매 찾기' : '계정 조건'}</h3><div className="v7-field-grid"><label>{isBuying ? '내 닉네임 글자 수' : '닉네임 글자 수'}<input type="number" min="1" max="20" step="1" placeholder="제한 없음" value={account.nicknameChars || ''} onChange={e => setAccount(value => ({ ...value, nicknameChars: e.target.value }))} /></label><label>{isBuying ? '내 닉 등급' : '닉 등급'}<select value={account.nicknameRank || ''} onChange={e => setAccount(value => ({ ...value, nicknameRank: e.target.value }))}><option value="">전체</option>{NICK_RANKS.map(value => <option key={value}>{value}</option>)}</select></label><label>{isBuying ? '내 계정 대주 수' : '대주 수'}<div className="v7-unit-input"><input type="number" min="1" max="9999" step="1" placeholder="제한 없음" value={account[isBuying ? 'ownerCountOfMine' : 'maxOwners'] || ''} onChange={e => setAccount(value => ({ ...value, [isBuying ? 'ownerCountOfMine' : 'maxOwners']: e.target.value }))} /><span>{isBuying ? '대주' : '대주 이하'}</span></div></label><label>전적 조건<select value={account[isBuying ? 'recordPreference' : 'recordStatus'] || ''} onChange={e => setAccount(value => ({ ...value, [isBuying ? 'recordPreference' : 'recordStatus']: e.target.value }))}><option value="">전체</option>{(isBuying ? ['무전적', '전적 있어도 괜찮음'] : ['무전적', '전적 있음']).map(value => <option key={value}>{value}</option>)}</select></label></div></TabsContent></>}
            {hasLadder && <TabsContent value="ladder"><div className="v7-field-heading"><h3>{isBuying ? '구매자가 찾는 래더' : '래더 기록'}</h3><select aria-label="시즌 일치 방식" value={match} onChange={e => setMatch(e.target.value)}><option value="any">하나 이상 포함</option><option value="all">모두 포함</option></select></div><SeasonPicker value={tags} onChange={setTags} search /></TabsContent>}
            {isAccount && <TabsContent value="skin"><h3 className="v7-field-title">{isBuying ? '구매자가 찾는 스킨' : '보유 스킨'}</h3><p className="v7-field-description">선택한 스킨 중 하나 이상 포함된 거래를 찾습니다.</p><SkinChoices value={wantedSkins} onChange={setWantedSkins} /></TabsContent>}
            {!isExchange && <TabsContent value="price"><h3 className="v7-field-title">{isBuying ? '구매 예산 (MAX)' : kind === 'sell' ? '즉거가' : '가격 범위'}</h3><div className="v7-field-grid"><label>최소 금액<div className="v7-unit-input"><input type="number" min="0" step="1" placeholder="제한 없음" value={min} onChange={e => setMin(e.target.value)} /><span>원</span></div></label><label>최대 금액<div className="v7-unit-input"><input type="number" min="0" step="1" placeholder="제한 없음" value={max} onChange={e => setMax(e.target.value)} /><span>원</span></div></label></div></TabsContent>}
            {!isAccount && isExchange && <TabsContent value="status"><h3 className="v7-field-title">교환 대상</h3><p className="v7-field-description">{categoryName(category)}에서 {categoryName(wantedCategory)} 구함</p></TabsContent>}
        </div></Tabs><div className="v7-filter-bottom"><label className="v7-active-only"><Checkbox checked={activeOnly} onCheckedChange={value => setActiveOnly(value === true)} />거래완료 제외</label><div className="v7-filter-actions"><button className="secondary" onClick={resetDraft}><RotateCcw size={17} />초기화</button><button className="primary" onClick={apply}>{draftCount > 0 ? draftCount + '개 조건 적용' : '적용'}</button></div></div></DialogContent></Dialog>
        <Dialog open={save} onOpenChange={setSave}><DialogContent><DialogTitle>검색 조건 저장</DialogTitle><DialogDescription>내 거래의 저장한 검색에서 다시 볼 수 있습니다.</DialogDescription><form className="form-stack" onSubmit={saveSearch}><label>검색 이름<input required maxLength={32} placeholder="예: 30시즌 마스터 계정" value={name} onChange={e => setName(e.target.value)} /></label><button className="primary">저장</button></form></DialogContent></Dialog>
    </>;
}
