import { relativeTime } from '../../shared/market';

// The server writes users.last_seen_at at most once per 10 minutes, so anything newer reads
// '최근 접속 10분 이내'; older times read '최근 접속 3시간 전'. Empty when it was never recorded.
export function lastSeenText(t: number | null | undefined) {
    if (!t) return '';
    return Date.now() - t < 10 * 60000 ? '최근 접속 10분 이내' : '최근 접속 ' + relativeTime(t);
}
