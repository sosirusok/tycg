// ============================================================================
//  신우 키우기 — 데이터 / 밸런스 / 수식 코어
//  밸런스 철학: 비용은 기하급수(1.07~1.10), 생산은 거의 동률로 성장시켜
//  "초반 회수시간 ~30s → 후반 ~80s" 의 완만한 난이도. 마일스톤 ×2 와
//  환생(★) 곱연산이 급성장을 만들고, 비용 multiplier가 후반일수록 낮아
//  대량구매(x100/MAX)로 막힘 없이 뚫린다.
// ============================================================================

// ---- 밸런스 상수 ----------------------------------------------------------
export const BAL = {
  startFat: 20,            // 시작 지방
  startCubes: 12,          // 시작 큐브(가챠 가능하게)
  starPowerBase: 0.03,     // ★ 1개당 생산 +3%
  starDivisor: 1e6,        // 환생 ★ = sqrt(run지방 / 이 값)
  offlineCapHoursBase: 2,  // 기본 오프라인 보상 상한(시간)
  offlineEffBase: 0.5,     // 기본 오프라인 효율 50%
  tapIncomeFrac: 0.12,     // 탭 1회 = 초당수익의 12% (+기본)
  tapBaseFlat: 1,
  critChanceBase: 0.05,
  critMultBase: 7,
  goldenBaseChancePerSec: 1 / 95, // 평균 95초마다 황금음식
  goldenRewardSecs: 30,    // 황금음식 = 30초치 수익 (+버프)
  goldenBuffMult: 7,
  goldenBuffSecs: 15,
  cubePerLevel: 1,         // 레벨업 1회당 큐브
  // 마일스톤(보유 수) 도달 시 해당 사업 생산 ×2
  milestones: [10, 25, 50, 100, 150, 200, 300, 400, 500, 750, 1000],
}

// ---- 사업(생산기) 12종 : 음식 제국 ----------------------------------------
// baseCost ×~10/티어, baseRev = baseCost / 회수시간(30~83s). mult 1.10→1.07.
export const GENERATORS = [
  { id: 'g1',  name: '붕어빵 가판대',   emoji: '🐟', baseCost: 15,     baseRev: 0.5,    mult: 1.100 },
  { id: 'g2',  name: '떡볶이 포차',     emoji: '🌶️', baseCost: 1.0e2,  baseRev: 3,      mult: 1.100 },
  { id: 'g3',  name: '김밥천국',        emoji: '🍙', baseCost: 1.1e3,  baseRev: 30,     mult: 1.095 },
  { id: 'g4',  name: '치킨집',          emoji: '🍗', baseCost: 1.2e4,  baseRev: 300,    mult: 1.090 },
  { id: 'g5',  name: '디저트 카페',     emoji: '🧁', baseCost: 1.3e5,  baseRev: 3.0e3,  mult: 1.085 },
  { id: 'g6',  name: '수제버거 가게',   emoji: '🍔', baseCost: 1.4e6,  baseRev: 3.0e4,  mult: 1.080 },
  { id: 'g7',  name: '패밀리 레스토랑', emoji: '🍝', baseCost: 1.5e7,  baseRev: 3.0e5,  mult: 1.080 },
  { id: 'g8',  name: '호텔 뷔페',       emoji: '🍤', baseCost: 1.6e8,  baseRev: 3.0e6,  mult: 1.075 },
  { id: 'g9',  name: '미슐랭 레스토랑', emoji: '⭐', baseCost: 1.7e9,  baseRev: 3.0e7,  mult: 1.075 },
  { id: 'g10', name: '프랜차이즈 본사', emoji: '🏢', baseCost: 1.8e10, baseRev: 3.0e8,  mult: 1.070 },
  { id: 'g11', name: '글로벌 식품기업', emoji: '🌐', baseCost: 2.0e11, baseRev: 3.0e9,  mult: 1.070 },
  { id: 'g12', name: '우주 미식제국',   emoji: '🚀', baseCost: 2.5e12, baseRev: 3.0e10, mult: 1.070 },
]

