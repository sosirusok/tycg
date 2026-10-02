import { TEMPLATE_VARS, priceText, wonText } from './market';
import {
    AD_TEXT, CHAT_AUTO_TEXT, MATCH_TEXT, PERKS, REPORT_TEXT, SITE_RULES, STATS_GUIDE, STATS_TEXT, TITLE_STYLE_NAMES, dropGuideText, filterAlertText, gapText, gradeInfo, introShown,
    linkPreviewAllowed, matchGuideText, priorityCell, titleTier, type GradeId, type Perks,
} from './membership';
import { styleRank } from './richtext';

// 등급 혜택 표시 (WP61). Every row of the Guide table, the counts and '일반 대비' lines on the grade cards and the
// apply modal's lines come from PERKS, SITE_RULES and GRADES only, so no screen can drift from what the Worker
// enforces and every word stays true (no hand-typed numbers). 자동 매칭 (matchPosts, matchChats: WP58), 판매 통계
// (stats) and 대표 글 (profilePins: WP63) and the order rows (WP60) use the helpers of the packages that ship them.
// Rows are split into specific items, so '혜택 N가지' counts honestly.
export type BenefitCell = string | string[];
export type BenefitRow = { label: string; cell: (g: GradeId) => BenefitCell; price?: boolean };
// The table's columns; 관리자 has every 엘리트 benefit, so its column would repeat 엘리트.
export const TABLE_GRADES: GradeId[] = ['normal', 'plus', 'premium', 'elite'];
export const PAID_GRADES = ['plus', 'premium', 'elite'] as const;
export type PaidGrade = typeof PAID_GRADES[number];
export const isPaidGrade = (g: unknown): g is PaidGrade => typeof g === 'string' && (PAID_GRADES as readonly string[]).includes(g);

const rank = (g: GradeId) => gradeInfo(g).rank;
// 6개월 plans: '월 환산 1만원' (the price divided by the months, rounded down to 100원).
export const monthly = (price: number, months: number) => priceText(Math.floor(price / months / 100) * 100);
// The tier table's daily formula: the 3 new posts on top, then the full wallet and a day of refills.
export const dailyTops = (k: Perks) => SITE_RULES.freshPerDay + k.bumpMax + Math.floor(1440 / k.bumpRefillMinutes);
// The grade chips and avatar rings in the grade metals (WP66).
const NAME_STYLE: Record<string, string> = { normal: '-', plus: '동색 테두리', premium: '은색 바탕', elite: '금색 바탕' };
const RING_STYLE: Record<string, string> = { normal: '회색', plus: '동색', premium: '은색', elite: '금색 (반짝임)' };
const STYLE_LADDER = ['굵게', '+ 글자색·밑줄·취소선', '+ 글자 크기', '+ 배경 강조·가운데 정렬'];

export const BENEFIT_ROWS: BenefitRow[] = [
    { label: '가격', price: true, cell: g => gradeInfo(g).plans.length ? gradeInfo(g).plans.map(p => `${p.label} ${wonText(p.price)}${p.months ? ` · 월 환산 ${monthly(p.price, p.months)}` : ''}`) : '무료' },
    { label: '끌올 보관', cell: g => `${PERKS[g].bumpMax}개` },
    { label: '끌올 충전', cell: g => `${gapText(PERKS[g].bumpRefillMinutes)}마다 1개` },
    { label: '같은 글 끌올 간격', cell: g => gapText(PERKS[g].bumpGapMinutes) },
    { label: '하루 최대 맨 위 노출', cell: g => `약 ${dailyTops(PERKS[g])}번` },
    // One post per run: '-', '글 1개 · 4시간마다 1번', '글 5개 중 1개씩 · 1시간 30분마다', '전체 중 1개씩 · 30분마다'.
    { label: '자동 끌올', cell: g => { const k = PERKS[g], every = gapText(k.autoEveryMinutes); return !k.autoBumpPosts ? '-' : k.autoBumpPosts === 1 ? `글 1개 · ${every}마다 1번` : Number.isFinite(k.autoBumpPosts) ? `글 ${k.autoBumpPosts}개 중 1개씩 · ${every}마다` : `전체 중 1개씩 · ${every}마다`; } },
    { label: '자동 가격 내리기', cell: g => dropGuideText(PERKS[g]) },
    { label: '조건 알림', cell: g => filterAlertText(PERKS[g]) },
    // '-', '내 글 3개', '내 글 전체 · 채팅 보내기 하루 20번'.
    { label: MATCH_TEXT.switch, cell: g => matchGuideText(PERKS[g]) },
    { label: '내 빠른 답장', cell: g => { const k = PERKS[g]; return !k.replyTemplates ? '-' : `${k.replyTemplates}개${k.templateVars ? (rank(g) >= 3 ? ' · 변수' : ' · ' + TEMPLATE_VARS.join(' ')) : ''}`; } },
    { label: CHAT_AUTO_TEXT.first, cell: g => PERKS[g].firstReply ? 'O' : '-' },
    { label: '자리 비움 자동 응답', cell: g => PERKS[g].awayReply ? 'O' : '-' },
    { label: '추천 설정 모두 켜기', cell: g => rank(g) >= 3 ? 'O' : '-' },
    { label: '제목 강조', cell: g => TITLE_STYLE_NAMES[titleTier(g)] },
    { label: '링크 미리보기', cell: g => linkPreviewAllowed(g) ? 'O' : '-' },
    { label: '글자 꾸미기', cell: g => STYLE_LADDER[styleRank(g)] },
    { label: '게시판 상단 광고', cell: g => PERKS[g].adSlots ? `${PERKS[g].adSlots}개` : '-' },
    { label: `거래완료 글 하단 ${AD_TEXT.similar}`, cell: g => PERKS[g].adSlots ? 'O' : '-' },
    { label: `홈 ${AD_TEXT.home}`, cell: g => rank(g) >= 3 ? 'O' : '-' },
    { label: '홈 하단 광고 카드', cell: g => rank(g) >= 3 ? 'O' : '-' },
    { label: '광고 유입 수 · 광고 고정', cell: g => PERKS[g].adSlots ? 'O' : '-' },
    // 신고 처리 순서 and the manager's unread chats (WP60): the same order by grade, the 체험 as 일반.
    { label: REPORT_TEXT.order, cell: g => priorityCell(g) },
    { label: REPORT_TEXT.chatOrder, cell: g => priorityCell(g) },
    { label: '대표 글', cell: g => PERKS[g].profilePins ? `${PERKS[g].profilePins}개` : '-' },
    { label: STATS_TEXT.title, cell: g => STATS_GUIDE[PERKS[g].stats] },
    { label: '중개·가측 인증 신청', cell: g => rank(g) < 1 ? '-' : g === 'plus' ? 'O (체험 제외)' : 'O' },
    { label: '중개/가측 탭 노출', cell: g => { const r = rank(g); return r >= 3 ? `골드 카드 · 최상단 + 소개 ${introShown(r)}자` : r === 2 ? `큰 프로필 + 소개 ${introShown(r)}자` : r === 1 ? '작은 프로필 · 하단' : '-'; } },
    { label: '중개·가측 광고 팝업', cell: g => rank(g) >= 3 ? 'O' : '-' },
    { label: '프로필 테두리', cell: g => RING_STYLE[g] || '-' },
    { label: '닉네임 칩', cell: g => NAME_STYLE[g] || '-' },
];

