'use client';
import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, ImagePlus, X, ChevronLeft, ChevronRight, Save, Check, Eye, LoaderCircle } from 'lucide-react';
import { AccountFields, AccountDetails } from './account-fields';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { CATEGORIES, KIND_NAMES, DETAIL_FIELDS, STATUS_NAMES, categoriesForKind, isProxyKind, normalizeTrade, listingPrice, type SeasonTag } from '@/lib/market';
import { api, errorMessage, useMarket, LoginGate, Loading, SeasonPicker, TagBadges } from './shared';
type Draft = {
    kind: string;
    category: string;
    title: string;
    body: string;
    price: string;
    price_mode: string;
    accepts_offers: boolean;
    status: string;
    tags: SeasonTag[];
    details: Record<string, string>;
    images: string[];
};
const initial: Draft = { kind: 'sell', category: 'account', title: '', body: '', price: '', price_mode: 'fixed', accepts_offers: false, status: 'open', tags: [], details: {}, images: [] };
function normalizeDraft(raw: Partial<Draft>): Draft {
    const trade = normalizeTrade(raw.kind || 'sell', raw.category || 'account');
    const validCategories = categoriesForKind(trade.kind);
    const draft = { ...initial, ...raw, ...trade, category: validCategories.some(c => c.id === trade.category) ? trade.category : validCategories[0].id, details: { ...(raw.details || {}) } };
    if (draft.kind === 'exchange') {
        draft.price = '';
        draft.details.wantedCategory = draft.details.wantedCategory === 'clan' ? 'clan' : 'account';
    }
    return draft;
}
function descriptionTemplate(kind: string, category: string) {
    if (kind === 'exchange') return '[내놓는 대상]\n\n[구하는 대상과 조건]\n\n[교환 방법]\n';
    if (kind === 'proxy_request') return '[진행을 원하는 내용]\n\n[현재 상태와 목표]\n\n[희망 일정]\n';
    if (kind === 'proxy_offer') return '[진행 가능한 내용]\n\n[작업 범위와 소요 시간]\n\n[진행 조건]\n';
    if (kind === 'buy') return '[원하는 조건]\n\n[우대 사항]\n\n[거래 가능한 시간]\n';
    if (category === 'clan') return '[클랜 소개]\n\n[이전 범위와 조건]\n\n[거래 방법]\n';
    if (category === 'goods_coupon') return '[상품 설명과 구성]\n\n[상태 또는 사용 조건]\n\n[전달 방법]\n';
    return '[상세 설명]\n\n[거래 조건]\n\n[거래 가능한 시간]\n';
}
export function Editor({ id }: {
    id?: string;
}) {
    const params = useSearchParams();
    const from = params.get('from');
    const returnPath = from && /^\/(?:\?.*|(?:profile|activity)\/[A-Za-z0-9_-]+(?:\?.*)?)?$/.test(from) ? from : null;
    const defaults = normalizeDraft({ category: params.get('category') || 'account', kind: params.get('kind') || 'sell', details: params.get('kind') === 'exchange' ? { wantedCategory: params.get('wantedCategory') === 'clan' ? 'clan' : 'account' } : {} });
    const { me, go, refresh, setBeforeLeave } = useMarket(), [form, setForm] = useState<Draft>(defaults), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [saved, setSaved] = useState(''), [restorable, setRestorable] = useState<any>(null), [preview, setPreview] = useState(false);
    const file = useRef<HTMLInputElement>(null), dirty = useRef(false), saving = useRef<Promise<boolean> | null>(null), submitted = useRef(false), lastSaved = useRef(''), formRef = useRef(form);
    formRef.current = form;
    const patch = (v: Partial<Draft>) => { dirty.current = true; setForm(f => ({ ...f, ...v })); };
    useEffect(() => { if (!me)
        return; let active = true; Promise.all([id ? api('posts/' + id) : Promise.resolve(null), api('drafts/' + (id || 'new'))]).then(([p, d]) => { if (!active)
        return; if (p) {
        if (p.post.author_id !== me.id)
            throw new Error('본인 게시글만 수정할 수 있습니다.');
        setForm(normalizeDraft({ ...p.post, price: p.post.price === null ? '' : String(p.post.price), accepts_offers: !!p.post.accepts_offers }));
    } setRestorable(d.draft); setLoaded(true); }).catch(e => setError(errorMessage(e))); return () => { active = false; }; }, [id, me?.id]);
    const persist = async (manual = false): Promise<boolean> => { if (!me || !loaded || submitted.current || !dirty.current && !manual)
        return true; if (saving.current) {
        const result = await saving.current;
        if (!result)
            return false;
        if (JSON.stringify(formRef.current) === lastSaved.current)
            return true;
        return persist(manual);
    } const snapshot = JSON.stringify(formRef.current); if (snapshot === lastSaved.current)
        return true; const pending = (async () => { try {
        await api('drafts/' + (id || 'new'), 'PUT', JSON.parse(snapshot));
        lastSaved.current = snapshot;
        setSaved(new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
        if (manual)
            toast.success('임시저장했습니다.');
        return true;
    }
    catch (e) {
        setSaved('저장 실패');
        toast.error('임시저장에 실패했습니다. 내용을 유지한 채 다시 시도해 주세요.');
        return false;
    } })(); saving.current = pending; const result = await pending; saving.current = null; if (result && JSON.stringify(formRef.current) !== snapshot)
        return persist(false); return result; };
    useEffect(() => { if (!loaded)
        return; setBeforeLeave(() => persist()); return () => { setBeforeLeave(null); if (dirty.current && !submitted.current && JSON.stringify(formRef.current) !== lastSaved.current) {
        void fetch('/api/drafts/' + (id || 'new'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formRef.current), credentials: 'same-origin', keepalive: true });
    } }; }, [loaded, me?.id, id, setBeforeLeave]);
    useEffect(() => { if (!loaded || !dirty.current || restorable)
        return; const t = setTimeout(() => persist(), 1400); return () => clearTimeout(t); }, [form, loaded, restorable]);
    useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (dirty.current && JSON.stringify(formRef.current) !== lastSaved.current && !submitted.current) {
        e.preventDefault();
    } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, []);
    async function upload(files: FileList | null) { if (!files)
        return; const selected = Array.from(files); if (form.images.length + selected.length > 6) {
        toast.error('사진은 최대 6장까지 첨부할 수 있습니다.');
        return;
    } setUploading(true); const added: string[] = []; try {
        for (const source of selected) {
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(source.type) || source.size > 5 * 1024 * 1024)
                throw new Error('5MB 이하의 JPG, PNG, WebP 사진을 선택해 주세요.');
            const bitmap = await createImageBitmap(source);
            const ratio = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height)), canvas = document.createElement('canvas');
            canvas.width = Math.round(bitmap.width * ratio);
            canvas.height = Math.round(bitmap.height * ratio);
            canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            bitmap.close();
            const compressed = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('사진을 처리하지 못했습니다.')), 'image/webp', .88));
            const r = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'image/webp' }, body: compressed });
            const d: any = await r.json();
            if (!r.ok)
                throw new Error(d.error);
            added.push(d.id);
        }
    }
    catch (e) {
        toast.error(errorMessage(e));
    }
    finally {
        if (added.length)
            patch({ images: [...formRef.current.images, ...added] });
        setUploading(false);
        if (file.current)
            file.current.value = '';
    } }
    async function submit(e: React.FormEvent) { e.preventDefault(); if (busy || uploading)
        return; setBusy(true); setError(''); try {
        if (!await persist())
            return;
        submitted.current = true;
        const d = await api('posts' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', { ...form, price: form.kind === 'exchange' || form.price === '' ? null : Number(form.price), price_mode: form.kind === 'exchange' ? 'negotiate' : form.price !== '' ? 'fixed' : form.kind === 'sell' ? 'offer' : 'negotiate', accepts_offers: form.kind === 'sell' && (form.price === '' || form.accepts_offers) });
        try {
            await api('drafts/' + (id || 'new'), 'DELETE');
        }
        catch { }
        refresh();
        toast.success(id ? '게시글을 수정했습니다.' : '거래 글을 등록했습니다.');
        go('/posts/' + d.id + (returnPath ? '?from=' + encodeURIComponent(returnPath) : ''));
    }
    catch (e) {
        submitted.current = false;
        setError(errorMessage(e));
    }
    finally {
        setBusy(false);
    } }
    const changeKind = (kind: string) => {
        if (kind === form.kind) return;
        const category = categoriesForKind(kind).some(c => c.id === form.category) ? form.category : categoriesForKind(kind)[0].id;
        patch({ kind, category, price: '', price_mode: kind === 'sell' ? 'offer' : 'negotiate', accepts_offers: false, tags: [], details: kind === 'exchange' ? { wantedCategory: 'account' } : {} });
    };
    const changeCategory = (category: string) => {
        if (category === form.category) return;
        const details: Record<string, string> = {};
        if (form.kind === 'sell' && form.details.currentOffer) details.currentOffer = form.details.currentOffer;
        if (form.kind === 'exchange') for (const [key, value] of Object.entries(form.details)) if (key.startsWith('wanted')) details[key] = value;
        patch({ category, tags: [], details });
    };
    const detailPatch = (key: string, value: string) => patch({ details: { ...form.details, [key]: value } });
    const moneyField = (label: string, value: string, onChange: (value: string) => void, placeholder: string) => <label className="field-label">{label}<div className="money-input"><input type="number" inputMode="numeric" min="0" max="1000000000" step="1" placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}/><span>원</span></div>{value !== '' && <span className="price-readable">{Number(value).toLocaleString('ko-KR')}원</span>}</label>;
    const genericFields = (category: string) => <div className="detail-fields">{DETAIL_FIELDS[category]?.filter(f => !(form.kind === 'proxy_offer' && f.id === 'current')).map(f => <label className="field-label" key={f.id}>{form.kind === 'buy' && ['clanName', 'clanLevel', 'clanMembers', 'clanCapacity', 'goodsName', 'condition', 'couponName', 'quantity'].includes(f.id) ? '희망 ' : ''}{f.label}<input type={f.type || 'text'} min={f.type === 'number' ? 0 : undefined} max={f.type === 'number' ? 1000000000 : undefined} step={f.type === 'number' ? '1' : undefined} maxLength={500} placeholder={f.placeholder || '선택 입력'} value={form.details[f.id] || ''} onChange={e => detailPatch(f.id, e.target.value)}/></label>)}</div>;
    const categoryName = (category: string) => CATEGORIES.find(c => c.id === category)?.name || category;
    const wantedCategory = form.details.wantedCategory === 'clan' ? 'clan' : 'account';
    const exchangeText = `${categoryName(form.category)}에서 ${categoryName(wantedCategory)} 구함`;
    const hasAccount = form.category === 'account';
    const proxy = isProxyKind(form.kind);
    const showDetails = hasAccount || form.kind === 'exchange' || (DETAIL_FIELDS[form.category]?.length || 0) > 0;
    if (!me) return <LoginGate />;
    if (error && !loaded) return <div className="error-banner">{error}</div>;
    if (!loaded) return <Loading />;
    return <div className="editor-v9">
        <button className="back-link" onClick={() => go(id ? '/posts/' + id : returnPath || '/')}><ArrowLeft size={16}/>돌아가기</button>
        <div className="page-title"><div><h2>{id ? '거래 수정' : '거래 등록'}</h2></div><span className="draft-state"><Check size={13}/>{restorable ? '임시저장 있음' : saved ? saved === '저장 실패' ? saved : saved + ' 저장됨' : '자동 저장'}</span></div>
        {restorable && <div className="restore-draft"><div><Save size={18}/><span>작성하던 내용이 있습니다.<small>{new Date(restorable.savedAt).toLocaleString('ko-KR')}</small></span></div><button onClick={() => { const { savedAt, ...d } = restorable; setForm(normalizeDraft(d)); dirty.current = true; setRestorable(null); toast.success('작성하던 내용을 불러왔습니다.'); }}>불러오기</button><button className="subtle" onClick={() => { setRestorable(null); api('drafts/' + (id || 'new'), 'DELETE').catch(e => toast.error(errorMessage(e))); }}>새로 작성</button></div>}
        <form onSubmit={submit} className="trade-editor"><fieldset className="editor-fields" disabled={!!restorable || busy}>
            <section className="editor-section">
                <h3 className="editor-section-title">거래 구분</h3>
                <RadioGroup aria-label="거래 구분" className="editor-kind-tabs-v9" value={form.kind} onValueChange={changeKind}>{Object.entries(KIND_NAMES).map(([key, label]) => <label className={form.kind === key ? 'selected' : ''} key={key}><RadioGroupItem value={key}/><span>{label}</span></label>)}</RadioGroup>
                {form.kind === 'exchange' ? <div className="exchange-choice-v9"><div><label className="field-label">내놓는 대상<select value={form.category} onChange={e => changeCategory(e.target.value)}><option value="account">계정</option><option value="clan">클랜</option></select></label><span aria-hidden="true">→</span><label className="field-label">구하는 대상<select value={wantedCategory} onChange={e => { const details = Object.fromEntries(Object.entries(form.details).filter(([key]) => !key.startsWith('wanted'))); patch({ details: { ...details, wantedCategory: e.target.value } }); }}><option value="account">계정</option><option value="clan">클랜</option></select></label></div><p>{exchangeText}</p></div> : <RadioGroup aria-label="세부 분류" className="editor-subcategory-v9" value={form.category} onValueChange={changeCategory}>{categoriesForKind(form.kind).map(c => <label className={form.category === c.id ? 'selected' : ''} key={c.id}><RadioGroupItem value={c.id}/><span>{c.name}</span></label>)}</RadioGroup>}
                <label className="field-label editor-title-field"><span>제목 <em>필수</em></span><input required minLength={2} maxLength={100} placeholder="제목을 입력하세요" value={form.title} onChange={e => patch({ title: e.target.value })}/><small>{form.title.length} / 100</small></label>
                {id && <label className="field-label narrow">거래 상태<select value={form.status} onChange={e => patch({ status: e.target.value })}>{Object.entries(STATUS_NAMES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>}
            </section>
            {form.kind !== 'exchange' && <section className="editor-section editor-pricing-v9"><h3 className="editor-section-title">{form.kind === 'buy' ? '최대 예산' : form.kind === 'sell' ? '가격' : form.kind === 'proxy_request' ? '작업 예산' : '진행 금액'}</h3>
                {form.kind === 'sell' ? <><div className="sale-prices-v9"><div>{moneyField('즉거가', form.price, price => patch({ price }), '미정이면 비워두세요')}</div><div>{moneyField('현젯', form.details.currentOffer || '', value => detailPatch('currentOffer', value), '제안이 없으면 비워두세요')}</div></div>{id && <p className="field-hint">즉거가를 변경하면 이전 금액이 취소선으로 함께 공개됩니다.</p>}<label className="inline-check"><Checkbox checked={form.price === '' || form.accepts_offers} disabled={form.price === ''} onCheckedChange={v => patch({ accepts_offers: v === true })}/>가격 제안 받기</label></> : <div className="single-price-v9">{moneyField(form.kind === 'buy' ? '최대 사용 가능 금액 (MAX)' : form.kind === 'proxy_request' ? '최대 작업 예산' : '진행 금액', form.price, price => patch({ price }), '협의하려면 비워두세요')}</div>}
            </section>}
            {showDetails && <section className="editor-section"><div className="section-heading"><div><h3>{form.kind === 'exchange' ? '교환 조건' : hasAccount ? form.kind === 'buy' ? '원하는 계정 조건' : '판매 계정 정보' : proxy ? form.kind === 'proxy_request' ? '요청 내용' : '진행 내용' : categoryName(form.category) + (form.kind === 'buy' ? ' 구매 조건' : ' 정보')}</h3><p>필요한 항목만 입력하세요.</p></div></div>
                {form.kind === 'exchange' ? <><div className="exchange-account-section-v9"><h4 className="exchange-section-title">내놓는 {categoryName(form.category)}</h4>{hasAccount ? <><AccountFields value={form.details} onChange={details => patch({ details })} buying={false}/><details className="editor-ladder"><summary>보유 래더 기록<span>{form.tags.length ? form.tags.length + '개 선택' : '선택 사항'}</span></summary><SeasonPicker value={form.tags} onChange={tags => patch({ tags })}/></details></> : genericFields('clan')}</div><div className="exchange-account-section-v9"><h4 className="exchange-section-title">구하는 {categoryName(wantedCategory)}</h4>{wantedCategory === 'account' ? <AccountFields value={form.details} onChange={details => patch({ details })} buying wanted/> : <p className="field-hint">원하는 클랜 조건을 아래 상세 설명에 적어주세요.</p>}</div></> : hasAccount ? <><AccountFields value={form.details} onChange={details => patch({ details })} buying={form.kind === 'buy'}/><details className="editor-ladder"><summary>{form.kind === 'buy' ? '원하는 래더 기록' : '보유 래더 기록'}<span>{form.tags.length ? form.tags.length + '개 선택' : '선택 사항'}</span></summary><SeasonPicker value={form.tags} onChange={tags => patch({ tags })}/></details></> : <>{genericFields(form.category)}{form.category === 'ladder' && <details className="editor-ladder"><summary>래더 시즌과 티어<span>{form.tags.length ? form.tags.length + '개 선택' : '선택 사항'}</span></summary><SeasonPicker value={form.tags} onChange={tags => patch({ tags })}/></details>}</>}
            </section>}
            <section className="editor-section"><div className="section-heading"><div><h3>사진과 설명</h3><p>첫 번째 사진이 대표 사진입니다. 최대 6장까지 올릴 수 있어요.</p></div></div><input type="file" ref={file} hidden multiple accept="image/jpeg,image/png,image/webp" onChange={e => upload(e.target.files)}/><div className="image-upload-grid">{form.images.map((img, i) => <div className="upload-preview" key={img}><img src={'/api/images/' + img} alt={'첨부 사진 ' + (i + 1)}/>{i === 0 && <b>대표</b>}<button type="button" className="remove-image" aria-label={'사진 ' + (i + 1) + ' 삭제'} onClick={() => patch({ images: form.images.filter(v => v !== img) })}><X size={14}/></button><div><button type="button" disabled={i === 0} aria-label="사진 앞으로" onClick={() => { const a = [...form.images]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; patch({ images: a }); }}><ChevronLeft size={13}/></button><span>{i + 1}</span><button type="button" disabled={i === form.images.length - 1} aria-label="사진 뒤로" onClick={() => { const a = [...form.images]; [a[i + 1], a[i]] = [a[i], a[i + 1]]; patch({ images: a }); }}><ChevronRight size={13}/></button></div></div>)}{form.images.length < 6 && <button type="button" className="upload-button" disabled={uploading} onClick={() => file.current?.click()}>{uploading ? <LoaderCircle size={24} className="spin"/> : <ImagePlus size={26}/>}<span>{uploading ? '사진 처리 중' : `사진 추가 ${form.images.length}/6`}</span></button>}</div><div className="description-heading"><label htmlFor="trade-description">상세 설명 <em>필수</em></label><button type="button" className="subtle" disabled={!!form.body.trim()} onClick={() => patch({ body: descriptionTemplate(form.kind, form.category) })}>설명 양식 넣기</button></div><textarea id="trade-description" required maxLength={10000} rows={9} placeholder={form.kind === 'exchange' ? '내놓는 대상과 구하는 조건, 교환 방법을 적어주세요.' : proxy ? '진행 범위와 일정, 필요한 조건을 적어주세요.' : form.kind === 'buy' ? '원하는 조건과 거래 방법을 적어주세요.' : '스킨과 구성, 상태, 거래 방법 등 자세한 내용을 적어주세요.'} value={form.body} onChange={e => patch({ body: e.target.value })}/><div className="description-foot"><span>비밀번호, 인증번호, 쿠폰 코드는 공개하지 마세요.</span><span>{form.body.length.toLocaleString()} / 10,000</span></div></section>
            {error && <div className="error-banner" role="alert">{error}</div>}<div className="editor-actions"><button type="button" className="secondary" onClick={() => persist(true)}><Save size={16}/>임시저장</button><div><button type="button" className="secondary" onClick={() => setPreview(true)}><Eye size={16}/>미리보기</button><button type="submit" className="primary" disabled={busy || uploading}>{busy ? <LoaderCircle size={17} className="spin"/> : <Check size={17}/>} {id ? '수정 완료' : '등록하기'}</button></div></div>
        </fieldset></form>
        <Dialog open={preview} onOpenChange={setPreview}><DialogContent className="preview-dialog"><DialogTitle>{form.title || '아직 제목이 없습니다'}</DialogTitle><DialogDescription>{KIND_NAMES[form.kind]} / {form.kind === 'exchange' ? exchangeText : categoryName(form.category)}</DialogDescription>{form.kind !== 'exchange' && <div className="preview-pricing-v9"><span>{form.kind === 'buy' ? '최대 예산 (MAX)' : form.kind === 'sell' ? '즉거가' : '진행 금액'}</span><strong className="preview-price">{listingPrice({ kind: form.kind as any, price_mode: form.price === '' && form.kind === 'sell' ? 'offer' : 'negotiate', price: form.price === '' ? null : Number(form.price) })}</strong>{form.kind === 'sell' && form.details.currentOffer && <span>현젯 <b>{Number(form.details.currentOffer).toLocaleString('ko-KR')}원</b></span>}</div>}<TagBadges tags={form.tags}/>{hasAccount && <AccountDetails value={form.details} buying={form.kind === 'buy'}/>}{form.kind === 'exchange' && wantedCategory === 'account' && <><h4>구하는 계정 조건</h4><AccountDetails value={form.details} buying wanted/></>}{form.images[0] && <img className="preview-photo" src={'/api/images/' + form.images[0]} alt="대표 사진 미리보기"/>}<div className="formatted-body">{form.body || '상세 설명을 작성해주세요.'}</div></DialogContent></Dialog>
    </div>;
}
