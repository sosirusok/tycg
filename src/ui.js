// ============================================================================
//  신우 키우기 — UI v4
// ============================================================================
import {
  BAL, FOODS, FOOD_BY_ID, STAGE_FOODS, THEMES, SKILLS, FAME_SHOP,
  PET_GRADES, PET_GRADE_BY_ID, PET_STAR_MAX, PET_STAT_LABEL,
  RARITIES, fmt, fmtTime, nextEquipMilestone, skillNodeCost, fameNodeCost,
  stageAdvanceCost, petStats, petKey, parsePetKey, petBuyPrice, runForLevel,
} from './data.js'
import {
  computeStats, incomePerSec, foodCalc, buyInfo, buyFood, collectFood,
  canAdvance, advanceStage, availablePoints, findSkill, isNodeUnlocked, learnSkill,
  fameBuy, fameBuyCost, buyPet, canFuse, fusePet, equipPet, unequipPet, maxPetSlots, reconcileEquip,
  pull, PULL_COST, prestigeGain, doPrestige, tap,
} from './engine.js'
import { FOOD_ART, CHAR_ART, UI_ART, BG_ART, PET_ART, img } from './assets.js'

const $ = s => document.querySelector(s)
const el = h => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild }
const TABS = [['food', '음식'], ['skills', '스킬'], ['pets', '펫'], ['fame', '명성'], ['gacha', '가챠'], ['collection', '도감'], ['stats', '통계']]
const CHAR_STAGES = [{ min: 0, art: 's1', n: '병아리 식신' }, { min: 6, art: 's2', n: '먹보' }, { min: 14, art: 's3', n: '미식가' }, { min: 26, art: 's4', n: '오너 셰프' }, { min: 42, art: 's5', n: '식품왕' }, { min: 62, art: 's6', n: '미식황제' }, { min: 90, art: 's7', n: '우주 미식신' }]
const charFor = lv => { let s = CHAR_STAGES[0]; for (const x of CHAR_STAGES) if (lv >= x.min) s = x; return s }

let G = null, activeTab = 'food'
const H = {}; let FOODUI = null, SKILLUI = null

export function initUI(game) { G = game; applyStage(G.state.stage); buildShell(); switchTab('food') }
export function applyStage(s) {
  const st = THEMES[Math.max(0, Math.min(THEMES.length - 1, s))]
  for (const k in st.vars) document.documentElement.style.setProperty(k, st.vars[k])
  document.documentElement.classList.toggle('is-dark', st.id === 'cosmic')
  const bg = BG_ART[st.bg]; document.body.style.backgroundImage = bg ? `url("${bg}")` : 'none'
  H.curStageBg = s
}

function buildShell() {
  const app = $('#app'); app.className = 'game-root'
  app.innerHTML = `
  <div class="game">
    <header class="topbar">
      <div class="brand">신우 키우기</div>
      <div class="currencies">
        <div class="cur" title="칼로리(지방)">${img(UI_ART.fat, 'cur-ico')}<b id="cur-fat">0</b><span class="unit">g</span></div>
        <div class="cur" title="명성(환생 화폐)">${img(UI_ART.star, 'cur-ico')}<b id="cur-fame">0</b></div>
        <div class="cur" title="큐브(가챠)">${img(UI_ART.cube, 'cur-ico')}<b id="cur-cube">0</b></div>
        <div class="cur cur-inc" title="초당 생산">+<b id="cur-inc">0</b><span class="unit">g/초</span></div>
        <div class="lvbar" id="lvbar" title="레벨 경험치"><div id="lvfill"></div><span id="lvtext"></span></div>
      </div>
      <div class="topright">
        <button class="hero" id="hero" title="신우 (탭)">${img(CHAR_ART.s1, 'hero-art', 'id="hero-art"')}<span class="hero-lv">Lv.<b id="hero-lvl">0</b><span id="hero-sp" class="hero-sp"></span></span></button>
        <button class="ghost sm" id="btn-logout">로그아웃</button>
      </div>
    </header>
    <nav class="tabs" id="tabs">${TABS.map(([id, n]) => `<button class="tab" data-tab="${id}">${n}</button>`).join('')}</nav>
    <div class="tabbody" id="tabbody"></div>
    <div id="float-layer"></div><div id="toast-layer"></div><div id="modal-layer"></div>
  </div>`
  H.fat = $('#cur-fat'); H.fame = $('#cur-fame'); H.cube = $('#cur-cube'); H.inc = $('#cur-inc')
  H.heroArt = $('#hero-art'); H.heroLvl = $('#hero-lvl'); H.heroSp = $('#hero-sp'); H.curHero = 's1'
  H.lvfill = $('#lvfill'); H.lvtext = $('#lvtext'); H.tabbody = $('#tabbody')
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) switchTab(b.dataset.tab) })
  $('#btn-logout').addEventListener('click', () => G.onLogout && G.onLogout())
  $('#hero').addEventListener('click', e => { const r = tap(G.state, G.stats, G.income); G.recompute(); spawnFloat(e.clientX, e.clientY, '+' + fmt(r.gain), 'tap') })
  H.tabbody.addEventListener('click', onBodyClick)
}
function switchTab(tab) { activeTab = tab; document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); FOODUI = null; SKILLUI = null; renderBody() }

