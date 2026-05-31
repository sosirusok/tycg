// ============================================================================
//  신우 키우기 — UI (단계 배경 크게 / 음식 제작·획득 / 중심형 스킬 그래프)
// ============================================================================
import {
  BAL, FOODS, FOOD_BY_ID, SKILLS, RARITIES, STAGES,
  fmt, fmtTime, nextEquipMilestone, skillNodeCost,
} from './data.js'
import {
  computeStats, incomePerSec, foodCalc, buyInfo, buyFood,
  collectFood, collectAll, readyCount, learnSkill, availablePoints, findSkill, isNodeUnlocked,
  pull, PULL_COST, prestigeGain, doPrestige, tap, stageProgress,
} from './engine.js'
import { FOOD_ART, CHAR_ART, UI_ART, BG_ART, img } from './assets.js'

const $ = s => document.querySelector(s)
const el = h => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild }

const TABS = [['food', '음식'], ['skills', '스킬'], ['gacha', '가챠'], ['collection', '도감'], ['prestige', '환생'], ['stats', '통계']]
const CHAR_STAGES = [{ min: 0, art: 's1', n: '병아리 식신' }, { min: 8, art: 's2', n: '먹보' }, { min: 20, art: 's3', n: '미식가' }, { min: 40, art: 's4', n: '오너 셰프' }, { min: 70, art: 's5', n: '식품왕' }, { min: 110, art: 's6', n: '미식황제' }, { min: 160, art: 's7', n: '우주 미식신' }]
const stageFor = lv => { let s = CHAR_STAGES[0]; for (const x of CHAR_STAGES) if (lv >= x.min) s = x; return s }

let G = null, activeTab = 'food'
const H = {}
let FOODUI = null      // 음식 탭 캐시
let SKILLUI = null     // 스킬 그래프 캐시

export function initUI(game) { G = game; applyStage(G.state.stage); buildShell(); switchTab('food') }

export function applyStage(s) {
  const st = STAGES[Math.max(0, Math.min(STAGES.length - 1, s))]
  for (const k in st.vars) document.documentElement.style.setProperty(k, st.vars[k])
  const bg = BG_ART[st.bg]
  document.body.style.backgroundImage = bg ? `url("${bg}")` : 'none'
  H.curStageBg = s
}

function buildShell() {
  const app = $('#app'); app.className = 'game-root'
  app.innerHTML = `
  <div class="game">
    <header class="topbar">
      <div class="brand">신우 키우기</div>
      <div class="currencies">
        <div class="cur" title="칼로리(지방) — 기본 화폐">${img(UI_ART.fat, 'cur-ico')}<b id="cur-fat">0</b><span class="unit">g</span></div>
        <div class="cur" title="미슐랭 ★ — 환생 화폐">${img(UI_ART.star, 'cur-ico')}<b id="cur-star">0</b></div>
        <div class="cur" title="큐브 — 가챠 화폐">${img(UI_ART.cube, 'cur-ico')}<b id="cur-cube">0</b></div>
        <div class="cur cur-inc" title="초당 생산">${'+'}<b id="cur-inc">0</b><span class="unit">g/초</span></div>
      </div>
      <div class="topright">
        <button class="hero" id="hero" title="신우 (탭하면 약간의 칼로리)">
          ${img(CHAR_ART.s1, 'hero-art', 'id="hero-art"')}
          <span class="hero-lv">Lv.<b id="hero-lvl">0</b><span id="hero-sp" class="hero-sp"></span></span>
        </button>
        <button class="ghost sm" id="btn-logout">로그아웃</button>
      </div>
    </header>
    <nav class="tabs" id="tabs">${TABS.map(([id, n]) => `<button class="tab" data-tab="${id}">${n}</button>`).join('')}</nav>
    <div class="tabbody" id="tabbody"></div>
    <div id="float-layer"></div><div id="toast-layer"></div><div id="modal-layer"></div>
  </div>`

  H.fat = $('#cur-fat'); H.star = $('#cur-star'); H.cube = $('#cur-cube'); H.inc = $('#cur-inc')
  H.heroArt = $('#hero-art'); H.heroLvl = $('#hero-lvl'); H.heroSp = $('#hero-sp'); H.curHero = 's1'
  H.tabbody = $('#tabbody')

  $('#tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) switchTab(b.dataset.tab) })
  $('#btn-logout').addEventListener('click', () => G.onLogout && G.onLogout())
  $('#hero').addEventListener('click', e => { const r = tap(G.state, G.stats, G.income); G.recompute(); spawnFloat(e.clientX, e.clientY, '+' + fmt(r.gain), 'tap') })
  H.tabbody.addEventListener('click', onBodyClick)
}

function switchTab(tab) { activeTab = tab; document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); FOODUI = null; SKILLUI = null; renderBody() }

