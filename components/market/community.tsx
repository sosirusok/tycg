'use client';
import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, ArrowUpRight, MessageCircle, Send, ChevronRight, Bookmark, Trash2, Shield, Check, LoaderCircle, ArrowLeftRight, EyeOff, ImageIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { type User, type Post, priceText, relativeTime } from '@/lib/market';
import { api, errorMessage, useMarket, Loading, LoginGate, EmptyState, Avatar, Role, PolicyNote } from './shared';
import { ListingRows } from './board';
const offerNames: Record<string, string> = { pending: '답변 대기', accepted: '수락됨', declined: '거절됨', withdrawn: '철회됨', cancelled: '거래 상태 변경으로 종료' };
export function OfferCard({ o, changed }: {
    o: any;
    changed: () => void;
}) { const { me, go } = useMarket(), [busy, setBusy] = useState(false); async function action(a: string) { setBusy(true); try {
    await api('offers/' + o.id, 'PATCH', { action: a });
    changed();
    toast.success(a === 'accepted' ? '제안을 수락했습니다. 채팅에서 상세 조건을 확인하세요.' : '제안을 처리했습니다.');
}
catch (e) {
    toast.error(errorMessage(e));
}
finally {
    setBusy(false);
} } return <div className="offer-card"><span><ArrowLeftRight size={14}/>가격 제안 <b className={o.status}>{offerNames[o.status]}</b></span><button className="offer-title" onClick={() => go('/posts/' + o.post_id)}>{o.title}</button><strong>{priceText(o.amount)}</strong>{o.note && <p>{o.note}</p>}{o.status === 'pending' && <div className="offer-actions">{me?.id === o.recipient_id ? <><button disabled={busy} className="primary" onClick={() => action('accepted')}>수락</button><button disabled={busy} className="secondary" onClick={() => action('declined')}>거절</button></> : <button disabled={busy} className="secondary" onClick={() => action('withdrawn')}>제안 철회</button>}</div>}{o.status === 'accepted' && <small>조건 협의 중입니다. 결제 또는 거래 완료를 의미하지 않습니다.</small>}</div>; }
export function Chat({ id }: {
    id?: string;
}) {
    const { me, go, refresh } = useMarket(), [rooms, setRooms] = useState<any[]>([]), [messages, setMessages] = useState<any[]>([]), [offers, setOffers] = useState<any[]>([]), [draft, setDraft] = useState(''), [error, setError] = useState(''), [blocked, setBlocked] = useState(false), [sending, setSending] = useState(false), [more, setMore] = useState(false), [loading, setLoading] = useState(true), [olderBusy, setOlderBusy] = useState(false), [tick, setTick] = useState(0);
    const last = useRef(0), read = useRef(0), bottom = useRef<HTMLDivElement>(null), lock = useRef(false), olderLock = useRef(false);
    const room = rooms.find(c => c.id === id);
    useEffect(() => { if (!me)
        return; let active = true, running = false; async function poll() { if (running || document.hidden)
        return; running = true; try {
        const [r, m] = await Promise.all([api('chats'), id ? api('chats/' + id + '/messages' + (last.current ? '?after=' + last.current : '')) : Promise.resolve(null)]);
        if (!active)
            return;
        setRooms(r.chats);
        setLoading(false);
        setError('');
        if (m) {
            setBlocked(m.blocked);
            setOffers(m.offers);
            setMessages(prev => { const all = new Map(prev.map(v => [v.id, v])); m.messages.forEach((v: any) => all.set(v.id, v)); return [...all.values()].sort((a, b) => a.id - b.id).map(v => v.sender_id === me!.id && v.id <= m.readThrough ? { ...v, read_at: 1 } : v); });
            if (!last.current)
                setMore(m.hasMore);
            const n = m.messages.at(-1)?.id || 0;
            if (n > last.current) {
                last.current = n;
                setTimeout(() => bottom.current?.scrollIntoView({ block: 'nearest' }), 70);
            }
            if (last.current > read.current) {
                const cursor = last.current;
                await api('chats/' + id + '/read', 'POST', { lastId: cursor });
                read.current = cursor;
                refresh();
            }
        }
    }
    catch (e) {
        if (active) {
            setError(errorMessage(e));
            setLoading(false);
        }
    }
    finally {
        running = false;
    } } poll(); const t = setInterval(poll, 2500); return () => { active = false; clearInterval(t); }; }, [id, me?.id, tick, refresh]);
    async function send(e: React.FormEvent) { e.preventDefault(); if (!draft.trim() || !id || lock.current)
        return; lock.current = true; setSending(true); const sent = draft; try {
        await api('chats/' + id + '/messages', 'POST', { body: sent });
        setDraft(current => current === sent ? '' : current);
        setTick(n => n + 1);
    }
    catch (e) {
        toast.error(errorMessage(e));
    }
    finally {
        lock.current = false;
        setSending(false);
    } }
    async function older() { if (olderLock.current)
        return; olderLock.current = true; setOlderBusy(true); try {
        const d = await api('chats/' + id + '/messages?before=' + messages[0]?.id);
        setMessages(m => [...new Map([...d.messages, ...m].map(v => [v.id, v])).values()].sort((a, b) => a.id - b.id));
        setMore(d.hasMore);
    }
    catch (e) {
        toast.error(errorMessage(e));
    }
    finally {
        olderLock.current = false;
        setOlderBusy(false);
    } }
    if (!me)
        return <LoginGate />;
    return <><div className="page-title"><div><div className="breadcrumb">나의 거래</div><h2>내 채팅</h2><p>거래 조건과 가격 제안을 한 대화에서 확인하세요.</p></div><span className="private-label"><Shield size={14}/>참여 회원만 열람</span></div><div className={'chat-layout ' + (id ? 'has-room' : '')}><section className="chat-list"><h3>대화 목록 <span>{rooms.length}</span></h3>{rooms.map(c => <button key={c.id} className={id === c.id ? 'active' : ''} onClick={() => go('/chat/' + c.id)}><Avatar name={c.nickname}/><div><strong>{c.nickname}</strong><p>{c.last_message || '대화를 시작해 보세요'}</p></div><span>{relativeTime(c.updated_at)}{c.unread > 0 && <b className="unread-badge">{c.unread}</b>}</span></button>)}{!rooms.length && !loading && <p className="chat-list-empty">아직 대화가 없습니다.<br />거래 글에서 문의를 시작하세요.</p>}</section><section className="chat-conversation">{id ? <><header><button className="mobile-chat-back icon-button" aria-label="대화 목록" onClick={() => go('/chat')}><ArrowLeft size={18}/></button><Avatar name={room?.nickname || '회'}/><button onClick={() => room && go('/profile/' + room.partner_id)}><strong>{room?.nickname || '대화 불러오는 중'}</strong><Role role={room?.role || 'member'}/></button><button className="subtle chat-profile" onClick={() => room && go('/profile/' + room.partner_id)}>프로필<ChevronRight size={13}/></button></header><div className="messages" aria-live="polite">{more && <button className="load-older" disabled={olderBusy} onClick={older}>이전 메시지 보기</button>}{messages.map((m, i) => <div key={m.id} className="message-group">{(i === 0 || new Date(m.created_at).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) !== new Date(messages[i - 1].created_at).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })) && <div className="chat-date">{new Date(m.created_at).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}</div>}<div className={'message ' + (m.sender_id === me.id ? 'mine' : '')}><div className={'message-bubble ' + (m.type !== 'text' ? 'structured-message' : '')}>{m.type === 'offer' ? (offers.find(o => o.id === m.reference_id) ? <OfferCard o={offers.find(o => o.id === m.reference_id)} changed={() => setTick(n => n + 1)}/> : <p>삭제된 게시글의 가격 제안입니다.</p>) : m.type === 'listing' ? <button className="chat-listing" onClick={() => go('/posts/' + m.reference_id)}><span>문의한 거래 글</span><strong>{m.body}</strong><small>게시글 보기 </small></button> : m.body}</div><div className="message-time">{m.sender_id === me.id && !m.read_at && <b>1</b>}{new Date(m.created_at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' })}</div></div></div>)}{!messages.length && !loading && <p className="conversation-start">거래 가능 여부나 궁금한 점을 물어보세요.</p>}<div ref={bottom}/></div>{error && <p className="chat-error">{error}</p>}{blocked ? <div className="chat-error">차단된 회원과는 메시지를 주고받을 수 없습니다.</div> : <><div className="quick-replies">{['아직 거래 가능한가요?', '추가 사진을 볼 수 있을까요?', '거래 가능한 시간을 알려주세요.'].map(v => <button key={v} onClick={() => setDraft(v)}>{v}</button>)}</div><form onSubmit={send} className="message-form"><textarea aria-label="메시지" rows={2} placeholder="메시지 입력 (Enter 전송 / Shift+Enter 줄바꿈)" maxLength={2000} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        send(e);
    } }}/><button className="primary" aria-label="메시지 전송" disabled={!draft.trim() || sending}>{sending ? <LoaderCircle size={18} className="spin"/> : <Send size={19}/>}</button></form></>}</> : <div className="chat-welcome"><MessageCircle size={43}/><h3>대화를 선택해 주세요</h3><p>거래 문의와 가격 제안을 이곳에서 이어가세요.</p>{error && <p className="error-text">{error}</p>}</div>}</section></div></>;
}
export function Profile({ id }: {
    id: string;
}) {
    const { me, go, chat, setMe, login } = useMarket(), [u, setU] = useState<User | null>(null), [posts, setPosts] = useState<Post[]>([]), [total, setTotal] = useState(0), [page, setPage] = useState(1), [error, setError] = useState(''), [edit, setEdit] = useState(false), [nick, setNick] = useState(''), [bio, setBio] = useState(''), [blocked, setBlocked] = useState(false), [busy, setBusy] = useState(false), [tick, setTick] = useState(0);
    const own = me?.id === id;
    useEffect(() => { Promise.all([api('users/' + id), api('posts?author=' + encodeURIComponent(id) + '&page=' + page)]).then(([d, p]) => { setU(d.user); setNick(d.user.nickname); setBio(d.user.bio); setPosts(p.posts); setTotal(p.total); }).catch(e => setError(errorMessage(e))); if (me)
        api('blocks').then(d => setBlocked(d.blocks.some((b: any) => b.target_id === id))).catch(() => { }); }, [id, page, me?.id, tick]);
    async function save(e: React.FormEvent) { e.preventDefault(); setBusy(true); try {
        await api('users/' + id, 'PUT', { nickname: nick, bio });
        const d = await api('auth/me');
        setMe(d.user);
        setU(d.user);
        setEdit(false);
        toast.success('프로필을 수정했습니다.');
    }
    catch (e) {
        toast.error(errorMessage(e));
    }
    finally {
        setBusy(false);
    } }
    async function block() { if (!me) {
        login();
        return;
    } try {
        await api('blocks', 'POST', { userId: id, active: !blocked });
        setBlocked(!blocked);
        toast.success(blocked ? '차단을 해제했습니다.' : '회원의 채팅과 가격 제안을 차단했습니다.');
    }
    catch (e) {
        toast.error(errorMessage(e));
    } }
    if (error)
        return <EmptyState title="프로필을 찾을 수 없습니다" description={error}/>;
    if (!u)
        return <Loading />;
    return <><div className="page-title"><div><div className="breadcrumb">회원 프로필</div><h2>{own ? '내 프로필' : u.nickname + '님의 프로필'}</h2></div></div><section className="member-profile"><Avatar name={u.nickname} size="large"/><div><h3>{u.nickname}<Role role={u.role}/></h3><p>{u.bio || '등록된 자기소개가 없습니다.'}</p><span>{new Date(u.created_at).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })} 가입 <b>작성 글 {total}개</b></span></div><div className="profile-buttons">{own ? <button className="secondary" onClick={() => setEdit(true)}>프로필 수정</button> : <><button className="primary" disabled={blocked} onClick={() => chat(id)}>1대1 채팅</button><button className="subtle" onClick={block}>{blocked ? '차단 해제' : '회원 차단'}</button></>}</div></section><h3 className="section-title">작성한 거래 글 <span>{total}</span></h3>{posts.length ? <ListingRows posts={posts} onFavorite={() => setTick(n => n + 1)}/> : <EmptyState title="작성한 거래 글이 없습니다" description="등록한 거래 글이 여기에 표시됩니다."/>}{total > 16 && <div className="simple-pagination"><button className="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>이전</button><span>{page} / {Math.ceil(total / 16)}</span><button className="secondary" disabled={page * 16 >= total} onClick={() => setPage(page + 1)}>다음</button></div>}<Dialog open={edit} onOpenChange={setEdit}><DialogContent><DialogTitle>프로필 수정</DialogTitle><DialogDescription>거래 상대방에게 보여줄 정보를 적어주세요.</DialogDescription><form className="form-stack" onSubmit={save}><label>닉네임<input required minLength={2} maxLength={16} readOnly={me?.role === 'manager'} value={nick} onChange={e => setNick(e.target.value)}/></label><label>자기소개<textarea maxLength={300} rows={4} value={bio} onChange={e => setBio(e.target.value)}/></label><button className="primary" disabled={busy}>저장</button></form></DialogContent></Dialog></>;
}
const activityTabs = [['posts', '내가 쓴 글'], ['favorites', '찜한 글'], ['offers', '가격 제안'], ['recent', '최근 본 글'], ['searches', '저장한 검색'], ['blocks', '차단 관리'], ['uploads', '사진 정리']];
export function Activity({ tab }: {
    tab: string;
}) {
    const { me, go } = useMarket(), [data, setData] = useState<any>(null), [error, setError] = useState(''), [tick, setTick] = useState(0), [page, setPage] = useState(1), [offerTab, setOfferTab] = useState('received');
    useEffect(() => { if (!me)
        return; setData(null); setError(''); let endpoint = tab === 'posts' ? 'posts?author=' + me.id + '&page=' + page : tab === 'favorites' || tab === 'recent' ? 'posts?scope=' + tab + '&page=' + page : tab; api(endpoint).then(setData).catch(e => setError(errorMessage(e))); }, [me?.id, tab, tick, page]);
    if (!me)
        return <LoginGate />;
    const reload = () => setTick(n => n + 1);
    return <><div className="page-title"><div><div className="breadcrumb">나의 거래</div><h2>{activityTabs.find(t => t[0] === tab)?.[1] || '거래 활동'}</h2><p>관심 있는 거래와 진행 상황을 모아보세요.</p></div></div><Tabs value={tab} onValueChange={v => go('/activity/' + v)}><TabsList className="activity-tabs">{activityTabs.map(([id, name]) => <TabsTrigger key={id} value={id}>{name}</TabsTrigger>)}</TabsList></Tabs>{error ? <EmptyState title="불러오지 못했습니다" description={error}/> : !data ? <Loading /> : data.posts ? <>{data.posts.length ? <ListingRows posts={data.posts} onFavorite={reload}/> : <EmptyState title="아직 저장된 거래 글이 없습니다" description="거래 목록에서 거래 글을 둘러보세요."><button className="primary" onClick={() => go('/')}>거래 둘러보기</button></EmptyState>}{data.total > 16 && <div className="simple-pagination"><button className="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>이전</button><span>{page} / {Math.ceil(data.total / 16)}</span><button className="secondary" disabled={page * 16 >= data.total} onClick={() => setPage(page + 1)}>다음</button></div>}</> : tab === 'offers' ? <><div className="offer-tabs"><button className={offerTab === 'received' ? 'active' : ''} onClick={() => setOfferTab('received')}>받은 제안</button><button className={offerTab === 'sent' ? 'active' : ''} onClick={() => setOfferTab('sent')}>보낸 제안</button><span>최근 100건</span></div>{data.offers.filter((o: any) => offerTab === 'received' ? o.recipient_id === me.id : o.sender_id === me.id).length ? <div className="offers-grid">{data.offers.filter((o: any) => offerTab === 'received' ? o.recipient_id === me.id : o.sender_id === me.id).map((o: any) => <div key={o.id}><OfferCard o={o} changed={reload}/><button className="offer-chat" onClick={() => go('/chat/' + o.conversation_id)}>{offerTab === 'received' ? o.sender_name : o.recipient_name}님과 채팅 <MessageCircle size={14}/></button></div>)}</div> : <EmptyState title="가격 제안이 없습니다" description="주고받은 가격 제안과 답변 상태를 여기서 확인할 수 있습니다."/>}</> : tab === 'searches' ? data.searches.length ? <div className="saved-list">{data.searches.map((s: any) => <div key={s.id}><button onClick={() => go('/?' + s.query)}><Bookmark size={19}/><strong>{s.name}</strong></button><button aria-label={s.name + ' 검색 삭제'} onClick={async () => { try {
        await api('searches/' + s.id, 'DELETE');
        reload();
    }
    catch (e) {
        toast.error(errorMessage(e));
    } }}><Trash2 size={16}/></button></div>)}</div> : <EmptyState title="저장한 검색이 없습니다" description="거래 목록에서 조건을 고른 뒤 검색 저장을 눌러보세요."/> : tab === 'uploads' ? data.uploads.length ? <><p className="field-hint">게시글이나 임시저장에서 사용하지 않는 사진입니다. 삭제한 사진은 복구할 수 없습니다.</p><div className="unused-images">{data.uploads.map((img: any) => <UnusedImage key={img.id} img={img} reload={reload}/>)}</div></> : <EmptyState title="정리할 사진이 없습니다" description="글과 임시저장에 쓰이지 않는 사진만 표시합니다."/> : tab === 'blocks' ? data.blocks.length ? <div className="saved-list">{data.blocks.map((b: any) => <div key={b.target_id}><button onClick={() => go('/profile/' + b.target_id)}><Avatar name={b.nickname}/><strong>{b.nickname}</strong></button><button className="secondary" onClick={async () => { try {
        await api('blocks', 'POST', { userId: b.target_id, active: false });
        reload();
    }
    catch (e) {
        toast.error(errorMessage(e));
    } }}>차단 해제</button></div>)}</div> : <EmptyState title="차단한 회원이 없습니다" description="회원 프로필에서 채팅과 가격 제안을 차단할 수 있습니다."/> : null}</>;
}
export function Guide() { const [notices, setNotices] = useState<any[]>([]); useEffect(() => { api('notices').then(d => setNotices(d.notices)).catch(() => { }); }, []); return <><div className="page-title"><div><div className="breadcrumb">거래소 안내</div><h2>공지와 이용 안내</h2><p>거래를 시작하기 전에 확인해 주세요.</p></div></div>{notices.map(n => <details className="guide-item" key={n.id}><summary><span>공지</span>{n.title}<small>{relativeTime(n.created_at)}</small></summary><div className="formatted-body">{n.body}</div></details>)}<details className="guide-item" open><summary><span>이용</span>거래는 어떻게 등록하나요?</summary><div>구매, 판매, 교환, 대리(구함), 대리(진행) 중 하나를 선택하세요. 구매에는 최대 예산과 원하는 조건을, 판매에는 보유 정보와 즉거가, 현젯을 적습니다. 대주 수는 숫자로 입력합니다. 교환은 내놓는 대상과 구하는 대상을 각각 선택합니다. 제목과 상세 설명은 직접 작성하며 스킨 정보가 제목에 자동으로 붙지 않습니다. 판매 즉거가를 수정하면 이전 금액은 취소선으로 남습니다. 현젯은 작성자가 적은 현재 제시 금액이며 채팅에서 받은 제안과 자동으로 연동되지 않습니다.</div></details><details className="guide-item"><summary><span>검색</span>시즌과 티어는 어떻게 검색하나요?</summary><div>래더 시즌을 눌러 원하는 티어와 시즌을 체크하세요. 기본은 하나 이상 포함하는 글을 찾습니다. 모든 기록이 있는 계정을 찾으려면 모두 포함으로 바꾸세요. 아이언은 25~32시즌, 마스터는 17~32시즌, 챔피언은 8~32시즌, 그 외 티어는 6~32시즌을 선택할 수 있습니다. 조건을 저장하면 나의 거래에서 다시 열 수 있습니다.</div></details><details className="guide-item"><summary><span>제안</span>제안을 수락하면 거래가 끝나나요?</summary><div>가격 제안을 수락하면 글이 협의중으로 바뀌고 다른 대기 제안은 거절됩니다. 실제 결제나 거래 완료를 뜻하지 않습니다. 채팅으로 조건을 확인한 뒤 작성자가 거래완료로 변경하세요. 거래를 재개하거나 완료하면 처리 중인 제안은 종료됩니다. 결제, 에스크로, 거래 보증은 제공하지 않습니다.</div></details><details className="guide-item"><summary><span>관리</span>문제 있는 게시글과 회원은 어떻게 처리하나요?</summary><div>게시글의 신고 버튼으로 사유를 남길 수 있습니다. 신고는 매니저가 확인하고 필요하면 글을 숨깁니다. 회원 프로필에서 차단하면 서로 메시지나 가격 제안을 보낼 수 없습니다. 이미 나눈 대화는 기록으로 남습니다. 매니저를 제외한 회원은 일반 회원 등급입니다.</div></details><section className="guide-policy"><h3>게임 운영정책과 게시 정보</h3><PolicyNote /><p>계정 정보, 소유 이력, 진행도와 사진은 작성자가 제공한 내용이며 거래소가 검증한 정보가 아닙니다. 공개 게시글에 비밀번호, 인증번호, 쿠폰 코드나 개인정보를 남기지 마세요.</p></section></>; }
export function Manage() {
    const { me, go } = useMarket(), [data, setData] = useState<any>(null), [notices, setNotices] = useState<any[]>([]), [error, setError] = useState(''), [title, setTitle] = useState(''), [content, setContent] = useState(''), [editId, setEditId] = useState<number | null>(null), [busy, setBusy] = useState(false), [tick, setTick] = useState(0);
    useEffect(() => { if (me?.role === 'manager')
        Promise.all([api('manage'), api('notices')]).then(([d, n]) => { setData(d); setNotices(n.notices); }).catch(e => setError(errorMessage(e))); }, [me?.id, tick]);
    if (!me)
        return <LoginGate />;
    if (me.role !== 'manager')
        return <EmptyState title="매니저 전용 메뉴입니다" description="접근 권한이 없습니다."/>;
    const reload = () => setTick(n => n + 1);
    async function perform(path: string, body: any) { try {
        await api('manage/' + path, 'POST', body);
        reload();
        toast.success('처리했습니다.');
    }
    catch (e) {
        toast.error(errorMessage(e));
    } }
    async function notice(e: React.FormEvent) { e.preventDefault(); setBusy(true); try {
        await api('manage/notice' + (editId ? '/' + editId : ''), editId ? 'PUT' : 'POST', { title, body: content });
        setTitle('');
        setContent('');
        setEditId(null);
        reload();
        toast.success('공지를 저장했습니다.');
    }
    catch (e) {
        toast.error(errorMessage(e));
    }
    finally {
        setBusy(false);
    } }
    return <><div className="page-title"><div><div className="breadcrumb">운영 관리</div><h2>매니저 관리</h2><p>신고와 숨긴 게시글, 거래소 공지를 관리합니다.</p></div><Role role="manager"/></div>{error && <div className="error-banner">{error}</div>}<section className="admin-section"><h3>신고 접수 <span>{data?.reports.filter((r: any) => r.status === 'pending').length || 0}건 대기</span></h3>{!data ? <Loading /> : data.reports.length ? data.reports.map((r: any) => <article className="report-card" key={r.id}><div><b>{r.reason}</b><span>{r.status === 'pending' ? '검토 대기' : '처리 완료'}</span></div><button className="report-title" disabled={!r.post_id} onClick={() => go('/posts/' + r.post_id)}>{r.title || '삭제된 게시글'}</button><p>{r.details}</p><small>신고자 {r.nickname} / {relativeTime(r.created_at)}</small><div className="report-actions">{r.post_id && <button className="secondary" onClick={() => perform('visibility', { postId: r.post_id, hidden: !r.hidden })}>{r.hidden ? '게시글 복원' : '게시글 숨기기'}</button>}<button className="secondary" onClick={() => perform('report', { id: r.id, status: r.status === 'pending' ? 'resolved' : 'pending' })}>{r.status === 'pending' ? '처리 완료' : '다시 검토'}</button></div></article>) : <p className="muted">접수된 신고가 없습니다.</p>}</section><section className="admin-section"><h3>숨긴 게시글</h3>{data?.hidden.length ? data.hidden.map((p: Post) => <div className="hidden-row" key={p.id}><button onClick={() => go('/posts/' + p.id)}><EyeOff size={16}/>{p.title}</button><button className="secondary" onClick={() => perform('visibility', { postId: p.id, hidden: false })}>복원</button></div>) : <p className="muted">숨긴 게시글이 없습니다.</p>}</section><section className="admin-section"><h3>{editId ? '공지 수정' : '새 공지 작성'}</h3><form className="form-stack" onSubmit={notice}><label>공지 제목<input required minLength={2} maxLength={100} value={title} onChange={e => setTitle(e.target.value)}/></label><label>공지 내용<textarea required maxLength={10000} rows={6} value={content} onChange={e => setContent(e.target.value)}/></label><div className="row-actions"><button className="primary" disabled={busy}>공지 저장</button>{editId && <button type="button" className="secondary" onClick={() => { setEditId(null); setTitle(''); setContent(''); }}>수정 취소</button>}</div></form>{notices.map(n => <div className="hidden-row" key={n.id}><span>{n.title}</span><button className="secondary" onClick={() => { setEditId(n.id); setTitle(n.title); setContent(n.body); }}>수정</button></div>)}</section></>;
}
function UnusedImage({ img, reload }: {
    img: any;
    reload: () => void;
}) { const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false); return <div><img src={'/api/images/' + img.id} alt="사용하지 않는 첨부 사진"/><small>{Math.round(img.size / 1024)} KB</small><button className="subtle" onClick={() => setConfirm(true)}>삭제</button><AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent><AlertDialogTitle>사용하지 않는 사진을 삭제할까요?</AlertDialogTitle><AlertDialogDescription>사진을 영구 삭제하며 복구할 수 없습니다.</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>취소</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={async (e) => { e.preventDefault(); setBusy(true); try {
    await api('uploads/' + img.id, 'DELETE');
    setConfirm(false);
    reload();
}
catch (e) {
    toast.error(errorMessage(e));
}
finally {
    setBusy(false);
} }}>삭제</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>; }
