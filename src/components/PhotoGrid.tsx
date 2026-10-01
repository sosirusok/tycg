import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight, ImagePlus, LoaderCircle, X } from 'lucide-react';
import { imageUrl } from '../lib/api';

// The editor's photo grid (WP46). '사진 추가' comes first; the first photo is the 대표 (images[0], the
// list thumbnail) with a brand ring and band; every other photo has '대표로', which moves it to the
// front and keeps the others' order. Photos move with ‹ › or by dragging (a mouse drags at once, a
// finger after a 300ms press so the page still scrolls). Moves slide in 160ms (none with reduced motion).

const LONG_PRESS = 300;
const SLOP = 8;

type Drag = { id: string; pointerId: number; x: number; y: number; startX: number; startY: number; grabX: number; grabY: number; active: boolean; timer: number };

export function PhotoGrid({ images, onChange, canAdd, uploading, onAdd }: { images: string[]; onChange: (images: string[]) => void; canAdd: boolean; uploading: boolean; onAdd: () => void }) {
    const grid = useRef<HTMLDivElement>(null);
    const tiles = useRef(new Map<string, HTMLDivElement>());
    // Each tile's layout position (offsetLeft/Top, which a transform does not change) just before a
    // move or a removal, for the slide; null when nothing moved.
    const places = useRef<Map<string, { x: number; y: number }> | null>(null);
    const drag = useRef<Drag | null>(null);
    const [dragging, setDragging] = useState<string | null>(null);
    const imagesRef = useRef(images), onChangeRef = useRef(onChange);
    imagesRef.current = images; onChangeRef.current = onChange;

    const snapshot = () => { places.current = new Map([...tiles.current].map(([id, el]) => [id, { x: el.offsetLeft, y: el.offsetTop }])); };
    const move = (from: number, to: number) => {
        snapshot();
        const a = [...imagesRef.current];
        const [item] = a.splice(from, 1);
        a.splice(to, 0, item);
        onChangeRef.current(a);
    };

    // Puts the dragged tile under the finger (or mouse), from its current layout position.
    const follow = () => {
        const d = drag.current, el = d && tiles.current.get(d.id), box = grid.current?.getBoundingClientRect();
        if (!d || !d.active || !el || !box) return;
        el.style.transition = 'none';
        el.style.transform = `translate(${d.x - box.left - d.grabX - el.offsetLeft}px,${d.y - box.top - d.grabY - el.offsetTop}px)`;
    };

    // Slide (FLIP): every tile that changed place starts at its old place and moves to the new one.
    useLayoutEffect(() => {
        const old = places.current;
        places.current = null;
        const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (old && !still) for (const [id, el] of tiles.current) {
            const now = { x: el.offsetLeft, y: el.offsetTop }, before = old.get(id);
            if (id === drag.current?.id && drag.current.active) continue;
            if (!before || (before.x === now.x && before.y === now.y)) continue;
            el.style.transition = 'none';
            el.style.transform = `translate(${before.x - now.x}px,${before.y - now.y}px)`;
            void el.offsetWidth;
            el.style.transition = 'transform 160ms ease';
            el.style.transform = '';
        }
        follow();
    }, [images]);

    useEffect(() => {
        // While a finger drags, the page must not scroll (the listener has to be non-passive).
        const stopScroll = (e: TouchEvent) => { if (drag.current?.active && e.cancelable) e.preventDefault(); };
        const onMove = (e: PointerEvent) => {
            const d = drag.current;
            if (!d || e.pointerId !== d.pointerId) return;
            d.x = e.clientX; d.y = e.clientY;
            const moved = Math.hypot(d.x - d.startX, d.y - d.startY);
            if (!d.active) {
                if (e.pointerType === 'mouse' && moved > 4) activate();
                else if (e.pointerType !== 'mouse' && moved > SLOP) end();
                return;
            }
            e.preventDefault();
            follow();
            // The tile under the pointer (by layout place) takes the dragged photo's slot.
            const box = grid.current?.getBoundingClientRect();
            if (!box) return;
            const px = d.x - box.left, py = d.y - box.top, list = imagesRef.current;
            const target = list.findIndex(id => {
                const el = tiles.current.get(id);
                return !!el && px >= el.offsetLeft && px < el.offsetLeft + el.offsetWidth && py >= el.offsetTop && py < el.offsetTop + el.offsetHeight;
            });
            const from = list.indexOf(d.id);
            if (target >= 0 && from >= 0 && target !== from) move(from, target);
        };
        const onUp = (e: PointerEvent) => { if (drag.current && e.pointerId === drag.current.pointerId) end(); };
        document.addEventListener('touchmove', stopScroll, { passive: false });
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            document.removeEventListener('touchmove', stopScroll);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            if (drag.current) window.clearTimeout(drag.current.timer);
        };
    }, []);

    function activate() {
        const d = drag.current, el = d && tiles.current.get(d.id), box = grid.current?.getBoundingClientRect();
        if (!d || !el || !box) return;
        window.clearTimeout(d.timer);
        d.active = true;
        d.grabX = d.startX - box.left - el.offsetLeft;
        d.grabY = d.startY - box.top - el.offsetTop;
        setDragging(d.id);
        navigator.vibrate?.(10);
        follow();
    }

    // Drops the photo where it is (the order already changed while dragging).
    function end() {
        const d = drag.current;
        if (!d) return;
        window.clearTimeout(d.timer);
        drag.current = null;
        setDragging(null);
        const el = tiles.current.get(d.id);
        if (el && d.active) {
            // Settles into its slot.
            el.style.transition = 'transform 160ms ease';
            el.style.transform = '';
        }
    }

    function down(e: ReactPointerEvent<HTMLDivElement>, id: string) {
        if (drag.current || (e.pointerType === 'mouse' && e.button !== 0) || (e.target as HTMLElement).closest('button')) return;
        if (e.pointerType === 'mouse') e.preventDefault();
        drag.current = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, grabX: 0, grabY: 0, active: false,
            timer: e.pointerType === 'mouse' ? 0 : window.setTimeout(activate, LONG_PRESS) };
    }

    const remove = (id: string) => { snapshot(); onChange(images.filter(v => v !== id)); };
    const step = (i: number, d: number) => move(i, i + d);

    return <div className="photo-grid" ref={grid}>
        {canAdd && <button type="button" className="photo-add" disabled={uploading} onClick={onAdd}>
            {uploading ? <LoaderCircle size={26} className="spin" /> : <ImagePlus size={26} />}<span>{uploading ? '올리는 중' : '사진 추가'}</span>
        </button>}
        {images.map((img, i) => <div key={img} className={'photo' + (i === 0 ? ' is-cover' : '') + (dragging === img ? ' is-dragging' : '')}
            ref={el => { if (el) tiles.current.set(img, el); else tiles.current.delete(img); }}
            onPointerDown={e => down(e, img)} onContextMenu={e => e.preventDefault()}>
            <img src={imageUrl(img)} alt={`사진 ${i + 1}`} draggable={false} />
            {i === 0 ? <b className="photo-cover">대표</b>
                : <button type="button" className="photo-make-cover" aria-label="대표 사진으로 지정" onClick={() => move(i, 0)}>대표로</button>}
            <button type="button" className="photo-remove" aria-label={`사진 ${i + 1} 빼기`} onClick={() => remove(img)}><X size={14} /></button>
            <div className="photo-move">
                <button type="button" disabled={i === 0} aria-label="앞으로" onClick={() => step(i, -1)}><ChevronLeft size={14} /></button>
                <button type="button" disabled={i === images.length - 1} aria-label="뒤로" onClick={() => step(i, 1)}><ChevronRight size={14} /></button>
            </div>
        </div>)}
    </div>;
}
