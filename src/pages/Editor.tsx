import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, ImagePlus, LoaderCircle, Lock, X } from 'lucide-react';
import { toast } from 'sonner';
import {
    ACCOUNT_CHOICES, DETAIL_FIELDS, KIND_ICONS, KIND_NAMES, NICK_RANKS, RECORD_PREFERENCES, STATUS_NAMES, TRADE_KINDS,
    categoriesForKind, categoryName, choiceLabel, isTradeKind, manToWon, normalizeTrade, parseList, skinTags, wonToMan,
    type Post, type SeasonTag, type TradeKind,
} from '../../shared/market';
import { api, errorText, imageUrl, uploadPhoto } from '../lib/api';
import { navigate, setLeaveGuard, useLocation } from '../lib/router';
import { useApp } from '../app/state';
import { CIcon, EmptyState, SkeletonRows } from '../components/ui';
import { RankPicker, SeasonPicker, Segmented, SkinPicker } from '../components/Pickers';

type Form = {
    kind: TradeKind; category: string; title: string; body: string;
    price: string; // 만원
    offer: string; // 현젯, 만원
    accepts_offers: boolean; status: string; tags: SeasonTag[]; details: Record<string, string>; images: string[];
    wantedTags: SeasonTag[]; // ladders an exchange post wants in return
};

const blank: Form = { kind: 'sell', category: 'account', title: '', body: '', price: '', offer: '', accepts_offers: true, status: 'open', tags: [], details: {}, images: [], wantedTags: [] };

function normalize(raw: Partial<Form>): Form {
    const t = normalizeTrade(raw.kind || 'sell', raw.category || 'account');
    const cats = categoriesForKind(t.kind);
    const form: Form = { ...blank, ...raw, kind: t.kind, category: cats.some(c => c.id === t.category) ? t.category : cats[0].id, details: { ...(raw.details || {}) }, tags: raw.tags || [], images: raw.images || [], wantedTags: raw.wantedTags || [] };
    if (form.kind === 'exchange') { form.price = ''; form.details.wantedCategory = form.details.wantedCategory === 'clan' ? 'clan' : 'account'; }
    return form;
}

function fromPost(p: Post): Form {
    const { currentOffer, ...details } = p.details;
    return normalize({ kind: p.kind, category: p.category, title: p.title, body: p.body, price: wonToMan(p.price), offer: currentOffer ? wonToMan(Number(currentOffer)) : '', accepts_offers: !!p.accepts_offers, status: p.status, tags: p.tags, details, images: p.images, wantedTags: p.wanted_tags || [] });
}

function template(kind: TradeKind, category: string) {
    if (kind === 'exchange') return '내놓는 것:\n원하는 것:\n추금: 받음 / 드림 / 없음\n';
    if (kind === 'proxy_request') return '종목:\n현재 -> 목표:\n가능 시간:\n';
    if (kind === 'proxy_offer') return '가능 종목:\n가격: (예: 천점당 0.7)\n경력: (예: 30 챌린저, 31 마스터)\n조건: (예: 선입금, 동접 시 중단)\n';
    if (kind === 'buy') return '필수:\n우대:\n거래 방법:\n';
    if (category === 'account') return '스킨/악세:\n라이드/펫:\n엠블럼:\n거래 방법: (쿨거, 전비변 바로 등)\n';
    return '내용:\n거래 방법:\n';
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
    return <section className="ed-section"><div className="ed-head"><h2>{title}</h2>{desc && <p>{desc}</p>}</div>{children}</section>;
}

// Whole-number fields drop anything after a decimal point instead of joining the digits (2.5 → 2, not 25).
const wholeNumber = (v: string) => v.split('.')[0].replace(/\D/g, '');

function Num({ label, value, onChange, unit, max = 1000000000, placeholder = '', decimal = false }: { label: string; value: string; onChange: (v: string) => void; unit?: string; max?: number; placeholder?: string; decimal?: boolean }) {
    return <label className="field"><span className="field-label">{label}</span>
        <div className={unit ? 'input-unit' : undefined}>
            <input className="input" type="number" inputMode={decimal ? 'decimal' : 'numeric'} min="0" max={max} step={decimal ? 'any' : '1'} placeholder={placeholder} value={value}
                onChange={e => onChange(decimal ? e.target.value : wholeNumber(e.target.value))} />
            {unit && <span>{unit}</span>}
        </div>
        {decimal && value && !Number.isNaN(manToWon(value)) && manToWon(value) !== null && <span className="field-hint">{manToWon(value)!.toLocaleString('ko-KR')}원</span>}
    </label>;
}

