// Verification badges and member grades. Both are granted by the manager after a
// chat-based application; there is no automatic payment or verification.

export type BadgeId = 'proxy' | 'identity' | 'credit';
export type GradeId = 'normal' | 'plus' | 'premium' | 'elite' | 'admin';
export type PlanId = 'permanent' | '6m';

export type BadgeInfo = {
    id: BadgeId;
    name: string;
    // Name for compact name lines; it is shown with the check mark, never dropped.
    short: string;
    icon: string;
    summary: string;
    requirements: string[];
    template: string;
};

// Display order is 본인 인증, 대리 인증, 신용인; sortBadges in the Worker follows it.
export const BADGES: BadgeInfo[] = [
    {
        id: 'identity',
        name: '본인 인증',
        short: '본인',
        icon: 'identification-card',
        summary: '전번, 계좌 확인 후 지급',
        requirements: ['전화번호', '본인 명의 계좌'],
        template: '[본인 인증 신청]\n전화번호: \n은행: \n계좌번호: \n예금주: ',
    },
    {
        id: 'proxy',
        name: '대리 인증',
        short: '대리',
        icon: 'trophy',
        summary: '대리(진행) 글쓰기',
        requirements: ['본인 인증', '대리 거래내역', '기타 인증'],
        template: '[대리 인증 신청]\n본인 인증: 있음 / 같이 신청\n대리 거래내역: 캡처 첨부\n기타 인증: ',
    },
    {
        id: 'credit',
        name: '신용인',
        short: '신용인',
        icon: 'handshake',
        summary: '거래내역, 거래 금액 보고 지급',
        requirements: ['거래내역', '누적 거래 금액', '활동 카페/닉네임'],
        template: '[신용인 신청]\n거래내역: 캡처 첨부\n누적 거래 금액: \n활동 카페/닉네임: ',
    },
];

export type GradePlan = { id: PlanId; label: string; price: number; months?: number };
export type GradeInfo = { id: GradeId; name: string; rank: number; icon: string; plans: GradePlan[]; note: string };

export const GRADES: GradeInfo[] = [
    { id: 'normal', name: '일반', rank: 0, icon: 'seedling', plans: [], note: '기본 등급' },
    { id: 'plus', name: '플러스', rank: 1, icon: 'star', plans: [{ id: 'permanent', label: '영구', price: 30000 }], note: '영구 구매만 가능' },
    { id: 'premium', name: '프리미엄', rank: 2, icon: 'gem-stone', plans: [{ id: 'permanent', label: '영구', price: 50000 }, { id: '6m', label: '6개월', price: 30000, months: 6 }], note: '영구 또는 6개월' },
    { id: 'elite', name: '엘리트', rank: 3, icon: 'crown', plans: [{ id: 'permanent', label: '영구', price: 150000 }, { id: '6m', label: '6개월', price: 60000, months: 6 }], note: '영구 또는 6개월' },
    { id: 'admin', name: '관리자', rank: 4, icon: 'shield', plans: [], note: '매니저 지정' },
];

export const PURCHASABLE_GRADES: GradeId[] = ['plus', 'premium', 'elite'];

export function badgeInfo(id: string) { return BADGES.find(b => b.id === id); }
export function gradeInfo(id: string | null | undefined) { return GRADES.find(g => g.id === id) || GRADES[0]; }
export function planInfo(grade: string, plan: string) { return gradeInfo(grade).plans.find(p => p.id === plan); }
export function isBadge(id: unknown): id is BadgeId { return typeof id === 'string' && BADGES.some(b => b.id === id); }
export function isGrade(id: unknown): id is GradeId { return typeof id === 'string' && GRADES.some(g => g.id === id); }

// Calendar months from the given time on the Korean (UTC+9) calendar, clamped to the
// last day of the month, so the end date matches the date shown to members.
const KST = 9 * 3600000;
export function addMonths(from: number, months: number) {
    const d = new Date(from + KST);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.getTime() - KST;
}

export type ApplicationKind = 'badge' | 'grade';
export type ApplicationStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type Application = {
    id: string;
    user_id: string;
    kind: ApplicationKind;
    target: string;
    plan: PlanId | null;
    status: ApplicationStatus;
    conversation_id: string | null;
    note: string;
    decided_at: number | null;
    created_at: number;
    nickname?: string;
};

export function applicationTitle(a: Pick<Application, 'kind' | 'target' | 'plan'>) {
    if (a.kind === 'badge') return (badgeInfo(a.target)?.name || a.target) + ' 신청';
    const plan = a.plan ? planInfo(a.target, a.plan) : undefined;
    return `${gradeInfo(a.target).name} 등급 신청${plan ? ` · ${plan.label} ${plan.price.toLocaleString('ko-KR')}원` : ''}`;
}

export function applicationTemplate(kind: ApplicationKind, target: string, plan?: string | null) {
    if (kind === 'badge') return badgeInfo(target)?.template || '';
    const p = plan ? planInfo(target, plan) : undefined;
    return `[${gradeInfo(target).name} 등급 신청]\n기간: ${p ? `${p.label} (${p.price.toLocaleString('ko-KR')}원)` : ''}\n입금자명: \n입금 일시: `;
}

