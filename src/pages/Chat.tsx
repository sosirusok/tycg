import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowLeft, Ban, ImagePlus, LoaderCircle, Send, UserCog, X } from 'lucide-react';
import { toast } from 'sonner';
import { priceText, relativeTime, type User } from '../../shared/market';
import { APPLICATION_STATUS_NAMES, applicationTitle, type Application } from '../../shared/membership';
import { ApiError, api, errorText, imageUrl, uploadPhoto } from '../lib/api';
import { Link, useLocation } from '../lib/router';
import { useApp } from '../app/state';
import { CHAT_DRAFT_EVENT, chatDraftKey } from '../app/ApplyModal';
import { Avatar, CIcon, EmptyState, Modal, NameLine } from '../components/ui';
import { MemberPanel } from '../components/MemberPanel';

type ChatItem = { id: string; updated_at: number; partner_id: string; nickname: string; role: string; grade: string; badges: string[]; last_message: string | null; unread: number; pending_applications: number };
type Message = { id: number; sender_id: string; body: string; type: string; reference_id: string | null; attachments: string[]; created_at: number; read_at: number | null };
type Offer = { id: string; post_id: number; sender_id: string; amount: number; note: string; status: string; title: string };
type Partner = Pick<User, 'id' | 'nickname' | 'role' | 'grade' | 'badges' | 'created_at'>;

const OFFER_STATUS: Record<string, string> = { pending: '대기', accepted: '수락', declined: '거절', withdrawn: '취소', cancelled: '마감' };

// Times are shown in Korean time wherever the browser is.
function timeLabel(t: number) { return new Date(t).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit' }); }
function dayLabel(t: number) { return new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }); }

export default function Chat({ id }: { id?: string }) {
    const { me, ready, requireLogin, refreshUnread, refreshMe } = useApp();
    const [chats, setChats] = useState<ChatItem[] | null>(null);
    const loadChats = useCallback(() => { api<{ chats: ChatItem[] }>('chats').then(d => setChats(d.chats)).catch(() => setChats([])); }, []);
    useEffect(() => { if (ready && !me) requireLogin(); }, [ready, me, requireLogin]);
    useEffect(() => {
        if (!me) return;
        loadChats();
        const t = setInterval(() => { if (!document.hidden) loadChats(); }, 20000);
        return () => clearInterval(t);
    }, [me?.id, loadChats]);

    if (!me) return <div className="container page"><EmptyState icon="key" title="로그인이 필요합니다" action={<button className="btn btn-primary" onClick={() => requireLogin()}>로그인</button>} /></div>;

    return <div className="container chat-page">
        <div className={'chat-shell' + (id ? ' has-room' : '')}>
            <aside className="chat-list" aria-label="채팅 목록">
                <h1 className="chat-list-title">채팅</h1>
                {chats === null ? <div className="grid-gap-8" style={{ padding: 16 }}>{[0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: 64 }} />)}</div>
                    : chats.length === 0 ? <EmptyState title="채팅 내역이 없습니다" />
                    : <ul>{chats.map(c => <li key={c.id}><Link to={'/chat/' + c.id} className={'chat-item' + (c.id === id ? ' is-active' : '')} aria-current={c.id === id ? 'page' : undefined}>
                        <Avatar name={c.nickname} />
                        <span className="chat-item-main">
                            <span className="chat-item-top"><NameLine nickname={c.nickname} grade={c.grade} role={c.role} badges={c.badges} /><time className="muted small nowrap">{relativeTime(c.updated_at)}</time></span>
                            <span className="chat-item-last">{c.pending_applications > 0 && me.role === 'manager' && <b className="app-flag">신청 {c.pending_applications}</b>}<span className="chat-item-text">{c.last_message || '새 채팅'}</span></span>
                        </span>
                        {c.unread > 0 && <b className="unread">{c.unread > 99 ? '99+' : c.unread}</b>}
                    </Link></li>)}</ul>}
            </aside>
            {id ? <Room key={id} id={id} me={me} onActivity={() => { loadChats(); refreshUnread(); }} onGrant={() => void refreshMe().catch(() => {})} />
                : <section className="chat-room chat-empty"><EmptyState title="채팅방을 선택하세요" /></section>}
        </div>
    </div>;
}

