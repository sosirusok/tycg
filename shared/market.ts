// Trade rules shared by the API Worker and the web client.
import type { BadgeId, GradeId } from './membership';
import type { LinkCard } from './links';
import type { BodyStyle } from './richtext';

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
    // 플러스 무료 체험 (WP41): the grade is 'plus', but no chip is shown.
    grade_trial?: boolean;
    badges: BadgeId[];
    // The session user's own 이용 정지 end (WP22); other members' profiles carry only `suspended`.
    suspended_until?: number | null;
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
    author_grade_trial?: boolean;
    author_badges: BadgeId[];
    kind: TradeKind;
    title: string;
    body: string;
    price: number | null;
    price_history?: PriceHistoryEntry[];
    status: string;
    // When the post was completed (WP43); null while 진행중 and for posts completed before the column.
    closed_at?: number | null;
    created_at: number;
    updated_at: number;
    // The place in 최신순: the last 끌올, or created_at. A new post of today's allowance sits 1 hour
    // ahead (새 글 우선), and a relist of the same listing may sit at its old place (WP44).
    bumped_at?: number;
    bump_count?: number;
    relist?: number;
    // The inline list thumbnail ('data:image/webp;base64,…', WP45), null once the cleanup cleared it.
    thumb?: string | null;
    // 조회수 (WP45).
    view_count?: number;
    // 댓글·답글 (WP55): live 댓글 and 답글 on the post.
    comment_count?: number;
    // 운영진 가측가 (WP65): the manager's appraisal, null once the post was edited after it.
    appraised?: { price: number; at: number } | null;
    // 완료 거래가 (WP51): the 거래가 of the completed post's confirmed trade. The author, the two members of
    // the trade and the manager also get a pending one, with deal_state ('확인 대기' / '확인 완료').
    deal_price?: number;
    deal_state?: 'pending' | 'confirmed';
    tags: SeasonTag[];
    // Ladders an exchange post wants in return.
    wanted_tags?: SeasonTag[];
    category: string;
    price_mode: string;
    accepts_offers: number;
    details: Record<string, string>;
    // Lists carry only the 대표 (images[0]) and photo_count; GET /posts/:id carries every photo (WP46).
    images: string[];
    photo_count?: number;
    favorite?: boolean;
    hidden: number;
    // 링크 미리보기 (WP48), GET /posts/:id only: the author's switch and the cards the post may show.
    link_preview?: boolean;
    link_cards?: LinkCard[];
    // 글자 꾸미기 (WP49), GET /posts/:id only: the ranges the author's current grade may show, or null.
    body_style?: BodyStyle | null;
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
// '2027년 4월 1일', for dates followed by a particle ('…까지').
export function longDate(t: number) {
    return new Date(t).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });
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
// Two states (WP43): 진행중 ('open') and 완료 ('closed', final). Each kind names them its own way;
// screens that mix kinds use 거래중/거래완료. A legacy 'reserved' reads as open.
export const STATUS_NAMES: Record<string, string> = { open: '거래중', closed: '거래완료' };
export const STATUS_LABELS: Record<TradeKind, { open: string; closed: string }> = {
    sell: { open: '판매중', closed: '판매완료' },
    buy: { open: '구매중', closed: '구매완료' },
    proxy_request: { open: '구하는중', closed: '구함완료' },
    exchange: { open: '교환중', closed: '교환완료' },
    proxy_offer: { open: '받는중', closed: '마감' },
};
export function statusName(kind: string, status: string) {
    const labels = STATUS_LABELS[kind as TradeKind];
    const st = status === 'closed' ? 'closed' : 'open';
    return labels ? labels[st] : STATUS_NAMES[st];
}
export const closedLabel = (kind: string) => statusName(kind, 'closed');

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
// 스킨 수 as cafe titles write it: 팬텀 % ('팬텀 214%', '3팬텀' = 300%). The same range on 판매 (phantom),
// on 구매 (phantomMin, the least a buyer accepts) and on the matching searches.
export const PHANTOM_MAX = 5000;
export const PHANTOM_LABEL = '스킨 수 (팬텀 %)';
export const PHANTOM_HINT = '3팬텀 = 300%';

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
        { id: 'level', label: '레벨', type: 'number' },
        { id: 'labLevel', label: '연구실', type: 'number' },
        { id: 'humanSkins', label: '인간 스킨 수', type: 'number' },
        { id: 'zombieSkins', label: '좀비 스킨 수', type: 'number' },
        { id: 'closet', label: '옷장', type: 'number' },
        { id: 'phantom', label: PHANTOM_LABEL, type: 'number', placeholder: '예: 225' },
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
    // A buy post reads 'MAX 30만원' (or 'MAX 미정') in one piece; 가격 제시 is the sale's offer button.
    if (p.kind === 'buy') return 'MAX ' + (p.price === null ? '미정' : priceText(p.price));
    if (p.price === null) return p.kind === 'sell' ? '가격 제시' : '가격 협의';
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
// 닉 종류 as nickname trades name them ('S급 여사', '남사닉 필수', '두 글자 무받침 영어').
export const NICK_TYPES = ['여사', '남사', '중성', '귀욤', '영어', '무받침', '연예인'] as const;
export function nickTypesText(types: readonly string[]) { return types.join('/'); }