// ---------------------------------------------------------------------------
export function render() {
  const s = G.state
  H.fat.textContent = fmt(s.fat); H.fame.textContent = fmt(s.fame); H.cube.textContent = fmt(s.cubes); H.inc.textContent = fmt(G.income)
  const c = charFor(s.level)
  if (c.art !== H.curHero && CHAR_ART[c.art]) { H.heroArt.src = CHAR_ART[c.art]; H.curHero = c.art }
  H.heroLvl.textContent = s.level
  const sp = availablePoints(s, G.stats); H.heroSp.textContent = sp > 0 ? ` · SP ${sp}` : ''; H.heroSp.classList.toggle('hot', sp > 0)
  // 레벨 바
  const lo = runForLevel(s.level, G.stats.xpMult), hi = runForLevel(s.level + 1, G.stats.xpMult)
  const p = Math.max(0, Math.min(1, (s.runFat - lo) / (hi - lo)))
  H.lvfill.style.width = (p * 100).toFixed(1) + '%'
  H.lvtext.textContent = `Lv.${s.level} · 다음 ${Math.floor(p * 100)}%`
  if (s.stage !== H.curStageBg) applyStage(s.stage)
  if (activeTab === 'food') updateFood()
  else if (activeTab === 'fame') updateFame()
}

function renderBody() {
  if (activeTab === 'food') return buildFood()
  if (activeTab === 'skills') return buildSkill()
  const b = H.tabbody
  if (activeTab === 'pets') b.innerHTML = petsHTML()
  else if (activeTab === 'fame') b.innerHTML = fameHTML()
  else if (activeTab === 'gacha') b.innerHTML = gachaHTML()
  else if (activeTab === 'collection') b.innerHTML = collectionHTML()
  else if (activeTab === 'stats') b.innerHTML = statsHTML()
}

// ===== 음식 ================================================================
function firstOfStage(i) { return i === 0 || FOODS[i - 1].stage !== FOODS[i].stage }
function foodRevealed(s, i) { const f = FOODS[i]; if (f.stage < s.stage) return true; if (f.stage > s.stage) return false; return firstOfStage(i) || (s.foods[FOODS[i - 1].id]?.equip || 0) > 0 }

