import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Flag, Heart, Link2, MessageCircle, Pencil, Trash2, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { toast } from 'sonner';
import {
    ACCOUNT_CHOICES, DETAIL_FIELDS, KIND_NAMES, NICK_RANKS, STATUS_NAMES, categoryName, manToWon, parseList, relativeTime, skinDisplay, skinTags, tagName,
    type Post,
} from '../../shared/market';
import { api, errorText, imageUrl } from '../lib/api';
import { Link, navigate, withParams } from '../lib/router';
import { useApp } from '../app/state';
import { Avatar, EmptyState, Modal, NameLine, SkeletonRows } from '../components/ui';
import { PriceLine } from '../components/PostCard';

type Row = [string, ReactNode];

function SpecList({ rows }: { rows: Row[] }) {
    const shown = rows.filter(([, v]) => v !== '' && v !== null && v !== undefined);
    if (!shown.length) return null;
    return <dl className="spec-list">{shown.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

const num = (v?: string, unit = '') => v ? Number(v).toLocaleString('ko-KR') + unit : '';

function nicknameRange(d: Record<string, string>, prefix = '') {
    const min = d[prefix ? 'wantedNicknameCharsMin' : 'nicknameCharsMin'];
    const max = d[prefix ? 'wantedNicknameCharsMax' : 'nicknameCharsMax'];
    if (min && max) return min === max ? `${min}글자` : `${min}~${max}글자`;
    return min ? `${min}글자 이상` : max ? `${max}글자 이하` : '';
}

// Seller-side account facts (판매, and the offered side of 교환).
function OfferedAccount({ post }: { post: Post }) {
    const d = post.details, skins = skinDisplay(skinTags(d.skinTags));
    const nick = [d.nicknameChars ? d.nicknameChars + '글자' : '', d.nicknameRank ? d.nicknameRank + ' 등급' : ''].filter(Boolean).join(' · ');
    return <>
        <SpecList rows={[
            ['대주 수', num(d.ownerCount, '대주')], ['전적', d.recordStatus], ['팬텀', d.phantom ? d.phantom + '%' : ''], ['닉네임', nick],
            ['가스', num(d.gas)], ['미네랄', num(d.minerals)],
            ...(['integrated', 'passwordChange', 'phoneChange', 'backupEmail'] as const).map(k => [ACCOUNT_CHOICES[k].label, d[k]] as Row),
            ['계정 레벨', num(d.level)], ['연구실 레벨', num(d.labLevel)], ['인간 스킨', num(d.humanSkins, '개')], ['좀비 스킨', num(d.zombieSkins, '개')], ['옷장', num(d.closet, '칸')],
        ]} />
        {post.tags.length > 0 && <><h3>래더 기록</h3><div className="tags">{[...post.tags].sort((a, b) => b.season - a.season).map(t => <span className="tag tag-line" key={t.tier + t.season}>{tagName(t)}</span>)}</div></>}
        {skins.length > 0 && <><h3>보유 우대 스킨</h3><div className="tags">{skins.map(s => <span className="tag tag-line" key={s}>{s}</span>)}</div></>}
        {d.rareSkins && <><h3>기타 스킨 (이전 기록)</h3><p className="body-text">{d.rareSkins}</p></>}
    </>;
}

// Buyer-side wishes (구매, and the wanted side of 교환 with the "wanted" prefix).
function WantedAccount({ post, prefix = '' }: { post: Post; prefix?: '' | 'wanted' }) {
    const d = post.details, key = (k: string) => prefix ? prefix + k[0].toUpperCase() + k.slice(1) : k;
    const ranks = parseList(d[key('nicknameRanks')], NICK_RANKS), skins = skinDisplay(skinTags(d[key('skinTags')]));
    const ladder = prefix ? post.wanted_tags || [] : post.tags;
    return <>
        <SpecList rows={[
            ['대주 수', num(d[key('maxOwners')], '대주 이하')], ['전적', d[key('recordPreference')]],
            ['닉네임 글자 수', nicknameRange(d, prefix)], ['닉 등급', ranks.join(', ')],
        ]} />
        {ladder.length > 0 && <><h3>원하는 래더</h3><div className="tags">{[...ladder].sort((a, b) => b.season - a.season).map(t => <span className="tag tag-line" key={t.tier + t.season}>{tagName(t)}</span>)}</div></>}
        {skins.length > 0 && <><h3>우대 스킨</h3><div className="tags">{skins.map(s => <span className="tag tag-line" key={s}>{s}</span>)}</div></>}
    </>;
}

function GenericFields({ post, category }: { post: Post; category: string }) {
    const rows = (DETAIL_FIELDS[category] || []).map(f => [f.label, f.type === 'number' ? num(post.details[f.id]) : post.details[f.id]] as Row);
    return <>
        <SpecList rows={rows} />
        {category === 'ladder' && post.tags.length > 0 && <><h3>래더 시즌</h3><div className="tags">{post.tags.map(t => <span className="tag tag-line" key={t.tier + t.season}>{tagName(t)}</span>)}</div></>}
    </>;
}

export function Detail({ id }: { id: string }) {
    const { me, requireLogin, refreshUnread } = useApp();
    const [post, setPost] = useState<Post | null>(null), [error, setError] = useState('');
    const [lightbox, setLightbox] = useState<string | null>(null), [offer, setOffer] = useState(false), [report, setReport] = useState(false), [confirmDelete, setConfirmDelete] = useState(false);
    const load = () => api<{ post: Post }>('posts/' + id).then(d => setPost(d.post)).catch(e => setError(errorText(e)));
    useEffect(() => { void load(); }, [id, me?.id]);
    useEffect(() => { if (me && post && post.author_id !== me.id) api(`posts/${id}/view`, 'POST', {}).catch(() => {}); }, [me?.id, post?.id]);

    if (error) return <div className="container page"><EmptyState icon="warning" title="글을 볼 수 없어요" text={error} action={<Link to="/trade" className="btn btn-primary">거래 목록으로</Link>} /></div>;
    if (!post) return <div className="container page"><SkeletonRows count={3} height={160} /></div>;

    const mine = me?.id === post.author_id, manager = me?.role === 'manager';
    const canOffer = !mine && post.status === 'open' && post.kind === 'sell' && (post.accepts_offers === 1 || post.price_mode === 'offer');
    const exchangeWanted = post.details.wantedCategory || 'account';

    async function startChat() {
        requireLogin(async () => {
            try { const d = await api<{ id: string }>('chats', 'POST', { userId: post!.author_id, postId: post!.id }); refreshUnread(); void navigate('/chat/' + d.id); }
            catch (e) { toast.error(errorText(e)); }
        });
    }
    async function favorite() {
        requireLogin(async () => {
            try { await api(`posts/${post!.id}/favorite`, 'POST', { active: !post!.favorite }); setPost({ ...post!, favorite: !post!.favorite }); toast(post!.favorite ? '찜을 해제했습니다.' : '찜한 글에 저장했습니다.'); }
            catch (e) { toast.error(errorText(e)); }
        });
    }
    async function setStatus(status: string) {
        try { await api(`posts/${post!.id}/status`, 'PATCH', { status }); setPost({ ...post!, status }); toast(`거래 상태를 ‘${STATUS_NAMES[status]}’으로 바꿨습니다.`); }
        catch (e) { toast.error(errorText(e)); }
    }
    async function remove() {
        try { await api('posts/' + post!.id, 'DELETE'); toast('글을 삭제했습니다.'); void navigate(withParams('/trade', { kind: post!.kind, category: post!.category }), { replace: true }); }
        catch (e) { toast.error(errorText(e)); }
    }
    async function hide(hidden: boolean) {
        try { await api('manage/visibility', 'POST', { postId: post!.id, hidden }); toast(hidden ? '글을 숨겼습니다.' : '글을 다시 공개했습니다.'); void load(); }
        catch (e) { toast.error(errorText(e)); }
    }

    const sectionTitle = post.kind === 'buy' ? '원하는 조건' : post.kind === 'exchange' ? '교환 조건' : post.kind.startsWith('proxy') ? (post.kind === 'proxy_request' ? '요청 내용' : '진행 내용') : `${categoryName(post.category)} 정보`;

    return <div className="container page detail-page">
        <div className="detail-layout">
            <article>
                <nav className="crumbs" aria-label="위치">
                    <Link to={withParams('/trade', { kind: post.kind })}>{KIND_NAMES[post.kind]}</Link><ChevronRight size={14} />
                    <Link to={withParams('/trade', { kind: post.kind, category: post.category, wantedCategory: post.kind === 'exchange' ? exchangeWanted : '' })}>{post.kind === 'exchange' ? `${categoryName(post.category)}에서 ${categoryName(exchangeWanted)} 구함` : categoryName(post.category)}</Link>
                </nav>
                <h1 className="detail-title">{post.title}</h1>
                <div className="detail-meta">
                    {post.status !== 'open' && <span className={'status status-' + post.status}>{STATUS_NAMES[post.status]}</span>}
                    {post.hidden === 1 && <span className="status status-closed">숨김 처리됨</span>}
                    <span>{relativeTime(post.created_at)} 등록</span>
                    {post.updated_at - post.created_at > 60000 && <span>· {relativeTime(post.updated_at)} 수정</span>}
                </div>
                {/* On phones the author and their verification checks come right under the title. */}
                <AuthorBox post={post} className="author-box-top" />
                {post.images.length > 0 && <div className="gallery">{post.images.map((img, i) => <button type="button" key={img} onClick={() => setLightbox(img)} aria-label={`사진 ${i + 1} 크게 보기`}><img src={imageUrl(img)} alt="" loading="lazy" /></button>)}</div>}

                <section className="detail-section">
                    <h2>{sectionTitle}</h2>
                    {post.kind === 'exchange' ? <>
                        <h3>내놓는 {categoryName(post.category)}</h3>
                        {post.category === 'account' ? <OfferedAccount post={post} /> : <GenericFields post={post} category="clan" />}
                        <h3>구하는 {categoryName(exchangeWanted)}</h3>
                        {exchangeWanted === 'account' ? <WantedAccount post={post} prefix="wanted" /> : <p className="muted">원하는 클랜 조건은 상세 설명을 확인해 주세요.</p>}
                    </> : post.category === 'account' ? (post.kind === 'buy' ? <WantedAccount post={post} /> : <OfferedAccount post={post} />) : <GenericFields post={post} category={post.category} />}
                </section>
                <section className="detail-section">
                    <h2>상세 설명</h2>
                    <p className="body-text">{post.body}</p>
                </section>
                <div className="row muted small detail-tools">
                    <button type="button" className="btn btn-text small" onClick={() => { void navigator.clipboard?.writeText(location.href).then(() => toast('링크를 복사했습니다.')); }}><Link2 size={15} />링크 복사</button>
                    {!mine && <button type="button" className="btn btn-text small" onClick={() => requireLogin(() => setReport(true))}><Flag size={15} />신고</button>}
                    <span className="grow" /><span>글 번호 {post.id}</span>
                </div>
            </article>

            <aside className="side-card" aria-label="가격과 문의">
                <PriceLine post={post} large />
                {mine ? <div className="owner-tools">
                    <Link to={'/edit/' + post.id} className="btn btn-primary btn-lg btn-block"><Pencil size={18} />수정하기</Link>
                    <label className="field"><span className="field-label">거래 상태</span>
                        <select className="select" value={post.status} onChange={e => setStatus(e.target.value)}>{Object.entries(STATUS_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                    <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}><Trash2 size={16} />삭제</button>
                </div> : <div className={'side-actions' + (canOffer ? ' with-offer' : '')}>
                    <button type="button" className="btn btn-primary btn-lg" onClick={startChat}><MessageCircle size={19} />채팅으로 문의하기</button>
                    {canOffer && <button type="button" className="btn btn-line btn-lg" onClick={() => requireLogin(() => setOffer(true))}>가격 제안</button>}
                    <button type="button" className={'btn btn-line btn-lg' + (post.favorite ? ' is-on' : '')} aria-pressed={!!post.favorite} aria-label={post.favorite ? '찜 해제' : '찜하기'} onClick={favorite}><Heart size={19} fill={post.favorite ? 'currentColor' : 'none'} /></button>
                </div>}
                {manager && !mine && <div className="row"><button type="button" className="btn btn-line btn-sm grow" onClick={() => hide(!post.hidden)}>{post.hidden ? '다시 공개' : '숨기기'}</button><button type="button" className="btn btn-danger btn-sm grow" onClick={() => setConfirmDelete(true)}>삭제</button></div>}
                <AuthorBox post={post} className="author-box-side" />
                <p className="safety">거래 전 상대의 전화번호·계좌를 조회하고, 비밀번호나 인증번호는 채팅에 쓰지 마세요. 사이트는 결제와 거래 보증을 하지 않습니다.</p>
            </aside>
        </div>

        {!mine && <div className="mobile-cta">
            <PriceLine post={post} />
            <button type="button" className={'icon-btn' + (post.favorite ? ' is-on' : '')} aria-label={post.favorite ? '찜 해제' : '찜하기'} onClick={favorite}><Heart size={22} fill={post.favorite ? 'currentColor' : 'none'} /></button>
            {canOffer && <button type="button" className="btn btn-line" onClick={() => requireLogin(() => setOffer(true))}>가격 제안</button>}
            <button type="button" className="btn btn-primary" onClick={startChat}>채팅하기</button>
        </div>}

        <Dialog.Root open={!!lightbox} onOpenChange={o => { if (!o) setLightbox(null); }}>
            <Dialog.Portal>
                <Dialog.Overlay className="lightbox" onClick={() => setLightbox(null)} />
                <Dialog.Content className="lightbox-content" aria-describedby={undefined} onClick={() => setLightbox(null)}>
                    <Dialog.Title className="sr-only">사진 크게 보기</Dialog.Title>
                    {lightbox && <img src={imageUrl(lightbox)} alt="" />}
                    <Dialog.Close className="icon-btn lightbox-close" aria-label="닫기"><X size={26} /></Dialog.Close>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
        <OfferModal open={offer} onClose={() => setOffer(false)} post={post} />
        <ReportModal open={report} onClose={() => setReport(false)} postId={post.id} />
        <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="글을 삭제할까요?" description="삭제한 글은 되돌릴 수 없어요."
            footer={<><button className="btn btn-line" onClick={() => setConfirmDelete(false)}>취소</button><button className="btn btn-dark" onClick={remove}>삭제</button></>}><span /></Modal>
    </div>;
}

function AuthorBox({ post, className }: { post: Post; className: string }) {
    return <Link to={'/profile/' + post.author_id} className={'author-box ' + className}>
        <Avatar name={post.nickname} />
        <span className="grow"><NameLine nickname={post.nickname} grade={post.author_grade} role={post.role} badges={post.author_badges} /><span className="author-stats">프로필과 다른 거래 보기</span></span>
        <ChevronRight size={18} className="muted" />
    </Link>;
}

function OfferModal({ open, onClose, post }: { open: boolean; onClose: () => void; post: Post }) {
    const [amount, setAmount] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false);
    const won = manToWon(amount);
    async function send() {
        if (won === null || Number.isNaN(won)) { toast.error('제안 금액을 만원 단위 숫자로 입력해 주세요.'); return; }
        setBusy(true);
        try { const d = await api<{ chatId: string }>('offers', 'POST', { postId: post.id, amount: won, note }); onClose(); toast('가격을 제안했습니다.'); void navigate('/chat/' + d.chatId); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    return <Modal open={open} onClose={onClose} title="가격 제안" description="판매자가 수락하면 거래 상태가 예약중으로 바뀌어요."
        footer={<button className="btn btn-primary btn-lg" disabled={busy || !amount} onClick={send}>제안 보내기</button>}>
        <div className="form-stack">
            <label className="field"><span className="field-label">제안 금액</span><div className="input-unit"><input className="input" type="number" inputMode="decimal" min="0" step="0.1" value={amount} onChange={e => setAmount(e.target.value)} placeholder="예: 45" autoFocus /><span>만원</span></div>
                {won !== null && !Number.isNaN(won) && <span className="field-hint">{won.toLocaleString('ko-KR')}원</span>}</label>
            <label className="field"><span className="field-label">메시지 (선택)</span><input className="input" maxLength={500} value={note} onChange={e => setNote(e.target.value)} placeholder="예: 오늘 바로 거래 가능해요" /></label>
        </div>
    </Modal>;
}

const REPORT_REASONS = ['사기 의심', '허위 매물', '거래 금지 품목', '욕설·비방', '기타'];

function ReportModal({ open, onClose, postId }: { open: boolean; onClose: () => void; postId: number }) {
    const [reason, setReason] = useState(REPORT_REASONS[0]), [details, setDetails] = useState(''), [busy, setBusy] = useState(false);
    async function send() {
        setBusy(true);
        try { await api('reports', 'POST', { postId, reason, details }); onClose(); setDetails(''); toast('신고를 접수했습니다. 매니저가 확인할게요.'); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    return <Modal open={open} onClose={onClose} title="게시글 신고" footer={<button className="btn btn-primary btn-lg" disabled={busy || !details.trim()} onClick={send}>신고하기</button>}>
        <div className="form-stack">
            <div className="chip-row">{REPORT_REASONS.map(r => <button type="button" key={r} className="chip chip-sm" aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>)}</div>
            <label className="field"><span className="field-label">내용</span><textarea className="textarea" style={{ minHeight: 120 }} maxLength={1000} value={details} onChange={e => setDetails(e.target.value)} placeholder="확인에 필요한 내용을 적어 주세요." /></label>
        </div>
    </Modal>;
}

