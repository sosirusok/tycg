import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';
import { BADGES, gradeInfo, type BadgeId, type GradeId } from '../../shared/membership';

// Fluent Emoji color icons (public/icons, MIT).
export function CIcon({ name, size = 24, alt = '' }: { name: string; size?: number; alt?: string }) {
    return <img className="cicon" src={`/icons/${name}.svg`} width={size} height={size} alt={alt} loading="lazy" decoding="async" />;
}

export function Avatar({ name, size = '' }: { name: string; size?: '' | 'sm' | 'lg' }) {
    return <span className={'avatar' + (size ? ' avatar-' + size : '')} aria-hidden="true">{name.slice(0, 1)}</span>;
}

export function VerifiedMark({ size = 15 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" /><path d="m6 10.2 2.6 2.6L14 7.4" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function GradeChip({ grade, role }: { grade?: GradeId | string | null; role?: string }) {
    if (role === 'manager') return <span className="grade grade-manager">매니저</span>;
    const info = gradeInfo(grade);
    if (info.id === 'normal') return null;
    if (info.id === 'admin') return <span className="grade grade-admin">관리자</span>;
    return <span className="grade"><img src={`/icons/${info.icon}.svg`} alt="" />{info.name}</span>;
}

export function Verified({ badges }: { badges?: BadgeId[] | string[] }) {
    if (!badges?.length) return null;
    return <>{BADGES.filter(b => badges.includes(b.id as never)).map(b => <Fragment key={b.id}>{' '}<span className="verified" title={b.name + ' 완료'}><VerifiedMark size={14} />{b.name}</span></Fragment>)}</>;
}

// Nickname followed by the grade chip and verification checks. Each chip and check is preceded by
// a space: the inline-flex line drops it, and a caption row that renders the line inline keeps the
// words apart for screen readers and copying. Nothing trails the last part, so text glued after it stays put.
export function NameLine({ nickname, grade, role, badges, size = '' }: { nickname: string; grade?: string | null; role?: string; badges?: string[]; size?: '' | 'lg' }) {
    const chip = GradeChip({ grade, role });
    return <span className={'name-line' + (size ? ' name-line-' + size : '')}>
        <span className="nick">{nickname}</span>
        {chip && <>{' '}{chip}</>}
        <Verified badges={badges} />
    </span>;
}

export function Modal({ open, onClose, title, description, children, footer, wide = false }: {
    open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
    return <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose(); }}>
        <Dialog.Portal>
            <Dialog.Overlay className="overlay" />
            <Dialog.Content className={'modal' + (wide ? ' modal-wide' : '')} aria-describedby={undefined}>
                <div className="modal-head">
                    <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
                    <Dialog.Close className="icon-btn" aria-label="닫기"><X size={22} /></Dialog.Close>
                </div>
                {/* A confirm with only a title and buttons gets no body, so no blank band sits above the footer. */}
                {(description || children) && <div className="modal-body">
                    {description && <p className="modal-desc">{description}</p>}
                    {children}
                </div>}
                {footer && <div className="modal-foot">{footer}</div>}
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}

// No icon unless the caller passes one (the old default magnifier had purple fills).
export function EmptyState({ icon, title, text, action }: { icon?: string; title: string; text?: string; action?: ReactNode }) {
    return <div className="empty">{icon && <CIcon name={icon} size={56} />}<h3>{title}</h3>{text && <p>{text}</p>}{action}</div>;
}

export function SkeletonRows({ count = 4, height = 132 }: { count?: number; height?: number }) {
    return <div className="skeleton-rows" aria-label="불러오는 중">{Array.from({ length: count }, (_, i) => <div key={i} className="skeleton" style={{ height }} />)}</div>;
}

export function Tabs<T extends string>({ items, value, onChange, label }: { items: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
    const row = useRef<HTMLDivElement>(null);
    const [hasMore, setHasMore] = useState(false);
    // More tabs off to the right: the row fades out (.tabs.has-more) until it is scrolled to the end.
    const measure = useCallback(() => {
        const box = row.current;
        setHasMore(!!box && box.scrollLeft + box.clientWidth < box.scrollWidth - 1);
    }, []);
    // On phones the row scrolls sideways: keep the selected tab in view on mount and on every change.
    // scrollIntoView runs only while the row is on screen, so block 'nearest' never moves the page;
    // a row below the fold scrolls itself instead.
    useEffect(() => {
        const show = () => {
            const box = row.current, tab = box?.querySelector<HTMLElement>('[aria-selected=true]');
            if (box && tab && box.scrollWidth > box.clientWidth) {
                const b = box.getBoundingClientRect();
                if (b.top >= 0 && b.bottom <= window.innerHeight) tab.scrollIntoView({ inline: 'center', block: 'nearest' });
                else {
                    const t = tab.getBoundingClientRect();
                    if (t.left < b.left || t.right > b.right) box.scrollLeft += t.left - b.left - (b.width - t.width) / 2;
                }
            }
            measure();
        };
        show();
        // The web font widens the labels after first paint; measure again once it is in.
        let alive = true;
        void document.fonts?.ready.then(() => { if (alive) show(); });
        return () => { alive = false; };
    }, [value, measure]);
    useEffect(() => {
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [measure]);
    return <div ref={row} className={'tabs' + (hasMore ? ' has-more' : '')} role="tablist" aria-label={label} onScroll={measure}>
        {items.map(item => <button key={item.id} role="tab" type="button" className="tab" aria-selected={item.id === value} onClick={() => onChange(item.id)}>{item.label}</button>)}
    </div>;
}