// ---------------------------------------------------------------------------
export function render() {
  const s = G.state
  H.fat.textContent = fmt(s.fat); H.star.textContent = fmt(s.stars); H.cube.textContent = fmt(s.cubes); H.inc.textContent = fmt(G.income)
  const stg = stageFor(s.level)
  if (stg.art !== H.curHero && CHAR_ART[stg.art]) { H.heroArt.src = CHAR_ART[stg.art]; H.curHero = stg.art }
  H.heroLvl.textContent = s.level
  const sp = availablePoints(s); H.heroSp.textContent = sp > 0 ? ` · SP ${sp}` : ''; H.heroSp.classList.toggle('hot', sp > 0)
  if (s.stage !== H.curStageBg) applyStage(s.stage)
  if (activeTab === 'food') updateFood()
  else if (activeTab === 'prestige') updatePrestige()
  else if (activeTab === 'skills' && SKILLUI) refreshSkill()
}

function renderBody() {
  if (activeTab === 'food') return buildFood()
  if (activeTab === 'skills') return buildSkill()
  const b = H.tabbody
  if (activeTab === 'gacha') b.innerHTML = gachaHTML()
  else if (activeTab === 'collection') b.innerHTML = collectionHTML()
  else if (activeTab === 'prestige') b.innerHTML = prestigeHTML()
  else if (activeTab === 'stats') b.innerHTML = statsHTML()
}

// ===== 음식 탭 ==============================================================
function firstOfStage(i) { return i === 0 || FOODS[i - 1].stage !== FOODS[i].stage }
function foodRevealed(s, i) {
  const f = FOODS[i]
  if (f.stage < s.stage) return true
  if (f.stage > s.stage) return false
  return firstOfStage(i) || (s.foods[FOODS[i - 1].id]?.equip || 0) > 0
}

