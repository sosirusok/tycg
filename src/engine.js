// ============================================================================
//  신우 키우기 — 엔진 v4
// ============================================================================
import {
  BAL, FOODS, FOOD_BY_ID, STAGE_FOODS, THEMES, SKILLS, FAME_SHOP,
  RARITIES, RARITY_BY_ID, PET_GRADES, PET_GRADE_BY_ID, PET_STAR_MAX,
  foodBulkCost, foodMaxBuy, equipMilestoneMult, stageAdvanceCost,
  skillNodeCost, fameNodeCost, petStats, petKey, parsePetKey, petBuyPrice,
  levelForRun, fameFromRun, buildGachaPool, dupeMult,
} from './data.js'

export function defaultState() {
  const foods = {}; for (const f of FOODS) foods[f.id] = { equip: 0, prog: 0, ready: false }
  return {
    version: 4,
    fat: BAL.startFat, runFat: 0, lifetimeFat: 0,
    fame: 0, cubes: BAL.startCubes, prestigeCount: 0,
    foods, skills: {}, skillSpent: 0, level: 0,
    stage: 0, maxStage: 0, milestonesHit: 0,
    fameBuys: {},
    pets: {}, petEquip: [],   // pets: {key:count}, petEquip: [key,...]
    gacha: {}, pulls: 0,
    buyMode: 1,
    lastSeen: Date.now(), createdAt: Date.now(),
    stats: { collects: 0, taps: 0, playMs: 0, fuses: 0 },
  }
}
export function defaultRuntime() { return {} }
function food(s, id) { let f = s.foods[id]; if (!f) f = s.foods[id] = { equip: 0, prog: 0, ready: false }; return f }

// ---- 파생 수치 -------------------------------------------------------------
export function computeStats(state) {
  let allKcal = 0, allTime = 0, allEquip = 0, fameGainB = 0, offEff = 0, offHours = 0, xpMult = 0, cubeMult = 0, petSlot = 0
  const sKcal = {}, sTime = {}, sAuto = new Set(), fBoost = new Set()
  for (const node of SKILLS.nodes) {
    const lv = state.skills[node.id] || 0; if (lv <= 0 || !node.eff) continue
    const e = node.eff, amt = (e.per || 0) * lv
    switch (e.k) {
      case 'allKcal': allKcal += amt; break
      case 'allTime': allTime += amt; break
      case 'allEquip': allEquip += amt; break
      case 'fameGain': fameGainB += amt; break
      case 'offline': offEff += 0.06 * lv; offHours += lv; break
      case 'xp': xpMult += amt; break
      case 'cube': cubeMult += amt; break
      case 'petSlot': petSlot += lv; break
      case 'sKcal': sKcal[e.stage] = (sKcal[e.stage] || 0) + amt; break
      case 'sTime': sTime[e.stage] = (sTime[e.stage] || 0) + amt; break
      case 'sAuto': sAuto.add(e.stage); break
      case 'fBoost': fBoost.add(e.food); break
    }
  }
  // 명성 상점(영구)
  let fameKcal = 0, fameTime = 0, fameEquip = 0, fameStartLv = 0, famePetSlot = 0, spBonus = 0
  const fameAutoStage = new Set()
  for (const node of FAME_SHOP) {
    const lv = state.fameBuys[node.id] || 0; if (lv <= 0) continue
    const e = node.eff, amt = (e.per || 0) * lv
    switch (e.k) {
      case 'fameKcal': fameKcal += amt; break
      case 'fameTime': fameTime += amt; break
      case 'fameEquip': fameEquip += amt; break
      case 'fameStart': fameStartLv += lv; break
      case 'famePetSlot': famePetSlot += lv; break
      case 'fameOffline': offEff += 0.08 * lv; offHours += 2 * lv; break
      case 'fameSP': spBonus += 2 * lv; break
      case 'fameGain': fameGainB += amt; break
      case 'fameCube': cubeMult += amt; break
      case 'fameAutoStage': fameAutoStage.add(e.stage); break
    }
  }
  // 가챠
  const pool = buildGachaPool(); const g = { kcal: 0, speed: 0, equip: 0, fame: 0, cube: 0, luck: 0 }; let distinct = 0
  for (const id in state.gacha) { const c = state.gacha[id]; if (!c) continue; const it = pool.byId[id]; if (!it) continue; distinct++; const dm = dupeMult(c); for (const k in it.stats) g[k] += it.stats[k] * dm }
  const collection = Math.floor(distinct / 10) * 0.02
  // 펫(착용분 합산)
  let petIncome = 0, petTime = 0, petOffline = 0, petCube = 0, petFame = 0, petEquip = 0
  for (const key of (state.petEquip || [])) { const { grade, star } = parsePetKey(key); const ps = petStats(grade, star); petIncome += ps.income || 0; petTime += ps.time || 0; petOffline += ps.offline || 0; petCube += ps.cube || 0; petFame += ps.fame || 0; petEquip += ps.equip || 0 }

  return {
    allKcal, allTime, allEquip, sKcal, sTime, sAuto, fBoost, fameAutoStage,
    fameKcal, fameTime, fameEquip, fameStartMult: Math.pow(4, fameStartLv),
    kcalGlobalMult: (1 + fameKcal + g.kcal / 100 + collection) * (1 + petIncome),
    equipGlobal: 1 + allEquip + fameEquip + g.equip / 100 + petEquip,
    timeGlobal: allTime + fameTime + g.speed / 100 + petTime,
    offEff: BAL.offlineEffBase + offEff + petOffline, offHours: BAL.offlineCapHoursBase + offHours,
    xpMult, cubeMult: 1 + cubeMult + g.cube / 100 + petCube, fameGainB: fameGainB + g.fame / 100 + petFame,
    luck: Math.min(0.45, g.luck / 100),
    petSlots: BAL.petSlotsBase + petSlot + famePetSlot, spBonus, distinct,
  }
}

