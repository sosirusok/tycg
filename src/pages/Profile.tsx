import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Ban, Bell, BellRing, ChevronRight, Flag, MessageCircle, Pencil, ThumbsDown, ThumbsUp } from 'lucide-react';
import { toast } from 'sonner';
import { dateText, longDate, priceText, reviewName, suspendUntilText, tradeStatsText, type Post, type Review, type User } from '../../shared/market';
import { ALERT_TEXT, BADGES, GRADES, gradeInfo, trialStatus } from '../../shared/membership';
import { ApiError, api, errorText } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { lastSeenText } from '../lib/lastSeen';
import { offerPush, setPageTitle, useApp } from '../app/state';
import { gradeBenefits } from '../app/ApplyModal';
import { Avatar, CIcon, EmptyState, Modal, NameLine, SkeletonRows, Tabs, VerifiedMark } from '../components/ui';
import { PostCard } from '../components/PostCard';
import { MemberReportModal } from '../components/MemberReport';
import { WalletGauge, couponItem, useMinuteClock, type Usage } from '../components/Wallet';

// "10월 31일" on the Korean calendar.
const monthDay = (t: number) => new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

// suspended: under 이용 정지 now; suspended_until (until when) reaches only the member and the manager.
// tradeCount, dealSum (거금), goodCount and reviewCount (WP23): trades as seller or buyer, 좋아요 received, 후기 received.
type Profile = User & { postCount: number; closedCount: number; tradeCount?: number; dealSum?: number; goodCount?: number; reviewCount?: number; prev_nickname?: string; nickname_next_at?: number; deleted?: boolean; blocked?: boolean; last_seen_at?: number | null; suspended?: boolean;
    // 판매자 구독 (WP54): whether the viewer follows the member, '구독 허용', and (own profile) the follower count.
    followed?: boolean; follow_allowed?: boolean; follower_count?: number };
// One row of the 후기 tab: the 후기 plus its author's name line (탈퇴회원 once they left).
// brokered: the trade of the 후기 was brokered by the manager (운영진 중개, WP65).
type ReviewRow = Review & { nickname: string; role: string; grade: string; grade_trial?: boolean; badges: string[]; author_deleted?: boolean; brokered?: number };
// One row of the 거래 기록 tab (WP51): a counted trade with the member's side (sold: seller), the title kept
// with the trade, 거래가 and the other member's name line.
type TradeRow = { id: string; post_id: number; created_at: number; price: number | null; kind: string; sold: boolean; title: string; post_gone: boolean; post_hidden: boolean; brokered: boolean;
    partner_id: string | null; nickname: string; role: string; grade: string; grade_trial?: boolean; badges: string[]; partner_deleted?: boolean };
type ProfileTab = 'active' | 'closed' | 'trades' | 'reviews';
const PAGE_SIZE = 20;