function Room({ id, me, onActivity, onGrant }: { id: string; me: User; onActivity: () => void; onGrant: () => void }) {
    // The parent passes new callbacks on every render; keeping them in refs lets the room
    // load once per chat instead of restarting whenever the chat list refreshes.
    const activity = useRef(onActivity), grant = useRef(onGrant);
    activity.current = onActivity; grant.current = onGrant;
    const [panelVersion, setPanelVersion] = useState(0), [appBusy, setAppBusy] = useState('');
    const appStatus = useRef(new Map<string, string>());
    const [partner, setPartner] = useState<Partner | null>(null), [blocked, setBlocked] = useState(false), [error, setError] = useState('');
    const [messages, setMessages] = useState<Message[]>([]), [offers, setOffers] = useState<Offer[]>([]), [apps, setApps] = useState<Application[]>([]);
    const [readThrough, setReadThrough] = useState(0), [loaded, setLoaded] = useState(false), [hasMore, setHasMore] = useState(false);
    const [text, setText] = useState(''), [photos, setPhotos] = useState<string[]>([]), [sending, setSending] = useState(false), [uploading, setUploading] = useState(false);
    const [panel, setPanel] = useState(false);
    // Opened from a post's 채팅하기 (/chat/:id?post=N): the first message carries that post, so the
    // server puts its card right before it. The param is then dropped from the address.
    const { params } = useLocation();
    const aboutPost = useRef(params.get('post'));
    const scroller = useRef<HTMLDivElement>(null), stick = useRef(true), last = useRef(0), idle = useRef(0), fileInput = useRef<HTMLInputElement>(null), input = useRef<HTMLTextAreaElement>(null);
    // The application template ApplyModal left for this room goes into the composer once.
    const takeDraft = () => {
        try { const draft = sessionStorage.getItem(chatDraftKey(id)); if (draft) { setText(draft); sessionStorage.removeItem(chatDraftKey(id)); setTimeout(() => input.current?.focus(), 50); } } catch { /* ignore */ }
    };

    const merge = (incoming: Message[]) => setMessages(prev => {
        const map = new Map(prev.map(m => [m.id, m]));
        for (const m of incoming) map.set(m.id, m);
        return [...map.values()].sort((a, b) => a.id - b.id);
    });

    const markRead = useCallback((list: Message[]) => {
        const lastIncoming = [...list].reverse().find(m => m.sender_id !== me.id && !m.read_at);
        if (lastIncoming) api(`chats/${id}/read`, 'POST', { lastId: lastIncoming.id }).then(() => activity.current()).catch(() => {});
    }, [id, me.id]);

    const poll = useCallback(async (initial = false) => {
        const d = await api<{ messages: Message[]; offers: Offer[]; applications: Application[]; readThrough: number; blocked: boolean; hasMore: boolean }>(`chats/${id}/messages` + (initial ? '' : `?after=${last.current}`));
        if (initial) setHasMore(d.hasMore);
        if (d.messages.length) { merge(d.messages); last.current = Math.max(last.current, ...d.messages.map(m => m.id)); idle.current = 0; markRead(d.messages); }
        else idle.current++;
        setOffers(d.offers); setApps(d.applications); setReadThrough(d.readThrough); setBlocked(d.blocked);
        // When an application is decided, the member's badges and the manager's panel update right away.
        let decided = false;
        for (const a of d.applications) {
            const before = appStatus.current.get(a.id);
            if (before && before !== a.status) decided = true;
            appStatus.current.set(a.id, a.status);
        }
        if (decided) { setPanelVersion(v => v + 1); grant.current(); }
        return d.messages.length;
    }, [id, markRead]);

    useEffect(() => {
        let alive = true;
        api<{ chat: { partner: Partner; blocked: boolean } }>('chats/' + id).then(d => { if (alive) { setPartner(d.chat.partner); setBlocked(d.chat.blocked); } }).catch(e => { if (alive) setError(errorText(e)); });
        poll(true).then(() => { if (alive) setLoaded(true); }).catch(e => { if (alive) setError(errorText(e)); });
        takeDraft();
        // New messages: every 4 s while active, slowing to 15 s after a quiet minute.
        let timer: ReturnType<typeof setTimeout>;
        const tick = () => { timer = setTimeout(async () => { if (!document.hidden) await poll().catch(() => {}); if (alive) tick(); }, idle.current > 15 ? 15000 : 4000); };
        tick();
        return () => { alive = false; clearTimeout(timer); };
    }, [id, poll]);

    // An application sent while this room is already open (same route, no remount) fills the composer
    // too, and its card is fetched right away instead of on the next poll.
    useEffect(() => {
        const onDraft = (e: Event) => { if ((e as CustomEvent<string>).detail === id) { takeDraft(); void poll().catch(() => {}); } };
        window.addEventListener(CHAT_DRAFT_EVENT, onDraft);
        return () => window.removeEventListener(CHAT_DRAFT_EVENT, onDraft);
    }, [id, poll]);

    useLayoutEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [messages, loaded]);

    async function loadOlder() {
        const first = messages[0]?.id;
        if (!first) return;
        const el = scroller.current, before = el?.scrollHeight || 0;
        const d = await api<{ messages: Message[]; hasMore: boolean }>(`chats/${id}/messages?before=${first}`);
        stick.current = false;
        merge(d.messages); setHasMore(d.hasMore);
        requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - before; });
    }

    async function send(e?: FormEvent) {
        e?.preventDefault();
        if (sending || uploading || (!text.trim() && !photos.length)) return;
        setSending(true);
        const postId = aboutPost.current && /^\d+$/.test(aboutPost.current) ? Number(aboutPost.current) : undefined;
        try {
            await api(`chats/${id}/messages`, 'POST', { body: text, images: photos, postId });
            if (postId !== undefined) forgetPost();
            setText(''); setPhotos([]); stick.current = true;
            await poll(); activity.current();
        } catch (err) {
            // A post that is gone must not block the chat: the next try goes without it.
            if (postId !== undefined && err instanceof ApiError && (err.status === 400 || err.status === 404)) forgetPost();
            toast.error(errorText(err));
        }
        finally { setSending(false); input.current?.focus(); }
    }
    // The post goes with one message only; the address loses the param too.
    function forgetPost() {
        aboutPost.current = null;
        const url = new URL(location.href);
        if (url.searchParams.has('post')) { url.searchParams.delete('post'); history.replaceState(history.state, '', url.pathname + url.search + url.hash); }
    }
    function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); void send(); }
    }
    async function attach(files: FileList | null) {
        if (!files?.length) return;
        const list = Array.from(files).slice(0, 6 - photos.length);
        setUploading(true);
        try { for (const f of list) { const up = await uploadPhoto(f); setPhotos(p => [...p, up]); } }
        catch (err) { toast.error(errorText(err)); }
        finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
    }
    async function offerAction(offer: Offer, action: string) {
        try { await api('offers/' + offer.id, 'PATCH', { action }); toast(action === 'accepted' ? '수락 완료. 글이 예약중으로 바뀌었습니다.' : action === 'declined' ? '거절 완료' : '제시 취소 완료'); await poll(); }
        catch (err) { toast.error(errorText(err)); }
    }
    async function appAction(app: Application, action: 'approve' | 'reject' | 'cancel', note = '') {
        if (appBusy) return;
        setAppBusy(app.id);
        try { await api('applications/' + app.id, 'PATCH', { action, note }); toast(action === 'approve' ? '지급 완료' : action === 'reject' ? '반려 완료' : '신청 취소 완료'); await poll(); activity.current(); }
        catch (err) { toast.error(errorText(err)); }
        finally { setAppBusy(''); }
    }
    async function toggleBlock() {
        if (!partner) return;
        try { await api('blocks', 'POST', { userId: partner.id, active: !blocked }); setBlocked(!blocked); toast(blocked ? '차단 해제' : '차단 완료'); }
        catch (err) { toast.error(errorText(err)); }
    }

    if (error) return <section className="chat-room"><EmptyState icon="warning" title="채팅방을 열 수 없습니다" text={error} action={<Link className="btn btn-line" to="/chat">채팅 목록</Link>} /></section>;

    const managerView = me.role === 'manager' && partner && partner.role !== 'manager';
    let prevDay = '';
    const lastMine = [...messages].reverse().find(m => m.sender_id === me.id);

    return <section className={'chat-room' + (managerView ? ' with-panel' : '')} aria-label="대화">
        <div className="room-main">
            <header className="room-head">
                <Link to="/chat" className="icon-btn room-back" aria-label="채팅 목록"><ArrowLeft size={22} /></Link>
                {partner ? <Link to={'/profile/' + partner.id} className="room-who"><Avatar name={partner.nickname} size="sm" /><NameLine nickname={partner.nickname} grade={partner.grade} role={partner.role} badges={partner.badges} /></Link> : <span className="grow" />}
                <span className="grow" />
                {managerView && <button type="button" className="btn btn-line btn-sm room-panel-btn" onClick={() => setPanel(true)}><UserCog size={16} />회원 관리</button>}
                {partner && partner.role !== 'manager' && <button type="button" className="icon-btn" aria-label={blocked ? '차단 해제' : '차단'} title={blocked ? '차단 해제' : '차단'} onClick={toggleBlock}><Ban size={19} /></button>}
            </header>
            <div className="room-scroll" ref={scroller} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
                {hasMore && <button type="button" className="btn btn-soft btn-xs older" onClick={loadOlder}>이전 대화 보기</button>}
                {!loaded ? <div className="room-loading"><LoaderCircle className="spin" /></div> : messages.map(m => {
                    const day = dayLabel(m.created_at), showDay = day !== prevDay; prevDay = day;
                    const mine = m.sender_id === me.id;
                    return <div key={m.id}>
                        {showDay && <div className="day-sep"><span>{day}</span></div>}
                        {m.type === 'system' ? <div className="sys-msg">{m.body}</div>
                            : m.type === 'listing' ? <ListingCard postId={Number(m.reference_id)} title={m.body} />
                            : m.type === 'application' ? <AppCard app={apps.find(a => a.id === m.reference_id)} fallback={m.body} me={me} partner={partner} mine={mine} at={m.created_at} busy={appBusy === m.reference_id} onAction={appAction} />
                            : m.type === 'offer' ? <OfferCard offer={offers.find(o => o.id === m.reference_id)} me={me} onAction={offerAction} />
                            : <div className={'bubble-row' + (mine ? ' mine' : '')}>
                                <div className="bubble-col">
                                    {m.attachments.length > 0 && <div className={'bubble-photos n' + Math.min(m.attachments.length, 3)}>{m.attachments.map(a => <a key={a} href={imageUrl(a)} target="_blank" rel="noreferrer"><img src={imageUrl(a)} alt="보낸 사진" loading="lazy" /></a>)}</div>}
                                    {m.body && <p className="bubble">{m.body}</p>}
                                </div>
                                <span className="bubble-meta">{mine && m.id === lastMine?.id && readThrough >= m.id && <span className="read">읽음</span>}{timeLabel(m.created_at)}</span>
                            </div>}
                    </div>;
                })}
            </div>
            <form className="composer" onSubmit={send}>
                {blocked ? <p className="muted small composer-blocked">차단된 채팅방입니다.</p> : <>
                    {photos.length > 0 && <div className="composer-photos">{photos.map(p => <span key={p}><img src={imageUrl(p)} alt="" /><button type="button" aria-label="사진 빼기" onClick={() => setPhotos(photos.filter(x => x !== p))}><X size={12} /></button></span>)}</div>}
                    <div className="composer-row">
                        <input ref={fileInput} type="file" hidden multiple accept="image/jpeg,image/png,image/webp" onChange={e => attach(e.target.files)} />
                        <button type="button" className="icon-btn" aria-label="사진 보내기" disabled={uploading || photos.length >= 6} onClick={() => fileInput.current?.click()}>{uploading ? <LoaderCircle size={20} className="spin" /> : <ImagePlus size={22} />}</button>
                        <textarea ref={input} rows={Math.min(6, Math.max(1, text.split('\n').length))} value={text} maxLength={2000} onChange={e => setText(e.target.value)} onKeyDown={onKey} placeholder="메시지 입력" aria-label="메시지" />
                        <button type="submit" className="send-btn" aria-label="보내기" disabled={sending || uploading || (!text.trim() && !photos.length)}>{sending ? <LoaderCircle size={20} className="spin" /> : <Send size={20} />}</button>
                    </div>
                </>}
            </form>
        </div>
        {managerView && partner && <>
            <aside className="room-panel"><MemberPanel inChat userId={partner.id} version={panelVersion} onChange={() => void poll()} /></aside>
            <Modal open={panel} onClose={() => setPanel(false)} title="회원 관리"><MemberPanel inChat userId={partner.id} version={panelVersion} onChange={() => void poll()} /></Modal>
        </>}
    </section>;
}

