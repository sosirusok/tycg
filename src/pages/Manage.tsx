import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { dateText, relativeTime, type Post, type User } from '../../shared/market';
import { APPLICATION_STATUS_NAMES, applicationTitle, type Application } from '../../shared/membership';
import { api, errorText } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { useApp } from '../app/state';
import { EmptyState, Modal, NameLine, SkeletonRows, Tabs } from '../components/ui';
import { MemberPanel } from '../components/MemberPanel';
import { PostCard } from '../components/PostCard';

type TabId = 'applications' | 'members' | 'reports' | 'hidden' | 'notices' | 'settings';
type App = Application & { nickname: string; username: string; grade: string; badges: string[] };
type Report = { id: number; post_id: number | null; title: string | null; hidden: number | null; nickname: string; reason: string; details: string; status: string; created_at: number };
type Notice = { id: number; title: string; body: string; created_at: number };

export default function Manage({ tab: raw }: { tab?: string }) {
    const { me, ready } = useApp();
    const tab = (['applications', 'members', 'reports', 'hidden', 'notices', 'settings'].includes(raw || '') ? raw : 'applications') as TabId;
    const [summary, setSummary] = useState<{ reports: Report[]; hidden: Post[]; pendingApplications: number } | null>(null);
    const loadSummary = useCallback(() => api<any>('manage').then(setSummary).catch(() => {}), []);
    useEffect(() => { if (me?.role === 'manager') void loadSummary(); }, [me?.role, loadSummary, tab]);
    if (!ready) return <div className="container page"><SkeletonRows /></div>;
    if (me?.role !== 'manager') return <div className="container page"><EmptyState icon="locked" title="매니저만 볼 수 있어요" /></div>;
    const pendingReports = summary?.reports.filter(r => r.status === 'pending').length || 0;
    return <div className="container page">
        <h1 className="page-title">매니저 관리</h1>
        <div className="mt-16"><Tabs label="관리 메뉴" value={tab} onChange={t => void navigate('/manage/' + t, { replace: true })} items={[
            { id: 'applications', label: <>인증·등급 신청{summary?.pendingApplications ? <b>{summary.pendingApplications}</b> : null}</> },
            { id: 'members', label: '회원' },
            { id: 'reports', label: <>신고{pendingReports ? <b>{pendingReports}</b> : null}</> },
            { id: 'hidden', label: '숨긴 글' }, { id: 'notices', label: '공지' }, { id: 'settings', label: '설정' },
        ]} /></div>
        <div className="mt-24">
            {tab === 'applications' ? <Applications onChange={loadSummary} />
                : tab === 'members' ? <Members />
                : tab === 'reports' ? <Reports reports={summary?.reports} onChange={loadSummary} />
                : tab === 'hidden' ? (summary ? summary.hidden.length ? <div className="post-list">{summary.hidden.map(p => <PostCard key={p.id} post={p} />)}</div> : <EmptyState icon="shield" title="숨긴 글이 없어요" /> : <SkeletonRows />)
                : tab === 'notices' ? <Notices /> : <Settings />}
        </div>
    </div>;
}