export default function ProfilePage({ id }: { id?: string }) {
    const { me, setMe, refreshMe, requireLogin, openApply, logout } = useApp();
    // A 404 means there is no such member; any other failure (offline, 429, 5xx) can be retried.
    const [user, setUser] = useState<Profile | null>(null), [error, setError] = useState<{ status: number; text: string } | null>(null), [retry, setRetry] = useState(0);
    const [tab, setTab] = useState<ProfileTab>('active'), [posts, setPosts] = useState<Post[] | null>(null), [total, setTotal] = useState(0);
    const [capped, setCapped] = useState({ on: false, full: false });
    const [page, setPage] = useState(1), [loadingMore, setLoadingMore] = useState(false);
    const [usage, setUsage] = useState<Usage | null>(null), [blockBusy, setBlockBusy] = useState(false), [followBusy, setFollowBusy] = useState(false);
    const [clock] = useMinuteClock();
    const [editing, setEditing] = useState(false), [nickname, setNickname] = useState(''), [bio, setBio] = useState(''), [saving, setSaving] = useState(false), [editError, setEditError] = useState('');
    const [postsVersion, setPostsVersion] = useState(0);
    // Counts list resets (tab switch, profile save), so a '더 보기' page for an old list is dropped.
    const listGen = useRef(0);
    const [account, setAccount] = useState<'' | 'password' | 'withdraw'>(''), [reporting, setReporting] = useState(false);
    const mine = me?.id === id;

    useEffect(() => {
        api<{ user: Profile }>('users/' + id).then(d => { setError(null); setUser(d.user); })
            .catch(e => setError({ status: e instanceof ApiError ? e.status : 0, text: errorText(e) }));
    }, [id, me?.grade, me?.badges.length, retry]);
    useEffect(() => { if (user) setPageTitle(user.nickname); }, [user?.nickname]);
    const postsPage = (n: number) => api<{ posts: Post[]; total: number; capped?: boolean }>('posts?' + new URLSearchParams({ author: id || '', size: String(PAGE_SIZE), page: String(n), ...(tab === 'active' ? { active: '1' } : { status: 'closed' }) }));
    useEffect(() => {
        let alive = true;
        listGen.current++;
        setPosts(null); setPage(1);
        // The 거래 기록 and 후기 tabs load their own lists (TradeList, ReviewList).
        if (tab === 'reviews' || tab === 'trades') return;
        postsPage(1).then(d => { if (alive) { setPosts(d.posts); setTotal(d.total); setCapped({ on: !!d.capped, full: d.posts.length === PAGE_SIZE }); } }).catch(() => { if (alive) setPosts([]); });
        return () => { alive = false; };
    }, [id, tab, postsVersion]);
    // The owner's 끌올 gauge: '끌올 3/4 · 1:20 후 충전' (counting down once a minute).
    useEffect(() => {
        if (!mine || me?.role === 'manager') { setUsage(null); return; }
        let alive = true;
        api<Usage>('me/usage').then(d => { if (alive) setUsage(d); }).catch(() => {});
        return () => { alive = false; };
    }, [mine, me?.grade, me?.role]);

    if (error) return <div className="container page">{error.status === 404
        ? <EmptyState icon="search" title="없는 회원입니다" />
        : <EmptyState title="회원 정보를 불러오지 못했습니다" text={error.text} action={<button type="button" className="btn btn-line" onClick={() => { setError(null); setRetry(n => n + 1); }}>다시 시도</button>} />}</div>;
    if (!user) return <div className="container page"><SkeletonRows count={2} height={160} /></div>;
    if (user.deleted) return <div className="container page"><EmptyState title="탈퇴한 회원입니다" /></div>;

    async function save() {
        setSaving(true); setEditError('');
        try {
            await api('users/' + user!.id, 'PUT', { nickname, bio });
            // The server stores the nickname in a normalized form, so read it back; the post cards
            // below carry the author's nickname too.
            const d = await api<{ user: Profile }>('users/' + user!.id);
            setUser(d.user);
            setPostsVersion(v => v + 1);
            await refreshMe();
            setEditing(false); toast('저장 완료');
        } catch (e) { setEditError(errorText(e)); }
        finally { setSaving(false); }
    }
    // A member may change their nickname once every 30 days (the manager's is fixed).
    const nicknameLocked = !!user.nickname_next_at && user.nickname_next_at > Date.now();
    const chat = () => requireLogin(async () => {
        try { const d = await api<{ id: string }>('chats', 'POST', { userId: user.id }); void navigate('/chat/' + d.id); }
        catch (e) { toast.error(errorText(e)); }
    });
    // 구독 / 구독 중 (WP54): new posts of this member reach the 알림함.
    const follow = () => requireLogin(async () => {
        if (followBusy) return;
        const active = !user.followed;
        setFollowBusy(true);
        try { await api(`users/${user.id}/follow`, 'POST', { active }); setUser(v => v && { ...v, followed: active }); toast(active ? ALERT_TEXT.followed : ALERT_TEXT.unfollowed); if (active) offerPush(); }
        catch (e) { toast.error(errorText(e)); }
        finally { setFollowBusy(false); }
    });
    // '구독 허용' (WP54): saved at once; off also stops 알림 to members who already follow.
    async function setFollowAllowed(on: boolean) {
        if (followBusy) return;
        setFollowBusy(true);
        try { await api('users/me', 'PATCH', { follow_allowed: on }); setUser(v => v && { ...v, follow_allowed: on }); }
        catch (e) { toast.error(errorText(e)); }
        finally { setFollowBusy(false); }
    }
    const block = () => requireLogin(async () => {
        if (blockBusy) return;
        const active = !user.blocked;
        setBlockBusy(true);
        try { await api('blocks', 'POST', { userId: user.id, active }); setUser(v => v && { ...v, blocked: active }); toast(active ? '차단 완료' : '차단 해제'); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBlockBusy(false); }
    });
    // '더 보기' adds the next page under the posts already shown.
    async function more() {
        if (loadingMore || !posts) return;
        setLoadingMore(true);
        const gen = listGen.current;
        try {
            const d = await postsPage(page + 1);
            if (gen !== listGen.current) return;
            const seen = new Set(posts.map(p => p.id));
            setPosts([...posts, ...d.posts.filter(p => !seen.has(p.id))]);
            // An empty page means the list shrank meanwhile: stop offering more. The count stops at 301
            // ('300+'): past it, a full page means there may be more.
            setTotal(d.posts.length ? d.total : posts.length);
            setCapped({ on: !!d.capped && !!d.posts.length, full: d.posts.length === PAGE_SIZE });
            setPage(page + 1);
        } catch (e) { if (gen === listGen.current) toast.error(errorText(e)); }
        finally { setLoadingMore(false); }
    }
    // A 플러스 무료 체험 is the member's own business: others (the manager aside) see 일반.
    const trialing = !!user.grade_trial && !!user.grade_expires_at;
    const grade = gradeInfo(user.grade_trial && !mine && me?.role !== 'manager' ? 'normal' : user.grade);
    // The next grade up for sale and the first thing it adds, on the owner's own grade card.
    // While on the 플러스 체험 the card already says 플러스 and the trial line covers keeping it, so the
    // next grade is 프리미엄, as for a paid 플러스 member.
    const nextGrade = user.role === 'manager' ? undefined : GRADES.find(g => g.rank === grade.rank + 1 && g.plans.length);
    return <div className="container page profile">
        <section className="profile-head">
            <Avatar name={user.nickname} size="lg" />
            <div className="grow">
                <NameLine nickname={user.nickname} grade={user.grade} trial={user.grade_trial} role={user.role} badges={user.badges} size="lg" />
                {/* 이용 정지: the member (and the manager) see until when; others see only '이용 제한 회원'. */}
                {user.suspended && <p className="mt-8"><span className="tag">{user.suspended_until ? `이용 정지 중 (${suspendUntilText(user.suspended_until)})` : '이용 제한 회원'}</span></p>}
                {user.prev_nickname && <p className="muted small mt-8">이전 닉네임: {user.prev_nickname}</p>}
                {/* The one trade count: trades confirmed with another member ('거래 3회 · 후기 좋아요 2'), also at 0 (WP51). */}
                <p className="profile-trades">{tradeStatsText(user.tradeCount ?? 0, user.goodCount ?? 0, user.dealSum ?? 0)}</p>
                <p className="muted small mt-8">{dateText(user.created_at)} 가입 · 거래글 {user.postCount}</p>
                {/* Other members' 최근 접속 (on one's own profile it would always read 10분 이내). */}
                {!mine && user.last_seen_at && <p className="muted small profile-seen">{lastSeenText(user.last_seen_at)}</p>}
                {user.bio && <p className="profile-bio">{user.bio}</p>}
            </div>
            <div className="profile-actions">
                {mine ? <button type="button" className="btn btn-line btn-sm" onClick={() => { setNickname(user.nickname); setBio(user.bio); setEditError(''); setEditing(true); }}><Pencil size={15} />프로필 수정</button>
                    : <>
                        <button type="button" className="btn btn-primary btn-sm" onClick={chat}><MessageCircle size={16} />채팅하기</button>
                        {(user.follow_allowed || user.followed) && <button type="button" className={'btn btn-line btn-sm' + (user.followed ? ' is-on' : '')} aria-pressed={!!user.followed} disabled={followBusy} onClick={follow}>{user.followed ? <BellRing size={15} /> : <Bell size={15} />}{user.followed ? ALERT_TEXT.following : ALERT_TEXT.follow}</button>}
                        {user.role !== 'manager' && <button type="button" className="btn btn-line btn-sm" aria-pressed={!!user.blocked} disabled={blockBusy} onClick={block}><Ban size={15} />{user.blocked ? '차단 해제' : '차단'}</button>}
                        {user.role !== 'manager' && me?.role !== 'manager' && <button type="button" className="btn btn-line btn-sm" onClick={() => requireLogin(() => setReporting(true))}><Flag size={15} />신고</button>}
                    </>}
            </div>
        </section>

        <section className="profile-cards">
            <div className="card card-pad">
                <h2 className="card-title">인증</h2>
                {/* 본인 인증, 대리 인증, 신용인 (the BADGES order). The owner applies from the row. */}
                <ul className="verify-list">{BADGES.map(b => {
                    const on = user.badges.includes(b.id);
                    return <li key={b.id} className={on ? 'on' : ''}><CIcon name={b.icon} size={28} /><span className="grow">{b.name}</span>{on ? <span className="verified"><VerifiedMark size={16} />인증 완료</span> : <>
                        <span className="tag tag-line">미인증</span>
                        {mine && user.role !== 'manager' && <button type="button" className="verify-apply" aria-label={b.name + ' 신청'} onClick={() => openApply({ kind: 'badge', target: b.id })}>신청</button>}
                    </>}</li>;
                })}</ul>
            </div>
            <div className="card card-pad">
                <div className="card-title-row"><h2 className="card-title">등급</h2>
                    {mine && user.role !== 'manager' && grade.rank < 3 && <button type="button" className="btn btn-line btn-sm" onClick={() => openApply({ kind: 'grade', target: grade.rank < 1 || trialing ? 'plus' : grade.rank < 2 ? 'premium' : 'elite', plan: 'permanent' })}>등급 신청</button>}</div>
                {user.role === 'manager' ? <p className="grade-big"><span className="grade grade-manager">매니저</span></p> : <>
                    <p className="grade-big"><CIcon name={grade.icon} size={36} /><strong>{grade.name}</strong></p>
                    {/* The end date of a 6-month grade reaches only the member and the manager. */}
                    {/* A trial reads '플러스 체험 · 10월 8일까지' (or '… · 내일 18:40 종료' in its last day). */}
                    {trialing && (mine || me?.role === 'manager') ? <p className="grade-trial mt-8">{trialStatus(user.grade_expires_at!)}</p>
                        : user.grade_expires_at && !user.grade_trial && <p className="muted small mt-8">{longDate(user.grade_expires_at)}까지</p>}
                    {/* '끌올 3/5 · 1:20 후 충전 · 무료 중개·가측 3/5 남음' (WP65 adds the last item; at most 3). */}
                    {mine && usage && <WalletGauge usage={usage} now={clock} className="grade-usage" extra={couponItem(usage)} />}
                    {/* One action on the card (등급 신청); the next grade is a plain data line. */}
                    {mine && nextGrade && <p className="grade-next">다음 등급: {nextGrade.name} · {gradeBenefits(nextGrade.id)[0]}</p>}
                </>}
            </div>
        </section>

        {mine && <nav className="my-menu" aria-label="내 메뉴">
            {([['/me/posts', '내 거래'], ['/me/favorites', '찜한 글'], ['/me/applications', '신청 내역'], ...(me?.role === 'manager' ? [['/manage', '매니저 메뉴']] : [])] as [string, string][]).map(([to, label]) =>
                <Link key={to} to={to}>{label}<ChevronRight size={18} /></Link>)}
            <button type="button" onClick={() => void logout()}>로그아웃</button>
        </nav>}

        <section className="section">
            <Tabs label="거래글" value={tab} onChange={setTab} items={[{ id: 'active', label: '거래중' }, { id: 'closed', label: '거래완료' }, { id: 'trades', label: '거래 기록' }, { id: 'reviews', label: '후기' }]} />
            <div className="mt-16">{tab === 'reviews' ? <ReviewList userId={user.id} /> : tab === 'trades' ? <TradeList userId={user.id} />
                : posts === null ? <SkeletonRows count={2} /> : posts.length ? <><p className="muted small" style={{ marginBottom: 12 }}>{capped.on ? `${total - 1}+` : total}건</p><div className="post-list">{posts.map(p => <PostCard key={p.id} post={p} hideAuthor />)}</div>
                {(posts.length < total || (capped.on && capped.full)) && <button type="button" className="btn btn-line more-btn" disabled={loadingMore} onClick={more}>더 보기</button>}</>
                : <EmptyState icon="file" title={tab === 'active' ? '거래중인 글이 없습니다' : '거래완료된 글이 없습니다'} action={mine && tab === 'active' ? <button className="btn btn-primary" onClick={() => void navigate('/write')}>글쓰기</button> : undefined} />}</div>
        </section>

        <Modal open={editing} onClose={() => setEditing(false)} title="프로필 수정" footer={<button className="btn btn-primary btn-lg" disabled={saving} onClick={save}>저장</button>}>
            <div className="form-stack">
                <div className="field"><label className="field-label" htmlFor="profile-nickname">닉네임</label>
                    <input id="profile-nickname" className="input" value={nickname} onChange={e => setNickname(e.target.value)} minLength={2} maxLength={16} disabled={user.role === 'manager' || nicknameLocked} aria-describedby={user.role === 'manager' ? undefined : 'profile-nickname-hint'} />
                    {user.role !== 'manager' && <span id="profile-nickname-hint" className="field-hint">{nicknameLocked ? `${monthDay(user.nickname_next_at!)}부터 변경 가능` : '30일에 한 번 변경 가능'}</span>}</div>
                <label className="field"><span className="field-label">소개</span><textarea className="textarea" style={{ minHeight: 110 }} maxLength={300} value={bio} onChange={e => setBio(e.target.value)} placeholder="예: 래더계 위주 거래, 밤에 답장 빠름" /></label>
                {editError && <p className="field-error" role="alert">{editError}</p>}
                <div className="follow-setting">
                    <label className="switch"><input type="checkbox" role="switch" checked={user.follow_allowed !== false} disabled={followBusy} onChange={e => void setFollowAllowed(e.target.checked)} />{ALERT_TEXT.allow}</label>
                    {user.follower_count !== undefined && <span className="muted small">구독자 {user.follower_count}명</span>}
                </div>
                <div className="row">
                    <button type="button" className="btn btn-line btn-sm" onClick={() => { setEditing(false); setAccount('password'); }}>비밀번호 변경</button>
                    {user.role !== 'manager' && <button type="button" className="btn btn-text small" style={{ marginLeft: 'auto' }} onClick={() => { setEditing(false); setAccount('withdraw'); }}>회원 탈퇴</button>}
                </div>
            </div>
        </Modal>
        {!mine && <MemberReportModal open={reporting} onClose={() => setReporting(false)} userId={user.id} nickname={user.nickname} />}
        <PasswordModal open={account === 'password'} onClose={() => setAccount('')} />
        <WithdrawModal open={account === 'withdraw'} onClose={() => setAccount('')} onDone={() => { setAccount(''); setMe(null); void navigate('/'); toast('탈퇴 완료'); }} />
    </div>;
}