function buildFood() {
  const s = G.state, st = G.stats, stage = THEMES[s.stage]
  const modes = [['1', 'x1'], ['10', 'x10'], ['100', 'x100'], ['max', 'MAX']]
  const adv = canAdvance(s), advCost = stageAdvanceCost(s.stage), isMax = s.stage + 1 >= THEMES.length
  const banner = `<div class="scene" style="background-image:url('${BG_ART[stage.bg] || ''}')"><div class="scene-grad"></div>
    <div class="scene-row"><div class="scene-stage">
      <div class="scene-badge">단계 ${s.stage + 1} / ${THEMES.length}</div>
      <div class="scene-name">${stage.name}</div>
      ${isMax ? `<div class="scene-need">최종 단계! 🎉</div>`
      : `<button class="advance ${adv ? '' : 'cant'}" data-act="advance">다음 단계로 · ${fmt(advCost)} g 소모</button>`}
    </div></div></div>`
  const head = `<div class="food-head"><div class="food-hint muted">제작시간마다 [획득]을 눌러 칼로리를 받아요. 스킬·펫으로 자동화하면 편해져요.</div>
    <div class="buymode">${modes.map(([m, l]) => `<button class="bm-btn ${String(s.buyMode) === m ? 'on' : ''}" data-act="mode" data-mode="${m}">${l}</button>`).join('')}</div></div>`
  const rows = FOODS.map((f, i) => {
    if (!foodRevealed(s, i)) { const why = f.stage > s.stage ? `${THEMES[f.stage].name} 단계 필요` : '앞 음식을 먼저 사봐'; return `<div class="food locked"><div class="food-ico ghost"></div><div class="food-mid"><div class="food-top"><span class="food-name">???</span></div><div class="food-sub">${why}</div></div></div>` }
    return `<div class="food" data-id="${f.id}">
      <div class="food-ico">${img(FOOD_ART[f.art], '')}</div>
      <div class="food-mid">
        <div class="food-top"><span class="food-name">${f.name}</span><span class="food-equip" data-r="equip">장비 0</span></div>
        <div class="food-bar"><div class="food-fill" data-r="fill"></div></div>
        <div class="ms-row"><div class="ms-bar"><div class="ms-fill" data-r="msfill"></div></div><span class="ms-txt" data-r="mstxt"></span></div>
        <div class="food-sub"><span data-r="yield"></span> <span class="auto-badge hidden" data-r="auto">자동</span></div>
      </div>
      <div class="food-act"><button class="collect" data-act="collect" data-id="${f.id}" data-r="cbtn">제작 중</button>
        <button class="food-buy" data-act="buyfood" data-id="${f.id}"><span data-r="bm">장비</span><span data-r="bc"></span></button></div>
    </div>`
  }).join('')
  H.tabbody.innerHTML = `${banner}${head}<div class="food-list">${rows}</div>`
  FOODUI = { sig: foodSig(s, st), refs: {} }
  H.tabbody.querySelectorAll('.food[data-id]').forEach(row => { const id = row.dataset.id; FOODUI.refs[id] = { equip: row.querySelector('[data-r=equip]'), fill: row.querySelector('[data-r=fill]'), msfill: row.querySelector('[data-r=msfill]'), mstxt: row.querySelector('[data-r=mstxt]'), yield: row.querySelector('[data-r=yield]'), auto: row.querySelector('[data-r=auto]'), cbtn: row.querySelector('[data-r=cbtn]'), bm: row.querySelector('[data-r=bm]'), bc: row.querySelector('[data-r=bc]') } })
  updateFood()
}
function foodSig(s, st) { let rev = 0, auto = 0; for (let i = 0; i < FOODS.length; i++) { if (foodRevealed(s, i)) rev++; const f = FOODS[i]; if (st.sAuto.has(f.stage) || st.fBoost.has(f.id) || st.fameAutoStage.has(f.stage)) auto++ } return s.stage + '|' + s.buyMode + '|' + rev + '|' + auto + '|' + canAdvance(s) }
function updateFood() {
  const s = G.state, st = G.stats
  if (!FOODUI || FOODUI.sig !== foodSig(s, st)) return buildFood()
  for (const f of FOODS) {
    const r = FOODUI.refs[f.id]; if (!r) continue
    const fs = s.foods[f.id], c = foodCalc(s, st, f)
    r.equip.textContent = '장비 ' + fmt(fs.equip)
    r.yield.textContent = fs.equip > 0 ? `${fmt(c.perCycle)} g / ${fmtTime(c.cycle)}` : '미가동'
    r.auto.classList.toggle('hidden', !c.auto)
    const mil = nextEquipMilestone(fs.equip)
    if (mil.next) { r.msfill.style.width = Math.min(100, (fs.equip - mil.prev) / (mil.next - mil.prev) * 100) + '%'; r.mstxt.textContent = `×2까지 ${fmt(mil.next - fs.equip)}` }
    else { r.msfill.style.width = '100%'; r.mstxt.textContent = '최대 보너스' }
    if (c.auto) { r.fill.style.width = '100%'; r.fill.classList.add('auto'); r.cbtn.classList.add('hidden') }
    else {
      r.fill.classList.remove('auto'); r.cbtn.classList.remove('hidden')
      r.fill.style.width = (c.cycle > 0 ? Math.min(100, fs.prog / c.cycle * 100) : 0) + '%'
      if (fs.ready) { r.cbtn.classList.add('ready'); r.cbtn.textContent = '획득 +' + fmt(c.perCycle) }
      else { r.cbtn.classList.remove('ready'); r.cbtn.textContent = fs.equip > 0 ? '제작 ' + fmtTime(Math.max(0, c.cycle - fs.prog)) : '장비 필요' }
    }
    const info = buyInfo(s, st, f.id); r.bm.textContent = '장비 +' + fmt(info.k); r.bc.textContent = fmt(info.cost) + ' g'; r.bm.parentElement.classList.toggle('cant', !info.affordable)
  }
}

