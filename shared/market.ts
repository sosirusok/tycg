// Trade rules shared by the API Worker and the web client.
import type { BadgeId, GradeId } from './membership';

export const LATEST_SEASON = 32;

export const TIERS = [
    { id: 'iron', name: '아이언', min: 25 },
    { id: 'bronze', name: '브론즈', min: 6 },
    { id: 'silver', name: '실버', min: 6 },
    { id: 'gold', name: '골드', min: 6 },
    { id: 'platinum', name: '플래티넘', min: 6 },
    { id: 'diamond', name: '다이아몬드', min: 6 },
    { id: 'master', name: '마스터', min: 17 },
    { id: 'challenger', name: '챌린저', min: 6 },
    { id: 'champion', name: '챔피언', min: 8 },
] as const;

export type SeasonTag = { tier: string; season: number };

export type User = {
    id: string;
    nickname: string;
    role: string;
    bio: string;
    created_at: number;
    username?: string;
    postCount?: number;
    grade: GradeId;
    grade_expires_at: number | null;
    badges: BadgeId[];
};

export type TradeKind = 'buy' | 'sell' | 'exchange' | 'proxy_request' | 'proxy_offer';
export const TRADE_KINDS: TradeKind[] = ['buy', 'sell', 'exchange', 'proxy_request', 'proxy_offer'];

export type PriceHistoryEntry = { price: number; changed_at: number };

export type Post = {
    id: number;
    author_id: string;
    nickname: string;
    role: string;
    author_grade: GradeId;
    author_badges: BadgeId[];
    kind: TradeKind;
    title: string;
    body: string;
    price: number | null;
    price_history?: PriceHistoryEntry[];
    status: string;
    created_at: number;
    updated_at: number;
    tags: SeasonTag[];
    // Ladders an exchange post wants in return.
    wanted_tags?: SeasonTag[];
    category: string;
    price_mode: string;
    accepts_offers: number;
    details: Record<string, string>;
    images: string[];
    favorite?: boolean;
    hidden: number;
};

export function seasonsOf(tier: (typeof TIERS)[number], latest = LATEST_SEASON) {
    return Array.from({ length: Math.max(0, latest - tier.min + 1) }, (_, i) => tier.min + i);
}

export function validTags(input: unknown, latest = LATEST_SEASON): input is SeasonTag[] {
    return Array.isArray(input) && input.length <= 300 && input.every(t => t && typeof t === 'object'
        && Number.isInteger(t.season) && TIERS.some(v => v.id === t.tier && t.season >= v.min && t.season <= latest));
}

export function tierName(id: string) { return TIERS.find(v => v.id === id)?.name || id; }
export function tagName(t: SeasonTag) { return `${t.season}시즌 ${tierName(t.tier)}`; }

export function dateText(t: number) {
    return new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
}

// Trade posts quote prices in 만원 (e.g. "ㅈㄱ 35" means 350,000원).
export function priceText(p: number | null) {
    if (p === null) return '가격 협의';
    if (p >= 10000 && p % 1000 === 0) {
        const man = p / 10000;
        return (Number.isInteger(man) ? man.toLocaleString('ko-KR') : man.toFixed(1)) + '만원';
    }
    return p.toLocaleString('ko-KR') + '원';
}
export function wonText(p: number) { return p.toLocaleString('ko-KR') + '원'; }

// The editor takes prices in 만원 with up to 4 decimals; the API stores 원.
export function manToWon(input: string): number | null {
    const v = input.trim();
    if (!v) return null;
    if (!/^\d{1,6}(\.\d{1,4})?$/.test(v)) return NaN;
    return Math.round(Number(v) * 10000);
}
export function wonToMan(p: number | null | undefined) {
    if (p === null || p === undefined) return '';
    return String(Number((p / 10000).toFixed(4)));
}

export const CATEGORIES = [
    { id: 'account', name: '계정', icon: 'man-zombie' },
    { id: 'clan', name: '클랜', icon: 'castle' },
    { id: 'goods_coupon', name: '굿즈 및 쿠폰', icon: 'admission-tickets' },
    { id: 'other', name: '기타', icon: 'package' },
    { id: 'ladder', name: '래더', icon: 'trophy' },
    { id: 'story', name: '스토리 및 재화', icon: 'bookmark' },
    { id: 'event', name: '이벤트', icon: 'party-popper' },
] as const;

export const KIND_NAMES: Record<TradeKind, string> = { buy: '구매', sell: '판매', exchange: '교환', proxy_request: '대리(구함)', proxy_offer: '대리(진행)' };
export const KIND_ICONS: Record<TradeKind, string> = { buy: 'shopping-cart', sell: 'money-bag', exchange: 'handshake', proxy_request: 'key', proxy_offer: 'trophy' };
export const STATUS_NAMES: Record<string, string> = { open: '거래중', reserved: '예약중', closed: '거래완료' };