export function foodCalc(state, stats, f) {
  const fs = state.foods[f.id] || { equip: 0 }; const equip = fs.equip
  const kcalAdd = stats.allKcal + (stats.sKcal[f.stage] || 0) + (stats.fBoost.has(f.id) ? 0.2 : 0)
  const kcalMult = (1 + kcalAdd) * stats.kcalGlobalMult
  const timeFrac = Math.max(0.04, 1 - (stats.timeGlobal + (stats.sTime[f.stage] || 0)))
  const cycle = Math.max(BAL.minCycleTime, f.time * timeFrac)
  const perCycle = equip * f.kcal * equipMilestoneMult(equip) * stats.equipGlobal * kcalMult
  const auto = stats.sAuto.has(f.stage) || stats.fBoost.has(f.id) || stats.fameAutoStage.has(f.stage)
  return { equip, cycle, perCycle, perSec: cycle > 0 ? perCycle / cycle : 0, auto }
}
export function incomePerSec(state, stats) { let s = 0; for (const f of FOODS) if ((state.foods[f.id]?.equip || 0) > 0) s += foodCalc(state, stats, f).perSec; return s }

// ---- 구매 ------------------------------------------------------------------
export function buyInfo(state, stats, id) {
  const f = FOOD_BY_ID[id], owned = state.foods[id]?.equip || 0, mode = state.buyMode
  let k = mode === 'max' ? foodMaxBuy(f, owned, state.fat) : Math.min(mode, foodMaxBuy(f, owned, state.fat))
  if (mode !== 'max' && k < mode) return { k: mode, cost: foodBulkCost(f, owned, mode), affordable: false }
  return { k, cost: foodBulkCost(f, owned, k), affordable: k > 0 }
}
export function buyFood(state, stats, id) { const info = buyInfo(state, stats, id); if (!info.affordable || info.k <= 0) return null; food(state, id).equip += info.k; state.fat -= info.cost; return info }

// ---- 획득(수동) ------------------------------------------------------------
export function collectFood(state, stats, id) { const fs = state.foods[id]; if (!fs || !fs.ready) return 0; const c = foodCalc(state, stats, FOOD_BY_ID[id]); earn(state, c.perCycle); fs.ready = false; fs.prog = 0; state.stats.collects++; return c.perCycle }

