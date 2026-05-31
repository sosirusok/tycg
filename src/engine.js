// ============================================================================
//  신우 키우기 — 엔진 (장비수 × 칼로리 / 제작시간, 수동 획득→자동, 단계 진행)
// ============================================================================
import {
  BAL, FOODS, FOOD_BY_ID, SKILLS, RARITIES, RARITY_BY_ID, STAGES,
  foodBulkCost, foodMaxBuy, equipMilestoneMult, stageForLifetime, stageThreshold,
  skillNodeCost, levelForLifetime, starsFromRun, buildGachaPool, dupeMult,
} from './data.js'

export function defaultState() {
  const foods = {}
  for (const f of FOODS) foods[f.id] = { equip: 0, prog: 0, ready: false }
  return {
    version: 2,
    fat: BAL.startFat, runFat: 0, lifetimeFat: 0,
    stars: 0, cubes: BAL.startCubes, prestigeCount: 0,
    foods, skills: {}, skillSpent: 0, level: 0,
    stage: 0, milestonesHit: 0,
    gacha: {}, pulls: 0,
    buyMode: 1,
    lastSeen: Date.now(), createdAt: Date.now(),
    stats: { collects: 0, taps: 0, playMs: 0 },
  }
}
export function defaultRuntime() { return {} }

function food(state, id) {
  let f = state.foods[id]
  if (!f) { f = state.foods[id] = { equip: 0, prog: 0, ready: false } }
  return f
}

// ---- 파생 수치 -------------------------------------------------------------
export function computeStats(state) {
  let kcalAdd = 0, timeRed = 0, equipAdd = 0, allAuto = false
  let starGain = 0, starPowAdd = 0, offEff = 0, offHours = 0, xpMult = 0, cubeMult = 0
  const fKcal = {}, fTime = {}, fEquip = {}, fAuto = new Set(), fMaster = new Set()

  for (const node of SKILLS.nodes) {
    const lv = state.skills[node.id] || 0
    if (lv <= 0 || !node.eff) continue
    const e = node.eff, amt = (e.per || 0) * lv
    switch (e.k) {
      case 'allKcal': kcalAdd += amt; break
      case 'allTime': timeRed += amt; break
      case 'allEquip': equipAdd += amt; break
      case 'allAuto': allAuto = true; break
      case 'starGain': starGain += amt; break
      case 'starPow': starPowAdd += amt; break
      case 'offline': offEff += 0.06 * lv; offHours += lv; break
      case 'xp': xpMult += amt; break
      case 'cube': cubeMult += amt; break
      case 'fKcal': fKcal[e.food] = (fKcal[e.food] || 0) + amt; break
      case 'fTime': fTime[e.food] = (fTime[e.food] || 0) + amt; break
      case 'fEquip': fEquip[e.food] = (fEquip[e.food] || 0) + amt; break
      case 'fAuto': fAuto.add(e.food); break
      case 'fMaster': fMaster.add(e.food); break
    }
  }

  // 가챠 컬렉션
  const pool = buildGachaPool()
  const g = { kcal: 0, speed: 0, equip: 0, star: 0, cube: 0, luck: 0 }
  let distinct = 0
  for (const id in state.gacha) {
    const c = state.gacha[id]; if (!c) continue
    const it = pool.byId[id]; if (!it) continue
    distinct++; const dm = dupeMult(c)
    for (const k in it.stats) g[k] += it.stats[k] * dm
  }
  kcalAdd += (g.kcal / 100) + Math.floor(distinct / 10) * 0.02
  timeRed += g.speed / 100
  equipAdd += g.equip / 100
  starGain += g.star / 100
  cubeMult += g.cube / 100

  const starPower = BAL.starPowerBase + starPowAdd
  const prestigeMult = 1 + state.stars * starPower

  return {
    kcalAdd, timeRed, equipAdd, allAuto, fKcal, fTime, fEquip, fAuto, fMaster,
    starGain, starPower, prestigeMult,
    offEff: BAL.offlineEffBase + offEff + (g.luck ? 0 : 0),
    offHours: BAL.offlineCapHoursBase + offHours,
    xpMult, cubeMult: 1 + cubeMult, luck: Math.min(0.45, g.luck / 100),
    distinct,
  }
}

