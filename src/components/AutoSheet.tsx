import { useState } from 'react';
import { toast } from 'sonner';
import { KIND_ICONS, isTradeKind } from '../../shared/market';
import { AUTO_TEXT } from '../../shared/membership';
import { ApiError, api, errorText, imageUrl } from '../lib/api';
import { CIcon, Modal } from './ui';
import { kstClock } from './Wallet';
import { offerPush } from '../app/state';

type Listed = { id: number; title: string; kind: string; thumb: string | null; image: string | null };

// The post's '자동 끌올' switch (WP52). 플러스 moves its one listed post ('자동 끌올 글 변경 완료'); 프리미엄 at
// 5/5 gets the '자동 끌올 5/5 · 뺄 글 선택' sheet, and the post picked there makes room for this one.
// onChange gets the post's new state.
export function useAutoToggle(onChange: (postId: number, on: boolean) => void) {
    const [sheet, setSheet] = useState<{ postId: number; slots: number; listed: Listed[] } | null>(null);
    const [busy, setBusy] = useState(false);
    async function toggle(postId: number, on: boolean) {
        if (busy) return;
        setBusy(true);
        try {
            const d = await api<{ bump: boolean; moved?: boolean }>(`posts/${postId}/auto`, 'PUT', { bump: on });
            onChange(postId, d.bump);
            if (d.moved) toast(AUTO_TEXT.moved);
        } catch (e) {
            if (e instanceof ApiError && e.status === 409 && e.data?.listed) setSheet({ postId, slots: e.data.slots, listed: e.data.listed });
            else toast.error(errorText(e));
        } finally { setBusy(false); }
    }
    async function swap(out: number) {
        if (!sheet || busy) return;
        setBusy(true);
        try {
            await api(`posts/${out}/auto`, 'PUT', { bump: false });
            onChange(out, false);
            const d = await api<{ bump: boolean }>(`posts/${sheet.postId}/auto`, 'PUT', { bump: true });
            onChange(sheet.postId, d.bump);
            toast(AUTO_TEXT.moved);
            setSheet(null);
        } catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    const element = <Modal open={!!sheet} onClose={() => { if (!busy) setSheet(null); }} title={sheet ? AUTO_TEXT.sheet(sheet.slots) : ''}>
        {sheet && <ul className="auto-swap">{sheet.listed.map(p => <li key={p.id}>
            <button type="button" className="post-strip auto-swap-row" disabled={busy} onClick={() => void swap(p.id)}>
                <span className="post-strip-thumb">{p.thumb || p.image ? <img src={p.thumb || imageUrl(p.image!)} alt="" /> : <CIcon name={isTradeKind(p.kind) ? KIND_ICONS[p.kind] : 'money-bag'} size={28} />}</span>
                <span className="post-strip-text"><strong>{p.title}</strong></span>
                <span className="auto-swap-out">빼기</span>
            </button>
        </li>)}</ul>}
    </Modal>;
    return { toggle, busy, sheet: element };
}

// The waiting 끌올 button: '15:40 알림 예정' once set (toast '알림 설정 완료'); every grade.
export async function setBumpRemind(postId: number): Promise<number | null> {
    try {
        const d = await api<{ remindAt: number | null }>(`posts/${postId}/auto`, 'PUT', { remind: true });
        toast('알림 설정 완료');
        offerPush();
        return d.remindAt;
    } catch (e) { toast.error(errorText(e)); return null; }
}
export const remindText = (at: number) => `${kstClock(at)} 알림 예정`;
