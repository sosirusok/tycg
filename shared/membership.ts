// Verification badges and member grades. Both are granted by the manager after a
// chat-based application; there is no automatic payment or verification.

export type BadgeId = 'proxy' | 'identity' | 'credit' | 'broker' | 'appraiser';
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

// Display order is 본인 인증, 대리 인증, 신용인, 중개 인증, 가측 인증; sortBadges in the Worker follows it.
// 중개 인증 and 가측 인증 (WP66) are for 플러스 and up only (canProvide; never the 무료 체험), and 중개 인증 also
// needs 본인 인증: members who hold one are listed on the '중개/가측' tab.
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
    {
        id: 'broker',
        name: '중개 인증',
        short: '중개',
        icon: 'key',
        summary: '중개를 맡아 주는 회원',
        requirements: ['플러스 이상 등급 (무료 체험 제외)', '본인 인증', '중개·거래 경력 (캡처)'],
        template: '[중개 인증 신청]\n본인 인증: 있음 / 같이 신청\n중개·거래 경력: 캡처 첨부\n활동 카페/닉네임: ',
    },
    {
        id: 'appraiser',
        name: '가측 인증',
        short: '가측',
        icon: 'clipboard',
        summary: '계정 가격을 측정해 주는 회원',
        requirements: ['플러스 이상 등급 (무료 체험 제외)', '가측 경력 또는 시세 근거 (캡처)'],
        template: '[가측 인증 신청]\n가측 경력: 캡처 첨부\n활동 카페/닉네임: ',
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
// 광고 (WP53): adSlots of the member's open posts can be ads, and pauseDays is also the visit rule for ads).
// 조건 알림 (WP54): filterAlerts saved searches with any filter can send 알림 (0: none), and
// filterAlertEvents says what they tell: 'new' 새 글 only, 'all' 새 글 and 가격 내림.
// 자동 가격 내리기 (WP56): autoPricePosts 판매 posts (Infinity: all), the periods a member can pick
// (priceEveryHours; 플러스 is fixed at a day), pricePct whether '5%' can be the step, and autoDecline
// whether '최저가 미만 제시 자동 거절' is available.
// 채팅 자동화 (WP57): replyTemplates own quick replies (내 빠른 답장), templateVars whether they can hold
// {제목} {즉거가} {현젯}, firstReply '첫 문의 자동 안내' and awayReply '자리 비움' (both off by default).
export type Perks = {
    bumpMax: number; bumpRefillMinutes: number; bumpGapMinutes: number;
    autoBumpPosts: number; autoEveryMinutes: number; pauseDays: number; adSlots: number;
    filterAlerts: number; filterAlertEvents: 'new' | 'all';
    autoPricePosts: number; priceEveryHours: number[]; pricePct: boolean; autoDecline: boolean;
    replyTemplates: number; templateVars: boolean; firstReply: boolean; awayReply: boolean;
};

const PRICE_PERIODS = [12, 24, 48, 72];
const ELITE_PERKS: Perks = { bumpMax: 20, bumpRefillMinutes: 30, bumpGapMinutes: 20, autoBumpPosts: Infinity, autoEveryMinutes: 30, pauseDays: 7, adSlots: 3, filterAlerts: 20, filterAlertEvents: 'all',
    autoPricePosts: Infinity, priceEveryHours: PRICE_PERIODS, pricePct: true, autoDecline: true,
    replyTemplates: 20, templateVars: true, firstReply: true, awayReply: true };
export const PERKS: Record<GradeId, Perks> = {
    normal: { bumpMax: 3, bumpRefillMinutes: 360, bumpGapMinutes: 360, autoBumpPosts: 0, autoEveryMinutes: 0, pauseDays: 0, adSlots: 0, filterAlerts: 0, filterAlertEvents: 'new',
        autoPricePosts: 0, priceEveryHours: [], pricePct: false, autoDecline: false,
        replyTemplates: 0, templateVars: false, firstReply: false, awayReply: false },
    plus: { bumpMax: 5, bumpRefillMinutes: 240, bumpGapMinutes: 180, autoBumpPosts: 1, autoEveryMinutes: 240, pauseDays: 3, adSlots: 0, filterAlerts: 3, filterAlertEvents: 'new',
        autoPricePosts: 1, priceEveryHours: [24], pricePct: false, autoDecline: false,
        replyTemplates: 5, templateVars: false, firstReply: false, awayReply: false },
    premium: { bumpMax: 10, bumpRefillMinutes: 90, bumpGapMinutes: 60, autoBumpPosts: 5, autoEveryMinutes: 90, pauseDays: 3, adSlots: 1, filterAlerts: 10, filterAlertEvents: 'all',
        autoPricePosts: 5, priceEveryHours: PRICE_PERIODS, pricePct: true, autoDecline: false,
        replyTemplates: 10, templateVars: true, firstReply: true, awayReply: false },
    elite: ELITE_PERKS,
    // 관리자 has the same limits as 엘리트 and no extra permissions.
    admin: { ...ELITE_PERKS },
};
export const MANAGER_PERKS: Perks = { ...ELITE_PERKS, bumpMax: Infinity, bumpGapMinutes: 0, pauseDays: 0 };

export function perksOf(u: { role?: string | null; grade?: string | null }): Perks {
    if (u.role === 'manager') return MANAGER_PERKS;
    return PERKS[u.grade as GradeId] || PERKS.normal;
}

// Handling order by grade (1순위 first): 엘리트·관리자 1, 프리미엄 2, 플러스 3, 일반 and the 플러스 체험 4. The
// report ordering (WP60) is meant to reuse this helper.
export function gradePriority(grade: string | null | undefined, trial?: boolean | null) {
    if (gradeInfo(grade).rank >= 3) return 1;
    if (grade === 'premium') return 2;
    if (grade === 'plus' && !trial) return 3;
    return 4;
}

// 중개/가측 (WP66). Members holding 중개 인증 or 가측 인증 are listed on the '중개/가측' tab while canProvide holds,
// '받는 중' is on and they visited in the last PROVIDER_SEEN_DAYS days (and no block stands between them and
// the viewer). Blocks by grade: 엘리트 and 관리자 gold cards with up to 25자 of 소개, 프리미엄 64px profiles with
// 12자, 플러스 48px profiles with none (the stored 소개 is kept whole). Inside a block, members 접속 중 (seen in
// the last 10 minutes) come first, then everyone else, each group in a rotation seeded by the KST date and
// 3-hour block, so nobody can buy or game a place inside a grade. The site never takes or moves money.
export type ProviderType = 'broker' | 'appraiser';
export const PROVIDER_TYPES: ProviderType[] = ['broker', 'appraiser'];
export const isProviderType = (v: unknown): v is ProviderType => v === 'broker' || v === 'appraiser';
export const PROVIDER_INTRO_MAX = 25;
// The 소개 shown for a grade rank: 엘리트·관리자 25자, 프리미엄 12자, 플러스 none.
export const introShown = (rank: number) => rank >= 3 ? PROVIDER_INTRO_MAX : rank === 2 ? 12 : 0;
export const PROVIDER_ONLINE_MS = 10 * 60000;
export const PROVIDER_SEEN_DAYS = 14;
export const PROVIDER_ROTATE_MS = 3 * 3600000;
// 프리미엄 shows its first 60 in the rotation; 플러스 pages 120 at a time ('더 보기').
export const PREMIUM_SHOWN = 60, PLUS_PAGE = 120;
// Whether a member may hold 중개·가측 인증 and be listed: a 플러스 or higher grade from the manager (never a
// 무료 체험), not suspended, not withdrawn. The manager performs no 중개·가측 of their own.
export function canProvide(u: { role?: string | null; grade?: string | null; grade_trial?: boolean | null; suspended_until?: number | null; deleted?: boolean | null }, now = Date.now()) {
    if (u.role === 'manager' || u.deleted) return false;
    if (typeof u.suspended_until === 'number' && u.suspended_until > now) return false;
    return gradeInfo(u.grade).rank >= 1 && !u.grade_trial;
}
export const PROVIDER_TEXT = {
    tab: '중개/가측',
    names: { broker: '중개', appraiser: '가측' } as Record<ProviderType, string>,
    safety: '거래 대금은 사이트를 거치지 않습니다. 인증 표시와 후기를 보고 진행하세요.',
    empty: { broker: '아직 등록된 중개인이 없습니다.', appraiser: '아직 등록된 가측인이 없습니다.' } as Record<ProviderType, string>,
    apply: { broker: '중개 인증 신청', appraiser: '가측 인증 신청' } as Record<ProviderType, string>,
    notEligible: '중개·가측 인증은 플러스 이상 등급부터 신청할 수 있습니다. (무료 체험 제외)',
    grantNotEligible: '중개·가측 인증은 플러스 이상 등급 회원에게만 지급할 수 있습니다. (무료 체험 제외)',
    needIdentity: '중개 인증은 본인 인증이 있는 회원에게만 지급할 수 있습니다.',
    introBad: '소개에는 링크와 연락처를 넣을 수 없습니다.',
    introLong: `소개는 ${PROVIDER_INTRO_MAX}자까지입니다.`,
    noBadge: '중개·가측 인증이 있는 회원만 수정할 수 있습니다.',
    mine: '내 카드',
    hidden: '플러스 이상 등급일 때 목록에 보입니다.',
    off: '받는 중이 꺼져 있어 목록에 보이지 않습니다.',
    receiving: '받는 중',
    online: '접속 중',
    more: '더 보기',
    reviews: (n: number) => `후기 ${n}`,
    // The composer is filled (never sent) when a card opens the chat (user voice).
    draft: { broker: '[중개 문의]\n거래 글/계정: \n', appraiser: '[가측 문의]\n계정 정보: ' } as Record<ProviderType, string>,
    find: '중개인 찾기',
    appraise: '가측 받기',
    guide: '중개는 중개 인증 회원에게 맡기세요',
};
// 수익 홍보 (WP66): the owner's examples ('사례', never a promise). The two amounts and the 사례 come from
// settings ('sys:earn_broker', 'sys:earn_appraise', 'sys:earn_story', edited in manage 설정) with these defaults.
export type Earn = { broker: string; appraise: string; story: string };
export const EARN_DEFAULTS: Earn = { broker: '5만원 이상', appraise: '5만원 이상', story: '가측만으로 매달 10만원씩 버는 회원도 있습니다' };
export const EARN_MAX = 60;
export const EARN_TEXT = {
    title: '중개·가측으로 수익 올리기',
    from: '플러스부터 중개·가측 인증 신청 가능',
    reach: '등급이 높을수록 더 크게, 더 위에 노출 (엘리트는 골드 카드 + 광고 팝업)',
    example: (e: Earn) => `수익 예시: 중개 월 ${e.broker} · 가측 월 ${e.appraise}`,
    note: '운영진이 직접 들은 사례이며, 수익은 활동량에 따라 다릅니다.',
};

// 프로필 테두리 (WP66): the avatar ring of the member's public grade. A 무료 체험 shows 일반 (as its hidden chip),
// 관리자 the same gold as 엘리트 (관리자 = 엘리트), the manager black.
export type RingTier = 'basic' | 'bronze' | 'silver' | 'gold' | 'manager';
export function ringTier(grade?: string | null, trial?: boolean | null, role?: string | null): RingTier {
    if (role === 'manager') return 'manager';
    const rank = trial ? 0 : gradeInfo(grade).rank;
    return rank >= 3 ? 'gold' : rank === 2 ? 'silver' : rank === 1 ? 'bronze' : 'basic';
}
// The public grade rank (a 무료 체험 reads as 일반; the manager has none). The 등급 축하 창 shows once each time
// it rises above users.celebrated_rank.
export const publicRank = (u: { grade?: string | null; grade_trial?: boolean | null; role?: string | null }) => u.role === 'manager' || u.grade_trial ? 0 : gradeInfo(u.grade).rank;
// 등급 축하 창 (WP66): the strongest benefits the grade unlocks, from PERKS (4 to 6 lines).
export function celebrationLines(grade: string): string[] {
    const k = PERKS[gradeInfo(grade).id], rank = gradeInfo(grade).rank;
    const lines = [`끌올 ${k.bumpMax}개 보관 · ${gapText(k.bumpRefillMinutes)}마다 충전`];
    if (k.autoBumpPosts) lines.push(Number.isFinite(k.autoBumpPosts) ? `자동 끌올 글 ${k.autoBumpPosts}개` : '전체 글 자동 끌올');
    lines.push(rank >= 3 ? '중개/가측 탭 최상단 골드 카드' : rank === 2 ? '중개/가측 탭 큰 프로필 + 소개' : '중개·가측 인증 신청 가능');
    if (k.adSlots) lines.push(rank >= 3 ? `광고 ${k.adSlots}개 · 홈 엘리트 매물` : `게시판 상단 광고 ${k.adSlots}개`);
    if (k.filterAlerts) lines.push(`조건 알림 ${k.filterAlerts}개`);
    if (k.awayReply) lines.push('자리 비움 자동 응답');
    else if (k.firstReply) lines.push('첫 문의 자동 안내');
    else if (k.replyTemplates) lines.push(`내 빠른 답장 ${k.replyTemplates}개`);
    return lines.slice(0, 6);
}

// 제목 강조 (WP48), list surfaces only: 0 일반 (회색), 1 플러스 and the 무료 체험 (검정), 2 프리미엄 (굵게),
// 3 엘리트, 관리자 and the manager (굵게·파랑), from the author's current grade. Order is untouched.
export type TitleTier = 0 | 1 | 2 | 3;
export function titleTier(grade: string | null | undefined, role?: string | null): TitleTier {
    if (role === 'manager') return 3;
    const rank = gradeInfo(grade).rank;
    return (rank >= 3 ? 3 : rank) as TitleTier;
}
export const TITLE_STYLE_NAMES: Record<TitleTier, string> = { 0: '회색', 1: '검정', 2: '굵게', 3: '굵게·파랑' };
// 링크 미리보기 (WP48): 플러스 and up (the 무료 체험 too) and the manager, per post (posts.link_preview).
export const linkPreviewAllowed = (grade: string | null | undefined, role?: string | null) => titleTier(grade, role) >= 1;

// 광고 (WP53, copy.md). Ads are built from the member's own open posts and never change list order.
export const AD_TEXT = {
    label: '광고',
    box: '광고 매물',
    home: '엘리트 매물',
    similar: '비슷한 매물',
    pin: '광고 고정',
    unpin: '광고 빼기',
    header: (used: number, slots: number) => `광고 ${used}/${slots} · 자동`,
    views: (n: number) => `광고 유입 ${n}`,
    error: '광고는 프리미엄부터 가능합니다.',
    open: '거래중인 글만 광고할 수 있습니다.',
    hint: '광고는 본인 인증 필요',
    off: '광고 제외',
    noIdentity: '본인 인증 없음 · 광고 제외',
    // The member's nickname with a fixed noun (no particle to pick): '좀비사냥꾼 글 3개 더'.
    more: (name: string, n: number) => name ? `${name} 글 ${n}개 더` : `이 회원 글 ${n}개 더`,
    sortNote: '정렬은 등급과 관계없습니다.',
    orderNote: '광고는 목록 순서를 바꾸지 않습니다.',
};
// The ad slots of a grade rank (프리미엄 1, 엘리트 and 관리자 3); the manager has 3.
export const adSlotsOfRank = (rank: number, manager = false) => manager ? MANAGER_PERKS.adSlots : perksOfRank(rank).adSlots;

// 자동 끌올 (WP52) leaves this many 끌올 in the wallet for manual use: it runs only while 3 or more remain.
export const AUTO_RESERVE = 2;
// The benefits of a grade rank (0 일반 … 4 관리자); the tick reads ranks, not grade ids.
export function perksOfRank(rank: number): Perks {
    return PERKS[GRADES.find(g => g.rank === rank)?.id || 'normal'];
}
// 자동 끌올 wording (copy.md WP52). The status lines take the clock ('15:40') of the next run.
export const AUTO_TEXT = {
    off: '자동 끌올은 플러스부터 가능합니다.',
    full: (n: number) => `자동 끌올은 글 ${n}개까지입니다.`,
    sheet: (n: number) => `자동 끌올 ${n}/${n} · 뺄 글 선택`,
    moved: '자동 끌올 글 변경 완료',
    grant: '자동 끌올이 켜졌습니다. 설정은 내 거래의 자동화 탭에 있습니다.',
    running: (min: number, at: string) => `자동 끌올 ${gapText(min)}마다 1개 · 다음 ${at}`,
    idle: '자동 끌올 쉬는 중 · 모든 글이 1페이지에 있습니다',
    // Nothing to bump for another reason (the same-post gap, 새 글 우선, a report): no cause named.
    rest: (at: string) => `자동 끌올 쉬는 중 · 다음 ${at}`,
    busy: (at: string) => `게시판이 붐벼 자동 끌올을 미뤘습니다. (${at} 예정)`,
    reply: '답장하지 않은 채팅이 있어 자동 끌올을 멈췄습니다. 답장하면 다시 시작됩니다.',
    away: (days: number) => `${days}일 동안 접속하지 않아 자동 끌올을 멈췄습니다. 접속하면 다시 시작됩니다.`,
    stale: '7일 동안 변경이 없어 자동 끌올을 멈췄습니다.',
    staleCount: (n: number) => `자동 끌올 글 ${n}개 확인 필요`,
    trial: '체험 중 자동 끌올은 유료 등급 다음 순서입니다.',
    ready: (title: string) => `‘${title}’ 글 끌올 가능`,
    reserve: '자동 끌올은 한 번에 글 1개씩 · 2개는 직접 끌올용으로 남김',
    capped: '자동 끌올은 게시판 활동량에 맞춰 제한됩니다.',
};

// 자동 가격 내리기 (WP56, copy.md). The step is 1만원 (or 5% for 프리미엄 and up, cut to 1,000원), the drops
// happen at 20:00 KST (and 08:00 with the 12시간 period), at most DROP_MAX times per setup. A 제시 or a
// chat message from another member since the last look holds the next drop, for every grade.
export const DROP_STEPS = [10000];
export const DROP_PCTS = [5];
export const DROP_MAX = 10;
export const DROP_HOUR = 20;
export const DROP_TEXT = {
    title: '가격 내리기',
    off: '가격 내리기는 플러스부터 가능합니다.',
    full: (n: number) => `가격 내리기는 글 ${n}개까지입니다.`,
    priced: '즉거가가 있는 판매 글만 가격 내리기를 할 수 있습니다.',
    floor: '최저가는 즉거가보다 낮게 입력해 주세요.',
    period: '내림 주기를 확인해 주세요.',
    step: '내림 폭을 확인해 주세요.',
    declineOff: '최저가 미만 제시 자동 거절은 엘리트부터 가능합니다.',
    stopped: (title: string) => `‘${title}’ 글 현젯이 다음 가격 이상이라 가격 내리기를 멈췄습니다.`,
    done: (title: string) => `‘${title}’ 글이 최저가에 닿아 가격 내리기를 마쳤습니다.`,
    maxed: (title: string) => `‘${title}’ 글 가격 내리기를 ${DROP_MAX}번 해서 마쳤습니다.`,
    declined: (price: string) => `제시 자동 거절 · ${price}`,
    hold: '문의나 제시가 오면 내리지 않고 기다립니다.',
    all: '판매 글 전체',
    decline: '최저가 미만 제시 자동 거절',
    floorLabel: '최저가',
    next: (when: string, price: string) => `다음 내림 ${when} · ${price}`,
    allDone: (n: number) => `가격 내리기 ${n}개 설정 완료`,
};
// 채팅 자동화 (WP57, copy.md). The prefills are in user voice (the member's own words, sent as theirs).
export const CHAT_AUTO_TEXT = {
    label: '자동 응답',
    templatesOff: '내 빠른 답장은 플러스부터 가능합니다.',
    templatesMax: (n: number) => `빠른 답장은 ${n}개까지입니다.`,
    templateLong: '빠른 답장은 100자까지입니다.',
    firstOff: '첫 문의 자동 안내는 프리미엄부터 가능합니다.',
    awayOff: '자리 비움 응답은 엘리트부터 가능합니다.',
    textLong: '자동 응답 문구는 300자까지입니다.',
    hours: '자리 비움 시간을 확인해 주세요.',
    first: '첫 문의 자동 안내',
    away: '자리 비움',
    awayNow: '지금 자리 비움',
    awayUntil: (at: string) => `지금 자리 비움 · ${at}까지`,
    // copy-lint-ignore-next-line
    firstDefault: '문의 감사합니다. {제목} 즉거가 {즉거가}입니다. 전번·계좌 인증 가능합니다.',
    // copy-lint-ignore-next-line
    awayDefault: '지금은 자리를 비웠습니다. 확인 후 답장 드립니다.',
};
// Own quick replies hold at most this many characters; the two auto texts at most AUTO_REPLY_MAX.
export const TEMPLATE_MAX = 100, AUTO_REPLY_MAX = 300;
// 자리 비움 by schedule: from 02:00 to 10:00 KST unless the member picks other hours.
export const AWAY_FROM = 2, AWAY_TO = 10;
// '지금 자리 비움' lasts this long, then turns itself off.
export const AWAY_NOW_MS = 12 * 3600000;
// The 자리 비움 window running at `now` (its start, the key of 'one reply per window'), or null.
// '지금 자리 비움' (until) wins over the schedule; the schedule is in whole KST hours and may wrap midnight.
export function awayWindow(a: { away_on?: number | boolean | null; away_from?: number | null; away_to?: number | null; away_until?: number | null }, now: number): number | null {
    if (a.away_until && a.away_until > now) return a.away_until - AWAY_NOW_MS;
    if (!a.away_on) return null;
    const from = a.away_from ?? AWAY_FROM, to = a.away_to ?? AWAY_TO;
    if (from === to) return null;
    const h = new Date(now + KST).getUTCHours();
    if (from < to ? h < from || h >= to : h < from && h >= to) return null;
    const start = kstDayStart(now) + from * 3600000;
    return start > now ? start - 86400000 : start;
}

// '1만원', '5%'.
export const dropStepText = (step: number | null, pct: number | null) => pct ? `${pct}%` : `${(step || DROP_STEPS[0]) / 10000}만원`;
// '12시간', '하루', '2일', '3일'.
export const dropEveryText = (h: number) => h === 24 ? '하루' : h % 24 === 0 ? `${h / 24}일` : `${h}시간`;
// The next price: the step (or pct, cut to 1,000원 and at least 1,000원) below the price, never under the floor.
export function nextDropPrice(price: number, floor: number, step: number | null, pct: number | null) {
    const cut = pct ? Math.max(1000, Math.floor(price * pct / 100 / 1000) * 1000) : (step || DROP_STEPS[0]);
    return Math.max(floor, price - cut);
}
// The 최저가 prefilled (and used by '판매 글 전체'): 80% of the price, rounded down to 만원.
export const defaultDropFloor = (price: number) => Math.floor(price * 0.8 / 10000) * 10000;
// The first drop time at or after t: 20:00 KST, or 08:00 and 20:00 KST with the 12-hour period.
export function dropSlotAt(t: number, everyH: number) {
    const slot = everyH === 12 ? 12 * 3600000 : 86400000, off = ((DROP_HOUR - 9) * 3600000) % slot;
    return Math.ceil((t - off) / slot) * slot + off;
}
// The Guide cell: '-', '판매 글 1개 · 하루 1번', '5개', '전체'.
export function dropGuideText(perks: Perks) {
    if (!perks.autoPricePosts) return '-';
    if (!Number.isFinite(perks.autoPricePosts)) return '전체';
    return perks.priceEveryHours.length === 1 ? `판매 글 ${perks.autoPricePosts}개 · ${dropEveryText(perks.priceEveryHours[0])} 1번` : `${perks.autoPricePosts}개`;
}

// 새 글 알림 (WP54): 키워드·게시판 알림 and 판매자 구독 for every grade, 조건 알림 for 플러스 and up.
export const ALERT_TEXT = {
    keywordButton: '이 키워드 알림 받기',
    boardBell: '새 글 알림',
    on: '알림 설정 완료',
    off: '알림 해제',
    keywordMax: (n: number) => `키워드 알림은 ${n}개까지입니다.`,
    filterOff: '조건 알림은 플러스부터 가능합니다.',
    // A saved search with filters, for a member below 플러스 (the switch stays off).
    filterLocked: '조건 알림 · 플러스부터',
    filterMax: (n: number) => `조건 알림은 ${n}개까지입니다.`,
    filterCount: (used: number, max: number) => `조건 알림 ${used}/${max}`,
    follow: '구독',
    following: '구독 중',
    followed: '구독 완료',
    unfollowed: '구독 해제',
    allow: '구독 허용',
    followMax: (n: number) => `구독은 ${n}명까지입니다.`,
    followClosed: '구독을 받지 않는 회원입니다.',
    manage: '구독 관리',
    // The 알림 page's button and modal with every saved search and its switch (every grade).
    searches: '검색 알림',
    noFollows: '구독한 회원이 없습니다.',
    keyword: (name: string) => `‘${name}’ 새 글`,
    filter: (name: string) => `‘${name}’ 조건 새 글`,
    filterDrop: (name: string) => `‘${name}’ 조건 가격 내림`,
    member: (nickname: string) => `${nickname} 새 글`,
    count: (n: number) => ` ${n >= 99 ? '99+' : n}개`,
};
// The 조건 알림 cell of the guide table: '-', '3개 (새 글)', '10개 (새 글 · 가격 내림)'.
export function filterAlertText(perks: Perks) {
    if (!perks.filterAlerts) return '-';
    return `${Number.isFinite(perks.filterAlerts) ? perks.filterAlerts + '개' : '무제한'} (${perks.filterAlertEvents === 'all' ? '새 글 · 가격 내림' : '새 글'})`;
}

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
// append a row once their feature ships (자동 끌올; 제목·글자색·링크 미리보기 joined with WP48 and WP49).
export type TrialRow = { icon: string; title: string; text: string };
export const TRIAL_ROWS: TrialRow[] = [
    { icon: 'megaphone', title: `끌올 ${PERKS.plus.bumpMax}개 · ${gapText(PERKS.plus.bumpRefillMinutes)}마다 충전`, text: `같은 글 ${gapText(PERKS.plus.bumpGapMinutes)}마다 끌올 (일반 ${gapText(PERKS.normal.bumpGapMinutes)})` },
    // 자동 끌올 (WP52): on from the first post, one post every autoEveryMinutes (copy.md order: second).
    { icon: 'alarm-clock', title: `자동 끌올 글 ${PERKS.plus.autoBumpPosts}개`, text: `${gapText(PERKS.plus.autoEveryMinutes)}마다 1번 · 첫 글부터 바로 켜짐` },
    // 제목 강조 검정 (WP48), the 플러스 글자 꾸미기 with 글자색 (WP49) and 링크 미리보기 (WP48).
    { icon: 'artist-palette', title: '진한 제목 · 글자색', text: '링크 미리보기 포함' },
];

// 알림함 rows for the trial (WP50), written by the daily cleanup: one in the last 24 hours ('10월 9일
// 14:32'), one after the end. The automation settings stay when the trial ends (WP52), and a 플러스
// grant turns them on again.
export const TRIAL_KEEPS = '설정은 그대로 남고, 플러스를 신청하면 바로 다시 켜집니다.';
export const trialAlertSoon = (when: string) => `플러스 무료 체험이 ${when}에 끝납니다. ${TRIAL_KEEPS}`;
export const TRIAL_ALERT_ENDED = '플러스 무료 체험이 끝났습니다.';

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