function buildFood() {
  const s = G.state, st = G.stats
  const sp = stageProgress(s)
  const stage = STAGES[s.stage]
  const modes = [['1', 'x1'], ['10', 'x10'], ['100', 'x100'], ['max', 'MAX']]
  const banner = `<div class="scene" style="background-image:url('${BG_ART[stage.bg] || ''}')">
    <div class="scene-grad"></div>
    <div class="scene-row">
      <div class="scene-stage">
        <div class="scene-badge">단계 ${s.stage + 1}/${STAGES.length}</div>
        <div class="scene-name">${stage.name}</div>
        ${sp.next != null
      ? `<div class="scene-prog"><div class="scene-progfill" style="width:${(sp.pct * 100).toFixed(1)}%"></div></div>
           <div class="scene-need">다음 단계 <b>${STAGES[sp.next].name}</b> 까지 누적 ${fmt(sp.need)} g (${Math.floor(sp.pct * 100)}%)</div>`
      : `<div class="scene-need">최종 단계 도달! 🎉</div>`}
      </div>
    </div>
  </div>`
  const head = `<div class="food-head">
    <button class="collect-all" data-act="collectall">모두 획득</button>
    <div class="buymode">${modes.map(([m, l]) => `<button class="bm-btn ${String(s.buyMode) === m ? 'on' : ''}" data-act="mode" data-mode="${m}">${l}</button>`).join('')}</div>
  </div>`
  const rows = FOODS.map((f, i) => {
    if (!foodRevealed(s, i)) {
      const why = f.stage > s.stage ? `${STAGES[f.stage].name} 단계 해금 필요` : '앞 음식을 먼저 사봐'
      return `<div class="food locked"><div class="food-ico ghost"></div><div class="food-mid"><div class="food-top"><span class="food-name">??? </span></div><div class="food-sub">${why}</div></div></div>`
    }
    return `<div class="food" data-id="${f.id}">
      <div class="food-ico">${img(FOOD_ART[f.art], '')}</div>
      <div class="food-mid">
        <div class="food-top"><span class="food-name">${f.name}</span><span class="food-equip" data-r="equip">장비 0</span></div>
        <div class="food-bar"><div class="food-fill" data-r="fill"></div></div>
        <div class="food-sub"><span data-r="yield"></span> <span class="auto-badge hidden" data-r="auto">자동</span></div>
      </div>
      <div class="food-act">
        <button class="collect" data-act="collect" data-id="${f.id}" data-r="cbtn">제작 중</button>
        <button class="food-buy" data-act="buyfood" data-id="${f.id}"><span data-r="bm">장비</span><span data-r="bc"></span></button>
      </div>
    </div>`
  }).join('')
  H.tabbody.innerHTML = `${banner}${head}<div class="food-list">${rows}</div>`
  FOODUI = { sig: foodSig(s, st), refs: {} }
  H.tabbody.querySelectorAll('.food[data-id]').forEach(row => {
    const id = row.dataset.id
    FOODUI.refs[id] = { equip: row.querySelector('[data-r=equip]'), fill: row.querySelector('[data-r=fill]'), yield: row.querySelector('[data-r=yield]'), auto: row.querySelector('[data-r=auto]'), cbtn: row.querySelector('[data-r=cbtn]'), bm: row.querySelector('[data-r=bm]'), bc: row.querySelector('[data-r=bc]') }
  })
  updateFood()
}
function foodSig(s, st) {
  let revealed = 0, auto = 0
  for (let i = 0; i < FOODS.length; i++) { if (foodRevealed(s, i)) revealed++; if (st.allAuto || st.fAuto.has(FOODS[i].id)) auto++ }
  return s.stage + '|' + s.buyMode + '|' + revealed + '|' + auto
}
function updateFood() {
  const s = G.state, st = G.stats
  if (!FOODUI || FOODUI.sig !== foodSig(s, st)) return buildFood()
  let anyReady = false
  for (const f of FOODS) {
    const r = FOODUI.refs[f.id]; if (!r) continue
    const fs = s.foods[f.id], c = foodCalc(s, st, f)
    r.equip.textContent = '장비 ' + fmt(fs.equip)
    r.yield.textContent = fs.equip > 0 ? `${fmt(c.perCycle)} g / ${fmtTime(c.cycle)}` : '미가동'
    r.auto.classList.toggle('hidden', !c.auto)
    if (c.auto) { r.fill.style.width = '100%'; r.fill.classList.add('auto'); r.cbtn.classList.add('hidden') }
    else {
      r.fill.classList.remove('auto'); r.cbtn.classList.remove('hidden')
      r.fill.style.width = (c.cycle > 0 ? Math.min(100, fs.prog / c.cycle * 100) : 0) + '%'
      if (fs.ready) { anyReady = true; r.cbtn.classList.add('ready'); r.cbtn.textContent = '획득 +' + fmt(c.perCycle) }
      else { r.cbtn.classList.remove('ready'); r.cbtn.textContent = fs.equip > 0 ? '제작 ' + fmtTime(Math.max(0, c.cycle - fs.prog)) : '장비 필요' }
    }
    const info = buyInfo(s, st, f.id)
    r.bm.textContent = '장비 +' + fmt(info.k)
    r.bc.textContent = fmt(info.cost) + ' g'
    r.bm.parentElement.classList.toggle('cant', !info.affordable)
  }
  const ca = H.tabbody.querySelector('.collect-all'); if (ca) ca.classList.toggle('show', anyReady)
}