// ===== 스킬 그래프 (렉 최소화: 1회 구성, 프레임마다 갱신 안 함) ============
function buildSkill() {
  const nodes = SKILLS.nodes
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9
  for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y) }
  const pad = 110, W = maxX - minX + pad * 2, Hh = maxY - minY + pad * 2, X = n => n.x - minX + pad, Y = n => n.y - minY + pad
  let lines = ''
  for (const n of nodes) for (const d of (n.deps || [])) { const p = SKILLS.byId[d.node]; if (p) lines += `<line x1="${X(p)}" y1="${Y(p)}" x2="${X(n)}" y2="${Y(n)}"/>` }
  const nodeHTML = nodes.map(n => {
    const isFood = n.eff && n.eff.k === 'fBoost'
    const ic = isFood ? img(FOOD_ART[FOOD_BY_ID[n.eff.food].art], 'sk-art') : `<span class="sk-glyph" style="background:${branchColor(n)}">${glyph(n)}</span>`
    return `<button class="sknode" data-act="sk" data-id="${n.id}" style="left:${X(n)}px;top:${Y(n)}px">${ic}<span class="sk-lv" data-r="lv"></span></button>`
  }).join('')
  H.tabbody.innerHTML = `<div class="sk-bar">스킬 포인트 <b id="sk-sp">0</b> <span class="muted">· 노드를 누르면 설명·강화 창이 떠요</span></div>
    <div class="sk-scroll"><div class="sk-canvas" style="width:${W}px;height:${Hh}px"><svg class="sk-edges" width="${W}" height="${Hh}">${lines}</svg>${nodeHTML}</div></div>`
  SKILLUI = { els: {}, X, Y }
  H.tabbody.querySelectorAll('.sknode').forEach(b => SKILLUI.els[b.dataset.id] = { b, lv: b.querySelector('[data-r=lv]') })
  const sc = H.tabbody.querySelector('.sk-scroll'); const r = SKILLS.byId.root
  requestAnimationFrame(() => { sc.scrollLeft = X(r) - sc.clientWidth / 2; sc.scrollTop = Y(r) - sc.clientHeight / 2 })
  refreshSkill()
}
function branchColor(n) { if (n.branch != null) return THEMES[n.branch].vars['--accent']; return 'var(--accent)' }
function glyph(n) { const k = n.eff && n.eff.k; return ({ allKcal: '칼', allTime: '속', allEquip: '장', fameGain: '명', offline: '오', xp: '경', cube: '큐', petSlot: '펫', sKcal: '◆', sTime: '속', sAuto: '⚡' })[k] || '✦' }
function refreshSkill() {
  if (!SKILLUI) return
  const s = G.state, pts = availablePoints(s, G.stats); const spEl = $('#sk-sp'); if (spEl) spEl.textContent = pts
  for (const n of SKILLS.nodes) {
    const ref = SKILLUI.els[n.id]; if (!ref) continue
    const lv = s.skills[n.id] || 0, maxed = lv >= n.max, unlocked = isNodeUnlocked(s, n)
    ref.lv.textContent = n.free ? '' : (maxed ? '✓' : (n.max === 1 ? '' : lv))
    ref.b.classList.toggle('locked', !unlocked && !n.free)
    ref.b.classList.toggle('owned', lv > 0)
    ref.b.classList.toggle('maxed', maxed)
    ref.b.classList.toggle('can', !maxed && unlocked && !n.free && pts >= skillNodeCost(n, lv))
  }
}
function condText(n) {
  const p = []
  for (const d of (n.deps || [])) { const pr = SKILLS.byId[d.node]; if (pr && d.lvl > 0) p.push(`‘${pr.name}’ ${d.lvl}↑`) }
  if (n.cond) { if (n.cond.stage != null) p.push(`‘${THEMES[n.cond.stage].name}’ 단계`); if (n.cond.foodLevel) p.push(`${FOOD_BY_ID[n.cond.foodLevel.food].name} 장비 ${n.cond.foodLevel.equip}↑`) }
  return p.join(', ')
}
function openSkillDetail(id) {
  const render = () => {
    const s = G.state, n = SKILLS.byId[id]; const lv = s.skills[id] || 0, maxed = lv >= n.max, unlocked = isNodeUnlocked(s, n)
    const cost = skillNodeCost(n, lv), pts = availablePoints(s, G.stats), can = !maxed && unlocked && pts >= cost
    const condOk = unlocked || n.free
    return `<div class="modal sk-detail"><h3>${n.name}</h3>
      <p>${n.desc}</p>
      <div class="sk-d-row"><span>레벨</span><b>${n.free ? '-' : `${lv} / ${n.max === 1 ? 1 : n.max}`}</b></div>
      ${n.free ? '' : `<div class="sk-d-row"><span>비용</span><b>${maxed ? '완료' : 'SP ' + cost}</b></div>`}
      ${condOk ? '' : `<div class="sk-d-cond">잠금: ${condText(n)}</div>`}
      <div class="modal-btns"><button class="ghost" data-x="close">닫기</button>${n.free || maxed ? '' : `<button class="primary ${can ? '' : 'cant'}" data-x="learn">강화 (SP ${cost})</button>`}</div></div>`
  }
  const bg = el(`<div class="modal-bg">${render()}</div>`); $('#modal-layer').appendChild(bg)
  bg.addEventListener('click', e => {
    const x = e.target.dataset.x
    if (x === 'close' || e.target === bg) bg.remove()
    else if (x === 'learn') { if (learnSkill(G.state, G.stats, id)) { G.recompute(); refreshSkill(); bg.querySelector('.modal').outerHTML = render(); } else toast('강화할 수 없어요', 'warn') }
  })
}