function ListingCard({ postId, title }: { postId: number; title: string }) {
    return <Link to={'/posts/' + postId} className="event-card listing-card"><CIcon name="money-bag" size={28} /><span className="grow"><span className="muted small">문의한 글</span><strong>{title}</strong></span></Link>;
}

function OfferCard({ offer, me, onAction }: { offer?: Offer; me: User; onAction: (o: Offer, a: string) => void }) {
    if (!offer) return <div className="sys-msg">가격 제시</div>;
    const received = offer.sender_id !== me.id;
    return <div className="event-card">
        <span className="muted small">{received ? '받은 제시' : '보낸 제시'} · <Link to={'/posts/' + offer.post_id}>{offer.title}</Link></span>
        <strong className="event-amount">{priceText(offer.amount)}</strong>
        {offer.note && <p className="small">{offer.note}</p>}
        <span className="event-status">{OFFER_STATUS[offer.status] || offer.status}</span>
        {offer.status === 'pending' && <div className="row mt-8">
            {received ? <><button type="button" className="btn btn-primary btn-sm grow" onClick={() => onAction(offer, 'accepted')}>수락</button><button type="button" className="btn btn-line btn-sm grow" onClick={() => onAction(offer, 'declined')}>거절</button></>
                : <button type="button" className="btn btn-line btn-sm grow" onClick={() => onAction(offer, 'withdrawn')}>제시 취소</button>}
        </div>}
    </div>;
}