// ===== 스킬 그래프 ==========================================================
function buildSkill() {
  const nodes = SKILLS.nodes
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9
  for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y) }
  const pad = 110, W = (maxX - minX) + pad * 2, Hh = (maxY - minY) + pad * 2
  const X = n => n.x - minX + pad, Y = n => n.y - minY + pad
  // edges
  let lines = ''
  for (const n of nodes) for (const d of (n.deps || [])) { const p = SKILLS.byId[d.node]; if (!p) continue; lines += `<line x1="${X(p)}" y1="${Y(p)}" x2="${X(n)}" y2="${Y(n)}" />` }
  const nodeHTML = nodes.map(n => {
    const isFood = !!n.cluster
    const ic = isFood ? img(FOOD_ART[FOOD_BY_ID[n.cluster].art], 'sk-art') : `<span class="sk-glyph">${glyph(n)}</span>`
    return `<button class="sknode" data-act="skill" data-id="${n.id}" style="left:${X(n)}px;top:${Y(n)}px" title="">
      <span class="sk-ic">${ic}</span><span class="sk-tag">${skTag(n)}</span><span class="sk-lv" data-r="lv"></span></button>`
  }).join('')
  H.tabbody.innerHTML = `
    <div class="sk-bar">스킬 포인트 <b id="sk-sp">0</b> <span class="muted">· 중심(신우의 부엌)에서 뻗어나가며, 조건을 만족하면 잠금 해제돼</span></div>
    <div class="sk-scroll"><div class="sk-canvas" style="width:${W}px;height:${Hh}px">
      <svg class="sk-edges" width="${W}" height="${Hh}">${lines}</svg>
      ${nodeHTML}
    </div></div>`
  SKILLUI = { els: {} }
  H.tabbody.querySelectorAll('.sknode').forEach(b => { SKILLUI.els[b.dataset.id] = { b, lv: b.querySelector('[data-r=lv]') } })
  // 첫 진입 시 중심으로 스크롤
  const scroll = H.tabbody.querySelector('.sk-scroll')
  requestAnimationFrame(() => { const root = SKILLS.byId.root; scroll.scrollLeft = X(root) - scroll.clientWidth / 2; scroll.scrollTop = Y(root) - scroll.clientHeight / 2 })
  refreshSkill()
}
function glyph(n) { const k = n.eff && n.eff.k; return ({ allKcal: '칼', allTime: '속', allEquip: '장', starGain: '별', starPow: '★', offline: '오', xp: '경', cube: '큐', allAuto: '⚡' })[k] || '✦' }
function skTag(n) { if (n.free) return '시작'; const k = n.eff && n.eff.k; return ({ fEquip: '장비', fKcal: '칼로리', fTime: '속도', fAuto: '자동', fMaster: '마스터', allKcal: '전체칼로리', allTime: '전체속도', allEquip: '전체장비', allAuto: '전자동', starGain: '★획득', starPow: '★강화', offline: '오프라인', xp: '경험치', cube: '큐브' })[k] || '' }
function condText(n) {
  const parts = []
  for (const d of (n.deps || [])) { const p = SKILLS.byId[d.node]; if (p && d.lvl > 0) parts.push(`선행 ‘${p.name}’ ${d.lvl}렙↑`) }
  if (n.cond) { if (n.cond.stage != null) parts.push(`‘${STAGES[n.cond.stage].name}’ 단계 도달`); if (n.cond.fat != null) parts.push(`누적 ${fmt(n.cond.fat)}g↑`); if (n.cond.foodLevel) parts.push(`${FOOD_BY_ID[n.cond.foodLevel.food].name} 장비 ${n.cond.foodLevel.equip}↑`) }
  return parts.length ? '잠금조건: ' + parts.join(', ') : ''
}
function refreshSkill() {
  const s = G.state, pts = availablePoints(s)
  const spEl = $('#sk-sp'); if (spEl) spEl.textContent = pts
  for (const n of SKILLS.nodes) {
    const ref = SKILLUI.els[n.id]; if (!ref) continue
    const lv = s.skills[n.id] || 0, maxed = lv >= n.max, unlocked = isNodeUnlocked(s, n)
    const cost = skillNodeCost(n, lv), can = !maxed && unlocked && pts >= cost
    ref.lv.textContent = n.free ? '' : (maxed ? 'MAX' : (n.max === 1 ? (lv ? '✓' : skTagCost(cost)) : `${lv}/${n.max}`))
    ref.b.classList.toggle('locked', !unlocked && !n.free)
    ref.b.classList.toggle('maxed', maxed)
    ref.b.classList.toggle('can', can)
    ref.b.classList.toggle('owned', lv > 0)
    ref.b.title = `${n.name}\n${n.desc}${maxed ? '' : `\n비용 SP ${cost}`}${unlocked || n.free ? '' : '\n' + condText(n)}`
  }
}
function skTagCost(c) { return 'SP' + c }

