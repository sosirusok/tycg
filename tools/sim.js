// 경제 시뮬레이터 — data.js 의 실제 수식으로 "적극적 플레이어"를 모사해
// 각 테마 클리어까지 걸리는 시간(시간 단위)을 측정한다. (스킬/펫/환생 0 기준, 전부 자동수령 가정 = 가장 빠른 경로)
import { FOODS, THEMES, BAL, foodUnitCost, equipMilestoneMult, stageAdvanceCost } from '../src/data.js'

function fmtH(sec) {
  if (sec < 60) return sec.toFixed(0) + 's'
  if (sec < 3600) return (sec / 60).toFixed(1) + 'm'
  if (sec < 86400) return (sec / 3600).toFixed(2) + 'h'
  return (sec / 86400).toFixed(2) + 'd'
}

function perUnit(f) { return f.kcal / f.time }            // 장비 1개당 초당(자동 가정)
function income(equip, stage) {
  let s = 0
  for (const f of FOODS) { if (f.stage > stage) break; const e = equip[f.index]; if (e > 0) s += e * perUnit(f) * equipMilestoneMult(e) }
  return s
}
// 장비 1개 더 살 때 income 증가량
function gain(f, e) { const pu = perUnit(f); return pu * ((e + 1) * equipMilestoneMult(e + 1) - e * equipMilestoneMult(e)) }

// 러시 전략: 진출 가능하면 즉시 진출, 아니면 "현재 살 수 있는 가장 상위 음식"을 구매.
// 아무것도 못 사면 (진출비용 또는 가장 싼 다음 구매) 중 가까운 쪽까지 시간 점프.
export function simulate(maxStage = 8, skillMult = 1) {
  const equip = FOODS.map(() => 0)
  let fat = BAL.startFat, t = 0, stage = 0, lifetime = 0
  const themeTime = []
  let iter = 0
  const MAXITER = 5_000_000
  const earn = (amt) => { lifetime += amt }
  while (stage <= maxStage && iter++ < MAXITER) {
    const inc = income(equip, stage) * skillMult
    const advCost = stage < maxStage ? stageAdvanceCost(stage) : Infinity
    if (isFinite(advCost) && fat >= advCost) { fat -= advCost; stage++; themeTime.push(t); continue }
    // 현재 살 수 있는 가장 상위 음식
    let buyIdx = -1
    for (let i = (stage + 1) * 8 - 1; i >= 0; i--) { if (FOODS[i].stage > stage) continue; if (foodUnitCost(FOODS[i], equip[i]) <= fat) { buyIdx = i; break } }
    if (buyIdx >= 0) { fat -= foodUnitCost(FOODS[buyIdx], equip[buyIdx]); equip[buyIdx]++; continue }
    // 아무것도 못 삼 → 목표(진출 또는 가장 싼 다음 음식 단위)까지 시간 점프
    let target = isFinite(advCost) ? advCost : Infinity
    for (let i = 0; i < (stage + 1) * 8; i++) { if (FOODS[i].stage > stage) break; target = Math.min(target, foodUnitCost(FOODS[i], equip[i])) }
    if (!isFinite(target) || inc <= 0) break
    const wait = (target - fat) / inc; t += wait; earn(target - fat); fat = target
  }
  return { themeTime, totalSec: t, lifetime }
}

for (const sm of [1, 4, 30]) {
  const r = simulate(8, sm)
  console.log(`\n=== 러시·자동, 스킬배수 ×${sm} ===`)
  let prev = 0
  r.themeTime.forEach((sec, i) => { console.log(`  테마${i + 1}→${i + 2}: 누적 ${fmtH(sec)} (소요 ${fmtH(sec - prev)})`); prev = sec })
  console.log('  전체:', fmtH(r.totalSec))
}
