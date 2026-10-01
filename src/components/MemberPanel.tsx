import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BADGES, GRADES, APPLICATION_STATUS_NAMES, applicationTitle, gradeInfo, type Application, type GradeId, type PlanId } from '../../shared/membership';
import { MEMBER_REPORT_REASONS, SUSPEND_DAYS, SUSPEND_FOREVER, dateText, longDate, reviewName, suspendDaysLabel, suspendEndText, type Review, type User } from '../../shared/market';
import { api, errorText } from '../lib/api';
import { Link } from '../lib/router';
import { Modal, NameLine } from './ui';

type Grant = { id: number; grade: GradeId; expires_at: number | null; granted_at: number; application_id: string | null };
type Revoke = { name: string; description?: string; task: () => Promise<unknown>; done: string };
type Sanction = { id: number; days: number | null; reason: string; created_at: number };
// A 후기 the member received (GET /users/:id/reviews), which the manager may delete (WP23).
type ReviewRow = Review & { nickname: string };
type Detail = { user: User & { username: string; deleted_at?: number | null; suspend_reason?: string }; grants: Grant[]; badges: { badge: string; granted_at: number }[]; applications: Application[]; sanctions?: Sanction[] };
// Reason chips for 이용 정지: the member report reasons except 기타 (typed in instead).
const SUSPEND_REASONS = MEMBER_REPORT_REASONS.filter(r => r !== '기타');

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
    // 이용 정지: the period chip and reason, then a confirm (days null: 정지 해제).
    const [suspendDays, setSuspendDays] = useState<number>(7), [suspendReason, setSuspendReason] = useState(''), [suspending, setSuspending] = useState<{ days: number | null } | null>(null);
    // 받은 후기 (the latest 20) and the one waiting for the delete confirm.
    const [reviews, setReviews] = useState<{ rows: ReviewRow[]; total: number } | null>(null), [removing, setRemoving] = useState<ReviewRow | null>(null);
    const load = useCallback(() => Promise.all([
        api<Detail>('manage/users/' + userId).then(setData).catch(e => setError(errorText(e))),
        api<{ reviews: ReviewRow[]; total: number }>(`users/${userId}/reviews`).then(d => setReviews({ rows: d.reviews, total: d.total })).catch(() => setReviews(null)),
    ]), [userId]);
    useEffect(() => { void load(); }, [load, version]);
    const plans = gradeInfo(grade).plans;
    useEffect(() => { if (!plans.some(p => p.id === plan)) setPlan('permanent'); }, [grade]);

    const run = async (task: () => Promise<unknown>, message: string) => {
        setBusy(true);
        try { await task(); toast(message); setRevoke(null); setSuspending(null); setRemoving(null); await load(); onChange?.(); }
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
    const suspendedUntil = u.suspended_until && u.suspended_until > now ? u.suspended_until : null;
    const suspendEnd = (t: number) => t >= SUSPEND_FOREVER ? '영구' : suspendEndText(t) + '까지';
    const suspend = (days: number | null) => () => api(`manage/users/${u.id}/suspend`, 'POST', { days, reason: days === null ? '' : suspendReason.trim() }).then(() => { if (days !== null) setSuspendReason(''); });

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
                    <span className="switch"><input type="checkbox" role="switch" aria-label={b.name} checked={on} disabled={busy || (!on && !!u.deleted_at)}
                        onChange={() => on ? setRevoke({ name: b.name, description: b.id === 'proxy' ? '대리(진행) 글이 목록에서 빠집니다.' : undefined, task: set(false), done: `${b.name} 회수 완료` }) : void run(set(true), `${b.name} 지급 완료`)} /></span>
                </div>;
            })}
        </div>
        {u.role !== 'manager' && <div className="mp-block">
            <h4>등급 <span className="muted small">현재 {gradeInfo(u.grade).name}{u.grade_expires_at ? ` · ${longDate(u.grade_expires_at)}까지` : ''}</span></h4>
            {active.length > 0 ? active.map(g => <div key={g.id} className="mp-row">
                <span className="grow">{gradeInfo(g.grade).name} <span className="muted small">{g.expires_at ? `${longDate(g.expires_at)}까지` : '영구'}</span></span>
                <button type="button" className="btn btn-line btn-xs" disabled={busy} onClick={() => setRevoke({ name: `${gradeInfo(g.grade).name} 등급`, task: () => api(`manage/users/${u.id}/grades/${g.id}`, 'DELETE'), done: '등급 회수 완료' })}>회수</button>
            </div>) : <p className="muted small">지급 내역 없음</p>}
            {!u.deleted_at && <div className="mp-grant">
                <select className="select" aria-label="지급할 등급" value={grade} onChange={e => setGrade(e.target.value as GradeId)}>{GRADES.filter(g => g.id !== 'normal').map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
                <select className="select" aria-label="기간" value={plan} onChange={e => setPlan(e.target.value as PlanId)}>{(plans.length ? plans : [{ id: 'permanent', label: '영구' }]).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => api(`manage/users/${u.id}/grades`, 'POST', { grade, plan }), `${gradeInfo(grade).name} 등급 지급 완료`)}>지급</button>
            </div>}
        </div>}
        {data.applications.length > pending.length && <div className="mp-block">
            <h4>지난 신청</h4>
            {data.applications.filter(a => a.status !== 'pending').slice(0, 8).map(a => <div key={a.id} className="mp-row small"><span className="grow">{applicationTitle(a)}</span><span className="muted">{APPLICATION_STATUS_NAMES[a.status]}</span></div>)}
        </div>}
        {u.role !== 'manager' && (!u.deleted_at || suspendedUntil) && <div className="mp-block">
            <h4>이용 정지{suspendedUntil && <span className="muted small"> {suspendEnd(suspendedUntil)}</span>}</h4>
            {suspendedUntil ? <div className="mp-row">
                <span className="grow">{u.suspend_reason ? `사유: ${u.suspend_reason}` : '이용 정지 중'}</span>
                <button type="button" className="btn btn-line btn-xs" disabled={busy} onClick={() => setSuspending({ days: null })}>정지 해제</button>
            </div> : <div className="mp-suspend">
                <div className="chip-row" role="group" aria-label="정지 기간">{SUSPEND_DAYS.map(d => <button type="button" key={d} className="chip chip-sm" aria-pressed={suspendDays === d} onClick={() => setSuspendDays(d)}>{suspendDaysLabel(d)}</button>)}</div>
                <div className="chip-row" role="group" aria-label="정지 사유 선택">{SUSPEND_REASONS.map(r => <button type="button" key={r} className="chip chip-sm" aria-pressed={suspendReason === r} onClick={() => setSuspendReason(r)}>{r}</button>)}</div>
                <input className="input" value={suspendReason} onChange={e => setSuspendReason(e.target.value)} maxLength={100} placeholder="정지 사유" aria-label="정지 사유" />
                <button type="button" className="btn btn-dark btn-sm" disabled={busy || suspendReason.trim().length < 2} onClick={() => setSuspending({ days: suspendDays })}>이용 정지</button>
            </div>}
            {(data.sanctions || []).slice(0, 5).map(x => <div key={x.id} className="mp-row small"><span className="grow">{x.days === null ? '정지 해제' : `이용 정지 ${suspendDaysLabel(x.days)}`}{x.reason && <span className="muted"> · {x.reason}</span>}</span><span className="muted">{dateText(x.created_at)}</span></div>)}
        </div>}
        {!u.deleted_at && reviews && <div className="mp-block">
            <h4>받은 후기{reviews.total > 0 && <span className="muted small"> {reviews.total}건</span>}</h4>
            {reviews.rows.length ? reviews.rows.map(r => <div key={r.id} className="mp-row mp-review">
                <span className="grow"><b>{reviewName(r.good)}</b> <span className="muted small">{r.nickname} · {dateText(r.created_at)}</span>
                    {r.tags.length > 0 && <span className="mp-review-text">{r.tags.join(', ')}</span>}
                    {r.text && <span className="mp-review-text">{r.text}</span>}</span>
                <button type="button" className="btn btn-line btn-xs" disabled={busy} onClick={() => setRemoving(r)}>삭제</button>
            </div>) : <p className="muted small">받은 후기 없음</p>}
        </div>}
        {u.role !== 'manager' && !u.deleted_at && <div className="mp-block">
            <h4>계정</h4>
            <button type="button" className="btn btn-line btn-sm" disabled={busy} onClick={() => setResetting(true)}>임시 비밀번호 발급</button>
        </div>}
        <Modal open={!!revoke} onClose={() => { if (!busy) setRevoke(null); }} title={revoke ? `${u.nickname}님 ${revoke.name} 회수` : ''} description={revoke?.description}
            footer={<><button type="button" className="btn btn-line" disabled={busy} onClick={() => setRevoke(null)}>취소</button><button type="button" className="btn btn-danger-solid" disabled={busy} onClick={() => { if (revoke) void run(revoke.task, revoke.done); }}>회수</button></>}>
            <NameLine nickname={u.nickname} grade={u.grade} role={u.role} badges={u.badges} />
        </Modal>
        <Modal open={!!suspending} onClose={() => { if (!busy) setSuspending(null); }} title={suspending?.days === null ? `${u.nickname}님 이용 정지 해제` : `${u.nickname}님 이용 정지 ${suspendDaysLabel(suspending?.days ?? 0)}`}
            description={suspending && suspending.days !== null ? `사유: ${suspendReason.trim()}` : undefined}
            footer={<><button type="button" className="btn btn-line" disabled={busy} onClick={() => setSuspending(null)}>취소</button>{suspending?.days === null
                ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(suspend(null), '이용 정지 해제')}>해제</button>
                : <button type="button" className="btn btn-danger-solid" disabled={busy} onClick={() => { if (suspending) void run(suspend(suspending.days), '이용 정지 완료'); }}>정지</button>}</>}>
            <NameLine nickname={u.nickname} grade={u.grade} role={u.role} badges={u.badges} />
        </Modal>
        <Modal open={!!removing} onClose={() => { if (!busy) setRemoving(null); }} title="후기 삭제" description="복구할 수 없습니다."
            footer={<><button type="button" className="btn btn-line" disabled={busy} onClick={() => setRemoving(null)}>취소</button><button type="button" className="btn btn-danger-solid" disabled={busy} onClick={() => { if (removing) void run(() => api(`manage/reviews/${removing.id}`, 'DELETE'), '삭제 완료'); }}>삭제</button></>}>
            {removing && <p className="small">{reviewName(removing.good)} · {removing.nickname}{removing.text ? ` · ${removing.text}` : ''}</p>}
        </Modal>
        <Modal open={resetting} onClose={() => { if (!busy) setResetting(false); }} title="임시 비밀번호 발급" description="기존 비밀번호는 바로 쓸 수 없게 되고, 모든 기기에서 로그아웃됩니다."
            footer={<><button type="button" className="btn btn-line" disabled={busy} onClick={() => setResetting(false)}>취소</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void issue()}>발급</button></>}>
            <NameLine nickname={u.nickname} grade={u.grade} role={u.role} badges={u.badges} />
        </Modal>
        <Modal open={!!temp} onClose={() => setTemp('')} title="임시 비밀번호"
            footer={<button type="button" className="btn btn-primary" onClick={() => void copy()}>복사</button>}>
            <div className="field">
                <input className="input mp-temp" readOnly value={temp} aria-label="임시 비밀번호" onFocus={e => e.currentTarget.select()} />
                <span className="field-hint">채팅으로 전달</span>
            </div>
        </Modal>
    </div>;
}
