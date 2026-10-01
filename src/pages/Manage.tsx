import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { REPORT_REASONS, dateText, relativeTime, type Post, type User } from '../../shared/market';
import { APPLICATION_STATUS_NAMES, applicationTitle, kstDateTime, type Application } from '../../shared/membership';
import { api, errorText } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { useApp } from '../app/state';
import { EmptyState, Modal, NameLine, SkeletonRows, Tabs } from '../components/ui';
import { MemberPanel } from '../components/MemberPanel';
import { PostCard } from '../components/PostCard';

type TabId = 'applications' | 'members' | 'reports' | 'hidden' | 'notices' | 'settings';
type App = Application & { nickname: string; username: string; grade: string; grade_trial?: boolean; badges: string[] };
type Report = { id: number; post_id: number | null; title: string | null; hidden: number | null; nickname: string; grade: string; grade_trial?: boolean; badges: string[]; reason: string; details: string; status: string; created_at: number;
    // A member report: the reported member and the chat it came from.
    target_user_id: string | null; conversation_id: string | null; target_nickname?: string; target_role?: string; target_grade?: string; target_grade_trial?: boolean; target_badges?: string[]; target_deleted?: boolean; target_suspended?: boolean };
type EvidenceMessage = { id: number; sender_id: string; nickname: string; body: string; type: string; photos: number; created_at: number };
type Notice = { id: number; title: string; body: string; created_at: number };

export default function Manage({ tab: raw }: { tab?: string }) {
    const { me, ready } = useApp();
    const tab = (['applications', 'members', 'reports', 'hidden', 'notices', 'settings'].includes(raw || '') ? raw : 'applications') as TabId;
    const [summary, setSummary] = useState<{ reports: Report[]; hidden: Post[]; pendingApplications: number } | null>(null);
    const loadSummary = useCallback(() => api<any>('manage').then(setSummary).catch(() => {}), []);
    useEffect(() => { if (me?.role === 'manager') void loadSummary(); }, [me?.role, loadSummary, tab]);
    if (!ready) return <div className="container page"><SkeletonRows /></div>;
    if (me?.role !== 'manager') return <div className="container page"><EmptyState icon="lock" title="매니저 전용 페이지입니다" /></div>;
    const pendingReports = summary?.reports.filter(r => r.status === 'pending').length || 0;
    return <div className="container page">
        <h1 className="page-title">매니저 메뉴</h1>
        <div className="mt-16"><Tabs label="관리 메뉴" value={tab} onChange={t => void navigate('/manage/' + t, { replace: true })} items={[
            { id: 'applications', label: <>인증/등급 신청{summary?.pendingApplications ? <b>{summary.pendingApplications}</b> : null}</> },
            { id: 'members', label: '회원' },
            { id: 'reports', label: <>신고{pendingReports ? <b>{pendingReports}</b> : null}</> },
            { id: 'hidden', label: '숨긴 글' }, { id: 'notices', label: '공지' }, { id: 'settings', label: '설정' },
        ]} /></div>
        <div className="mt-24">
            {tab === 'applications' ? <Applications onChange={loadSummary} />
                : tab === 'members' ? <Members />
                : tab === 'reports' ? <Reports reports={summary?.reports} onChange={loadSummary} />
                : tab === 'hidden' ? (summary ? summary.hidden.length ? <div className="post-list">{summary.hidden.map(p => <PostCard key={p.id} post={p} />)}</div> : <EmptyState title="숨긴 글이 없습니다" /> : <SkeletonRows />)
                : tab === 'notices' ? <Notices /> : <Settings />}
        </div>
    </div>;
}

