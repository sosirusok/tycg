// ============================================================================
//  신우 키우기 — 게임 엔진 (순수 로직: 상태를 받아 계산/변경)
// ============================================================================
import {
  BAL, GENERATORS, SKILLS, RARITIES, RARITY_BY_ID,
  genBulkCost, genMaxBuy, genMilestoneMult,
  skillNodeCost, levelForLifetime, starsFromRun,
  buildGachaPool, dupeMult,
} from './data.js'

export function defaultState() {
  return {
    version: 1,
    fat: BAL.startFat,
    runFat: 0,          // 이번 환생에서 번 지방(환생 ★ 계산용)
    lifetimeFat: 0,     // 영구 누적(레벨용)
    stars: 0,
    cubes: BAL.startCubes,
    prestigeCount: 0,
    generators: GENERATORS.map(() => 0),
    skills: {},         // nodeId -> level
    skillSpent: 0,
    level: 0,
    milestonesHit: 0,   // 사업 마일스톤 누적(큐브 지급 추적)
    gacha: {},          // itemId -> 보유수(중복 획득 가능, 중복마다 효과 강화)
    pulls: 0,
    buyMode: 1,         // 1 | 10 | 100 | 'max'
    theme: 'caramel',
    lastSeen: Date.now(),
    createdAt: Date.now(),
    stats: { taps: 0, crits: 0, goldens: 0, playMs: 0 },
  }
}

// 런타임 전용(저장 안 함)
export function defaultRuntime() {
  return {
    golden: null,         // {id, leftPct, topPct, ttl}
    buffUntil: 0,         // 황금 버프 종료 시각(ms)
    lastBinge: 0,
    lastAuto: 0,
    combo: 0,
    floatTexts: [],
  }
}

// ---- 파생 수치 계산 --------------------------------------------------------
export function computeStats(state) {
  let prodAdd = 0, earlyAdd = 0, lateAdd = 0, tapAdd = 0, milestonePow = 0
  let costRed = 0, offHours = 0, offEff = 0
  let goldRate = 0, goldVal = 0, critChance = 0, critMult = 0, luck = 0
  let starGain = 0, starPowAdd = 0, prestigeStartAdd = 0, xpMult = 0, cubeMult = 0, collectionAdd = 0
  const flags = { x10: false, x100: false, max: false, auto: false, binge: false }

  for (const branch of Object.values(SKILLS)) {
    for (const node of branch.nodes) {
      const lv = state.skills[node.id] || 0
      if (lv <= 0) continue
      const amt = node.per * lv
      switch (node.k) {
        case 'prodPct': prodAdd += amt; break
        case 'earlyPct': earlyAdd += amt; break
        case 'latePct': lateAdd += amt; break
        case 'tapPct': tapAdd += amt; break
        case 'milestonePow': milestonePow += amt; break
        case 'costRed': costRed += amt; break
        case 'offHours': offHours += amt; break
        case 'offEff': offEff += amt; break
        case 'goldRate': goldRate += amt; break
        case 'goldVal': goldVal += amt; break
        case 'critChance': critChance += amt; break
        case 'critMult': critMult += amt; break
        case 'luck': luck += amt; break
        case 'starGain': starGain += amt; break
        case 'starPow': starPowAdd += amt; break
        case 'prestigeStart': prestigeStartAdd += amt; break
        case 'xp': xpMult += amt; break
        case 'cubeGain': cubeMult += amt; break
        case 'collection': collectionAdd += amt; break
        case 'flag': flags[node.flag] = true; break
      }
    }
  }

  // 가챠 컬렉션 합산(스탯은 % 포인트 단위로 저장)
  const pool = buildGachaPool()
  const g = { prod: 0, tap: 0, star: 0, cube: 0, luck: 0, offline: 0 }
  let distinct = 0
  for (const id in state.gacha) {
    const c = state.gacha[id]
    if (!c) continue
    const it = pool.byId[id]
    if (!it) continue
    distinct++
    const dm = dupeMult(c)
    for (const k in it.stats) g[k] += it.stats[k] * dm
  }
  const collMilestoneProd = Math.floor(distinct / 10) * 2 // 10종마다 생산 +2%p
  g.prod += collMilestoneProd
  const cf = 1 + collectionAdd
  const gProd = (g.prod / 100) * cf
  const gTap = (g.tap / 100) * cf
  const gStar = (g.star / 100) * cf
  const gCube = (g.cube / 100) * cf
  const gLuck = (g.luck / 100) * cf
  const gOff = (g.offline / 100) * cf

  const starPower = BAL.starPowerBase + starPowAdd
  const prestigeMult = 1 + state.stars * starPower

  return {
    prodMult: (1 + prodAdd) * (1 + gProd) * prestigeMult,
    earlyMult: 1 + earlyAdd,
    lateMult: 1 + lateAdd,
    tapMult: (1 + tapAdd) * (1 + gTap),
    milestonePow,
    costRed: Math.min(0.6, costRed),
    offHours: BAL.offlineCapHoursBase + offHours,
    offEff: BAL.offlineEffBase + offEff + gOff,
    goldRate: 1 + goldRate,
    goldVal: 1 + goldVal,
    critChance: BAL.critChanceBase + critChance,
    critMult: BAL.critMultBase + critMult,
    luck: Math.min(0.45, luck + gLuck),
    starGain: starGain + gStar,
    starPower,
    prestigeMult,
    prestigeStartMult: 1 + prestigeStartAdd,
    xpMult,
    cubeMult: 1 + cubeMult + gCube,
    collectionAdd,
    distinct,
    flags,
  }
}

