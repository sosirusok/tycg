import { useState } from 'react';
import { toast } from 'sonner';
import { KIND_ICONS, isTradeKind, listingPrice, type Post } from '../../shared/market';
import { api, errorText, imageUrl } from '../lib/api';
import { navigate } from '../lib/router';
import { Icon, Modal } from './ui';
import { kstClock } from './Wallet';

// The 409 of a new post (or an edit) that is the same listing as one of the author's open posts (WP44).
export type Dup = { id: number; title: string | null; thumb: string | null; price: number | null; price_mode: string | null; kind: string; why: string; same: string; bumpAt: number | null; hidden: boolean };

// '같은 매물' sheet (design 10): the post strip, '같은 점: 사진 3장', then [글 보기] and [끌올] (or a
// disabled '15:40부터 가능'). A post the manager hid offers only [글 보기]. The editor keeps the draft.
export function SameListingSheet({ dup, onClose }: { dup: Dup | null; onClose: () => void }) {
    const [busy, setBusy] = useState(false);
    if (!dup) return <Modal open={false} onClose={onClose} title="" />;
    const icon = isTradeKind(dup.kind) ? KIND_ICONS[dup.kind] : 'file-text';
    const waiting = dup.bumpAt && dup.bumpAt > Date.now() ? dup.bumpAt : 0;
    async function bump() {
        if (busy || !dup) return;
        setBusy(true);
        try {
            await api(`posts/${dup.id}/bump`, 'POST');
            toast('끌올 완료');
            onClose();
            void navigate('/posts/' + dup.id);
        } catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    return <Modal open onClose={() => { if (!busy) onClose(); }} title="같은 매물"
        footer={<>
            <button type="button" className="btn btn-line btn-lg" onClick={() => { onClose(); void navigate('/posts/' + dup.id); }}>글 보기</button>
            {!dup.hidden && <button type="button" className="btn btn-primary btn-lg grow" disabled={busy || !!waiting} onClick={() => void bump()}>{waiting ? `${kstClock(waiting)}부터 가능` : '끌올'}</button>}
        </>}>
        <div className="same-sheet">
            <div className="post-strip">
                <span className="post-strip-thumb">{dup.thumb ? <img src={imageUrl(dup.thumb)} alt="" /> : <Icon name={icon} size={24} />}</span>
                <span className="post-strip-text"><strong>{dup.title}</strong><span>{listingPrice({ kind: dup.kind as Post['kind'], price: dup.price, price_mode: dup.price_mode || (dup.price === null ? 'offer' : 'fixed') })}</span></span>
            </div>
            <p className="same-line">같은 점: {dup.same}</p>
        </div>
    </Modal>;
}
