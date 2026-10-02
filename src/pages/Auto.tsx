import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { KIND_ICONS, isTradeKind, manToWon, priceText, wonToMan } from '../../shared/market';
import { ALERT_TEXT, AUTO_TEXT, DROP_TEXT, dropEveryText, dropStepText, kstDateTime } from '../../shared/membership';
import { api, errorText, imageUrl } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { CIcon, SkeletonRows } from '../components/ui';
import { WalletGauge, kstClock, useMinuteClock, type Usage, type Wallet } from '../components/Wallet';
import { useAutoToggle } from '../components/AutoSheet';

// GET me/automation (WP52). state: '' running, 'idle' 쉬는 중, 'busy' delayed, 'reply' / 'away' paused,
// 'wallet' waiting for 3 끌올. nextAt: the tick that looks next (null: parked). slots null: every post.
// drop (WP56): the post's 가격 내리기 (null: not a priced 판매 post).
export type PostDrop = { on: boolean; floor: number; nextAt: number | null; nextPrice: number | null; count: number };
type AutoPost = { id: number; title: string; kind: string; category: string; thumb: string | null; image: string | null; bumped_at: number; hidden: boolean; auto: boolean; stale: boolean;
    price: number | null; current_offer: number | null; drop: PostDrop | null };
type DropSettings = { slots: number | null; step: number; pct: number | null; everyH: number; everyOptions: number[]; canPct: boolean; canDecline: boolean; declineOn: boolean; on: number };
export type AutoState = Wallet & {
    bumpOn: boolean; bumpNew: boolean; canBumpNew: boolean; state: string; pausedAt: number | null; nextAt: number | null; everyMin: number;
    slots: number | null; pauseDays: number | null; trial: boolean; listed: number; stale: number; posts: AutoPost[]; drop: DropSettings;
};
// '다음 내림 10월 2일 20:00 · 27만원' (the Detail owner bar shows the same line).
export const dropStatus = (d: PostDrop | null | undefined) => d?.on && d.nextAt && d.nextPrice ? DROP_TEXT.next(kstDateTime(d.nextAt), priceText(d.nextPrice)) : null;

// The one status line under the wallet.
function statusLine(s: AutoState) {
    if (!s.bumpOn) return null;
    if (s.state === 'reply') return <>{AUTO_TEXT.reply} <Link to="/chat" className="auto-link">채팅</Link></>;
    if (s.state === 'away') return AUTO_TEXT.away(s.pauseDays || 3);
    if (s.listed > 0 && s.stale === s.listed) return AUTO_TEXT.stale;
    if (s.state === 'idle') return AUTO_TEXT.idle;
    if (s.state === 'busy' && s.nextAt) return AUTO_TEXT.busy(kstClock(s.nextAt));
    if (s.listed > 0 && s.nextAt) return AUTO_TEXT.running(s.everyMin, kstClock(s.nextAt));
    return null;
}

// 내 거래 › 자동화 (플러스 and up, the 체험 and the manager): the 끌올 card with the wallet, the status, the
// switches and the list of posts with their own switch.
export function Auto() {
    const [s, setS] = useState<AutoState | null>(null);
    const load = () => api<AutoState>('me/automation').then(setS).catch(e => toast.error(errorText(e)));
    useEffect(() => { void load(); }, []);
    if (!s) return <SkeletonRows count={2} height={120} />;
    return <>
        <BumpCard s={s} setS={setS} load={load} />
        <div className="mt-16"><DropCard s={s} setS={setS} /></div>
    </>;
}

