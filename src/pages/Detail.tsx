import { Fragment, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Flag, Heart, Link2, MessageCircle, MoreHorizontal, X } from 'lucide-react';
import { Dialog, DropdownMenu } from 'radix-ui';
import { toast } from 'sonner';
import {
    ACCOUNT_CHOICES, DETAIL_FIELDS, KIND_NAMES, NICK_RANKS, REPORT_REASONS, STATUS_NAMES, categoryName, choiceLabel, manToWon, parseList, priceText, rankText, skinDisplay, skinTags, tagName, wonToMan,
    type Post,
} from '../../shared/market';
import { ApiError, api, errorText, imageUrl } from '../lib/api';
import { Link, navigate, takeScrollRestore, withParams } from '../lib/router';
import { setPageTitle, useApp } from '../app/state';
import { Avatar, EmptyState, Modal, NameLine, SkeletonRows } from '../components/ui';
import { PriceLine } from '../components/PostCard';

type Row = [string, ReactNode];
// Fields the detail response adds to a post (WP10 bump and feature columns, hide reason, 탈퇴).
type DetailPost = Post & { bump_count?: number; featured?: boolean; hidden_reason?: string; author_deleted?: boolean };
type Usage = {
    perks: { bumpsPerDay: number | null; bumpGapHours: number | null; boardSlots: number | null };
    bumpsToday: number; bumpsLeft: number | null; featured: { id: number; title: string }[];
};

const HOUR = 3600000;
// '15:40' on the Korean clock, rounded up to the minute like the server's message.
function kstClock(t: number) {
    const d = new Date(Math.ceil(t / 60000) * 60000 + 9 * HOUR);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}
const kstDate = (t: number) => new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

const num = (v?: string, unit = '') => v ? Number(v).toLocaleString('ko-KR') + unit : '';
const filled = (rows: Row[]) => rows.filter(([, v]) => v !== '' && v !== null && v !== undefined);

