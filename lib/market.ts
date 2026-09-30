export const TIERS = [{ id: 'iron', name: '아이언', min: 25, color: '#707982' }, { id: 'bronze', name: '브론즈', min: 6, color: '#a06c45' }, { id: 'silver', name: '실버', min: 6, color: '#7a899c' }, { id: 'gold', name: '골드', min: 6, color: '#b38a22' }, { id: 'platinum', name: '플래티넘', min: 6, color: '#278e8d' }, { id: 'diamond', name: '다이아몬드', min: 6, color: '#4789c0' }, { id: 'master', name: '마스터', min: 17, color: '#8060b5' }, { id: 'challenger', name: '챌린저', min: 6, color: '#b88736' }, { id: 'champion', name: '챔피언', min: 8, color: '#b95d60' }] as const;
export type SeasonTag = {
    tier: string;
    season: number;
};
export type User = {
    id: string;
    nickname: string;
    role: string;
    bio: string;
    created_at: number;
    username?: string;
    postCount?: number;
};
export type TradeKind = 'buy' | 'sell' | 'exchange' | 'proxy_request' | 'proxy_offer';
export const TRADE_KINDS: TradeKind[] = ['buy', 'sell', 'exchange', 'proxy_request', 'proxy_offer'];
export type PriceHistoryEntry = { price: number; changed_at: number };
export type Post = {
    id: number;
    author_id: string;
    nickname: string;
    role: string;
    kind: TradeKind;
    title: string;
    body: string;
    price: number | null;
    price_history?: PriceHistoryEntry[];
    status: string;
    created_at: number;
    updated_at: number;
    tags: SeasonTag[];
    category: string;
    price_mode: string;
    accepts_offers: number;
    details: Record<string, string>;
    images: string[];
    favorite?: boolean;
    hidden: number;
};
export function validTags(input: unknown): input is SeasonTag[] { return Array.isArray(input) && input.length <= 230 && input.every(t => t && typeof t === 'object' && Number.isInteger(t.season) && TIERS.some(v => v.id === t.tier && t.season >= v.min && t.season <= 32)); }
export function tagName(t: SeasonTag) { return `${t.season}시즌 ${TIERS.find(v => v.id === t.tier)?.name || t.tier}`; }
export function dateText(t: number) { return new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit' }); }
export function priceText(p: number | null) { return p === null ? '가격 협의' : `${p.toLocaleString('ko-KR')}원`; }
export const CATEGORIES = [
    { id: 'account', name: '계정', description: '계정 거래' },
    { id: 'clan', name: '클랜', description: '클랜 거래' },
    { id: 'goods_coupon', name: '굿즈 및 쿠폰', description: '굿즈 및 쿠폰 거래' },
    { id: 'other', name: '기타', description: '그 외 거래' },
    { id: 'ladder', name: '래더', description: '시즌과 목표 티어' },
    { id: 'story', name: '스토리 및 재화', description: '콘텐츠와 작업 범위' },
    { id: 'event', name: '이벤트', description: '이벤트와 목표' },
];
export const KIND_NAMES: Record<string, string> = { buy: '구매', sell: '판매', exchange: '교환', proxy_request: '대리(구함)', proxy_offer: '대리(진행)' };
export const STATUS_NAMES: Record<string, string> = { open: '거래중', reserved: '협의중', closed: '거래완료' };
export const PRICE_MODES: Record<string, string> = { fixed: '즉거가', offer: '가격 제시', negotiate: '가격 협의' };
export function isProxyKind(kind: string) { return kind === 'proxy_request' || kind === 'proxy_offer'; }
export function categoriesForKind(kind: string) {
    const ids = isProxyKind(kind) ? ['ladder', 'story', 'event'] : kind === 'exchange' ? ['account', 'clan'] : ['account', 'clan', 'goods_coupon', 'other'];
    return CATEGORIES.filter(category => ids.includes(category.id));
}
export function normalizeTrade(kind: string, category: string): { kind: TradeKind; category: string } {
    if (category === 'service') return { kind: kind === 'buy' || kind === 'proxy_request' ? 'proxy_request' : 'proxy_offer', category: 'ladder' };
    const normalized = category === 'coupon' || category === 'goods' ? 'goods_coupon' : category === 'duo' ? 'other' : category;
    return { kind: TRADE_KINDS.includes(kind as TradeKind) ? kind as TradeKind : 'sell', category: normalized };
}
export function exchangeLabel(category: string, wantedCategory?: string) {
    const name = (id?: string) => CATEGORIES.find(c => c.id === id)?.name || '계정';
    return `${name(category)}에서 ${name(wantedCategory)} 구함`;
}
export type DetailField = { id: string; label: string; type?: string; placeholder?: string };
const PROXY_FIELDS: DetailField[] = [
    { id: 'mode', label: '모드 / 콘텐츠' }, { id: 'current', label: '현재 상태' },
    { id: 'target', label: '목표 / 작업 범위' }, { id: 'schedule', label: '가능 시간 / 희망 일정' },
    { id: 'duration', label: '예상 소요시간' }, { id: 'priceUnit', label: '가격 기준', placeholder: '예: 1회, 전체 작업' },
    { id: 'conditions', label: '진행 조건' },
];
export const DETAIL_FIELDS: Record<string, DetailField[]> = {
    account: [
        { id: 'level', label: '계정 레벨', type: 'number' }, { id: 'labLevel', label: '연구실 레벨', type: 'number' },
        { id: 'humanSkins', label: '인간 스킨 수', type: 'number' }, { id: 'zombieSkins', label: '좀비 스킨 수', type: 'number' },
        { id: 'emblems', label: '주요 엠블럼' }, { id: 'gas', label: '가스', type: 'number' }, { id: 'minerals', label: '미네랄', type: 'number' },
        { id: 'rides', label: '라이드 / 액세서리' }, { id: 'progress', label: '콘텐츠 진행도' },
        { id: 'joined', label: '게임 가입 시기', placeholder: '예: 2018년' }, { id: 'accountType', label: '연동 / 포함 범위' },
        { id: 'ownerCount', label: '대주 수', type: 'number' }, { id: 'recordStatus', label: '전적' },
    ],
    clan: [{ id: 'clanName', label: '클랜 이름' }, { id: 'clanLevel', label: '클랜 레벨', type: 'number' }, { id: 'clanMembers', label: '클랜원 수', type: 'number' }, { id: 'clanCapacity', label: '최대 인원', type: 'number' }],
    goods_coupon: [{ id: 'goodsName', label: '굿즈 이름' }, { id: 'condition', label: '상품 상태' }, { id: 'delivery', label: '거래 방법' }, { id: 'couponName', label: '쿠폰 이름' }, { id: 'expires', label: '유효기간', type: 'date' }, { id: 'quantity', label: '수량', type: 'number' }, { id: 'used', label: '사용 여부' }],
    other: [], ladder: PROXY_FIELDS, story: PROXY_FIELDS, event: PROXY_FIELDS,
};
export function listingPrice(p: Pick<Post, 'price' | 'price_mode' | 'kind'>) {
    if (p.kind === 'exchange') return '교환';
    if (p.price === null) return p.kind === 'buy' ? '예산 협의' : p.price_mode === 'offer' ? '가격 제시' : '가격 협의';
    return p.kind === 'buy' ? `MAX ${priceText(p.price)}` : priceText(p.price);
}
export function relativeTime(t: number) { const n = Date.now() - t; return n < 60000 ? '방금 전' : n < 3600000 ? Math.floor(n / 60000) + '분 전' : n < 86400000 ? Math.floor(n / 3600000) + '시간 전' : n < 604800000 ? Math.floor(n / 86400000) + '일 전' : dateText(t); }

// Owner-requested options. Research scope and source limits: docs/market-research-v8.md.
// These are not a measured popularity ranking.
export const SKIN_OPTIONS = ['유루미', '아람', '송편좀비', '유니콘 좀비', '악몽의 주인', '서큐 날개', '뱀파이어 정동석', '구미호 케빈'] as const;
// Accept historic stored values without offering them as preferred choices in new forms.
export const LEGACY_SKELETON = '해골 기사단장 남동진';
export const FULL_SET = '해골 기사단장 남동진 풀세트';
export const SKIN_TAGS: readonly string[] = [...SKIN_OPTIONS, LEGACY_SKELETON, '파자마 고나래', '펭귄 맹규리', FULL_SET];
export const NICK_RANKS = ['R', 'S', 'A', 'B', '잡'] as const;
export const ACCOUNT_CHOICES: Record<string, { label: string; options: readonly string[] }> = {
    nicknameRank: { label: '닉 등급 (작성자 선택)', options: NICK_RANKS },
    recordStatus: { label: '전적', options: ['무전적', '전적 있음'] },
    integrated: { label: '통합계정 여부', options: ['통합', '미통합', '모름'] },
    passwordChange: { label: '비밀번호 변경', options: ['가능', '불가', '확인 필요'] },
    phoneChange: { label: '전화번호 변경', options: ['가능', '불가', '확인 필요'] },
};
export const ACCOUNT_CORE = ['nicknameChars', 'nicknameRank', 'ownerCount', 'recordStatus', 'gas', 'minerals', 'integrated', 'passwordChange', 'phoneChange'];
export const RECORD_PREFERENCES = ['무전적', '전적 있어도 괜찮음'] as const;
export const BUYER_DETAIL_FIELDS: DetailField[] = [
    { id: 'maxOwners', label: '허용 대주 수', type: 'number' }, { id: 'recordPreference', label: '전적 조건' },
    { id: 'nicknameCharsMin', label: '닉네임 최소 글자 수', type: 'number' }, { id: 'nicknameCharsMax', label: '닉네임 최대 글자 수', type: 'number' },
    { id: 'nicknameRanks', label: '원하는 닉 등급' }, { id: 'skinTags', label: '우대 스킨' },
];
DETAIL_FIELDS.account.push(
    { id: 'nicknameChars', label: '게임 닉 글자 수', type: 'number' },
    ...Object.entries(ACCOUNT_CHOICES).map(([id, f]) => ({ id, label: f.label })),
    { id: 'skinTags', label: '선택한 스킨' },
);
export function skinTags(raw?: string): string[] {
    try { const tags: unknown = JSON.parse(raw || '[]'); return Array.isArray(tags) ? [...new Set(tags.filter((v): v is string => typeof v === 'string' && SKIN_TAGS.includes(v)))] : []; }
    catch { return []; }
}
export function accountSummary(d: Record<string, string>) {
    const wantedRanks: string[] = (() => { try { const ranks: unknown = JSON.parse(d.nicknameRanks || '[]'); return Array.isArray(ranks) ? ranks.filter((rank): rank is string => typeof rank === 'string' && (NICK_RANKS as readonly string[]).includes(rank)) : []; } catch { return []; } })();
    const wantedChars = d.nicknameCharsMin && d.nicknameCharsMax ? d.nicknameCharsMin === d.nicknameCharsMax ? `${d.nicknameCharsMin}글자 닉` : `${d.nicknameCharsMin}~${d.nicknameCharsMax}글자 닉` : d.nicknameCharsMin ? `${d.nicknameCharsMin}글자 이상 닉` : d.nicknameCharsMax ? `${d.nicknameCharsMax}글자 이하 닉` : '';
    const selected = skinTags(d.skinTags).filter(v => v !== LEGACY_SKELETON || !skinTags(d.skinTags).includes(FULL_SET));
    return [
        d.ownerCount ? `${d.ownerCount}대주` : '',
        d.maxOwners ? `${d.maxOwners}대주 이하` : '',
        d.recordStatus || d.recordPreference || '',
        wantedChars + (wantedRanks.length ? `${wantedChars ? ' / ' : '닉 '}${wantedRanks.join('/')}` : ''),
        d.nicknameChars ? `${d.nicknameChars}글자 닉${d.nicknameRank ? ' / ' + d.nicknameRank : ''}` : d.nicknameRank ? `닉 ${d.nicknameRank} (작성자 선택)` : '',
        selected.length ? selected[0] + (selected.length > 1 ? ` 외 ${selected.length - 1}개` : '') : '',
        d.gas ? `가스 ${Number(d.gas).toLocaleString('ko-KR')}` : '',
        d.minerals ? `미네랄 ${Number(d.minerals).toLocaleString('ko-KR')}` : '',
    ].filter(Boolean);
}
