import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BADGES, GRADES, APPLICATION_STATUS_NAMES, applicationTitle, gradeInfo, type Application, type GradeId, type PlanId } from '../../shared/membership';
import { dateText, type User } from '../../shared/market';
import { api, errorText } from '../lib/api';
import { Link } from '../lib/router';
import { Modal, NameLine } from './ui';

type Grant = { id: number; grade: GradeId; expires_at: number | null; granted_at: number; application_id: string | null };
type Revoke = { name: string; description?: string; task: () => Promise<unknown>; done: string };
type Detail = { user: User & { username: string; deleted_at?: number | null }; grants: Grant[]; badges: { badge: string; granted_at: number }[]; applications: Application[] };

// Manager tools for one member: verification switches, grade grants, applications.
// `version` reloads the panel after changes made elsewhere (e.g. the chat's application card).
// Inside the member's chat the pending applications already show as cards, so `inChat` hides them here.
export function MemberPanel({ userId, onChange, version = 0, inChat = false }: { userId: string; onChange?: () => void; version?: number; inChat?: boolean }) {
    const [data, setData] = useState<Detail | null>(null), [error, setError] = useState('');
    const [grade, setGrade] = useState<GradeId>('plus'), [plan, setPlan] = useState<PlanId>('permanent'), [busy, setBusy] = useState(false);
    // Temporary password: confirm first, then show the result once (it is not stored anywhere readable).
    const [resetting, setResetting] = useState(false), [temp, setTemp] = useState('');
    // Turning a badge off or taking back a grade asks first.
    const [revoke, setRevoke] = useState<Revoke | null>(null);
    const load = useCallback(() => api<Detail>('manage/users/' + userId).then(setData).catch(e => setError(errorText(e))), [userId]);
    useEffect(() => { void load(); }, [load, version]);
    const plans = gradeInfo(grade).plans;
    useEffect(() => { if (!plans.some(p => p.id === plan)) setPlan('permanent'); }, [grade]);

    const run = async (task: () => Promise<unknown>, message: string) => {
        setBusy(true);
        try { await task(); toast(message); setRevoke(null); await load(); onChange?.(); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    };
    const issue = async () => {
        setBusy(true);
        try { const d = await api<{ password: string }>(`manage/users/${userId}/password`, 'POST', {}); setResetting(false); setTemp(d.password); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    };
    const copy = async () => {
        try { await navigator.clipboard.writeText(temp); toast('복사 완료'); }
        catch { toast.error('복사하지 못했습니다.'); }
    };
    if (error) return <p className="muted">{error}</p>;
    if (!data) return <div className="skeleton" style={{ height: 240 }} />;
    const u = data.user, now = Date.now();
    const active = data.grants.filter(g => g.expires_at === null || g.expires_at > now);
    const pending = data.applications.filter(a => a.status === 'pending');

    return <div className="member-panel">
        <div className="mp-head">
            <NameLine nickname={u.nickname} grade={u.grade} role={u.role} badges={u.badges} />
            <span className="muted small">@{u.username} · {dateText(u.created_at)} 가입 · <Link to={'/profile/' + u.id}>프로필</Link></span>
        </div>
        {pending.length > 0 && !inChat && <div className="mp-block">
            <h4>신청 대기</h4>
            {pending.map(a => <div key={a.id} className="mp-app">
                <span>{applicationTitle(a)}</span>
                <div className="row">
                    <button type="button" className="btn btn-primary btn-sm grow" disabled={busy} onClick={() => run(() => api('applications/' + a.id, 'PATCH', { action: 'approve' }), '지급 완료')}>승인</button>
                    <button type="button" className="btn btn-line btn-sm grow" disabled={busy} onClick={() => run(() => api('applications/' + a.id, 'PATCH', { action: 'reject' }), '반려 완료')}>반려</button>
                </div>
            </div>)}
        </div>}
        <div className="mp-block">
            <h4>인증</h4>
            {BADGES.map(b => {
                const on = u.badges.includes(b.id);
                const set = (active: boolean) => () => api(`manage/users/${u.id}/badges`, 'POST', { badge: b.id, active });
                // Only the switch itself toggles; the name next to it is plain text.
                return <div key={b.id} className="mp-row">
                    <span className="grow">{b.name}{on && <span className="muted small"> · {dateText(data.badges.find(x => x.badge === b.id)?.granted_at || now)}</span>}</span>
                    <span className="switch"><input type="checkbox" role="switch" aria-label={b.name} checked={on} disabled={busy}
                        onChange={() => on ? setRevoke({ name: b.name, description: b.id === 'proxy' ? '대리(진행) 글이 목록에서 빠집니다.' : undefined, task: set(false), done: `${b.name} 회수 완료` }) : void run(set(true), `${b.name} 지급 완료`)} /></span>
                </div>;
            })}
        </div>
        {u.role !== 'manager' && <div className="mp-block">
            <h4>등급 <span className="muted small">현재 {gradeInfo(u.grade).name}{u.grade_expires_at ? ` · ${dateText(u.grade_expires_at)}까지` : ''}</span></h4>
            {active.length > 0 ? active.map(g => <div key={g.id} className="mp-row">
                <span className="grow">{gradeInfo(g.grade).name} <span className="muted small">{g.expires_at ? `${dateText(g.expires_at)}까지` : '영구'}</span></span>
                <button type="button" className="btn btn-line btn-xs" disabled={busy} onClick={() => setRevoke({ name: `${gradeInfo(g.grade).name} 등급`, task: () => api(`manage/users/${u.id}/grades/${g.id}`, 'DELETE'), done: '등급 회수 완료' })}>회수</button>
            </div>) : <p className="muted small">지급 내역 없음</p>}
            <div className="mp-grant">
                <select className="select" aria-label="지급할 등급" value={grade} onChange={e => setGrade(e.target.value as GradeId)}>{GRADES.filter(g => g.id !== 'normal').map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
                <select className="select" aria-label="기간" value={plan} onChange={e => setPlan(e.target.value as PlanId)}>{(plans.length ? plans : [{ id: 'permanent', label: '영구' }]).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => api(`manage/users/${u.id}/grades`, 'POST', { grade, plan }), `${gradeInfo(grade).name} 등급 지급 완료`)}>지급</button>
            </div>
        </div>}
        {data.applications.length > pending.length && <div className="mp-block">
            <h4>지난 신청</h4>
            {data.applications.filter(a => a.status !== 'pending').slice(0, 8).map(a => <div key={a.id} className="mp-row small"><span className="grow">{applicationTitle(a)}</span><span className="muted">{APPLICATION_STATUS_NAMES[a.status]}</span></div>)}
        </div>}
        {u.role !== 'manager' && !u.deleted_at && <div className="mp-block">
            <h4>계정</h4>
            <button type="button" className="btn btn-line btn-sm" disabled={busy} onClick={() => setResetting(true)}>임시 비밀번호 발급</button>
        </div>}
        <Modal open={!!revoke} onClose={() => { if (!busy) setRevoke(null); }} title={revoke ? `${u.nickname}님 ${revoke.name} 회수` : ''} description={revoke?.description}
            footer={<><button type="button" className="btn btn-line" disabled={busy} onClick={() => setRevoke(null)}>취소</button><button type="button" className="btn btn-danger-solid" disabled={busy} onClick={() => { if (revoke) void run(revoke.task, revoke.done); }}>회수</button></>}>
            <NameLine nickname={u.nickname} grade={u.grade} role={u.role} badges={u.badges} />
        </Modal>
        <Modal open={resetting} onClose={() => { if (!busy) setResetting(false); }} title="임시 비밀번호 발급" description="기존 비밀번호는 바로 쓸 수 없게 되고, 모든 기기에서 로그아웃됩니다."
            footer={<><button type="button" className="btn btn-line" disabled={busy} onClick={() => setResetting(false)}>취소</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void issue()}>발급</button></>}>
            <NameLine nickname={u.nickname} grade={u.grade} role={u.role} badges={u.badges} />
        </Modal>
        <Modal open={!!temp} onClose={() => setTemp('')} title="임시 비밀번호"
            footer={<button type="button" className="btn btn-primary" onClick={() => void copy()}>복사</button>}>
            <div className="field">
                <input className="input" readOnly value={temp} aria-label="임시 비밀번호" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 20, letterSpacing: '0.08em' }} onFocus={e => e.currentTarget.select()} />
                <span className="field-hint">회원에게 채팅으로 전달하세요.</span>
            </div>
        </Modal>
    </div>;
}