export const REPORT_REASONS = ['사기·먹튀', '허위 매물', '대주수·전적 속임', '회수·해킹 계정', '도배·중복 글', '욕설·비방', '기타'] as const;
// A report about a member (from the chat header or the profile) adds the cafe words 젯취·거파 and 잠수.
export const MEMBER_REPORT_REASONS = ['사기·먹튀', '젯취·거파', '잠수', '대주수·전적 속임', '욕설·비방', '기타'] as const;

// 거래 후기 (WP23): 좋아요 or 아쉬워요, plus any of that side's tags and one line of at most 100 characters.
export const REVIEW_TAGS = { good: ['약속 잘 지킴', '답장 빠름', '설명과 같음'], bad: ['잠수', '거래 파기', '설명과 다름'] } as const;
export const REVIEW_TEXT_MAX = 100;
export const REVIEW_DAYS = 30;
// The card a trade puts in the chat of its two members (also the chat list preview).
export const REVIEW_CARD_TEXT = '거래 후기 남기기';
export const reviewName = (good: boolean | number) => good ? '좋아요' : '아쉬워요';
// '거래 3회 · 후기 좋아요 2' on the profile and the detail page's author box.
// '거래 12회 · 거금 340만원 · 후기 좋아요 9' (거금 only once there is any).
export const tradeStatsText = (trades: number, good: number, deal = 0) => `거래 ${trades}회 · ${deal > 0 ? `거금 ${priceText(deal)} · ` : ''}후기 좋아요 ${good}`;
// One 후기 as the profile tab and the chat card show it. `removed`: the manager deleted it (the chat
// card of its author says so; lists and counts leave it out).
export type Review = { id: number; trade_id: string; author_id: string; target_id: string; good: number; tags: string[]; text: string; created_at: number; removed?: number };