// ===== 펫 ==================================================================
function petStatsLine(grade, star) { const ps = petStats(grade, star); return Object.entries(ps).map(([k, v]) => `<span>${PET_STAT_LABEL[k]} +${(v * 100).toFixed(0)}%</span>`).join('') }
function petsHTML() {
  const s = G.state, st = G.stats; reconcileEquip(s)
  const slots = maxPetSlots(st), eq = s.petEquip || []
  const equipped = eq.map(k => { const { grade, star } = parsePetKey(k), g = PET_GRADE_BY_ID[grade]; return `<div class="petcard eq" style="--rc:${g.color}"><div class="pet-ico">${img(PET_ART[g.art], '')}</div><div class="pet-name">${g.name} ${star}성</div><div class="pet-stats">${petStatsLine(grade, star)}</div><button class="petbtn" data-act="petunequip" data-key="${k}">해제</button></div>` }).join('') || '<div class="empty">착용한 펫이 없어요</div>'
  const ownedKeys = Object.keys(s.pets).filter(k => s.pets[k] > 0).sort((a, b) => { const A = parsePetKey(a), B = parsePetKey(b); return (PET_GRADE_BY_ID[B.grade].idx - PET_GRADE_BY_ID[A.grade].idx) || (B.star - A.star) })
  const owned = ownedKeys.map(k => { const { grade, star } = parsePetKey(k), g = PET_GRADE_BY_ID[grade], cnt = s.pets[k], isEq = eq.includes(k); return `<div class="petcard" style="--rc:${g.color}"><div class="pet-cnt">×${cnt}</div><div class="pet-ico">${img(PET_ART[g.art], '')}</div><div class="pet-name">${g.name} ${star}성</div><div class="pet-stats">${petStatsLine(grade, star)}</div><div class="pet-acts"><button class="petbtn ${isEq ? 'on' : ''}" data-act="petequip" data-key="${k}">${isEq ? '착용중' : '장착'}</button><button class="petbtn ${cnt >= 2 ? '' : 'cant'}" data-act="petfuse" data-key="${k}">합성</button></div></div>` }).join('') || '<div class="empty">보유한 펫이 없어요. 아래 상점에서 구매!</div>'
  const shop = PET_GRADES.map(g => `<div class="petshop-row" style="--rc:${g.color}"><div class="pet-ico sm">${img(PET_ART[g.art], '')}</div><div class="petshop-name">${g.name}</div>
    <button class="petbuy" data-act="petbuy" data-grade="${g.id}" data-star="1" ${s.fat < petBuyPrice(g.id, 1) ? 'disabled' : ''}>1성 · ${fmt(petBuyPrice(g.id, 1))} g</button>
    <button class="petbuy" data-act="petbuy" data-grade="${g.id}" data-star="6" ${s.fat < petBuyPrice(g.id, 6) ? 'disabled' : ''}>6성 · ${fmt(petBuyPrice(g.id, 6))} g</button></div>`).join('')
  return `<div class="pets-wrap">
    <div class="pet-sec"><div class="pet-h">착용 (${eq.length}/${slots})</div><div class="petgrid">${equipped}</div></div>
    <div class="pet-sec"><div class="pet-h">보유 펫 <span class="muted">· 같은 등급·성 2개 합성→1성↑ (10성 2개→다음 등급 1성)</span></div><div class="petgrid">${owned}</div></div>
    <div class="pet-sec"><div class="pet-h">펫 상점 <span class="muted">· 각 등급 1성·6성만 판매</span></div><div class="petshop">${shop}</div></div>
  </div>`
}

