import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { AD_TEXT, APPLICATION_STATUS_NAMES, BADGES, GRADES, PERKS, applicationTemplate, canProvide, gradeInfo, isProviderType, type Application, type ApplicationKind, type PlanId } from '../../shared/membership';
import { gradeExtras, gradeHook, gradeLine, isPaidGrade, monthly } from '../../shared/benefits';
import { api, errorText } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { GradeMark, Icon, Modal, NameLine, Tabs, VerifiedMark } from '../components/ui';
import { EarnBlock } from '../components/ProviderCard';
import { useApp } from './state';

type Choice = { kind: ApplicationKind; target: string; plan?: PlanId };

export const chatDraftKey = (chatId: string) => 'chat-draft:' + chatId;
// Tells an open chat room that a draft for it is waiting (the route may not change).
export const CHAT_DRAFT_EVENT = 'zg:chat-draft';

const won = (n: number) => n.toLocaleString('ko-KR') + '원';

export function ApplyModal() {
    const { apply, closeApply, me, config, requireLogin, refreshUnread } = useApp();
    const open = apply !== null;
    const preset = apply && apply !== 'open' ? apply : null;
    const [tab, setTab] = useState<ApplicationKind>('badge');
    // Each tab keeps its own choice, so the 등급 tab never submits a choice made on the 인증 tab.
    const [choices, setChoices] = useState<Record<ApplicationKind, Choice | null>>({ badge: null, grade: null });
    const [mine, setMine] = useState<Application[]>([]);
    const [busy, setBusy] = useState(false);

    const ownsBadge = (id: string) => !!me?.badges.includes(id as never);
    const allBadges = BADGES.every(b => ownsBadge(b.id));
    const rank = gradeInfo(me?.grade).rank;
    // The grade shown is the member's best one, and a permanent row wins a tie, so no expiry
    // means that rank is held for good. The server refuses the same rank or lower then.
    const permanent = rank > 0 && !me?.grade_expires_at;
    const heldForGood = (target: string) => permanent && gradeInfo(target).rank <= rank;
    const gradeClosed = (target: string) => gradeInfo(target).rank < rank || heldForGood(target);
    // A 6-month holder renews the same grade: the new 6 months start when the current ones end.
    const renewing = (target: string) => rank > 0 && !permanent && me?.grade === target;
    const anyGradeOpen = GRADES.some(g => g.plans.length && !gradeClosed(g.id));

    useEffect(() => {
        if (!open) return;
        setTab(preset?.kind || 'badge');
        const presetChoice = preset ? { kind: preset.kind, target: preset.target, plan: preset.plan || (preset.kind === 'grade' ? 'permanent' as PlanId : undefined) } : null;
        // Without a preset nothing is selected; the member picks first.
        setChoices({
            badge: presetChoice?.kind === 'badge' ? presetChoice : null,
            grade: presetChoice?.kind === 'grade' ? presetChoice : null,
        });
        if (me && me.role !== 'manager') api<{ applications: Application[] }>('applications').then(d => setMine(d.applications)).catch(() => {});
    }, [open]);

    // A choice for a verification the member already has (e.g. after logging in) is dropped.
    const raw = choices[tab];
    // 중개·가측 인증 stays locked below 플러스 and on the 무료 체험 (WP66), even when a button preset it.
    const locked = (target: string) => isProviderType(target) && !!me && !canProvide(me);
    const choice = raw && !(raw.kind === 'badge' && (ownsBadge(raw.target) || locked(raw.target))) && !(raw.kind === 'grade' && gradeClosed(raw.target)) ? raw : null;
    const choose = (c: Choice) => setChoices(v => ({ ...v, [c.kind]: c }));
    const pendingFor = (kind: string, target: string) => mine.find(a => a.kind === kind && a.target === target && a.status === 'pending');

    async function submit() {
        if (!choice) return;
        const selected = choice;
        const run = async () => {
            setBusy(true);
            try {
                const d = await api<{ id: string; chatId: string; created: boolean }>('applications', 'POST', selected);
                try {
                    sessionStorage.setItem(chatDraftKey(d.chatId), applicationTemplate(selected.kind, selected.target, selected.plan));
                    window.dispatchEvent(new CustomEvent(CHAT_DRAFT_EVENT, { detail: d.chatId }));
                } catch { /* storage may be unavailable */ }
                closeApply();
                refreshUnread();
                void navigate('/chat/' + d.chatId);
                toast(d.created ? '신청 완료' : '이미 신청한 건입니다. 채팅으로 이동합니다.');
            } catch (e) { toast.error(errorText(e)); }
            finally { setBusy(false); }
        };
        if (me) await run();
        else requireLogin(u => { if (!(selected.kind === 'badge' && u.badges.includes(selected.target as never))) void run(); });
    }

    if (me?.role === 'manager') {
        return <Modal open={open} onClose={closeApply} title="인증/등급 신청" footer={<button className="btn btn-primary btn-lg" onClick={() => { closeApply(); void navigate('/manage/applications'); }}>신청 관리</button>}>
            <p className="muted">매니저 계정은 신청할 수 없습니다.</p>
        </Modal>;
    }

    const hint = choice ? '신청하면 매니저 채팅방이 열립니다.'
        : tab === 'badge' ? (allBadges ? '모든 인증 보유' : '인증을 고르세요.')
        : anyGradeOpen ? '등급과 기간을 고르세요.' : '신청 가능한 등급 없음';
    return <Modal wide open={open} onClose={() => { if (!busy) closeApply(); }} title="인증/등급 신청"
        footer={<div className="apply-footer">
            <p className={'apply-hint' + (choice ? '' : ' is-pending')} aria-live="polite">{hint}</p>
            <button className="btn btn-primary btn-lg" disabled={!choice || busy} onClick={submit}>{busy ? <LoaderCircle size={20} className="spin" /> : '신청하러 가기'}</button>
        </div>}>
        <Tabs label="신청 종류" value={tab} onChange={setTab} items={[{ id: 'badge', label: '인증' }, { id: 'grade', label: '등급' }]} />
        {tab === 'badge' ? <div className="apply-pane">
            <p className="apply-intro">매니저 확인 후 지급합니다. 중복으로 받을 수 있고 닉네임 옆에 표시됩니다. <span className="apply-example"><NameLine nickname="예시닉네임" badges={['identity']} /></span></p>
            <div className="apply-options" role="radiogroup" aria-label="인증 종류">
                {BADGES.map(b => {
                    const owned = ownsBadge(b.id), pending = pendingFor('badge', b.id);
                    // 중개·가측 인증 (WP66): 플러스 and up only, never the 무료 체험 (guests see the rule and sign in first).
                    const closed = !owned && locked(b.id);
                    return <label key={b.id} className={'apply-option' + (owned ? ' is-owned' : closed ? ' is-locked' : '')}>
                        <input type="radio" name="apply-badge" disabled={owned || closed} checked={choice?.kind === 'badge' && choice.target === b.id} onChange={() => choose({ kind: 'badge', target: b.id })} />
                        <span className="apply-option-icon"><Icon name={b.icon} size={24} /></span>
                        <span className="apply-option-body">
                            <span className="apply-option-title">{b.name}
                                {owned ? <span className="apply-state on"><VerifiedMark size={14} />보유</span> : pending ? <span className="apply-state">{APPLICATION_STATUS_NAMES.pending}</span> : null}</span>
                            <span className="apply-option-text">{b.summary}</span>
                            <span className="apply-need">제출: {b.requirements.join(', ')}</span>
                            {closed && <span className="apply-lock">플러스 이상 등급부터 신청 가능 (무료 체험 제외) <button type="button" className="apply-link" onClick={e => { e.preventDefault(); setTab('grade'); }}>등급 보기</button></span>}
                        </span>
                        {!owned && !closed && <span className="radio-dot" aria-hidden="true" />}
                    </label>;
                })}
            </div>
        </div> : <div className="apply-pane">
            {/* 수익 홍보 (WP66) leads the 등급 part. */}
            <EarnBlock earn={config.earn} className="earn-apply" />
            <p className="apply-intro">입금 확인 후 매니저가 지급합니다. <Link to="/guide#grade" className="apply-link" onClick={e => {
                closeApply();
                // Already on the guide: the address does not change, so scroll to the table here.
                if (location.pathname === '/guide') { e.preventDefault(); history.replaceState(history.state, '', '/guide#grade'); setTimeout(() => document.getElementById('grade')?.scrollIntoView({ block: 'start' }), 50); }
            }}>혜택 보기</Link></p>
            <div className="grade-table" role="radiogroup" aria-label="등급과 기간">
                {GRADES.map(g => {
                    const pending = pendingFor('grade', g.id), current = (me?.grade || 'normal') === g.id, paid = isPaidGrade(g.id) ? g.id : null;
                    // 등급 혜택 (WP61): the hook from real numbers first, then the grade's line and '혜택 N가지', all from
                    // PERKS; the metal accent of the grade (엘리트 gold with '모든 혜택').
                    const metal = paid === 'elite' ? ' metal-gold' : paid === 'premium' ? ' metal-silver' : paid === 'plus' ? ' metal-bronze' : '';
                    return <div key={g.id} className={'grade-row' + metal + (current ? ' is-current' : '')}>
                        <GradeMark grade={g.id} size={28} />
                        <div className="grade-row-name">
                            <span className="grade-row-title"><strong>{g.name}</strong>{paid === 'elite' && <span className="grade-card-all">모든 혜택</span>}{current && <span className="apply-state on">{me?.grade_trial ? '체험 중' : '현재'}</span>}{pending && <span className="apply-state">{APPLICATION_STATUS_NAMES.pending}</span>}</span>
                            {paid && <span className="grade-row-hook">{gradeHook(paid)}</span>}
                            {paid && <span className="grade-row-perks">{gradeLine(paid)}</span>}
                            {paid && <span className="grade-row-count">혜택 {gradeExtras(paid).length}가지</span>}
                            {/* 중개·가측 인증 needs a paid 플러스 (WP66), though the 플러스 row lists it. */}
                            {current && g.id === 'plus' && me?.grade_trial && <span className="muted small">중개·가측 인증은 유료 플러스부터</span>}
                            {/* 광고 (WP53) needs 본인 인증 too; a member who has it is not reminded. */}
                            {PERKS[g.id].adSlots > 0 && g.plans.length > 0 && !ownsBadge('identity') && <span className="muted small">{AD_TEXT.hint}</span>}
                        </div>
                        <div className="grade-row-plans">
                            {g.plans.length ? g.plans.map(p => {
                                // Lower grades cannot be bought, nor a grade held permanently (or below it).
                                const disabled = gradeClosed(g.id), owned = heldForGood(g.id);
                                const label = p.id === '6m' && renewing(g.id) ? '연장' : p.label;
                                return <label key={p.id} className={'plan' + (owned ? ' is-owned' : disabled ? ' is-disabled' : '')}>
                                    <input type="radio" name="apply-grade" aria-label={`${g.name} ${label}${owned ? ' 보유 중' : ''}`} disabled={disabled} checked={choice?.kind === 'grade' && choice.target === g.id && choice.plan === p.id} onChange={() => choose({ kind: 'grade', target: g.id, plan: p.id })} />
                                    {!owned && <span className="radio-dot" aria-hidden="true" />}
                                    <span>{label}</span>{owned ? <span className="apply-state on">보유 중</span> : <b>{won(p.price)}{p.months ? <span className="plan-month">월 환산 {monthly(p.price, p.months)}</span> : null}</b>}
                                </label>;
                            }) : <span className="muted small">{g.note}</span>}
                        </div>
                    </div>;
                })}
            </div>
            <div className="pay-box">
                <strong>입금 안내</strong>
                <p>{config.paymentNotice || '입금 계좌는 신청 후 채팅으로 안내합니다.'}</p>
                <p className="muted small">입금 후 채팅에 입금자명, 입금 시간을 남겨 주세요. 6개월권은 지급일부터 6개월, 연장은 끝나는 날부터 6개월. 6개월 등급이 끝나도 올린 글과 사진은 그대로 남습니다.</p>
            </div>
        </div>}
    </Modal>;
}
