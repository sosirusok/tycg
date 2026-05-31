// ============================================================================
//  신우 키우기 — 데이터/밸런스 v4
//  음식: 장비수 × 칼로리 / 제작시간. 테마 9단계(지방 "소모"로 진행).
//  강화축: 음식 / 스킬트리(테마별 가지) / 펫(6등급×10성) / 명성상점(영구).
//  레벨: 환생 후 누적수익(runFat) 기준. 환생 → 명성 + 전부 초기화(명성상점 영구).
// ============================================================================

export const BAL = {
  startFat: 30,
  startCubes: 10,
  lvK: 3.0,                 // 레벨 곡선(환생후 누적 runFat 기준)
  fameDivisor: 1e9,         // 명성 ∝ sqrt(runFat / divisor)
  minCycleTime: 0.35,
  offlineCapHoursBase: 2,
  offlineEffBase: 0.5,
  petSlotsBase: 1,
  equipMilestones: [10, 25, 50, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000],
}

// ---- 9단계 테마 (작은 노점 → 차원의 만찬) ---------------------------------
export const THEMES = [
  { id: 'conv',    name: '편의점 거리',     bg: 'conv',    vars: pal('#23b3a6', '#159c90', '#eaf6f3', '#244640') },
  { id: 'snack',   name: '분식 골목',       bg: 'snack',   vars: pal('#ef7d3c', '#df6122', '#fdeede', '#46291a') },
  { id: 'chicken', name: '치킨·호프 거리',  bg: 'chicken', vars: pal('#e3a02f', '#cc8516', '#fbf0d8', '#4a3717') },
  { id: 'resto',   name: '비스트로',        bg: 'resto',   vars: pal('#c2557a', '#a83c61', '#f8ebf0', '#43222f') },
  { id: 'dept',    name: '백화점 식품관',   bg: 'dept',    vars: pal('#cf9b3f', '#b67f22', '#f7f0e0', '#43381f') },
  { id: 'factory', name: '스마트 푸드공장', bg: 'factory', vars: pal('#5b86c4', '#3f69ab', '#eaf0f9', '#22304a') },
  { id: 'corp',    name: '글로벌 식품제국', bg: 'corp',    vars: pal('#3aa6c9', '#2486a8', '#e9f4f8', '#1f3a44') },
  { id: 'space',   name: '궤도 미식 정거장', bg: 'space',  vars: pal('#6f8fe0', '#4f6fd0', '#eef0fb', '#222a4a') },
  { id: 'cosmic',  name: '차원의 만찬',     bg: 'cosmic',  vars: pal('#a877e6', '#8a52d6', '#1c1630', '#f3ecff', true) },
]
function pal(accent, accent2, bg, text, dark) {
  return {
    '--bg': bg, '--bg2': mix(bg, dark ? '#fff' : '#000', .05),
    '--panel': dark ? rgba('#241a36', .8) : rgba('#ffffff', .82), '--panel2': dark ? rgba('#2c2142', .9) : rgba('#ffffff', .92),
    '--line': dark ? '#3c3056' : mix(bg, '#000', .12), '--text': text, '--muted': mix(text, bg, .42),
    '--accent': accent, '--accent2': accent2, '--good': dark ? '#7fe0a0' : '#2f9e63', '--glow': rgba(accent, .2),
  }
}
function rgba(h, a) { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})` }
function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16)
  const c = i => Math.round(((pa >> i & 255) * (1 - t) + (pb >> i & 255) * t))
  return '#' + [c(16), c(8), c(0)].map(x => x.toString(16).padStart(2, '0')).join('')
}

// ---- 72 음식 (9테마 × 8), 격차 크게 ---------------------------------------
const ROSTER = [
  // 편의점 거리
  ['candy','사탕','n01'],['jelly','젤리','n02'],['choco','초콜릿','n03'],['snackbag','과자','m04'],
  ['samgak','삼각김밥','n04'],['cupramyun','컵라면','n05'],['hotbar','핫바','n06'],['cola','콜라','n13'],
  // 분식 골목
  ['boong','붕어빵','f01'],['ttbk','떡볶이','f02'],['kimbap','김밥','f03'],['eomuk','어묵','n07'],
  ['sundae','순대','n08'],['twigim','튀김','n09'],['ramyun','라면','f04'],['hotdog','핫도그','n12'],
  // 치킨·호프
  ['fried','후라이드치킨','f05'],['yangnyeom','양념치킨','n10'],['burger','햄버거','f07'],['fries','감자튀김','n11'],
  ['gopchang','곱창','f16'],['samgyup','삼겹살','f17'],['beer','맥주','m01'],['soda','음료수','n23'],
  // 비스트로
  ['pizza','피자','f06'],['pasta','파스타','f13'],['steak','스테이크','f12'],['risotto','리조또','n14'],
  ['salad','샐러드','n15'],['wine','와인','n16'],['tangsu','탕수육','f15'],['jjajang','짜장면','f14'],
  // 백화점 식품관
  ['cake','케이크','f09'],['macaron','마카롱','f10'],['sushi','초밥','f11'],['donut','도넛','f08'],
  ['parfait','파르페','n18'],['bingsu','빙수','f19'],['icecream','아이스크림','f20'],['coffee','커피','f21'],
  // 스마트 푸드공장
  ['can','통조림','n20'],['frozen','냉동식품','n21'],['instantrice','즉석밥','m02'],['ramyunbox','라면 묶음','m03'],
  ['drinkpack','음료 팩','m05'],['conveyor','컨베이어','n24'],['robot','자동화로봇','n25'],['bigpan','대형 조리라인','f24'],
  // 글로벌 식품제국
  ['mealkit','밀키트','m06'],['capsule','영양 캡슐','m07'],['proteinbar','단백질바','m08'],['shake','프로틴 쉐이크','m09'],
  ['stock','식품 주식','m10'],['brand','브랜드','m11'],['logistics','물류 센터','m12'],['hq','본사 빌딩','m13'],
  // 궤도 미식 정거장
  ['spacefood','우주 식량','m14'],['freezeice','동결건조 아이스크림','m15'],['zerojelly','무중력 젤리','m16'],['tubefood','튜브 음식','m17'],
  ['meteorcandy','운석 사탕','m18'],['alienfruit','외계 과일','m19'],['nebulasoup','성운 수프','m20'],['station','우주 정거장','m21'],
  // 차원의 만찬
  ['blackhole','블랙홀 커피','m22'],['galaxycake','은하 케이크','m23'],['starlight','별빛 사탕','m24'],['warpbread','시공간 빵','m25'],
  ['portal','차원의 문','m26'],['infinity','무한 칼로리','m27'],['feast','신의 만찬','m28'],['bigbang','빅뱅','m29'],
]
function buildFoods() {
  return ROSTER.map((r, i) => {
    const stage = Math.floor(i / 8)
    const baseCost = 12 * Math.pow(5.5, i)            // ×5.5/음식 (격차 큼)
    const payback = 28 + i * 1.7                       // 첫 장비 회수시간(초)
    const time = Math.round(Math.min(600, 2.5 * Math.pow(1.125, i)) * 10) / 10
    const kcal = (baseCost / payback) * time
    const equipMult = Math.max(1.068, 1.115 - i * 0.0006)
    return { id: r[0], name: r[1], art: r[2], index: i, stage, baseCost, kcal, time, equipMult }
  })
}
export const FOODS = buildFoods()
export const FOOD_BY_ID = Object.fromEntries(FOODS.map(f => [f.id, f]))
export const STAGE_FOODS = THEMES.map((_, s) => FOODS.filter(f => f.stage === s))

export function foodUnitCost(f, owned) { return f.baseCost * Math.pow(f.equipMult, owned) }
export function foodBulkCost(f, owned, k) { if (k <= 0) return 0; const r = f.equipMult; return f.baseCost * Math.pow(r, owned) * (Math.pow(r, k) - 1) / (r - 1) }
export function foodMaxBuy(f, owned, budget) { const r = f.equipMult, a = f.baseCost * Math.pow(r, owned); return Math.max(0, Math.floor(Math.log((budget * (r - 1)) / a + 1) / Math.log(r))) }
export function equipMilestoneMult(owned, bonusPow = 0) { let n = 0; for (const m of BAL.equipMilestones) if (owned >= m) n++; return Math.pow(2, n) * (1 + bonusPow * n) }
export function nextEquipMilestone(owned) { let prev = 0; for (const m of BAL.equipMilestones) { if (owned < m) return { next: m, prev }; prev = m } return { next: null, prev } }

// 테마 진행: 다음 테마로 넘어갈 때 지방을 "소모"
export function stageAdvanceCost(stage) {
  if (stage + 1 >= THEMES.length) return Infinity
  return FOODS[(stage + 1) * 8].baseCost * 12
}

// ---- 스킬트리: 중심에서 테마별 9가지로 뻗는 구조 + 중앙 글로벌 -------------
function buildSkillTree() {
  const nodes = []
  const push = n => (nodes.push(n), n)
  const TAU = Math.PI * 2
  push({ id: 'root', name: '신우의 부엌', desc: '모든 강화의 시작점', x: 0, y: 0, max: 1, costBase: 0, grow: 1, eff: null, deps: [], free: true })

  // 중앙 글로벌 라인 (안쪽 8방향)
  const G = [
    ['allKcal', '전체 칼로리', '모든 음식 칼로리 +7%', { k: 'allKcal', per: 0.07 }, 6, 2, 1.27],
    ['allTime', '전체 제작속도', '모든 음식 제작시간 -3%', { k: 'allTime', per: 0.03 }, 5, 3, 1.32],
    ['allEquip', '전체 장비효율', '모든 음식 장비효율 +5%', { k: 'allEquip', per: 0.05 }, 6, 3, 1.29],
    ['fame', '명성가도', '환생 명성 +5%', { k: 'fameGain', per: 0.05 }, 8, 3, 1.3],
    ['off', '신선 보관', '오프라인 효율+6%·상한+1h', { k: 'offline', per: 1 }, 6, 3, 1.3],
    ['xp', '경영 수업', '경험치 +8%', { k: 'xp', per: 0.08 }, 8, 2, 1.27],
    ['cube', '큐브 채굴', '큐브 +10%', { k: 'cube', per: 0.10 }, 6, 3, 1.32],
    ['petslot', '펫 친화', '펫 슬롯 +1', { k: 'petSlot', per: 1 }, 4, 12, 1.8],
  ]
  G.forEach((g, gi) => {
    const ang = (gi / 8) * TAU; let prev = 'root'
    for (let t = 0; t < g[4]; t++) {
      const id = `g_${g[0]}_${t}`, r = 170 + t * 120
      push({ id, name: g[1] + (t ? ` ${t + 1}` : ''), desc: g[2], x: Math.round(Math.cos(ang) * r), y: Math.round(Math.sin(ang) * r), max: 1 + Math.floor((g[4] - t)), costBase: Math.ceil(g[5] * Math.pow(1.5, t)), grow: g[6], eff: g[3], deps: [{ node: prev, lvl: t === 0 ? 0 : 1 }] })
      prev = id
    }
  })

  // 테마별 가지 (9개) — 바깥쪽으로
  THEMES.forEach((th, s) => {
    const ang = (s / THEMES.length) * TAU - Math.PI / 2
    const ux = Math.cos(ang), uy = Math.sin(ang), base = 560
    const at = (k, off) => ({ x: Math.round(ux * (base + k * 92) - uy * off), y: Math.round(uy * (base + k * 92) + ux * off) })
    const gate = `s_gate_${s}`
    push({ id: gate, name: `${th.name}`, desc: `${th.name} 특화 가지`, ...at(0, 0), max: 1, costBase: 3 + s * 2, grow: 1, eff: { k: 'sKcal', stage: s, per: 0.10 }, deps: [{ node: 'root', lvl: 0 }], cond: { stage: s }, branch: s, gate: true })
    let prev = gate
    for (let t = 0; t < 5; t++) { const id = `s_kcal_${s}_${t}`; push({ id, name: `${th.name} 칼로리 ${t + 2}`, desc: `${th.name} 음식 칼로리 +12%`, ...at(1 + t, -30), max: 4, costBase: 2 + s * 2 + t, grow: 1.3, eff: { k: 'sKcal', stage: s, per: 0.12 }, deps: [{ node: prev, lvl: 1 }], branch: s }); prev = id }
    let prev2 = gate
    for (let t = 0; t < 4; t++) { const id = `s_time_${s}_${t}`; push({ id, name: `${th.name} 속도 ${t + 1}`, desc: `${th.name} 제작시간 -5%`, ...at(1 + t, 34), max: 3, costBase: 3 + s * 2 + t, grow: 1.34, eff: { k: 'sTime', stage: s, per: 0.05 }, deps: [{ node: prev2, lvl: 1 }], branch: s }); prev2 = id }
    push({ id: `s_auto_${s}`, name: `${th.name} 자동화`, desc: `${th.name} 모든 음식 자동 획득`, ...at(5, 36), max: 1, costBase: 14 + s * 4, grow: 1, eff: { k: 'sAuto', stage: s, flag: true }, deps: [{ node: prev2, lvl: 1 }], branch: s })
    // 음식별 개별 자동 노드 (조기 자동화)
    STAGE_FOODS[s].forEach((f, fi) => {
      push({ id: `f_${f.id}`, name: `${f.name} 자동`, desc: `${f.name} 자동 획득 + 칼로리 +20%`, ...at(2 + (fi % 4), 70 + Math.floor(fi / 4) * 36 + (fi % 2) * 14), max: 1, costBase: 4 + s * 2, grow: 1, eff: { k: 'fBoost', food: f.id }, deps: [{ node: gate, lvl: 1 }], cond: { foodLevel: { food: f.id, equip: 1 } }, branch: s })
    })
  })
  return { nodes, byId: Object.fromEntries(nodes.map(n => [n.id, n])) }
}
export const SKILLS = buildSkillTree()
export const SKILL_COUNT = SKILLS.nodes.length
export function skillNodeCost(node, lvl) { return Math.ceil(node.costBase * Math.pow(node.grow, lvl)) }

// ---- 명성 상점 (영구) ------------------------------------------------------
export const FAME_SHOP = [
  { id: 'fa_kcal', name: '영구 칼로리', desc: '전체 칼로리 +10% (영구)', max: 50, costBase: 2, grow: 1.22, eff: { k: 'fameKcal', per: 0.10 } },
  { id: 'fa_time', name: '영구 제작속도', desc: '전체 제작시간 -3% (영구)', max: 20, costBase: 3, grow: 1.28, eff: { k: 'fameTime', per: 0.03 } },
  { id: 'fa_equip', name: '영구 장비효율', desc: '전체 장비효율 +6% (영구)', max: 30, costBase: 3, grow: 1.24, eff: { k: 'fameEquip', per: 0.06 } },
  { id: 'fa_start', name: '재기의 자본', desc: '환생 시작 지방 ×8', max: 18, costBase: 2, grow: 1.3, eff: { k: 'fameStart', per: 1 } },
  { id: 'fa_petslot', name: '펫 보유 +1', desc: '펫 동시 착용 +1', max: 8, costBase: 10, grow: 1.7, eff: { k: 'famePetSlot', per: 1 } },
  { id: 'fa_offline', name: '영구 신선보관', desc: '오프라인 효율+8%·상한+2h', max: 12, costBase: 4, grow: 1.32, eff: { k: 'fameOffline', per: 1 } },
  { id: 'fa_sp', name: '영재 교육', desc: '환생 후 시작 스킬포인트 +2', max: 20, costBase: 4, grow: 1.28, eff: { k: 'fameSP', per: 2 } },
  { id: 'fa_fame', name: '명성 가도', desc: '명성 획득 +8%', max: 25, costBase: 5, grow: 1.3, eff: { k: 'fameGain', per: 0.08 } },
  { id: 'fa_cube', name: '큐브 인맥', desc: '큐브 획득 +12%', max: 15, costBase: 4, grow: 1.3, eff: { k: 'fameCube', per: 0.12 } },
  { id: 'fa_auto0', name: '자동 군것질', desc: '1단계(편의점) 음식 영구 자동', max: 1, costBase: 25, grow: 1, eff: { k: 'fameAutoStage', stage: 0, flag: true } },
  { id: 'fa_auto1', name: '자동 분식', desc: '2단계(분식) 음식 영구 자동', max: 1, costBase: 60, grow: 1, eff: { k: 'fameAutoStage', stage: 1, flag: true } },
  { id: 'fa_global', name: '미식 제국의 위엄', desc: '전체 칼로리 +25% (영구·강력)', max: 30, costBase: 12, grow: 1.33, eff: { k: 'fameKcal', per: 0.25 } },
]
export function fameNodeCost(node, lvl) { return Math.ceil(node.costBase * Math.pow(node.grow, lvl)) }

// ---- 펫 (6등급 × 1~10성) ---------------------------------------------------
export const PET_GRADES = [
  { id: 'common', name: '일반', color: '#9fb0c3', art: 'pet1', inc: 0.05, price1: 4e3, price6: 1.2e5 },
  { id: 'uncommon', name: '희귀', color: '#5fd17a', art: 'pet2', inc: 0.12, price1: 1.5e5, price6: 4.5e6 },
  { id: 'rare', name: '초희귀', color: '#4ea3ff', art: 'pet3', inc: 0.30, price1: 6e6, price6: 1.8e8 },
  { id: 'epic', name: '에픽', color: '#b06bff', art: 'pet4', inc: 0.72, price1: 2.4e8, price6: 7e9 },
  { id: 'legendary', name: '전설', color: '#ffb13d', art: 'pet5', inc: 1.7, price1: 9e9, price6: 2.7e11 },
  { id: 'mythic', name: '신화', color: '#ff5d7a', art: 'pet6', inc: 4.0, price1: 3.5e11, price6: 1e13 },
]
export const PET_GRADE_BY_ID = Object.fromEntries(PET_GRADES.map((g, i) => [g.id, { ...g, idx: i }]))
export const PET_STAR_MAX = 10
export function petKey(grade, star) { return `${grade}:${star}` }
export function parsePetKey(k) { const [g, s] = k.split(':'); return { grade: g, star: +s } }
// 등급/성에 따라 능력치 종류가 늘어남
export function petStats(grade, star) {
  const g = PET_GRADE_BY_ID[grade]; if (!g) return {}
  const gi = g.idx, k = star - 1
  const st = { income: g.inc * (1 + 0.15 * k) }            // 모든 펫: 수익률%
  if (gi >= 1) st.time = (0.01 + 0.004 * gi) * (1 + 0.12 * k)   // 제작시간 감소%
  if (gi >= 2) st.offline = (0.04 + 0.02 * gi) * (1 + 0.1 * k)  // 오프라인 효율%
  if (gi >= 3) st.cube = (0.05 + 0.03 * gi) * (1 + 0.1 * k)     // 큐브 획득%
  if (gi >= 4) st.fame = (0.05 + 0.04 * gi) * (1 + 0.1 * k)     // 명성 획득%
  if (gi >= 5) st.equip = (0.08) * (1 + 0.12 * k)               // 장비효율%
  return st
}
export const PET_STAT_LABEL = { income: '수익률', time: '제작시간↓', offline: '오프라인', cube: '큐브', fame: '명성', equip: '장비효율' }
// 상점 가격(1성 또는 6성만 판매)
export function petBuyPrice(grade, star) { const g = PET_GRADE_BY_ID[grade]; return star === 1 ? g.price1 : g.price6 }

// ---- 레벨(환생 후 누적 runFat) / 명성 -------------------------------------
export function levelForRun(runFat, xpMult = 1) { return Math.floor(BAL.lvK * Math.log10(Math.max(0, runFat) * (1 + xpMult) + 1)) }
export function runForLevel(level, xpMult = 1) { return (Math.pow(10, level / BAL.lvK) - 1) / (1 + xpMult) }
export function fameFromRun(runFat, gain = 0) { return Math.floor(Math.sqrt(Math.max(0, runFat) / BAL.fameDivisor) * (1 + gain)) }

// ============================================================================
//  가챠 (보조) — 결정적 풀
// ============================================================================
export const RARITIES = [
  { id: 'common', name: '일반', color: '#9fb0c3', weight: 0.58, stats: 1, mag: [1, 3] },
  { id: 'uncommon', name: '고급', color: '#5fd17a', weight: 0.27, stats: 1, mag: [3, 6] },
  { id: 'rare', name: '희귀', color: '#4ea3ff', weight: 0.10, stats: 2, mag: [6, 11] },
  { id: 'epic', name: '영웅', color: '#b06bff', weight: 0.04, stats: 2, mag: [11, 20] },
  { id: 'legendary', name: '전설', color: '#ffb13d', weight: 0.0085, stats: 3, mag: [20, 35] },
  { id: 'mythic', name: '신화', color: '#ff5d7a', weight: 0.0015, stats: 3, mag: [40, 75] },
]
export const RARITY_BY_ID = Object.fromEntries(RARITIES.map(r => [r.id, r]))
const STAT_DEFS = { kcal: '칼로리', speed: '제작속도', equip: '장비', fame: '명성', cube: '큐브', luck: '행운' }
export const STAT_KEYS = Object.keys(STAT_DEFS)
export const STAT_LABEL = id => STAT_DEFS[id] || id
const PREFIXES = ['신선한', '바삭한', '매콤한', '달콤한', '황금', '전설의', '수제', '비법', '할매', '미슐랭', '우주', '마법의', '악마의', '천상의', '고대의', '프리미엄', '유기농', '초대형', '미니', '무한']
const GBASE = FOODS.map(f => ({ name: f.name, art: f.art }))
function rng(seed) { let t = (seed + 0x6D2B79F5) | 0; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 }
let _pool = null
export function buildGachaPool() {
  if (_pool) return _pool
  const combos = []; let idx = 0
  GBASE.forEach(b => { for (const p of PREFIXES) { combos.push({ i: idx, base: b, prefix: p, h: rng(idx * 2654435761 + 7) }); idx++ } })
  const N = combos.length
  const targets = [['mythic', Math.max(6, Math.round(N * 0.012))], ['legendary', Math.max(18, Math.round(N * 0.04))], ['epic', Math.round(N * 0.10)], ['rare', Math.round(N * 0.18)], ['uncommon', Math.round(N * 0.28)]]
  const sorted = [...combos].sort((a, b) => a.h - b.h); const rarityOf = {}; let p = 0
  for (const [rid, cnt] of targets) for (let k = 0; k < cnt && p < N; k++, p++) rarityOf[sorted[p].i] = rid
  for (; p < N; p++) rarityOf[sorted[p].i] = 'common'
  const items = [], byRarity = {}; RARITIES.forEach(r => byRarity[r.id] = [])
  for (const c of combos) {
    const seed = c.i * 2654435761, rar = RARITY_BY_ID[rarityOf[c.i]], stats = {}
    const ks = [...STAT_KEYS].sort((a, b) => rng(seed + a.charCodeAt(0) * 7) - rng(seed + b.charCodeAt(0) * 7))
    for (let s = 0; s < rar.stats; s++) { const key = ks[s % ks.length], t = rng(seed + 100 + s * 31); stats[key] = (stats[key] || 0) + Math.round((rar.mag[0] + t * (rar.mag[1] - rar.mag[0])) * 10) / 10 }
    const it = { id: 'it' + c.i, name: `${c.prefix} ${c.base.name}`, art: c.base.art, rarity: rar.id, rarityName: rar.name, color: rar.color, stats }
    items.push(it); byRarity[rar.id].push(it)
  }
  _pool = { items, byRarity, byId: Object.fromEntries(items.map(it => [it.id, it])) }
  return _pool
}
export function dupeMult(c) { return 1 + 0.12 * (c - 1) }

// ============================================================================
//  포맷
// ============================================================================
const KO = ['', '만', '억', '조', '경', '해', '자', '양', '구', '간', '정', '재', '극', '항하사', '아승기', '나유타', '불가사의', '무량대수']
export function fmt(n) {
  if (n === Infinity) return '∞'
  if (n == null || isNaN(n)) return '0'
  const neg = n < 0; n = Math.abs(n); let out
  if (n < 1) out = (Math.round(n * 100) / 100).toString()
  else if (n < 1e4) out = n < 100 ? (Math.round(n * 10) / 10).toString() : Math.floor(n).toLocaleString('en-US')
  else { const idx = Math.floor(Math.log10(n) / 4); if (idx < KO.length) { const m = n / Math.pow(10, idx * 4); out = (m >= 100 ? Math.floor(m) : Math.round(m * 100) / 100) + KO[idx] } else out = n.toExponential(2).replace('e+', 'e') }
  return neg ? '-' + out : out
}
export function fmtTime(sec) {
  sec = Math.max(0, sec)
  if (sec < 10) return (Math.round(sec * 10) / 10) + '초'
  sec = Math.floor(sec); if (sec < 60) return sec + '초'
  const m = Math.floor(sec / 60), s = sec % 60; if (m < 60) return `${m}분 ${s}초`
  const h = Math.floor(m / 60), mm = m % 60; if (h < 24) return `${h}시간 ${mm}분`
  const d = Math.floor(h / 24); return `${d}일 ${h % 24}시간`
}
