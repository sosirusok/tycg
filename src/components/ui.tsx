import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import {
    AlarmClock, ArrowLeftRight, Bell, BookOpen, Castle, ChartColumn, CircleAlert, CircleArrowUp, CirclePause, ClipboardList, Clock, Copy, EyeOff, FileText,
    Gamepad2, Gift, Handshake, LayoutList, Lock, Megaphone, MessageCircle, MessageSquare, MessageSquareReply, Package, Palette, PartyPopper, Search,
    ShieldCheck, ShoppingCart, SlidersHorizontal, Tag, Target, Ticket, TrendingDown, Trophy, User, UserCheck, UserSearch, X, type LucideIcon,
} from 'lucide-react';
import { BADGES, gradeInfo, ringTier, type BadgeId, type GradeId } from '../../shared/membership';

// The one icon set (WP71): lucide line icons, stroke 1.75, at 16, 20 or 24px. The names in shared/market.ts
// (KIND_ICONS, CATEGORIES), shared/membership.ts (BADGES, TRIAL_ROWS) and the 알림 types map here.
export const ICONS: Record<string, LucideIcon> = {
    'shopping-cart': ShoppingCart, tag: Tag, 'arrow-left-right': ArrowLeftRight, 'user-search': UserSearch, 'gamepad-2': Gamepad2,
    user: User, castle: Castle, ticket: Ticket, package: Package, trophy: Trophy, 'book-open': BookOpen, 'party-popper': PartyPopper,
    'shield-check': ShieldCheck, megaphone: Megaphone, 'alarm-clock': AlarmClock, palette: Palette, gift: Gift, bell: Bell,
    'file-text': FileText, 'trending-down': TrendingDown, handshake: Handshake, 'clipboard-list': ClipboardList, 'eye-off': EyeOff,
    copy: Copy, 'circle-pause': CirclePause, clock: Clock, 'circle-arrow-up': CircleArrowUp, 'chart-column': ChartColumn,
    'layout-list': LayoutList, 'user-check': UserCheck, 'sliders-horizontal': SlidersHorizontal, 'message-square': MessageSquare,
    'message-square-reply': MessageSquareReply, 'circle-alert': CircleAlert, target: Target, search: Search, 'message-circle': MessageCircle, lock: Lock,
};

export function Icon({ name, size = 20, className }: { name: string; size?: 16 | 20 | 24 | 32; className?: string }) {
    const Glyph = ICONS[name] || FileText;
    return <Glyph className={'ico' + (className ? ' ' + className : '')} size={size} strokeWidth={1.75} aria-hidden="true" />;
}

