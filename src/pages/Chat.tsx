import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowLeft, Check, ImagePlus, LoaderCircle, MoreHorizontal, Plus, Send, ThumbsDown, ThumbsUp, UserCog, X } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { toast } from 'sonner';
import {
    KIND_ICONS, REVIEW_CARD_TEXT, REVIEW_DAYS, REVIEW_TAGS, REVIEW_TEXT_MAX, closedLabel, fillTemplate, isTradeKind, quickReplies, statusName, listingPrice, priceText, relativeTime, reviewName, suspendUntilText,
    type Post, type Review, type User,
} from '../../shared/market';
import { APPLICATION_STATUS_NAMES, BADGES, CHAT_AUTO_TEXT, TEMPLATE_MAX, applicationTitle, gradeInfo, perksOf, type Application } from '../../shared/membership';
import { ApiError, api, dragsFiles, errorText, imageFiles, imageUrl, pastesText, uploadPhoto, UPLOAD_BUSY } from '../lib/api';
import { Link, navigate, useLocation } from '../lib/router';
import { lastSeenText } from '../lib/lastSeen';
import { useAdaptivePoll, useApp } from '../app/state';
import { CHAT_DRAFT_EVENT, chatDraftKey } from '../app/ApplyModal';
import { Avatar, CIcon, EmptyState, Modal, NameLine } from '../components/ui';
import { MemberPanel } from '../components/MemberPanel';
import { MemberReportModal } from '../components/MemberReport';
import { CompleteSheet } from '../components/CompleteSheet';
import { ServiceSheet } from '../components/ServiceSheet';
import { RichBody } from '../components/RichBody';

type ChatItem = { id: string; updated_at: number; partner_id: string; nickname: string; role: string; grade: string; grade_trial?: boolean; badges: string[]; last_message: string | null; unread: number; pending_applications: number; last_post_title: string | null; last_post_thumb: string | null };
type Message = { id: number; sender_id: string; body: string; type: string; reference_id: string | null; attachments: string[]; created_at: number; read_at: number | null };
type Offer = { id: string; post_id: number; sender_id: string; amount: number; note: string; status: string; title: string; post_kind: string; post_price: number | null; post_author_id: string; post_status?: string; post_current_offer: number | null };
type Partner = Pick<User, 'id' | 'nickname' | 'role' | 'grade' | 'grade_trial' | 'badges' | 'created_at'> & { deleted?: boolean; last_seen_at?: number | null; suspended?: boolean };
// The post the chat is about, pinned under the room header.
type Listing = { id: number; title: string; kind: string; category?: string; price: number | null; price_mode: string; status: string; closed_at?: number | null; thumb: string | null; author_id: string; currentOffer: number | null; canAsk?: boolean; hidden?: boolean };
type ChatFilter = 'all' | 'applications';
// A trade between the two members (WP23, WP43) with the 후기 each of them left, for the '거래 확인 요청' card.
// author_id asked for it; it is confirmed once the other member answered '확인' (or left their 후기);
// a pending one expires after 7 days; removed by the manager.
type Trade = { id: string; post_id: number; seller_id: string; buyer_id: string; created_at: number; title: string | null; kind: string | null; price: number | null; author_id: string | null; confirmed: number; removed: number; brokered?: number; reviews: Review[] };
const ANSWER_MS = 7 * 86400000;

const POST_MISMATCH = '게시글 작성자를 확인해 주세요.';
const OFFER_STATUS: Record<string, string> = { pending: '대기', accepted: '수락', declined: '거절', withdrawn: '취소', cancelled: '마감' };
// 채팅 자동화 (WP57): GET me/automation/chat. The board chips (quickReplies) are for every grade; own
// quick replies (내 빠른 답장) for 플러스 and up, with {제목} {즉거가} {현젯} filled from the pinned post
// for 프리미엄 and up (vars); awayUntil is '지금 자리 비움' (엘리트 and up).
export type ChatAuto = { templates: string[]; max: number | null; vars: boolean; canFirst: boolean; firstOn: boolean; firstText: string;
    canAway: boolean; awayOn: boolean; awayFrom: number; awayTo: number; awayText: string; awayUntil: number | null };
const REJECT_NOTES = ['입금 확인 안 됨', '자료 부족', '명의 불일치', '거래내역 부족'];
// A phone number (010-1234-5678) or an account-like run of digits in a partner's message gets a
// '더치트 조회' link, the cafes' safety step before sending money. Bank accounts have 10 to 14 digits,
// so a dashed run with fewer (a date such as 2026-10-01, a score) is not one.
const LOOKUP = /01[016789][-\s]?\d{3,4}[-\s]?\d{4}|\d{2,6}-\d{2,6}-\d{2,8}|\d{10,14}/g;
const hasLookup = (text: string) => [...text.matchAll(LOOKUP)].some(([m]) => m.replace(/\D/g, '').length >= 10);
const PHOTOS_PER_MESSAGE = 6;

// 거래 전 확인 (WP51): the safety steps for the post's kind of trade, shown on the client only (no writes)
// at the top of a chat about a post. The 더치트 step is in every set.
const CHEAT_CHECK = '입금 전 더치트로 전번·계좌 조회';
function pretradeItems(l: Pick<Listing, 'kind' | 'category'>): string[] {
    if (l.kind === 'proxy_request' || l.kind === 'proxy_offer') return ['선입금·후입금 먼저 합의', '동접 시 중단', CHEAT_CHECK];
    if (l.category === 'account') return ['이중창 인증', CHEAT_CHECK, '받은 뒤 바로 비번·전번·보멜 변경'];
    if (l.category === 'goods_coupon') return ['쿠폰 코드는 입금 확인 후 전달', CHEAT_CHECK];
    return [CHEAT_CHECK];
}
function Pretrade({ listing }: { listing: Listing }) {
    return <aside className="pretrade" aria-label="거래 전 확인">
        <b className="pretrade-title">거래 전 확인</b>
        <ul>{pretradeItems(listing).map(item => <li key={item}><Check size={14} aria-hidden="true" />{item === CHEAT_CHECK
            ? <a href="https://thecheat.co.kr" target="_blank" rel="noreferrer">{item}</a> : item}</li>)}</ul>
    </aside>;
}