export const APPLICATION_STATUS_NAMES: Record<ApplicationStatus, string> = { pending: '대기', approved: '지급 완료', rejected: '반려', cancelled: '취소' };

// Cafe basics: the same for every member (the free 일반 grade included). They are only anti-flood
// ceilings, never a reason to buy a grade. The manager has no open-post or daily-post ceiling.
export type SiteRules = {
    photosPerPost: number; openPosts: number; postsPerDay: number; uploadsPer10Min: number; uploadsPerDay: number;
    freshPerDay: number; keywordAlerts: number; follows: number; savedSearches: number; commentsPer10Min: number; commentsPerDay: number;
};
export const SITE_RULES: SiteRules = {
    photosPerPost: 100, openPosts: 100, postsPerDay: 30, uploadsPer10Min: 120, uploadsPerDay: 300,
    freshPerDay: 3, keywordAlerts: 10, follows: 100, savedSearches: 20, commentsPer10Min: 20, commentsPerDay: 200,
};
export function rulesOf(u: { role?: string | null }): SiteRules {
    return u.role === 'manager' ? { ...SITE_RULES, openPosts: Infinity, postsPerDay: Infinity } : SITE_RULES;
}

// Grade benefits (see the Guide table and the apply modal, which render from this object).
// The Worker enforces them; the manager account has no caps.
// 끌올 지갑: up to bumpMax 끌올, one more every bumpRefillMinutes, and the same post again after
// bumpGapMinutes. Manual 끌올 spends the wallet (owner override of 2026-10-01: 3/5/10/20, 6h/4h/90분/30분,
// gap 6h/3h/1h/20분). The automation fields are the tier-table values for the packages that ship them
// (자동 끌올: autoBumpPosts posts, one every autoEveryMinutes, paused after pauseDays without a visit;
// 광고 매물: adSlots). Nothing reads them yet. boardSlots is the round-2 게시판 상단 노출, which the 광고
// package (WP53) replaces with adSlots.
// serviceCoupons (WP65): 무료 중개·가측 per KST calendar month, shared between the two services
// (Infinity = 무제한). A 플러스 무료 체험 gets none (serviceCouponsOf).
export type Perks = {
    bumpMax: number; bumpRefillMinutes: number; bumpGapMinutes: number;
    autoBumpPosts: number; autoEveryMinutes: number; pauseDays: number; adSlots: number;
    boardSlots: number; homeShelf: boolean; serviceCoupons: number;
};

const ELITE_PERKS: Perks = { bumpMax: 20, bumpRefillMinutes: 30, bumpGapMinutes: 20, autoBumpPosts: Infinity, autoEveryMinutes: 30, pauseDays: 7, adSlots: 3, boardSlots: 3, homeShelf: true, serviceCoupons: Infinity };
export const PERKS: Record<GradeId, Perks> = {
    normal: { bumpMax: 3, bumpRefillMinutes: 360, bumpGapMinutes: 360, autoBumpPosts: 0, autoEveryMinutes: 0, pauseDays: 0, adSlots: 0, boardSlots: 0, homeShelf: false, serviceCoupons: 0 },
    plus: { bumpMax: 5, bumpRefillMinutes: 240, bumpGapMinutes: 180, autoBumpPosts: 1, autoEveryMinutes: 240, pauseDays: 3, adSlots: 0, boardSlots: 0, homeShelf: false, serviceCoupons: 1 },
    premium: { bumpMax: 10, bumpRefillMinutes: 90, bumpGapMinutes: 60, autoBumpPosts: 5, autoEveryMinutes: 90, pauseDays: 3, adSlots: 1, boardSlots: 1, homeShelf: false, serviceCoupons: 5 },
    elite: ELITE_PERKS,
    // 관리자 has the same limits as 엘리트 and no extra permissions.
    admin: { ...ELITE_PERKS },
};
export const MANAGER_PERKS: Perks = { ...ELITE_PERKS, bumpMax: Infinity, bumpGapMinutes: 0, pauseDays: 0 };

export function perksOf(u: { role?: string | null; grade?: string | null }): Perks {
    if (u.role === 'manager') return MANAGER_PERKS;
    return PERKS[u.grade as GradeId] || PERKS.normal;
}