// 보유 수 n 으로 사업 1개 추가 비용
export function genUnitCost(gen, owned) {
  return gen.baseCost * Math.pow(gen.mult, owned)
}
// n개 보유 상태에서 k개 한꺼번에 사는 비용(등비수열 합)
export function genBulkCost(gen, owned, k) {
  if (k <= 0) return 0
  const r = gen.mult
  return gen.baseCost * Math.pow(r, owned) * (Math.pow(r, k) - 1) / (r - 1)
}
// 보유 가능한 최대 개수(예산 budget 내)
export function genMaxBuy(gen, owned, budget) {
  const r = gen.mult
  const a = gen.baseCost * Math.pow(r, owned)
  const k = Math.floor(Math.log((budget * (r - 1)) / a + 1) / Math.log(r))
  return Math.max(0, k)
}
// 마일스톤 배수(보유 수에 따라 ×2 누적)
export function genMilestoneMult(owned, bonusPow = 0) {
  let n = 0
  for (const m of BAL.milestones) if (owned >= m) n++
  return Math.pow(2, n) * (1 + bonusPow * n)
}
// 다음 마일스톤
export function nextMilestone(owned) {
  for (const m of BAL.milestones) if (owned < m) return m
  return null
}

// ---- 스킬트리 : 4계열 ------------------------------------------------------
//  k: 효과키, per: 레벨당 값. flag: 1회성 해금. baseCost/grow: 스킬포인트 비용.
export const SKILLS = {
  prod: {
    name: '생산', icon: '🔥', color: '#ff8a4c',
    nodes: [
      { id: 'p_glob',  name: '대량 양산',     desc: '모든 생산 +6%',           max: 25, baseCost: 1, grow: 1.35, k: 'prodPct', per: 0.06 },
      { id: 'p_early', name: '노점의 추억',   desc: '1~6번 사업 생산 +30%',    max: 12, baseCost: 1, grow: 1.4,  k: 'earlyPct', per: 0.30 },
      { id: 'p_late',  name: '대기업 파워',   desc: '7~12번 사업 생산 +40%',   max: 12, baseCost: 2, grow: 1.4,  k: 'latePct',  per: 0.40 },
      { id: 'p_mile',  name: '규모의 경제',   desc: '마일스톤 ×2 효과 강화(+15%/단계)', max: 8, baseCost: 3, grow: 1.6, k: 'milestonePow', per: 0.15 },
      { id: 'p_tap',   name: '폭식 강타',     desc: '탭 수익 +12%',            max: 30, baseCost: 1, grow: 1.3,  k: 'tapPct', per: 0.12 },
      { id: 'p_inf',   name: '무한 식욕',     desc: '모든 생산 +1.5% (무한)',  max: 9999, baseCost: 5, grow: 1.12, k: 'prodPct', per: 0.015 },
    ],
  },
  conv: {
    name: '편의', icon: '⚙️', color: '#4cc5ff',
    nodes: [
      { id: 'c_x10',  name: 'x10 구매',      desc: '한 번에 10개 구매 해금',   max: 1, baseCost: 2,  grow: 1, k: 'flag', flag: 'x10' },
      { id: 'c_x100', name: 'x100 구매',     desc: '한 번에 100개 구매 해금',  max: 1, baseCost: 5,  grow: 1, k: 'flag', flag: 'x100' },
      { id: 'c_max',  name: 'MAX 구매',      desc: '가능한 최대치 구매 해금',  max: 1, baseCost: 10, grow: 1, k: 'flag', flag: 'max' },
      { id: 'c_auto', name: '자동 경영',     desc: '가장 싼 사업 자동 구매',    max: 1, baseCost: 25, grow: 1, k: 'flag', flag: 'auto' },
      { id: 'c_cost', name: '협상의 달인',   desc: '모든 구매 비용 -2%',       max: 15, baseCost: 3, grow: 1.5, k: 'costRed', per: 0.02 },
      { id: 'c_offt', name: '냉동 보관',     desc: '오프라인 보상 +2시간',     max: 12, baseCost: 2, grow: 1.3, k: 'offHours', per: 2 },
      { id: 'c_offe', name: '신선 유지',     desc: '오프라인 효율 +6%',        max: 10, baseCost: 3, grow: 1.4, k: 'offEff', per: 0.06 },
    ],
  },
  ability: {
    name: '능력', icon: '✨', color: '#b98cff',
    nodes: [
      { id: 'a_grate', name: '황금 후각',   desc: '황금 음식 출현율 +12%',    max: 15, baseCost: 2, grow: 1.35, k: 'goldRate', per: 0.12 },
      { id: 'a_gval',  name: '황금 미각',   desc: '황금 음식 가치 +20%',      max: 15, baseCost: 2, grow: 1.4,  k: 'goldVal', per: 0.20 },
      { id: 'a_crc',   name: '예리한 혀',   desc: '탭 크리티컬 확률 +2%',     max: 20, baseCost: 2, grow: 1.3,  k: 'critChance', per: 0.02 },
      { id: 'a_crm',   name: '미식 폭발',   desc: '크리티컬 배수 +1.5',       max: 15, baseCost: 3, grow: 1.4,  k: 'critMult', per: 1.5 },
      { id: 'a_luck',  name: '행운의 식탁', desc: '가챠 행운 +8%',            max: 20, baseCost: 3, grow: 1.35, k: 'luck', per: 0.08 },
      { id: 'a_binge', name: '폭식 모드',   desc: '90초마다 자동 황금 버프',  max: 1,  baseCost: 30, grow: 1, k: 'flag', flag: 'binge' },
    ],
  },
  stat: {
    name: '수치', icon: '📈', color: '#42d6a4',
    nodes: [
      { id: 's_star', name: '미슐랭 인맥',   desc: '환생 ★ 획득 +6%',        max: 20, baseCost: 2, grow: 1.35, k: 'starGain', per: 0.06 },
      { id: 's_pow',  name: '별의 무게',     desc: '★당 생산 보너스 +0.5%p',  max: 20, baseCost: 4, grow: 1.45, k: 'starPow', per: 0.005 },
      { id: 's_start',name: '재기의 자본',   desc: '환생 후 시작 지방 ×5',    max: 12, baseCost: 3, grow: 1.5,  k: 'prestigeStart', per: 5 },
      { id: 's_xp',   name: '경영 수업',     desc: '경험치 획득 +10%',        max: 20, baseCost: 2, grow: 1.3,  k: 'xp', per: 0.10 },
      { id: 's_cube', name: '큐브 채굴',     desc: '큐브 획득 +1/레벨당 보너스', max: 15, baseCost: 3, grow: 1.4, k: 'cubeGain', per: 0.10 },
      { id: 's_coll', name: '수집가의 손길', desc: '가챠 컬렉션 효과 +8%',     max: 20, baseCost: 3, grow: 1.4, k: 'collection', per: 0.08 },
      { id: 's_peak', name: '미식의 정점',   desc: '모든 생산 +0.5% (무한)',   max: 9999, baseCost: 6, grow: 1.1, k: 'prodPct', per: 0.005 },
    ],
  },
}

