import type { ReactNode } from 'react';
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
    return <>{BADGES.filter(b => badges.includes(b.id as never)).map(b => <span className="verified" key={b.id} title={b.name + ' 완료'}><VerifiedMark size={14} />{b.name}</span>)}</>;
}

// Nickname followed by the grade chip and verification checks.
export function NameLine({ nickname, grade, role, badges, size = '' }: { nickname: string; grade?: string | null; role?: string; badges?: string[]; size?: '' | 'lg' }) {
    return <span className={'name-line' + (size ? ' name-line-' + size : '')}>
        <span className="nick">{nickname}</span>
        <GradeChip grade={grade} role={role} />
        <Verified badges={badges} />
    </span>;
}

export function Modal({ open, onClose, title, description, children, footer, wide = false }: {
    open: boolean; onClose: () => void; title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
    return <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose(); }}>
        <Dialog.Portal>
            <Dialog.Overlay className="overlay" />
            <Dialog.Content className={'modal' + (wide ? ' modal-wide' : '')} aria-describedby={undefined}>
                <div className="modal-head">
                    <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
                    <Dialog.Close className="icon-btn" aria-label="닫기"><X size={22} /></Dialog.Close>
                </div>
                <div className="modal-body">
                    {description && <p className="modal-desc">{description}</p>}
                    {children}
                </div>
                {footer && <div className="modal-foot">{footer}</div>}
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}

export function EmptyState({ icon = 'magnifying-glass-tilted-left', title, text, action }: { icon?: string; title: string; text?: string; action?: ReactNode }) {
    return <div className="empty"><CIcon name={icon} size={56} /><h3>{title}</h3>{text && <p>{text}</p>}{action}</div>;
}

export function SkeletonRows({ count = 4, height = 132 }: { count?: number; height?: number }) {
    return <div className="skeleton-rows" aria-label="불러오는 중">{Array.from({ length: count }, (_, i) => <div key={i} className="skeleton" style={{ height }} />)}</div>;
}

export function Tabs<T extends string>({ items, value, onChange, label }: { items: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
    return <div className="tabs" role="tablist" aria-label={label}>
        {items.map(item => <button key={item.id} role="tab" type="button" className="tab" aria-selected={item.id === value} onClick={() => onChange(item.id)}>{item.label}</button>)}
    </div>;
}
