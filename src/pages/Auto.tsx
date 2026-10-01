import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { KIND_ICONS, isTradeKind } from '../../shared/market';
import { AUTO_TEXT } from '../../shared/membership';
import { api, errorText, imageUrl } from '../lib/api';
import { Link } from '../lib/router';
import { CIcon, SkeletonRows } from '../components/ui';
import { WalletGauge, kstClock, useMinuteClock, type Usage, type Wallet } from '../components/Wallet';
import { useAutoToggle } from '../components/AutoSheet';

// GET me/automation (WP52). state: '' running, 'idle' 쉬는 중, 'busy' delayed, 'reply' / 'away' paused,
// 'wallet' waiting for 3 끌올. nextAt: the tick that looks next (null: parked). slots null: every post.
type AutoPost = { id: number; title: string; kind: string; category: string; thumb: string | null; image: string | null; bumped_at: number; hidden: boolean; auto: boolean; stale: boolean };
export type AutoState = Wallet & {
    bumpOn: boolean; bumpNew: boolean; canBumpNew: boolean; state: string; pausedAt: number | null; nextAt: number | null; everyMin: number;
    slots: number | null; pauseDays: number | null; trial: boolean; listed: number; stale: number; posts: AutoPost[];
};

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
    const [s, setS] = useState<AutoState | null>(null), [busy, setBusy] = useState(false);
    const [now] = useMinuteClock();
    const load = () => api<AutoState>('me/automation').then(setS).catch(e => toast.error(errorText(e)));
    useEffect(() => { void load(); }, []);
    const { toggle, busy: toggling, sheet } = useAutoToggle(() => { void load(); });
    if (!s) return <SkeletonRows count={2} height={120} />;

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