// ===== 가챠 / 도감 / 환생 / 통계 (보조) =====================================
function gachaHTML() {
  const s = G.state
  const odds = RARITIES.map(r => `<span class="odd" style="--rc:${r.color}">${r.name} ${(r.weight * 100 >= 0.1 ? (r.weight * 100).toFixed(1) : (r.weight * 100).toFixed(2))}%</span>`).join('')
  return `<div class="gacha-wrap">
    <div class="gacha-banner"><div class="gb-title">미식 가챠</div>
      <div class="gb-sub">수백 종! 같은 걸 또 뽑으면 효과가 강해져요(중복 강화). 보유시 능력치 영구 합산.</div>
      <div class="odds">${odds}</div></div>
    <div class="pull-row">
      <button class="pull-btn" data-act="pull" data-n="1" ${s.cubes < PULL_COST[1] ? 'disabled' : ''}>1회 뽑기<br><small>큐브 ${PULL_COST[1]}</small></button>
      <button class="pull-btn big" data-act="pull" data-n="10" ${s.cubes < PULL_COST[10] ? 'disabled' : ''}>10연차<br><small>큐브 ${PULL_COST[10]} · 희귀확정</small></button>
    </div>
    <div class="cube-info">보유 큐브 <b>${fmt(s.cubes)}</b> · 큐브는 <b>장비 마일스톤·레벨업·단계해금·환생</b>으로 모여요</div>
    <div id="pull-out" class="pull-out"></div></div>`
}
function statLabel(k) { return ({ kcal: '칼로리', speed: '제작속도', equip: '장비', star: '★', cube: '큐브', luck: '행운' })[k] || k }
function collectionHTML() {
  const s = G.state, st = G.stats, pool = G.pool, total = pool.items.length
  const owned = Object.keys(s.gacha).filter(id => s.gacha[id] > 0).sort((a, b) => RARITIES.findIndex(r => r.id === pool.byId[b].rarity) - RARITIES.findIndex(r => r.id === pool.byId[a].rarity))
  const byR = {}; RARITIES.forEach(r => byR[r.id] = 0); owned.forEach(id => byR[pool.byId[id].rarity]++)
  const summary = RARITIES.map(r => `<div class="rsum" style="--rc:${r.color}"><b>${r.name}</b><span>${byR[r.id]}/${pool.byRarity[r.id].length}</span></div>`).join('')
  const cards = owned.map(id => { const it = pool.byId[id], c = s.gacha[id]; const stats = Object.entries(it.stats).map(([k, v]) => `<span>${statLabel(k)} +${v}%</span>`).join(''); return `<div class="gcard" style="--rc:${it.color}">${c > 1 ? `<div class="gc-dupe">×${c}</div>` : ''}<div class="gc-ico">${img(FOOD_ART[it.art], '')}</div><div class="gc-name">${it.name}</div><div class="gc-rar">${it.rarityName}</div><div class="gc-stats">${stats}</div></div>` }).join('')
  return `<div class="coll-wrap"><div class="coll-head"><div>도감 <b>${st.distinct}</b> / ${total} 종 · 컬렉션 칼로리 +<b>${Math.floor(st.distinct / 10) * 2}%</b></div><div class="rsum-row">${summary}</div></div>
    <div class="gcards">${cards || '<div class="empty">아직 보유 아이템이 없어요. 가챠에서 뽑아보세요!</div>'}</div></div>`
}
function prestigeHTML() {
  const s = G.state
  return `<div class="prestige-wrap"><div class="pg-card"><div class="pg-emoji">${img(UI_ART.star, 'pg-star')}</div>
    <div class="pg-title">미슐랭 환생</div>
    <p class="pg-desc">음식과 칼로리를 초기화하고 <b>미슐랭 ★</b>을 얻어요. ★1당 모든 칼로리 <b>+${(G.stats.starPower * 100).toFixed(1)}%</b>(영구·곱연산). 스킬·레벨·단계·도감 유지.</p>
    <div class="pg-now">현재 ★ <b id="pg-cur">${fmt(s.stars)}</b> · 환생 <b>${s.prestigeCount}</b>회 · 배수 <b id="pg-multnow">×${G.stats.prestigeMult.toFixed(2)}</b></div>
    <div class="pg-gain">환생하면 → <b id="pg-gain">+0 ★</b></div><div class="pg-after" id="pg-after"></div>
    <button class="pg-btn" data-act="prestige">환생하기</button><div class="muted" id="pg-hint" style="margin-top:8px"></div></div></div>`
}
function updatePrestige() {
  const s = G.state, st = G.stats, gain = prestigeGain(s, st), g1 = $('#pg-gain'); if (!g1) return
  g1.textContent = `+${fmt(gain)} ★`; $('#pg-cur').textContent = fmt(s.stars); $('#pg-multnow').textContent = '×' + st.prestigeMult.toFixed(2)
  $('#pg-after').textContent = gain > 0 ? `환생 후 배수 ×${(1 + (s.stars + gain) * st.starPower).toFixed(2)}` : ''
  const btn = H.tabbody.querySelector('.pg-btn'); if (btn) btn.classList.toggle('cant', gain <= 0)
  $('#pg-hint').textContent = gain <= 0 ? '아직 환생 이득이 없어요 — 더 키운 뒤에!' : ''
}
function statsHTML() {
  const s = G.state
  const rows = [['플레이 시간', fmtTime(s.stats.playMs / 1000)], ['누적 칼로리', fmt(s.lifetimeFat) + ' g'], ['이번 판', fmt(s.runFat) + ' g'], ['레벨', 'Lv.' + s.level], ['단계', STAGES[s.stage].name], ['미슐랭 ★', fmt(s.stars)], ['환생', s.prestigeCount + '회'], ['총 획득', fmt(s.stats.collects) + '회'], ['가챠', fmt(s.pulls) + '회'], ['도감', G.stats.distinct + '종']]
  return `<div class="stats-wrap"><div class="stat-grid">${rows.map(([k, v]) => `<div class="stat-row"><span>${k}</span><b>${v}</b></div>`).join('')}</div><div class="muted" style="margin-top:14px">${G.cloudNote || ''}</div></div>`
}