// 중개·가측 (WP65): manual services the manager performs from the manager chat. 중개 = the manager
// checks the account and the handover between two members; 가측 = the manager appraises an account.
// The site never takes, holds or moves money.
export type ServiceKind = 'broker' | 'appraise';
export const SERVICE_NAMES: Record<ServiceKind, string> = { broker: '중개', appraise: '가측' };
// The member's monthly 무료 중개·가측: none for the manager (who performs them) and none during a
// 플러스 무료 체험 (free manual work per throwaway account); Infinity = 무제한.
export function serviceCouponsOf(u: { role?: string | null; grade?: string | null; grade_trial?: boolean | null }): number {
    if (u.role === 'manager' || u.grade_trial) return 0;
    return (PERKS[u.grade as GradeId] || PERKS.normal).serviceCoupons;
}
// GET services/me and me/usage: limit and left are null for 무제한; resetsAt is the next 1st 00:00 KST.
export type Coupons = { limit: number | null; used: number; left: number | null; resetsAt: number };
// The KST calendar month 'YYYY-MM' (the coupon count's key, so it resets on the 1st with no cron),
// and the start of the next one.
export const kstMonth = (t: number) => new Date(t + KST).toISOString().slice(0, 7);
export function nextKstMonthStart(t: number) {
    const d = new Date(t + KST);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - KST;
}
// Handling order (1순위 first) for 중개·가측 requests: 엘리트·관리자 1, 프리미엄 2, 플러스 3, 일반 and the
// 플러스 체험 4. The report ordering (WP60) is meant to reuse this helper when it ships.
export function gradePriority(grade: string | null | undefined, trial?: boolean | null) {
    if (grade === 'elite' || grade === 'admin') return 1;
    if (grade === 'premium') return 2;
    if (grade === 'plus' && !trial) return 3;
    return 4;
}

// 자동 끌올 (a later package) leaves this many 끌올 in the wallet for manual use.
export const AUTO_RESERVE = 2;

// '30분', '1시간', '1시간 30분'.
export function gapText(min: number) {
    const h = Math.floor(min / 60), m = min % 60;
    return [h ? `${h}시간` : '', m ? `${m}분` : ''].filter(Boolean).join(' ') || '0분';
}

// The wallet at `now` from the stored columns (users.bump_tokens, users.bump_at): one 끌올 per full
// refill interval since bump_at, capped at bumpMax. A lower grade's cap applies on the next read.
// nextRefillAt is null while the wallet is full (or unlimited).
export function walletOf(tokens: number, at: number, perks: Perks, now: number): { tokens: number; nextRefillAt: number | null } {
    if (!Number.isFinite(perks.bumpMax)) return { tokens: Infinity, nextRefillAt: null };
    const R = perks.bumpRefillMinutes * 60000, steps = Math.max(0, Math.floor((now - at) / R));
    const have = Math.min(perks.bumpMax, tokens + steps);
    return { tokens: have, nextRefillAt: have >= perks.bumpMax ? null : at + (steps + 1) * R };
}

// Start of the current day on the Korean calendar (daily caps reset at KST midnight).
export const kstDayStart = (now: number) => now - ((now + 9 * 3600000) % 86400000);

// Same-title check: letters and digits only, so '28 챌린저 계정 팝니다' and '28챌린저  계정팝니다!' match.
export const titleKey = (t: string) => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// 플러스 7일 무료 체험 (WP41): a real 플러스 row with source 'trial' that ends exactly 7 days after
// sign-up. Every 플러스 usage benefit applies; the public chip is left out while it lasts.
export const TRIAL_DAYS = 7;
export const TRIAL_MS = TRIAL_DAYS * 86400000;
// The member's own trial state (GET auth/me and the sign-up response).
export type TrialState = { endsAt: number | null; popup: boolean; ended: boolean; capped: boolean };

// The popup's benefit rows, from the 플러스 limits the Worker enforces right now. Later packages
// append a row once their feature ships (자동 끌올, 제목·글자색·링크 미리보기).
export type TrialRow = { icon: string; title: string; text: string };
export const TRIAL_ROWS: TrialRow[] = [
    { icon: 'megaphone', title: `끌올 ${PERKS.plus.bumpMax}개 · ${gapText(PERKS.plus.bumpRefillMinutes)}마다 충전`, text: `같은 글 ${gapText(PERKS.plus.bumpGapMinutes)}마다 끌올 (일반 ${gapText(PERKS.normal.bumpGapMinutes)})` },
];

const kstParts = (t: number) => {
    const d = new Date(t + KST);
    return { month: d.getUTCMonth() + 1, day: d.getUTCDate(), time: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` };
};
// '10월 8일 18:40' on the Korean calendar.
export function kstDateTime(t: number) {
    const p = kstParts(t);
    return `${p.month}월 ${p.day}일 ${p.time}`;
}
// The KST calendar date as 'YYYY-MM-DD' (daily keys such as the one-modal-a-day rule).
export const kstDate = (t: number) => new Date(t + KST).toISOString().slice(0, 10);

// The member's own status line: '플러스 체험 · 10월 8일까지', and in the last 24 hours
// '플러스 체험 · 내일 18:40 종료' or '플러스 체험 · 오늘 18:40 종료'.
export function trialStatus(endsAt: number, now = Date.now()) {
    const p = kstParts(endsAt);
    if (endsAt - now > 86400000) return `플러스 체험 · ${p.month}월 ${p.day}일까지`;
    return `플러스 체험 · ${kstDayStart(endsAt) === kstDayStart(now) ? '오늘' : '내일'} ${p.time} 종료`;
}
