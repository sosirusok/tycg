import { db } from './http';
import { notifyStatement } from './notifications';
import { MANAGER_PERKS, perksOfRank, type Perks } from '../shared/membership';

// 자동 매칭 (WP58, round-3 WP34 change 6): an own 판매 or 구매 post and a post of the other side match
// when they are in the same category and nothing filled on both sides disagrees:
// - price: MAX at least 80% of the 즉거가, or either one empty;
// - on 계정: 대주 수 within 대주 이하, the 전적 (only '무전적' wanted against '전적 있음' fails), 팬텀 % at
//   least the least wanted, the nickname length within the range wanted, the 닉 등급 among the ones wanted,
//   any shared 닉 종류 and any shared ladder (an empty side matches anything).
// The SQL is shared by tick B's 'match' 알림, the 알림함 count and the list behind it (GET posts/:id/matches),
// so the three never disagree. Relists (posts.relist=1) never count as new posts of the other side.

const det = (t: string, k: string) => `json_extract(${t}.details,'$.${k}')`;
const int = (t: string, k: string) => `CAST(${det(t, k)} AS INTEGER)`;
const blank = (t: string, k: string) => `COALESCE(${det(t, k)},'')=''`;
// A list detail (stored as JSON text); anything else reads as an empty list.
const list = (t: string, k: string) => `(CASE WHEN json_valid(${det(t, k)}) THEN ${det(t, k)} ELSE '[]' END)`;
const noList = (t: string, k: string) => `json_array_length(${list(t, k)})=0`;

// The 판매 post s fits the 구매 post b (aliases of posts rows).
function fits(s: string, b: string) {
    return `((${b}.price IS NULL OR ${s}.price IS NULL OR ${b}.price*5>=${s}.price*4)
        AND (${s}.category!='account' OR ((${blank(b, 'maxOwners')} OR ${blank(s, 'ownerCount')} OR ${int(s, 'ownerCount')}<=${int(b, 'maxOwners')})
            AND (COALESCE(${det(b, 'recordPreference')},'')!='무전적' OR COALESCE(${det(s, 'recordStatus')},'')!='전적 있음')
            AND (${blank(b, 'phantomMin')} OR ${blank(s, 'phantom')} OR ${int(s, 'phantom')}>=${int(b, 'phantomMin')})
            AND (${blank(s, 'nicknameChars')} OR ((${blank(b, 'nicknameCharsMin')} OR ${int(s, 'nicknameChars')}>=${int(b, 'nicknameCharsMin')})
                AND (${blank(b, 'nicknameCharsMax')} OR ${int(s, 'nicknameChars')}<=${int(b, 'nicknameCharsMax')})))
            AND (${blank(s, 'nicknameRank')} OR ${noList(b, 'nicknameRanks')} OR EXISTS(SELECT 1 FROM json_each(${list(b, 'nicknameRanks')}) mr WHERE mr.value=${det(s, 'nicknameRank')}))
            AND (${noList(s, 'nicknameTypes')} OR ${noList(b, 'wantedNicknameTypes')}
                OR EXISTS(SELECT 1 FROM json_each(${list(s, 'nicknameTypes')}) mt1 JOIN json_each(${list(b, 'wantedNicknameTypes')}) mt2 ON mt1.value=mt2.value))
            AND (NOT EXISTS(SELECT 1 FROM post_seasons WHERE post_id=${s}.id) OR NOT EXISTS(SELECT 1 FROM post_seasons WHERE post_id=${b}.id)
                OR EXISTS(SELECT 1 FROM post_seasons ms1 JOIN post_seasons ms2 ON ms2.post_id=${b}.id AND ms2.tier=ms1.tier AND ms2.season=ms1.season WHERE ms1.post_id=${s}.id)))))`;
}

// The own post o (판매 or 구매) and the post p of the other side match. Binds nothing.
export const pairSql = (o: string, p: string) => `${p}.kind=CASE ${o}.kind WHEN 'sell' THEN 'buy' ELSE 'sell' END AND ${p}.category=${o}.category
    AND (CASE ${o}.kind WHEN 'sell' THEN ${fits(o, p)} ELSE ${fits(p, o)} END)`;

// A post the subscriber may hear about: visible, not their own, no block either way, its author not
// under 이용 정지, and the 대리(진행) rule. Aliases: p (post), u (its author); `owner` and `now` are SQL
// expressions (inlined, nothing bound but what they hold). Shared with 새 글 알림 (WP54).
export const reachable = (owner: string, now: string) => `p.hidden=0 AND p.author_id!=${owner} AND (u.suspended_until IS NULL OR u.suspended_until<=${now})
    AND (p.kind!='proxy_offer' OR u.role='manager' OR EXISTS(SELECT 1 FROM user_badges bd WHERE bd.user_id=p.author_id AND bd.badge='proxy'))
    AND NOT EXISTS(SELECT 1 FROM blocks bk WHERE (bk.user_id=${owner} AND bk.target_id=p.author_id) OR (bk.user_id=p.author_id AND bk.target_id=${owner}))`;