// ===== 입력 ================================================================
function onBodyClick(e) {
  const t = e.target.closest('[data-act]'); if (!t) return
  const act = t.dataset.act, s = G.state, st = G.stats
  if (act === 'mode') { s.buyMode = t.dataset.mode === 'max' ? 'max' : +t.dataset.mode; buildFood() }
  else if (act === 'buyfood') { if (buyFood(s, st, t.dataset.id)) { G.recompute(); updateFood() } else toast('칼로리가 부족해요', 'warn') }
  else if (act === 'collect') { const g = collectFood(s, st, t.dataset.id); if (g > 0) { const r = t.getBoundingClientRect(); spawnFloat(r.left + r.width / 2, r.top, '+' + fmt(g), 'tap'); updateFood() } }
  else if (act === 'collectall') { const g = collectAll(s, st); if (g > 0) { const r = t.getBoundingClientRect(); spawnFloat(r.left + r.width / 2, r.top, '+' + fmt(g), 'gold'); updateFood() } }
  else if (act === 'skill') {
    const id = t.dataset.id
    if (learnSkill(s, id)) { G.recompute(); refreshSkill() }
    else { const n = findSkill(id); if (n && !isNodeUnlocked(s, n)) toast('잠금: ' + (condText(n) || '조건 미충족'), 'warn'); else if (n && (s.skills[id] || 0) >= n.max) toast('이미 최대', 'warn'); else toast('스킬 포인트가 부족해요', 'warn') }
  }
  else if (act === 'pull') { const res = pull(s, st, +t.dataset.n); if (!res) return toast('큐브가 부족해요', 'warn'); G.recompute(); H.tabbody.innerHTML = gachaHTML(); showPulls(res) }
  else if (act === 'prestige') { const gain = prestigeGain(s, st); if (gain <= 0) return toast('아직 환생 이득이 없어요', 'warn'); confirmModal('환생할까요?', `음식·칼로리 초기화 후 <b>+${fmt(gain)} ★</b> 획득. (스킬·레벨·단계·도감 유지)`, () => { const g = doPrestige(s, st); G.recompute(); FOODUI = null; renderBody(); toast(`환생! +${fmt(g)} ★`, 'gold') }) }
}