function Applications({ onChange }: { onChange: () => void }) {
    const [status, setStatus] = useState<'pending' | 'all'>('pending'), [apps, setApps] = useState<App[] | null>(null), [member, setMember] = useState<string | null>(null);
    const load = useCallback(() => api<{ applications: App[] }>('manage/applications' + (status === 'pending' ? '?status=pending' : '')).then(d => setApps(d.applications)).catch(e => toast.error(errorText(e))), [status]);
    useEffect(() => { setApps(null); void load(); }, [load]);
    const [rejecting, setRejecting] = useState<App | null>(null), [note, setNote] = useState('');
    async function act(a: App, action: 'approve' | 'reject', reason = '') {
        try { await api('applications/' + a.id, 'PATCH', { action, note: reason }); toast(action === 'approve' ? '지급했어요.' : '반려했어요.'); setRejecting(null); setNote(''); void load(); onChange(); }
        catch (e) { toast.error(errorText(e)); }
    }
    return <>
        <div className="chip-row"><button type="button" className="chip chip-sm" aria-pressed={status === 'pending'} onClick={() => setStatus('pending')}>확인 중</button><button type="button" className="chip chip-sm" aria-pressed={status === 'all'} onClick={() => setStatus('all')}>전체</button></div>
        <div className="mt-16">{apps === null ? <SkeletonRows count={3} height={72} /> : apps.length ? <ul className="simple-list">{apps.map(a => <li key={a.id}>
            <span className="grow">
                <strong>{applicationTitle(a)}</strong>
                <span className="row small"><button type="button" className="link-btn" onClick={() => setMember(a.user_id)}><NameLine nickname={a.nickname} grade={a.grade} badges={a.badges} /></button><span className="muted">@{a.username} · {relativeTime(a.created_at)}</span></span>
            </span>
            <span className={'event-status st-' + a.status}>{APPLICATION_STATUS_NAMES[a.status]}</span>
            {a.conversation_id && <Link to={'/chat/' + a.conversation_id} className="btn btn-line btn-xs">채팅 보기</Link>}
            {a.status === 'pending' && <><button type="button" className="btn btn-primary btn-xs" onClick={() => act(a, 'approve')}>승인</button><button type="button" className="btn btn-line btn-xs" onClick={() => setRejecting(a)}>반려</button></>}
        </li>)}</ul> : <EmptyState icon="check-mark-button" title={status === 'pending' ? '확인할 신청이 없어요' : '신청 내역이 없어요'} />}</div>
        <Modal open={!!member} onClose={() => setMember(null)} title="회원 관리">{member && <MemberPanel userId={member} onChange={() => { void load(); onChange(); }} />}</Modal>
        <Modal open={!!rejecting} onClose={() => setRejecting(null)} title="신청 반려" description={rejecting ? `${rejecting.nickname}님의 ${applicationTitle(rejecting)}` : ''}
            footer={<button className="btn btn-dark btn-lg" onClick={() => rejecting && act(rejecting, 'reject', note)}>반려하기</button>}>
            <label className="field"><span className="field-label">반려 사유 (선택)</span><input className="input" maxLength={300} value={note} onChange={e => setNote(e.target.value)} placeholder="채팅에 함께 표시돼요" /></label>
        </Modal>
    </>;
}

function Members() {
    const [q, setQ] = useState(''), [filter, setFilter] = useState(''), [users, setUsers] = useState<(User & { username: string; postCount: number })[] | null>(null), [member, setMember] = useState<string | null>(null);
    const [applied, setApplied] = useState('');
    const load = useCallback(() => api<{ users: any[] }>('manage/users?' + new URLSearchParams({ q: applied, filter })).then(d => setUsers(d.users)).catch(e => toast.error(errorText(e))), [applied, filter]);
    useEffect(() => { void load(); }, [load]);
    const submit = (e: FormEvent) => { e.preventDefault(); setApplied(q.trim()); };
    return <>
        <form className="search-input" onSubmit={submit} role="search"><Search size={20} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="닉네임 또는 아이디" aria-label="회원 검색" /></form>
        <div className="chip-row mt-12">{[['', '전체'], ['badged', '인증 보유'], ['graded', '등급 보유']].map(([id, label]) => <button type="button" key={id} className="chip chip-sm" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
        <div className="mt-16">{users === null ? <SkeletonRows count={4} height={60} /> : users.length ? <ul className="simple-list">{users.map(u => <li key={u.id}>
            <span className="grow"><NameLine nickname={u.nickname} grade={u.grade} role={u.role} badges={u.badges} /><span className="muted small">@{u.username} · {dateText(u.created_at)} 가입 · 글 {u.postCount}</span></span>
            <button type="button" className="btn btn-line btn-xs" onClick={() => setMember(u.id)}>관리</button>
        </li>)}</ul> : <EmptyState title="회원이 없어요" />}</div>
        <Modal open={!!member} onClose={() => setMember(null)} title="회원 관리">{member && <MemberPanel userId={member} onChange={() => void load()} />}</Modal>
    </>;
}

function Reports({ reports, onChange }: { reports?: Report[]; onChange: () => void }) {
    if (!reports) return <SkeletonRows />;
    if (!reports.length) return <EmptyState icon="police-car-light" title="접수된 신고가 없어요" />;
    const act = async (task: Promise<unknown>, message: string) => { try { await task; toast(message); onChange(); } catch (e) { toast.error(errorText(e)); } };
    return <ul className="simple-list">{reports.map(r => <li key={r.id} className={r.status === 'pending' ? '' : 'is-done'}>
        <span className="grow">
            <strong>{r.reason}</strong>
            <span className="small">{r.details}</span>
            <span className="muted small">{r.nickname}님 · {relativeTime(r.created_at)} · {r.post_id ? <Link to={'/posts/' + r.post_id}>{r.title || '글 ' + r.post_id}</Link> : '삭제된 글'}</span>
        </span>
        {r.post_id && <button type="button" className="btn btn-line btn-xs" onClick={() => act(api('manage/visibility', 'POST', { postId: r.post_id, hidden: !r.hidden }), r.hidden ? '다시 공개했어요.' : '글을 숨겼어요.')}>{r.hidden ? '공개' : '숨기기'}</button>}
        <button type="button" className="btn btn-line btn-xs" onClick={() => act(api('manage/report', 'POST', { id: r.id, status: r.status === 'pending' ? 'resolved' : 'pending' }), r.status === 'pending' ? '처리 완료로 표시했어요.' : '다시 확인 중으로 돌렸어요.')}>{r.status === 'pending' ? '처리 완료' : '되돌리기'}</button>
    </li>)}</ul>;
}

function Notices() {
    const [list, setList] = useState<Notice[] | null>(null), [editing, setEditing] = useState<Partial<Notice> | null>(null);
    const load = () => api<{ notices: Notice[] }>('notices').then(d => setList(d.notices)).catch(() => setList([]));
    useEffect(() => { void load(); }, []);
    async function save() {
        if (!editing) return;
        try { await api('manage/notice' + (editing.id ? '/' + editing.id : ''), editing.id ? 'PUT' : 'POST', { title: editing.title, body: editing.body }); setEditing(null); toast('공지를 저장했어요.'); void load(); }
        catch (e) { toast.error(errorText(e)); }
    }
    const [deleting, setDeleting] = useState<Notice | null>(null);
    async function remove(id: number) {
        try { await api('manage/notice/' + id, 'DELETE'); toast('삭제했어요.'); setDeleting(null); void load(); } catch (e) { toast.error(errorText(e)); }
    }
    return <>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({ title: '', body: '' })}>새 공지</button>
        <div className="mt-16">{list === null ? <SkeletonRows count={2} height={60} /> : list.length ? <ul className="simple-list">{list.map(n => <li key={n.id}>
            <span className="grow"><strong>{n.title}</strong><span className="muted small">{dateText(n.created_at)}</span></span>
            <button type="button" className="btn btn-line btn-xs" onClick={() => setEditing(n)}>수정</button>
            <button type="button" className="btn btn-line btn-xs" onClick={() => setDeleting(n)}>삭제</button>
        </li>)}</ul> : <EmptyState icon="megaphone" title="공지가 없어요" />}</div>
        <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? '공지 수정' : '새 공지'} footer={<button className="btn btn-primary btn-lg" onClick={save}>저장</button>}>
            <div className="form-stack">
                <label className="field"><span className="field-label">제목</span><input className="input" maxLength={100} value={editing?.title || ''} onChange={e => setEditing({ ...editing, title: e.target.value })} /></label>
                <label className="field"><span className="field-label">내용</span><textarea className="textarea" maxLength={10000} value={editing?.body || ''} onChange={e => setEditing({ ...editing, body: e.target.value })} /></label>
            </div>
        </Modal>
        <Modal open={!!deleting} onClose={() => setDeleting(null)} title="공지를 삭제할까요?" description={deleting?.title}
            footer={<><button className="btn btn-line" onClick={() => setDeleting(null)}>취소</button><button className="btn btn-dark" onClick={() => deleting && remove(deleting.id)}>삭제</button></>}><span /></Modal>
    </>;
}

