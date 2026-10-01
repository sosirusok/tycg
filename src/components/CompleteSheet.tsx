import { useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { toast } from 'sonner';
import { KIND_ICONS, closedLabel, isTradeKind, listingPrice, manToWon, priceText, wonToMan, type Post } from '../../shared/market';
import { api, errorText, imageUrl } from '../lib/api';
import { Avatar, CIcon, Modal, NameLine } from './ui';

type Partner = { id: string; nickname: string; role: string; grade: string; grade_trial?: boolean; badges: string[]; conversation_id: string; accepted_amount: number | null; chat_at: number; restricted?: boolean };
// The post as the sheet needs it: the detail page, 내 글 and the chat's pinned bar all have these.
export type SheetPost = { id: number; kind: string; title: string; price: number | null; price_mode?: string; status: string; thumb: string | null };
const OUTSIDE = '';
const SHOWN = 5;
const dayText = (t: number) => new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

// 완료 sheet (WP43, design 'completion sheet'): one tap in the common case. It opens from the detail
// page's owner button, the 내 글 row and the chat's pinned bar (that chat's partner preselected).
// '거래한 회원' preselects the chat partner, else the accepted 제시's sender, else the only partner, else
// '사이트 밖 거래 · 기록 없음'. '거래가' is filled from the accepted 제시 or the post price (hidden for 교환
// and 사이트 밖). The button completes the post (final) and, with a member picked, asks them to
// confirm the trade. On a post already completed (within 7 days, no record yet) the same sheet asks
// for the record only. X and the overlay change nothing. `post` null keeps it closed.
export function CompleteSheet({ post, preselect, suspended = false, onClose, onDone }: { post: SheetPost | null; preselect?: string; suspended?: boolean; onClose: () => void; onDone?: (chatId: string | null) => void }) {
    const [partners, setPartners] = useState<Partner[] | null>(null), [pick, setPick] = useState(OUTSIDE), [amount, setAmount] = useState('');
    const [more, setMore] = useState(false), [busy, setBusy] = useState(false);
    const close = useRef(onClose);
    close.current = onClose;
    const completing = !!post && post.status !== 'closed';
    const exchange = post?.kind === 'exchange';
    const amountFor = (list: Partner[], id: string) => {
        const p = list.find(x => x.id === id);
        return wonToMan(p?.accepted_amount ?? post?.price ?? null);
    };
    useEffect(() => {
        setPartners(null); setPick(OUTSIDE); setMore(false); setAmount('');
        if (!post) return;
        // Under 이용 정지 the post can only be completed, without a trade record.
        if (suspended) { setPartners([]); return; }
        let alive = true;
        api<{ partners: Partner[] }>(`posts/${post.id}/partners`).then(d => {
            if (!alive) return;
            const list = d.partners.filter(p => !p.restricted);
            const chosen = preselect && list.some(p => p.id === preselect) ? preselect
                : list.find(p => p.accepted_amount !== null)?.id ?? (list.length === 1 ? list[0].id : OUTSIDE);
            setPartners(list); setPick(completing ? chosen : chosen || list[0]?.id || OUTSIDE);
            setAmount(amountFor(list, chosen));
            if (list.findIndex(p => p.id === chosen) >= SHOWN) setMore(true);
        }).catch(() => { if (alive) setPartners([]); });
        return () => { alive = false; };
    }, [post?.id, preselect, suspended]);

    if (!post) return <Modal open={false} onClose={onClose} title="" />;
    const label = closedLabel(post.kind);
    const choose = (id: string) => { setPick(id); if (partners) setAmount(amountFor(partners, id)); };
    const won = manToWon(amount);
    const showAmount = !exchange && pick !== OUTSIDE;
    const badAmount = showAmount && Number.isNaN(won);

    async function save() {
        if (busy || !post || badAmount) return;
        setBusy(true);
        const trade = pick !== OUTSIDE ? { partnerId: pick, ...showAmount && won !== null ? { amount: won } : {} } : {};
        try {
            if (completing) {
                const d = await api<{ chatId?: string; trade?: unknown }>(`posts/${post.id}/status`, 'PATCH', { status: 'closed', ...trade });
                toast(`상태 변경: ${label}`);
                close.current();
                onDone?.(d.chatId ?? null);
            } else {
                const d = await api<{ chatId: string }>(`posts/${post.id}/trade`, 'POST', trade);
                toast('요청 완료');
                close.current();
                onDone?.(d.chatId);
            }
        } catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }

    const list = partners || [];
    const shown = more ? list : list.slice(0, SHOWN);
    const icon = isTradeKind(post.kind) ? KIND_ICONS[post.kind] : 'money-bag';
    return <Modal open onClose={() => { if (!busy) close.current(); }} title={completing ? label : '거래 기록 요청'}
        footer={<button type="button" className="btn btn-primary btn-lg btn-block" disabled={busy || partners === null || badAmount || (!completing && pick === OUTSIDE)} onClick={() => void save()}>{completing ? label : '거래 기록 요청'}</button>}>
        <div className="complete-sheet">
            <div className="post-strip">
                <span className="post-strip-thumb">{post.thumb ? <img src={imageUrl(post.thumb)} alt="" /> : <CIcon name={icon} size={28} />}</span>
                <span className="post-strip-text"><strong>{post.title}</strong><span>{listingPrice({ kind: post.kind as Post['kind'], price: post.price, price_mode: post.price_mode || (post.price === null ? 'offer' : 'fixed') })}</span></span>
            </div>
            {!suspended && <section className="complete-section">
                <h3>거래한 회원</h3>
                {partners === null ? <div className="skeleton" style={{ height: 56 }} /> : <div className="apply-options" role="radiogroup" aria-label="거래한 회원">
                    {shown.map(p => <label key={p.id} className="apply-option partner-option">
                        <input type="radio" name="complete-partner" value={p.id} checked={pick === p.id} onChange={() => choose(p.id)} />
                        <Avatar name={p.nickname} size="sm" />
                        <span className="apply-option-body">
                            <NameLine nickname={p.nickname} grade={p.grade} trial={p.grade_trial} role={p.role} badges={p.badges} compact />
                            <span className="partner-sub">{p.accepted_amount !== null ? `제시 수락 · ${priceText(p.accepted_amount)}` : `채팅 · ${dayText(p.chat_at)}`}</span>
                        </span>
                        <span className="radio-dot" aria-hidden="true" />
                    </label>)}
                    {list.length > SHOWN && !more && <button type="button" className="btn btn-text btn-sm partner-more" onClick={() => setMore(true)}>더 보기</button>}
                    {completing && <label className="apply-option partner-option">
                        <input type="radio" name="complete-partner" value="" checked={pick === OUTSIDE} onChange={() => choose(OUTSIDE)} />
                        <span className="apply-option-body"><span className="partner-outside">사이트 밖 거래 · 기록 없음</span></span>
                        <span className="radio-dot" aria-hidden="true" />
                    </label>}
                </div>}
                {pick !== OUTSIDE && <p className="complete-note">상대가 확인하면 두 회원의 거래 기록에 남습니다.</p>}
            </section>}
            {showAmount && <label className="field"><span className="field-label">거래가</span>
                <div className="input-unit"><input className="input" type="number" inputMode="decimal" min="0.1" step="0.1" value={amount} aria-invalid={badAmount || undefined} onChange={e => setAmount(e.target.value)} /><span>만원</span></div>
                {badAmount ? <span className="field-error" role="alert">거래가를 만원 단위로 입력해 주세요. 예: 35</span> : <span className="field-hint">단위: 만원</span>}</label>}
            {completing && <p className="lock-line"><Lock size={16} aria-hidden="true" />완료하면 되돌릴 수 없습니다.</p>}
        </div>
    </Modal>;
}