// Each builder returns the blocks it has content for, so a section with none is left out.
function specBlock(rows: Row[]) {
    const shown = filled(rows);
    return shown.length ? [<dl className="spec-list" key="spec">{shown.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>] : [];
}
function tagBlock(title: string, names: string[]) {
    return names.length ? [<h3 key={title + '-h'}>{title}</h3>, <div className="tags" key={title}>{names.map(s => <span className="tag tag-line" key={s}>{s}</span>)}</div>] : [];
}
const ladderNames = (tags: Post['tags']) => [...tags].sort((a, b) => b.season - a.season).map(tagName);

function nicknameRange(d: Record<string, string>, prefix = '') {
    const min = d[prefix ? 'wantedNicknameCharsMin' : 'nicknameCharsMin'];
    const max = d[prefix ? 'wantedNicknameCharsMax' : 'nicknameCharsMax'];
    if (min && max) return min === max ? `${min}글자` : `${min}~${max}글자`;
    return min ? `${min}글자 이상` : max ? `${max}글자 이하` : '';
}

// Seller-side account facts (판매, and the offered side of 교환).
function offeredBlocks(post: Post): ReactNode[] {
    const d = post.details;
    const nick = [d.nicknameChars ? d.nicknameChars + '글자' : '', d.nicknameRank ? rankText([d.nicknameRank]) : ''].filter(Boolean).join(' · ');
    return [
        ...specBlock([
            ['대주 수', num(d.ownerCount, '대주')], ['전적', d.recordStatus], ['팬텀', d.phantom ? d.phantom + '%' : ''], ['닉네임', nick],
            ['가스', num(d.gas)], ['미네랄', num(d.minerals)],
            ...(['integrated', 'passwordChange', 'phoneChange', 'backupEmail'] as const).map(k => [ACCOUNT_CHOICES[k].label, d[k] ? choiceLabel(k, d[k]) : ''] as Row),
            ['레벨', num(d.level)], ['연구실', num(d.labLevel)], ['인간 스킨', num(d.humanSkins, '개')], ['좀비 스킨', num(d.zombieSkins, '개')], ['옷장', num(d.closet, '칸')],
        ]),
        ...tagBlock('래더 기록', ladderNames(post.tags)),
        ...tagBlock('우대 스킨', skinDisplay(skinTags(d.skinTags))),
        ...d.rareSkins ? [<h3 key="rare-h">기타 스킨</h3>, <p className="body-text" key="rare">{d.rareSkins}</p>] : [],
    ];
}

// Buyer-side wishes (구매, and the wanted side of 교환 with the "wanted" prefix).
function wantedBlocks(post: Post, prefix: '' | 'wanted' = ''): ReactNode[] {
    const d = post.details, key = (k: string) => prefix ? prefix + k[0].toUpperCase() + k.slice(1) : k;
    const ranks = parseList(d[key('nicknameRanks')], NICK_RANKS);
    return [
        ...specBlock([
            ['대주 수', num(d[key('maxOwners')], '대주 이하')], ['전적', d[key('recordPreference')]],
            ['닉 글자 수', nicknameRange(d, prefix)], ['닉 등급', ranks.length ? rankText(ranks) : ''],
        ]),
        ...tagBlock('원하는 래더', ladderNames(prefix ? post.wanted_tags || [] : post.tags)),
        ...tagBlock('우대 스킨', skinDisplay(skinTags(d[key('skinTags')]))),
    ];
}

function genericBlocks(post: Post, category: string): ReactNode[] {
    return [
        ...specBlock((DETAIL_FIELDS[category] || []).map(f => [f.label, f.type === 'number' ? num(post.details[f.id]) : post.details[f.id]] as Row)),
        ...category === 'ladder' ? tagBlock('래더 시즌', post.tags.map(tagName)) : [],
    ];
}

// 거래 상태 as one row of three; a 대리(진행) post whose author lost 대리 인증 may only be closed.
function StatusSeg({ post, name, lostProxy, onChange }: { post: Post; name: string; lostProxy: boolean; onChange: (status: string) => void }) {
    const options = Object.entries(STATUS_NAMES).filter(([k]) => !lostProxy || k === post.status || k === 'closed');
    return <div className="seg seg-full" role="radiogroup" aria-label="거래 상태" style={options.length === 3 ? undefined : { gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
        {options.map(([k, v]) => <label key={k}><input type="radio" name={name} value={k} checked={post.status === k} onChange={() => onChange(k)} />{v}</label>)}
    </div>;
}

export function Detail({ id }: { id: string }) {
    const { me, ready, requireLogin, refreshUnread } = useApp();
    // A 404 means the post is gone; any other failure (offline, 429, 5xx) can be retried.
    const [post, setPost] = useState<DetailPost | null>(null), [error, setError] = useState<{ status: number; text: string } | null>(null);
    const [lightbox, setLightbox] = useState<string | null>(null), [offer, setOffer] = useState(false), [report, setReport] = useState(false), [confirmDelete, setConfirmDelete] = useState(false);
    const [priceOpen, setPriceOpen] = useState(false), [usage, setUsage] = useState<Usage | null>(null), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now());
    const load = () => api<{ post: DetailPost }>('posts/' + id).then(d => { setError(null); setPost(d.post); }).catch(e => setError({ status: e instanceof ApiError ? e.status : 0, text: errorText(e) }));
    const mine = !!post && me?.id === post.author_id;
    const loadUsage = () => api<Usage>('me/usage').then(setUsage).catch(() => setUsage(null));
    // Waits for the session check, so a full page load asks for the post once.
    useEffect(() => { if (!ready) return; void load(); }, [id, me?.id, ready]);
    // The author's counters for 끌올 and 게시판 상단 노출.
    useEffect(() => { if (mine) void loadUsage(); else setUsage(null); }, [mine, me?.id]);
    useEffect(() => { if (post) setPageTitle(post.title); }, [post?.title]);
    // Back to this post: return to where the member was once the post is on screen.
    useLayoutEffect(() => {
        if (!post) return;
        const y = takeScrollRestore();
        if (y !== null) window.scrollTo(0, y);
    }, [!!post]);
    useEffect(() => { if (me && post && post.author_id !== me.id) api(`posts/${id}/view`, 'POST', {}).catch(() => {}); }, [me?.id, post?.id]);
    // The 끌올 button turns on by itself when the gap ends.
    const nextBump = post && usage ? (post.bumped_at || post.created_at) + (usage.perks.bumpGapHours || 0) * HOUR : 0;
    useEffect(() => {
        if (!nextBump || nextBump <= now) return;
        const t = setTimeout(() => setNow(Date.now()), Math.min(nextBump - now + 500, 2 ** 31 - 1));
        return () => clearTimeout(t);
    }, [nextBump, now]);

    if (error) return <div className="container page">{error.status === 404
        ? <EmptyState icon="file" title="삭제되었거나 없는 글입니다" action={<Link to="/trade" className="btn btn-primary">목록으로</Link>} />
        : <EmptyState title="글을 불러오지 못했습니다" text={error.text} action={<button type="button" className="btn btn-line" onClick={() => { setError(null); void load(); }}>다시 시도</button>} />}</div>;
    if (!post) return <div className="container page"><SkeletonRows count={3} height={160} /></div>;

    const manager = me?.role === 'manager';
    // A post hidden by 회원 탈퇴 cannot be published again, and its author takes no chats or offers.
    const withdrawnPost = !!post.author_deleted || post.hidden_reason === '탈퇴';
    // Only the manager and the author see a hidden post, and a hidden post takes no offers.
    const canOffer = !mine && !withdrawnPost && !post.hidden && post.status === 'open' && post.kind === 'sell' && (post.accepts_offers === 1 || post.price_mode === 'offer');
    const exchangeWanted = post.details.wantedCategory || 'account';
    // A 대리(진행) post whose author lost 대리 인증 is off every list; the author may only close it.
    const lostProxy = mine && post.kind === 'proxy_offer' && !manager && !me?.badges.includes('proxy');
    const openNow = post.status === 'open' && !post.hidden;

    // 끌올: '오늘 2/6', '15:40부터 가능' or '오늘 끌올 모두 사용'.
    const bump = !usage ? { disabled: true, hint: '' }
        : !openNow || lostProxy ? { disabled: true, hint: '' }
        : nextBump > now ? { disabled: true, hint: `${kstClock(nextBump)}부터 가능` }
        : usage.bumpsLeft === 0 ? { disabled: true, hint: '오늘 끌올 모두 사용' }
        : { disabled: false, hint: usage.perks.bumpsPerDay === null ? '' : `오늘 ${usage.bumpsToday}/${usage.perks.bumpsPerDay}` };
    const slots = usage?.perks.boardSlots || 0, slotsUsed = usage?.featured.length || 0;

    async function startChat() {
        requireLogin(async () => {
            try { const d = await api<{ id: string }>('chats', 'POST', { userId: post!.author_id, postId: post!.id }); refreshUnread(); void navigate(`/chat/${d.id}?post=${post!.id}`); }
            catch (e) { toast.error(errorText(e)); }
        });
    }
    // The manager account's id is 'manager' (worker/http.ts MANAGER_ID).
    async function managerChat() {
        try { const d = await api<{ id: string }>('chats', 'POST', { userId: 'manager' }); void navigate('/chat/' + d.id); }
        catch (e) { toast.error(errorText(e)); }
    }
    async function favorite() {
        requireLogin(async () => {
            try { await api(`posts/${post!.id}/favorite`, 'POST', { active: !post!.favorite }); setPost({ ...post!, favorite: !post!.favorite }); toast(post!.favorite ? '찜 해제' : '찜 완료'); }
            catch (e) { toast.error(errorText(e)); }
        });
    }
    async function setStatus(status: string) {
        if (busy || status === post!.status) return;
        setBusy(true);
        try { await api(`posts/${post!.id}/status`, 'PATCH', { status }); toast(`상태 변경: ${STATUS_NAMES[status]}`); await load(); void loadUsage(); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    async function bumpNow() {
        if (busy || bump.disabled) return;
        setBusy(true);
        try { await api(`posts/${post!.id}/bump`, 'POST', {}); toast('끌올 완료'); await Promise.all([load(), loadUsage()]); setNow(Date.now()); }
        catch (e) { toast.error(errorText(e)); void loadUsage(); }
        finally { setBusy(false); }
    }
    async function feature(active: boolean) {
        if (busy) return;
        setBusy(true);
        try {
            const d = await api<{ featured: boolean; replaced: { id: number; title: string } | null }>(`posts/${post!.id}/feature`, 'PUT', { active });
            setPost({ ...post!, featured: d.featured });
            toast(d.featured ? '상단 노출 완료' : '상단 노출 해제');
            if (d.replaced) toast(`‘${d.replaced.title}’ 상단 노출 해제`);
            void loadUsage();
        }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    async function remove() {
        try { await api('posts/' + post!.id, 'DELETE'); toast('삭제 완료'); void navigate(withParams('/trade', { kind: post!.kind, category: post!.category }), { replace: true }); }
        catch (e) { toast.error(errorText(e)); }
    }
    async function hide(hidden: boolean) {
        try { await api('manage/visibility', 'POST', { postId: post!.id, hidden }); toast(hidden ? '숨김 완료' : '공개 완료'); void load(); }
        catch (e) { toast.error(errorText(e)); }
    }

    const sectionTitle = post.kind === 'buy' ? '원하는 조건' : post.kind === 'exchange' ? '교환 조건' : post.kind.startsWith('proxy') ? (post.kind === 'proxy_request' ? '요청 내용' : '진행 내용') : `${categoryName(post.category)} 정보`;
    // The rows of each section are built first; a section without any is left out.
    let info: ReactNode[];
    if (post.kind === 'exchange') {
        const offered = post.category === 'account' ? offeredBlocks(post) : genericBlocks(post, 'clan');
        const wanted = exchangeWanted === 'account' ? wantedBlocks(post, 'wanted') : [];
        info = [
            ...offered.length ? [<h3 key="offered-h">내놓는 {categoryName(post.category)}</h3>, <Fragment key="offered">{offered}</Fragment>] : [],
            <h3 key="wanted-h">구하는 {categoryName(exchangeWanted)}</h3>,
            wanted.length ? <Fragment key="wanted">{wanted}</Fragment> : <p className="muted" key="wanted">따로 정한 조건 없음 · 내용 참고</p>,
        ];
    } else info = post.category === 'account' ? (post.kind === 'buy' ? wantedBlocks(post) : offeredBlocks(post)) : genericBlocks(post, post.category);

    const bumpButton = (cls: string) => <button type="button" className={'btn btn-line ' + cls} disabled={bump.disabled || busy} onClick={bumpNow}>
        <span>끌올</span>{bump.hint && <small className="bump-hint">{bump.hint}</small>}</button>;

    return <div className="container page detail-page">
        <div className="detail-layout">
            <article>
                <nav className="crumbs" aria-label="위치">
                    <Link to={withParams('/trade', { kind: post.kind })}>{KIND_NAMES[post.kind]}</Link><ChevronRight size={14} />
                    <Link to={withParams('/trade', { kind: post.kind, category: post.category, wantedCategory: post.kind === 'exchange' ? exchangeWanted : '' })}>{post.kind === 'exchange' ? `${categoryName(post.category)}에서 ${categoryName(exchangeWanted)} 구함` : categoryName(post.category)}</Link>
                </nav>
                {mine && !manager && post.hidden === 1 && !withdrawnPost && <div className="alert hidden-note">
                    <span className="grow">숨김 처리된 글입니다{post.hidden_reason ? ` · 사유: ${post.hidden_reason}` : ''}</span>
                    <button type="button" className="btn btn-line btn-sm" onClick={managerChat}>매니저 채팅</button>
                </div>}
                <h1 className="detail-title">{post.title}</h1>
                {/* Phones: the full price line with every struck earlier 즉거가 sits under the title. */}
                <div className="price-top"><PriceLine post={post} large /></div>
                <div className="detail-meta">
                    {post.status !== 'open' && <span className={'status status-' + post.status}>{STATUS_NAMES[post.status]}</span>}
                    {post.hidden === 1 && <span className="status status-closed">숨김</span>}
                    <span>{kstDate(post.created_at)} 등록{post.bump_count ? ` · 끌올 ${post.bump_count}회` : ''}</span>
                </div>
                {/* On phones the author and their verification checks come right under the title. */}
                <AuthorBox post={post} className="author-box-top" />
                {post.images.length > 0 && <div className="gallery">{post.images.map((img, i) => <button type="button" key={img} onClick={() => setLightbox(img)} aria-label={`사진 ${i + 1} 크게 보기`}><img src={imageUrl(img)} alt="" loading="lazy" /></button>)}</div>}

                {info.length > 0 && <section className="detail-section">
                    <h2>{sectionTitle}</h2>
                    {info}
                </section>}
                {post.body.trim() && <section className="detail-section">
                    <h2>내용</h2>
                    <p className="body-text">{post.body}</p>
                </section>}
                <div className="row muted small detail-tools">
                    <button type="button" className="btn btn-text small" onClick={() => { void navigator.clipboard?.writeText(location.href).then(() => toast('링크 복사 완료')); }}><Link2 size={15} />링크 복사</button>
                    {!mine && <button type="button" className="btn btn-text small" onClick={() => requireLogin(() => setReport(true))}><Flag size={15} />신고</button>}
                    <span className="grow" /><span>글 번호 {post.id}</span>
                </div>
            </article>

            <aside className="side-card" aria-label="가격과 문의">
                <PriceLine post={post} large />
                {mine ? <div className="owner-tools">
                    <StatusSeg post={post} name="status-side" lostProxy={lostProxy} onChange={setStatus} />
                    <div className="owner-bump">{bumpButton('btn-block')}</div>
                    {post.kind === 'sell' && <button type="button" className="btn btn-line btn-block" onClick={() => setPriceOpen(true)}>가격 수정</button>}
                    <Link to={'/edit/' + post.id} className="btn btn-line btn-block">수정</Link>
                    <button type="button" className="btn btn-text owner-delete" onClick={() => setConfirmDelete(true)}>삭제</button>
                </div> : !withdrawnPost && <div className={'side-actions' + (canOffer ? ' with-offer' : '')}>
                    <button type="button" className="btn btn-primary btn-lg" onClick={startChat}><MessageCircle size={19} />채팅하기</button>
                    {canOffer && <button type="button" className="btn btn-line btn-lg" onClick={() => requireLogin(() => setOffer(true))}>제시하기</button>}
                    <button type="button" className={'btn btn-line btn-lg' + (post.favorite ? ' is-on' : '')} aria-pressed={!!post.favorite} aria-label={post.favorite ? '찜 해제' : '찜하기'} onClick={favorite}><Heart size={19} fill={post.favorite ? 'currentColor' : 'none'} /></button>
                </div>}
                {lostProxy && <p className="muted small">대리 인증이 없어 목록에 표시되지 않습니다.</p>}
                {/* 게시판 상단 노출 for 프리미엄 and above; lower grades see where it comes from. Others see nothing. */}
                {mine && usage && (slots > 0
                    ? <div className="promo-row">
                        <label className="switch"><input type="checkbox" role="switch" checked={!!post.featured} disabled={busy || lostProxy || (!post.featured && !openNow)} onChange={e => feature(e.target.checked)} />게시판 상단 노출</label>
                        <span className="owner-hint">{slotsUsed}/{slots}자리 사용</span>
                    </div>
                    : <Link to="/guide#grade" className="promo-up">게시판 상단 노출은 프리미엄부터</Link>)}
                {manager && !mine && <div className="row">{!withdrawnPost && <button type="button" className="btn btn-line btn-sm grow" onClick={() => hide(!post.hidden)}>{post.hidden ? '다시 공개' : '숨기기'}</button>}<button type="button" className="btn btn-danger btn-sm grow" onClick={() => setConfirmDelete(true)}>삭제</button></div>}
                <AuthorBox post={post} className="author-box-side" />
                <p className="safety">입금 전 <a href="https://thecheat.co.kr" target="_blank" rel="noreferrer">더치트</a>로 상대 전번·계좌 조회. 사이트는 거래를 보증하지 않습니다.</p>
            </aside>
        </div>

        {mine ? <div className="owner-bar">
            <StatusSeg post={post} name="status-bar" lostProxy={lostProxy} onChange={setStatus} />
            {bumpButton('owner-bar-bump')}
            <DropdownMenu.Root modal={false}>
                <DropdownMenu.Trigger className="icon-btn" aria-label="더보기"><MoreHorizontal size={22} /></DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                    <DropdownMenu.Content className="menu" align="end" side="top" sideOffset={8}>
                        {post.kind === 'sell' && <DropdownMenu.Item className="menu-item" onSelect={() => setPriceOpen(true)}>가격 수정</DropdownMenu.Item>}
                        <DropdownMenu.Item className="menu-item" onSelect={() => void navigate('/edit/' + post.id)}>수정</DropdownMenu.Item>
                        <DropdownMenu.Item className="menu-item menu-danger" onSelect={() => setConfirmDelete(true)}>삭제</DropdownMenu.Item>
                    </DropdownMenu.Content>
                </DropdownMenu.Portal>
            </DropdownMenu.Root>
        </div> : !withdrawnPost && <div className="mobile-cta">
            <PriceLine post={post} />
            <button type="button" className={'icon-btn' + (post.favorite ? ' is-on' : '')} aria-label={post.favorite ? '찜 해제' : '찜하기'} onClick={favorite}><Heart size={22} fill={post.favorite ? 'currentColor' : 'none'} /></button>
            {canOffer && <button type="button" className="btn btn-line" onClick={() => requireLogin(() => setOffer(true))}>제시하기</button>}
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
        {mine && post.kind === 'sell' && <PriceModal open={priceOpen} onClose={() => setPriceOpen(false)} post={post} onSaved={p => setPost(p)} />}
        <ReportModal open={report} onClose={() => setReport(false)} postId={post.id} />
        <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="글 삭제" description="복구할 수 없습니다."
            footer={<><button className="btn btn-line" onClick={() => setConfirmDelete(false)}>취소</button><button className="btn btn-danger-solid" onClick={remove}>삭제</button></>} />
    </div>;
}

function AuthorBox({ post, className }: { post: Post; className: string }) {
    // A withdrawn author has no profile; the name is plain 탈퇴회원 without grade or badges.
    if ((post as Post & { author_deleted?: boolean }).author_deleted) return <div className={'author-box ' + className}>
        <Avatar name={post.nickname} />
        <span className="grow"><NameLine nickname={post.nickname} /></span>
    </div>;
    return <Link to={'/profile/' + post.author_id} className={'author-box ' + className}>
        <Avatar name={post.nickname} />
        <span className="grow"><NameLine nickname={post.nickname} grade={post.author_grade} role={post.role} badges={post.author_badges} /><span className="author-stats">프로필 보기</span></span>
        <ChevronRight size={18} className="muted" />
    </Link>;
}

function OfferModal({ open, onClose, post }: { open: boolean; onClose: () => void; post: Post }) {
    const [amount, setAmount] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false);
    const won = manToWon(amount);
    const current = post.details.currentOffer ? Number(post.details.currentOffer) : null;
    const context = [post.price !== null ? `즉거가 ${priceText(post.price)}` : '', current ? `현젯 ${priceText(current)}` : ''].filter(Boolean).join(' · ');
    // Chips count down from 즉거가 in 만원 and never go below 0.1 (1,000원).
    const fromPrice = (minus: number) => setAmount(String(Math.max(0.1, Number((post.price! / 10000 - minus).toFixed(4)))));
    async function send() {
        if (won === null || Number.isNaN(won)) { toast.error('제시가를 만원 단위로 입력해 주세요. 예: 45'); return; }
        setBusy(true);
        try { const d = await api<{ chatId: string }>('offers', 'POST', { postId: post.id, amount: won, note }); onClose(); toast('제시 완료'); void navigate('/chat/' + d.chatId); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    return <Modal open={open} onClose={onClose} title="가격 제시" description="수락되면 글이 예약중으로 바뀝니다."
        footer={<button className="btn btn-primary btn-lg" disabled={busy || !amount} onClick={send}>제시하기</button>}>
        <div className="form-stack">
            {context && <p className="offer-context">{context}</p>}
            <label className="field"><span className="field-label">제시가</span><div className="input-unit"><input className="input" type="number" inputMode="decimal" min="0.1" step="0.1" value={amount} onChange={e => setAmount(e.target.value)} placeholder="예: 45" autoFocus /><span>만원</span></div>
                {won !== null && !Number.isNaN(won) && <span className="field-hint">{won.toLocaleString('ko-KR')}원</span>}</label>
            {post.price !== null && <div className="chip-row offer-chips">{([['즉거가로', 0], ['-1만', 1], ['-3만', 3], ['-5만', 5]] as const).map(([label, minus]) =>
                <button type="button" key={label} className="chip chip-sm" onClick={() => fromPrice(minus)}>{label}</button>)}</div>}
            <label className="field"><span className="field-label">메시지</span><input className="input" maxLength={500} value={note} onChange={e => setNote(e.target.value)} placeholder="예: 바로 쿨거 가능" /></label>
        </div>
    </Modal>;
}

// Quick 즉거가 and 현젯 change for the author of a 판매 post (PATCH /posts/:id/price).
function PriceModal({ open, onClose, post, onSaved }: { open: boolean; onClose: () => void; post: Post; onSaved: (post: DetailPost) => void }) {
    const [price, setPrice] = useState(''), [current, setCurrent] = useState(''), [busy, setBusy] = useState(false);
    useEffect(() => { if (open) { setPrice(wonToMan(post.price)); setCurrent(wonToMan(post.details.currentOffer ? Number(post.details.currentOffer) : null)); } }, [open]);
    const priceWon = manToWon(price), currentWon = manToWon(current);
    async function save() {
        if (Number.isNaN(priceWon)) { toast.error('즉거가: 만원 단위로 입력해 주세요. 예: 35'); return; }
        if (Number.isNaN(currentWon)) { toast.error('현젯: 만원 단위로 입력해 주세요. 예: 30'); return; }
        setBusy(true);
        try {
            const d = await api<{ post: DetailPost }>(`posts/${post.id}/price`, 'PATCH', { ...priceWon !== null ? { price: priceWon } : {}, currentOffer: currentWon ?? '' });
            onSaved(d.post); onClose(); toast('가격 변경 완료');
        }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    const unitField = (label: string, value: string, set: (v: string) => void, won: number | null) => <label className="field"><span className="field-label">{label}</span>
        <div className="input-unit"><input className="input" type="number" inputMode="decimal" min="0.1" step="0.1" value={value} onChange={e => set(e.target.value)} /><span>만원</span></div>
        {won !== null && !Number.isNaN(won) && <span className="field-hint">{won.toLocaleString('ko-KR')}원</span>}</label>;
    return <Modal open={open} onClose={onClose} title="가격 수정"
        footer={<button className="btn btn-primary btn-lg" disabled={busy || (priceWon === null && post.price === null && currentWon === null)} onClick={save}>저장</button>}>
        <div className="form-stack">
            {unitField('즉거가', price, setPrice, priceWon)}
            {unitField('현젯', current, setCurrent, currentWon)}
        </div>
    </Modal>;
}

function ReportModal({ open, onClose, postId }: { open: boolean; onClose: () => void; postId: number }) {
    const [reason, setReason] = useState<string>(REPORT_REASONS[0]), [details, setDetails] = useState(''), [busy, setBusy] = useState(false);
    async function send() {
        setBusy(true);
        try { await api('reports', 'POST', { postId, reason, details }); onClose(); setDetails(''); toast('신고 접수 완료'); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    return <Modal open={open} onClose={onClose} title="신고" footer={<button className="btn btn-primary btn-lg" disabled={busy || !details.trim()} onClick={send}>신고</button>}>
        <div className="form-stack">
            <div className="chip-row">{REPORT_REASONS.map(r => <button type="button" key={r} className="chip chip-sm" aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>)}</div>
            <label className="field"><span className="field-label">내용</span><textarea className="textarea" style={{ minHeight: 120 }} maxLength={1000} value={details} onChange={e => setDetails(e.target.value)} placeholder="예: 입금 후 잠수, 사진 도용" /></label>
        </div>
    </Modal>;
}

