import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { imageUrl } from '../lib/api';

const SWIPE = 40;

// The detail page's photo viewer (WP46): ‹ › ('이전 사진' / '다음 사진'), the arrow keys and a 40px
// swipe step through the photos, '3/12' counts them. Tapping the photo does nothing; the dark area
// around it, X and Esc close it.
export function Lightbox({ images, index, onIndex, onClose }: { images: string[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
    const open = index !== null && index >= 0 && index < images.length;
    const swipe = useRef<{ x: number; y: number; id: number } | null>(null), swiped = useRef(false);
    const go = (d: number) => { if (index === null) return; const n = index + d; if (n >= 0 && n < images.length) onIndex(n); };
    const goRef = useRef(go);
    goRef.current = go;
    useEffect(() => {
        if (!open) return;
        const key = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); goRef.current(-1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); goRef.current(1); }
        };
        window.addEventListener('keydown', key);
        return () => window.removeEventListener('keydown', key);
    }, [open]);
    // The photos next to the open one load ahead, so stepping shows them at once.
    useEffect(() => {
        if (!open) return;
        for (const i of [index! - 1, index! + 1]) if (images[i]) { const img = new Image(); img.src = imageUrl(images[i]); }
    }, [open, index, images]);

    return <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose(); }}>
        <Dialog.Portal>
            <Dialog.Overlay className="lightbox" />
            <Dialog.Content className="lightbox-content" aria-describedby={undefined}
                onPointerDown={e => { swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId }; swiped.current = false; }}
                onPointerUp={e => {
                    const s = swipe.current;
                    swipe.current = null;
                    if (!s || s.id !== e.pointerId) return;
                    const dx = e.clientX - s.x, dy = e.clientY - s.y;
                    if (Math.abs(dx) >= SWIPE && Math.abs(dx) > Math.abs(dy)) { swiped.current = true; go(dx < 0 ? 1 : -1); }
                }}
                onPointerCancel={() => { swipe.current = null; }}
                // Only the dark area itself closes (the content box fills the screen above the overlay).
                onClick={e => { if (swiped.current) { swiped.current = false; return; } if (e.target === e.currentTarget) onClose(); }}>
                <Dialog.Title className="sr-only">사진 크게 보기</Dialog.Title>
                {open && <img key={images[index!]} src={imageUrl(images[index!])} alt={`사진 ${index! + 1}`} draggable={false} />}
                {open && images.length > 1 && <>
                    <button type="button" className="lightbox-nav lightbox-prev" aria-label="이전 사진" disabled={index === 0} onClick={() => go(-1)}><ChevronLeft size={28} /></button>
                    <button type="button" className="lightbox-nav lightbox-next" aria-label="다음 사진" disabled={index === images.length - 1} onClick={() => go(1)}><ChevronRight size={28} /></button>
                    <p className="lightbox-count" aria-live="polite">{index! + 1}/{images.length}</p>
                </>}
                <Dialog.Close className="icon-btn lightbox-close" aria-label="닫기"><X size={26} /></Dialog.Close>
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}
