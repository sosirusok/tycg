import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { User } from '../../shared/market';
import { EARN_DEFAULTS, EARN_TEXT, PROVIDER_INTRO_MAX, PROVIDER_TEXT, type BadgeId, type Earn, type GradeId, type ProviderType } from '../../shared/membership';
import { hasContact } from '../../shared/links';
import { api, errorText, imageUrl } from '../lib/api';
import { navigate } from '../lib/router';
import { lastSeenText } from '../lib/lastSeen';
import { CHAT_DRAFT_EVENT, chatDraftKey } from '../app/ApplyModal';
import { Avatar, Modal, Verified } from './ui';

// One member on the '중개/가측' tab (GET /api/providers, WP66): the 소개 is already cut to the grade's length.
export type ProviderItem = {
    id: string; nickname: string; avatar: string | null; avatarId: string | null; grade: GradeId; intro: string; online: boolean; lastSeenAt: number | null;
    badges: BadgeId[]; reviewCount: number; type?: ProviderType;
};
export type OwnCard = { intro: string; active: boolean; listed: boolean; reason: '' | 'grade' | 'off' };

// Opens (or reuses) the 1:1 chat with the member and fills the composer with the 문의 template, never sent.
// Guests sign in first and go on from there; the member's own card opens its editor instead (onOwn).
export function openProviderChat(p: ProviderItem, type: ProviderType, requireLogin: (next?: (u: User) => void) => boolean, onOwn?: () => void) {
    requireLogin(async u => {
        if (u.id === p.id) { onOwn?.(); return; }
        try {
            const d = await api<{ id: string }>('chats', 'POST', { userId: p.id });
            try {
                sessionStorage.setItem(chatDraftKey(d.id), PROVIDER_TEXT.draft[type]);
                window.dispatchEvent(new CustomEvent(CHAT_DRAFT_EVENT, { detail: d.id }));
            } catch { /* storage may be unavailable: the chat opens empty */ }
            void navigate('/chat/' + d.id);
        } catch (e) { toast.error(errorText(e)); }
    });
}

// '접속 중' with its dot, or '최근 접속 3시간 전'.
function Seen({ p }: { p: ProviderItem }) {
    if (p.online) return <span className="pv-online"><span className="pv-dot" aria-hidden="true" />{PROVIDER_TEXT.online}</span>;
    const text = lastSeenText(p.lastSeenAt);
    return text ? <span>{text}</span> : null;
}

// 엘리트 and 관리자: the gold card (WP66 item 6). The whole card is one button.
export function EliteCard({ p, mine, onOpen }: { p: ProviderItem; mine?: boolean; onOpen: () => void }) {
    return <button type="button" className="pv-elite" onClick={onOpen}>
        <span className="pv-elite-who">
            <Avatar name={p.nickname} src={p.avatarId ? imageUrl(p.avatarId) : p.avatar} grade={p.grade} />
            <span className="pv-elite-name">{p.nickname}</span>
        </span>
        <span className="pv-elite-main">
            {mine && <span className="pv-mine">{PROVIDER_TEXT.mine}</span>}
            {p.intro ? <span className="pv-elite-intro">{p.intro}</span> : <span className="pv-elite-intro is-empty">{PROVIDER_TEXT.names[p.type || 'broker']}</span>}
            <span className="pv-elite-meta"><Seen p={p} />{p.badges.length > 0 && <span className="pv-badges"><Verified badges={p.badges} /></span>}<span>{PROVIDER_TEXT.reviews(p.reviewCount)}</span></span>
        </span>
    </button>;
}

// 프리미엄 (64px, 소개 12자) and 플러스 (48px, nickname only) profiles (WP66 item 7).
export function ProviderTile({ p, size, mine, onOpen }: { p: ProviderItem; size: 'premium' | 'plus'; mine?: boolean; onOpen: () => void }) {
    return <button type="button" className={'pv-tile pv-' + size} onClick={onOpen}>
        <span className="pv-tile-avatar"><Avatar name={p.nickname} src={p.avatar} grade={p.grade} />{p.online && <span className="pv-dot pv-dot-on" title={PROVIDER_TEXT.online}><span className="sr-only">{PROVIDER_TEXT.online}</span></span>}</span>
        <span className="pv-tile-name">{p.nickname}</span>
        {size === 'premium' && p.intro && <span className="pv-tile-intro">{p.intro}</span>}
        {mine && <span className="pv-mine">{PROVIDER_TEXT.mine}</span>}
    </button>;
}