function Settings() {
    const { config, refreshConfig } = useApp();
    const [notice, setNotice] = useState(config.paymentNotice), [season, setSeason] = useState(String(config.latestSeason)), [busy, setBusy] = useState(false);
    useEffect(() => { setNotice(config.paymentNotice); setSeason(String(config.latestSeason)); }, [config]);
    async function save(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        try { await api('manage/settings', 'PUT', { paymentNotice: notice, latestSeason: Number(season) }); refreshConfig(); toast('설정을 저장했어요.'); }
        catch (err) { toast.error(errorText(err)); }
        finally { setBusy(false); }
    }
    return <form className="settings-form" onSubmit={save}>
        <label className="field"><span className="field-label">등급 입금 안내</span>
            <textarea className="textarea" style={{ minHeight: 110 }} maxLength={300} value={notice} onChange={e => setNotice(e.target.value)} placeholder="예: 국민은행 000000-00-000000 (예금주 ○○○)" />
            <span className="field-hint">인증·등급 신청 창의 ‘입금 안내’에 그대로 보여요. 비워 두면 “채팅에서 안내”로 표시돼요.</span></label>
        <label className="field"><span className="field-label">현재 래더 시즌</span>
            <div className="input-unit" style={{ maxWidth: 200 }}><input className="input" type="number" min={32} max={200} value={season} onChange={e => setSeason(e.target.value)} /><span>시즌</span></div>
            <span className="field-hint">새 시즌이 열리면 올려 주세요. 글쓰기와 검색의 시즌 선택지가 이 숫자까지 늘어나요. 낮출 수는 없어요.</span></label>
        <div><button className="btn btn-primary" disabled={busy}>저장</button></div>
    </form>;
}