// Grade marks (WP71): a small hexagon in the grade's metal (WP66) with one, two or three chevrons for
// 플러스, 프리미엄 and 엘리트 and a star for 관리자; 일반 is a plain gray outline. Decorative: the grade
// name always sits next to it.
const MARK_METALS: Record<string, { stops: string[]; edge: string; ink: string }> = {
    bronze: { stops: ['var(--bronze-1)', 'var(--bronze-2)'], edge: 'var(--bronze-2)', ink: 'var(--tier-bronze-ink)' },
    silver: { stops: ['var(--silver-1)', 'var(--silver-2)'], edge: 'var(--silver-2)', ink: 'var(--tier-silver-ink)' },
    gold: { stops: ['var(--gold-1)', 'var(--gold-2)', 'var(--gold-3)'], edge: 'var(--gold-edge)', ink: 'var(--gold-ink)' },
};
const HEX = 'M12 1.9 20.6 6.85v10.3L12 22.1 3.4 17.15V6.85z';
const CHEVRONS: Record<number, number[]> = { 1: [14.4], 2: [12.6, 16.2], 3: [10.8, 14.4, 18] };
export function GradeMark({ grade, size = 24 }: { grade?: GradeId | string | null; size?: number }) {
    const uid = useId().replace(/:/g, '');
    const info = gradeInfo(grade);
    const metal = info.rank >= 3 ? 'gold' : info.rank === 2 ? 'silver' : info.rank === 1 ? 'bronze' : null;
    if (!metal) return <svg className="grade-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path d={HEX} style={{ fill: 'var(--white)', stroke: 'var(--line-2)' }} strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="2.4" style={{ fill: 'var(--ink-4)' }} />
    </svg>;
    const m = MARK_METALS[metal], id = 'gm' + uid;
    return <svg className={'grade-mark grade-mark-' + metal} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1">{m.stops.map((c, i) => <stop key={i} offset={i / (m.stops.length - 1)} style={{ stopColor: c }} />)}</linearGradient></defs>
        <path d={HEX} fill={`url(#${id})`} style={{ stroke: m.edge }} strokeWidth="1.2" strokeLinejoin="round" />
        {info.rank >= 4
            ? <path d="m12 7.6 1.35 2.75 3.03.44-2.19 2.13.52 3.02L12 14.52l-2.71 1.42.52-3.02-2.19-2.13 3.03-.44z" style={{ fill: m.ink }} />
            : CHEVRONS[info.rank].map(y => <path key={y} d={`M8.2 ${y}l3.8-2.6 3.8 2.6`} fill="none" style={{ stroke: m.ink }} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>;
}

// The site mark: the favicon's brand square with the white Z.
export function LogoMark({ size = 28 }: { size?: number }) {
    return <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" style={{ fill: 'var(--brand)' }} /><path d="M9 9h14v3.6L13.6 20H23v3H9v-3.6L18.4 12H9z" style={{ fill: 'var(--white)' }} /></svg>;
}

// The member's 프로필 사진 (WP59) when src is given (the 64px inline copy in lists and rows, the 256px photo
// on the profile head), else the initial letter; a photo that fails to load falls back to the letter.
// The ring is the member's public grade (WP66 프로필 테두리): 일반 gray, 플러스 bronze, 프리미엄 silver, 엘리트 and
// 관리자 gold with a slow shimmer, the manager black; a 무료 체험 shows 일반.
export function Avatar({ name, size = '', src, grade, trial, role }: { name: string; size?: '' | 'sm' | 'lg'; src?: string | null; grade?: string | null; trial?: boolean | null; role?: string | null }) {
    const [broken, setBroken] = useState<string | null>(null);
    const cls = 'avatar ring-' + ringTier(grade, trial, role) + (size ? ' avatar-' + size : '');
    if (src && broken !== src) return <span className={cls + ' avatar-photo'} aria-hidden="true"><img src={src} alt="" decoding="async" onError={() => setBroken(src)} /></span>;
    return <span className={cls} aria-hidden="true">{name.slice(0, 1)}</span>;
}

// Data items separated by ' · ', each kept whole so a line breaks only between items.
export function DataItems({ items }: { items: string[] }) {
    return <>{items.map((item, i) => <Fragment key={i}>{i > 0 && ' · '}<span className="nowrap">{item}</span></Fragment>)}</>;
}

export function VerifiedMark({ size = 15 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" /><path d="m6 10.2 2.6 2.6L14 7.4" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// Text-only grade chip in the grade metals (WP66): 플러스 bronze outline, 프리미엄 silver, 엘리트 gold,
// 관리자 an ink outline and 매니저 ink solid. The grade marks (GradeMark) sit on the apply modal and profile grade card.
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

const EMPTY_ICONS = { search: Search, message: MessageCircle, lock: Lock, file: FileText, bell: Bell };
export type EmptyIcon = keyof typeof EMPTY_ICONS;

// An empty state is a line icon, one line and the action (WP71); a caller without an icon gets the file icon.
export function EmptyState({ icon, title, text, action }: { icon?: EmptyIcon; title: string; text?: string; action?: ReactNode }) {
    const Glyph = EMPTY_ICONS[icon || 'file'];
    return <div className="empty"><span className="empty-icon"><Glyph size={24} strokeWidth={1.75} aria-hidden="true" /></span><h3>{title}</h3>{text && <p>{text}</p>}{action}</div>;
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