export function skillNodeCost(node, curLevel) {
  return Math.ceil(node.baseCost * Math.pow(node.grow, curLevel))
}

// ---- 레벨 / 경험치 ---------------------------------------------------------
// 누적 지방(lifetime) 기준. 자릿수당 약 5레벨 → 전 구간 균일한 레벨업 템포.
export function levelForLifetime(lifetime, xpMult = 1) {
  const v = Math.max(0, lifetime) * (1 + xpMult)
  return Math.floor(5 * Math.log10(v + 1))
}
export function lifetimeForLevel(level, xpMult = 1) {
  const raw = Math.pow(10, level / 5) - 1
  return raw / (1 + xpMult)
}

// ---- 환생(미슐랭 ★) --------------------------------------------------------
export function starsFromRun(runFat, starGain = 0) {
  const s = Math.sqrt(Math.max(0, runFat) / BAL.starDivisor)
  return Math.floor(s * (1 + starGain))
}

// ---- 가챠 : 수백 개 아이템 풀(결정적 생성) ---------------------------------
export const RARITIES = [
  { id: 'common',    name: '일반',   color: '#9fb0c3', weight: 0.580, stats: 1, mag: [1, 3] },
  { id: 'uncommon',  name: '고급',   color: '#5fd17a', weight: 0.270, stats: 1, mag: [3, 6] },
  { id: 'rare',      name: '희귀',   color: '#4ea3ff', weight: 0.100, stats: 2, mag: [6, 11] },
  { id: 'epic',      name: '영웅',   color: '#b06bff', weight: 0.040, stats: 2, mag: [11, 20] },
  { id: 'legendary', name: '전설',   color: '#ffb13d', weight: 0.0085, stats: 3, mag: [20, 35] },
  { id: 'mythic',    name: '신화',   color: '#ff5d7a', weight: 0.0015, stats: 3, mag: [40, 75] },
]
export const RARITY_BY_ID = Object.fromEntries(RARITIES.map(r => [r.id, r]))

