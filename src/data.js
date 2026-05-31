// ============================================================================
//  신우 키우기 — 데이터 / 밸런스 / 스킬트리 (대규모 재설계)
//  핵심: 음식마다 [장비수 × 칼로리(g)] 를 [제작시간]마다 생산.
//  처음엔 [획득] 버튼 수동, 스킬로 자동화. 테마=진행단계(편의점→…→공장).
// ============================================================================

export const BAL = {
  startFat: 25,
  startCubes: 12,
  lvK: 2.0,                 // 레벨 곡선(작을수록 느림)
  starPowerBase: 0.04,      // ★1당 전체 칼로리 +4%
  starDivisor: 1e7,
  minCycleTime: 0.4,        // 제작시간 하한(스킬로 줄여도)
  offlineCapHoursBase: 2,
  offlineEffBase: 0.5,
  equipMilestones: [10, 25, 50, 100, 150, 200, 300, 400, 500, 750, 1000],
  collectCarryCap: 1,       // 수동 음식은 최대 1주기까지만 대기(누르게 유도)
}

// ---- 진행 단계(테마) -------------------------------------------------------
export const STAGES = [
  { id: 'conv',    name: '편의점',   bg: 'conv',    vars: pal('#23b3a6', '#159c90', '#eaf6f3', '#244640') },
  { id: 'snack',   name: '분식집',   bg: 'snack',   vars: pal('#ef7d3c', '#df6122', '#fdeede', '#46291a') },
  { id: 'chicken', name: '치킨집',   bg: 'chicken', vars: pal('#e3a02f', '#cc8516', '#fbf0d8', '#4a3717') },
  { id: 'resto',   name: '레스토랑', bg: 'resto',   vars: pal('#c2557a', '#a83c61', '#f8ebf0', '#43222f') },
  { id: 'dept',    name: '백화점',   bg: 'dept',    vars: pal('#cf9b3f', '#b67f22', '#f7f0e0', '#43381f') },
  { id: 'factory', name: '공장',     bg: 'factory', vars: pal('#5b86c4', '#3f69ab', '#eaf0f9', '#22304a') },
]
function pal(accent, accent2, panelTint, text) {
  return {
    '--bg': panelTint, '--bg2': mix(panelTint, '#000', .04),
    '--panel': rgba('#ffffff', .82), '--panel2': rgba('#ffffff', .9),
    '--line': mix(panelTint, '#000', .12), '--text': text, '--muted': mix(text, panelTint, .45),
    '--accent': accent, '--accent2': accent2, '--good': '#2f9e63', '--glow': rgba(accent, .18),
  }
}
function rgba(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})` }
function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16)
  const r = Math.round(((pa >> 16 & 255) * (1 - t) + (pb >> 16 & 255) * t))
  const g = Math.round(((pa >> 8 & 255) * (1 - t) + (pb >> 8 & 255) * t))
  const bl = Math.round(((pa & 255) * (1 - t) + (pb & 255) * t))
  return '#' + [r, g, bl].map(x => x.toString(16).padStart(2, '0')).join('')
}

// ---- 음식 명단 (싼 것 → 비싼 것, 6단계 × 6) --------------------------------
const FOOD_ROSTER = [
  // 편의점
  { id: 'candy', name: '사탕', art: 'n01', stage: 0 }, { id: 'jelly', name: '젤리', art: 'n02', stage: 0 },
  { id: 'choco', name: '초콜릿', art: 'n03', stage: 0 }, { id: 'samgak', name: '삼각김밥', art: 'n04', stage: 0 },
  { id: 'cupramyun', name: '컵라면', art: 'n05', stage: 0 }, { id: 'hotbar', name: '핫바', art: 'n06', stage: 0 },
  // 분식집
  { id: 'ttbk', name: '떡볶이', art: 'f02', stage: 1 }, { id: 'kimbap', name: '김밥', art: 'f03', stage: 1 },
  { id: 'eomuk', name: '어묵', art: 'n07', stage: 1 }, { id: 'sundae', name: '순대', art: 'n08', stage: 1 },
  { id: 'twigim', name: '튀김', art: 'n09', stage: 1 }, { id: 'ramyun', name: '라면', art: 'f04', stage: 1 },
  // 치킨집
  { id: 'fried', name: '후라이드치킨', art: 'f05', stage: 2 }, { id: 'yangnyeom', name: '양념치킨', art: 'n10', stage: 2 },
  { id: 'burger', name: '햄버거', art: 'f07', stage: 2 }, { id: 'fries', name: '감자튀김', art: 'n11', stage: 2 },
  { id: 'hotdog', name: '핫도그', art: 'n12', stage: 2 }, { id: 'cola', name: '콜라', art: 'n13', stage: 2 },
  // 레스토랑
  { id: 'pizza', name: '피자', art: 'f06', stage: 3 }, { id: 'pasta', name: '파스타', art: 'f13', stage: 3 },
  { id: 'steak', name: '스테이크', art: 'f12', stage: 3 }, { id: 'risotto', name: '리조또', art: 'n14', stage: 3 },
  { id: 'salad', name: '샐러드', art: 'n15', stage: 3 }, { id: 'wine', name: '와인', art: 'n16', stage: 3 },
  // 백화점
  { id: 'cake', name: '케이크', art: 'f09', stage: 4 }, { id: 'macaron', name: '마카롱', art: 'f10', stage: 4 },
  { id: 'sushi', name: '초밥', art: 'f11', stage: 4 }, { id: 'hanwoo', name: '한우', art: 'n17', stage: 4 },
  { id: 'parfait', name: '파르페', art: 'n18', stage: 4 }, { id: 'champagne', name: '샴페인', art: 'n19', stage: 4 },
  // 공장
  { id: 'can', name: '통조림', art: 'n20', stage: 5 }, { id: 'frozen', name: '냉동식품', art: 'n21', stage: 5 },
  { id: 'snackbag', name: '과자', art: 'n22', stage: 5 }, { id: 'soda', name: '음료수', art: 'n23', stage: 5 },
  { id: 'conveyor', name: '컨베이어', art: 'n24', stage: 5 }, { id: 'robot', name: '자동화로봇', art: 'n25', stage: 5 },
]

// 인덱스 기반 부드러운 밸런스 곡선
function buildFoods() {
  return FOOD_ROSTER.map((f, i) => {
    const baseCost = 5 * Math.pow(3.25, i)          // 첫 장비 비용
    const payback = 16 + i * 2.3                     // 첫 장비 회수시간(초)
    const time = Math.round(Math.min(360, 1.5 * Math.pow(1.155, i)) * 10) / 10  // 제작시간(초)
    const kcal = (baseCost / payback) * time         // 장비 1개가 1주기에 만드는 칼로리(g)
    const equipMult = Math.max(1.068, 1.11 - i * 0.0011)
    return { ...f, index: i, baseCost, kcal, time, equipMult }
  })
}
export const FOODS = buildFoods()
export const FOOD_BY_ID = Object.fromEntries(FOODS.map(f => [f.id, f]))

export function foodUnitCost(food, owned) { return food.baseCost * Math.pow(food.equipMult, owned) }
export function foodBulkCost(food, owned, k) {
  if (k <= 0) return 0
  const r = food.equipMult
  return food.baseCost * Math.pow(r, owned) * (Math.pow(r, k) - 1) / (r - 1)
}
export function foodMaxBuy(food, owned, budget) {
  const r = food.equipMult, a = food.baseCost * Math.pow(r, owned)
  return Math.max(0, Math.floor(Math.log((budget * (r - 1)) / a + 1) / Math.log(r)))
}
export function equipMilestoneMult(owned, bonusPow = 0) {
  let n = 0; for (const m of BAL.equipMilestones) if (owned >= m) n++
  return Math.pow(2, n) * (1 + bonusPow * n)
}
export function nextEquipMilestone(owned) { for (const m of BAL.equipMilestones) if (owned < m) return m; return null }

// 단계 해금: 누적 칼로리(lifetime) 기준
export function stageThreshold(s) { if (s <= 0) return 0; return FOODS[s * 6].baseCost * 5 }
export function stageForLifetime(lifetime) {
  let s = 0; for (let i = 0; i < STAGES.length; i++) if (lifetime >= stageThreshold(i)) s = i; return s
}

// ============================================================================
//  스킬트리 — 중심에서 뻗어나가는 통합형 200+ 노드 (조건부 잠금해제)
// ============================================================================
function buildSkillTree() {
  const nodes = []
  const push = n => (nodes.push(n), n)
  const TAU = Math.PI * 2

  // 중심
  push({ id: 'root', name: '신우의 부엌', desc: '모든 강화의 시작점', x: 0, y: 0, max: 1, costBase: 0, grow: 1, eff: null, deps: [], free: true })

  // 내부 글로벌 라인들(8방향) — 전체 강화 + 메타
  const globalLines = [
    { key: 'allKcal', name: '전체 칼로리', desc: '모든 음식 칼로리 +8%', eff: { k: 'allKcal', per: 0.08 }, max: 30, costBase: 2, grow: 1.28, ang: 0 },
    { key: 'allTime', name: '전체 제작속도', desc: '모든 음식 제작시간 -4%', eff: { k: 'allTime', per: 0.04 }, max: 18, costBase: 3, grow: 1.33, ang: 1 },
    { key: 'allEquip', name: '전체 장비효율', desc: '모든 음식 장비 효율 +6%', eff: { k: 'allEquip', per: 0.06 }, max: 25, costBase: 3, grow: 1.3, ang: 2 },
    { key: 'star', name: '미슐랭 인맥', desc: '환생 ★ 획득 +6%', eff: { k: 'starGain', per: 0.06 }, max: 20, costBase: 3, grow: 1.32, ang: 3 },
    { key: 'starpow', name: '별의 무게', desc: '★당 보너스 +0.6%p', eff: { k: 'starPow', per: 0.006 }, max: 20, costBase: 4, grow: 1.4, ang: 4 },
    { key: 'off', name: '신선 보관', desc: '오프라인 효율 +6% · 상한 +1시간', eff: { k: 'offline', per: 1 }, max: 12, costBase: 3, grow: 1.32, ang: 5 },
    { key: 'xp', name: '경영 수업', desc: '경험치 +10%', eff: { k: 'xp', per: 0.10 }, max: 20, costBase: 2, grow: 1.28, ang: 6 },
    { key: 'cube', name: '큐브 채굴', desc: '큐브 획득 +10%', eff: { k: 'cube', per: 0.10 }, max: 15, costBase: 3, grow: 1.34, ang: 7 },
  ]
  globalLines.forEach(line => {
    const baseAng = (line.ang / 8) * TAU
    let prev = 'root'
    for (let t = 0; t < 5; t++) {
      const id = `g_${line.key}_${t}`
      const r = 180 + t * 130
      const jitter = (t % 2 ? 0.06 : -0.06)
      push({
        id, name: line.name + (t ? ` ${'I'.repeat(t + 1)}` : ''), desc: line.desc,
        x: Math.cos(baseAng + jitter) * r, y: Math.sin(baseAng + jitter) * r,
        max: Math.ceil(line.max / 5), costBase: Math.ceil(line.costBase * Math.pow(1.5, t)), grow: line.grow,
        eff: line.eff, deps: [{ node: prev, lvl: t === 0 ? 0 : 1 }],
        cond: t >= 2 ? { fat: FOODS[Math.min(35, t * 6)].baseCost } : null,
      })
      prev = id
    }
  })

  // 전체 자동획득 (편의 끝판)
  push({ id: 'g_allauto', name: '전자동 주방', desc: '모든 음식 자동 획득', x: 0, y: -560, max: 1, costBase: 120, grow: 1, eff: { k: 'allAuto', flag: true }, deps: [{ node: 'g_allTime_2', lvl: 1 }], cond: { stage: 3 } })

  // 음식별 클러스터 (각 음식 4~5 노드) — 바깥 링, 단계별로 더 멀리
  FOODS.forEach((food, i) => {
    const ang = (i / FOODS.length) * TAU - Math.PI / 2
    const r0 = 360 + food.stage * 150
    const ux = Math.cos(ang), uy = Math.sin(ang)
    const px = (k) => Math.round(ux * (r0 + k * 95) - uy * ((k % 2 ? 1 : -1) * 26))
    const py = (k) => Math.round(uy * (r0 + k * 95) + ux * ((k % 2 ? 1 : -1) * 26))
    const cond = { stage: food.stage, foodLevel: { food: food.id, equip: 1 } }
    const e = `fe_${food.id}`, kk = `fk_${food.id}`, tt = `ft_${food.id}`, aa = `fa_${food.id}`, mm = `fm_${food.id}`
    push({ id: e, name: `${food.name} · 장비`, desc: `${food.name} 장비 효율 +10%`, x: px(0), y: py(0), max: 15, costBase: 1 + Math.floor(i / 3), grow: 1.32, eff: { k: 'fEquip', food: food.id, per: 0.10 }, deps: [{ node: 'root', lvl: 0 }], cond, cluster: food.id })
    push({ id: kk, name: `${food.name} · 칼로리`, desc: `${food.name} 칼로리 +12%`, x: px(1), y: py(1), max: 15, costBase: 1 + Math.floor(i / 3), grow: 1.34, eff: { k: 'fKcal', food: food.id, per: 0.12 }, deps: [{ node: e, lvl: 3 }], cluster: food.id })
    push({ id: tt, name: `${food.name} · 제작속도`, desc: `${food.name} 제작시간 -6%`, x: px(2), y: py(2), max: 12, costBase: 2 + Math.floor(i / 3), grow: 1.36, eff: { k: 'fTime', food: food.id, per: 0.06 }, deps: [{ node: kk, lvl: 3 }], cluster: food.id })
    push({ id: aa, name: `${food.name} · 자동`, desc: `${food.name} 자동 획득`, x: px(3), y: py(3), max: 1, costBase: 6 + i, grow: 1, eff: { k: 'fAuto', food: food.id, flag: true }, deps: [{ node: tt, lvl: 1 }], cluster: food.id })
    push({ id: mm, name: `${food.name} · 마스터`, desc: `${food.name} 칼로리 +50% · 제작시간 -15%`, x: px(4), y: py(4), max: 1, costBase: 10 + i, grow: 1, eff: { k: 'fMaster', food: food.id }, deps: [{ node: kk, lvl: 8 }, { node: tt, lvl: 6 }], cluster: food.id })
  })

  return { nodes, byId: Object.fromEntries(nodes.map(n => [n.id, n])) }
}
export const SKILLS = buildSkillTree()
export const SKILL_COUNT = SKILLS.nodes.length
export function skillNodeCost(node, lvl) { return Math.ceil(node.costBase * Math.pow(node.grow, lvl)) }

// ---- 레벨 / 환생 -----------------------------------------------------------
export function levelForLifetime(lifetime, xpMult = 1) {
  return Math.floor(BAL.lvK * Math.log10(Math.max(0, lifetime) * (1 + xpMult) + 1))
}
export function lifetimeForLevel(level, xpMult = 1) { return (Math.pow(10, level / BAL.lvK) - 1) / (1 + xpMult) }
export function starsFromRun(runFat, starGain = 0) {
  return Math.floor(Math.sqrt(Math.max(0, runFat) / BAL.starDivisor) * (1 + starGain))
}

// ============================================================================
//  가챠 (보조 시스템) — 결정적 500종 풀, 보유시 효과 영구 합산
// ============================================================================
export const RARITIES = [
  { id: 'common', name: '일반', color: '#9fb0c3', weight: 0.580, stats: 1, mag: [1, 3] },
  { id: 'uncommon', name: '고급', color: '#5fd17a', weight: 0.270, stats: 1, mag: [3, 6] },
  { id: 'rare', name: '희귀', color: '#4ea3ff', weight: 0.100, stats: 2, mag: [6, 11] },
  { id: 'epic', name: '영웅', color: '#b06bff', weight: 0.040, stats: 2, mag: [11, 20] },
  { id: 'legendary', name: '전설', color: '#ffb13d', weight: 0.0085, stats: 3, mag: [20, 35] },
  { id: 'mythic', name: '신화', color: '#ff5d7a', weight: 0.0015, stats: 3, mag: [40, 75] },
]
export const RARITY_BY_ID = Object.fromEntries(RARITIES.map(r => [r.id, r]))
const STAT_DEFS = { kcal: '칼로리', speed: '제작속도', equip: '장비', star: '★', cube: '큐브', luck: '행운' }
export const STAT_KEYS = Object.keys(STAT_DEFS)
export const STAT_LABEL = id => STAT_DEFS[id] || id
const PREFIXES = ['신선한', '바삭한', '매콤한', '달콤한', '황금', '전설의', '수제', '비법', '할매', '미슐랭', '우주', '마법의', '악마의', '천상의', '고대의', '프리미엄', '유기농', '초대형', '미니', '무한']
const GBASE = FOODS.map(f => ({ name: f.name, art: f.art }))
function rng(seed) { let t = (seed + 0x6D2B79F5) | 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
let _pool = null
export function buildGachaPool() {
  if (_pool) return _pool
  const combos = []
  let idx = 0
  GBASE.forEach(base => { for (const prefix of PREFIXES) { combos.push({ i: idx, base, prefix, h: rng(idx * 2654435761 + 7) }); idx++ } })
  const N = combos.length
  const targets = [['mythic', Math.max(5, Math.round(N * 0.012))], ['legendary', Math.max(16, Math.round(N * 0.04))], ['epic', Math.round(N * 0.10)], ['rare', Math.round(N * 0.18)], ['uncommon', Math.round(N * 0.28)]]
  const sorted = [...combos].sort((a, b) => a.h - b.h)
  const rarityOf = {}; let p = 0
  for (const [rid, cnt] of targets) for (let k = 0; k < cnt && p < N; k++, p++) rarityOf[sorted[p].i] = rid
  for (; p < N; p++) rarityOf[sorted[p].i] = 'common'
  const items = [], byRarity = {}; RARITIES.forEach(r => byRarity[r.id] = [])
  for (const c of combos) {
    const seed = c.i * 2654435761, rarity = RARITY_BY_ID[rarityOf[c.i]], stats = {}
    const ks = [...STAT_KEYS].sort((a, b) => rng(seed + a.charCodeAt(0) * 7) - rng(seed + b.charCodeAt(0) * 7))
    for (let s = 0; s < rarity.stats; s++) {
      const key = ks[s % ks.length], t = rng(seed + 100 + s * 31)
      stats[key] = (stats[key] || 0) + Math.round((rarity.mag[0] + t * (rarity.mag[1] - rarity.mag[0])) * 10) / 10
    }
    const item = { id: 'it' + c.i, name: `${c.prefix} ${c.base.name}`, art: c.base.art, rarity: rarity.id, rarityName: rarity.name, color: rarity.color, stats }
    items.push(item); byRarity[rarity.id].push(item)
  }
  _pool = { items, byRarity, byId: Object.fromEntries(items.map(it => [it.id, it])) }
  return _pool
}
export function dupeMult(count) { return 1 + 0.12 * (count - 1) }

// ============================================================================
//  포맷
// ============================================================================
const KO_UNITS = ['', '만', '억', '조', '경', '해', '자', '양', '구', '간', '정', '재', '극', '항하사', '아승기', '나유타', '불가사의', '무량대수']
export function fmt(n) {
  if (n === Infinity) return '∞'
  if (n == null || isNaN(n)) return '0'
  const neg = n < 0; n = Math.abs(n)
  let out
  if (n < 1) out = (Math.round(n * 100) / 100).toString()
  else if (n < 10000) out = n < 100 ? (Math.round(n * 10) / 10).toString() : Math.floor(n).toLocaleString('en-US')
  else {
    const idx = Math.floor(Math.log10(n) / 4)
    if (idx < KO_UNITS.length) {
      const m = n / Math.pow(10, idx * 4)
      out = (m >= 100 ? Math.floor(m) : Math.round(m * 100) / 100) + KO_UNITS[idx]
    } else out = n.toExponential(2).replace('e+', 'e')
  }
  return neg ? '-' + out : out
}
export function fmtTime(sec) {
  sec = Math.max(0, sec)
  if (sec < 10) return (Math.round(sec * 10) / 10) + '초'
  sec = Math.floor(sec)
  if (sec < 60) return sec + '초'
  const m = Math.floor(sec / 60), s = sec % 60
  if (m < 60) return `${m}분 ${s}초`
  const h = Math.floor(m / 60), mm = m % 60
  if (h < 24) return `${h}시간 ${mm}분`
  const d = Math.floor(h / 24); return `${d}일 ${h % 24}시간`
}
