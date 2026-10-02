import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { PROVIDER_TEXT, canProvide, isProviderType, type ProviderType } from '../../shared/membership';
import { api, errorText } from '../lib/api';
import { navigate, useLocation, withParams } from '../lib/router';
import { useAdaptivePoll, useApp } from '../app/state';
import { EmptyState, SkeletonRows } from '../components/ui';
import { EarnBlock, EliteCard, ProviderEditor, ProviderTile, openProviderChat, type OwnCard, type ProviderItem } from '../components/ProviderCard';

type ListData = { type: ProviderType; page: number; seed: string; elite: ProviderItem[]; premium: ProviderItem[]; plus: ProviderItem[]; plusMore: boolean; mine: OwnCard | null };
// While the page is on screen it asks again every 2 minutes (adaptive: never while hidden or idle).
const REFRESH_MS = 120000;

// '중개/가측' (WP66): the members holding 중개 인증 or 가측 인증, by grade block (엘리트 and 관리자 gold cards, 프리미엄
// 64px profiles with 12자 of 소개, 플러스 48px profiles), each block 접속 중 first and then in the server's fair
// rotation. A card opens the chat with the 문의 template in the composer; the member's own card opens its editor.
export default function Providers() {
    const { me, requireLogin, openApply, config } = useApp();
    const { params } = useLocation();
    const raw = params.get('type');
    const type: ProviderType = isProviderType(raw) ? raw : 'broker';
    const [data, setData] = useState<ListData | null>(null), [error, setError] = useState(''), [more, setMore] = useState<ProviderItem[]>([]), [page, setPage] = useState(1), [moreBusy, setMoreBusy] = useState(false);
    const [editing, setEditing] = useState(false);
    const requests = useRef(0);
    // fresh: skip the 30-second browser cache (after an edit of the member's own card).
    const load = useCallback((fresh = false) => {
        const n = ++requests.current;
        api<ListData>(withParams('providers', { type, ...fresh ? { t: String(Date.now()) } : {} }))
            .then(d => { if (n === requests.current) { setData(d); setError(''); } })
            .catch(e => { if (n === requests.current) setError(errorText(e)); });
    }, [type]);
    useEffect(() => { setData(null); setMore([]); setPage(1); load(); }, [load, me?.id]);
    useAdaptivePoll(() => { if (page === 1) load(); }, true, REFRESH_MS);

    async function loadMore() {
        if (moreBusy || !data) return;
        setMoreBusy(true);
        try {
            const d = await api<ListData>(withParams('providers', { type, page: String(page + 1) }));
            const seen = new Set([...data.plus, ...more].map(p => p.id));
            setMore([...more, ...d.plus.filter(p => !seen.has(p.id))]);
            setData({ ...data, plusMore: d.plusMore });
            setPage(page + 1);
        } catch (e) { toast.error(errorText(e)); }
        finally { setMoreBusy(false); }
    }

    const holds = !!me?.badges.includes(type);
    const eligible = !!me && canProvide(me);
    const open = (p: ProviderItem) => openProviderChat(p, type, requireLogin, () => setEditing(true));
    const segment = (t: ProviderType) => void navigate(withParams('/providers', { type: t }), { replace: true });
    const mine = data?.mine || null;
    const plus = data ? [...data.plus, ...more] : [];
    const empty = !!data && !data.elite.length && !data.premium.length && !plus.length;
    const applyButton = eligible && !holds && <button type="button" className="btn btn-primary" onClick={() => openApply({ kind: 'badge', target: type })}>{PROVIDER_TEXT.apply[type]}</button>;

    return <div className="container page providers">
        <h1 className="sr-only">{PROVIDER_TEXT.tab}</h1>
        <div className="pv-head">
            <div className="pv-seg" role="tablist" aria-label={PROVIDER_TEXT.tab}>
                {(['broker', 'appraiser'] as ProviderType[]).map(t => <button key={t} type="button" role="tab" aria-selected={t === type} className="pv-seg-btn" onClick={() => segment(t)}>{PROVIDER_TEXT.names[t]}</button>)}
            </div>
            {holds && <button type="button" className="btn btn-line btn-sm" onClick={() => setEditing(true)}>{PROVIDER_TEXT.mine}</button>}
        </div>
        <p className="pv-safety"><ShieldCheck size={16} aria-hidden="true" />{PROVIDER_TEXT.safety}</p>
        {/* The member's own card while it is not listed: why, and the editor. */}
        {mine && !mine.listed && <button type="button" className="pv-own" onClick={() => setEditing(true)}>
            <b>{PROVIDER_TEXT.mine}</b><span>{mine.reason === 'off' ? PROVIDER_TEXT.off : PROVIDER_TEXT.hidden}</span>
        </button>}
        {error && !data ? <EmptyState title="목록을 불러오지 못했습니다" text={error} action={<button type="button" className="btn btn-line" onClick={() => load(true)}>다시 시도</button>} />
            : !data ? <SkeletonRows count={3} height={132} />
            : empty ? <EmptyState title={PROVIDER_TEXT.empty[type]} action={applyButton || undefined} />
            : <>
                {data.elite.length > 0 && <section className="pv-block" aria-label="엘리트">
                    <h2 className="pv-label pv-label-gold">엘리트</h2>
                    <div className="pv-elite-grid">{data.elite.map(p => <EliteCard key={p.id} p={{ ...p, type }} mine={p.id === me?.id} onOpen={() => open(p)} />)}</div>
                </section>}
                {data.premium.length > 0 && <section className="pv-block" aria-label="프리미엄">
                    <h2 className="pv-label pv-label-silver">프리미엄</h2>
                    <div className="pv-grid pv-grid-premium">{data.premium.map(p => <ProviderTile key={p.id} p={p} size="premium" mine={p.id === me?.id} onOpen={() => open(p)} />)}</div>
                </section>}
                {plus.length > 0 && <section className="pv-block" aria-label="플러스">
                    <h2 className="pv-label pv-label-bronze">플러스</h2>
                    <div className="pv-grid pv-grid-plus">{plus.map(p => <ProviderTile key={p.id} p={p} size="plus" mine={p.id === me?.id} onOpen={() => open(p)} />)}</div>
                    {data.plusMore && <button type="button" className="btn btn-line more-btn" disabled={moreBusy} onClick={() => void loadMore()}>{PROVIDER_TEXT.more}</button>}
                </section>}
                {applyButton && <div className="pv-apply">{applyButton}</div>}
            </>}
        {/* 수익 홍보 for members who may apply and have no 인증 of this kind yet. */}
        {eligible && !holds && <EarnBlock earn={config.earn} className="mt-24" />}
        {holds && <ProviderEditor open={editing} onClose={() => setEditing(false)} type={type} initial={mine ? { intro: mine.intro, active: mine.active } : null} onSaved={() => load(true)} />}
    </div>;
}