export default function Editor({ id }: { id?: string }) {
    const { me, ready, requireLogin, openApply, refreshMe } = useApp();
    const { params } = useLocation();
    const proxyAllowed = me?.role === 'manager' || !!me?.badges.includes('proxy');
    // A link to a 대리(진행) form without 대리 인증 opens 대리(구함) instead and offers the application.
    const proxyBlocked = !id && params.get('kind') === 'proxy_offer' && !!me && !proxyAllowed;
    const initial = normalize({
        kind: proxyBlocked ? 'proxy_request' : isTradeKind(params.get('kind')) ? params.get('kind') as TradeKind : 'sell',
        category: params.get('category') || undefined,
        details: params.get('kind') === 'exchange' ? { wantedCategory: params.get('wantedCategory') === 'clan' ? 'clan' : 'account' } : {},
    });
    const [form, setForm] = useState<Form>(initial);
    const [loaded, setLoaded] = useState(false), [loadError, setLoadError] = useState('');
    const [restore, setRestore] = useState<(Form & { savedAt: number }) | null>(null);
    const [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [error, setError] = useState(''), [savedAt, setSavedAt] = useState('');
    const formRef = useRef(form), dirty = useRef(false), done = useRef(false), lastSaved = useRef(''), fileInput = useRef<HTMLInputElement>(null);
    formRef.current = form;
    const draftKey = id || 'new';

    useEffect(() => { if (ready && !me) requireLogin(); }, [ready, me, requireLogin]);
    useEffect(() => {
        void refreshMe().catch(() => {});
        if (proxyBlocked) { openApply({ kind: 'badge', target: 'proxy' }); toast('대리(진행)는 대리 인증이 필요합니다. 대리(구함)으로 열었습니다.'); }
    }, []);
    useEffect(() => {
        if (!me) return;
        let alive = true;
        Promise.all([id ? api<{ post: Post }>('posts/' + id) : Promise.resolve(null), api<{ draft: any }>('drafts/' + draftKey)])
            .then(([p, d]) => {
                if (!alive) return;
                if (p) {
                    if (p.post.author_id !== me.id) throw new Error('본인 글만 수정할 수 있습니다.');
                    setForm(fromPost(p.post));
                }
                if (d.draft && typeof d.draft.kind === 'string' && 'offer' in d.draft) setRestore(d.draft);
                setLoaded(true);
            }).catch(e => { if (alive) setLoadError(errorText(e)); });
        return () => { alive = false; };
    }, [id, me?.id]);

    const persist = async (manual = false) => {
        if (!loaded || done.current || (!dirty.current && !manual)) return true;
        const snapshot = JSON.stringify(formRef.current);
        if (snapshot === lastSaved.current && !manual) return true;
        try {
            await api('drafts/' + draftKey, 'PUT', JSON.parse(snapshot));
            lastSaved.current = snapshot;
            setSavedAt(new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' }));
            if (manual) toast('임시저장 완료');
            return true;
        } catch (e) { if (manual) toast.error(errorText(e)); return false; }
    };
    // Auto-save shortly after edits, and before leaving the page.
    useEffect(() => { if (!loaded || !dirty.current || restore) return; const t = setTimeout(() => void persist(), 1500); return () => clearTimeout(t); }, [form, loaded, restore]);
    useEffect(() => {
        if (!loaded) return;
        setLeaveGuard(async () => { await persist(); return true; });
        const unsaved = () => dirty.current && !done.current && JSON.stringify(formRef.current) !== lastSaved.current;
        const warn = (e: BeforeUnloadEvent) => { if (unsaved()) e.preventDefault(); };
        window.addEventListener('beforeunload', warn);
        return () => {
            setLeaveGuard(null);
            window.removeEventListener('beforeunload', warn);
            // Leaving with the browser's Back button skips the guard, so the last edits are sent on the way out.
            if (unsaved()) void fetch('/api/drafts/' + draftKey, { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formRef.current) }).catch(() => {});
        };
    }, [loaded]);

    const patch = (v: Partial<Form>) => { dirty.current = true; setForm(f => ({ ...f, ...v })); };
    const setDetail = (key: string, value: string) => patch({ details: { ...formRef.current.details, [key]: value } });

    function changeKind(kind: TradeKind) {
        if (kind === form.kind) return;
        if (kind === 'proxy_offer' && !proxyAllowed) { openApply({ kind: 'badge', target: 'proxy' }); return; }
        const cats = categoriesForKind(kind);
        const category = cats.some(c => c.id === form.category) ? form.category : cats[0].id;
        patch({ kind, category, price: '', offer: '', tags: [], wantedTags: [], details: kind === 'exchange' ? { wantedCategory: 'account' } : {} });
    }
    function changeCategory(category: string) {
        if (category === form.category) return;
        const keep = form.kind === 'exchange' ? Object.fromEntries(Object.entries(form.details).filter(([k]) => k.startsWith('wanted'))) : {};
        patch({ category, tags: [], details: keep });
    }

    async function addPhotos(files: FileList | null) {
        if (!files?.length) return;
        const list = Array.from(files).slice(0, 6 - form.images.length);
        if (files.length > list.length) toast.error('사진은 최대 6장입니다.');
        setUploading(true);
        const added: string[] = [];
        try { for (const f of list) added.push(await uploadPhoto(f)); }
        catch (e) { toast.error(errorText(e)); }
        finally {
            if (added.length) patch({ images: [...formRef.current.images, ...added] });
            setUploading(false);
            if (fileInput.current) fileInput.current.value = '';
        }
    }
    const moveImage = (i: number, d: number) => { const a = [...form.images]; [a[i], a[i + d]] = [a[i + d], a[i]]; patch({ images: a }); };

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (busy || uploading) return;
        setError('');
        const price = form.kind === 'exchange' ? null : manToWon(form.price);
        const offer = form.kind === 'sell' ? manToWon(form.offer) : null;
        if (Number.isNaN(price) || Number.isNaN(offer)) { setError('가격은 만원 단위 숫자로 입력하세요. 예: 35, 1.5'); return; }
        if (form.kind === 'proxy_offer' && !proxyAllowed) { openApply({ kind: 'badge', target: 'proxy' }); return; }
        setBusy(true);
        try {
            const details = { ...form.details, ...(offer !== null ? { currentOffer: String(offer) } : {}) };
            const payload = { kind: form.kind, category: form.category, title: form.title, body: form.body, price, accepts_offers: form.kind === 'sell' && (price === null || form.accepts_offers), status: form.status, tags: form.tags, wantedTags: form.kind === 'exchange' ? form.wantedTags : [], details, images: form.images };
            done.current = true;
            const d = await api<{ id: number }>(id ? 'posts/' + id : 'posts', id ? 'PUT' : 'POST', payload);
            api('drafts/' + draftKey, 'DELETE').catch(() => {});
            setLeaveGuard(null);
            toast(id ? '수정 완료' : '등록 완료');
            void navigate('/posts/' + d.id, { replace: !!id, force: true });
        } catch (err) { done.current = false; setError(errorText(err)); }
        finally { setBusy(false); }
    }

    if (!me) return <div className="container page"><EmptyState icon="locked" title="로그인이 필요합니다" action={<button className="btn btn-primary" onClick={() => requireLogin()}>로그인</button>} /></div>;
    if (loadError) return <div className="container page"><EmptyState icon="warning" title="글을 불러오지 못했습니다" text={loadError} /></div>;
    if (!loaded) return <div className="container page"><SkeletonRows count={3} height={180} /></div>;

    const { kind, category, details: d } = form;
    const account = category === 'account', buying = kind === 'buy', wanted = d.wantedCategory === 'clan' ? 'clan' : 'account';
    const ranksOf = (key: string) => parseList(d[key], NICK_RANKS);

    const sellerAccount = <div className="grid-gap-16">
        <div className="field"><span className="field-label">래더 기록</span><SeasonPicker value={form.tags} onChange={tags => patch({ tags })} /></div>
        <div className="ed-grid">
            <Num label="대주 수" value={d.ownerCount || ''} onChange={v => setDetail('ownerCount', v)} unit="대주" max={9999} placeholder="예: 2" />
            <div className="field"><span className="field-label">전적</span><Segmented name="전적" options={['무전적', '전적 있음'] as const} value={d.recordStatus || ''} onChange={v => setDetail('recordStatus', v)} /></div>
            <Num label="닉네임 글자 수" value={d.nicknameChars || ''} onChange={v => setDetail('nicknameChars', v)} unit="글자" max={20} placeholder="예: 2" />
            <div className="field"><span className="field-label">닉 등급</span><RankPicker value={d.nicknameRank ? [d.nicknameRank] : []} onChange={v => setDetail('nicknameRank', v[0] || '')} /></div>
        </div>
        <div className="field"><span className="field-label">보유 우대 스킨</span><SkinPicker value={skinTags(d.skinTags)} onChange={v => setDetail('skinTags', v.length ? JSON.stringify(v) : '')} /><span className="field-hint">없는 스킨은 내용에 적어 주세요.</span></div>
        <div className="ed-grid ed-grid-3">
            <Num label="팬텀" value={d.phantom || ''} onChange={v => setDetail('phantom', v)} unit="%" max={5000} placeholder="예: 225" />
            <Num label="가스" value={d.gas || ''} onChange={v => setDetail('gas', v)} placeholder="예: 246" />
            <Num label="미네랄" value={d.minerals || ''} onChange={v => setDetail('minerals', v)} placeholder="예: 1400000" />
        </div>
        <details className="ed-more" open={['integrated', 'passwordChange', 'phoneChange', 'backupEmail', 'level', 'labLevel', 'humanSkins', 'zombieSkins', 'closet'].some(k => d[k])}>
            <summary>추가 정보 <span>통합, 전비변, 보멜, 레벨, 연구실, 옷장</span></summary>
            <div className="ed-grid mt-16">
                {(['integrated', 'passwordChange', 'phoneChange', 'backupEmail'] as const).map(k => <div className="field" key={k}><span className="field-label">{ACCOUNT_CHOICES[k].label}</span><Segmented name={ACCOUNT_CHOICES[k].label} options={ACCOUNT_CHOICES[k].options} label={v => choiceLabel(k, v)} value={d[k] || ''} onChange={v => setDetail(k, v)} /></div>)}
                <Num label="계정 레벨" value={d.level || ''} onChange={v => setDetail('level', v)} max={999} />
                <Num label="연구실 레벨" value={d.labLevel || ''} onChange={v => setDetail('labLevel', v)} max={99} />
                <Num label="인간 스킨 수" value={d.humanSkins || ''} onChange={v => setDetail('humanSkins', v)} unit="개" />
                <Num label="좀비 스킨 수" value={d.zombieSkins || ''} onChange={v => setDetail('zombieSkins', v)} unit="개" />
                <Num label="옷장" value={d.closet || ''} onChange={v => setDetail('closet', v)} unit="칸" max={999} />
            </div>
        </details>
    </div>;

    const buyerAccount = (prefix: '' | 'wanted') => {
        const k = (name: string) => prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name;
        return <div className="grid-gap-16">
            <div className="ed-grid">
                <Num label="대주 수" value={d[k('maxOwners')] || ''} onChange={v => setDetail(k('maxOwners'), v)} unit="대주 이하" max={9999} placeholder="상관없음" />
                <div className="field"><span className="field-label">전적</span><Segmented name={prefix + '전적'} options={RECORD_PREFERENCES} value={d[k('recordPreference')] || ''} onChange={v => setDetail(k('recordPreference'), v)} /></div>
            </div>
            <div className="field"><span className="field-label">원하는 닉네임</span>
                <div className="range nick-range">
                    <div className="input-unit"><input className="input" type="number" inputMode="numeric" min="1" max="20" placeholder="최소" aria-label="닉네임 최소 글자 수" value={d[k('nicknameCharsMin')] || ''} onChange={e => setDetail(k('nicknameCharsMin'), wholeNumber(e.target.value))} /><span>글자</span></div>
                    <span>~</span>
                    <div className="input-unit"><input className="input" type="number" inputMode="numeric" min="1" max="20" placeholder="최대" aria-label="닉네임 최대 글자 수" value={d[k('nicknameCharsMax')] || ''} onChange={e => setDetail(k('nicknameCharsMax'), wholeNumber(e.target.value))} /><span>글자</span></div>
                </div>
                <RankPicker multiple value={ranksOf(k('nicknameRanks'))} onChange={v => setDetail(k('nicknameRanks'), v.length ? JSON.stringify(v) : '')} />
                <span className="field-hint">등급 중복 선택 가능</span>
            </div>
            <div className="field"><span className="field-label">원하는 래더</span>
                {prefix ? <SeasonPicker value={form.wantedTags} onChange={wantedTags => patch({ wantedTags })} /> : <SeasonPicker value={form.tags} onChange={tags => patch({ tags })} />}
            </div>
            <div className="field"><span className="field-label">우대 스킨</span><SkinPicker value={skinTags(d[k('skinTags')])} onChange={v => setDetail(k('skinTags'), v.length ? JSON.stringify(v) : '')} /></div>
        </div>;
    };

    const generic = (cat: string) => <div className="grid-gap-16">
        {cat === 'ladder' && <div className="field"><span className="field-label">래더 시즌</span><SeasonPicker value={form.tags} onChange={tags => patch({ tags })} /></div>}
        <div className="ed-grid">{(DETAIL_FIELDS[cat] || []).filter(f => !(kind === 'proxy_offer' && f.id === 'current')).map(f => f.type === 'number'
            ? <Num key={f.id} label={(buying ? '희망 ' : '') + f.label} value={d[f.id] || ''} onChange={v => setDetail(f.id, v)} />
            : <label className="field" key={f.id}><span className="field-label">{(buying && cat !== 'ladder' && cat !== 'story' && cat !== 'event' ? '희망 ' : '') + f.label}</span><input className="input" type={f.type === 'date' ? 'date' : 'text'} maxLength={500} placeholder={f.placeholder || ''} value={d[f.id] || ''} onChange={e => setDetail(f.id, e.target.value)} /></label>)}</div>
    </div>;

    const infoTitle = account ? (buying ? '원하는 계정' : '계정 정보') : kind === 'proxy_request' ? '요청 내용' : kind === 'proxy_offer' ? '진행 내용' : `${categoryName(category)} 정보`;
    const hasInfo = account || (DETAIL_FIELDS[category]?.length || 0) > 0;

    return <div className="container page editor">
        <div className="ed-top">
            <h1 className="page-title">{id ? '글 수정' : '글쓰기'}</h1>
            <span className="muted small">{savedAt ? `${savedAt} 자동 저장됨` : ''}</span>
        </div>
        {restore && <div className="restore">
            <span className="grow">임시저장된 글이 있습니다. <span className="muted small">{new Date(restore.savedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</span></span>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => { const { savedAt: _s, ...rest } = restore; void _s; setForm(normalize(rest)); dirty.current = true; setRestore(null); }}>이어서 쓰기</button>
            <button type="button" className="btn btn-line btn-sm" onClick={() => { setRestore(null); api('drafts/' + draftKey, 'DELETE').catch(() => {}); }}>새로 쓰기</button>
        </div>}
        <form className="ed-form" onSubmit={submit}>
            <fieldset disabled={!!restore || busy}>
                <Section title="게시판">
                    <div className="kind-cards" role="radiogroup" aria-label="거래 구분">
                        {TRADE_KINDS.map(k => {
                            const locked = k === 'proxy_offer' && !proxyAllowed;
                            return <label key={k} className={'kind-card' + (locked ? ' is-locked' : '')}>
                                <input type="radio" name="kind" checked={kind === k} onChange={() => changeKind(k)} onClick={() => { if (locked) changeKind(k); }} />
                                <CIcon name={KIND_ICONS[k]} size={36} /><span>{KIND_NAMES[k]}</span>
                                {locked && <small><Lock size={11} />대리 인증 필요</small>}
                            </label>;
                        })}
                    </div>
                    {kind === 'exchange' ? <div className="exchange-pick mt-16">
                        <select className="select" aria-label="내놓는 대상" value={category} onChange={e => changeCategory(e.target.value)}>{categoriesForKind(kind).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                        <span>에서</span>
                        <select className="select" aria-label="구하는 대상" value={wanted} onChange={e => patch({ details: { ...Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('wanted'))), wantedCategory: e.target.value } })}>{categoriesForKind(kind).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                        <span>구함</span>
                    </div> : <div className="chip-row mt-16" role="radiogroup" aria-label="세부 분류">
                        {categoriesForKind(kind).map(c => <button type="button" key={c.id} role="radio" aria-checked={category === c.id} className="chip" aria-pressed={category === c.id} onClick={() => changeCategory(c.id)}>{c.name}</button>)}
                    </div>}
                </Section>

                {kind !== 'exchange' && <Section title="가격" desc="단위: 만원 (1.5 = 15,000원)">
                    {kind === 'sell' ? <div className="grid-gap-16">
                        <div className="ed-grid">
                            <Num decimal label="즉거가" value={form.price} onChange={v => patch({ price: v })} unit="만원" placeholder="미정" />
                            <Num decimal label="현젯 (현재 제시가)" value={form.offer} onChange={v => patch({ offer: v })} unit="만원" placeholder="없음" />
                        </div>
                        {id && <p className="field-hint">이전 즉거가는 취소선으로 남습니다.</p>}
                        <label className="switch"><input type="checkbox" checked={form.price === '' || form.accepts_offers} disabled={form.price === ''} onChange={e => patch({ accepts_offers: e.target.checked })} />제시 받기</label>
                    </div> : <div className="ed-grid">
                        <Num decimal label={buying ? '최대 사용 가능 금액 (MAX)' : kind === 'proxy_request' ? '희망 가격' : '가격'} value={form.price} onChange={v => patch({ price: v })} unit="만원" placeholder="협의" />
                    </div>}
                </Section>}

                {kind === 'exchange' ? <>
                    <Section title={`내가 내놓는 ${categoryName(category)}`}>{account ? sellerAccount : generic('clan')}</Section>
                    <Section title={`내가 구하는 ${categoryName(wanted)}`}>
                        {wanted === 'account' ? buyerAccount('wanted') : <p className="muted">원하는 클랜은 내용에 적어 주세요.</p>}
                    </Section>
                </> : hasInfo && <Section title={infoTitle}>
                    {account ? (buying ? buyerAccount('') : sellerAccount) : generic(category)}
                </Section>}

                <Section title="내용">
                    <div className="grid-gap-16">
                        <label className="field"><span className="field-label">제목 <em>*</em></span>
                            <input className="input" required minLength={2} maxLength={100} value={form.title} onChange={e => patch({ title: e.target.value })} placeholder="예: 28 챌린저 2대주 계정 팝니다" /></label>
                        <div className="field">
                            <div className="row"><label className="field-label grow" htmlFor="body">내용 <em>*</em></label>
                                <button type="button" className="btn btn-text small" disabled={!!form.body.trim()} onClick={() => patch({ body: template(kind, category) })}>양식 불러오기</button></div>
                            <textarea id="body" className="textarea" required maxLength={10000} value={form.body} onChange={e => patch({ body: e.target.value })}
                                placeholder={kind === 'buy' ? '필수, 우대 조건 등' : kind === 'exchange' ? '원하는 조건, 추금 등' : kind.startsWith('proxy') ? '가격, 경력, 진행 조건 등' : '스킨, 악세, 라이드, 거래 방법 등'} />
                            <span className="field-hint">비번, 인증번호는 쓰지 마세요. · {form.body.length.toLocaleString()} / 10,000</span>
                        </div>
                    </div>
                </Section>

                <Section title="사진" desc="첫 장이 대표 사진">
                    <input ref={fileInput} type="file" hidden multiple accept="image/jpeg,image/png,image/webp" onChange={e => addPhotos(e.target.files)} />
                    <div className="photo-grid">
                        {form.images.map((img, i) => <div className="photo" key={img}>
                            <img src={imageUrl(img)} alt={`사진 ${i + 1}`} />
                            {i === 0 && <b className="photo-main">대표</b>}
                            <button type="button" className="photo-remove" aria-label={`사진 ${i + 1} 빼기`} onClick={() => patch({ images: form.images.filter(v => v !== img) })}><X size={14} /></button>
                            <div className="photo-move">
                                <button type="button" disabled={i === 0} aria-label="앞으로" onClick={() => moveImage(i, -1)}><ChevronLeft size={14} /></button>
                                <button type="button" disabled={i === form.images.length - 1} aria-label="뒤로" onClick={() => moveImage(i, 1)}><ChevronRight size={14} /></button>
                            </div>
                        </div>)}
                        {form.images.length < 6 && <button type="button" className="photo-add" disabled={uploading} onClick={() => fileInput.current?.click()}>
                            {uploading ? <LoaderCircle size={24} className="spin" /> : <ImagePlus size={26} />}<span>{uploading ? '올리는 중' : `${form.images.length}/6`}</span>
                        </button>}
                    </div>
                </Section>

                {id && <Section title="거래 상태">
                    <div className="chip-row">{Object.entries(STATUS_NAMES).map(([k, v]) => <button type="button" key={k} className="chip" aria-pressed={form.status === k} onClick={() => patch({ status: k })}>{v}</button>)}</div>
                </Section>}

                {error && <p className="alert alert-danger" role="alert">{error}</p>}
                <div className="ed-bar">
                    <button type="button" className="btn btn-line" onClick={() => void persist(true)}>임시저장</button>
                    <button type="submit" className="btn btn-primary grow" disabled={busy || uploading}>{busy ? <LoaderCircle size={18} className="spin" /> : id ? '수정 완료' : '등록'}</button>
                </div>
            </fieldset>
        </form>
    </div>;
}
