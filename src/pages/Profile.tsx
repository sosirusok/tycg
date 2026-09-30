import { useEffect, useState } from 'react';
import { Ban, ChevronRight, MessageCircle, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { dateText, type Post, type User } from '../../shared/market';
import { BADGES, gradeInfo } from '../../shared/membership';
import { api, errorText } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { useApp } from '../app/state';
import { Avatar, CIcon, EmptyState, Modal, NameLine, SkeletonRows, Tabs, VerifiedMark } from '../components/ui';
import { PostCard } from '../components/PostCard';

type Profile = User & { postCount: number; closedCount: number };

export default function ProfilePage({ id }: { id?: string }) {
    const { me, refreshMe, requireLogin, openApply, logout } = useApp();
    const [user, setUser] = useState<Profile | null>(null), [error, setError] = useState('');
    const [tab, setTab] = useState<'active' | 'closed'>('active'), [posts, setPosts] = useState<Post[] | null>(null), [total, setTotal] = useState(0);
    const [editing, setEditing] = useState(false), [nickname, setNickname] = useState(''), [bio, setBio] = useState(''), [saving, setSaving] = useState(false);
    const mine = me?.id === id;

    useEffect(() => { api<{ user: Profile }>('users/' + id).then(d => setUser(d.user)).catch(e => setError(errorText(e))); }, [id, me?.grade, me?.badges.length]);
    useEffect(() => {
        setPosts(null);
        api<{ posts: Post[]; total: number }>('posts?' + new URLSearchParams({ author: id || '', size: '20', ...(tab === 'active' ? { active: '1' } : { status: 'closed' }) }))
            .then(d => { setPosts(d.posts); setTotal(d.total); }).catch(() => setPosts([]));
    }, [id, tab]);

    if (error) return <div className="container page"><EmptyState icon="warning" title="없는 회원입니다" text={error} /></div>;
    if (!user) return <div className="container page"><SkeletonRows count={2} height={160} /></div>;

    async function save() {
        setSaving(true);
        try {
            await api('users/' + user!.id, 'PUT', { nickname, bio });
            // The server stores the nickname in a normalized form, so read it back.
            const d = await api<{ user: Profile }>('users/' + user!.id);
            setUser(d.user);
            await refreshMe();
            setEditing(false); toast('저장 완료');
        } catch (e) { toast.error(errorText(e)); }
        finally { setSaving(false); }
    }
    const chat = () => requireLogin(async () => {
        try { const d = await api<{ id: string }>('chats', 'POST', { userId: user.id }); void navigate('/chat/' + d.id); }
        catch (e) { toast.error(errorText(e)); }
    });
    const block = () => requireLogin(async () => {
        try { await api('blocks', 'POST', { userId: user.id, active: true }); toast('차단 완료. 해제는 내 거래 > 차단'); }
        catch (e) { toast.error(errorText(e)); }
    });
    const grade = gradeInfo(user.grade);

    return <div className="container page profile">
        <section className="profile-head">
            <Avatar name={user.nickname} size="lg" />
            <div className="grow">
                <NameLine nickname={user.nickname} grade={user.grade} role={user.role} badges={user.badges} size="lg" />
                <p className="muted small mt-8">{dateText(user.created_at)} 가입 · 거래글 {user.postCount} · 거래완료 {user.closedCount}</p>
                {user.bio && <p className="profile-bio">{user.bio}</p>}
            </div>
            <div className="profile-actions">
                {mine ? <>
                    <button type="button" className="btn btn-line btn-sm" onClick={() => { setNickname(user.nickname); setBio(user.bio); setEditing(true); }}><Pencil size={15} />프로필 수정</button>
                    {user.role !== 'manager' && <button type="button" className="btn btn-primary btn-sm" onClick={() => openApply()}>인증/등급 신청</button>}
                </> : <>
                    <button type="button" className="btn btn-primary btn-sm" onClick={chat}><MessageCircle size={16} />채팅하기</button>
                    {user.role !== 'manager' && <button type="button" className="btn btn-line btn-sm" onClick={block}><Ban size={15} />차단</button>}
                </>}
            </div>
        </section>

        <section className="profile-cards">
            <div className="card card-pad">
                <div className="card-title-row"><h2 className="card-title">인증</h2>
                    {mine && user.role !== 'manager' && user.badges.length < BADGES.length && <button type="button" className="btn btn-line btn-sm" onClick={() => openApply({ kind: 'badge', target: BADGES.find(b => !user.badges.includes(b.id))!.id })}>인증 신청</button>}</div>
                <ul className="verify-list">{BADGES.map(b => {
                    const on = user.badges.includes(b.id);
                    return <li key={b.id} className={on ? 'on' : ''}><CIcon name={b.icon} size={28} /><span className="grow">{b.name}</span>{on ? <span className="verified"><VerifiedMark size={16} />인증 완료</span> : <span className="muted small">미인증</span>}</li>;
                })}</ul>
            </div>
            <div className="card card-pad">
                <div className="card-title-row"><h2 className="card-title">등급</h2>
                    {mine && user.role !== 'manager' && grade.rank < 3 && <button type="button" className="btn btn-line btn-sm" onClick={() => openApply({ kind: 'grade', target: grade.rank < 1 ? 'plus' : grade.rank < 2 ? 'premium' : 'elite', plan: 'permanent' })}>등급 신청</button>}</div>
                {user.role === 'manager' ? <p className="grade-big"><span className="grade grade-manager">매니저</span></p> : <>
                    <p className="grade-big"><CIcon name={grade.icon} size={36} /><strong>{grade.name}</strong></p>
                    {mine && user.grade_expires_at && <p className="muted small">{dateText(user.grade_expires_at)}까지</p>}
                </>}
            </div>
        </section>

        {mine && <nav className="my-menu" aria-label="내 메뉴">
            {([['/me/posts', '내 거래'], ['/me/favorites', '찜한 글'], ['/me/applications', '신청 내역'], ...(me?.role === 'manager' ? [['/manage', '매니저 메뉴']] : [])] as [string, string][]).map(([to, label]) =>
                <Link key={to} to={to}>{label}<ChevronRight size={18} /></Link>)}
            <button type="button" onClick={() => void logout()}>로그아웃</button>
        </nav>}

        <section className="section">
            <Tabs label="거래글" value={tab} onChange={setTab} items={[{ id: 'active', label: '거래 중' }, { id: 'closed', label: '거래 완료' }]} />
            <div className="mt-16">{posts === null ? <SkeletonRows count={2} /> : posts.length ? <><p className="muted small" style={{ marginBottom: 12 }}>{total}건</p><div className="post-list">{posts.map(p => <PostCard key={p.id} post={p} />)}</div></>
                : <EmptyState icon="memo" title={tab === 'active' ? '거래중인 글이 없습니다' : '거래완료된 글이 없습니다'} action={mine && tab === 'active' ? <button className="btn btn-primary" onClick={() => void navigate('/write')}>글쓰기</button> : undefined} />}</div>
        </section>

        <Modal open={editing} onClose={() => setEditing(false)} title="프로필 수정" footer={<button className="btn btn-primary btn-lg" disabled={saving} onClick={save}>저장</button>}>
            <div className="form-stack">
                <label className="field"><span className="field-label">닉네임</span><input className="input" value={nickname} onChange={e => setNickname(e.target.value)} minLength={2} maxLength={16} disabled={user.role === 'manager'} /></label>
                <label className="field"><span className="field-label">소개</span><textarea className="textarea" style={{ minHeight: 110 }} maxLength={300} value={bio} onChange={e => setBio(e.target.value)} placeholder="예: 래더계 위주 거래, 밤에 답장 빠름" /></label>
            </div>
        </Modal>
    </div>;
}