function Applications({ onChange }: { onChange: () => void }) {
    const [status, setStatus] = useState<'pending' | 'all'>('pending'), [apps, setApps] = useState<App[] | null>(null), [member, setMember] = useState<string | null>(null);
    const load = useCallback(() => api<{ applications: App[] }>('manage/applications' + (status === 'pending' ? '?status=pending' : '')).then(d => setApps(d.applications)).catch(e => toast.error(errorText(e))), [status]);
    useEffect(() => { setApps(null); void load(); }, [load]);
    const [rejecting, setRejecting] = useState<App | null>(null), [note, setNote] = useState('');
    const [busy, setBusy] = useState('');
    async function act(a: App, action: 'approve' | 'reject', reason = '') {
        if (busy) return;
        setBusy(a.id);
        try { await api('applications/' + a.id, 'PATCH', { action, note: reason }); toast(action === 'approve' ? '지급 완료' : '반려 완료'); setRejecting(null); setNote(''); void load(); onChange(); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(''); }
    }
    return <>
        <div className="chip-row"><button type="button" className="chip chip-sm" aria-pressed={status === 'pending'} onClick={() => setStatus('pending')}>신청 대기</button><button type="button" className="chip chip-sm" aria-pressed={status === 'all'} onClick={() => setStatus('all')}>전체</button></div>
        <div className="mt-16">{apps === null ? <SkeletonRows count={3} height={72} /> : apps.length ? <ul className="simple-list">{apps.map(a => <li key={a.id}>
            <span className="grow">
                <strong>{applicationTitle(a)}</strong>
                <span className="row small"><button type="button" className="link-btn" onClick={() => setMember(a.user_id)}><NameLine nickname={a.nickname} grade={a.grade} trial={a.grade_trial} badges={a.badges} /></button><span className="muted">@{a.username} · {relativeTime(a.created_at)}</span></span>
            </span>
            <span className={'event-status st-' + a.status}>{APPLICATION_STATUS_NAMES[a.status]}</span>
            {a.conversation_id && <Link to={'/chat/' + a.conversation_id} className="btn btn-line btn-xs">채팅</Link>}
            {a.status === 'pending' && <><button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => act(a, 'approve')}>승인</button><button type="button" className="btn btn-line btn-sm" disabled={!!busy} onClick={() => setRejecting(a)}>반려</button></>}
        </li>)}</ul> : <EmptyState icon="file" title={status === 'pending' ? '대기 중인 신청이 없습니다' : '신청 내역이 없습니다'} />}</div>
        <Modal open={!!member} onClose={() => setMember(null)} title="회원 관리">{member && <MemberPanel userId={member} onChange={() => { void load(); onChange(); }} />}</Modal>
        <Modal open={!!rejecting} onClose={() => setRejecting(null)} title="신청 반려" description={rejecting ? `${rejecting.nickname}님의 ${applicationTitle(rejecting)}` : ''}
            footer={<button className="btn btn-dark btn-lg" onClick={() => rejecting && act(rejecting, 'reject', note)}>반려</button>}>
            <label className="field"><span className="field-label">반려 사유</span><input className="input" maxLength={300} value={note} onChange={e => setNote(e.target.value)} placeholder="채팅에 표시됨" /></label>
        </Modal>
    </>;
}

