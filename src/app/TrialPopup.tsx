import { useEffect, useState } from 'react';
import { Dialog } from 'radix-ui';
import { Gift, X } from 'lucide-react';
import { TRIAL_ROWS, kstDate, kstDateTime } from '../../shared/membership';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { Icon } from '../components/ui';
import { useApp } from './state';

// The site shows at most one modal a day: the day this popup shows, no ad card shows.
export const MODAL_DAY_KEY = 'modal-day';

// '플러스 7일 무료 체험' sign-up event popup (WP41). It opens about 400 ms after the sign-up dialog
// closes, once no other dialog is open, and keeps coming back on later visits until the member closes
// it or taps '첫 글 쓰기' (both stamp users.trial_popup_at, so it shows once per account).
export function TrialPopup() {
    const { me, trial, setTrial, authMode, apply } = useApp();
    const [open, setOpen] = useState(false);
    const endsAt = trial?.endsAt ?? null;
    const due = !!me && !!trial?.popup && !!endsAt && endsAt > Date.now();

    useEffect(() => {
        if (!due || open || authMode || apply) return;
        let timer = setTimeout(function show() {
            // Another dialog (a confirm, a sheet) is on screen: wait for it to close.
            if (document.querySelector('[role=dialog]')) { timer = setTimeout(show, 1000); return; }
            setOpen(true);
            try { localStorage.setItem(MODAL_DAY_KEY, kstDate(Date.now())); } catch { /* storage may be unavailable */ }
        }, 400);
        return () => clearTimeout(timer);
    }, [due, open, authMode, apply]);

    function close(write = false) {
        setOpen(false);
        if (trial) setTrial({ ...trial, popup: false });
        api('me/trial-popup', 'POST', {}).catch(() => {});
        if (write) void navigate('/write');
    }

    if (!due && !open) return null;
    return <Dialog.Root open={open} onOpenChange={o => { if (!o) close(); }}>
        <Dialog.Portal>
            <Dialog.Overlay className="trial-overlay" />
            <Dialog.Content className="trial-card" aria-describedby={undefined} onOpenAutoFocus={e => { e.preventDefault(); (e.currentTarget as HTMLElement).focus(); }}>
                <div className="trial-hero">
                    <span className="trial-eyebrow">신규 가입 이벤트</span>
                    <Dialog.Title asChild><h2>가입 선물 <b>플러스 7일</b> <b>무료 체험</b></h2></Dialog.Title>
                    <Gift className="trial-art" size={150} strokeWidth={1.25} aria-hidden="true" />
                    <Dialog.Close className="trial-x" aria-label="닫기"><X size={24} /></Dialog.Close>
                </div>
                <div className="trial-body">
                    {endsAt && <div className="trial-until"><span>체험 기간</span><strong>{kstDateTime(endsAt)}까지</strong></div>}
                    <ul className="trial-perks">
                        {TRIAL_ROWS.map(row => <li key={row.icon}><span className="trial-perk-icon"><Icon name={row.icon} size={20} /></span><div><strong>{row.title}</strong><span>{row.text}</span></div></li>)}
                    </ul>
                    <p className="trial-fine">체험이 끝나면 일반 등급으로 돌아갑니다. 결제는 없습니다.</p>
                </div>
                <div className="trial-foot">
                    <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => close(true)}>첫 글 쓰기</button>
                    <button type="button" className="btn btn-text" onClick={() => close()}>닫기</button>
                </div>
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}