function toListing(p: Post): Listing {
    return { id: p.id, title: p.title, kind: p.kind, category: p.category, price: p.price, price_mode: p.price_mode, status: p.status === 'closed' ? 'closed' : 'open', closed_at: p.closed_at ?? null, thumb: p.images[0] ?? null, author_id: p.author_id, currentOffer: p.details.currentOffer ? Number(p.details.currentOffer) || null : null };
}
// The price as the cards show it: 'MAX 30만원' for a buy post, 즉거가 (and 현젯) for a sale.
function listingLine(l: Listing) {
    const price = listingPrice({ kind: l.kind as Post['kind'], price: l.price, price_mode: l.price_mode });
    return [price, l.kind === 'sell' && l.currentOffer ? '현젯 ' + priceText(l.currentOffer) : '', statusName(l.kind, l.status)].filter(Boolean).join(' · ');
}

// Times are shown in Korean time wherever the browser is.
function timeLabel(t: number) { return new Date(t).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit' }); }
function dayLabel(t: number) { return new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }); }

export default function Chat({ id }: { id?: string }) {
    const { me, ready, requireLogin, refreshUnread, refreshMe } = useApp();
    const [chats, setChats] = useState<ChatItem[] | null>(null), [listError, setListError] = useState<number | null>(null);
    // The manager can narrow the list to chats with a waiting application (신청 대기).
    const [filter, setFilter] = useState<ChatFilter>('all');
    const view = me?.role === 'manager' ? filter : 'all';
    // A failed refresh keeps the list on screen; it never turns into an empty list. After the first
    // load, the list asks only for the chats updated since its last answer (?since=, a minute of overlap
    // for clock drift) and merges them in. The manager's 신청 대기 view always reloads whole, since its
    // rows also leave when an application is handled.
    const since = useRef<number | null>(null);
    const loadChats = useCallback((full = false) => {
        const merge = !full && view === 'all' && since.current !== null;
        const path = view === 'applications' ? 'chats?filter=applications' : merge ? `chats?since=${since.current}` : 'chats';
        api<{ chats: ChatItem[]; at?: number }>(path).then(d => {
            if (view === 'all' && typeof d.at === 'number') since.current = Math.max(0, d.at - 60000);
            setChats(prev => {
                if (!merge || !prev) return d.chats;
                const fresh = new Map(d.chats.map(c => [c.id, c]));
                return [...d.chats, ...prev.filter(c => !fresh.has(c.id))].sort((a, b) => b.updated_at - a.updated_at).slice(0, 100);
            });
            setListError(null);
        }).catch(e => setListError(e instanceof ApiError ? e.status : 0));
    }, [view]);
    useEffect(() => { if (ready && !me) requireLogin(); }, [ready, me, requireLogin]);
    useEffect(() => {
        if (!me) return;
        setChats(null); setListError(null);
        since.current = null;
        loadChats(true);
    }, [me?.id, loadChats]);
    useAdaptivePoll(loadChats, !!me);
    // 채팅 자동화 (WP57): read once per member and grade, for the own chips and '지금 자리 비움'.
    const perks = me ? perksOf(me) : null;
    const wantsAuto = !!perks && (perks.replyTemplates > 0 || perks.awayReply);
    const [auto, setAuto] = useState<ChatAuto | null>(null), [awayBusy, setAwayBusy] = useState(false);
    useEffect(() => {
        setAuto(null);
        if (wantsAuto) api<ChatAuto>('me/automation/chat').then(setAuto).catch(() => {});
    }, [me?.id, me?.grade, wantsAuto]);
    async function awayNow(on: boolean) {
        if (awayBusy) return;
        setAwayBusy(true);
        try { const r = await api<{ chat: ChatAuto }>('me/automation', 'PUT', { awayNow: on }); setAuto(r.chat); toast(on ? '자리 비움 설정 완료' : '자리 비움 해제'); }
        catch (e) { toast.error(errorText(e)); }
        finally { setAwayBusy(false); }
    }
    // The open room marked its messages read: its row shows none at once, then the list catches up.
    const roomActivity = () => {
        if (id) setChats(list => list && list.map(c => c.id === id ? { ...c, unread: 0 } : c));
        loadChats();
        refreshUnread();
    };

    if (!me) return <div className="container page"><EmptyState icon="lock" title="로그인이 필요합니다" action={<button className="btn btn-primary" onClick={() => requireLogin()}>로그인</button>} /></div>;

    // No chats at all: one empty state across the shell and no right pane.
    const empty = view === 'all' && !id && chats !== null && chats.length === 0;
    return <div className="container chat-page">
        <div className={'chat-shell' + (id ? ' has-room' : '') + (empty ? ' is-empty' : '')}>
            <aside className="chat-list" aria-label="채팅 목록">
                <div className="chat-list-head">
                    <div className="chat-list-top">
                        <h1 className="chat-list-title">채팅</h1>
                        {auto?.canAway && me.role !== 'manager' && <label className="switch chat-away"><input type="checkbox" role="switch" checked={!!auto.awayUntil} disabled={awayBusy} onChange={e => void awayNow(e.target.checked)} />{CHAT_AUTO_TEXT.awayNow}</label>}
                    </div>
                    {me.role === 'manager' && <div className="chip-row chat-filter" role="group" aria-label="채팅 목록 보기">
                        {([['all', '전체'], ['applications', '신청 대기']] as const).map(([v, label]) => <button type="button" key={v} className="chip chip-sm" aria-pressed={view === v} onClick={() => setFilter(v)}>{label}</button>)}
                    </div>}
                </div>
                {listError === 401 ? <EmptyState icon="lock" title="로그인이 필요합니다" action={<button type="button" className="btn btn-primary" onClick={() => requireLogin()}>로그인</button>} />
                    : chats === null && listError !== null ? <EmptyState title="채팅을 불러오지 못했습니다" action={<button type="button" className="btn btn-line" onClick={() => { setListError(null); loadChats(true); }}>다시 시도</button>} />
                    : chats === null ? <div className="grid-gap-8" style={{ padding: 16 }}>{[0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: 64 }} />)}</div>
                    : chats.length === 0 ? (view === 'applications' ? <EmptyState title="대기 중인 신청이 없습니다" /> : <EmptyState icon="message" title="채팅 내역이 없습니다" />)
                    : <ul>{chats.map(c => <li key={c.id}><Link to={'/chat/' + c.id} className={'chat-item' + (c.id === id ? ' is-active' : '')} aria-current={c.id === id ? 'page' : undefined}>
                        <Avatar name={c.nickname} />
                        {/* Time top-right and the unread count bottom-right of the text column; the post's photo sits outside it. */}
                        <span className="chat-item-main">
                            <span className="chat-item-top"><NameLine nickname={c.nickname} grade={c.grade} trial={c.grade_trial} role={c.role} badges={c.badges} compact /><time className="chat-item-time">{relativeTime(c.updated_at)}</time></span>
                            {c.last_post_title && <span className="chat-item-post">{c.last_post_title}</span>}
                            <span className="chat-item-last">{c.pending_applications > 0 && me.role === 'manager' && <b className="app-flag">신청 {c.pending_applications}</b>}<span className="chat-item-text">{c.last_message || '새 채팅'}</span>{c.unread > 0 && <b className="unread">{c.unread > 99 ? '99+' : c.unread}</b>}</span>
                        </span>
                        {c.last_post_thumb && <img className="chat-item-thumb" src={imageUrl(c.last_post_thumb)} alt="" loading="lazy" />}
                    </Link></li>)}</ul>}
            </aside>
            {id ? <Room key={id} id={id} me={me} auto={auto} setAuto={setAuto} onActivity={roomActivity} onGrant={() => void refreshMe().catch(() => {})} />
                : !empty && <section className="chat-room chat-empty"><p className="chat-pick">채팅방을 선택하세요</p></section>}
        </div>
    </div>;
}