// 음식 한 종의 계산값
export function foodCalc(state, stats, f) {
  const fs = state.foods[f.id] || { equip: 0 }
  const equip = fs.equip
  const kcalMult = (1 + stats.kcalAdd + (stats.fKcal[f.id] || 0)) * (stats.fMaster.has(f.id) ? 1.5 : 1) * stats.prestigeMult
  const equipMult = 1 + stats.equipAdd + (stats.fEquip[f.id] || 0)
  let timeFrac = 1 - stats.timeRed - (stats.fTime[f.id] || 0)
  if (stats.fMaster.has(f.id)) timeFrac *= 0.85
  const cycle = Math.max(BAL.minCycleTime, f.time * Math.max(0.05, timeFrac))
  const perCycle = equip * f.kcal * equipMilestoneMult(equip) * equipMult * kcalMult
  const auto = stats.allAuto || stats.fAuto.has(f.id)
  return { equip, cycle, perCycle, perSec: cycle > 0 ? perCycle / cycle : 0, auto }
}

export function incomePerSec(state, stats) {
  let s = 0
  for (const f of FOODS) { if ((state.foods[f.id]?.equip || 0) > 0) s += foodCalc(state, stats, f).perSec }
  return s
}

// ---- 구매(장비수) ----------------------------------------------------------
export function buyInfo(state, stats, id) {
  const f = FOOD_BY_ID[id], owned = state.foods[id]?.equip || 0, mode = state.buyMode
  let k = mode === 'max' ? foodMaxBuy(f, owned, state.fat) : Math.min(mode, foodMaxBuy(f, owned, state.fat))
  if (mode !== 'max' && k < mode) return { k: mode, cost: foodBulkCost(f, owned, mode), affordable: false }
  return { k, cost: foodBulkCost(f, owned, k), affordable: k > 0 }
}
export function buyFood(state, stats, id) {
  const info = buyInfo(state, stats, id)
  if (!info.affordable || info.k <= 0) return null
  const fs = food(state, id)
  state.fat -= info.cost
  fs.equip += info.k
  return info
}

// ---- 획득 ------------------------------------------------------------------
export function collectFood(state, stats, id) {
  const fs = state.foods[id]; if (!fs || !fs.ready) return 0
  const c = foodCalc(state, stats, FOOD_BY_ID[id])
  earn(state, c.perCycle)
  fs.ready = false; fs.prog = 0; state.stats.collects++
  return c.perCycle
}
export function readyCount(state) { let n = 0; for (const id in state.foods) if (state.foods[id].ready) n++; return n }
export function collectAll(state, stats) {
  let total = 0
  for (const f of FOODS) { const fs = state.foods[f.id]; if (fs && fs.ready) total += collectFood(state, stats, f.id) }
  return total
}

// ---- 스킬 ------------------------------------------------------------------
export function availablePoints(state) { return state.level - state.skillSpent }
export function findSkill(id) { return SKILLS.byId[id] || null }
export function isNodeUnlocked(state, node) {
  if (node.free) return true
  for (const d of (node.deps || [])) if ((state.skills[d.node] || 0) < d.lvl) return false
  const c = node.cond
  if (c) {
    if (c.stage != null && state.stage < c.stage) return false
    if (c.fat != null && state.lifetimeFat < c.fat) return false
    if (c.foodLevel && (state.foods[c.foodLevel.food]?.equip || 0) < c.foodLevel.equip) return false
  }
  return true
}
export function learnSkill(state, id) {
  const node = SKILLS.byId[id]; if (!node || node.free) return false
  const cur = state.skills[id] || 0
  if (cur >= node.max) return false
  if (!isNodeUnlocked(state, node)) return false
  const cost = skillNodeCost(node, cur)
  if (availablePoints(state) < cost) return false
  state.skills[id] = cur + 1; state.skillSpent += cost
  return true
}

// ---- 환생 ------------------------------------------------------------------
export function prestigeGain(state, stats) { return starsFromRun(state.runFat, stats.starGain) }
export function doPrestige(state, stats) {
  const gain = prestigeGain(state, stats); if (gain <= 0) return 0
  state.stars += gain; state.prestigeCount++; state.cubes += Math.floor(gain / 3) + 3
  for (const id in state.foods) state.foods[id] = { equip: 0, prog: 0, ready: false }
  state.fat = BAL.startFat; state.runFat = 0
  return gain
}

