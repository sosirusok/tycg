import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { BADGES, GRADES, applicationTemplate, gradeInfo, type Application, type ApplicationKind, type PlanId } from '../../shared/membership';
import { api, errorText } from '../lib/api';
import { navigate } from '../lib/router';
import { CIcon, Modal, NameLine, Tabs, VerifiedMark } from '../components/ui';
import { useApp } from './state';

type Choice = { kind: ApplicationKind; target: string; plan?: PlanId };

export const chatDraftKey = (chatId: string) => 'chat-draft:' + chatId;

const won = (n: number) => n.toLocaleString('ko-KR') + '원';

export function ApplyModal() {
    const { apply, closeApply, me, config, requireLogin, refreshUnread } = useApp();
    const open = apply !== null;
    const preset = apply && apply !== 'open' ? apply : null;
    const [tab, setTab] = useState<ApplicationKind>('badge');
    const [choice, setChoice] = useState<Choice | null>(null);
    const [mine, setMine] = useState<Application[]>([]);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!open) return;
        setTab(preset?.kind || 'badge');
        setChoice(preset ? { kind: preset.kind, target: preset.target, plan: preset.plan || (preset.kind === 'grade' ? 'permanent' : undefined) } : null);
        if (me && me.role !== 'manager') api<{ applications: Application[] }>('applications').then(d => setMine(d.applications)).catch(() => {});
    }, [open]);

    const pendingFor = (kind: string, target: string) => mine.find(a => a.kind === kind && a.target === target && a.status === 'pending');
    const ownsBadge = (id: string) => !!me?.badges.includes(id as never);
    const rank = gradeInfo(me?.grade).rank;

    async function submit() {
        if (!choice) return;
        const run = async () => {
            setBusy(true);
            try {
                const d = await api<{ id: string; chatId: string; created: boolean }>('applications', 'POST', choice);
                try { sessionStorage.setItem(chatDraftKey(d.chatId), applicationTemplate(choice.kind, choice.target, choice.plan)); } catch { /* storage may be unavailable */ }
                closeApply();
                refreshUnread();
                void navigate('/chat/' + d.chatId);
                toast(d.created ? '신청했어요. 매니저에게 필요한 정보를 보내 주세요.' : '확인 중인 신청이 있어 같은 채팅으로 이동했어요.');
            } catch (e) { toast.error(errorText(e)); }
            finally { setBusy(false); }
        };
        if (requireLogin(() => void run())) await run();
    }

    if (me?.role === 'manager') {
        return <Modal open={open} onClose={closeApply} title="인증·등급 신청" footer={<button className="btn btn-primary btn-lg" onClick={() => { closeApply(); void navigate('/manage/applications'); }}>신청 관리로 이동</button>}>
            <p className="muted">매니저 계정은 회원의 신청을 확인하고 인증과 등급을 지급합니다.</p>
        </Modal>;
    }

    return <Modal wide open={open} onClose={() => { if (!busy) closeApply(); }} title="인증·등급 신청"
        footer={<button className="btn btn-primary btn-lg" disabled={!choice || busy} onClick={submit}>{busy ? <LoaderCircle size={20} className="spin" /> : '신청하러 가기'}</button>}>
        <Tabs label="신청 종류" value={tab} onChange={setTab} items={[{ id: 'badge', label: '인증' }, { id: 'grade', label: '등급' }]} />
        {tab === 'badge' ? <div className="apply-pane">
            <p className="apply-intro">매니저가 직접 확인한 뒤 지급해요. 여러 개를 받을 수 있고, 닉네임 옆에 인증 이름과 체크 표시가 붙어요.</p>
            <div className="apply-example" aria-label="표시 예시"><span className="muted small">표시 예시</span><NameLine nickname="좀비사냥꾼" badges={['proxy', 'identity']} /></div>
            <div className="apply-options" role="radiogroup" aria-label="인증 종류">
                {BADGES.map(b => {
                    const owned = ownsBadge(b.id), pending = pendingFor('badge', b.id);
                    const selected = choice?.kind === 'badge' && choice.target === b.id;
                    return <label key={b.id} className={'apply-option' + (owned ? ' is-owned' : '')}>
                        <input type="radio" name="apply-choice" disabled={owned} checked={selected} onChange={() => setChoice({ kind: 'badge', target: b.id })} />
                        <CIcon name={b.icon} size={40} />
                        <span className="apply-option-body">
                            <span className="apply-option-title">{b.name}
                                {owned ? <span className="apply-state on"><VerifiedMark size={14} />받음</span> : pending ? <span className="apply-state">확인 중</span> : null}</span>
                            <span className="apply-option-text">{b.summary}</span>
                            <span className="apply-need">필요한 것 · {b.requirements.join(', ')}</span>
                        </span>
                    </label>;
                })}
            </div>
        </div> : <div className="apply-pane">
            <p className="apply-intro">등급은 <b>일반 → 플러스 → 프리미엄 → 엘리트 → 관리자</b> 순이에요. 매니저 계좌로 입금이 확인되면 지급합니다. 등급 혜택은 준비 중이에요.</p>
            <div className="grade-table" role="radiogroup" aria-label="등급과 기간">
                {GRADES.map(g => {
                    const pending = pendingFor('grade', g.id), current = (me?.grade || 'normal') === g.id;
                    return <div key={g.id} className={'grade-row' + (current ? ' is-current' : '')}>
                        <CIcon name={g.icon} size={32} />
                        <div className="grade-row-name"><strong>{g.name}</strong>{current && <span className="apply-state on">현재 등급</span>}{pending && <span className="apply-state">확인 중</span>}</div>
                        <div className="grade-row-plans">
                            {g.plans.length ? g.plans.map(p => {
                                // Lower grades than the current one cannot be bought; the server also rejects
                                // a grade already held permanently.
                                const disabled = g.rank < rank;
                                return <label key={p.id} className={'plan' + (disabled ? ' is-disabled' : '')}>
                                    <input type="radio" name="apply-choice" disabled={disabled} checked={choice?.kind === 'grade' && choice.target === g.id && choice.plan === p.id} onChange={() => setChoice({ kind: 'grade', target: g.id, plan: p.id })} />
                                    <span>{p.label}</span><b>{won(p.price)}</b>
                                </label>;
                            }) : <span className="muted small">{g.note}</span>}
                        </div>
                    </div>;
                })}
            </div>
            <div className="pay-box">
                <strong>입금 안내</strong>
                <p>{config.paymentNotice || '입금 계좌는 신청 후 채팅에서 매니저가 알려드려요.'}</p>
                <p className="muted small">입금자명과 입금 일시를 채팅으로 보내 주세요. 6개월 등급은 지급일부터 6개월 동안 유지되고, 영구 등급은 기간 제한이 없어요.</p>
            </div>
        </div>}
        <p className="apply-foot-note">‘신청하러 가기’를 누르면 매니저와의 1:1 채팅이 열려요. 안내에 따라 필요한 정보를 보내 주세요.</p>
    </Modal>;
}