function Room({ id, me, auto, setAuto, onActivity, onGrant }: { id: string; me: User; auto: ChatAuto | null; setAuto: (a: ChatAuto) => void; onActivity: () => void; onGrant: () => void }) {
    // The parent passes new callbacks on every render; keeping them in refs lets the room
    // load once per chat instead of restarting whenever the chat list refreshes.
    const activity = useRef(onActivity), grant = useRef(onGrant);
    activity.current = onActivity; grant.current = onGrant;
    const [panelVersion, setPanelVersion] = useState(0), [appBusy, setAppBusy] = useState('');
    const appStatus = useRef(new Map<string, string>());
    const [partner, setPartner] = useState<Partner | null>(null), [blocked, setBlocked] = useState(false), [error, setError] = useState('');
    const [messages, setMessages] = useState<Message[]>([]), [offers, setOffers] = useState<Offer[]>([]), [apps, setApps] = useState<Application[]>([]), [trades, setTrades] = useState<Trade[]>([]);
    // The 완료 sheet from the pinned bar, with this chat's partner preselected (WP43).
    const [tradeSheet, setTradeSheet] = useState(false);
    // 중개 신청 (WP65) from the header menu, with this chat's post and partner filled in.
    const [brokerSheet, setBrokerSheet] = useState(false);
    const [readThrough, setReadThrough] = useState(0), [loaded, setLoaded] = useState(false), [hasMore, setHasMore] = useState(false);
    const [text, setText] = useState(''), [photos, setPhotos] = useState<string[]>([]), [sending, setSending] = useState(false), [uploading, setUploading] = useState(false);
    const [savingTemplate, setSavingTemplate] = useState(false);
    const [panel, setPanel] = useState(false), [listing, setListing] = useState<Listing | null>(null), [statusBusy, setStatusBusy] = useState(false), [reporting, setReporting] = useState(false);
    // After the manager decides an application here: the next chat with a waiting one (null: none left).
    const [decided, setDecided] = useState(''), [nextApp, setNextApp] = useState<string | null | undefined>(undefined);
    // Opened from a post's 채팅하기 (/chat/:id?post=N): the first message carries that post, so the
    // server puts its card right before it. The param is then dropped from the address.
    const { params } = useLocation();
    const aboutPost = useRef(params.get('post'));
    // '채팅 보내기' from a 자동 매칭 (WP58, /chat/:id?post=N&match=1): the post is the member's own, sent as a
    // match with the first message (엘리트 and up, 20 a day).
    const matchSend = useRef(params.get('match') === '1');
    const scroller = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), stick = useRef(true), last = useRef(0), idle = useRef(0), fileInput = useRef<HTMLInputElement>(null), input = useRef<HTMLTextAreaElement>(null);
    // The application template ApplyModal left for this room goes into the composer once.
    const takeDraft = () => {
        try { const draft = sessionStorage.getItem(chatDraftKey(id)); if (draft) { setText(draft); sessionStorage.removeItem(chatDraftKey(id)); setTimeout(() => input.current?.focus(), 50); } } catch { /* ignore */ }
    };

    const merge = (incoming: Message[]) => setMessages(prev => {
        const map = new Map(prev.map(m => [m.id, m]));
        for (const m of incoming) map.set(m.id, m);
        return [...map.values()].sort((a, b) => a.id - b.id);
    });

    // The pinned bar follows the post: it is read again when a 제시 changes state, when a post card,
    // 제시 or system line arrives (수락, 완료, 마감), and once a minute while the room is open,
    // so a status set on the post page or by the other member shows up too.
    const offerState = useRef(''), listingAt = useRef(0);
    const refreshListing = useCallback(() => {
        listingAt.current = Date.now();
        return api<{ chat: { partner: Partner; blocked: boolean; listing: Listing | null } }>('chats/' + id).then(d => {
            setPartner(d.chat.partner); setBlocked(d.chat.blocked);
            // Before the first message the bar shows the post from 채팅하기, which the chat does not know yet.
            if (d.chat.listing || !aboutPost.current) setListing(d.chat.listing);
        }).catch(() => {});
    }, [id]);

    const markRead = useCallback((list: Message[]) => {
        const lastIncoming = [...list].reverse().find(m => m.sender_id !== me.id && !m.read_at);
        if (lastIncoming) api(`chats/${id}/read`, 'POST', { lastId: lastIncoming.id }).then(() => activity.current()).catch(() => {});
    }, [id, me.id]);

    // The trades for the review cards come with the first load, with a poll that brings a card or a
    // system line, and when asked (`withTrades`, after this member writes a 후기); other polls leave them.
    const poll = useCallback(async (initial = false, withTrades = false) => {
        const d = await api<{ messages: Message[]; offers: Offer[]; applications: Application[]; trades?: Trade[]; readThrough: number; blocked: boolean; hasMore: boolean }>(`chats/${id}/messages` + (initial ? '' : `?after=${last.current}` + (withTrades ? '&trades=1' : '')));
        if (initial) setHasMore(d.hasMore);
        if (d.messages.length) { merge(d.messages); last.current = Math.max(last.current, ...d.messages.map(m => m.id)); idle.current = 0; markRead(d.messages); }
        else idle.current++;
        setOffers(d.offers); setApps(d.applications); setReadThrough(d.readThrough); setBlocked(d.blocked);
        if (d.trades) setTrades(d.trades);
        const offerKey = d.offers.map(o => o.id + ':' + o.status).join(',');
        if (!initial && (offerKey !== offerState.current || d.messages.some(m => m.type === 'listing' || m.type === 'offer' || m.type === 'system') || Date.now() - listingAt.current > 60000)) void refreshListing();
        offerState.current = offerKey;
        // When an application is decided, the member's badges and the manager's panel update right away.
        let decided = false;
        for (const a of d.applications) {
            const before = appStatus.current.get(a.id);
            if (before && before !== a.status) decided = true;
            appStatus.current.set(a.id, a.status);
        }
        if (decided) { setPanelVersion(v => v + 1); grant.current(); }
        return d.messages.length;
    }, [id, markRead, refreshListing]);

    useEffect(() => {
        let alive = true;
        listingAt.current = Date.now();
        api<{ chat: { partner: Partner; blocked: boolean; listing: Listing | null } }>('chats/' + id).then(d => {
            if (!alive) return;
            setPartner(d.chat.partner); setBlocked(d.chat.blocked); setListing(d.chat.listing);
            // A chat opened from 채팅하기 has no post card until the first message: the bar shows that post meanwhile.
            const about = aboutPost.current;
            if (!d.chat.listing && about && /^\d+$/.test(about)) api<{ post: Post }>('posts/' + about).then(r => { if (alive) setListing(toListing(r.post)); }).catch(() => {});
        }).catch(e => { if (alive) setError(errorText(e)); });
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

    // Stays at the newest message while the reader is at the bottom: after new messages, when a photo
    // finishes loading, and whenever the content or the visible area changes size (composer, keyboard).
    const toBottom = useCallback(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, []);
    useLayoutEffect(toBottom, [messages, loaded, toBottom]);
    useEffect(() => {
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(toBottom);
        if (content.current) ro.observe(content.current);
        if (scroller.current) ro.observe(scroller.current);
        return () => ro.disconnect();
    }, [toBottom]);

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
            await api(`chats/${id}/messages`, 'POST', { body: text, images: photos, postId, ...postId !== undefined && matchSend.current ? { match: true } : {} });
            if (postId !== undefined) forgetPost();
            setText(''); setPhotos([]); stick.current = true;
            await poll(); activity.current();
        } catch (err) {
            // A post that is gone (or not the partner's) must not block the chat: the next try goes
            // without it. Other errors, such as a message that is too long, keep the post for the retry.
            // A match send over the day's limit (429) or without the grade (403) goes on as a plain chat.
            if (postId !== undefined && err instanceof ApiError && (err.status === 404 || err.message === POST_MISMATCH || (matchSend.current && (err.status === 429 || err.status === 403)))) forgetPost();
            toast.error(errorText(err));
        }
        finally { setSending(false); input.current?.focus(); }
    }
    // The post goes with one message only; the address loses the param too.
    function forgetPost() {
        aboutPost.current = null;
        matchSend.current = false;
        const url = new URL(location.href);
        if (url.searchParams.has('post') || url.searchParams.has('match')) {
            url.searchParams.delete('post');
            url.searchParams.delete('match');
            history.replaceState(history.state, '', url.pathname + url.search + url.hash);
        }
    }
    function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); void send(); }
    }
    // Photos from the picker, a paste or a drop; at most 6 per message, one batch at a time.
    async function attach(files: File[]) {
        if (!files.length) return;
        if (uploading) { toast.error(UPLOAD_BUSY); return; }
        const list = files.slice(0, Math.max(0, PHOTOS_PER_MESSAGE - photos.length));
        if (files.length > list.length) toast.error(`사진은 한 번에 ${PHOTOS_PER_MESSAGE}장까지입니다.`);
        if (!list.length) { if (fileInput.current) fileInput.current.value = ''; return; }
        setUploading(true);
        try { for (const f of list) { const up = await uploadPhoto(f); setPhotos(p => [...p, up]); } }
        catch (err) { toast.error(errorText(err)); }
        finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
    }
    // A member under 이용 정지 writes only to the manager; elsewhere the composer says until when.
    const suspended = !!me.suspended_until && me.suspended_until > Date.now();
    const suspendedUntil = suspended && partner && partner.role !== 'manager' ? me.suspended_until! : null;
    // A pasted screenshot or a photo dropped on the room goes up like one picked from the album; text
    // copied with a picture of it (Excel, Word) stays text in the message field.
    const closed = blocked || !!partner?.deleted || !!suspendedUntil;
    function onPaste(e: ClipboardEvent<HTMLFormElement>) {
        const files = imageFiles(e.clipboardData.files);
        if (!files.length || closed || pastesText(e.target, e.clipboardData)) return;
        e.preventDefault();
        void attach(files);
    }
    function onDragOver(e: DragEvent<HTMLElement>) { if (dragsFiles(e.dataTransfer.types)) e.preventDefault(); }
    function onDrop(e: DragEvent<HTMLElement>) {
        if (!dragsFiles(e.dataTransfer.types)) return;
        // Even a refused drop must not open the file in place of the app.
        e.preventDefault();
        if (!closed) void attach(imageFiles(e.dataTransfer.files));
    }
    async function offerAction(offer: Offer, action: string) {
        try { await api('offers/' + offer.id, 'PATCH', { action }); toast(action === 'accepted' ? '수락 완료' : action === 'declined' ? '거절 완료' : action === 'released' ? '수락 취소 완료' : '제시 취소 완료'); await poll(); activity.current(); }
        catch (err) { toast.error(errorText(err)); }
    }
    async function appAction(app: Application, action: 'approve' | 'reject' | 'cancel', note = '') {
        if (appBusy) return;
        setAppBusy(app.id);
        try {
            await api('applications/' + app.id, 'PATCH', { action, note }); toast(action === 'approve' ? '지급 완료' : action === 'reject' ? '반려 완료' : '신청 취소 완료'); await poll(); activity.current();
            // The manager goes on to the next chat with a waiting application.
            if (action !== 'cancel' && me.role === 'manager') {
                setDecided(app.id); setNextApp(undefined);
                api<{ chats: ChatItem[] }>('chats?filter=applications').then(d => setNextApp(d.chats.find(c => c.id !== id)?.id ?? null)).catch(() => setNextApp(null));
            }
        }
        catch (err) { toast.error(errorText(err)); }
        finally { setAppBusy(''); }
    }
    // The pinned bar (WP43): the author completes an open post with one button (the 완료 sheet, this
    // chat's partner preselected); within 7 days of 완료 either member of the chat can ask for the trade
    // record while the post has none; an accepted 제시 in this chat can be released ('수락 취소').
    async function askRecord() {
        if (!listing || statusBusy) return;
        setStatusBusy(true);
        try { await api(`posts/${listing.id}/trade`, 'POST', {}); toast('요청 완료'); stick.current = true; await poll(false, true); activity.current(); }
        catch (err) { toast.error(errorText(err)); }
        finally { setStatusBusy(false); }
    }
    async function release(offer: Offer) {
        if (statusBusy) return;
        setStatusBusy(true);
        try { await api('offers/' + offer.id, 'PATCH', { action: 'released' }); toast('수락 취소 완료'); await poll(); activity.current(); }
        catch (err) { toast.error(errorText(err)); }
        finally { setStatusBusy(false); }
    }
    // A received 제시 below the 즉거가 can become the post's 현젯.
    async function markOffer(offer: Offer) {
        try {
            await api(`posts/${offer.post_id}/price`, 'PATCH', { currentOffer: offer.amount });
            toast('현젯 변경 완료');
            setListing(l => l && l.id === offer.post_id ? { ...l, currentOffer: offer.amount } : l);
            setOffers(list => list.map(o => o.post_id === offer.post_id ? { ...o, post_current_offer: offer.amount } : o));
        } catch (err) { toast.error(errorText(err)); }
    }
    async function toggleBlock() {
        if (!partner) return;
        try { await api('blocks', 'POST', { userId: partner.id, active: !blocked }); setBlocked(!blocked); toast(blocked ? '차단 해제' : '차단 완료'); }
        catch (err) { toast.error(errorText(err)); }
    }

    if (error) return <section className="chat-room"><EmptyState title="채팅방을 열 수 없습니다" text={error} action={<Link className="btn btn-line" to="/chat">채팅 목록</Link>} /></section>;

    const managerView = me.role === 'manager' && partner && partner.role !== 'manager';
    let prevDay = '';
    const lastMine = [...messages].reverse().find(m => m.sender_id === me.id);
    const ownListing = !!listing && listing.author_id === me.id;
    // Quick replies: any trade chat before my first text message (never in an application chat or a
    // chat with the manager that is not about a post), hidden as soon as the composer has text.
    // On a completed post only the author of a sale keeps '판완됐습니다'; the 'still selling' chips go.
    const usable = loaded && !apps.length && !blocked && !partner?.deleted && !suspendedUntil;
    const replies = quickReplies(listing, ownListing);
    const quick = usable && !text && (!!listing || (me.role !== 'manager' && partner?.role !== 'manager'))
        && !messages.some(m => m.sender_id === me.id && m.type === 'text') ? replies : [];
    // 내 빠른 답장 (WP57): first in the row whenever the composer is empty; with text in it, a '+' chip
    // saves that text as one more (while under the grade's count and not saved already).
    const own = usable && !text && auto ? auto.templates : [];
    const trimmed = text.trim();
    const canSave = usable && !!auto && auto.max !== 0 && !!trimmed && trimmed.length <= TEMPLATE_MAX && !auto.templates.includes(trimmed) && (auto.max === null || auto.templates.length < auto.max);
    const applyTemplate = (t: string) => {
        const filled = auto?.vars ? fillTemplate(t, listing && { title: listing.title, kind: listing.kind, price: listing.price, currentOffer: listing.currentOffer }) : t;
        setText(filled ?? t); input.current?.focus();
    };
    async function saveTemplate() {
        if (!auto || !canSave || savingTemplate) return;
        setSavingTemplate(true);
        try { const r = await api<{ chat: ChatAuto }>('me/automation', 'PUT', { templates: [...auto.templates, trimmed] }); setAuto(r.chat); toast('저장 완료'); }
        catch (err) { toast.error(errorText(err)); }
        finally { setSavingTemplate(false); input.current?.focus(); }
    }
    const listingIcon = listing && isTradeKind(listing.kind) ? KIND_ICONS[listing.kind] : 'money-bag';
    const nowMs = Date.now();
    const listingOpen = !!listing && listing.status !== 'closed';
    // The trade record this chat holds for the post, when one is confirmed, removed or still waiting.
    const liveTrade = !!listing && trades.some(t => t.post_id === listing.id && (!!t.confirmed || !!t.removed || t.created_at > nowMs - ANSWER_MS));
    // canAsk (from the server): not hidden and under the post's 3 requests, so the button never only fails.
    const recordable = !!listing && !listingOpen && !liveTrade && !suspended && !blocked && !partner?.deleted && listing.canAsk !== false
        && (listing.closed_at ?? 0) > nowMs - ANSWER_MS && (ownListing || partner?.id === listing.author_id);
    // A member who answered '거래 아님' in this chat gets the request as a line button, not the main action.
    const deniedByMe = messages.some(m => m.sender_id === me.id && m.type === 'system' && m.body === '거래 아님');
    const acceptedHere = listing && listingOpen ? offers.find(o => o.post_id === listing.id && o.status === 'accepted') : undefined;
    // 중개 신청: an open post of one of the two members, while the chat is usable (the manager performs it).
    const canBroker = !!listing && listingOpen && !listing.hidden && !!partner && me.role !== 'manager' && partner.role !== 'manager' && !partner.deleted && !blocked && !suspended
        && (ownListing || partner.id === listing.author_id);

    return <section className={'chat-room' + (managerView ? ' with-panel' : '')} aria-label="대화">
        <div className="room-main" onDragOver={onDragOver} onDrop={onDrop}>
            <header className="room-head">
                <Link to="/chat" className="icon-btn room-back" aria-label="채팅 목록"><ArrowLeft size={22} /></Link>
                {partner?.deleted ? <span className="room-who"><Avatar name={partner.nickname} size="sm" /><span>{partner.nickname}</span></span>
                    : partner ? <Link to={'/profile/' + partner.id} className="room-who"><Avatar name={partner.nickname} size="sm" /><span className="room-who-text">
                        <NameLine nickname={partner.nickname} grade={partner.grade} trial={partner.grade_trial} role={partner.role} badges={partner.badges} compact />
                        {partner.last_seen_at && <span className="room-seen">{lastSeenText(partner.last_seen_at)}</span>}
                    </span></Link> : <span className="grow" />}
                <span className="grow" />
                {managerView && <button type="button" className="btn btn-line btn-sm room-panel-btn" onClick={() => setPanel(true)}><UserCog size={16} />회원 관리</button>}
                {/* 신고 (members only; the manager has 회원 관리) and 차단. */}
                {partner && partner.role !== 'manager' && (me.role !== 'manager' || !partner.deleted) && <DropdownMenu.Root modal={false}>
                    <DropdownMenu.Trigger className="icon-btn" aria-label="더보기"><MoreHorizontal size={22} /></DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                        <DropdownMenu.Content className="menu" align="end" sideOffset={6}>
                            {canBroker && <DropdownMenu.Item className="menu-item" onSelect={() => setBrokerSheet(true)}>중개 신청</DropdownMenu.Item>}
                            {me.role !== 'manager' && <DropdownMenu.Item className="menu-item" onSelect={() => setReporting(true)}>신고</DropdownMenu.Item>}
                            {!partner.deleted && <DropdownMenu.Item className="menu-item" onSelect={() => void toggleBlock()}>{blocked ? '차단 해제' : '차단'}</DropdownMenu.Item>}
                        </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                </DropdownMenu.Root>}
            </header>
            {partner?.suspended && <p className="room-notice">이용 제한 회원입니다.</p>}
            {listing && <div className="room-listing">
                <Link to={'/posts/' + listing.id} className="room-listing-thumb" tabIndex={-1} aria-hidden="true">{listing.thumb ? <img src={imageUrl(listing.thumb)} alt="" /> : <CIcon name={listingIcon} size={24} />}</Link>
                <span className="room-listing-main">
                    <Link to={'/posts/' + listing.id} className="room-listing-title">{listing.title}</Link>
                    <span className="room-listing-meta">{listingLine(listing)}</span>
                </span>
                <span className="room-listing-actions" role="group" aria-label="거래 상태">
                    {acceptedHere && <button type="button" className="btn btn-line btn-sm" disabled={statusBusy} onClick={() => void release(acceptedHere)}>수락 취소</button>}
                    {ownListing && listingOpen ? <button type="button" className="btn btn-primary btn-sm" disabled={statusBusy} onClick={() => setTradeSheet(true)}>{closedLabel(listing.kind)}</button>
                        : recordable ? <button type="button" className={'btn btn-sm ' + (deniedByMe ? 'btn-line' : 'btn-primary')} disabled={statusBusy} onClick={() => ownListing ? setTradeSheet(true) : void askRecord()}>거래 기록 요청</button>
                        : !ownListing && !acceptedHere && <Link to={'/posts/' + listing.id} className="btn btn-line btn-sm">글 보기</Link>}
                </span>
            </div>}
            <div className="room-scroll" ref={scroller} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
                <div ref={content}>
                {/* Scrolls with the messages, above the ones loaded. */}
                {/* Pre-trade advice only while the post is in progress; after 완료 it would be stale. */}
                {listing && loaded && listing.status !== 'closed' && <Pretrade listing={listing} />}
                {hasMore && <button type="button" className="btn btn-soft btn-xs older" onClick={loadOlder}>이전 대화 보기</button>}
                {!loaded ? <div className="room-loading"><LoaderCircle className="spin" /></div> : messages.map(m => {
                    const day = dayLabel(m.created_at), showDay = day !== prevDay; prevDay = day;
                    const mine = m.sender_id === me.id;
                    // Not on the manager's own lines (the account for a grade deposit is the site's).
                    const lookup = !mine && m.type === 'text' && partner?.role !== 'manager' && hasLookup(m.body);
                    return <div key={m.id}>
                        {showDay && <div className="day-sep"><span>{day}</span></div>}
                        {m.type === 'system' ? <div className="sys-msg">{m.body}</div>
                            : m.type === 'listing' ? <ListingCard postId={Number(m.reference_id)} title={m.body} />
                            : m.type === 'application' ? <AppCard app={apps.find(a => a.id === m.reference_id)} fallback={m.body} me={me} partner={partner} mine={mine} at={m.created_at} busy={appBusy === m.reference_id} onAction={appAction} next={decided && decided === m.reference_id ? nextApp : undefined} />
                            : m.type === 'offer' ? <OfferCard offer={offers.find(o => o.id === m.reference_id)} me={me} onAction={offerAction} onMark={markOffer} />
                            : m.type === 'review' ? <ReviewCard trade={trades.find(t => t.id === m.reference_id)} me={me} gone={!!partner?.deleted} asked={m.sender_id === me.id}
                                denied={messages.some(x => x.id > m.id && x.type === 'system' && x.body === '거래 아님' && x.sender_id !== m.sender_id)} onReport={() => setReporting(true)} onSaved={() => { void poll(false, true); activity.current(); }} />
                            : <div className={'bubble-row' + (mine ? ' mine' : '') + (m.type === 'auto' ? ' is-auto' : '')}>
                                <div className="bubble-col">
                                    {m.type === 'auto' && <span className="bubble-auto">{CHAT_AUTO_TEXT.label}</span>}
                                    {m.attachments.length > 0 && <div className={'bubble-photos n' + Math.min(m.attachments.length, 3)}>{m.attachments.map(a => <a key={a} href={imageUrl(a)} target="_blank" rel="noreferrer"><img src={imageUrl(a)} alt="보낸 사진" loading="lazy" onLoad={toBottom} /></a>)}</div>}
                                    {m.body && <p className="bubble"><RichBody text={m.body} /></p>}
                                </div>
                                <span className="bubble-meta">{mine && m.id === lastMine?.id && readThrough >= m.id && <span className="read">읽음</span>}{timeLabel(m.created_at)}</span>
                            </div>}
                        {/* Under the bubble row, so the time stays beside the bubble. */}
                        {lookup && <a className="lookup-link" href="https://thecheat.co.kr" target="_blank" rel="noreferrer">더치트 조회</a>}
                    </div>;
                })}
                </div>
            </div>
            <form className="composer" onSubmit={send} onPaste={onPaste}>
                {partner?.deleted ? <p className="muted small composer-blocked">탈퇴한 회원입니다.</p>
                    : blocked ? <p className="muted small composer-blocked">차단된 채팅방입니다.</p>
                    : suspendedUntil ? <p className="muted small composer-blocked">이용 정지 중입니다. ({suspendUntilText(suspendedUntil)})</p> : <>
                    {(own.length > 0 || quick.length > 0 || canSave) && <div className="chip-scroll quick-replies" role="group" aria-label="빠른 답장">
                        {own.map(q => <button type="button" key={'own:' + q} className="chip chip-sm chip-own" title={q} onClick={() => applyTemplate(q)}>{q}</button>)}
                        {quick.filter(q => !own.includes(q)).map(q => <button type="button" key={q} className="chip chip-sm" onClick={() => { setText(q); input.current?.focus(); }}>{q}</button>)}
                        {canSave && <button type="button" className="chip chip-sm chip-add" aria-label="빠른 답장 저장" disabled={savingTemplate} onClick={() => void saveTemplate()}><Plus size={14} aria-hidden="true" />빠른 답장</button>}
                    </div>}
                    {photos.length > 0 && <div className="composer-photos">{photos.map(p => <span key={p}><img src={imageUrl(p)} alt="" /><button type="button" aria-label="사진 빼기" onClick={() => setPhotos(photos.filter(x => x !== p))}><X size={12} /></button></span>)}</div>}
                    <div className="composer-row">
                        <input ref={fileInput} type="file" hidden multiple accept="image/jpeg,image/png,image/webp" onChange={e => void attach(Array.from(e.target.files || []))} />
                        <button type="button" className="icon-btn" aria-label="사진 보내기" disabled={uploading || photos.length >= PHOTOS_PER_MESSAGE} onClick={() => fileInput.current?.click()}>{uploading ? <LoaderCircle size={20} className="spin" /> : <ImagePlus size={22} />}</button>
                        <textarea ref={input} rows={Math.min(6, Math.max(1, text.split('\n').length))} value={text} maxLength={2000} onChange={e => setText(e.target.value)} onKeyDown={onKey} placeholder="메시지 입력" aria-label="메시지" />
                        <button type="submit" className="send-btn" aria-label="보내기" disabled={sending || uploading || (!text.trim() && !photos.length)}>{sending ? <LoaderCircle size={20} className="spin" /> : <Send size={20} />}</button>
                    </div>
                </>}
            </form>
        </div>
        {canBroker && listing && partner && <ServiceSheet open={brokerSheet} onClose={() => setBrokerSheet(false)} kind="broker" post={listing} partner={partner} />}
        {partner && me.role !== 'manager' && <MemberReportModal open={reporting} onClose={() => setReporting(false)} userId={partner.id} nickname={partner.nickname} conversationId={id} />}
        <CompleteSheet post={tradeSheet && listing ? { id: listing.id, kind: listing.kind, title: listing.title, price: listing.price, price_mode: listing.price_mode, status: listing.status, thumb: listing.thumb, hidden: listing.hidden } : null} preselect={partner?.id} suspended={suspended}
            onClose={() => setTradeSheet(false)} onDone={() => { stick.current = true; void refreshListing(); void poll(false, true).then(() => activity.current()); }} />
        {managerView && partner && <>
            <aside className="room-panel"><MemberPanel inChat userId={partner.id} version={panelVersion} onChange={() => void poll()} /></aside>
            <Modal open={panel} onClose={() => setPanel(false)} title="회원 관리"><MemberPanel inChat userId={partner.id} version={panelVersion} onChange={() => void poll()} /></Modal>
        </>}
    </section>;
}

