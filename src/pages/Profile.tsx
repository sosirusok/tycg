import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Ban, ChevronRight, MessageCircle, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { dateText, longDate, type Post, type User } from '../../shared/market';
import { BADGES, GRADES, gradeInfo } from '../../shared/membership';
import { ApiError, api, errorText } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { lastSeenText } from '../lib/lastSeen';
import { setPageTitle, useApp } from '../app/state';
import { gradeBenefits } from '../app/ApplyModal';
import { Avatar, CIcon, EmptyState, Modal, NameLine, SkeletonRows, Tabs, VerifiedMark } from '../components/ui';
import { PostCard } from '../components/PostCard';

// "10월 31일" on the Korean calendar.
const monthDay = (t: number) => new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

type Profile = User & { postCount: number; closedCount: number; prev_nickname?: string; nickname_next_at?: number; deleted?: boolean; blocked?: boolean; last_seen_at?: number | null };
// GET /me/usage: today's use of the grade limits (null limits are the manager's: no cap).
type Usage = { perks: { bumpsPerDay: number | null; openPosts: number | null; boardSlots: number | null }; bumpsToday: number; openPosts: number; featured: unknown[] };
const PAGE_SIZE = 20;

export default function ProfilePage({ id }: { id?: string }) {
    const { me, setMe, refreshMe, requireLogin, openApply, logout } = useApp();
    // A 404 means there is no such member; any other failure (offline, 429, 5xx) can be retried.
    const [user, setUser] = useState<Profile | null>(null), [error, setError] = useState<{ status: number; text: string } | null>(null), [retry, setRetry] = useState(0);
    const [tab, setTab] = useState<'active' | 'closed'>('active'), [posts, setPosts] = useState<Post[] | null>(null), [total, setTotal] = useState(0);
    const [page, setPage] = useState(1), [loadingMore, setLoadingMore] = useState(false);
    const [usage, setUsage] = useState<Usage | null>(null), [blockBusy, setBlockBusy] = useState(false);
    const [editing, setEditing] = useState(false), [nickname, setNickname] = useState(''), [bio, setBio] = useState(''), [saving, setSaving] = useState(false), [editError, setEditError] = useState('');
    const [postsVersion, setPostsVersion] = useState(0);
    // Counts list resets (tab switch, profile save), so a '더 보기' page for an old list is dropped.
    const listGen = useRef(0);
    const [account, setAccount] = useState<'' | 'password' | 'withdraw'>('');
    const mine = me?.id === id;

    useEffect(() => {
        api<{ user: Profile }>('users/' + id).then(d => { setError(null); setUser(d.user); })
            .catch(e => setError({ status: e instanceof ApiError ? e.status : 0, text: errorText(e) }));
    }, [id, me?.grade, me?.badges.length, retry]);
    useEffect(() => { if (user) setPageTitle(user.nickname); }, [user?.nickname]);
    const postsPage = (n: number) => api<{ posts: Post[]; total: number }>('posts?' + new URLSearchParams({ author: id || '', size: String(PAGE_SIZE), page: String(n), ...(tab === 'active' ? { active: '1' } : { status: 'closed' }) }));
    useEffect(() => {
        let alive = true;
        listGen.current++;
        setPosts(null); setPage(1);
        postsPage(1).then(d => { if (alive) { setPosts(d.posts); setTotal(d.total); } }).catch(() => { if (alive) setPosts([]); });
        return () => { alive = false; };
    }, [id, tab, postsVersion]);
    // The owner's counters: '오늘 끌올 2/10 · 거래중 글 4/30 · 상단 노출 1/1'.
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
            // An empty page means the list shrank meanwhile: stop offering more.
            setTotal(d.posts.length ? d.total : posts.length);
            setPage(page + 1);
        } catch (e) { if (gen === listGen.current) toast.error(errorText(e)); }
        finally { setLoadingMore(false); }
    }
    const grade = gradeInfo(user.grade);
    // The next grade up for sale and the first thing it adds, on the owner's own grade card.
    const nextGrade = user.role === 'manager' ? undefined : GRADES.find(g => g.rank === grade.rank + 1 && g.plans.length);
    const usageLine = usage && usage.perks.bumpsPerDay !== null && usage.perks.openPosts !== null
        ? `오늘 끌올 ${usage.bumpsToday}/${usage.perks.bumpsPerDay} · 거래중 글 ${usage.openPosts}/${usage.perks.openPosts}` + (usage.perks.boardSlots ? ` · 상단 노출 ${usage.featured.length}/${usage.perks.boardSlots}` : '')
        : '';

    return <div className="container page profile">
        <section className="profile-head">
            <Avatar name={user.nickname} size="lg" />
            <div className="grow">
                <NameLine nickname={user.nickname} grade={user.grade} role={user.role} badges={user.badges} size="lg" />
                {user.prev_nickname && <p className="muted small mt-8">이전 닉네임: {user.prev_nickname}</p>}
                <p className="muted small mt-8">{dateText(user.created_at)} 가입 · 거래글 {user.postCount} · 거래완료 {user.closedCount}</p>
                {/* Other members' 최근 접속 (on one's own profile it would always read 10분 이내). */}
                {!mine && user.last_seen_at && <p className="muted small profile-seen">{lastSeenText(user.last_seen_at)}</p>}
                {user.bio && <p className="profile-bio">{user.bio}</p>}
            </div>
            <div className="profile-actions">
                {mine ? <button type="button" className="btn btn-line btn-sm" onClick={() => { setNickname(user.nickname); setBio(user.bio); setEditError(''); setEditing(true); }}><Pencil size={15} />프로필 수정</button>
                    : <>
                        <button type="button" className="btn btn-primary btn-sm" onClick={chat}><MessageCircle size={16} />채팅하기</button>
                        {user.role !== 'manager' && <button type="button" className="btn btn-line btn-sm" aria-pressed={!!user.blocked} disabled={blockBusy} onClick={block}><Ban size={15} />{user.blocked ? '차단 해제' : '차단'}</button>}
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
                    {mine && user.role !== 'manager' && grade.rank < 3 && <button type="button" className="btn btn-line btn-sm" onClick={() => openApply({ kind: 'grade', target: grade.rank < 1 ? 'plus' : grade.rank < 2 ? 'premium' : 'elite', plan: 'permanent' })}>등급 신청</button>}</div>
                {user.role === 'manager' ? <p className="grade-big"><span className="grade grade-manager">매니저</span></p> : <>
                    <p className="grade-big"><CIcon name={grade.icon} size={36} /><strong>{grade.name}</strong></p>
                    {/* The end date of a 6-month grade reaches only the member and the manager. */}
                    {user.grade_expires_at && <p className="muted small mt-8">{longDate(user.grade_expires_at)}까지</p>}
                    {mine && usageLine && <p className="grade-usage">{usageLine}</p>}
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
            <Tabs label="거래글" value={tab} onChange={setTab} items={[{ id: 'active', label: '거래중' }, { id: 'closed', label: '거래완료' }]} />
            <div className="mt-16">{posts === null ? <SkeletonRows count={2} /> : posts.length ? <><p className="muted small" style={{ marginBottom: 12 }}>{total}건</p><div className="post-list">{posts.map(p => <PostCard key={p.id} post={p} hideAuthor />)}</div>
                {posts.length < total && <button type="button" className="btn btn-line more-btn" disabled={loadingMore} onClick={more}>더 보기</button>}</>
                : <EmptyState icon="file" title={tab === 'active' ? '거래중인 글이 없습니다' : '거래완료된 글이 없습니다'} action={mine && tab === 'active' ? <button className="btn btn-primary" onClick={() => void navigate('/write')}>글쓰기</button> : undefined} />}</div>
        </section>

        <Modal open={editing} onClose={() => setEditing(false)} title="프로필 수정" footer={<button className="btn btn-primary btn-lg" disabled={saving} onClick={save}>저장</button>}>
            <div className="form-stack">
                <div className="field"><label className="field-label" htmlFor="profile-nickname">닉네임</label>
                    <input id="profile-nickname" className="input" value={nickname} onChange={e => setNickname(e.target.value)} minLength={2} maxLength={16} disabled={user.role === 'manager' || nicknameLocked} aria-describedby={user.role === 'manager' ? undefined : 'profile-nickname-hint'} />
                    {user.role !== 'manager' && <span id="profile-nickname-hint" className="field-hint">{nicknameLocked ? `${monthDay(user.nickname_next_at!)}부터 변경 가능` : '30일에 한 번 변경 가능'}</span>}</div>
                <label className="field"><span className="field-label">소개</span><textarea className="textarea" style={{ minHeight: 110 }} maxLength={300} value={bio} onChange={e => setBio(e.target.value)} placeholder="예: 래더계 위주 거래, 밤에 답장 빠름" /></label>
                {editError && <p className="field-error" role="alert">{editError}</p>}
                <div className="row">
                    <button type="button" className="btn btn-line btn-sm" onClick={() => { setEditing(false); setAccount('password'); }}>비밀번호 변경</button>
                    {user.role !== 'manager' && <button type="button" className="btn btn-text small" style={{ marginLeft: 'auto' }} onClick={() => { setEditing(false); setAccount('withdraw'); }}>회원 탈퇴</button>}
                </div>
            </div>
        </Modal>
        <PasswordModal open={account === 'password'} onClose={() => setAccount('')} />
        <WithdrawModal open={account === 'withdraw'} onClose={() => setAccount('')} onDone={() => { setAccount(''); setMe(null); void navigate('/'); toast('탈퇴 완료'); }} />
    </div>;
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