// ---- 단계 진행(지방 소모) --------------------------------------------------
export function canAdvance(state) { return state.stage + 1 < THEMES.length && state.fat >= stageAdvanceCost(state.stage) }
export function advanceStage(state) { if (!canAdvance(state)) return false; state.fat -= stageAdvanceCost(state.stage); state.stage++; if (state.stage > state.maxStage) state.maxStage = state.stage; state.cubes += 10; return true }

// ---- 스킬 ------------------------------------------------------------------
export function availablePoints(state, stats) { return state.level + (stats ? stats.spBonus : 0) - state.skillSpent }
export function findSkill(id) { return SKILLS.byId[id] || null }
export function isNodeUnlocked(state, node) {
  if (node.free) return true
  for (const d of (node.deps || [])) if ((state.skills[d.node] || 0) < d.lvl) return false
  const c = node.cond
  if (c) { if (c.stage != null && state.stage < c.stage) return false; if (c.foodLevel && (state.foods[c.foodLevel.food]?.equip || 0) < c.foodLevel.equip) return false }
  return true
}
export function learnSkill(state, stats, id) {
  const node = SKILLS.byId[id]; if (!node || node.free) return false
  const cur = state.skills[id] || 0; if (cur >= node.max) return false
  if (!isNodeUnlocked(state, node)) return false
  const cost = skillNodeCost(node, cur); if (availablePoints(state, stats) < cost) return false
  state.skills[id] = cur + 1; state.skillSpent += cost; return true
}

// ---- 명성 상점 -------------------------------------------------------------
export function fameBuy(state, id) {
  const node = FAME_SHOP.find(n => n.id === id); if (!node) return false
  const cur = state.fameBuys[id] || 0; if (cur >= node.max) return false
  const cost = fameNodeCost(node, cur); if (state.fame < cost) return false
  state.fame -= cost; state.fameBuys[id] = cur + 1; return true
}
export function fameBuyCost(state, id) { const node = FAME_SHOP.find(n => n.id === id); return fameNodeCost(node, state.fameBuys[id] || 0) }

// ---- 펫 --------------------------------------------------------------------
export function petCount(state, key) { return state.pets[key] || 0 }
export function buyPet(state, grade, star) { const price = petBuyPrice(grade, star); if (state.fat < price) return false; state.fat -= price; const k = petKey(grade, star); state.pets[k] = (state.pets[k] || 0) + 1; return true }
export function canFuse(state, key) { return (state.pets[key] || 0) >= 2 }
export function fusePet(state, key) {
  if ((state.pets[key] || 0) < 2) return null
  const { grade, star } = parsePetKey(key)
  state.pets[key] -= 2; if (state.pets[key] <= 0) delete state.pets[key]
  let outKey
  if (star < PET_STAR_MAX) outKey = petKey(grade, star + 1)
  else { const gi = PET_GRADE_BY_ID[grade].idx; if (gi + 1 >= PET_GRADES.length) { state.pets[key] = (state.pets[key] || 0) + 2; return null } outKey = petKey(PET_GRADES[gi + 1].id, 1) }
  state.pets[outKey] = (state.pets[outKey] || 0) + 1; state.stats.fuses++
  // 착용 중이던 게 사라졌으면 정리
  return outKey
}
export function maxPetSlots(stats) { return stats.petSlots }
export function equipPet(state, stats, key) {
  if (!(state.pets[key] > 0)) return false
  state.petEquip = state.petEquip || []
  if (state.petEquip.includes(key)) return false
  if (state.petEquip.length >= maxPetSlots(stats)) state.petEquip.shift()
  state.petEquip.push(key); return true
}
export function unequipPet(state, key) { state.petEquip = (state.petEquip || []).filter(k => k !== key) }
// 보유 수보다 많이 착용돼 있지 않게 정리
export function reconcileEquip(state) { state.petEquip = (state.petEquip || []).filter(k => (state.pets[k] || 0) > 0) }