export function isProxyKind(kind: string) { return kind === 'proxy_request' || kind === 'proxy_offer'; }
export function isTradeKind(kind: unknown): kind is TradeKind { return typeof kind === 'string' && (TRADE_KINDS as string[]).includes(kind); }

export function categoriesForKind(kind: string) {
    const ids: string[] = isProxyKind(kind) ? ['ladder', 'story', 'event'] : kind === 'exchange' ? ['account', 'clan'] : ['account', 'clan', 'goods_coupon', 'other'];
    return CATEGORIES.filter(category => ids.includes(category.id));
}
export function categoryName(id: string) { return CATEGORIES.find(c => c.id === id)?.name || id; }

// Older posts used different category ids; map them onto the current tabs.
export function normalizeTrade(kind: string, category: string): { kind: TradeKind; category: string } {
    if (category === 'service') return { kind: kind === 'buy' || kind === 'proxy_request' ? 'proxy_request' : 'proxy_offer', category: 'ladder' };
    const normalized = category === 'coupon' || category === 'goods' ? 'goods_coupon' : category === 'duo' ? 'other' : category;
    return { kind: isTradeKind(kind) ? kind : 'sell', category: normalized };
}

export function exchangeLabel(category: string, wantedCategory?: string) {
    return `${categoryName(category)}에서 ${categoryName(wantedCategory || 'account')} 구함`;
}

export type DetailField = { id: string; label: string; type?: 'number' | 'text' | 'date'; placeholder?: string };

const PROXY_FIELDS: DetailField[] = [
    { id: 'mode', label: '종목', placeholder: '예: 래더 솔큐, 엘프고' },
    { id: 'current', label: '현재', placeholder: '예: 플래 3.6 (36,000점)' },
    { id: 'target', label: '목표', placeholder: '예: 5.8까지, 다이아 달성' },
    { id: 'schedule', label: '가능 시간', placeholder: '예: 평일 저녁, 점검 후' },
    { id: 'duration', label: '기간', placeholder: '예: 3일' },
    { id: 'priceUnit', label: '가격 기준', placeholder: '예: 천점당 0.7, 판당, 챕터당 0.3' },
    { id: 'conditions', label: '조건', placeholder: '예: 선입금, 동접 시 중단' },
];

export const DETAIL_FIELDS: Record<string, DetailField[]> = {
    account: [
        { id: 'level', label: '계정 레벨', type: 'number' },
        { id: 'labLevel', label: '연구실 레벨', type: 'number' },
        { id: 'humanSkins', label: '인간 스킨 수', type: 'number' },
        { id: 'zombieSkins', label: '좀비 스킨 수', type: 'number' },
        { id: 'closet', label: '옷장 칸 수', type: 'number' },
        { id: 'phantom', label: '팬텀', type: 'number' },
        { id: 'rides', label: '라이드' },
        { id: 'emblems', label: '주요 엠블럼' },
        { id: 'gas', label: '가스', type: 'number' },
        { id: 'minerals', label: '미네랄', type: 'number' },
        { id: 'progress', label: '콘텐츠 진행도' },
        { id: 'joined', label: '게임 가입 시기' },
        { id: 'accountType', label: '연동 / 포함 범위' },
        { id: 'ownerCount', label: '대주 수', type: 'number' },
        { id: 'recordStatus', label: '전적' },
    ],
    clan: [
        { id: 'clanName', label: '클랜명' },
        { id: 'clanLevel', label: '클랜 레벨', type: 'number' },
        { id: 'clanMembers', label: '클랜원 수', type: 'number' },
        { id: 'clanCapacity', label: '최대 인원', type: 'number' },
    ],
    goods_coupon: [
        { id: 'goodsName', label: '상품명' },
        { id: 'condition', label: '상태', placeholder: '예: 미개봉' },
        { id: 'delivery', label: '거래 방법', placeholder: '예: 택배, 입금 후 코드 전달' },
        { id: 'couponName', label: '쿠폰명', placeholder: '예: 코믹스 1권 미쿺, 유루미 스쿺' },
        { id: 'expires', label: '유효기간', type: 'date' },
        { id: 'quantity', label: '수량', type: 'number' },
        { id: 'used', label: '사용 여부' },
    ],
    other: [],
    ladder: PROXY_FIELDS,
    story: PROXY_FIELDS,
    event: PROXY_FIELDS,
};