function AppCard({ app, fallback, me, partner, mine, at, busy, onAction }: { app?: Application; fallback: string; me: User; partner: Partner | null; mine: boolean; at: number; busy: boolean; onAction: (a: Application, action: 'approve' | 'reject' | 'cancel', note?: string) => void }) {
    const [note, setNote] = useState(''), [rejecting, setRejecting] = useState(false);
    if (!app) return <div className="sys-msg">{fallback}</div>;
    const manager = me.role === 'manager';
    return <div className="event-card app-card">
        <div className="row"><CIcon name={app.kind === 'badge' ? 'check-mark-button' : 'crown'} size={28} /><span className="grow"><span className="muted small app-card-who">{mine ? '내 신청' : <>신청자 {partner ? <NameLine nickname={partner.nickname} grade={partner.grade} role={partner.role} badges={partner.badges} /> : app.nickname || '회원'}</>}<span className="nowrap">{'\u00a0'}· {timeLabel(at)}</span></span><strong>{applicationTitle(app)}</strong></span><span className={'event-status st-' + app.status}>{APPLICATION_STATUS_NAMES[app.status]}</span></div>
        {app.status === 'pending' && !manager && <p className="small muted">필요 자료를 이 채팅으로 보내 주세요.</p>}
        {app.status === 'pending' && (manager ? (rejecting ? <div className="grid-gap-8 mt-8">
            <input className="input" value={note} onChange={e => setNote(e.target.value)} maxLength={300} placeholder="반려 사유" aria-label="반려 사유" autoFocus />
            <div className="row"><button type="button" className="btn btn-dark btn-sm grow" disabled={busy} onClick={() => onAction(app, 'reject', note)}>반려</button><button type="button" className="btn btn-line btn-sm" onClick={() => setRejecting(false)}>취소</button></div>
        </div> : <div className="row mt-8"><button type="button" className="btn btn-primary btn-sm grow" disabled={busy} onClick={() => onAction(app, 'approve')}>{busy ? <LoaderCircle size={16} className="spin" /> : '승인'}</button><button type="button" className="btn btn-line btn-sm grow" disabled={busy} onClick={() => setRejecting(true)}>반려</button></div>)
            : mine && <button type="button" className="btn btn-text small mt-8" disabled={busy} onClick={() => onAction(app, 'cancel')}>신청 취소</button>)}
    </div>;
}
