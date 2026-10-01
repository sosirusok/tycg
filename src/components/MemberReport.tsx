import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MEMBER_REPORT_REASONS } from '../../shared/market';
import { api, errorText } from '../lib/api';
import { Modal } from './ui';

// 신고 of a member, from the chat header (that chat goes with it as the evidence) or their profile.
export function MemberReportModal({ open, onClose, userId, nickname, conversationId }: { open: boolean; onClose: () => void; userId: string; nickname: string; conversationId?: string }) {
    const [reason, setReason] = useState<string>(MEMBER_REPORT_REASONS[0]), [details, setDetails] = useState(''), [busy, setBusy] = useState(false);
    useEffect(() => { if (open) { setReason(MEMBER_REPORT_REASONS[0]); setDetails(''); } }, [open]);
    async function send() {
        if (busy || !details.trim()) return;
        setBusy(true);
        try { await api('reports', 'POST', { userId, conversationId, reason, details }); onClose(); toast('신고 접수 완료'); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    return <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={`${nickname}님 신고`}
        footer={<button type="button" className="btn btn-primary btn-lg" disabled={busy || !details.trim()} onClick={() => void send()}>신고</button>}>
        <div className="form-stack">
            <div className="chip-row" role="group" aria-label="신고 사유">{MEMBER_REPORT_REASONS.map(r => <button type="button" key={r} className="chip chip-sm" aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>)}</div>
            <label className="field"><span className="field-label">내용</span><textarea className="textarea" style={{ minHeight: 120 }} maxLength={1000} value={details} onChange={e => setDetails(e.target.value)} placeholder="예: 입금 후 잠수, 거래 약속 파기" /></label>
        </div>
    </Modal>;
}