export function listingPrice(p: Pick<Post, 'price' | 'price_mode' | 'kind'>) {
    if (p.kind === 'exchange') return '교환 글';
    if (p.price === null) return p.kind === 'buy' || p.kind === 'sell' ? '가격 제시' : '가격 협의';
    return priceText(p.price);
}

export function priceLabel(kind: string) {
    return kind === 'sell' ? '즉거가' : kind === 'buy' ? 'MAX' : kind === 'exchange' ? '교환' : kind === 'proxy_request' ? '희망 가격' : '가격';
}

export function relativeTime(t: number) {
    const n = Date.now() - t;
    return n < 60000 ? '방금 전' : n < 3600000 ? Math.floor(n / 60000) + '분 전' : n < 86400000 ? Math.floor(n / 3600000) + '시간 전' : n < 604800000 ? Math.floor(n / 86400000) + '일 전' : dateText(t);
}

// Preferred ("우대") skins. The first eight are the owner's list, spelled as the owner
// wrote them; the rest recur as 우대/필수 in 2025–2026 trade posts. Sources: docs/research.md.
export const OWNER_SKINS = ['유루미', '아람', '송편좀비', '유니콘 좀비', '악몽주인', '서큐 날개', '뱀파이어 정동석', '구미호 케빈'] as const;
export const SKIN_OPTIONS = [
    ...OWNER_SKINS,
    '창작의 화신', '마법고 5강', '마리오네트 윤슬', '냥냥 김준호', '냥냥 정예슬', '홍매화 정예슬',
    '끝주홍 나비날개', '발렌타인 마녀', '파멸세계 스킨', '교장 부부 세트', '해골기사 남동진 풀세트', '붉은 박스 좀비',
] as const;
// Values stored by earlier versions stay valid for existing posts and searches.
export const LEGACY_SKELETON = '해골 기사단장 남동진';
export const FULL_SET = '해골 기사단장 남동진 풀세트';
const LEGACY_SKINS = [LEGACY_SKELETON, '파자마 고나래', '펭귄 맹규리', FULL_SET];
export const SKIN_TAGS: readonly string[] = [...SKIN_OPTIONS, ...LEGACY_SKINS];

// Other names for the same skin: in-game names and short forms used in trade posts
// (악주, 뱀동, 냥준, 냥예, 홍매화, 풀강, 펭규리, 붉박 …). Searching any of them finds the listed skin.
export const SKIN_ALIASES: Record<string, readonly string[]> = {
    '송편좀비': ['송편 좀비'],
    '악몽주인': ['악몽의 주인', '악주'],
    '서큐 날개': ['서큐버스 날개', '서큐'],
    '뱀파이어 정동석': ['뱀동', '뱀파동석'],
    '냥냥 김준호': ['냥준', '냥준호'],
    '냥냥 정예슬': ['냥슬', '냥예', '냥예슬'],
    '홍매화 정예슬': ['홍매화'],
    '마법고 5강': ['5강', '풀강', '마법고 풀강'],
    '펭귄 맹규리': ['펭규리'],
    '붉은 박스 좀비': ['붉박'],
    '끝주홍 나비날개': ['끝주홍'],
    [FULL_SET]: ['해골기사 남동진 풀세트'],
    '해골기사 남동진 풀세트': [FULL_SET],
};
const squash = (v: string) => v.replace(/\s+/g, '').toLowerCase();

// The stored skin values that a search word refers to (exact skin or alias, spaces ignored).
export function skinsForWord(word: string): string[] {
    const w = squash(word);
    if (!w) return [];
    return SKIN_TAGS.filter(tag => squash(tag) === w || SKIN_ALIASES[tag]?.some(a => squash(a) === w));
}

// Skin values to match when a filter selects these skins, including older stored values.
export function expandSkins(chosen: string[]) {
    const out = new Set(chosen);
    for (const tag of chosen) for (const alias of SKIN_ALIASES[tag] || []) if (SKIN_TAGS.includes(alias)) out.add(alias);
    return [...out];
}

export const NICK_RANKS = ['R', 'S', 'A', 'B', '잡'] as const;

export const REPORT_REASONS = ['사기·먹튀', '허위 매물', '대주수·전적 속임', '회수·해킹 계정', '도배·중복 글', '욕설·비방', '기타'] as const;