// ---- 가챠 ------------------------------------------------------------------
function rollRarity(luck) {
  const w = RARITIES.map(r => r.weight), shift = Math.min(0.45, luck), moved = w[0] * shift
  w[0] -= moved; const rest = w.slice(1).reduce((a, b) => a + b, 0)
  for (let i = 1; i < w.length; i++) w[i] += moved * (w[i] / rest)
  let roll = Math.random(), acc = 0
  for (let i = 0; i < RARITIES.length; i++) { acc += w[i]; if (roll <= acc) return RARITIES[i] }
  return RARITIES[0]
}
export const PULL_COST = { 1: 1, 10: 10 }
export function pull(state, stats, n) {
  const cost = PULL_COST[n]; if (state.cubes < cost) return null
  state.cubes -= cost
  const pool = buildGachaPool(), results = []; let rarePlus = false
  for (let i = 0; i < n; i++) {
    let rar = rollRarity(stats.luck)
    if (RARITIES.indexOf(rar) >= 2) rarePlus = true
    if (n === 10 && i === n - 1 && !rarePlus) rar = RARITY_BY_ID.rare
    const bucket = pool.byRarity[rar.id], it = bucket[Math.floor(Math.random() * bucket.length)]
    const before = state.gacha[it.id] || 0
    state.gacha[it.id] = before + 1
    results.push({ item: it, isNew: before === 0, count: before + 1 })
  }
  state.pulls += n
  return results
}

// ---- 탭(신우) --------------------------------------------------------------
export function tap(state, stats, income) {
  const gain = Math.max(1, income * 0.10) * (1 + stats.kcalAdd) * stats.prestigeMult
  earn(state, gain); state.stats.taps++
  return { gain }
}

export function earn(state, amt) { state.fat += amt; state.runFat += amt; state.lifetimeFat += amt }

// ---- 틱 --------------------------------------------------------------------
export function tick(state, stats, rt, dt, now) {
  let income = 0
  for (const f of FOODS) {
    const fs = state.foods[f.id]; if (!fs || fs.equip <= 0) continue
    const c = foodCalc(state, stats, f)
    income += c.perSec
    if (c.auto) { earn(state, c.perSec * dt); fs.ready = false }
    else if (!fs.ready) {
      fs.prog += dt
      if (fs.prog >= c.cycle) { fs.prog = c.cycle; fs.ready = true }
    }
  }
  state.stats.playMs += dt * 1000

  // 레벨
  const newLevel = levelForLifetime(state.lifetimeFat, stats.xpMult)
  let leveledUp = 0
  if (newLevel > state.level) { leveledUp = newLevel - state.level; state.cubes += Math.max(1, Math.floor(leveledUp * stats.cubeMult)); state.level = newLevel }

  // 장비 마일스톤 → 큐브
  let mh = 0
  for (const f of FOODS) { const e = state.foods[f.id]?.equip || 0; for (const m of BAL.equipMilestones) if (e >= m) mh++ }
  if (mh > (state.milestonesHit || 0)) { state.cubes += Math.floor((mh - state.milestonesHit) * stats.cubeMult); state.milestonesHit = mh }

  // 단계(테마) 진행
  const ns = stageForLifetime(state.lifetimeFat)
  let stageUp = 0
  if (ns > state.stage) { stageUp = ns; state.stage = ns; state.cubes += 8 }

  return { income, leveledUp, stageUp }
}

// ---- 오프라인 --------------------------------------------------------------
export function applyOffline(state, stats, now) {
  const dt = Math.max(0, (now - state.lastSeen) / 1000)
  if (dt < 30) return null
  const cap = stats.offHours * 3600, t = Math.min(dt, cap)
  let gain = 0
  for (const f of FOODS) {
    const fs = state.foods[f.id]; if (!fs || fs.equip <= 0) continue
    const c = foodCalc(state, stats, f)
    if (c.auto) gain += c.perSec * t * stats.offEff
    else if (!fs.ready && (fs.prog + dt) >= c.cycle) { fs.prog = c.cycle; fs.ready = true } // 수동은 1주기 대기 상태로
  }
  if (gain > 0) earn(state, gain)
  return gain > 0 ? { dt, t, gain, capped: dt > cap, eff: stats.offEff } : (dt > 60 ? { dt, t, gain: 0, capped: dt > cap, eff: stats.offEff } : null)
}

// 다음 단계 진행도(현재 lifetime 기준)
export function stageProgress(state) {
  const cur = state.stage, next = cur + 1
  if (next >= STAGES.length) return { next: null, pct: 1, need: 0, have: state.lifetimeFat }
  const lo = stageThreshold(cur), hi = stageThreshold(next)
  return { next, pct: Math.max(0, Math.min(1, (state.lifetimeFat - lo) / (hi - lo))), need: hi, have: state.lifetimeFat }
}