// 사업별 초당 생산(버프 제외, 표시는 안정적으로)
export function genIncome(state, stats, idx) {
  const gen = GENERATORS[idx]
  const owned = state.generators[idx]
  if (owned <= 0) return 0
  const extra = idx < 6 ? stats.earlyMult : stats.lateMult
  return owned * gen.baseRev * genMilestoneMult(owned, stats.milestonePow) * extra * stats.prodMult
}

export function incomePerSec(state, stats) {
  let sum = 0
  for (let i = 0; i < GENERATORS.length; i++) sum += genIncome(state, stats, i)
  return sum
}

// ---- 구매 ------------------------------------------------------------------
export function buyInfo(state, stats, idx) {
  const gen = GENERATORS[idx]
  const owned = state.generators[idx]
  const disc = 1 - stats.costRed
  const mode = state.buyMode
  let k
  if (mode === 'max') k = genMaxBuy(gen, owned, state.fat / disc)
  else k = Math.min(mode, genMaxBuy(gen, owned, state.fat / disc))
  if (mode !== 'max' && k < mode) {
    // 부족하면 정가(요청수량) 표시
    const fullCost = genBulkCost(gen, owned, mode) * disc
    return { k: mode, cost: fullCost, affordable: false }
  }
  const cost = genBulkCost(gen, owned, k) * disc
  return { k, cost, affordable: k > 0 }
}

export function buyGenerator(state, stats, idx) {
  const info = buyInfo(state, stats, idx)
  if (!info.affordable || info.k <= 0) return null
  state.fat -= info.cost
  state.generators[idx] += info.k
  return info
}

// ---- 스킬 ------------------------------------------------------------------
export function availablePoints(state) {
  return state.level - state.skillSpent
}
export function findSkill(nodeId) {
  for (const bid in SKILLS) {
    const n = SKILLS[bid].nodes.find(x => x.id === nodeId)
    if (n) return { branch: bid, node: n }
  }
  return null
}
export function learnSkill(state, nodeId) {
  const f = findSkill(nodeId)
  if (!f) return false
  const cur = state.skills[nodeId] || 0
  if (cur >= f.node.max) return false
  const cost = skillNodeCost(f.node, cur)
  if (availablePoints(state) < cost) return false
  state.skills[nodeId] = cur + 1
  state.skillSpent += cost
  return true
}

// ---- 환생(미슐랭 ★) --------------------------------------------------------
export function prestigeGain(state, stats) {
  return starsFromRun(state.runFat, stats.starGain)
}
export function doPrestige(state, stats) {
  const gain = prestigeGain(state, stats)
  if (gain <= 0) return 0
  state.stars += gain
  state.prestigeCount++
  state.cubes += Math.floor(gain / 3) + 3
  // 리셋: 사업/지방. (스킬/레벨/가챠/★ 유지)
  state.generators = GENERATORS.map(() => 0)
  state.fat = BAL.startFat * stats.prestigeStartMult
  state.runFat = 0
  return gain
}

// ---- 가챠 ------------------------------------------------------------------
function rollRarity(luck) {
  // 행운: common 가중치 일부를 상위로 비례 이동
  const shift = Math.min(0.45, luck)
  const base = RARITIES.map(r => r.weight)
  const commonIdx = 0
  const moved = base[commonIdx] * shift
  base[commonIdx] -= moved
  const restTotal = base.slice(1).reduce((a, b) => a + b, 0)
  for (let i = 1; i < base.length; i++) base[i] += moved * (base[i] / restTotal)
  let roll = Math.random(), acc = 0
  for (let i = 0; i < RARITIES.length; i++) { acc += base[i]; if (roll <= acc) return RARITIES[i] }
  return RARITIES[0]
}
export const PULL_COST = { 1: 1, 10: 10 }
export function pull(state, stats, n) {
  const cost = PULL_COST[n]
  if (state.cubes < cost) return null
  state.cubes -= cost
  const pool = buildGachaPool()
  const results = []
  let gotRarePlus = false
  for (let i = 0; i < n; i++) {
    let rar = rollRarity(stats.luck)
    if (RARITIES.indexOf(rar) >= 2) gotRarePlus = true
    // 10연차 마지막 희귀+ 보장
    if (n === 10 && i === n - 1 && !gotRarePlus) rar = RARITY_BY_ID.rare
    const bucket = pool.byRarity[rar.id]
    const item = bucket[Math.floor(Math.random() * bucket.length)]
    const before = state.gacha[item.id] || 0
    state.gacha[item.id] = before + 1
    results.push({ item, isNew: before === 0, count: before + 1 })
  }
  state.pulls += n
  return results
}

