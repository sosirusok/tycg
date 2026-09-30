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
    { id: 'elite', name: '엘리트', rank: 3, icon: 'crown', plans: [{ id: 'permanent', label: '영구', price: 100000 }, { id: '6m', label: '6개월', price: 60000, months: 6 }], note: '영구 또는 6개월' },
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

export const APPLICATION_STATUS_NAMES: Record<ApplicationStatus, string> = { pending: '확인 중', approved: '지급 완료', rejected: '반려', cancelled: '취소' };