// ===== 명성(환생 + 상점) ===================================================
function fameHTML() {
  const s = G.state
  const shop = FAME_SHOP.map(n => { const lv = s.fameBuys[n.id] || 0, maxed = lv >= n.max, cost = fameNodeCost(n, lv), can = !maxed && s.fame >= cost; return `<div class="fame-item ${can ? 'can' : ''}"><div class="fi-mid"><div class="fi-name">${n.name} <span class="fi-lv">${maxed ? 'MAX' : `${lv}/${n.max}`}</span></div><div class="fi-desc">${n.desc}</div></div><button class="fi-buy ${can ? '' : 'cant'}" data-act="famebuy" data-id="${n.id}" ${maxed ? 'disabled' : ''}>${maxed ? '완료' : '명성 ' + fmt(cost)}</button></div>` }).join('')
  return `<div class="fame-wrap">
    <div class="pg-card"><div class="pg-emoji">${img(UI_ART.star, 'pg-star')}</div><div class="pg-title">미슐랭 환생</div>
      <p class="pg-desc">음식·지방·레벨·스킬·펫·단계를 <b>전부 초기화</b>하고 <b>명성</b>을 얻어요. 명성으로 아래 <b>영구 강화</b>를 사면 다음 회차가 훨씬 빨라져요. (도감·명성상점은 유지)</p>
      <div class="pg-now">보유 명성 <b id="pg-fame">${fmt(s.fame)}</b> · 환생 <b>${s.prestigeCount}</b>회</div>
      <div class="pg-gain">환생하면 → <b id="pg-gain">+0</b> 명성</div>
      <button class="pg-btn" data-act="prestige">환생하기</button><div class="muted" id="pg-hint" style="margin-top:6px"></div></div>
    <div class="fame-shop"><div class="pet-h">명성 상점 (영구)</div>${shop}</div>
  </div>`
}
function updateFame() { const s = G.state, gain = prestigeGain(s, G.stats), g1 = $('#pg-gain'); if (!g1) return; g1.textContent = '+' + fmt(gain); $('#pg-fame').textContent = fmt(s.fame); const btn = H.tabbody.querySelector('.pg-btn'); if (btn) btn.classList.toggle('cant', gain <= 0); $('#pg-hint').textContent = gain <= 0 ? '아직 환생 이득이 없어요 — 더 키운 뒤에!' : '' }

