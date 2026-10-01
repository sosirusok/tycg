import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { FileText, Lock, MessageCircle, Search, X } from 'lucide-react';
import { BADGES, gradeInfo, type BadgeId, type GradeId } from '../../shared/membership';

// Fluent Emoji color icons (public/icons, MIT).
export function CIcon({ name, size = 24, alt = '' }: { name: string; size?: number; alt?: string }) {
    return <img className="cicon" src={`/icons/${name}.svg`} width={size} height={size} alt={alt} loading="lazy" decoding="async" />;
}

export function Avatar({ name, size = '' }: { name: string; size?: '' | 'sm' | 'lg' }) {
    return <span className={'avatar' + (size ? ' avatar-' + size : '')} aria-hidden="true">{name.slice(0, 1)}</span>;
}

// Data items separated by ' · ', each kept whole so a line breaks only between items.
export function DataItems({ items }: { items: string[] }) {
    return <>{items.map((item, i) => <Fragment key={i}>{i > 0 && ' · '}<span className="nowrap">{item}</span></Fragment>)}</>;
}

export function VerifiedMark({ size = 15 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" /><path d="m6 10.2 2.6 2.6L14 7.4" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// Text-only grade chip: plus is a gray outline, premium a brand outline, elite brand solid,
// 관리자 an ink outline and 매니저 ink solid. The Fluent grade icons stay on the apply modal and profile grade card.
// A 플러스 무료 체험 (trial) shows no chip anywhere; the member sees their own status line instead.
export function GradeChip({ grade, role, trial }: { grade?: GradeId | string | null; role?: string; trial?: boolean | null }) {
    if (role === 'manager') return <span className="grade grade-manager">매니저</span>;
    const info = gradeInfo(grade);
    if (info.id === 'normal' || trial) return null;
    return <span className={'grade grade-' + info.id}>{info.name}</span>;
}

// Verification name plus check mark. Both the full name (본인 인증) and the short one (본인) are
// rendered; the name line shows the short one only in compact rows. The name is never dropped.
export function Verified({ badges }: { badges?: BadgeId[] | string[] }) {
    if (!badges?.length) return null;
    return <>{BADGES.filter(b => badges.includes(b.id as never)).map(b => <Fragment key={b.id}>{' '}<span className="verified" title={b.name} aria-label={b.name}><VerifiedMark size={14} /><span className="v-full">{b.name}</span><span className="v-short">{b.short}</span></span></Fragment>)}</>;
}

// Nickname followed by the grade chip and verification checks. Each chip and check is preceded by
// a space: the inline-flex line drops it, and a caption row that renders the line inline keeps the
// words apart for screen readers and copying. Nothing trails the last part, so text glued after it stays put.
// compact keeps everything on one line for list rows, chat and the header menu: the nickname
// ellipsizes first and the badges use their short names.
export function NameLine({ nickname, grade, trial, role, badges, size = '', compact = false }: { nickname: string; grade?: string | null; trial?: boolean | null; role?: string; badges?: string[]; size?: '' | 'lg'; compact?: boolean }) {
    const chip = GradeChip({ grade, role, trial });
    return <span className={'name-line' + (size ? ' name-line-' + size : '') + (compact ? ' compact' : '')}>
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

const EMPTY_ICONS = { search: Search, message: MessageCircle, lock: Lock, file: FileText };
export type EmptyIcon = keyof typeof EMPTY_ICONS;

// No icon unless the caller passes one; an empty state never shows a 3D illustration.
export function EmptyState({ icon, title, text, action }: { icon?: EmptyIcon; title: string; text?: string; action?: ReactNode }) {
    const Icon = icon ? EMPTY_ICONS[icon] : null;
    return <div className="empty">{Icon && <Icon className="empty-icon" size={32} strokeWidth={1.75} aria-hidden="true" />}<h3>{title}</h3>{text && <p>{text}</p>}{action}</div>;
}

export function SkeletonRows({ count = 4, height = 132 }: { count?: number; height?: number }) {
    return <div className="skeleton-rows" aria-label="불러오는 중">{Array.from({ length: count }, (_, i) => <div key={i} className="skeleton" style={{ height }} />)}</div>;
}

// A row that scrolls sideways fades out on the right ('has-more', base.css) while part of it is
// still off screen. Pass measure to the row's onScroll.
export function useMoreRight<T extends HTMLElement>() {
    const ref = useRef<T>(null);
    const [more, setMore] = useState(false);
    const measure = useCallback(() => {
        const box = ref.current;
        setMore(!!box && box.scrollLeft + box.clientWidth < box.scrollWidth - 1);
    }, []);
    useEffect(() => {
        const box = ref.current;
        measure();
        // The row's width changes with the window or when a sheet opens; the web font widens the labels after first paint.
        const observer = box && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
        if (box) observer?.observe(box);
        let alive = true;
        void document.fonts?.ready.then(() => { if (alive) measure(); });
        window.addEventListener('resize', measure);
        return () => { alive = false; observer?.disconnect(); window.removeEventListener('resize', measure); };
    }, [measure]);
    return { ref, more, measure };
}

export function Tabs<T extends string>({ items, value, onChange, label }: { items: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
    // More tabs off to the right: the row fades out (.tabs.has-more) until it is scrolled to the end.
    const { ref: row, more: hasMore, measure } = useMoreRight<HTMLDivElement>();
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
    return <div ref={row} className={'tabs' + (hasMore ? ' has-more' : '')} role="tablist" aria-label={label} onScroll={measure}>
        {items.map(item => <button key={item.id} role="tab" type="button" className="tab" aria-selected={item.id === value} onClick={() => onChange(item.id)}>{item.label}</button>)}
    </div>;
}