function ListingCard({ postId, title }: { postId: number; title: string }) {
    return <Link to={'/posts/' + postId} className="event-card listing-card"><CIcon name="money-bag" size={28} /><span className="grow"><span className="muted small">문의한 글</span><strong>{title}</strong></span></Link>;
}

function OfferCard({ offer, me, onAction, onMark }: { offer?: Offer; me: User; onAction: (o: Offer, a: string) => void; onMark: (o: Offer) => void }) {
    if (!offer) return <div className="sys-msg">가격 제시</div>;
    const received = offer.sender_id !== me.id;
    // The seller can show a waiting or accepted 제시 below the 즉거가 as the post's 현젯, unless it already is
    // or the post is completed (a completed post's price no longer changes).
    // Each poll brings the post's own 현젯 with its 제시, so this holds when the bar shows another post too.
    const markable = received && offer.post_author_id === me.id && offer.post_kind === 'sell' && offer.post_status !== 'closed' && offer.post_price !== null && offer.amount < offer.post_price
        && (offer.status === 'pending' || offer.status === 'accepted') && offer.post_current_offer !== offer.amount;
    return <div className="event-card">
        <span className="muted small">{received ? '받은 제시' : '보낸 제시'} · <Link to={'/posts/' + offer.post_id}>{offer.title}</Link></span>
        <strong className="event-amount">{priceText(offer.amount)}</strong>
        {offer.note && <p className="small">{offer.note}</p>}
        <span className="event-status">{OFFER_STATUS[offer.status] || offer.status}</span>
        {offer.status === 'pending' && <div className="row mt-8">
            {received ? <><button type="button" className="btn btn-primary btn-sm grow" onClick={() => onAction(offer, 'accepted')}>수락</button><button type="button" className="btn btn-line btn-sm grow" onClick={() => onAction(offer, 'declined')}>거절</button></>
                : <button type="button" className="btn btn-line btn-sm grow" onClick={() => onAction(offer, 'withdrawn')}>제시 취소</button>}
        </div>}
        {markable && <button type="button" className="btn btn-line btn-sm" onClick={() => onMark(offer)}>현젯으로 표시</button>}
    </div>;
}

