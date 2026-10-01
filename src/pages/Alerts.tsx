import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { relativeTime } from '../../shared/market';
import { api, errorText, imageUrl } from '../lib/api';
import { navigate } from '../lib/router';
import { useApp } from '../app/state';
import { CIcon, EmptyState, SkeletonRows } from '../components/ui';

// 알림함 (WP50): GET notifications (20 a page, newest first). Tapping a row marks it read and opens its
// target; '모두 읽음' marks every row read. The header bell's count comes from the shared poll.
type Alert = { id: number; type: string; ref: string; text: string; created_at: number; read: boolean; post_id: number | null; post: { id: number; title: string; thumb: string | null } | null };
type Page = { alerts: Alert[]; hasMore: boolean; page: number };

const ICONS: Record<string, string> = {
    fav_price: 'money-with-wings', fav_closed: 'handshake', application: 'clipboard', grade_end: 'alarm-clock', hidden: 'warning', same_listing: 'police-car-light',
};

export default function Alerts() {
    const { me, ready, requireLogin, setAlerts, refreshUnread, openApply } = useApp();
    const [list, setList] = useState<Alert[] | null>(null);
    const [page, setPage] = useState(1), [hasMore, setHasMore] = useState(false), [loading, setLoading] = useState(false);
    useEffect(() => { if (ready && !me) requireLogin(); }, [ready, me, requireLogin]);
    useEffect(() => {
        if (!me) return;
        let alive = true;
        api<Page>('notifications?page=1').then(d => { if (alive) { setList(d.alerts); setHasMore(d.hasMore); setPage(1); } })
            .catch(e => { if (alive) { toast.error(errorText(e)); setList([]); } });
        return () => { alive = false; };
    }, [me?.id]);

    if (!me) return <div className="container page"><EmptyState icon="lock" title="로그인이 필요합니다" action={<button className="btn btn-primary" onClick={() => requireLogin()}>로그인</button>} /></div>;
    const unread = list?.some(a => !a.read) ?? false;

    async function more() {
        if (loading) return;
        setLoading(true);
        try {
            const d = await api<Page>('notifications?page=' + (page + 1));
            setList(prev => [...(prev || []), ...d.alerts.filter(a => !prev?.some(p => p.id === a.id))]);
            setHasMore(d.hasMore);
            setPage(d.page);
        } catch (e) { toast.error(errorText(e)); }
        finally { setLoading(false); }
    }
    async function readAll() {
        try {
            await api('notifications/read-all', 'POST', {});
            setList(prev => prev && prev.map(a => ({ ...a, read: true })));
            setAlerts(0);
        } catch (e) { toast.error(errorText(e)); }
    }
    // The row is marked read on the page at once; the request runs in the background and the shared
    // poll corrects the count if it failed.
    function open(a: Alert) {
        if (!a.read) {
            setList(prev => prev && prev.map(x => x.id === a.id ? { ...x, read: true } : x));
            setAlerts(n => Math.max(0, n - 1));
            api('notifications/read', 'POST', { id: a.id }).catch(() => refreshUnread());
        }
        if (a.type === 'application') void navigate('/me/applications');
        else if (a.type === 'grade_end') openApply(me!.grade_trial || me!.grade === 'normal' ? { kind: 'grade', target: 'plus' } : undefined);
        else if (a.post) void navigate('/posts/' + a.post.id);
    }

    return <div className="container page alerts-page">
        <div className="alerts-head">
            <h1 className="page-title">알림</h1>
            {unread && <button type="button" className="btn btn-line btn-sm" onClick={() => void readAll()}>모두 읽음</button>}
        </div>
        <div className="mt-16">
            {list === null ? <SkeletonRows count={4} height={72} />
                : list.length ? <>
                    <ul className="alert-list">{list.map(a => <li key={a.id}>
                        <button type="button" className={'alert-row' + (a.read ? '' : ' is-unread')} onClick={() => open(a)}>
                            <span className="alert-icon"><CIcon name={ICONS[a.type] || 'bell'} size={22} /></span>
                            <span className="alert-body">
                                <span className="alert-text">{a.text}</span>
                                <span className="alert-time">{relativeTime(a.created_at)}{!a.read && <span className="sr-only"> · 읽지 않음</span>}</span>
                            </span>
                            {a.post?.thumb ? <img className="alert-thumb" src={imageUrl(a.post.thumb)} alt="" loading="lazy" /> : null}
                            {!a.read && <span className="alert-dot" aria-hidden="true" />}
                        </button>
                    </li>)}</ul>
                    {hasMore && <button type="button" className="btn btn-line more-btn" disabled={loading} onClick={() => void more()}>더 보기</button>}
                </>
                : <EmptyState title="새 알림이 없습니다." />}
        </div>
    </div>;
}