const same = (a: BenefitCell, b: BenefitCell) => JSON.stringify(a) === JSON.stringify(b);
// The benefits a paid grade adds: every row (the price aside) whose cell is not '-' and differs from 일반.
export function gradeExtras(g: GradeId) {
    return BENEFIT_ROWS.filter(r => !r.price && r.cell(g) !== '-' && !same(r.cell(g), r.cell('normal')));
}
// '1.5배', '12배' (one decimal below 10, rounded down, so a ratio never reads larger than it is).
const times = (x: number) => x >= 10 ? `${Math.floor(x)}배` : `${Math.floor(x * 10) / 10}배`;
// '일반 대비' (at most 3 lines), computed from PERKS: 끌올 충전, 하루 최대 맨 위 노출, 같은 글 끌올 간격.
export function vsNormal(g: GradeId): string[] {
    const k = PERKS[g], n = PERKS.normal, out: string[] = [];
    if (k.bumpRefillMinutes < n.bumpRefillMinutes) out.push(`끌올 충전 ${times(n.bumpRefillMinutes / k.bumpRefillMinutes)} 빠름 (${gapText(k.bumpRefillMinutes)}마다 · 일반 ${gapText(n.bumpRefillMinutes)}마다)`);
    if (dailyTops(k) > dailyTops(n)) out.push(`하루 최대 맨 위 노출 약 ${times(dailyTops(k) / dailyTops(n))} (약 ${dailyTops(k)}번 · 일반 약 ${dailyTops(n)}번)`);
    if (k.bumpGapMinutes < n.bumpGapMinutes) out.push(`같은 글 끌올 간격 ${times(n.bumpGapMinutes / k.bumpGapMinutes)} 짧음 (${gapText(k.bumpGapMinutes)} · 일반 ${gapText(n.bumpGapMinutes)})`);
    return out.slice(0, 3);
}
// '90분', '4시간', '30분' for the hooks.
const minutes = (m: number) => m % 60 === 0 ? `${m / 60}시간` : `${m}분`;
// The one-line hook leading each paid grade (owner requests 2026-10-01 and 2026-10-02), from PERKS.
export function gradeHook(g: PaidGrade) {
    const k = PERKS[g];
    if (g === 'plus') return `끌올 ${k.bumpMax}개 보관 · 자동 끌올 · 중개·가측 인증 신청`;
    if (g === 'premium') return `끌올 ${k.bumpMax}개 · ${minutes(k.bumpRefillMinutes)}마다 충전 · 중개/가측 큰 프로필`;
    return `골드 카드 최상단 · 끌올 ${k.bumpMax}개 · ${minutes(k.bumpRefillMinutes)}마다 충전 · 전체 글 자동 끌올`;
}
// The apply modal's line under the hook (WP61 change 3, with the owner's wallet numbers).
export function gradeLine(g: PaidGrade) {
    const k = PERKS[g];
    if (g === 'plus') return `끌올 ${k.bumpMax}개 · ${gapText(k.bumpRefillMinutes)}마다 충전 · 자동 끌올 ${k.autoBumpPosts}개`;
    if (g === 'premium') return `게시판 상단 광고 ${k.adSlots}개 · 자동 끌올 글 ${k.autoBumpPosts}개 · ${CHAT_AUTO_TEXT.first}`;
    return `전체 글 자동 끌올 · ${gapText(k.bumpRefillMinutes)}마다 끌올 · 홈 광고`;
}
// The profile's '다음 등급: 프리미엄 · 게시판 상단 광고 1개'.
export function nextBenefit(g: PaidGrade) {
    const k = PERKS[g];
    if (g === 'plus') return `자동 끌올 ${k.autoBumpPosts}개`;
    if (g === 'premium') return `게시판 상단 광고 ${k.adSlots}개`;
    return '전체 글 자동 끌올';
}