function BumpCard({ s, setS, load }: { s: AutoState; setS: (s: AutoState) => void; load: () => Promise<unknown> }) {
    const [busy, setBusy] = useState(false);
    const [now] = useMinuteClock();
    const { toggle, busy: toggling, sheet } = useAutoToggle(() => { void load(); });

    async function save(change: { bumpOn?: boolean; bumpNew?: boolean }) {
        if (busy) return;
        setBusy(true);
        try { setS(await api<AutoState>('me/automation', 'PUT', change)); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    async function keepAll() {
        if (busy) return;
        setBusy(true);
        try { await api('me/automation/continue', 'POST', {}); await load(); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    const line = statusLine(s);
    const open = s.posts.filter(p => !p.hidden);
    return <section className="card card-pad auto-card" aria-labelledby="auto-bump-title">
        <h2 className="card-title" id="auto-bump-title">끌올</h2>
        <WalletGauge usage={s as unknown as Usage} now={now} className="auto-wallet" />
        {line && <p className={'auto-status' + (s.state === 'reply' || s.state === 'away' || (s.listed > 0 && s.stale === s.listed) ? ' is-paused' : '')} role="status">{line}</p>}
        {s.trial && <p className="auto-note">{AUTO_TEXT.trial}</p>}
        <div className="auto-switches">
            <label className="switch"><input type="checkbox" role="switch" checked={s.bumpOn} disabled={busy} onChange={e => void save({ bumpOn: e.target.checked })} />자동 끌올</label>
            {s.canBumpNew && <label className="switch"><input type="checkbox" role="switch" checked={s.bumpNew} disabled={busy} onChange={e => void save({ bumpNew: e.target.checked })} />새 글 자동 포함</label>}
        </div>
        {s.stale > 0 && <div className="auto-stale">
            <span>{AUTO_TEXT.staleCount(s.stale)}</span>
            <button type="button" className="btn btn-line btn-sm" disabled={busy} onClick={() => void keepAll()}>모두 계속</button>
        </div>}
        <h3 className="auto-list-title">글 {s.listed}{s.slots !== null ? `/${s.slots}` : ''}</h3>
        {open.length ? <ul className="auto-list">{open.map(p => <li key={p.id} className={p.auto ? 'is-on' : ''}>
            <Link to={'/posts/' + p.id} className="auto-thumb" tabIndex={-1} aria-hidden="true">{p.thumb || p.image ? <img src={p.thumb || imageUrl(p.image!)} alt="" loading="lazy" /> : <CIcon name={isTradeKind(p.kind) ? KIND_ICONS[p.kind] : 'money-bag'} size={24} />}</Link>
            <span className="auto-main">
                <Link to={'/posts/' + p.id} className="auto-title">{p.title}</Link>
                {p.auto && p.stale && <span className="auto-sub">7일 동안 변경 없음</span>}
            </span>
            <label className="switch auto-post-switch"><input type="checkbox" role="switch" aria-label={`${p.title} 자동 끌올`} checked={p.auto} disabled={toggling} onChange={e => void toggle(p.id, e.target.checked)} /></label>
        </li>)}</ul> : <p className="auto-empty">거래중인 글이 없습니다.</p>}
        <ul className="auto-hints">
            <li>{AUTO_TEXT.reserve}</li>
            <li>{AUTO_TEXT.capped}</li>
        </ul>
        {sheet}
    </section>;
}

// The '가격 내리기' card (WP56): at most 3 controls above the list (내림 폭, 주기 and, for 엘리트, '판매 글
// 전체'; 플러스 has fixed text instead), then every open priced 판매 post with its 즉거가, 최저가 (만원, prefilled
// with 80% rounded down to 만원) and switch, and '다음 내림 10월 2일 20:00 · 27만원' once on.
function DropCard({ s, setS }: { s: AutoState; setS: (s: AutoState) => void }) {
    const d = s.drop, [busy, setBusy] = useState(false);
    const [floors, setFloors] = useState<Record<number, string>>({});
    const rows = s.posts.filter(p => p.drop && !p.hidden);
    const floorOf = (p: AutoPost) => floors[p.id] ?? wonToMan(p.drop!.floor);
    async function run<T>(fn: () => Promise<T>) {
        if (busy) return;
        setBusy(true);
        try { await fn(); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    const save = (change: Record<string, unknown>) => run(async () => setS(await api<AutoState>('me/automation', 'PUT', change)));
    const setPost = (id: number, drop: PostDrop) => setS({ ...s, posts: s.posts.map(p => p.id === id ? { ...p, drop } : p), drop: { ...d, on: d.on + (drop.on ? 1 : 0) - (s.posts.find(p => p.id === id)?.drop?.on ? 1 : 0) } });
    // The switch, and a new 최저가 on a running setup (on blur or Enter).
    function put(p: AutoPost, on: boolean) {
        const floor = manToWon(floorOf(p));
        if (on && (floor === null || Number.isNaN(floor) || floor < 1000 || p.price === null || floor >= p.price)) { toast.error(DROP_TEXT.floor); return; }
        return run(async () => {
            const r = await api<{ drop: PostDrop }>(`posts/${p.id}/auto`, 'PUT', { drop: on ? { on, floor } : { on } });
            setPost(p.id, r.drop);
            setFloors(f => { const { [p.id]: _, ...rest } = f; return rest; });
        });
    }
    const allOn = () => run(async () => {
        const r = await api<AutoState & { count: number }>('me/automation/drop-all', 'POST', {});
        setS(r);
        toast(DROP_TEXT.allDone(r.count));
    });
    return <section className="card card-pad auto-card drop-card" aria-labelledby="auto-drop-title">
        <div className="card-title-row"><h2 className="card-title" id="auto-drop-title">{DROP_TEXT.title}</h2>
            <span className="alert-count">글 {d.on}{d.slots !== null ? `/${d.slots}` : ''}</span></div>
        <div className="drop-head">
            <label className="drop-setting"><span>내림 폭</span>
                {d.canPct ? <select className="select" value={d.pct ? 'pct' : 'step'} disabled={busy} onChange={e => void save(e.target.value === 'pct' ? { dropPct: 5 } : { dropStep: d.step })}>
                    <option value="step">{dropStepText(d.step, null)}</option><option value="pct">{dropStepText(null, 5)}</option>
                </select> : <strong>{dropStepText(d.step, null)}</strong>}</label>
            <label className="drop-setting"><span>주기</span>
                {d.everyOptions.length > 1 ? <select className="select" value={d.everyH} disabled={busy} onChange={e => void save({ dropEveryH: Number(e.target.value) })}>
                    {d.everyOptions.map(h => <option key={h} value={h}>{dropEveryText(h)}</option>)}
                </select> : <strong>{dropEveryText(d.everyH)}</strong>}</label>
            {d.slots === null && <button type="button" className="btn btn-line btn-sm drop-all" disabled={busy || !rows.length} onClick={() => void allOn()}>{DROP_TEXT.all}</button>}
        </div>
        {rows.length ? <ul className="auto-list drop-list">{rows.map(p => {
            const status = dropStatus(p.drop);
            return <li key={p.id} className={p.drop!.on ? 'is-on' : ''}>
                <Link to={'/posts/' + p.id} className="auto-thumb" tabIndex={-1} aria-hidden="true">{p.thumb || p.image ? <img src={p.thumb || imageUrl(p.image!)} alt="" loading="lazy" /> : <CIcon name="money-bag" size={24} />}</Link>
                <span className="auto-main">
                    <Link to={'/posts/' + p.id} className="auto-title">{p.title}</Link>
                    <span className="auto-sub">즉거가 {priceText(p.price)}{p.current_offer ? ` · 현젯 ${priceText(p.current_offer)}` : ''}</span>
                    <span className="drop-floor"><span className="drop-floor-label">{DROP_TEXT.floorLabel}</span>
                        <span className="input-unit"><input className="input" type="number" inputMode="decimal" min="0.1" step="0.1" aria-label={`${p.title} ${DROP_TEXT.floorLabel}`}
                            value={floorOf(p)} disabled={busy} onChange={e => setFloors(f => ({ ...f, [p.id]: e.target.value }))}
                            onBlur={() => { if (p.drop!.on && floors[p.id] !== undefined && manToWon(floors[p.id]) !== p.drop!.floor) void put(p, true); }}
                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /><span>만원</span></span></span>
                    {status && <span className="drop-status">{status}</span>}
                </span>
                <label className="switch auto-post-switch"><input type="checkbox" role="switch" aria-label={`${p.title} ${DROP_TEXT.title}`} checked={p.drop!.on} disabled={busy} onChange={e => void put(p, e.target.checked)} /></label>
            </li>;
        })}</ul> : <p className="auto-empty">즉거가가 있는 판매 글이 없습니다.</p>}
        {d.canDecline && <label className="switch drop-decline"><input type="checkbox" role="switch" checked={d.declineOn} disabled={busy} onChange={e => void save({ declineOn: e.target.checked })} />{DROP_TEXT.decline}</label>}
        <ul className="auto-hints"><li>{DROP_TEXT.hold}</li></ul>
    </section>;
}

// The '알림' card (WP54): every saved search with its 알림 switch. 키워드·게시판 알림 are free for every
// grade (SITE_RULES.keywordAlerts); 조건 알림 count against the grade ('조건 알림 3/10').
type SavedAlert = { id: string; name: string; query: string; alert: boolean; keyword: boolean };
type SavedList = { searches: SavedAlert[]; filterAlerts: number | null; keywordAlerts: number };
export function AlertCard() {
    const [d, setD] = useState<SavedList | null>(null), [busy, setBusy] = useState(false);
    const load = () => api<SavedList>('searches').then(setD).catch(e => toast.error(errorText(e)));
    useEffect(() => { void load(); }, []);
    if (!d) return <SkeletonRows count={1} height={120} />;
    async function toggle(v: SavedAlert, on: boolean) {
        if (busy) return;
        setBusy(true);
        try { await api('searches/' + v.id, 'PATCH', { alert: on }); toast(on ? ALERT_TEXT.on : ALERT_TEXT.off); await load(); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    const used = d.searches.filter(v => v.alert && !v.keyword).length;
    return <section className="card card-pad auto-card alert-card" aria-labelledby="auto-alert-title">
        <div className="card-title-row"><h2 className="card-title" id="auto-alert-title">알림</h2>
            {d.filterAlerts !== null && <span className="alert-count">{ALERT_TEXT.filterCount(used, d.filterAlerts)}</span>}</div>
        {d.searches.length ? <ul className="auto-list">{d.searches.map(v => <li key={v.id} className={v.alert ? 'is-on' : ''}>
            <span className="auto-main">
                <button type="button" className="auto-title" onClick={() => void navigate('/trade?' + v.query)}>{v.name}</button>
                <span className="auto-sub">{v.keyword ? (new URLSearchParams(v.query).get('q') ? '키워드 알림' : '게시판 알림') : '조건 알림'}</span>
            </span>
            <label className="switch auto-post-switch"><input type="checkbox" role="switch" aria-label={`${v.name} ${ALERT_TEXT.boardBell}`} checked={v.alert} disabled={busy} onChange={e => void toggle(v, e.target.checked)} /></label>
        </li>)}</ul> : <p className="auto-empty">저장한 검색이 없습니다. 게시판에서 검색 조건을 저장하면 여기서 알림을 켤 수 있습니다.</p>}
    </section>;
}
