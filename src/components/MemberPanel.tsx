import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BADGES, GRADES, APPLICATION_STATUS_NAMES, applicationTitle, gradeInfo, type Application, type GradeId, type PlanId } from '../../shared/membership';
import { dateText, type User } from '../../shared/market';
import { api, errorText } from '../lib/api';
import { Link } from '../lib/router';
import { NameLine } from './ui';

type Grant = { id: number; grade: GradeId; expires_at: number | null; granted_at: number; application_id: string | null };
type Detail = { user: User & { username: string }; grants: Grant[]; badges: { badge: string; granted_at: number }[]; applications: Application[] };

// Manager tools for one member: verification switches, grade grants, applications.
// `version` reloads the panel after changes made elsewhere (e.g. the chat's application card).
// Inside the member's chat the pending applications already show as cards, so `inChat` hides them here.
export function MemberPanel({ userId, onChange, version = 0, inChat = false }: { userId: string; onChange?: () => void; version?: number; inChat?: boolean }) {
    const [data, setData] = useState<Detail | null>(null), [error, setError] = useState('');
    const [grade, setGrade] = useState<GradeId>('plus'), [plan, setPlan] = useState<PlanId>('permanent'), [busy, setBusy] = useState(false);
    const load = useCallback(() => api<Detail>('manage/users/' + userId).then(setData).catch(e => setError(errorText(e))), [userId]);
    useEffect(() => { void load(); }, [load, version]);
    const plans = gradeInfo(grade).plans;
    useEffect(() => { if (!plans.some(p => p.id === plan)) setPlan('permanent'); }, [grade]);

    const run = async (task: () => Promise<unknown>, message: string) => {
        setBusy(true);
        try { await task(); toast(message); await load(); onChange?.(); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
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
            <h4>확인 중인 신청</h4>
            {pending.map(a => <div key={a.id} className="mp-app">
                <span>{applicationTitle(a)}</span>
                <div className="row">
                    <button type="button" className="btn btn-primary btn-sm grow" disabled={busy} onClick={() => run(() => api('applications/' + a.id, 'PATCH', { action: 'approve' }), '지급했어요.')}>승인하고 지급</button>
                    <button type="button" className="btn btn-line btn-sm grow" disabled={busy} onClick={() => run(() => api('applications/' + a.id, 'PATCH', { action: 'reject' }), '반려했어요.')}>반려</button>
                </div>
            </div>)}
        </div>}
        <div className="mp-block">
            <h4>인증</h4>
            {BADGES.map(b => {
                const on = u.badges.includes(b.id);
                return <label key={b.id} className="mp-row switch">
                    <span className="grow">{b.name}{on && <span className="muted small"> · {dateText(data.badges.find(x => x.badge === b.id)?.granted_at || now)}</span>}</span>
                    <input type="checkbox" checked={on} disabled={busy} onChange={() => run(() => api(`manage/users/${u.id}/badges`, 'POST', { badge: b.id, active: !on }), on ? `${b.name}을 회수했어요.` : `${b.name}을 지급했어요.`)} />
                </label>;
            })}
        </div>
        {u.role !== 'manager' && <div className="mp-block">
            <h4>등급 <span className="muted small">현재 {gradeInfo(u.grade).name}{u.grade_expires_at ? ` · ${dateText(u.grade_expires_at)}까지` : ''}</span></h4>
            {active.length > 0 ? active.map(g => <div key={g.id} className="mp-row">
                <span className="grow">{gradeInfo(g.grade).name} <span className="muted small">{g.expires_at ? `${dateText(g.expires_at)}까지` : '영구'}</span></span>
                <button type="button" className="btn btn-line btn-xs" disabled={busy} onClick={() => run(() => api(`manage/users/${u.id}/grades/${g.id}`, 'DELETE'), '등급을 회수했어요.')}>회수</button>
            </div>) : <p className="muted small">지급된 등급이 없어요 (일반).</p>}
            <div className="mp-grant">
                <select className="select" aria-label="지급할 등급" value={grade} onChange={e => setGrade(e.target.value as GradeId)}>{GRADES.filter(g => g.id !== 'normal').map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
                <select className="select" aria-label="기간" value={plan} onChange={e => setPlan(e.target.value as PlanId)}>{(plans.length ? plans : [{ id: 'permanent', label: '영구' }]).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => api(`manage/users/${u.id}/grades`, 'POST', { grade, plan }), `${gradeInfo(grade).name} 등급을 지급했어요.`)}>지급</button>
            </div>
        </div>}
        {data.applications.length > pending.length && <div className="mp-block">
            <h4>지난 신청</h4>
            {data.applications.filter(a => a.status !== 'pending').slice(0, 8).map(a => <div key={a.id} className="mp-row small"><span className="grow">{applicationTitle(a)}</span><span className="muted">{APPLICATION_STATUS_NAMES[a.status]}</span></div>)}
        </div>}
    </div>;
}