// The 후기 a member received, newest first, 20 at a time with '더 보기' (GET /users/:id/reviews).
function ReviewList({ userId }: { userId: string }) {
    const [rows, setRows] = useState<ReviewRow[] | null>(null), [total, setTotal] = useState(0), [page, setPage] = useState(1), [busy, setBusy] = useState(false);
    const load = (n: number) => api<{ reviews: ReviewRow[]; total: number }>(`users/${userId}/reviews?page=${n}`);
    useEffect(() => {
        let alive = true;
        setRows(null); setPage(1);
        load(1).then(d => { if (alive) { setRows(d.reviews); setTotal(d.total); } }).catch(() => { if (alive) setRows([]); });
        return () => { alive = false; };
    }, [userId]);
    async function more() {
        if (busy || !rows) return;
        setBusy(true);
        try {
            const d = await load(page + 1), seen = new Set(rows.map(r => r.id));
            setRows([...rows, ...d.reviews.filter(r => !seen.has(r.id))]);
            setTotal(d.reviews.length ? d.total : rows.length);
            setPage(page + 1);
        } catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    if (rows === null) return <SkeletonRows count={2} height={72} />;
    if (!rows.length) return <EmptyState title="받은 후기가 없습니다" />;
    return <>
        {/* Every confirmed trade is listed; the trust line's '거래 N회' counts a partner once per 30 days. */}
        <p className="muted small" style={{ marginBottom: 12 }}>전체 {total}건 · 거래 횟수는 같은 회원 30일 1번</p>
        <ul className="review-list">{rows.map(r => <li key={r.id}>
            <div className="review-head">
                {r.author_deleted ? <NameLine nickname={r.nickname} compact /> : <Link to={'/profile/' + r.author_id} className="review-who"><NameLine nickname={r.nickname} grade={r.grade} trial={r.grade_trial} role={r.role} badges={r.badges} compact /></Link>}
                <time className="review-date">{dateText(r.created_at)}</time>
            </div>
            <div className="review-line">
                <span className="review-verdict">{r.good ? <ThumbsUp size={16} /> : <ThumbsDown size={16} />}{reviewName(r.good)}</span>
                {r.tags.map(t => <span key={t} className="tag">{t}</span>)}
                {!!r.brokered && <span className="tag tag-line">운영진 중개</span>}
            </div>
            {r.text && <p className="review-text">{r.text}</p>}
        </li>)}</ul>
        {rows.length < total && <button type="button" className="btn btn-line more-btn" disabled={busy} onClick={() => void more()}>더 보기</button>}
    </>;
}

// The member's side of a trade, as the board names it.
function sideName(t: TradeRow) {
    if (t.kind === 'exchange') return '교환';
    if (t.kind === 'proxy_request' || t.kind === 'proxy_offer') return t.sold ? '대리(진행)' : '대리(구함)';
    return t.sold ? '판매' : '구매';
}

// 거래 기록 (WP51): the member's confirmed trades, newest first, 20 at a time (GET /users/:id/trades). A deleted
// post keeps the title the trade saved, marked '삭제된 글'; a hidden one is not linked.
function TradeList({ userId }: { userId: string }) {
    const [rows, setRows] = useState<TradeRow[] | null>(null), [total, setTotal] = useState(0), [page, setPage] = useState(1), [busy, setBusy] = useState(false);
    const load = (n: number) => api<{ trades: TradeRow[]; total: number }>(`users/${userId}/trades?page=${n}`);
    useEffect(() => {
        let alive = true;
        setRows(null); setPage(1);
        load(1).then(d => { if (alive) { setRows(d.trades); setTotal(d.total); } }).catch(() => { if (alive) setRows([]); });
        return () => { alive = false; };
    }, [userId]);
    async function more() {
        if (busy || !rows) return;
        setBusy(true);
        try {
            const d = await load(page + 1), seen = new Set(rows.map(r => r.id));
            setRows([...rows, ...d.trades.filter(r => !seen.has(r.id))]);
            setTotal(d.trades.length ? d.total : rows.length);
            setPage(page + 1);
        } catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    if (rows === null) return <SkeletonRows count={2} height={72} />;
    if (!rows.length) return <EmptyState title="거래 기록이 없습니다" />;
    return <>
        {/* Every confirmed trade is listed; the trust line's '거래 N회' counts a partner once per 30 days. */}
        <p className="muted small" style={{ marginBottom: 12 }}>전체 {total}건 · 거래 횟수는 같은 회원 30일 1번</p>
        <ul className="review-list trade-list">{rows.map(t => <li key={t.id}>
            <div className="review-head">
                <span className="trade-title"><span className="tag">{sideName(t)}</span>
                    {t.post_gone || t.post_hidden ? <span className="trade-title-text">{t.title || '삭제된 글'}</span> : <Link to={'/posts/' + t.post_id} className="trade-title-text">{t.title}</Link>}
                    {t.post_gone && t.title && <span className="tag tag-line">삭제된 글</span>}</span>
                <time className="review-date">{dateText(t.created_at)}</time>
            </div>
            <div className="review-line">
                {t.partner_deleted || !t.partner_id ? <NameLine nickname={t.nickname} compact /> : <Link to={'/profile/' + t.partner_id} className="review-who"><NameLine nickname={t.nickname} grade={t.grade} trial={t.grade_trial} role={t.role} badges={t.badges} compact /></Link>}
                {t.price !== null && <span className="trade-price">거래가 {priceText(t.price)}</span>}
                {t.brokered && <span className="tag tag-line">운영진 중개</span>}
            </div>
        </li>)}</ul>
        {rows.length < total && <button type="button" className="btn btn-line more-btn" disabled={busy} onClick={() => void more()}>더 보기</button>}
    </>;
}

// Other devices are signed out by the change; this one stays signed in.
function PasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [again, setAgain] = useState('');
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    useEffect(() => { if (!open) { setCurrent(''); setNext(''); setAgain(''); setError(''); } }, [open]);
    const mismatch = again !== '' && again !== next;
    const ready = current !== '' && next.length >= 8 && again === next;
    async function submit(e: FormEvent) {
        e.preventDefault();
        if (busy || !ready) return;
        setBusy(true); setError('');
        try { await api('auth/password', 'POST', { current, next }); toast('비밀번호 변경 완료'); onClose(); }
        catch (err) { setError(errorText(err)); }
        finally { setBusy(false); }
    }
    return <Modal open={open} onClose={() => { if (!busy) onClose(); }} title="비밀번호 변경"
        footer={<button type="submit" form="password-form" className="btn btn-primary btn-lg" disabled={busy || !ready}>변경</button>}>
        <form id="password-form" className="form-stack" onSubmit={submit}>
            <label className="field"><span className="field-label">현재 비밀번호</span>
                <input className="input" type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} maxLength={128} required autoFocus /></label>
            <label className="field"><span className="field-label">새 비밀번호</span>
                <input className="input" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} placeholder="8자 이상" minLength={8} maxLength={128} required /></label>
            <div className="field"><label className="field-label" htmlFor="password-again">새 비밀번호 확인</label>
                <input id="password-again" className="input" type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} minLength={8} maxLength={128} required
                    aria-invalid={mismatch} aria-describedby={mismatch ? 'password-again-error' : undefined} />
                {mismatch && <span id="password-again-error" className="field-error" role="alert">비밀번호가 서로 다릅니다.</span>}</div>
            {error && <p className="field-error" role="alert">{error}</p>}
        </form>
    </Modal>;
}

// The server signs the member out everywhere; `onDone` clears the app state and goes home.
function WithdrawModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
    const [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    useEffect(() => { if (!open) { setPassword(''); setError(''); } }, [open]);
    async function submit(e: FormEvent) {
        e.preventDefault();
        if (busy || !password) return;
        setBusy(true); setError('');
        try { await api('auth/withdraw', 'POST', { password }); onDone(); }
        catch (err) { setError(errorText(err)); }
        finally { setBusy(false); }
    }
    return <Modal open={open} onClose={() => { if (!busy) onClose(); }} title="회원 탈퇴" description="작성한 글은 모두 숨겨지고 복구할 수 없습니다."
        footer={<><button type="button" className="btn btn-line btn-lg" disabled={busy} onClick={onClose}>취소</button><button type="submit" form="withdraw-form" className="btn btn-danger-solid btn-lg" disabled={busy || !password}>탈퇴</button></>}>
        <form id="withdraw-form" className="form-stack" onSubmit={submit}>
            <label className="field"><span className="field-label">비밀번호</span>
                <input className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} maxLength={128} required autoFocus /></label>
            {error && <p className="field-error" role="alert">{error}</p>}
        </form>
    </Modal>;
}