// ===== 가챠/도감/통계 ======================================================
function gachaHTML() { const s = G.state; const odds = RARITIES.map(r => `<span class="odd" style="--rc:${r.color}">${r.name} ${(r.weight * 100 >= 0.1 ? (r.weight * 100).toFixed(1) : (r.weight * 100).toFixed(2))}%</span>`).join(''); return `<div class="gacha-wrap"><div class="gacha-banner"><div class="gb-title">미식 가챠</div><div class="gb-sub">수백 종! 중복 획득 시 효과 강화. 보유시 영구 합산.</div><div class="odds">${odds}</div></div><div class="pull-row"><button class="pull-btn" data-act="pull" data-n="1" ${s.cubes < PULL_COST[1] ? 'disabled' : ''}>1회<br><small>큐브 ${PULL_COST[1]}</small></button><button class="pull-btn big" data-act="pull" data-n="10" ${s.cubes < PULL_COST[10] ? 'disabled' : ''}>10연차<br><small>큐브 ${PULL_COST[10]} · 희귀확정</small></button></div><div class="cube-info">보유 큐브 <b>${fmt(s.cubes)}</b> · 큐브는 장비 마일스톤·단계해금·환생으로 모여요</div><div id="pull-out" class="pull-out"></div></div>` }
function statLabel(k) { return ({ kcal: '칼로리', speed: '제작속도', equip: '장비', fame: '명성', cube: '큐브', luck: '행운' })[k] || k }
function collectionHTML() { const s = G.state, st = G.stats, pool = G.pool, total = pool.items.length; const owned = Object.keys(s.gacha).filter(id => s.gacha[id] > 0).sort((a, b) => RARITIES.findIndex(r => r.id === pool.byId[b].rarity) - RARITIES.findIndex(r => r.id === pool.byId[a].rarity)); const byR = {}; RARITIES.forEach(r => byR[r.id] = 0); owned.forEach(id => byR[pool.byId[id].rarity]++); const summary = RARITIES.map(r => `<div class="rsum" style="--rc:${r.color}"><b>${r.name}</b><span>${byR[r.id]}/${pool.byRarity[r.id].length}</span></div>`).join(''); const cards = owned.map(id => { const it = pool.byId[id], c = s.gacha[id]; const stats = Object.entries(it.stats).map(([k, v]) => `<span>${statLabel(k)} +${v}%</span>`).join(''); return `<div class="gcard" style="--rc:${it.color}">${c > 1 ? `<div class="gc-dupe">×${c}</div>` : ''}<div class="gc-ico">${img(FOOD_ART[it.art], '')}</div><div class="gc-name">${it.name}</div><div class="gc-rar">${it.rarityName}</div><div class="gc-stats">${stats}</div></div>` }).join(''); return `<div class="coll-wrap"><div class="coll-head"><div>도감 <b>${st.distinct}</b> / ${total} 종 · 컬렉션 칼로리 +<b>${Math.floor(st.distinct / 10) * 2}%</b></div><div class="rsum-row">${summary}</div></div><div class="gcards">${cards || '<div class="empty">아직 보유 아이템이 없어요.</div>'}</div></div>` }
function statsHTML() { const s = G.state; const rows = [['플레이 시간', fmtTime(s.stats.playMs / 1000)], ['이번 판 누적', fmt(s.runFat) + ' g'], ['전체 누적', fmt(s.lifetimeFat) + ' g'], ['레벨', 'Lv.' + s.level], ['단계', THEMES[s.stage].name + ` (${s.stage + 1}/${THEMES.length})`], ['명성', fmt(s.fame)], ['환생', s.prestigeCount + '회'], ['총 획득(탭)', fmt(s.stats.collects) + '회'], ['펫 합성', fmt(s.stats.fuses) + '회'], ['가챠', fmt(s.pulls) + '회'], ['도감', G.stats.distinct + '종']]; return `<div class="stats-wrap"><div class="stat-grid">${rows.map(([k, v]) => `<div class="stat-row"><span>${k}</span><b>${v}</b></div>`).join('')}</div><div class="muted" style="margin-top:14px">${G.cloudNote || ''}</div></div>` }

// ===== 입력 ================================================================
function onBodyClick(e) {
  const t = e.target.closest('[data-act]'); if (!t) return
  const act = t.dataset.act, s = G.state, st = G.stats
  if (act === 'mode') { s.buyMode = t.dataset.mode === 'max' ? 'max' : +t.dataset.mode; buildFood() }
  else if (act === 'buyfood') { if (buyFood(s, st, t.dataset.id)) { G.recompute(); updateFood() } else toast('칼로리가 부족해요', 'warn') }
  else if (act === 'collect') { const g = collectFood(s, st, t.dataset.id); if (g > 0) { const r = t.getBoundingClientRect(); spawnFloat(r.left + r.width / 2, r.top, '+' + fmt(g), 'tap'); updateFood() } }
  else if (act === 'advance') { if (!canAdvance(s)) return toast(`지방이 부족해요 (${fmt(stageAdvanceCost(s.stage))} g 필요)`, 'warn'); confirmModal('다음 단계로?', `<b>${fmt(stageAdvanceCost(s.stage))} g</b> 를 소모하고 <b>${THEMES[s.stage + 1].name}</b> 으로 진출해요.`, () => { advanceStage(s); G.recompute(); applyStage(s.stage); FOODUI = null; renderBody(); toast(`${THEMES[s.stage].name} 진출!`, 'gold') }) }
  else if (act === 'sk') openSkillDetail(t.dataset.id)
  else if (act === 'famebuy') { if (fameBuy(s, t.dataset.id)) { G.recompute(); H.tabbody.innerHTML = fameHTML() } else toast('명성이 부족해요', 'warn') }
  else if (act === 'petbuy') { if (buyPet(s, t.dataset.grade, +t.dataset.star)) { G.recompute(); H.tabbody.innerHTML = petsHTML() } else toast('칼로리가 부족해요', 'warn') }
  else if (act === 'petfuse') { const out = fusePet(s, t.dataset.key); if (out) { G.recompute(); H.tabbody.innerHTML = petsHTML(); const o = parsePetKey(out); toast(`합성! ${PET_GRADE_BY_ID[o.grade].name} ${o.star}성`, 'gold') } else toast('같은 펫 2개가 필요해요', 'warn') }
  else if (act === 'petequip') { if (equipPet(s, st, t.dataset.key)) { G.recompute(); H.tabbody.innerHTML = petsHTML() } else toast('이미 착용했거나 슬롯이 가득해요', 'warn') }
  else if (act === 'petunequip') { unequipPet(s, t.dataset.key); G.recompute(); H.tabbody.innerHTML = petsHTML() }
  else if (act === 'pull') { const res = pull(s, st, +t.dataset.n); if (!res) return toast('큐브가 부족해요', 'warn'); G.recompute(); H.tabbody.innerHTML = gachaHTML(); showPulls(res) }
  else if (act === 'prestige') { const gain = prestigeGain(s, st); if (gain <= 0) return toast('아직 환생 이득이 없어요', 'warn'); confirmModal('환생할까요?', `전부 초기화하고 <b>+${fmt(gain)} 명성</b> 획득. (도감·명성상점 유지)`, () => { const g = doPrestige(s, st); G.recompute(); applyStage(0); FOODUI = null; renderBody(); toast(`환생! +${fmt(g)} 명성`, 'gold') }) }
}

