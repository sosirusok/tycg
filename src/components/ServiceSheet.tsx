import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { SERVICE_NAMES, gradeInfo, type Coupons, type ServiceKind } from '../../shared/membership';
import { api, errorText } from '../lib/api';
import { navigate } from '../lib/router';
import { useApp } from '../app/state';
import { Modal } from './ui';

const NOTE_MAX = 200;
const monthDay = (t: number) => new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

// The member's 무료 중개·가측 line: '이번 달 무료 3/5 남음 · 11월 1일 초기화', '무료 무제한 (엘리트)' or
// '유료 · 수수료는 매니저가 안내', with where free requests start under it for 일반 and the 체험.
export function couponLines(c: Coupons, grade: string | undefined, trial: boolean | undefined): [string, string] {
    if (c.limit === null) return [`무료 무제한 (${gradeInfo(grade).name})`, ''];
    if ((c.left ?? 0) > 0) return [`이번 달 무료 ${c.left}/${c.limit} 남음 · ${monthDay(c.resetsAt)} 초기화`, ''];
    return ['유료 · 수수료는 매니저가 안내', trial ? '무료 중개·가측은 유료 플러스부터' : c.limit === 0 ? '플러스부터 월 1회 무료' : `${monthDay(c.resetsAt)} 초기화`];
}

type OpenRequest = { id: number; kind: ServiceKind; post_title: string | null };

// 중개·가측 신청 (WP65): one small sheet for both. 가측 comes from the 더보기 menu of an own 판매·교환
// account post; 중개 from the chat menu, with the post and the chat partner filled in. While a request
// of the kind is open (one per kind), the sheet says so and links to the manager chat instead.
export function ServiceSheet({ open, onClose, kind, post, partner }: {
    open: boolean; onClose: () => void; kind: ServiceKind; post: { id: number; title: string }; partner?: { id: string; nickname: string };
}) {
    const { me, refreshUnread } = useApp();
    const [note, setNote] = useState(''), [coupons, setCoupons] = useState<Coupons | null>(null), [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<OpenRequest | null>(null);
    useEffect(() => {
        if (!open) return;
        setNote(''); setPending(null);
        let alive = true;
        api<{ coupons: Coupons; open: OpenRequest[] }>('services/me').then(d => {
            if (!alive) return;
            setCoupons(d.coupons);
            setPending(d.open.find(r => r.kind === kind) || null);
        }).catch(() => { if (alive) setCoupons(null); });
        return () => { alive = false; };
    }, [open, kind]);
    async function openChat() {
        try { const d = await api<{ id: string }>('chats', 'POST', { userId: 'manager' }); onClose(); void navigate('/chat/' + d.id); }
        catch (e) { toast.error(errorText(e)); }
    }
    async function send() {
        if (busy) return;
        setBusy(true);
        try {
            const d = await api<{ chatId: string }>('services', 'POST', { kind, postId: post.id, ...partner ? { partnerId: partner.id } : {}, note });
            onClose();
            refreshUnread();
            toast('신청 완료', { action: { label: '채팅 보기', onClick: () => void navigate('/chat/' + d.chatId) } });
        } catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    const [line, sub] = coupons ? couponLines(coupons, me?.grade, me?.grade_trial) : ['', ''];
    return <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={`${SERVICE_NAMES[kind]} 신청`}
        footer={<button className="btn btn-primary btn-lg" disabled={busy || !!pending} onClick={send}>{busy ? <LoaderCircle size={20} className="spin" /> : '신청'}</button>}>
        <div className="form-stack service-sheet">
            <p className="service-post"><b>{post.title}</b>{partner && <span className="muted"> · 상대 {partner.nickname}</span>}</p>
            {pending ? <p className="service-coupon" aria-live="polite">
                <b>진행 중인 {SERVICE_NAMES[kind]} 신청이 있습니다{pending.post_title ? ` · ${pending.post_title}` : ''}</b>
                <button type="button" className="btn btn-text service-chat" onClick={() => void openChat()}>채팅 보기</button>
            </p> : <>
                <label className="field"><span className="field-label">메모</span>
                    <input className="input" maxLength={NOTE_MAX} value={note} onChange={e => setNote(e.target.value)} placeholder={kind === 'appraise' ? '예: 급처 예정' : '예: 오늘 저녁 거래'} /></label>
                {coupons ? <p className="service-coupon" aria-live="polite"><b>{line}</b>{sub && <span className="muted small">{sub}</span>}</p>
                    : <p className="service-coupon muted small" aria-hidden="true">&nbsp;</p>}
            </>}
        </div>
    </Modal>;
}
