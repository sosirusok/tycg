import { useState } from 'react';
import { X } from 'lucide-react';
import { CIcon } from '../components/ui';
import { useApp } from './state';

// '알림 켜기' (WP64): one line over the page right after the member sends a chat message or turns on an
// 알림 (offerPush), never on page load. The button asks the browser and subscribes; '닫기' hides the bar
// for 30 days.
export function PushBar() {
    const { pushBar, enablePush, closePushBar } = useApp();
    const [busy, setBusy] = useState(false);
    if (!pushBar) return null;
    return <div className="push-bar" role="status">
        <CIcon name="bell" size={22} />
        <p>새 채팅과 알림을 이 기기에서 받습니다.</p>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => { setBusy(true); void enablePush().finally(() => setBusy(false)); }}>알림 켜기</button>
        <button type="button" className="icon-btn" aria-label="닫기" onClick={closePushBar}><X size={18} /></button>
    </div>;
}
