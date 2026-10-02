import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { relativeTime } from '../../shared/market';
import { ALERT_TEXT } from '../../shared/membership';
import { api, errorText, imageUrl } from '../lib/api';
import { navigate } from '../lib/router';
import { useApp } from '../app/state';
import { CIcon, EmptyState, Modal, NameLine, SkeletonRows } from '../components/ui';

// 알림함 (WP50): GET notifications (20 a page, newest first). Tapping a row marks it read and opens its
// target; '모두 읽음' marks every row read. The header bell's count comes from the shared poll.
// 새 글 알림 (WP54): unread keyword, board, follow and condition rows carry count (the posts that match
// now, from the row's first post on) and query (the saved search to open on the board).
type Alert = { id: number; type: string; ref: string; text: string; created_at: number; read: boolean; post_id: number | null; post: { id: number; title: string; thumb: string | null; image: string | null } | null; count?: number; query?: string | null };
type Follow = { target_id: string; nickname: string; grade: string; grade_trial?: boolean; badges: string[] };
type Page = { alerts: Alert[]; hasMore: boolean; page: number };

const ICONS: Record<string, string> = {
    fav_price: 'money-with-wings', fav_closed: 'handshake', application: 'clipboard', grade_end: 'alarm-clock', hidden: 'warning', same_listing: 'police-car-light',
    // 자동 끌올 (WP52).
    auto_paused: 'warning', auto_stale: 'memo', bump_ready: 'megaphone',
    // 새 글 알림 (WP54).
    keyword: 'bell', board: 'spiral-notepad', follow: 'bookmark', condition: 'gem-stone',
    // 댓글·답글 (WP55).
    comment: 'memo', reply: 'memo',
    // 자동 가격 내리기 (WP56).
    drop_stopped: 'warning', drop_done: 'money-with-wings',
};

// 구독 관리 (WP54): the members this member follows, newest first, each with '구독 해제'.
function FollowsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [list, setList] = useState<Follow[] | null>(null);
    useEffect(() => {
        if (!open) return;
        let alive = true;
        setList(null);
        api<{ follows: Follow[] }>('me/follows').then(d => { if (alive) setList(d.follows); }).catch(e => { if (alive) { toast.error(errorText(e)); setList([]); } });
        return () => { alive = false; };
    }, [open]);
    async function unfollow(f: Follow) {
        try {
            await api(`users/${f.target_id}/follow`, 'POST', { active: false });
            setList(prev => prev && prev.filter(x => x.target_id !== f.target_id));
            toast(ALERT_TEXT.unfollowed);
        } catch (e) { toast.error(errorText(e)); }
    }
    return <Modal open={open} onClose={onClose} title={ALERT_TEXT.manage}>
        {list === null ? <SkeletonRows count={3} height={48} />
            : list.length ? <ul className="simple-list follow-list">{list.map(f => <li key={f.target_id}>
                <span className="grow"><button type="button" className="strong-link" onClick={() => { onClose(); void navigate('/profile/' + f.target_id); }}><NameLine nickname={f.nickname} grade={f.grade} trial={f.grade_trial} badges={f.badges} /></button></span>
                <button type="button" className="btn btn-line btn-xs" onClick={() => void unfollow(f)}>{ALERT_TEXT.unfollowed}</button>
            </li>)}</ul>
            : <p className="muted">{ALERT_TEXT.noFollows}</p>}
    </Modal>;
}

export default function Alerts() {
    const { me, ready, requireLogin, alerts, setAlerts, refreshUnread, openApply } = useApp();
    const [list, setList] = useState<Alert[] | null>(null);
    const [page, setPage] = useState(1), [hasMore, setHasMore] = useState(false), [loading, setLoading] = useState(false);
    const [follows, setFollows] = useState(false);
    useEffect(() => { if (ready && !me) requireLogin(); }, [ready, me, requireLogin]);
    useEffect(() => {
        if (!me) return;
        let alive = true;
        api<Page>('notifications?page=1').then(d => { if (alive) { setList(d.alerts); setHasMore(d.hasMore); setPage(1); } })
            .catch(e => { if (alive) { toast.error(errorText(e)); setList([]); } });
        return () => { alive = false; };
    }, [me?.id]);

    if (!me) return <div className="container page"><EmptyState icon="lock" title="로그인이 필요합니다" action={<button className="btn btn-primary" onClick={() => requireLogin()}>로그인</button>} /></div>;
    // Unread rows past the loaded pages still count in the bell, so the shared count shows the button too.
    const unread = (list?.some(a => !a.read) ?? false) || alerts > 0;

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
        // 자동 끌올 (WP52): a reply pause opens 채팅, the other pause the 자동화 tab, the weekly check 내 글 with
        // the posts to look at ('모두 계속').
        else if (a.type === 'auto_paused') void navigate(a.ref === 'reply' ? '/chat' : '/me/auto');
        else if (a.type === 'auto_stale') void navigate('/me/posts?stale=1');
        // 새 글 알림 (WP54): the saved search on the board in 최신순, a 구독 row the member's profile.
        else if (a.type === 'follow') void navigate('/profile/' + a.ref);
        else if ((a.type === 'keyword' || a.type === 'board' || a.type === 'condition') && a.query) {
            const q = new URLSearchParams(a.query);
            q.delete('sort');
            q.delete('page');
            void navigate('/trade?' + q.toString());
        }
        // 댓글·답글 (WP55): the post at its 댓글 section.
        else if ((a.type === 'comment' || a.type === 'reply') && a.post) void navigate('/posts/' + a.post.id + '#comments');
        else if (a.post) void navigate('/posts/' + a.post.id);
    }

    return <div className="container page alerts-page">
        <div className="alerts-head">
            <h1 className="page-title">알림</h1>
            <div className="alerts-tools">
                <button type="button" className="btn btn-text btn-sm" onClick={() => setFollows(true)}>{ALERT_TEXT.manage}</button>
                {unread && <button type="button" className="btn btn-line btn-sm" onClick={() => void readAll()}>모두 읽음</button>}
            </div>
        </div>
        <FollowsModal open={follows} onClose={() => setFollows(false)} />
        <div className="mt-16">
            {list === null ? <SkeletonRows count={4} height={72} />
                : list.length ? <>
                    <ul className="alert-list">{list.map(a => <li key={a.id}>
                        <button type="button" className={'alert-row' + (a.read ? '' : ' is-unread')} onClick={() => open(a)}>
                            <span className="alert-icon"><CIcon name={ICONS[a.type] || 'bell'} size={22} /></span>
                            <span className="alert-body">
                                <span className="alert-text">{a.text}{!a.read && a.count ? ALERT_TEXT.count(a.count) : ''}</span>
                                <span className="alert-time">{relativeTime(a.created_at)}{!a.read && <span className="sr-only"> · 읽지 않음</span>}</span>
                            </span>
                            {a.post?.thumb || a.post?.image ? <img className="alert-thumb" src={a.post.thumb || imageUrl(a.post.image!)} alt="" loading="lazy" /> : null}
                            {!a.read && <span className="alert-dot" aria-hidden="true" />}
                        </button>
                    </li>)}</ul>
                    {hasMore && <button type="button" className="btn btn-line more-btn" disabled={loading} onClick={() => void more()}>더 보기</button>}
                </>
                : <EmptyState title="새 알림이 없습니다." />}
        </div>
    </div>;
}