// The gold mini card of the home popup (WP66 item 12): avatar, nickname, '중개' or '가측' and the 소개, with the
// solid '광고' label (ad) in its head row.
export function ProviderMini({ p, ad }: { p: ProviderItem; ad?: string }) {
    return <span className="pv-mini">
        <Avatar name={p.nickname} src={p.avatar} grade={p.grade} />
        <span className="pv-mini-text">
            <span className="pv-mini-head"><b>{p.nickname}</b><span className="pv-mini-kind">{PROVIDER_TEXT.names[p.type || 'broker']}</span>{ad && <span className="pv-mini-ad">{ad}</span>}</span>
            {p.intro && <span className="pv-mini-intro">{p.intro}</span>}
        </span>
    </span>;
}

// The member's own card: '소개' (one line, 25자, no links or phone numbers) and '받는 중'.
export function ProviderEditor({ open, onClose, type, initial, onSaved }: { open: boolean; onClose: () => void; type: ProviderType; initial: { intro: string; active: boolean } | null; onSaved: (v: { intro: string; active: boolean }) => void }) {
    const [intro, setIntro] = useState(''), [active, setActive] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
    useEffect(() => { if (open) { setIntro(initial?.intro || ''); setActive(initial?.active ?? true); setError(''); } }, [open]);
    const bad = hasContact(intro);
    async function save() {
        if (busy) return;
        setBusy(true); setError('');
        try { const d = await api<{ intro: string; active: boolean }>('providers/me/' + type, 'PUT', { intro, active }); onSaved(d); toast('저장 완료'); onClose(); }
        catch (e) { setError(errorText(e)); }
        finally { setBusy(false); }
    }
    return <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={`${PROVIDER_TEXT.mine} · ${PROVIDER_TEXT.names[type]}`}
        footer={<button type="button" className="btn btn-primary btn-lg" disabled={busy || bad} onClick={() => void save()}>저장</button>}>
        <div className="form-stack">
            <label className="field"><span className="field-label">소개</span>
                <input className="input" value={intro} maxLength={PROVIDER_INTRO_MAX} onChange={e => setIntro(e.target.value.replace(/\n/g, ' '))} placeholder={type === 'broker' ? '예: 계정 거래 중개 3년, 밤에도 가능' : '예: 래더 계정 시세 빠르게 측정'} />
                <span className="field-hint">{[...intro].length}/{PROVIDER_INTRO_MAX} · 엘리트 25자, 프리미엄 12자까지 표시</span>
                {bad && <span className="field-error" role="alert">{PROVIDER_TEXT.introBad}</span>}</label>
            <label className="switch"><input type="checkbox" role="switch" checked={active} onChange={e => setActive(e.target.checked)} />{PROVIDER_TEXT.receiving}</label>
            {error && <p className="field-error" role="alert">{error}</p>}
        </div>
    </Modal>;
}

// 수익 홍보 (WP66 item 15): the owner's examples, never a promise; the amounts and the 사례 come from settings.
export function EarnBlock({ earn, className }: { earn?: Earn; className?: string }) {
    const e = earn || EARN_DEFAULTS;
    return <section className={'earn' + (className ? ' ' + className : '')} aria-label={EARN_TEXT.title}>
        <h3 className="earn-title">{EARN_TEXT.title}</h3>
        <p className="earn-example"><span className="earn-lead">수익 예시: </span><span className="earn-stat"><span className="earn-kind">중개</span> <b>월 {e.broker}</b></span><span className="earn-sep"> · </span><span className="earn-stat"><span className="earn-kind">가측</span> <b>월 {e.appraise}</b></span></p>
        <p className="earn-story">{e.story}</p>
        <ul className="earn-lines">
            <li>{EARN_TEXT.from}</li>
            <li>{EARN_TEXT.reach}</li>
        </ul>
        <p className="earn-note">{EARN_TEXT.note}</p>
    </section>;
}
