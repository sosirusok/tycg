import { useEffect, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { KIND_ICONS, isTradeKind, manToWon, priceText, wonToMan } from '../../shared/market';
import { ALERT_TEXT, AUTO_REPLY_MAX, AUTO_TEXT, CHAT_AUTO_TEXT, DROP_TEXT, MATCH_TEXT, TEMPLATE_MAX, dropEveryText, dropStepText, kstDateTime } from '../../shared/membership';
import { TEMPLATE_VARS } from '../../shared/market';
import type { ChatAuto } from './Chat';
import { api, errorText, imageUrl } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { CIcon, SkeletonRows } from '../components/ui';
import { WalletGauge, kstClock, useMinuteClock, type Usage, type Wallet } from '../components/Wallet';
import { useAutoToggle } from '../components/AutoSheet';

// GET me/automation (WP52). state: '' running, 'idle' 쉬는 중 (every post on page 1), 'wait' 쉬는 중 (another
// reason), 'busy' delayed, 'reply' / 'away' paused,
// 'wallet' waiting for 3 끌올. nextAt: the tick that looks next (null: parked). slots null: every post.
// drop (WP56): the post's 가격 내리기 (null: not a priced 판매 post).
export type PostDrop = { on: boolean; floor: number; nextAt: number | null; nextPrice: number | null; count: number };
// match (WP58): whether 자동 매칭 looks at the post now (open 판매·구매 posts only).
type AutoPost = { id: number; title: string; kind: string; category: string; thumb: string | null; image: string | null; bumped_at: number; hidden: boolean; auto: boolean; stale: boolean;
    price: number | null; current_offer: number | null; drop: PostDrop | null; match?: boolean };
// 자동 매칭 (WP58): the switch, the posts it may look at (0: below 프리미엄, null: every post), '채팅 보내기' a day.
type MatchSettings = { on: boolean; slots: number | null; chats: number; count: number };
type DropSettings = { slots: number | null; step: number; pct: number | null; everyH: number; everyOptions: number[]; canPct: boolean; canDecline: boolean; declineOn: boolean; on: number };
export type AutoState = Wallet & {
    bumpOn: boolean; bumpNew: boolean; canBumpNew: boolean; state: string; pausedAt: number | null; nextAt: number | null; everyMin: number;
    slots: number | null; pauseDays: number | null; trial: boolean; listed: number; stale: number; posts: AutoPost[]; drop: DropSettings; chat: ChatAuto; match: MatchSettings;
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
    if (s.state === 'wait') return s.listed > 0 && s.nextAt ? AUTO_TEXT.rest(kstClock(s.nextAt)) : null;
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
        <div className="mt-16"><ChatCard chat={s.chat} setChat={chat => setS({ ...s, chat })} /></div>
        <div className="mt-16"><AlertCard auto={s} setAuto={setS} reload={load} /></div>
    </>;
}

// '자동 매칭' on the '알림' card (WP58): 프리미엄 picks up to 3 posts as chips ('글 2/3'; until the first pick the
// 3 most recently bumped), 엘리트 and up match every post and get '채팅 보내기'. 플러스 sees the grade it needs.
function MatchBlock({ s, setS, reload }: { s: AutoState; setS: (s: AutoState) => void; reload: () => Promise<unknown> }) {
    const m = s.match, [busy, setBusy] = useState(false);
    if (m.slots === 0) return <div className="match-block"><span className="auto-title">{MATCH_TEXT.switch}</span><span className="auto-sub">{MATCH_TEXT.locked}</span></div>;
    async function run(fn: () => Promise<unknown>) {
        if (busy) return;
        setBusy(true);
        try { await fn(); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    const posts = s.posts.filter(p => p.match !== undefined);
    return <div className="match-block">
        <label className="switch"><input type="checkbox" role="switch" checked={m.on} disabled={busy} onChange={e => void run(async () => setS(await api<AutoState>('me/automation', 'PUT', { matchOn: e.target.checked })))} />{MATCH_TEXT.switch}</label>
        {m.slots === null ? <span className="auto-sub">{MATCH_TEXT.all}{m.chats ? ` · ${MATCH_TEXT.chat} 하루 ${m.chats}번` : ''}</span> : <>
            <span className="auto-sub">글 {m.count}/{m.slots}</span>
            {posts.length ? <div className="chip-row match-chips">{posts.map(p => <button type="button" key={p.id} className="chip chip-sm" aria-pressed={!!p.match} disabled={busy || !m.on}
                onClick={() => void run(async () => { await api(`posts/${p.id}/auto`, 'PUT', { match: !p.match }); await reload(); })}><span className="chip-own">{p.title}</span></button>)}</div>
                : <p className="auto-empty">거래중인 판매·구매 글이 없습니다.</p>}
        </>}
    </div>;
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

// The '채팅' card (WP57): 내 빠른 답장 (n/10, each with a delete button, and a field to add one), then
// for 프리미엄 and up '첫 문의 자동 안내' with its text, and for 엘리트 and up '자리 비움' with its hours and
// text. Both switches start off; the texts start with the prefills and save on blur.
const hourText = (h: number) => `${String(h).padStart(2, '0')}:00`;
function ChatCard({ chat, setChat }: { chat: ChatAuto; setChat: (c: ChatAuto) => void }) {
    const [busy, setBusy] = useState(false), [draft, setDraft] = useState('');
    const [first, setFirst] = useState(chat.firstText), [away, setAway] = useState(chat.awayText);
    async function save(change: Record<string, unknown>, done?: string) {
        if (busy) return false;
        setBusy(true);
        try { const r = await api<{ chat: ChatAuto }>('me/automation', 'PUT', change); setChat(r.chat); if (done) toast(done); return true; }
        catch (e) { toast.error(errorText(e)); return false; }
        finally { setBusy(false); }
    }
    async function add(e: FormEvent) {
        e.preventDefault();
        const t = draft.trim();
        if (!t || chat.templates.includes(t)) { setDraft(''); return; }
        if (await save({ templates: [...chat.templates, t] }, '저장 완료')) setDraft('');
    }
    const full = chat.max !== null && chat.templates.length >= chat.max;
    const hours = Array.from({ length: 24 }, (_, h) => h);
    return <section className="card card-pad auto-card chat-auto-card" aria-labelledby="auto-chat-title">
        <h2 className="card-title" id="auto-chat-title">채팅</h2>
        <h3 className="auto-list-title">내 빠른 답장 {chat.templates.length}{chat.max !== null ? `/${chat.max}` : ''}</h3>
        {chat.templates.length ? <ul className="auto-list template-list">{chat.templates.map(t => <li key={t}>
            <span className="auto-main"><span className="template-text">{t}</span></span>
            <button type="button" className="icon-btn" aria-label={`${t} 삭제`} disabled={busy} onClick={() => void save({ templates: chat.templates.filter(x => x !== t) }, '삭제 완료')}><X size={18} /></button>
        </li>)}</ul> : <p className="auto-empty">채팅 입력창의 + 빠른 답장으로도 저장할 수 있습니다.</p>}
        {!full && <form className="template-add" onSubmit={add}>
            <input className="input" value={draft} maxLength={TEMPLATE_MAX} disabled={busy} onChange={e => setDraft(e.target.value)} placeholder="예: 전번·계좌 인증 가능합니다" aria-label="빠른 답장 문구" />
            <button type="submit" className="btn btn-line btn-sm" disabled={busy || !draft.trim()}>추가</button>
        </form>}
        {chat.vars && <p className="auto-note">쓸 수 있는 값: {TEMPLATE_VARS.join(' · ')}</p>}
        {(chat.canFirst || chat.canAway) && <h3 className="auto-list-title">{CHAT_AUTO_TEXT.label}</h3>}
        {chat.canFirst && <div className="chat-auto-block">
            <label className="switch"><input type="checkbox" role="switch" checked={chat.firstOn} disabled={busy} onChange={e => void save({ firstOn: e.target.checked })} />{CHAT_AUTO_TEXT.first}</label>
            <textarea className="textarea" rows={3} maxLength={AUTO_REPLY_MAX} value={first} disabled={busy} aria-label={`${CHAT_AUTO_TEXT.first} 문구`}
                onChange={e => setFirst(e.target.value)} onBlur={() => { if (first.trim() && first.trim() !== chat.firstText) void save({ firstText: first }, '저장 완료'); else setFirst(chat.firstText); }} />
            <p className="auto-sub">내 거래중 글에 온 첫 문의에 1번 · 문의한 글의 {TEMPLATE_VARS.join(' ')} 자동 입력</p>
        </div>}
        {chat.canAway && <div className="chat-auto-block">
            <label className="switch"><input type="checkbox" role="switch" checked={chat.awayOn} disabled={busy} onChange={e => void save({ awayOn: e.target.checked })} />{CHAT_AUTO_TEXT.away}</label>
            <div className="away-hours">
                <select className="select" aria-label="자리 비움 시작" value={chat.awayFrom} disabled={busy} onChange={e => void save({ awayFrom: Number(e.target.value), awayTo: chat.awayTo })}>
                    {hours.map(h => <option key={h} value={h} disabled={h === chat.awayTo}>{hourText(h)}</option>)}</select>
                <span aria-hidden="true">~</span>
                <select className="select" aria-label="자리 비움 끝" value={chat.awayTo} disabled={busy} onChange={e => void save({ awayFrom: chat.awayFrom, awayTo: Number(e.target.value) })}>
                    {hours.map(h => <option key={h} value={h} disabled={h === chat.awayFrom}>{hourText(h)}</option>)}</select>
            </div>
            <textarea className="textarea" rows={2} maxLength={AUTO_REPLY_MAX} value={away} disabled={busy} aria-label={`${CHAT_AUTO_TEXT.away} 문구`}
                onChange={e => setAway(e.target.value)} onBlur={() => { if (away.trim() && away.trim() !== chat.awayText) void save({ awayText: away }, '저장 완료'); else setAway(chat.awayText); }} />
            <p className="auto-sub">자리 비움 시간에 온 채팅에 1번 · 채팅 목록 &lsquo;지금 자리 비움&rsquo; 12시간 유지</p>
            {chat.awayUntil && <div className="away-now" role="status">
                <span>{CHAT_AUTO_TEXT.awayUntil(kstClock(chat.awayUntil))}</span>
                <button type="button" className="btn btn-line btn-sm" disabled={busy} onClick={() => void save({ awayNow: false }, '자리 비움 해제')}>해제</button>
            </div>}
        </div>}
    </section>;
}

// The '알림' card (WP54): every saved search with its 알림 switch. 키워드·게시판 알림 are free for every
// grade (SITE_RULES.keywordAlerts); 조건 알림 count against the grade ('조건 알림 3/10').
type SavedAlert = { id: string; name: string; query: string; alert: boolean; keyword: boolean };
type SavedList = { searches: SavedAlert[]; filterAlerts: number | null; keywordAlerts: number };
// bare: inside the 알림 page's '검색 알림' modal (every grade, so a 일반 member sees every saved search with
// its switch too); the modal gives the title.
// auto (the 자동화 tab): the card also holds '자동 매칭' (WP58).
export function AlertCard({ bare = false, auto, setAuto, reload }: { bare?: boolean; auto?: AutoState; setAuto?: (s: AutoState) => void; reload?: () => Promise<unknown> }) {
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
    // A 조건 알림 needs 플러스 (filterAlerts 0): its switch stays off with the reason, not a refused tap.
    const locked = (v: SavedAlert) => !v.keyword && !v.alert && d.filterAlerts === 0;
    const count = d.filterAlerts !== null && (!bare || d.filterAlerts > 0) && <span className="alert-count">{ALERT_TEXT.filterCount(used, d.filterAlerts)}</span>;
    return <section className={bare ? 'auto-card alert-card is-bare' : 'card card-pad auto-card alert-card'} aria-labelledby={bare ? undefined : 'auto-alert-title'} aria-label={bare ? ALERT_TEXT.searches : undefined}>
        {bare ? count && <div className="card-title-row">{count}</div>
            : <div className="card-title-row"><h2 className="card-title" id="auto-alert-title">알림</h2>{count}</div>}
        {d.searches.length ? <ul className="auto-list">{d.searches.map(v => <li key={v.id} className={v.alert ? 'is-on' : ''}>
            <span className="auto-main">
                <button type="button" className="auto-title" onClick={() => void navigate('/trade?' + v.query)}>{v.name}</button>
                <span className="auto-sub">{v.keyword ? (new URLSearchParams(v.query).get('q') ? '키워드 알림' : '게시판 알림') : locked(v) ? ALERT_TEXT.filterLocked : '조건 알림'}</span>
            </span>
            <label className="switch auto-post-switch"><input type="checkbox" role="switch" aria-label={`${v.name} ${ALERT_TEXT.boardBell}`} checked={v.alert} disabled={busy || locked(v)} onChange={e => void toggle(v, e.target.checked)} /></label>
        </li>)}</ul> : <p className="auto-empty">저장한 검색이 없습니다. 게시판에서 검색 조건을 저장하면 여기서 알림을 켤 수 있습니다.</p>}
        {auto && setAuto && reload && <MatchBlock s={auto} setS={setAuto} reload={reload} />}
    </section>;
}
