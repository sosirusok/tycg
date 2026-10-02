import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { Check } from 'lucide-react';
import { celebrationLines, gradeInfo, kstDate, publicRank } from '../../shared/membership';
import { api } from '../lib/api';
import { useApp } from '../app/state';
import { MODAL_DAY_KEY } from '../app/TrialPopup';
import { Avatar, CIcon } from './ui';

// 등급 축하 창 (WP66 item 14b): when the member's public grade rises (a manager grant; the 무료 체험 never counts),
// the next page view shows this once: the metal badge, '<등급> 회원이 되었습니다', the strongest benefits the
// grade unlocks (from PERKS) and the member's own avatar with the new ring. '확인' (or closing it) stores the
// rank (users.celebrated_rank); a lower rank (an ended grade) is stored quietly, so the next rise shows it again.
export function GradeCelebration() {
    const { me, setMe, authMode, apply } = useApp();
    const [open, setOpen] = useState(false), [photo, setPhoto] = useState<string | null>(null);
    const sent = useRef('');
    const rank = me ? publicRank(me) : 0, seen = me?.celebrated_rank ?? rank;
    const due = !!me && me.role !== 'manager' && rank > seen;

    function store() {
        if (!me) return;
        const key = me.id + ':' + rank;
        if (sent.current === key) return;
        sent.current = key;
        api<{ rank: number }>('me/celebrated', 'POST', {}).then(d => setMe({ ...me, celebrated_rank: d.rank })).catch(() => { sent.current = ''; });
    }
    // An ended grade: remember the lower rank without a window.
    useEffect(() => { if (me && me.role !== 'manager' && rank < seen) store(); }, [me?.id, rank, seen]);
    useEffect(() => {
        if (!due || open || authMode || apply) return;
        let timer = setTimeout(function show() {
            if (document.querySelector('[role=dialog]')) { timer = setTimeout(show, 1000); return; }
            setOpen(true);
            // The site's one modal of the day: no home ad card today.
            try { localStorage.setItem(MODAL_DAY_KEY, kstDate(Date.now())); } catch { /* storage may be unavailable */ }
        }, 600);
        return () => clearTimeout(timer);
    }, [due, open, authMode, apply]);
    // The member's 프로필 사진 for the frame preview (the session carries no photo).
    useEffect(() => {
        if (!open || !me) return;
        api<{ user: { avatar_thumb?: string } }>('users/' + me.id).then(d => setPhoto(d.user.avatar_thumb || null)).catch(() => {});
    }, [open, me?.id]);

    if (!me || (!due && !open)) return null;
    const grade = gradeInfo(me.grade), tier = rank >= 3 ? 'gold' : rank === 2 ? 'silver' : 'bronze';
    const close = () => { setOpen(false); store(); };
    return <Dialog.Root open={open} onOpenChange={o => { if (!o) close(); }}>
        <Dialog.Portal>
            <Dialog.Overlay className="overlay" />
            <Dialog.Content className={'celebrate celebrate-' + tier} aria-describedby={undefined}>
                <div className="celebrate-hero">
                    <span className="celebrate-medal"><CIcon name={grade.icon} size={44} /></span>
                    <Dialog.Title className="celebrate-title">{grade.name} 회원이 되었습니다</Dialog.Title>
                </div>
                <div className="celebrate-body">
                    <div className="celebrate-me"><Avatar name={me.nickname} src={photo} grade={me.grade} trial={me.grade_trial} role={me.role} /><span>{me.nickname}</span></div>
                    <ul className="celebrate-list">{celebrationLines(grade.id).map(line => <li key={line}><Check size={16} aria-hidden="true" />{line}</li>)}</ul>
                </div>
                <div className="celebrate-foot"><button type="button" className="btn btn-primary btn-lg" onClick={close}>확인</button></div>
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}