function Members() {
    const [q, setQ] = useState(''), [filter, setFilter] = useState(''), [users, setUsers] = useState<(User & { username: string; postCount: number; suspended?: boolean })[] | null>(null), [member, setMember] = useState<string | null>(null);
    const [applied, setApplied] = useState('');
    const load = useCallback(() => api<{ users: any[] }>('manage/users?' + new URLSearchParams({ q: applied, filter })).then(d => setUsers(d.users)).catch(e => toast.error(errorText(e))), [applied, filter]);
    useEffect(() => { void load(); }, [load]);
    const submit = (e: FormEvent) => { e.preventDefault(); setApplied(q.trim()); };
    return <>
        <form className="search-input" onSubmit={submit} role="search"><Search size={20} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="닉네임 또는 아이디" aria-label="회원 검색" /></form>
        <div className="chip-row mt-12">{[['', '전체'], ['badged', '인증 보유'], ['graded', '등급 보유']].map(([id, label]) => <button type="button" key={id} className="chip chip-sm" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
        <div className="mt-16">{users === null ? <SkeletonRows count={4} height={60} /> : users.length ? <ul className="simple-list">{users.map(u => <li key={u.id}>
            <span className="grow"><NameLine nickname={u.nickname} grade={u.grade} trial={u.grade_trial} role={u.role} badges={u.badges} /><span className="muted small">@{u.username} · {dateText(u.created_at)} 가입 · 글 {u.postCount}{u.suspended && ' · 이용 정지 중'}</span></span>
            <button type="button" className="btn btn-line btn-xs" onClick={() => setMember(u.id)}>관리</button>
        </li>)}</ul> : <EmptyState icon="search" title="검색 결과가 없습니다" />}</div>
        <Modal open={!!member} onClose={() => setMember(null)} title="회원 관리">{member && <MemberPanel userId={member} onChange={() => void load()} />}</Modal>
    </>;
}

function Reports({ reports, onChange }: { reports?: Report[]; onChange: () => void }) {
    const [member, setMember] = useState<string | null>(null), [evidence, setEvidence] = useState<Report | null>(null);
    if (!reports) return <SkeletonRows />;
    if (!reports.length) return <EmptyState title="접수된 신고가 없습니다" />;
    const act = async (task: Promise<unknown>, message: string) => { try { await task; toast(message); onChange(); } catch (e) { toast.error(errorText(e)); } };
    return <>
        <ul className="simple-list">{reports.map(r => <li key={r.id} className={r.status === 'pending' ? '' : 'is-done'}>
            <span className="grow">
                <strong>{r.reason}</strong>
                <span className="small">{r.details}</span>
                {/* A member report names the member (profile link); a post report names the post. */}
                {r.target_user_id && <span className="small">대상 {r.target_deleted ? r.target_nickname : <Link to={'/profile/' + r.target_user_id}><NameLine nickname={r.target_nickname || ''} grade={r.target_grade} trial={r.target_grade_trial} role={r.target_role} badges={r.target_badges} /></Link>}{r.target_suspended && <span className="nowrap">{'\u00a0'}· 이용 정지 중</span>}</span>}
                <span className="muted small">신고자 <NameLine nickname={r.nickname} grade={r.grade} trial={r.grade_trial} badges={r.badges} /><span className="nowrap">{'\u00a0'}· {relativeTime(r.created_at)}</span>{!r.target_user_id && <> · {r.post_id ? <Link to={'/posts/' + r.post_id}>{r.title || '글 ' + r.post_id}</Link> : '삭제된 글'}</>}</span>
            </span>
            {/* One group, so the actions wrap together under the text on phones. */}
            <span className="report-actions">
                {r.post_id && <button type="button" className="btn btn-line btn-xs" onClick={() => act(api('manage/visibility', 'POST', { postId: r.post_id, hidden: !r.hidden, reason: !r.hidden && (REPORT_REASONS as readonly string[]).includes(r.reason) ? r.reason : '' }), r.hidden ? '공개 완료' : '숨김 완료')}>{r.hidden ? '공개' : '숨기기'}</button>}
                {r.conversation_id && <button type="button" className="btn btn-line btn-xs" onClick={() => setEvidence(r)}>채팅 보기</button>}
                {r.target_user_id && <button type="button" className="btn btn-line btn-xs" onClick={() => setMember(r.target_user_id)}>회원 관리</button>}
                <button type="button" className="btn btn-line btn-xs" onClick={() => act(api('manage/report', 'POST', { id: r.id, status: r.status === 'pending' ? 'resolved' : 'pending' }), r.status === 'pending' ? '처리 완료' : '미처리로 변경')}>{r.status === 'pending' ? '처리 완료' : '되돌리기'}</button>
            </span>
        </li>)}</ul>
        <Modal open={!!member} onClose={() => setMember(null)} title="회원 관리">{member && <MemberPanel userId={member} onChange={onChange} />}</Modal>
        <Modal open={!!evidence} onClose={() => setEvidence(null)} title="신고된 채팅" wide>{evidence && <ReportChat report={evidence} />}</Modal>
    </>;
}

// The chat a member report came from, read-only: who wrote each line and when. The reported member's lines are bold.
function ReportChat({ report }: { report: Report }) {
    const [messages, setMessages] = useState<EvidenceMessage[] | null>(null), [error, setError] = useState('');
    useEffect(() => { api<{ messages: EvidenceMessage[] }>(`manage/reports/${report.id}/messages`).then(d => setMessages(d.messages)).catch(e => setError(errorText(e))); }, [report.id]);
    if (error) return <p className="muted">{error}</p>;
    if (!messages) return <SkeletonRows count={3} height={48} />;
    if (!messages.length) return <EmptyState title="메시지가 없습니다" />;
    const text = (m: EvidenceMessage) => m.type === 'offer' ? '가격 제시' : m.type === 'listing' ? `문의한 글: ${m.body}` : [m.body, m.photos ? `사진 ${m.photos}장` : ''].filter(Boolean).join(' · ');
    return <ul className="report-chat">{messages.map(m => <li key={m.id} className={m.sender_id === report.target_user_id ? 'is-target' : ''}>
        <span className="muted small">{m.nickname} · {dateText(m.created_at)} {new Date(m.created_at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit' })}</span>
        <span className={m.type === 'system' ? 'muted' : ''}>{text(m)}</span>
    </li>)}</ul>;
}

function Notices() {
    const [list, setList] = useState<Notice[] | null>(null), [editing, setEditing] = useState<Partial<Notice> | null>(null);
    const load = () => api<{ notices: Notice[] }>('notices').then(d => setList(d.notices)).catch(() => setList([]));
    useEffect(() => { void load(); }, []);
    async function save() {
        if (!editing) return;
        try { await api('manage/notice' + (editing.id ? '/' + editing.id : ''), editing.id ? 'PUT' : 'POST', { title: editing.title, body: editing.body }); setEditing(null); toast('저장 완료'); void load(); }
        catch (e) { toast.error(errorText(e)); }
    }
    const [deleting, setDeleting] = useState<Notice | null>(null);
    async function remove(id: number) {
        try { await api('manage/notice/' + id, 'DELETE'); toast('삭제 완료'); setDeleting(null); void load(); } catch (e) { toast.error(errorText(e)); }
    }
    return <>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({ title: '', body: '' })}>새 공지</button>
        <div className="mt-16">{list === null ? <SkeletonRows count={2} height={60} /> : list.length ? <ul className="simple-list">{list.map(n => <li key={n.id}>
            <span className="grow"><strong>{n.title}</strong><span className="muted small">{dateText(n.created_at)}</span></span>
            <button type="button" className="btn btn-line btn-xs" onClick={() => setEditing(n)}>수정</button>
            <button type="button" className="btn btn-line btn-xs" onClick={() => setDeleting(n)}>삭제</button>
        </li>)}</ul> : <EmptyState title="공지가 없습니다" />}</div>
        <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? '공지 수정' : '새 공지'} footer={<button className="btn btn-primary btn-lg" onClick={save}>저장</button>}>
            <div className="form-stack">
                <label className="field"><span className="field-label">제목</span><input className="input" maxLength={100} value={editing?.title || ''} onChange={e => setEditing({ ...editing, title: e.target.value })} /></label>
                <label className="field"><span className="field-label">내용</span><textarea className="textarea" maxLength={10000} value={editing?.body || ''} onChange={e => setEditing({ ...editing, body: e.target.value })} /></label>
            </div>
        </Modal>
        <Modal open={!!deleting} onClose={() => setDeleting(null)} title="공지 삭제" description={deleting?.title}
            footer={<><button className="btn btn-line" onClick={() => setDeleting(null)}>취소</button><button className="btn btn-danger-solid" onClick={() => deleting && remove(deleting.id)}>삭제</button></>} />
    </>;
}

type TrialInfo = { start: number | null; end: number | null; open: boolean; granted: number; active: number; applied: number };
const KST = 9 * 3600000;
// 'YYYY-MM-DDTHH:mm' on the Korean calendar for a datetime-local input, and back (to the end of that minute).
const kstInput = (t: number) => new Date(t + KST).toISOString().slice(0, 16);
const fromKstInput = (v: string) => { const t = Date.parse(v + ':00Z'); return Number.isFinite(t) ? t - KST + 59999 : NaN; };

// '플러스 무료 체험': the sign-up window, the counts, 종료일 변경 (up to 90 days ahead) and 지금 마감.
function TrialCard() {
    const { refreshConfig } = useApp();
    const [info, setInfo] = useState<TrialInfo | null>(null);
    const [sheet, setSheet] = useState<'' | 'end' | 'close'>(''), [end, setEnd] = useState(''), [endRunning, setEndRunning] = useState(false), [busy, setBusy] = useState(false);
    useEffect(() => { api<TrialInfo>('manage/trial').then(setInfo).catch(e => toast.error(errorText(e))); }, []);
    async function save(data: Record<string, unknown>, done: string) {
        setBusy(true);
        try { setInfo(await api<TrialInfo>('manage/trial', 'PUT', data)); setSheet(''); refreshConfig(); toast(done); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    if (!info) return null;
    const now = Date.now();
    return <section className="card card-pad trial-admin">
        <h2 className="card-title">플러스 무료 체험</h2>
        <p>가입 기간 {info.start ? kstDateTime(info.start) : '-'} ~ {info.end && info.end > 0 ? kstDateTime(info.end) : '-'}</p>
        <p className="muted small">체험 받은 회원 {info.granted}명 · 지금 체험 중 {info.active}명 · 체험 후 등급 신청 {info.applied}명</p>
        <div className="row mt-8">
            <button type="button" className="btn btn-line btn-sm" onClick={() => { setEnd(kstInput(Math.max(info.end && info.end > now ? info.end : now + 86400000, now))); setSheet('end'); }}>종료일 변경</button>
            <button type="button" className="btn btn-line btn-sm" disabled={!info.open} onClick={() => { setEndRunning(false); setSheet('close'); }}>지금 마감</button>
        </div>
        <Modal open={sheet === 'end'} onClose={() => { if (!busy) setSheet(''); }} title="종료일 변경"
            footer={<button className="btn btn-primary btn-lg btn-block" disabled={busy || !end} onClick={() => save({ end: fromKstInput(end) }, '저장 완료')}>저장</button>}>
            <label className="field"><span className="field-label">종료 일시</span>
                <input className="input" type="datetime-local" value={end} min={kstInput(now)} max={kstInput(now + 90 * 86400000)} onChange={e => setEnd(e.target.value)} />
                <span className="field-hint">한국 시간 · 90일 이내</span></label>
        </Modal>
        <Modal open={sheet === 'close'} onClose={() => { if (!busy) setSheet(''); }} title="지금 마감"
            footer={<button className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={() => save({ close: true, endRunning }, '마감 완료')}>마감</button>}>
            <label className="check"><input type="checkbox" checked={endRunning} onChange={e => setEndRunning(e.target.checked)} />진행 중인 체험도 지금 끝내기</label>
        </Modal>
    </section>;
}

function Settings() {
    const { config, refreshConfig } = useApp();
    const [notice, setNotice] = useState(config.paymentNotice), [season, setSeason] = useState(String(config.latestSeason)), [busy, setBusy] = useState(false);
    useEffect(() => { setNotice(config.paymentNotice); setSeason(String(config.latestSeason)); }, [config]);
    async function save(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        try { await api('manage/settings', 'PUT', { paymentNotice: notice, latestSeason: Number(season) }); refreshConfig(); toast('저장 완료'); }
        catch (err) { toast.error(errorText(err)); }
        finally { setBusy(false); }
    }
    return <><TrialCard /><form className="settings-form" onSubmit={save}>
        <label className="field"><span className="field-label">등급 입금 안내</span>
            <textarea className="textarea" style={{ minHeight: 110 }} maxLength={300} value={notice} onChange={e => setNotice(e.target.value)} placeholder="예: 국민은행 000000-00-000000 (예금주 ○○○)" />
            <span className="field-hint">신청 창 입금 안내에 표시. 비우면 ‘채팅으로 안내’로 표시.</span></label>
        <label className="field"><span className="field-label">현재 래더 시즌</span>
            <div className="input-unit" style={{ maxWidth: 200 }}><input className="input" type="number" min={32} max={200} value={season} onChange={e => setSeason(e.target.value)} /><span>시즌</span></div>
            <span className="field-hint">새 시즌 오픈 시 변경. 글쓰기, 검색 시즌 목록에 반영. 낮출 수 없음.</span></label>
        <div><button className="btn btn-primary" disabled={busy}>저장</button></div>
    </form></>;
}