// ---- 탭(신우 먹이기) -------------------------------------------------------
export function tap(state, stats, income) {
  const base = Math.max(BAL.tapBaseFlat, income * BAL.tapIncomeFrac) * stats.tapMult
  const isCrit = Math.random() < stats.critChance
  const gain = base * (isCrit ? stats.critMult : 1)
  earn(state, gain)
  state.stats.taps++
  if (isCrit) state.stats.crits++
  return { gain, crit: isCrit }
}

export function earn(state, amt) {
  state.fat += amt
  state.runFat += amt
  state.lifetimeFat += amt
}

// ---- 틱 --------------------------------------------------------------------
export function tick(state, stats, rt, dtSec, now) {
  const income = incomePerSec(state, stats)
  const buffed = now < rt.buffUntil ? BAL.goldenBuffMult : 1
  earn(state, income * dtSec * buffed)
  state.stats.playMs += dtSec * 1000

  // 황금 음식 스폰
  if (!rt.golden) {
    const chance = BAL.goldenBaseChancePerSec * stats.goldRate * dtSec
    if (Math.random() < chance) {
      rt.golden = {
        id: 'gold' + now,
        leftPct: 8 + Math.random() * 78,
        topPct: 15 + Math.random() * 60,
        ttl: 9,
      }
    }
  } else {
    rt.golden.ttl -= dtSec
    if (rt.golden.ttl <= 0) rt.golden = null
  }

  // 폭식 모드(자동 버프)
  if (stats.flags.binge && now - rt.lastBinge > 90000) {
    rt.lastBinge = now
    rt.buffUntil = Math.max(rt.buffUntil, now) + BAL.goldenBuffSecs * 1000
  }

  // 자동 경영(가장 싼 사업 1개, 보유 지방의 25% 이내, 1초 간격)
  if (stats.flags.auto && now - rt.lastAuto > 1000) {
    rt.lastAuto = now
    let best = -1, bestCost = Infinity
    for (let i = 0; i < GENERATORS.length; i++) {
      const c = GENERATORS[i].baseCost * Math.pow(GENERATORS[i].mult, state.generators[i]) * (1 - stats.costRed)
      if (c < bestCost) { bestCost = c; best = i }
    }
    if (best >= 0 && bestCost <= state.fat * 0.25) {
      state.fat -= bestCost
      state.generators[best] += 1
    }
  }

  // 레벨 / 큐브
  const newLevel = levelForLifetime(state.lifetimeFat, stats.xpMult)
  let leveledUp = 0
  if (newLevel > state.level) {
    leveledUp = newLevel - state.level
    state.cubes += Math.max(1, Math.floor(leveledUp * BAL.cubePerLevel * stats.cubeMult))
    state.level = newLevel
  }
  // 사업 마일스톤 달성 시 큐브(가챠 주 공급원)
  let mh = 0
  for (let i = 0; i < GENERATORS.length; i++) { const c = state.generators[i]; for (const m of BAL.milestones) if (c >= m) mh++ }
  if (mh > (state.milestonesHit || 0)) {
    state.cubes += Math.floor((mh - (state.milestonesHit || 0)) * BAL.cubePerMilestone * stats.cubeMult)
    state.milestonesHit = mh
  }
  return { income, buffed: buffed > 1, leveledUp }
}

export function collectGolden(state, stats, rt, now) {
  if (!rt.golden) return 0
  const income = incomePerSec(state, stats)
  const reward = Math.max(state.fat * 0.05, income * BAL.goldenRewardSecs * stats.goldVal)
  earn(state, reward)
  rt.buffUntil = Math.max(rt.buffUntil, now) + BAL.goldenBuffSecs * 1000
  rt.golden = null
  state.stats.goldens++
  if (Math.random() < 0.25) state.cubes += 1
  return reward
}

// ---- 오프라인 보상 ---------------------------------------------------------
export function applyOffline(state, stats, now) {
  const dt = Math.max(0, (now - state.lastSeen) / 1000)
  if (dt < 30) return null
  const cap = stats.offHours * 3600
  const t = Math.min(dt, cap)
  const income = incomePerSec(state, stats)
  const gain = income * t * stats.offEff
  if (gain <= 0) return null
  earn(state, gain)
  return { dt, t, gain, capped: dt > cap, eff: stats.offEff }
}