const DAY = 86400000;

const kstDay = (t: number) => new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

// The '거래 확인 요청' card (WP43, design 'trade confirm card'). While pending, the member who did not ask
// sees '거래 확인' with the post, the closed label and 거래가, and answers '확인' or '거래 아님'; the
// requester sees '확인 대기 · 10월 8일까지' or '확인 기간 지남', and after a '거래 아님' a '신고' link.
// Once confirmed it is the '거래 후기 남기기' card (WP23): 좋아요 or 아쉬워요, that side's tags and one line,
// one 후기 each within 30 days; afterwards it shows what they wrote, or that the manager removed it.
function ReviewCard({ trade, me, gone, asked, denied, onReport, onSaved }: { trade?: Trade; me: User; gone: boolean; asked: boolean; denied: boolean; onReport: () => void; onSaved: () => void }) {
    const [good, setGood] = useState<boolean | null>(null), [tags, setTags] = useState<string[]>([]), [text, setText] = useState(''), [busy, setBusy] = useState(false);
    // The row is gone: answered '거래 아님', or replaced after it expired.
    if (!trade) return denied ? <div className="event-card review-card">
        <strong>거래 확인</strong>
        <p className="small muted">거래 아님</p>
        {asked && !gone && <button type="button" className="btn btn-text btn-xs review-report" onClick={onReport}>신고</button>}
    </div> : <div className="sys-msg">거래 확인 요청</div>;
    const mine = trade.reviews.find(r => r.author_id === me.id);
    const party = trade.seller_id === me.id || trade.buyer_id === me.id;
    const now = Date.now();
    const ended = now > trade.created_at + REVIEW_DAYS * DAY;
    const pending = !trade.confirmed && !trade.removed, expired = pending && now > trade.created_at + ANSWER_MS;
    const requester = trade.author_id === me.id;
    const info = `‘${trade.title || '삭제된 글'}’ ${closedLabel(trade.kind || '')}${trade.price !== null ? ` · 거래가 ${priceText(trade.price)}` : ''}`;
    const choose = (value: boolean) => { if (value !== good) { setGood(value); setTags([]); } };
    const toggle = (tag: string) => setTags(list => list.includes(tag) ? list.filter(t => t !== tag) : [...list, tag]);
    async function answer(confirm: boolean) {
        if (busy || !trade) return;
        setBusy(true);
        try { await api(`trades/${trade.id}/answer`, 'POST', { confirm }); toast(confirm ? '확인 완료' : '응답 완료'); onSaved(); }
        catch (err) { toast.error(errorText(err)); onSaved(); }
        finally { setBusy(false); }
    }
    async function submit(e: FormEvent) {
        e.preventDefault();
        if (busy || good === null || !trade) return;
        setBusy(true);
        try { await api(`trades/${trade.id}/review`, 'POST', { good, tags, text }); toast('후기 등록 완료'); onSaved(); }
        catch (err) { toast.error(errorText(err)); onSaved(); }
        finally { setBusy(false); }
    }
    const note = (line: string) => <p className="small muted">{line}</p>;
    const titleLine = <span className="muted small">{trade.title ? <Link to={'/posts/' + trade.post_id}>{info}</Link> : info}{!!trade.brokered && <> <span className="tag tag-line">운영진 중개</span></>}</span>;
    if (pending) return <div className="event-card review-card trade-confirm">
        <strong>거래 확인</strong>
        {titleLine}
        {!party ? null : gone ? note('탈퇴한 회원입니다.') : expired ? note('확인 기간 지남')
            : requester ? note(`확인 대기 · ${kstDay(trade.created_at + ANSWER_MS)}까지`)
            : <>
                <p className="small">확인하면 두 회원의 거래 기록에 남습니다. 받을 것을 모두 받은 뒤 확인해 주세요.</p>
                <div className="trade-confirm-actions">
                    <button type="button" className="btn btn-line btn-sm" disabled={busy} onClick={() => void answer(false)}>거래 아님</button>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void answer(true)}>확인</button>
                </div>
            </>}
    </div>;
    return <div className="event-card review-card">
        {titleLine}
        <strong>{mine && !trade.removed ? '내 후기' : REVIEW_CARD_TEXT}</strong>
        {trade.removed ? note('삭제된 거래입니다.')
            : mine ? (mine.removed ? note('삭제된 후기입니다.') : <>
                <span className="review-verdict">{mine.good ? <ThumbsUp size={16} /> : <ThumbsDown size={16} />}{reviewName(mine.good)}</span>
                {mine.tags.length > 0 && <span className="tags">{mine.tags.map(t => <span key={t} className="tag">{t}</span>)}</span>}
                {mine.text && <p className="small">{mine.text}</p>}
            </>)
            : !party ? null : gone ? note('탈퇴한 회원입니다.') : ended ? note('후기 기간이 끝났습니다.')
            : <form className="review-form" onSubmit={submit}>
                <div className="review-pick" role="group" aria-label="후기">
                    <button type="button" className="chip" aria-pressed={good === true} onClick={() => choose(true)}><ThumbsUp size={16} />좋아요</button>
                    <button type="button" className="chip" aria-pressed={good === false} onClick={() => choose(false)}><ThumbsDown size={16} />아쉬워요</button>
                </div>
                {good !== null && <div className="chip-row" role="group" aria-label="후기 항목">{REVIEW_TAGS[good ? 'good' : 'bad'].map(t =>
                    <button type="button" key={t} className="chip chip-sm" aria-pressed={tags.includes(t)} onClick={() => toggle(t)}>{t}</button>)}</div>}
                <input className="input" value={text} onChange={e => setText(e.target.value)} maxLength={REVIEW_TEXT_MAX} placeholder="예: 쿨거 감사합니다" aria-label="후기 한 줄" />
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy || good === null}>등록</button>
            </form>}
    </div>;
}