const STAT_DEFS = {
  prod:    { label: '생산',     suffix: '%' },
  tap:     { label: '탭 수익',  suffix: '%' },
  star:    { label: '★ 획득',   suffix: '%' },
  cube:    { label: '큐브 획득', suffix: '%' },
  luck:    { label: '행운',     suffix: '%' },
  offline: { label: '오프라인', suffix: '%' },
}
export const STAT_KEYS = Object.keys(STAT_DEFS)
export const STAT_LABEL = id => STAT_DEFS[id].label

const PREFIXES = ['신선한','바삭한','매콤한','달콤한','황금','전설의','수제','비법','할매','미슐랭',
  '우주','마법의','악마의','천상의','고대의','프리미엄','유기농','초대형','미니','무한']
const BASES = ['붕어빵','떡볶이','김밥','라면','치킨','피자','햄버거','도넛','케이크','마카롱',
  '초밥','스테이크','파스타','짜장면','탕수육','곱창','삼겹살','비빔밥','빙수','아이스크림',
  '커피','버블티','식칼','프라이팬','오븐']
const EMOJI_BY_BASE = {
  '붕어빵':'🐟','떡볶이':'🌶️','김밥':'🍙','라면':'🍜','치킨':'🍗','피자':'🍕','햄버거':'🍔',
  '도넛':'🍩','케이크':'🍰','마카롱':'🍪','초밥':'🍣','스테이크':'🥩','파스타':'🍝','짜장면':'🥡',
  '탕수육':'🍤','곱창':'🍢','삼겹살':'🥓','비빔밥':'🍲','빙수':'🍧','아이스크림':'🍦',
  '커피':'☕','버블티':'🧋','식칼':'🔪','프라이팬':'🍳','오븐':'🔥',
}

