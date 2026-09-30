'use client';
import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Heart, Share2, Flag, MessageCircle, ArrowUpRight, PenLine, Trash2, ImageIcon, ChevronLeft, ChevronRight, Check, ArrowLeftRight } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { AccountDetails } from './account-fields';
import { PriceDisplay } from './price-display';
import { CATEGORIES, KIND_NAMES, STATUS_NAMES, DETAIL_FIELDS, exchangeLabel, isProxyKind, relativeTime, type Post } from '@/lib/market';
import { api, errorMessage, useMarket, Loading, EmptyState, Avatar, Role, TagBadges, PolicyNote } from './shared';
export function Detail({ id }: {
    id: string;
}) {
    const params = useSearchParams();
    const from = params.get('from');
    const returnPath = from && /^\/(?:\?.*|(?:profile|activity)\/[A-Za-z0-9_-]+(?:\?.*)?)?$/.test(from) ? from : null;
    const { me, go, chat, login, refresh } = useMarket(), [p, setP] = useState<Post | null>(null), [error, setError] = useState(''), [photo, setPhoto] = useState(0), [lightbox, setLightbox] = useState(false), [offer, setOffer] = useState(false), [amount, setAmount] = useState(''), [note, setNote] = useState(''), [report, setReport] = useState(false), [reason, setReason] = useState('허위 정보 / 사기 의심'), [reportText, setReportText] = useState(''), [deleting, setDeleting] = useState(false), [busy, setBusy] = useState(false);
    const load = () => api('posts/' + id).then(d => setP(d.post)).catch(e => setError(errorMessage(e)));
    useEffect(() => { load(); }, [id, me?.id]);
    useEffect(() => { if (me && p)
        api('posts/' + id + '/view', 'POST', {}).catch(() => { }); }, [id, me?.id, p?.id]);
    async function favorite() { if (!me) {
        login();
        return;
    } try {
        await api('posts/' + id + '/favorite', 'POST', { active: !p!.favorite });
        setP({ ...p!, favorite: !p!.favorite });
    }
    catch (e) {
        toast.error(errorMessage(e));
    } }
    async function submitOffer(e: React.FormEvent) { e.preventDefault(); setBusy(true); try {
        const d = await api('offers', 'POST', { postId: Number(id), amount: Number(amount), note });
        setOffer(false);
        toast.success('가격 제안을 보냈습니다.');
        go('/chat/' + d.chatId);
    }
    catch (e) {
        toast.error(errorMessage(e));
    }
    finally {
        setBusy(false);
    } }
    async function submitReport(e: React.FormEvent) { e.preventDefault(); setBusy(true); try {
        await api('reports', 'POST', { postId: Number(id), reason, details: reportText });
        setReport(false);
        toast.success('신고가 접수되었습니다. 매니저가 확인합니다.');
    }
    catch (e) {
        toast.error(errorMessage(e));
    }
    finally {
        setBusy(false);
    } }
    async function status(value: string) { try {
        await api('posts/' + id + '/status', 'PATCH', { status: value });
        load();
        refresh();
        toast.success('거래 상태를 변경했습니다.');
    }
    catch (e) {
        toast.error(errorMessage(e));
    } }
    async function remove() { setBusy(true); try {
        await api('posts/' + id, 'DELETE');
        refresh();
        go('/');
        toast.success('게시글을 삭제했습니다.');
    }
    catch (e) {
        toast.error(errorMessage(e));
    }
    finally {
        setBusy(false);
        setDeleting(false);
    } }
    if (error)
        return <EmptyState title="게시글을 열 수 없습니다" description={error}><button className="secondary" onClick={() => go('/')}>거래 목록</button></EmptyState>;
    if (!p)
        return <Loading />;
    const own = me?.id === p.author_id;
    return <><button className="back-link" onClick={() => go(returnPath || '/?kind=' + p.kind + '&category=' + p.category)}><ArrowLeft size={16}/>{returnPath ? '목록으로 돌아가기' : '거래 목록'}</button>{!!p.hidden && <div className="error-banner">매니저가 숨긴 게시글입니다. 다른 회원에게 표시되지 않습니다.</div>}<div className="detail-layout"><div className="detail-main"><div className="detail-heading"><div className="detail-labels"><span className={'kind-badge ' + p.kind}>{KIND_NAMES[p.kind]}</span><span>{CATEGORIES.find(c => c.id === p.category)?.name}</span><span className={'status-badge ' + p.status}>{STATUS_NAMES[p.status]}</span></div><h1>{p.title}</h1><div className="detail-meta"><span>{relativeTime(p.created_at)} 등록</span>{p.updated_at !== p.created_at && <span>{relativeTime(p.updated_at)} 수정</span>}</div><div className="detail-mobile-price"><PriceDisplay post={p} compact/></div>{own && <div className="mobile-owner-actions"><button className="secondary" onClick={()=>go('/edit/' + id + (returnPath ? '?from=' + encodeURIComponent(returnPath) : ''))}><PenLine size={16}/>수정</button><label>상태<select aria-label="내 글 거래 상태" value={p.status} onChange={e=>status(e.target.value)}>{Object.entries(STATUS_NAMES).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></label></div>}</div>
 {p.images.length > 0 ? <section className="gallery"><button className="gallery-main" onClick={() => setLightbox(true)}><img src={'/api/images/' + p.images[photo]} alt={`거래 사진 ${photo + 1}`}/><span>{photo + 1} / {p.images.length} </span></button><div className="gallery-thumbnails">{p.images.map((img, i) => <button key={img} className={i === photo ? 'selected' : ''} onClick={() => setPhoto(i)} aria-label={'사진 ' + (i + 1) + ' 보기'}><img src={'/api/images/' + img} alt=""/></button>)}</div></section> : <div className="no-photo-note"><ImageIcon size={20}/><span>첨부된 사진이 없습니다.<small>필요한 화면은 작성자에게 문의하세요.</small></span></div>}
 {(Object.keys(p.details).length > 0 || p.tags.length > 0) && <section className="detail-section"><div className="detail-section-title"><h3>{p.kind === 'buy' ? '구하는 조건' : p.kind === 'exchange' ? '내놓는 대상' : p.category === 'account' ? '계정 정보' : '거래 정보'}</h3><span>작성자 기재 정보</span></div>{p.tags.length > 0 && <div className="detail-tiers"><h4>{p.kind === 'buy' ? '원하는 래더 기록' : '래더 기록'}</h4><TagBadges tags={p.tags}/></div>}{p.category === 'account' ? <AccountDetails value={p.details} buying={p.kind === 'buy'}/> : <dl className="spec-table">{DETAIL_FIELDS[p.category]?.filter(f => p.details[f.id]).map(f => <div key={f.id}><dt>{f.label}</dt><dd>{p.details[f.id]}</dd></div>)}</dl>}</section>}
 {p.kind === 'exchange' && <section className="detail-section"><h3 className="exchange-detail-title">{exchangeLabel(p.category, p.details.wantedCategory)}</h3>{p.details.wantedCategory === 'account' && <AccountDetails value={p.details} buying wanted/>}</section>}
 <section className="detail-section"><h3>상세 설명</h3><div className="formatted-body">{p.body}</div></section>{(p.category === 'account' || isProxyKind(p.kind)) && <PolicyNote />}<div className="detail-bottom"><span className="listing-number">글 번호 {p.id}</span><button className="subtle" onClick={async () => { try {
        await navigator.clipboard.writeText(location.href);
        toast.success('링크를 복사했습니다.');
    }
    catch {
        toast.error('주소창에서 링크를 복사해 주세요.');
    } }}><Share2 size={15}/>링크 복사</button><button className="subtle" onClick={() => me ? setReport(true) : login()}><Flag size={15}/>게시글 신고</button></div></div>
 <aside className="trade-sidebar"><div className="price-box"><PriceDisplay post={p}/>{!!p.accepts_offers && <small><Check size={13}/>가격 제안을 받는 글입니다</small>}<div className="seller-block"><button className="member-identity" onClick={() => go('/profile/' + p.author_id)}><Avatar name={p.nickname}/><span><b>{p.nickname}</b><Role role={p.role}/></span><ChevronRight size={15}/></button><button className="seller-posts" onClick={() => go('/profile/' + p.author_id)}>프로필과 작성 글 보기</button></div>
 {own ? <div className="owner-actions"><label>거래 상태<select aria-label="거래 상태 변경" value={p.status} onChange={e => status(e.target.value)}>{Object.entries(STATUS_NAMES).map(([k, v]) => <option value={k} key={k}>{v}</option>)}</select></label><button className="primary" onClick={() => go('/edit/' + id + (returnPath ? '?from=' + encodeURIComponent(returnPath) : ''))}><PenLine size={16}/>게시글 수정</button><button className="secondary danger" onClick={() => setDeleting(true)}><Trash2 size={15}/>게시글 삭제</button><button className="subtle" onClick={() => go('/activity/offers')}>받은 가격 제안 확인</button></div> : <div className="buyer-actions"><button className="primary" disabled={p.status === 'closed' || !!p.hidden} onClick={() => chat(p.author_id, p.id)}><MessageCircle size={18}/>{p.status === 'closed' ? '거래가 완료되었습니다' : p.kind === 'sell' && p.price !== null ? '이 가격으로 문의' : '거래 문의하기'}</button>{!!p.accepts_offers && <button className="secondary" disabled={p.status !== 'open' || !!p.hidden} onClick={() => { if (!me) {
        login();
        return;
    } setAmount(p.price === null ? '' : String(p.price)); setOffer(true); }}><ArrowLeftRight size={16}/>가격 제안하기</button>}<button className={'secondary favorite-button ' + (p.favorite ? 'hearted' : '')} onClick={favorite}><Heart size={17} fill={p.favorite ? 'currentColor' : 'none'}/>{p.favorite ? '찜한 글' : '찜하기'}</button>{me?.role === 'manager' && <button className="subtle danger" onClick={() => setDeleting(true)}>매니저 권한으로 삭제</button>}</div>}
 <p className="transaction-note">거래 조건은 채팅에서 확인하세요.<br />사이트 내 결제나 거래 보증은 제공하지 않습니다.</p></div><div className="trade-tip"><strong>거래 전 확인해 주세요</strong><p>작성자가 기재한 정보와 실제 화면이 일치하는지 확인하세요. 비밀번호와 인증번호를 공개 게시글에 남기지 마세요.</p><button onClick={() => go('/guide')}>거래소 이용 안내 </button></div></aside></div>
 {!own && p.status !== 'closed' && !p.hidden && <div className="mobile-trade-bar"><PriceDisplay post={p} compact/><button className="primary" onClick={() => chat(p.author_id, p.id)}><MessageCircle size={16}/>거래 문의</button></div>}
 <Dialog open={offer} onOpenChange={setOffer}><DialogContent><DialogTitle>가격 제안하기</DialogTitle><DialogDescription>{p.title}</DialogDescription><form className="form-stack" onSubmit={submitOffer}><label>제안 금액<div className="money-input"><input required type="number" min="0" max="1000000000" step="1" value={amount} onChange={e => setAmount(e.target.value)} placeholder="제안할 금액"/><span>원</span></div></label><label>함께 보낼 내용<textarea rows={3} maxLength={500} value={note} onChange={e => setNote(e.target.value)} placeholder="가능 시간이나 제안 조건을 적어주세요"/></label><p className="field-hint">제안은 상대방과의 채팅에 전달됩니다. 수락되면 게시글이 협의중으로 바뀌며, 결제나 거래 완료를 뜻하지 않습니다.</p><button className="primary" disabled={busy}>가격 제안 보내기</button></form></DialogContent></Dialog>
 <Dialog open={report} onOpenChange={setReport}><DialogContent><DialogTitle>게시글 신고</DialogTitle><DialogDescription>신고 내용은 매니저만 확인합니다.</DialogDescription><form className="form-stack" onSubmit={submitReport}><label>신고 사유<select value={reason} onChange={e => setReason(e.target.value)}>{['허위 정보 / 사기 의심', '개인정보 노출', '도배 / 광고', '부적절한 내용', '기타'].map(v => <option key={v}>{v}</option>)}</select></label><label>상세 내용<textarea required maxLength={1000} rows={4} value={reportText} onChange={e => setReportText(e.target.value)} placeholder="어떤 문제가 있는지 구체적으로 적어주세요"/></label><button className="primary" disabled={busy}>신고 접수</button></form></DialogContent></Dialog>
 <Dialog open={lightbox} onOpenChange={setLightbox}><DialogContent className="lightbox"><DialogTitle>거래 사진 {photo + 1} / {p.images.length}</DialogTitle><DialogDescription className="sr-only">게시글에 첨부된 사진을 크게 봅니다.</DialogDescription>{p.images[photo] && <img src={'/api/images/' + p.images[photo]} alt={'거래 사진 ' + (photo + 1)}/>}<div><button className="secondary" disabled={photo === 0} onClick={() => setPhoto(photo - 1)}><ChevronLeft size={16}/>이전</button><button className="secondary" disabled={photo === p.images.length - 1} onClick={() => setPhoto(photo + 1)}>다음<ChevronRight size={16}/></button></div></DialogContent></Dialog>
 <AlertDialog open={deleting} onOpenChange={setDeleting}><AlertDialogContent><AlertDialogTitle>게시글을 삭제할까요?</AlertDialogTitle><AlertDialogDescription>게시글과 연결된 가격 제안은 삭제되며 복구할 수 없습니다. 기존 채팅 메시지는 남습니다.</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>취소</AlertDialogCancel><AlertDialogAction onClick={e => { e.preventDefault(); remove(); }} disabled={busy}>삭제하기</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></>;
}