function AppCard({ app, fallback, me, partner, mine, at, busy, onAction, next }: { app?: Application; fallback: string; me: User; partner: Partner | null; mine: boolean; at: number; busy: boolean; onAction: (a: Application, action: 'approve' | 'reject' | 'cancel', note?: string) => void; next?: string | null }) {
    const [note, setNote] = useState(''), [rejecting, setRejecting] = useState(false);
    if (!app) return <div className="sys-msg">{fallback}</div>;
    const manager = me.role === 'manager';
    return <div className="event-card app-card">
        <div className="row"><CIcon name={app.kind === 'badge' ? BADGES.find(b => b.id === app.target)?.icon || 'identification-card' : gradeInfo(app.target).icon} size={28} /><span className="grow"><span className="muted small app-card-who">{mine ? '내 신청' : <>신청자 {partner ? <NameLine nickname={partner.nickname} grade={partner.grade} trial={partner.grade_trial} role={partner.role} badges={partner.badges} /> : app.nickname || '회원'}</>}<span className="nowrap">{'\u00a0'}· {timeLabel(at)}</span></span><strong>{applicationTitle(app)}</strong></span><span className={'event-status st-' + app.status}>{APPLICATION_STATUS_NAMES[app.status]}</span></div>
        {app.status === 'pending' && !manager && <p className="small muted">필요 자료를 이 채팅으로 보내 주세요.</p>}
        {app.status === 'pending' && (manager ? (rejecting ? <div className="grid-gap-8 mt-8">
            <div className="chip-row" role="group" aria-label="반려 사유 선택">{REJECT_NOTES.map(n => <button type="button" key={n} className="chip chip-sm" aria-pressed={note === n} onClick={() => setNote(n)}>{n}</button>)}</div>
            <input className="input" value={note} onChange={e => setNote(e.target.value)} maxLength={300} placeholder="반려 사유" aria-label="반려 사유" autoFocus />
            <div className="row"><button type="button" className="btn btn-dark btn-sm grow" disabled={busy} onClick={() => onAction(app, 'reject', note)}>반려</button><button type="button" className="btn btn-line btn-sm" onClick={() => setRejecting(false)}>취소</button></div>
        </div> : <div className="row mt-8"><button type="button" className="btn btn-primary btn-sm grow" disabled={busy} onClick={() => onAction(app, 'approve')}>{busy ? <LoaderCircle size={16} className="spin" /> : '승인'}</button><button type="button" className="btn btn-line btn-sm grow" disabled={busy} onClick={() => setRejecting(true)}>반려</button></div>)
            : mine && <button type="button" className="btn btn-text small mt-8" disabled={busy} onClick={() => onAction(app, 'cancel')}>신청 취소</button>)}
        {manager && app.status !== 'pending' && next !== undefined && (next ? <button type="button" className="btn btn-line btn-sm mt-8" onClick={() => void navigate('/chat/' + next)}>다음 신청</button>
            : <p className="small muted mt-8">대기 중인 신청 없음</p>)}
    </div>;
}
