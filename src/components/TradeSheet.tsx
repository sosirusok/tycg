import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { priceText } from '../../shared/market';
import { api, errorText } from '../lib/api';
import { Avatar, Modal, NameLine } from './ui';

type Partner = { id: string; nickname: string; role: string; grade: string; grade_trial?: boolean; badges: string[]; conversation_id: string; accepted_amount: number | null };

// '거래한 회원' (WP23), opened after the author sets a post to 거래완료 on the detail page, in 내 글 or
// from the chat's pinned bar (with that chat's partner preselected), and later from the detail page's
// owner tools. Picking a member records the trade and puts a '거래 후기 남기기' card in their chat; it
// counts once that member confirms it with their 후기. The status change is already saved, so closing
// the sheet ('사이트 밖 거래 · 건너뛰기', X or the overlay) changes nothing. It stays shut when the post
// has no partners or already has a trade. `postId` null keeps it closed.
export function TradeSheet({ postId, preselect, onClose, onDone }: { postId: number | null; preselect?: string; onClose: () => void; onDone?: (chatId: string) => void }) {
    const [partners, setPartners] = useState<Partner[] | null>(null), [pick, setPick] = useState(''), [busy, setBusy] = useState(false);
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        setPartners(null); setPick('');
        if (postId === null) return;
        let alive = true;
        api<{ partners: Partner[]; trade: unknown }>(`posts/${postId}/partners`).then(d => {
            if (!alive) return;
            if (d.trade || !d.partners.length) { close.current(); return; }
            setPartners(d.partners);
            setPick(preselect && d.partners.some(p => p.id === preselect) ? preselect : d.partners.length === 1 ? d.partners[0].id : '');
        }).catch(() => { if (alive) close.current(); });
        return () => { alive = false; };
    }, [postId, preselect]);

    async function save() {
        if (busy || !pick || postId === null) return;
        setBusy(true);
        try {
            const d = await api<{ chatId: string }>(`posts/${postId}/trade`, 'POST', { partnerId: pick });
            toast('등록 완료');
            close.current();
            onDone?.(d.chatId);
        } catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }

    return <Modal open={postId !== null && !!partners} onClose={() => { if (!busy) close.current(); }} title="거래한 회원"
        footer={<>
            <button type="button" className="btn btn-text trade-skip" disabled={busy} onClick={() => close.current()}>사이트 밖 거래 · 건너뛰기</button>
            <button type="button" className="btn btn-primary btn-lg" disabled={busy || !pick} onClick={() => void save()}>등록</button>
        </>}>
        <div className="apply-options" role="radiogroup" aria-label="거래한 회원">
            {(partners || []).map(p => <label key={p.id} className="apply-option partner-option">
                <input type="radio" name="trade-partner" value={p.id} checked={pick === p.id} onChange={() => setPick(p.id)} />
                <Avatar name={p.nickname} size="sm" />
                <span className="apply-option-body">
                    <NameLine nickname={p.nickname} grade={p.grade} trial={p.grade_trial} role={p.role} badges={p.badges} compact />
                    {p.accepted_amount !== null && <span className="apply-need">제시 수락 · {priceText(p.accepted_amount)}</span>}
                </span>
                <span className="radio-dot" aria-hidden="true" />
            </label>)}
        </div>
    </Modal>;
}