// ===== 효과/토스트/모달 =====================================================
function spawnFloat(x, y, text, cls) { const f = el(`<div class="float ${cls}">${text}</div>`); f.style.left = x + 'px'; f.style.top = y + 'px'; $('#float-layer').appendChild(f); setTimeout(() => f.remove(), 850) }
export function toast(msg, type = 'info') { const t = el(`<div class="toast ${type}">${msg}</div>`); $('#toast-layer').appendChild(t); setTimeout(() => t.classList.add('show'), 10); setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300) }, 2800) }
function showPulls(results) {
  const out = $('#pull-out'); if (!out) return
  out.innerHTML = results.map((r, i) => `<div class="pulled" style="--rc:${r.item.color};animation-delay:${i * 55}ms"><div class="p-ico">${img(FOOD_ART[r.item.art], '')}</div><div class="p-name">${r.item.name}</div><div class="p-rar">${r.item.rarityName}${r.isNew ? ' <span class="newtag">NEW</span>' : ' ×' + r.count}</div></div>`).join('')
  const best = results.reduce((a, b) => RARITIES.findIndex(r => r.id === b.item.rarity) > RARITIES.findIndex(r => r.id === a.item.rarity) ? b : a)
  if (RARITIES.findIndex(r => r.id === best.item.rarity) >= 4) toast(`${best.item.rarityName}! ${best.item.name}`, 'gold')
}
function confirmModal(title, body, onYes) { const m = el(`<div class="modal-bg"><div class="modal"><h3>${title}</h3><p>${body}</p><div class="modal-btns"><button class="ghost" data-x="no">취소</button><button class="primary" data-x="yes">확인</button></div></div></div>`); $('#modal-layer').appendChild(m); m.addEventListener('click', e => { if (e.target.dataset.x === 'yes') { onYes(); m.remove() } else if (e.target.dataset.x === 'no' || e.target === m) m.remove() }) }
export function showOffline(info) {
  const body = info.gain > 0
    ? `<p>${fmtTime(info.dt)} 동안 비웠어요${info.capped ? ` (보상은 ${fmtTime(info.t)}까지)` : ''}.</p><p class="off-gain">자동 생산 <b>+${fmt(info.gain)} g</b> <span class="muted">(효율 ${Math.round(info.eff * 100)}%)</span></p>`
    : `<p>${fmtTime(info.dt)} 동안 비웠어요.</p><p class="muted">자동 획득 스킬을 배우면 자리를 비운 동안에도 자동으로 벌어요!</p>`
  const m = el(`<div class="modal-bg"><div class="modal"><h3>다녀온 사이</h3>${body}<div class="modal-btns"><button class="primary" data-x="ok">확인</button></div></div></div>`)
  $('#modal-layer').appendChild(m); m.addEventListener('click', e => { if (e.target.dataset.x === 'ok' || e.target === m) m.remove() })
}