// 이용 정지: 3, 7 or 30 days, or 0 for 영구. 영구 is stored as this far-future time, which is past
// the largest Date, so it is never formatted as a date.
export const SUSPEND_DAYS = [3, 7, 30, 0] as const;
export const SUSPEND_FOREVER = 9e15;
export const suspendDaysLabel = (days: number) => days ? days + '일' : '영구';
// When a suspension ends: '10월 8일 15:40' on the Korean clock (rounded up to the minute, so it is
// never early), or '영구'.
export function suspendEndText(until: number) {
    if (until >= SUSPEND_FOREVER) return '영구';
    const d = new Date(Math.ceil(until / 60000) * 60000 + 9 * 3600000);
    return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
// The one way every screen and error names the period: '10월 8일 15:40까지' or '영구'
// ('이용 정지 중입니다. (10월 8일 15:40까지)', '이용 정지 중 (영구)').
export const suspendUntilText = (until: number) => until >= SUSPEND_FOREVER ? '영구' : suspendEndText(until) + '까지';

// Stored values never change; `labels` only gives some of them the cafe word on screen.
export const ACCOUNT_CHOICES: Record<string, { label: string; options: readonly string[]; legacy?: readonly string[]; labels?: Record<string, string> }> = {
    nicknameRank: { label: '닉 등급', options: NICK_RANKS },
    recordStatus: { label: '전적', options: ['무전적', '전적 있음'] },
    integrated: { label: '통합/미통', options: ['통합', '미통합'], legacy: ['모름'], labels: { '미통합': '미통' } },
    passwordChange: { label: '비번 변경 (비변)', options: ['가능', '불가'], legacy: ['확인 필요'] },
    // 영전: the phone number goes with the account ('31 다야 3대주 영전').
    phoneChange: { label: '전번 변경 (전변)', options: ['가능', '영전', '쿨타임 남음', '불가'], legacy: ['확인 필요'], labels: { '영전': '영전 (같이 넘김)' } },
    backupEmail: { label: '보안 메일 (보멜)', options: ['없음', '있음', '있음 (변경 불가)'], labels: { '없음': '없음 (보멜X)' } },
};
export function choiceAllowed(key: string, value: string) {
    const f = ACCOUNT_CHOICES[key];
    return !!f && (f.options.includes(value) || !!f.legacy?.includes(value));
}
export function choiceLabel(key: string, value: string) { return ACCOUNT_CHOICES[key]?.labels?.[value] || value; }

export const RECORD_PREFERENCES = ['무전적', '전적 있어도 괜찮음'] as const;

export const BUYER_DETAIL_FIELDS: DetailField[] = [
    { id: 'maxOwners', label: '대주 수', type: 'number' },
    // The least 스킨 수 a buyer accepts, in 팬텀 % (3팬텀 = 300%); wantedPhantomMin on 교환.
    { id: 'phantomMin', label: PHANTOM_LABEL, type: 'number' },
    { id: 'recordPreference', label: '전적' },
    { id: 'nicknameCharsMin', label: '닉네임 최소 글자 수', type: 'number' },
    { id: 'nicknameCharsMax', label: '닉네임 최대 글자 수', type: 'number' },
    { id: 'nicknameRanks', label: '원하는 닉 등급' },
    { id: 'skinTags', label: '우대 스킨' },
];
// Buyers' 닉 종류 has one key on 구매 and on the wanted side of 교환 (the offered side keeps nicknameTypes),
// so it is not in BUYER_DETAIL_FIELDS, whose ids get the 'wanted' prefix on 교환.
export const WANTED_NICK_TYPES_FIELD: DetailField = { id: 'wantedNicknameTypes', label: '닉 종류' };

DETAIL_FIELDS.account.push(
    { id: 'nicknameChars', label: '닉네임 글자 수', type: 'number' },
    { id: 'nicknameTypes', label: '닉 종류' },
    ...Object.entries(ACCOUNT_CHOICES).filter(([id]) => id !== 'recordStatus').map(([id, f]) => ({ id, label: f.label })),
    { id: 'skinTags', label: '우대 스킨' },
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

// Short condition list for cards, most-scanned first: owners, record, a buyer's 팬텀 minimum, nickname, skins,
// then the cafe flags as one token ('전비변O·영전·보멜X·미통'), then currency. Cards show
// only the first few items, so the nickname grade and skins must come before the flags.
// Each item is one data word with no '·' between spaced words ('2글자 여사 S급 닉').
// The nickname is one item: a seller's own (nicknameChars, nicknameTypes, nicknameRank) or a
// buyer's wish (nicknameCharsMin/Max, wantedNicknameTypes, nicknameRanks); a record holds one of the two.
// The wanted side of 교환 arrives unprefixed, so its 닉 종류 is nicknameTypes there. A full 교환
// record (it has wantedCategory) is the offered side, so its wantedNicknameTypes is left out.
export function accountSummary(d: Record<string, string>) {
    const wantedRanks = parseList(d.nicknameRanks, NICK_RANKS);
    const min = d.nicknameCharsMin, max = d.nicknameCharsMax;
    const wantedChars = min && max ? (min === max ? `${min}글자` : `${min}~${max}글자`) : min ? `${min}글자 이상` : max ? `${max}글자 이하` : '';
    const types = [...new Set([...parseList(d.nicknameTypes, NICK_TYPES), ...d.wantedCategory ? [] : parseList(d.wantedNicknameTypes, NICK_TYPES)])];
    const chars = d.nicknameChars ? `${d.nicknameChars}글자` : wantedChars;
    const ranks = d.nicknameRank ? [d.nicknameRank] : wantedRanks;
    const nick = chars || types.length || ranks.length ? [chars, nickTypesText(types), ranks.length ? rankText(ranks) : '', '닉'].filter(Boolean).join(' ') : '';
    const skins = skinDisplay(skinTags(d.skinTags));
    const flags = [
        d.passwordChange === '가능' && (d.phoneChange === '가능' || d.phoneChange === '영전') ? '전비변O' : '',
        d.phoneChange === '영전' ? '영전' : '',
        d.backupEmail === '없음' ? '보멜X' : '',
        d.integrated === '미통합' ? '미통' : '',
    ].filter(Boolean).join('·');
    return [
        d.ownerCount ? `${d.ownerCount}대주` : '',
        d.maxOwners ? `${d.maxOwners}대주 이하` : '',
        d.recordStatus || d.recordPreference || '',
        // A buyer's least 스킨 수 decides who can answer, so it comes before the nickname wish.
        d.phantomMin ? `팬텀 ${d.phantomMin}% 이상` : '',
        nick,
        skins.length ? skins[0] + (skins.length > 1 ? ` 외 ${skins.length - 1}` : '') : '',
        flags,
        d.phantom ? `팬텀 ${d.phantom}%` : '',
        d.gas ? `가스 ${Number(d.gas).toLocaleString('ko-KR')}` : '',
        d.minerals ? `미네랄 ${Number(d.minerals).toLocaleString('ko-KR')}` : '',
    ].filter(Boolean);
}

// Quick replies (WP57): chips that fill the chat composer, never sent on their own. User voice (casual
// cafe talk), one set per board for the member who writes to the post (writer) and one for its author.
// A chat about no post uses the 판매 writer set.
export const QUICK_REPLIES: Record<TradeKind, { writer: string[]; author: string[] }> = {
    sell: {
        // copy-lint-ignore-next-line
        writer: ['아직 판매중인가요?', '쿨거 가능해요', '이중창 인증 가능할까요?', '전번·계좌 인증 되나요?'],
        // copy-lint-ignore-next-line
        author: ['네 판매중입니다', '판완됐습니다'],
    },
    buy: {
        // copy-lint-ignore-next-line
        writer: ['아직 구하시나요?', '스펙 캡처 보내드릴게요', '전번·계좌 인증 가능합니다'],
        // copy-lint-ignore-next-line
        author: ['네 아직 구합니다', '이중창 인증 가능할까요?', '전번·계좌 인증 되나요?'],
    },
    exchange: {
        // copy-lint-ignore-next-line
        writer: ['교환 아직 되나요?', '제 계정 스펙 보내드릴게요'],
        // copy-lint-ignore-next-line
        author: ['네 교환 가능합니다', '이중창 인증 가능할까요?'],
    },
    // 대리(구함): the writer is the one who would do the 대리, so they send their own 경력.
    proxy_request: {
        // copy-lint-ignore-next-line
        writer: ['바로 진행 가능합니다', '천점당 얼마인가요?', '경력 캡처 보내드릴게요'],
        // copy-lint-ignore-next-line
        author: ['네 아직 구합니다', '가격 알려주세요', '경력 있으신가요?'],
    },
    proxy_offer: {
        // copy-lint-ignore-next-line
        writer: ['천점당 얼마인가요?', '경력 캡처 있나요?', '바로 진행 가능합니다'],
        // copy-lint-ignore-next-line
        author: ['네 진행 가능합니다', '가격 알려주세요'],
    },
};
// The board chips for a chat: by the post's board and side; after 완료 only a sale's author keeps
// '판완됐습니다'.
export function quickReplies(listing: { kind: string; status: string } | null, own: boolean): string[] {
    if (!listing || !isTradeKind(listing.kind)) return QUICK_REPLIES.sell.writer;
    const set = QUICK_REPLIES[listing.kind];
    if (listing.status === 'closed') return own && listing.kind === 'sell' ? set.author.slice(1) : [];
    return own ? set.author : set.writer;
}

// {제목}, {즉거가} and {현젯} in a quick reply or an auto reply, from the post the chat is about. A
// sentence with a value the post does not have (no post, no 즉거가, no 현젯) is left out; null when
// nothing is left.
export const TEMPLATE_VARS = ['{제목}', '{즉거가}', '{현젯}'] as const;
export function fillTemplate(text: string, post: { title: string; kind: string; price: number | null; currentOffer?: number | null } | null): string | null {
    const values: Record<string, string | null> = {
        '{제목}': post ? post.title : null,
        '{즉거가}': post && post.kind === 'sell' && post.price !== null ? priceText(post.price) : null,
        '{현젯}': post && post.kind === 'sell' && post.currentOffer ? priceText(post.currentOffer) : null,
    };
    const lines = text.split('\n').map(line => line.split(/(?<=[.!?])\s+/).filter(sentence => TEMPLATE_VARS.every(v => !sentence.includes(v) || values[v] !== null))
        .map(sentence => TEMPLATE_VARS.reduce((out, v) => out.split(v).join(values[v] ?? ''), sentence)).join(' '));
    const out = lines.join('\n').trim();
    return out || null;
}