// The 알림함 count and the list behind it look at this many post ids from the 알림's first match on.
export const MATCH_SCAN = 600;

// The own posts of a grade (perks.matchPosts): -1 every open 판매·구매 post, 0 none.
const slotsOf = (perks: Perks) => Number.isFinite(perks.matchPosts) ? perks.matchPosts : -1;

// The posts tick B matches: of every member with '자동 매칭' on (automation_match), the open, visible 판매 and
// 구매 posts the grade allows now. 프리미엄 (3): the posts the member picked (post_auto.match=1; a post
// switched off is -1), else the 3 most recently bumped. 엘리트, 관리자 and the manager: every one.
function ownPostsSql(now: number) {
    const rank = `COALESCE((SELECT MAX(g.rank) FROM user_grades g WHERE g.user_id=a.user_id AND (g.expires_at IS NULL OR g.expires_at>${now})),0)`;
    const slots = `CASE WHEN mu.role='manager' THEN ${slotsOf(MANAGER_PERKS)} ELSE CASE ${rank} ${[0, 1, 2, 3, 4].map(r => `WHEN ${r} THEN ${slotsOf(perksOfRank(r))}`).join(' ')} ELSE 0 END END`;
    return `SELECT q.id,q.author_id,q.kind,q.category,q.price,q.details,q.title FROM (
            SELECT o.id,o.author_id,o.kind,o.category,o.price,o.details,o.title,m.slots,COALESCE(pa.match,0) AS picked,
                MAX(CASE WHEN COALESCE(pa.match,0)!=0 THEN 1 ELSE 0 END) OVER (PARTITION BY o.author_id) AS chosen,
                ROW_NUMBER() OVER (PARTITION BY o.author_id ORDER BY COALESCE(pa.match,0)=1 DESC,o.bumped_at DESC,o.id DESC) AS rn
            FROM (SELECT a.user_id,${slots} AS slots FROM automation a INDEXED BY automation_match JOIN users mu ON mu.id=a.user_id AND mu.deleted_at IS NULL WHERE a.match_on=1) m
            JOIN posts o INDEXED BY posts_author_status ON o.author_id=m.user_id AND o.status='open'
            LEFT JOIN post_auto pa ON pa.post_id=o.id
            WHERE m.slots!=0 AND o.hidden=0 AND o.kind IN ('sell','buy')) q
        WHERE q.slots<0 OR (q.rn<=q.slots AND (q.chosen=0 OR q.picked=1))`;
}

// Tick B (worker/alerts.ts alertJob): one 'match' 알림 per own post with a match among the window's new
// posts (ids, a JSON list), ref = the own post, post_id = its first match; set-based, one statement.
// The 알림함 counts the matches on open ('‘제목’ 글과 맞는 구매 글 2개').
export function matchAlertStatement(ids: string, now: number) {
    return notifyStatement('match', `SELECT o.author_id AS user_id,CAST(o.id AS TEXT) AS ref,MIN(p.id) AS post_id,NULL AS actor_id,
            '‘'||o.title||'’ 글과 맞는 '||CASE o.kind WHEN 'sell' THEN '구매' ELSE '판매' END||' 글' AS text
        FROM (${ownPostsSql(now)}) o JOIN posts p ON p.id IN (SELECT value FROM json_each(?)) AND p.relist=0 AND p.status!='closed' AND ${pairSql('o', 'p')}
        JOIN users u ON u.id=p.author_id
        WHERE ${reachable('o.author_id', String(now))}
        GROUP BY o.id`, [ids], now);
}

// The posts that match the member's own open post `ownId` from post id `from` on (at most `scan` ids),
// for the 알림함 count. Binds ownId, userId, from.
export function matchCountStatement(ownId: string, userId: string, from: number, now: number, scan: number, cap: number) {
    return db().prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM posts o JOIN posts p ON p.id>=? AND p.id<? AND p.relist=0 AND p.status!='closed' AND ${pairSql('o', 'p')}
        JOIN users u ON u.id=p.author_id WHERE o.id=? AND o.author_id=? AND o.status='open' AND o.hidden=0 AND ${reachable('o.author_id', String(now))} LIMIT ${cap})`)
        .bind(from, from + scan, ownId, userId);
}
