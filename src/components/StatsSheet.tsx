import { useEffect, useState } from 'react';
import { priceText } from '../../shared/market';
import { AD_TEXT, STATS_TEXT, type StatsLevel } from '../../shared/membership';
import { api, errorText } from '../lib/api';
import { Modal, SkeletonRows } from './ui';

// 판매 통계 (WP63): GET me/stats?post=<id> for 프리미엄 and up, opened from a 내 글 row. CSS bars in the brand
// color on white, no chart library: 7 KST days of 조회 (bars) with 찜 and 채팅 under them, 끌올 효과 (views in
// the 2 hours before and after the last placements), 광고 유입, and for 엘리트 and up 조회 by hour of day
// (14 days) and the 시세 from confirmed trades.
type Day = { day: number; views: number; favorites: number; chats: number };
type Effect = { type: 'manual' | 'auto' | 'relist'; count: number; before: number; after: number };
export type Stats = { level: StatsLevel; post: number; days: Day[]; effect: Effect[]; promoViews: number; hours?: number[]; market?: { n: number; median: number } | null };

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
// '오늘', else the KST weekday ('월').
function dayLabel(start: number, today: number) {
    return start === today ? '오늘' : WEEKDAYS[new Date(start + 9 * 3600000).getUTCDay()];
}
const height = (n: number, max: number) => `${max ? Math.max(n ? 4 : 0, Math.round(n / max * 100)) : 0}%`;

export function StatsSheet({ post, onClose, showAds }: { post: { id: number; title: string } | null; onClose: () => void; showAds?: boolean }) {
    const [stats, setStats] = useState<Stats | null>(null), [error, setError] = useState('');
    useEffect(() => {
        setStats(null); setError('');
        if (post) api<Stats>('me/stats?post=' + post.id).then(setStats).catch(e => setError(errorText(e)));
    }, [post?.id]);
    return <Modal open={!!post} onClose={onClose} title={STATS_TEXT.title} description={post?.title}>
        {error ? <p className="muted">{error}</p> : !stats ? <SkeletonRows count={2} height={96} /> : <StatsBody stats={stats} showAds={showAds} />}
    </Modal>;
}

function StatsBody({ stats, showAds }: { stats: Stats; showAds?: boolean }) {
    const max = Math.max(...stats.days.map(d => d.views)), today = stats.days[stats.days.length - 1]?.day;
    const total = (key: 'views' | 'favorites' | 'chats') => stats.days.reduce((n, d) => n + d[key], 0);
    const hours = stats.hours, hourMax = hours ? Math.max(...hours) : 0;
    return <div className="stats-sheet">
        <section className="stats-block" aria-labelledby="stats-days">
            <h3 id="stats-days">{STATS_TEXT.days}<span>{STATS_TEXT.views} {total('views')} · {STATS_TEXT.favorites} {total('favorites')} · {STATS_TEXT.chats} {total('chats')}</span></h3>
            <div className="stats-grid">
                <span className="stats-row-label">{STATS_TEXT.views}</span>
                {stats.days.map(d => <span key={d.day} className="stats-col"><span className="stats-val">{d.views}</span><span className="stats-bar" style={{ height: height(d.views, max) }} /></span>)}
                <span />
                {stats.days.map(d => <span key={d.day} className="stats-day">{dayLabel(d.day, today)}</span>)}
                <span className="stats-row-label">{STATS_TEXT.favorites}</span>
                {stats.days.map(d => <span key={d.day} className="stats-num">{d.favorites}</span>)}
                <span className="stats-row-label">{STATS_TEXT.chats}</span>
                {stats.days.map(d => <span key={d.day} className="stats-num">{d.chats}</span>)}
            </div>
        </section>
        <section className="stats-block" aria-labelledby="stats-effect">
            <h3 id="stats-effect">{STATS_TEXT.effect}<span>{STATS_TEXT.average}</span></h3>
            {stats.effect.length ? <ul className="stats-effect">{stats.effect.map(e => <li key={e.type}>
                <span>{STATS_TEXT[e.type]} {STATS_TEXT.times(e.count)}</span>
                <span className="stats-effect-nums">{STATS_TEXT.before} <b>{e.before}</b> · {STATS_TEXT.after} <b>{e.after}</b></span>
            </li>)}</ul> : <p className="muted small">{STATS_TEXT.noEffect}</p>}
            {(showAds || stats.promoViews > 0) && <p className="stats-note">{AD_TEXT.views(stats.promoViews)}</p>}
        </section>
        {hours && <section className="stats-block" aria-labelledby="stats-hours">
            <h3 id="stats-hours">{STATS_TEXT.hours}</h3>
            <div className="stats-hours">{hours.map((n, h) => <span key={h} className="stats-hour" title={`${h}시 ${STATS_TEXT.views} ${n}`}><span className="stats-hour-bar" style={{ height: height(n, hourMax) }} /></span>)}</div>
            <div className="stats-hours-axis" aria-hidden="true"><span>0시</span><span>6시</span><span>12시</span><span>18시</span></div>
        </section>}
        {stats.market && <section className="stats-block stats-market" aria-labelledby="stats-market">
            <h3 id="stats-market">{STATS_TEXT.market}</h3>
            <p>{STATS_TEXT.marketLine(stats.market.n, priceText(stats.market.median))}</p>
        </section>}
    </div>;
}