// ---- 환생 ------------------------------------------------------------------
export function prestigeGain(state, stats) { return fameFromRun(state.runFat, stats.fameGainB) }
export function doPrestige(state, stats) {
  const gain = prestigeGain(state, stats); if (gain <= 0) return 0
  state.fame += gain; state.prestigeCount++; state.cubes += Math.floor(gain / 2) + 5
  for (const id in state.foods) state.foods[id] = { equip: 0, prog: 0, ready: false }
  state.fat = BAL.startFat * stats.fameStartMult; state.runFat = 0
  state.level = 0; state.skills = {}; state.skillSpent = 0
  state.stage = 0; state.milestonesHit = 0
  state.pets = {}; state.petEquip = []
  return gain
}

// ---- 가챠 ------------------------------------------------------------------
function rollRarity(luck) { const w = RARITIES.map(r => r.weight), shift = Math.min(0.45, luck), moved = w[0] * shift; w[0] -= moved; const rest = w.slice(1).reduce((a, b) => a + b, 0); for (let i = 1; i < w.length; i++) w[i] += moved * (w[i] / rest); let roll = Math.random(), acc = 0; for (let i = 0; i < RARITIES.length; i++) { acc += w[i]; if (roll <= acc) return RARITIES[i] } return RARITIES[0] }
export const PULL_COST = { 1: 1, 10: 10 }
export function pull(state, stats, n) {
  const cost = PULL_COST[n]; if (state.cubes < cost) return null
  state.cubes -= cost; const pool = buildGachaPool(), results = []; let rarePlus = false
  for (let i = 0; i < n; i++) { let rar = rollRarity(stats.luck); if (RARITIES.indexOf(rar) >= 2) rarePlus = true; if (n === 10 && i === n - 1 && !rarePlus) rar = RARITY_BY_ID.rare; const b = pool.byRarity[rar.id], it = b[Math.floor(Math.random() * b.length)]; const before = state.gacha[it.id] || 0; state.gacha[it.id] = before + 1; results.push({ item: it, isNew: before === 0, count: before + 1 }) }
  state.pulls += n; return results
}
export function tap(state, stats, income) { const gain = Math.max(1, income * 0.08) * stats.kcalGlobalMult; earn(state, gain); state.stats.taps++; return { gain } }
export function earn(state, amt) { state.fat += amt; state.runFat += amt; state.lifetimeFat += amt }

// ---- 틱 --------------------------------------------------------------------
export function tick(state, stats, rt, dt, now) {
  let income = 0
  for (const f of FOODS) { const fs = state.foods[f.id]; if (!fs || fs.equip <= 0) continue; const c = foodCalc(state, stats, f); income += c.perSec; if (c.auto) { earn(state, c.perSec * dt); fs.ready = false } else if (!fs.ready) { fs.prog += dt; if (fs.prog >= c.cycle) { fs.prog = c.cycle; fs.ready = true } } }
  state.stats.playMs += dt * 1000
  const newLevel = levelForRun(state.runFat, stats.xpMult); let leveledUp = 0
  if (newLevel > state.level) { leveledUp = newLevel - state.level; state.level = newLevel }
  let mh = 0; for (const f of FOODS) { const e = state.foods[f.id]?.equip || 0; for (const m of BAL.equipMilestones) if (e >= m) mh++ }
  if (mh > (state.milestonesHit || 0)) { state.cubes += Math.floor((mh - state.milestonesHit) * stats.cubeMult); state.milestonesHit = mh }
  return { income, leveledUp }
}
export function applyOffline(state, stats, now) {
  const dt = Math.max(0, (now - state.lastSeen) / 1000); if (dt < 30) return null
  const cap = stats.offHours * 3600, t = Math.min(dt, cap); let gain = 0
  for (const f of FOODS) { const fs = state.foods[f.id]; if (!fs || fs.equip <= 0) continue; const c = foodCalc(state, stats, f); if (c.auto) gain += c.perSec * t * stats.offEff; else if (!fs.ready && (fs.prog + dt) >= c.cycle) { fs.prog = c.cycle; fs.ready = true } }
  if (gain > 0) earn(state, gain)
  return (gain > 0 || dt > 60) ? { dt, t, gain, capped: dt > cap, eff: stats.offEff } : null
}