// Stored values never change; `labels` only gives some of them the cafe word on screen.
export const ACCOUNT_CHOICES: Record<string, { label: string; options: readonly string[]; legacy?: readonly string[]; labels?: Record<string, string> }> = {
    nicknameRank: { label: '닉 등급', options: NICK_RANKS },
    recordStatus: { label: '전적', options: ['무전적', '전적 있음'] },
    integrated: { label: '통합', options: ['통합', '미통합'], legacy: ['모름'], labels: { '미통합': '미통' } },
    passwordChange: { label: '비번 변경 (비변)', options: ['가능', '불가'], legacy: ['확인 필요'] },
    // 영전: the phone number goes with the account ('31 다야 3대주 영전').
    phoneChange: { label: '전번 변경 (전변)', options: ['가능', '영전', '쿨타임 남음', '불가'], legacy: ['확인 필요'], labels: { '영전': '영전 (같이 넘김)' } },
    backupEmail: { label: '보안 메일 (보멜)', options: ['없음', '있음', '있음 (변경 불가)'] },
};
export function choiceAllowed(key: string, value: string) {
    const f = ACCOUNT_CHOICES[key];
    return !!f && (f.options.includes(value) || !!f.legacy?.includes(value));
}
export function choiceLabel(key: string, value: string) { return ACCOUNT_CHOICES[key]?.labels?.[value] || value; }

export const RECORD_PREFERENCES = ['무전적', '전적 있어도 괜찮음'] as const;

export const BUYER_DETAIL_FIELDS: DetailField[] = [
    { id: 'maxOwners', label: '대주 수', type: 'number' },
    { id: 'recordPreference', label: '전적' },
    { id: 'nicknameCharsMin', label: '닉네임 최소 글자 수', type: 'number' },
    { id: 'nicknameCharsMax', label: '닉네임 최대 글자 수', type: 'number' },
    { id: 'nicknameRanks', label: '원하는 닉 등급' },
    { id: 'skinTags', label: '우대 스킨' },
];

DETAIL_FIELDS.account.push(
    { id: 'nicknameChars', label: '닉네임 글자 수', type: 'number' },
    ...Object.entries(ACCOUNT_CHOICES).filter(([id]) => id !== 'recordStatus').map(([id, f]) => ({ id, label: f.label })),
    { id: 'skinTags', label: '보유 스킨' },
);

export function parseList(raw: string | undefined, allowed: readonly string[]): string[] {
    try {
        const v: unknown = JSON.parse(raw || '[]');
        return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && allowed.includes(x)))] : [];
    } catch { return []; }
}
export function skinTags(raw?: string): string[] { return parseList(raw, SKIN_TAGS); }

export function skinDisplay(tags: string[]) {
    return tags.filter(v => v !== LEGACY_SKELETON || !tags.includes(FULL_SET));
}

// Nickname grades as the cafes write them: S급, R/S급; 잡 has no 급.
export function rankText(ranks: readonly string[]) {
    const graded = ranks.filter(r => r !== '잡');
    return [graded.length ? graded.join('/') + '급' : '', ranks.includes('잡') ? '잡' : ''].filter(Boolean).join('/');
}

// Short condition list for cards: owners, record, 전비변/영전/보멜/미통, nickname, skins, currency.
export function accountSummary(d: Record<string, string>) {
    const wantedRanks = parseList(d.nicknameRanks, NICK_RANKS);
    const min = d.nicknameCharsMin, max = d.nicknameCharsMax;
    const wantedChars = min && max ? (min === max ? `${min}글자 닉` : `${min}~${max}글자 닉`) : min ? `${min}글자 이상 닉` : max ? `${max}글자 이하 닉` : '';
    const skins = skinDisplay(skinTags(d.skinTags));
    const rank = d.nicknameRank ? rankText([d.nicknameRank]) : '';
    return [
        d.ownerCount ? `${d.ownerCount}대주` : '',
        d.maxOwners ? `${d.maxOwners}대주 이하` : '',
        d.recordStatus || d.recordPreference || '',
        d.passwordChange === '가능' && (d.phoneChange === '가능' || d.phoneChange === '영전') ? '전비변O' : '',
        d.phoneChange === '영전' ? '영전' : '',
        d.backupEmail === '없음' ? '보멜X' : '',
        d.integrated === '미통합' ? '미통' : '',
        wantedChars + (wantedRanks.length ? `${wantedChars ? ' · ' : '닉 '}${rankText(wantedRanks)}` : ''),
        d.nicknameChars ? `${d.nicknameChars}글자 닉${rank ? ' · ' + rank : ''}` : rank ? `닉 ${rank}` : '',
        skins.length ? skins[0] + (skins.length > 1 ? ` 외 ${skins.length - 1}` : '') : '',
        d.phantom ? `팬텀 ${d.phantom}%` : '',
        d.gas ? `가스 ${Number(d.gas).toLocaleString('ko-KR')}` : '',
        d.minerals ? `미네랄 ${Number(d.minerals).toLocaleString('ko-KR')}` : '',
    ].filter(Boolean);
}