// ===== 효과/토스트/모달 ====================================================
function spawnFloat(x, y, text, cls) { const f = el(`<div class="float ${cls}">${text}</div>`); f.style.left = x + 'px'; f.style.top = y + 'px'; $('#float-layer').appendChild(f); setTimeout(() => f.remove(), 850) }
export function toast(msg, type = 'info') { const t = el(`<div class="toast ${type}">${msg}</div>`); $('#toast-layer').appendChild(t); setTimeout(() => t.classList.add('show'), 10); setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300) }, 2800) }
function showPulls(results) { const out = $('#pull-out'); if (!out) return; out.innerHTML = results.map((r, i) => `<div class="pulled" style="--rc:${r.item.color};animation-delay:${i * 55}ms"><div class="p-ico">${img(FOOD_ART[r.item.art], '')}</div><div class="p-name">${r.item.name}</div><div class="p-rar">${r.item.rarityName}${r.isNew ? ' <span class="newtag">NEW</span>' : ' ×' + r.count}</div></div>`).join(''); const best = results.reduce((a, b) => RARITIES.findIndex(r => r.id === b.item.rarity) > RARITIES.findIndex(r => r.id === a.item.rarity) ? b : a); if (RARITIES.findIndex(r => r.id === best.item.rarity) >= 4) toast(`${best.item.rarityName}! ${best.item.name}`, 'gold') }
function confirmModal(title, body, onYes) { const m = el(`<div class="modal-bg"><div class="modal"><h3>${title}</h3><p>${body}</p><div class="modal-btns"><button class="ghost" data-x="no">취소</button><button class="primary" data-x="yes">확인</button></div></div></div>`); $('#modal-layer').appendChild(m); m.addEventListener('click', e => { if (e.target.dataset.x === 'yes') { onYes(); m.remove() } else if (e.target.dataset.x === 'no' || e.target === m) m.remove() }) }
export function showOffline(info) { const body = info.gain > 0 ? `<p>${fmtTime(info.dt)} 동안 비웠어요${info.capped ? ` (보상 ${fmtTime(info.t)}까지)` : ''}.</p><p class="off-gain">자동 생산 <b>+${fmt(info.gain)} g</b> <span class="muted">(효율 ${Math.round(info.eff * 100)}%)</span></p>` : `<p>${fmtTime(info.dt)} 동안 비웠어요.</p><p class="muted">스킬·펫으로 자동 획득을 켜면 자리를 비운 동안에도 벌어요!</p>`; const m = el(`<div class="modal-bg"><div class="modal"><h3>다녀온 사이</h3>${body}<div class="modal-btns"><button class="primary" data-x="ok">확인</button></div></div></div>`); $('#modal-layer').appendChild(m); m.addEventListener('click', e => { if (e.target.dataset.x === 'ok' || e.target === m) m.remove() }) }