// 결정적 PRNG (mulberry32)
function rng(seed) {
  let t = (seed + 0x6D2B79F5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

let _pool = null
export function buildGachaPool() {
  if (_pool) return _pool
  // 1) 모든 조합 생성
  const combos = []
  let idx = 0
  for (const base of BASES) for (const prefix of PREFIXES) {
    combos.push({ i: idx, base, prefix, h: rng(idx * 2654435761 + 7) }); idx++
  }
  const N = combos.length
  // 2) 레어리티별 "종류 수"를 보장(상위도 충분히 다양하게). 뽑기 확률과는 별개.
  const targets = [
    ['mythic', Math.max(5, Math.round(N * 0.012))],
    ['legendary', Math.max(16, Math.round(N * 0.04))],
    ['epic', Math.round(N * 0.10)],
    ['rare', Math.round(N * 0.18)],
    ['uncommon', Math.round(N * 0.28)],
  ]
  const sorted = [...combos].sort((a, b) => a.h - b.h)
  const rarityOf = {}
  let p = 0
  for (const [rid, cnt] of targets) for (let k = 0; k < cnt && p < N; k++, p++) rarityOf[sorted[p].i] = rid
  for (; p < N; p++) rarityOf[sorted[p].i] = 'common'
  // 3) 원래 인덱스 순서로 아이템 생성(아이디 안정)
  const items = []
  const byRarity = {}
  RARITIES.forEach(r => (byRarity[r.id] = []))
  for (const c of combos) {
    const seed = c.i * 2654435761
    const rarity = RARITY_BY_ID[rarityOf[c.i]]
    const stats = {}
    const keysShuffled = [...STAT_KEYS].sort((a, b) => rng(seed + a.charCodeAt(0) * 7) - rng(seed + b.charCodeAt(0) * 7))
    for (let s = 0; s < rarity.stats; s++) {
      const key = keysShuffled[s % keysShuffled.length]
      const t = rng(seed + 100 + s * 31)
      const val = Math.round((rarity.mag[0] + t * (rarity.mag[1] - rarity.mag[0])) * 10) / 10
      stats[key] = (stats[key] || 0) + val
    }
    const item = {
      id: 'it' + c.i, name: `${c.prefix} ${c.base}`, emoji: EMOJI_BY_BASE[c.base] || '🍴',
      rarity: rarity.id, rarityName: rarity.name, color: rarity.color, stats,
    }
    items.push(item)
    byRarity[rarity.id].push(item)
  }
  _pool = { items, byRarity, byId: Object.fromEntries(items.map(it => [it.id, it])) }
  return _pool
}

// 중복 보너스: 보유 수 c → 효과 배수
export function dupeMult(count) {
  return 1 + 0.12 * (count - 1)
}

// ---- 테마 (눈 안 피로하게 다양) -------------------------------------------
export const THEMES = [
  { id: 'caramel', name: '카라멜', vars: { '--bg':'#1c1410','--bg2':'#241a14','--panel':'#2a1f17','--panel2':'#33261c','--line':'#43321f','--text':'#f6ead9','--muted':'#b59b80','--accent':'#ffae57','--accent2':'#ff7a3c','--good':'#7fe0a0','--glow':'rgba(255,174,87,.35)' } },
  { id: 'matcha',  name: '말차',   vars: { '--bg':'#0f1813','--bg2':'#13201a','--panel':'#16241d','--panel2':'#1d3026','--line':'#27412f','--text':'#e7f5ec','--muted':'#8fb6a0','--accent':'#7fd98a','--accent2':'#3fbf76','--good':'#9be8b0','--glow':'rgba(127,217,138,.32)' } },
  { id: 'berry',   name: '베리',   vars: { '--bg':'#170f1b','--bg2':'#1f1426','--panel':'#241629','--panel2':'#2f1c35','--line':'#3d2647','--text':'#f6e9f8','--muted':'#b794c0','--accent':'#e879f9','--accent2':'#c026d3','--good':'#86efac','--glow':'rgba(232,121,249,.32)' } },
  { id: 'ocean',   name: '오션',   vars: { '--bg':'#0c1320','--bg2':'#0f1a2c','--panel':'#121f33','--panel2':'#17283f','--line':'#22364f','--text':'#e6f0fb','--muted':'#8aa6c4','--accent':'#56b6ff','--accent2':'#3d7bf0','--good':'#7fe0a0','--glow':'rgba(86,182,255,.32)' } },
  { id: 'cream',   name: '크림',   vars: { '--bg':'#f3ece1','--bg2':'#efe6d7','--panel':'#fffaf2','--panel2':'#f7eee0','--line':'#e2d3bd','--text':'#3a2c1d','--muted':'#8a755c','--accent':'#e8893a','--accent2':'#d2641b','--good':'#2f9e63','--glow':'rgba(232,137,58,.25)' } },
]

// ============================================================================
//  숫자 / 시간 포맷
// ============================================================================
const KO_UNITS = ['','만','억','조','경','해','자','양','구','간','정','재','극','항하사','아승기','나유타','불가사의','무량대수']

export function fmt(n) {
  if (n === Infinity) return '∞'
  if (n === null || n === undefined || isNaN(n)) return '0'
  const neg = n < 0
  n = Math.abs(n)
  let out
  if (n < 1) out = (Math.round(n * 100) / 100).toString()
  else if (n < 10000) {
    out = n < 100 ? (Math.round(n * 10) / 10).toString() : Math.floor(n).toLocaleString('en-US')
  } else {
    const idx = Math.floor(Math.log10(n) / 4)
    if (idx < KO_UNITS.length) {
      const m = n / Math.pow(10, idx * 4)
      const mantissa = m >= 100 ? Math.floor(m) : Math.round(m * 100) / 100
      out = mantissa + KO_UNITS[idx]
    } else {
      out = n.toExponential(2).replace('e+', 'e')
    }
  }
  return neg ? '-' + out : out
}

export function fmtTime(sec) {
  sec = Math.floor(sec)
  if (sec < 60) return `${sec}초`
  const m = Math.floor(sec / 60), s = sec % 60
  if (m < 60) return `${m}분 ${s}초`
  const h = Math.floor(m / 60), mm = m % 60
  if (h < 24) return `${h}시간 ${mm}분`
  const d = Math.floor(h / 24), hh = h % 24
  return `${d}일 ${hh}시간`
}
