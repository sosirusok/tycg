// ============================================================================
//  신우 키우기 — UI (렌더링 / 입력)
// ============================================================================
import {
  BAL, GENERATORS, SKILLS, RARITIES, THEMES,
  fmt, fmtTime, genMilestoneMult, nextMilestone, skillNodeCost,
} from './data.js'
import {
  computeStats, incomePerSec, genIncome, buyInfo, buyGenerator,
  tap, learnSkill, availablePoints, findSkill, pull, PULL_COST,
  prestigeGain, doPrestige, collectGolden,
} from './engine.js'

const $ = sel => document.querySelector(sel)
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild }

const TABS = [
  ['business', '사업', '🏭'], ['skills', '스킬', '🌳'], ['gacha', '가챠', '🎰'],
  ['collection', '도감', '📒'], ['prestige', '환생', '⭐'], ['stats', '통계', '📊'],
]
const CHAR_STAGES = [
  { min: 0, e: '🐣', n: '병아리 식신' }, { min: 8, e: '😋', n: '먹보' },
  { min: 20, e: '😎', n: '미식가' }, { min: 40, e: '🧑‍🍳', n: '오너 셰프' },
  { min: 70, e: '🤵', n: '식품왕' }, { min: 110, e: '👑', n: '미식황제' },
  { min: 160, e: '🌌', n: '우주 미식신' },
]
function stageFor(level) { let s = CHAR_STAGES[0]; for (const x of CHAR_STAGES) if (level >= x.min) s = x; return s }

let G = null
let activeTab = 'business'
const H = {}            // 헤더 참조
let BIZ = null          // 사업 행 참조 + 시그니처

export function initUI(game) {
  G = game
  applyTheme(G.state.theme)
  buildShell()
  switchTab('business')
}

export function applyTheme(id) {
  const th = THEMES.find(t => t.id === id) || THEMES[0]
  for (const k in th.vars) document.documentElement.style.setProperty(k, th.vars[k])
  document.documentElement.dataset.theme = th.id
}

function buildShell() {
  const app = $('#app')
  app.className = 'game-root'
  app.innerHTML = `
  <div class="game">
    <header class="topbar">
      <div class="brand">🍳 신우 키우기</div>
      <div class="currencies">
        <div class="cur cur-fat" title="지방 — 기본 화폐"><span class="ico">🧈</span><b id="cur-fat">0</b><span class="unit">g</span></div>
        <div class="cur cur-star" title="미슐랭 ★ — 환생 화폐"><span class="ico">⭐</span><b id="cur-star">0</b></div>
        <div class="cur cur-cube" title="큐브 — 가챠 화폐"><span class="ico">🧊</span><b id="cur-cube">0</b></div>
        <div class="cur cur-inc" title="초당 생산"><span class="ico">📈</span><b id="cur-inc">0</b><span class="unit">g/s</span><span id="buff-badge" class="buff hidden">🔥×7</span></div>
      </div>
      <div class="topright">
        <span class="who" id="who"></span>
        <button class="ghost" id="btn-theme" title="테마 변경">🎨</button>
        <button class="ghost" id="btn-logout">로그아웃</button>
      </div>
    </header>
    <div class="main">
      <aside class="character">
        <div class="char-emoji" id="char-emoji">🐣</div>
        <div class="char-name">신우 · <span id="char-stage">병아리 식신</span></div>
        <div class="char-lvl">Lv.<b id="char-lvl">0</b> <span class="sp" id="char-sp"></span></div>
        <div class="xpbar"><div id="xpfill"></div><span id="xptext"></span></div>
        <button class="feed-btn" id="feed">신우 먹이기<br><small id="feed-sub">탭하면 지방 획득</small></button>
        <div class="char-stats" id="char-stats"></div>
        <div class="cloud-note" id="cloud-note"></div>
      </aside>
      <section class="content">
        <nav class="tabs" id="tabs">
          ${TABS.map(([id, name, ic]) => `<button class="tab" data-tab="${id}">${ic}<span>${name}</span></button>`).join('')}
        </nav>
        <div class="tabbody" id="tabbody"></div>
      </section>
    </div>
    <div id="golden-layer"></div>
    <div id="float-layer"></div>
    <div id="toast-layer"></div>
    <div id="modal-layer"></div>
  </div>`

  H.fat = $('#cur-fat'); H.star = $('#cur-star'); H.cube = $('#cur-cube'); H.inc = $('#cur-inc'); H.buff = $('#buff-badge')
  H.who = $('#who'); H.emoji = $('#char-emoji'); H.stage = $('#char-stage'); H.lvl = $('#char-lvl')
  H.sp = $('#char-sp'); H.xpfill = $('#xpfill'); H.xptext = $('#xptext'); H.feedSub = $('#feed-sub')
  H.charStats = $('#char-stats'); H.cloud = $('#cloud-note'); H.tabbody = $('#tabbody'); H.golden = $('#golden-layer')

  $('#who').textContent = G.user ? '@' + G.user.id : '게스트(로컬 저장)'

  // 탭 전환
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) switchTab(b.dataset.tab) })
  // 테마
  $('#btn-theme').addEventListener('click', cycleTheme)
  // 로그아웃
  $('#btn-logout').addEventListener('click', () => G.onLogout && G.onLogout())
  // 먹이기
  const feed = $('#feed')
  feed.addEventListener('click', e => doFeed(e.clientX, e.clientY))
  H.emoji.addEventListener('click', e => doFeed(e.clientX, e.clientY))
  // 탭 내부 위임
  H.tabbody.addEventListener('click', onBodyClick)
  // 황금음식 클릭
  H.golden.addEventListener('click', e => {
    const g = e.target.closest('.golden'); if (!g) return
    const r = collectGolden(G.state, G.stats, G.rt, Date.now())
    if (r > 0) { spawnFloat(e.clientX, e.clientY, '🔥 +' + fmt(r), 'gold'); toast('황금 음식! ' + BAL.goldenBuffSecs + '초간 ×' + BAL.goldenBuffMult + ' 폭주!', 'gold') }
  })
}

function cycleTheme() {
  const i = THEMES.findIndex(t => t.id === G.state.theme)
  const next = THEMES[(i + 1) % THEMES.length]
  G.state.theme = next.id
  applyTheme(next.id)
  toast('테마: ' + next.name, 'info')
}

function doFeed(cx, cy) {
  const r = tap(G.state, G.stats, G.income)
  G.recompute()
  spawnFloat(cx, cy, (r.crit ? '💥 ' : '+') + fmt(r.gain), r.crit ? 'crit' : 'tap')
  const e = H.emoji; e.classList.remove('bounce'); void e.offsetWidth; e.classList.add('bounce')
}

function switchTab(tab) {
  activeTab = tab
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
  BIZ = null
  renderTabBody()
}

// ---------------------------------------------------------------------------
//  매 프레임 렌더 (가벼운 갱신)
// ---------------------------------------------------------------------------
export function render() {
  const s = G.state, st = G.stats
  H.fat.textContent = fmt(s.fat)
  H.star.textContent = fmt(s.stars)
  H.cube.textContent = fmt(s.cubes)
  H.inc.textContent = fmt(G.income)
  const buffed = Date.now() < G.rt.buffUntil
  H.buff.classList.toggle('hidden', !buffed)

  const stg = stageFor(s.level)
  H.emoji.textContent = stg.e
  H.stage.textContent = stg.n
  H.lvl.textContent = s.level
  const sp = availablePoints(s)
  H.sp.textContent = sp > 0 ? `· SP ${sp}` : ''
  H.sp.classList.toggle('hot', sp > 0)
  // XP 바: 현재 레벨~다음 레벨 사이 비율(자릿수 기반)
  const lo = Math.pow(10, s.level / 5) - 1, hi = Math.pow(10, (s.level + 1) / 5) - 1
  const p = Math.max(0, Math.min(1, (s.lifetimeFat - lo) / (hi - lo)))
  H.xpfill.style.width = (p * 100).toFixed(1) + '%'
  H.xptext.textContent = `다음 Lv ${Math.floor(p * 100)}%`

  const tapVal = Math.max(BAL.tapBaseFlat, G.income * BAL.tapIncomeFrac) * st.tapMult
  H.feedSub.textContent = `+${fmt(tapVal)} g · 크리 ${Math.round(st.critChance * 100)}%`

  H.charStats.innerHTML = miniStat('초당', fmt(G.income) + ' g')
    + miniStat('환생 배수', '×' + (st.prestigeMult).toFixed(2))
    + miniStat('컬렉션', st.distinct + '종')
    + miniStat('크리배수', '×' + st.critMult.toFixed(1))

  if (G.cloudNote !== undefined) H.cloud.textContent = G.cloudNote

  updateGolden()
  if (activeTab === 'business') updateBusiness()
  else if (activeTab === 'prestige') updatePrestige()
}
const miniStat = (k, v) => `<div class="ms"><span>${k}</span><b>${v}</b></div>`

function updateGolden() {
  const g = G.rt.golden
  let elx = H.golden.querySelector('.golden')
  if (g) {
    if (!elx) { elx = el('<div class="golden">🍔</div>'); H.golden.appendChild(elx) }
    elx.style.left = g.leftPct + '%'; elx.style.top = g.topPct + '%'
  } else if (elx) elx.remove()
}

// ---------------------------------------------------------------------------
//  탭 본문
// ---------------------------------------------------------------------------
function renderTabBody() {
  const b = H.tabbody
  if (activeTab === 'business') { buildBusiness(); return }
  if (activeTab === 'skills') { b.innerHTML = skillsHTML(); return }
  if (activeTab === 'gacha') { b.innerHTML = gachaHTML(); return }
  if (activeTab === 'collection') { b.innerHTML = collectionHTML(); return }
  if (activeTab === 'prestige') { b.innerHTML = prestigeHTML(); return }
  if (activeTab === 'stats') { b.innerHTML = statsHTML(); return }
}

// ----- 사업 -----
function unlockedCount(s) { let n = 1; for (let i = 1; i < GENERATORS.length; i++) { if (s.generators[i - 1] > 0 || s.generators[i] > 0) n = i + 1; else break } return n }

function buildBusiness() {
  const s = G.state, st = G.stats
  const modes = [['1', 'x1', true], ['10', 'x10', st.flags.x10], ['100', 'x100', st.flags.x100], ['max', 'MAX', st.flags.max]]
  const head = `<div class="biz-head">
    <div class="biz-title">음식 사업 <span class="muted">— 사장은 신우, 생산물은 전부 지방(g)</span></div>
    <div class="buymode">${modes.map(([m, label, on]) =>
      `<button class="bm-btn ${String(s.buyMode) === m ? 'on' : ''} ${on ? '' : 'locked'}" data-act="mode" data-mode="${m}">${on ? '' : '🔒'}${label}</button>`).join('')}</div>
  </div>`
  const unlocked = unlockedCount(s)
  const rows = GENERATORS.map((gen, i) => {
    if (i >= unlocked) return `<div class="biz locked"><div class="biz-ico">❔</div><div class="biz-mid"><div class="biz-top"><span class="biz-name">??? 사업</span></div><div class="biz-sub">앞 사업을 먼저 열어줘</div></div></div>`
    return `<div class="biz" data-idx="${i}">
      <div class="biz-ico">${gen.emoji}</div>
      <div class="biz-mid">
        <div class="biz-top"><span class="biz-name">${gen.name}</span><span class="biz-count" data-r="count">×0</span></div>
        <div class="biz-bar"><div class="biz-fill" data-r="fill"></div><span class="biz-ms" data-r="ms"></span></div>
        <div class="biz-inc" data-r="inc"></div>
      </div>
      <button class="biz-buy" data-act="buy" data-idx="${i}">
        <span class="bm" data-r="bm">구매</span><span class="bc" data-r="bc"></span>
      </button>
    </div>`
  }).join('')
  H.tabbody.innerHTML = `<div class="biz-wrap">${head}<div class="biz-list">${rows}</div></div>`
  BIZ = { sig: unlocked + '|' + s.buyMode + '|' + st.flags.x10 + st.flags.x100 + st.flags.max, refs: [] }
  H.tabbody.querySelectorAll('.biz[data-idx]').forEach(row => {
    const i = +row.dataset.idx
    BIZ.refs[i] = {
      row, count: row.querySelector('[data-r=count]'), fill: row.querySelector('[data-r=fill]'),
      ms: row.querySelector('[data-r=ms]'), inc: row.querySelector('[data-r=inc]'),
      bm: row.querySelector('[data-r=bm]'), bc: row.querySelector('[data-r=bc]'), btn: row.querySelector('.biz-buy'),
    }
  })
  updateBusiness()
}

function updateBusiness() {
  const s = G.state, st = G.stats
  const sig = unlockedCount(s) + '|' + s.buyMode + '|' + st.flags.x10 + st.flags.x100 + st.flags.max
  if (!BIZ || BIZ.sig !== sig) { buildBusiness(); return }
  for (let i = 0; i < GENERATORS.length; i++) {
    const r = BIZ.refs[i]; if (!r) continue
    const owned = s.generators[i]
    r.count.textContent = '×' + fmt(owned)
    r.inc.textContent = owned > 0 ? '+' + fmt(genIncome(s, st, i)) + ' g/s' : '미가동'
    const nm = nextMilestone(owned)
    if (nm) {
      let prev = 0; for (const m of BAL.milestones) { if (m === nm) break; prev = m }
      r.fill.style.width = Math.min(100, ((owned - prev) / (nm - prev)) * 100) + '%'
      r.ms.textContent = `다음 ×2: ${nm}`
    } else { r.fill.style.width = '100%'; r.ms.textContent = 'MAX 보너스' }
    const info = buyInfo(s, st, i)
    r.bm.textContent = '구매 ×' + fmt(info.k)
    r.bc.textContent = fmt(info.cost) + ' g'
    r.btn.classList.toggle('cant', !info.affordable)
  }
}

// ----- 스킬 -----
function skillsHTML() {
  const s = G.state
  const pts = availablePoints(s)
  const cols = Object.entries(SKILLS).map(([bid, br]) => {
    const nodes = br.nodes.map(n => {
      const lv = s.skills[n.id] || 0
      const maxed = lv >= n.max
      const cost = skillNodeCost(n, lv)
      const can = !maxed && pts >= cost
      const isFlag = n.k === 'flag'
      const lvlText = isFlag ? (lv ? '보유' : '미보유') : `${lv}/${n.max >= 9999 ? '∞' : n.max}`
      return `<button class="skill ${maxed ? 'maxed' : ''} ${can ? 'can' : ''}" data-act="skill" data-id="${n.id}" ${maxed ? 'disabled' : ''}>
        <div class="sk-top"><span class="sk-name">${n.name}</span><span class="sk-lv">${lvlText}</span></div>
        <div class="sk-desc">${n.desc}</div>
        <div class="sk-cost">${maxed ? '완료' : (isFlag && lv ? '완료' : 'SP ' + cost)}</div>
      </button>`
    }).join('')
    return `<div class="skill-col" style="--bc:${br.color}">
      <div class="skill-colhead">${br.icon} ${br.name}</div>${nodes}</div>`
  }).join('')
  return `<div class="skills-wrap">
    <div class="sp-bar">남은 스킬 포인트 <b>${pts}</b> <span class="muted">· 레벨업하면 SP를 얻어 (현재 Lv.${s.level})</span></div>
    <div class="skill-cols">${cols}</div></div>`
}

// ----- 가챠 -----
function gachaHTML() {
  const s = G.state
  const odds = RARITIES.map(r => `<span class="odd" style="--rc:${r.color}">${r.name} ${(r.weight * 100 >= 0.1 ? (r.weight * 100).toFixed(1) : (r.weight * 100).toFixed(2))}%</span>`).join('')
  return `<div class="gacha-wrap">
    <div class="gacha-banner">
      <div class="gb-title">🎰 미식 가챠</div>
      <div class="gb-sub">수백 종의 식재료·도구·레시피! 보유하면 능력치가 영구 합산돼.</div>
      <div class="odds">${odds}</div>
    </div>
    <div class="pull-row">
      <button class="pull-btn" data-act="pull" data-n="1" ${s.cubes < PULL_COST[1] ? 'disabled' : ''}>
        1회 뽑기<br><small>🧊 ${PULL_COST[1]} 큐브</small></button>
      <button class="pull-btn big" data-act="pull" data-n="10" ${s.cubes < PULL_COST[10] ? 'disabled' : ''}>
        10연차<br><small>🧊 ${PULL_COST[10]} · 희귀 확정</small></button>
    </div>
    <div class="cube-info">보유 🧊 <b>${fmt(s.cubes)}</b> · 큐브는 <b>레벨업</b>·<b>환생</b>·<b>황금음식</b>으로 모아져</div>
    <div id="pull-out" class="pull-out"></div>
  </div>`
}

// ----- 도감 -----
function collectionHTML() {
  const s = G.state, st = G.stats
  const pool = G.pool
  const total = pool.items.length
  const owned = Object.keys(s.gacha).filter(id => s.gacha[id] > 0)
  owned.sort((a, b) => RARITIES.findIndex(r => r.id === pool.byId[b].rarity) - RARITIES.findIndex(r => r.id === pool.byId[a].rarity))
  const byR = {}; RARITIES.forEach(r => byR[r.id] = 0)
  owned.forEach(id => byR[pool.byId[id].rarity]++)
  const summary = RARITIES.map(r => {
    const totR = pool.byRarity[r.id].length
    return `<div class="rsum" style="--rc:${r.color}"><b>${r.name}</b><span>${byR[r.id]}/${totR}</span></div>`
  }).join('')
  const cards = owned.map(id => {
    const it = pool.byId[id], c = s.gacha[id]
    const stats = Object.entries(it.stats).map(([k, v]) => `<span>${statLabel(k)} +${v}%</span>`).join('')
    return `<div class="gcard" style="--rc:${it.color}">
      <div class="gc-ico">${it.emoji}</div>
      <div class="gc-name">${it.name}</div>
      <div class="gc-rar">${it.rarityName}${c > 1 ? ` ×${c}` : ''}</div>
      <div class="gc-stats">${stats}</div></div>`
  }).join('')
  const collBonus = Math.floor(st.distinct / 10) * 2
  return `<div class="coll-wrap">
    <div class="coll-head">
      <div>도감 <b>${st.distinct}</b> / ${total} 종 · 컬렉션 보너스 생산 <b>+${collBonus}%</b></div>
      <div class="rsum-row">${summary}</div>
    </div>
    <div class="gcards">${cards || '<div class="empty">아직 보유한 아이템이 없어. 가챠에서 뽑아봐! 🎰</div>'}</div>
  </div>`
}
function statLabel(k) {
  return ({ prod: '생산', tap: '탭', star: '★', cube: '큐브', luck: '행운', offline: '오프라인' })[k] || k
}

// ----- 환생 -----
function prestigeHTML() {
  const s = G.state
  return `<div class="prestige-wrap">
    <div class="pg-card">
      <div class="pg-emoji">⭐</div>
      <div class="pg-title">미슐랭 환생</div>
      <p class="pg-desc">사업과 지방을 초기화하는 대신 <b>미슐랭 ★</b>을 얻어.
      ★ 1개당 모든 생산이 <b>+${(G.stats.starPower * 100).toFixed(1)}%</b> (영구·곱연산). 스킬·레벨·도감은 유지돼.</p>
      <div class="pg-now">현재 ★ <b id="pg-cur">${fmt(s.stars)}</b> · 환생 <b>${s.prestigeCount}</b>회 · 현재 배수 <b id="pg-multnow">×${G.stats.prestigeMult.toFixed(2)}</b></div>
      <div class="pg-gain">이번에 환생하면 → <b id="pg-gain">+0 ★</b></div>
      <div class="pg-after" id="pg-after"></div>
      <button class="pg-btn" data-act="prestige">환생하기</button>
      <div class="muted" id="pg-hint" style="margin-top:8px"></div>
    </div>
  </div>`
}
function updatePrestige() {
  const s = G.state, st = G.stats
  const gain = prestigeGain(s, st)
  const g1 = $('#pg-gain'); if (!g1) return
  g1.textContent = `+${fmt(gain)} ★`
  $('#pg-cur').textContent = fmt(s.stars)
  $('#pg-multnow').textContent = '×' + st.prestigeMult.toFixed(2)
  const afterMult = 1 + (s.stars + gain) * st.starPower
  $('#pg-after').textContent = gain > 0 ? `환생 후 배수: ×${afterMult.toFixed(2)}` : ''
  const btn = H.tabbody.querySelector('.pg-btn')
  if (btn) btn.classList.toggle('cant', gain <= 0)
  $('#pg-hint').textContent = gain <= 0 ? '아직 환생 이득이 없어 — 더 키운 뒤에! (이번 판 지방이 더 필요해)' : ''
}

// ----- 통계 -----
function statsHTML() {
  const s = G.state
  const rows = [
    ['플레이 시간', fmtTime(s.stats.playMs / 1000)],
    ['누적 지방(영구)', fmt(s.lifetimeFat) + ' g'],
    ['이번 판 지방', fmt(s.runFat) + ' g'],
    ['레벨', 'Lv.' + s.level],
    ['미슐랭 ★', fmt(s.stars)],
    ['환생 횟수', s.prestigeCount + '회'],
    ['총 탭', fmt(s.stats.taps) + '회'],
    ['크리티컬', fmt(s.stats.crits) + '회'],
    ['황금음식', fmt(s.stats.goldens) + '회'],
    ['가챠 횟수', fmt(s.pulls) + '회'],
    ['도감', G.stats.distinct + '종'],
  ]
  return `<div class="stats-wrap"><div class="stat-grid">${rows.map(([k, v]) => `<div class="stat-row"><span>${k}</span><b>${v}</b></div>`).join('')}</div>
   <div class="muted" style="margin-top:14px">${G.cloudNote || ''}</div></div>`
}

// ---------------------------------------------------------------------------
//  입력 위임
// ---------------------------------------------------------------------------
function onBodyClick(e) {
  const t = e.target.closest('[data-act]')
  if (!t) return
  const act = t.dataset.act, s = G.state, st = G.stats
  if (act === 'mode') { s.buyMode = t.dataset.mode === 'max' ? 'max' : +t.dataset.mode; buildBusiness() }
  else if (act === 'buy') {
    const idx = +t.dataset.idx
    const res = buyGenerator(s, st, idx)
    if (res) { G.recompute(); updateBusiness() }
    else toast('지방이 부족해', 'warn')
  }
  else if (act === 'skill') {
    if (learnSkill(s, t.dataset.id)) { G.recompute(); H.tabbody.innerHTML = skillsHTML() }
    else { const f = findSkill(t.dataset.id); toast(availablePoints(s) < skillNodeCost(f.node, s.skills[f.node.id] || 0) ? '스킬 포인트가 부족해' : '더 올릴 수 없어', 'warn') }
  }
  else if (act === 'pull') {
    const n = +t.dataset.n
    const res = pull(s, st, n)
    if (!res) { toast('큐브가 부족해 🧊', 'warn'); return }
    G.recompute(); H.tabbody.innerHTML = gachaHTML(); showPulls(res)
  }
  else if (act === 'prestige') {
    const gain = prestigeGain(s, st)
    if (gain <= 0) { toast('아직 환생 이득이 없어', 'warn'); return }
    confirmModal(`정말 환생할까?`, `사업과 지방이 초기화되고 <b>+${fmt(gain)} ★</b>을 얻어. (스킬·레벨·도감 유지)`, () => {
      const g = doPrestige(s, st); G.recompute(); BIZ = null; renderTabBody()
      toast(`환생 완료! +${fmt(g)} ★ 획득`, 'gold')
    })
  }
}

// ---------------------------------------------------------------------------
//  플로팅 텍스트 / 토스트 / 모달
// ---------------------------------------------------------------------------
function spawnFloat(x, y, text, cls) {
  const f = el(`<div class="float ${cls}">${text}</div>`)
  f.style.left = x + 'px'; f.style.top = y + 'px'
  $('#float-layer').appendChild(f)
  setTimeout(() => f.remove(), 850)
}

let toastT = null
export function toast(msg, type = 'info') {
  const layer = $('#toast-layer')
  const t = el(`<div class="toast ${type}">${msg}</div>`)
  layer.appendChild(t)
  setTimeout(() => t.classList.add('show'), 10)
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300) }, 2600)
}

function showPulls(results) {
  const out = $('#pull-out'); if (!out) return
  out.innerHTML = results.map((r, i) => {
    const it = r.item
    return `<div class="pulled" style="--rc:${it.color}; animation-delay:${i * 60}ms">
      <div class="p-ico">${it.emoji}</div>
      <div class="p-name">${it.name}</div>
      <div class="p-rar">${it.rarityName}${r.isNew ? ' <span class="newtag">NEW</span>' : ' ×' + r.count}</div>
    </div>`
  }).join('')
  const best = results.reduce((a, b) => RARITIES.findIndex(r => r.id === b.item.rarity) > RARITIES.findIndex(r => r.id === a.item.rarity) ? b : a)
  if (RARITIES.findIndex(r => r.id === best.item.rarity) >= 4) toast(`${best.item.rarityName}! ${best.item.name} ✨`, 'gold')
}

function confirmModal(title, body, onYes) {
  const layer = $('#modal-layer')
  const m = el(`<div class="modal-bg"><div class="modal"><h3>${title}</h3><p>${body}</p>
    <div class="modal-btns"><button class="ghost" data-x="no">취소</button><button class="primary" data-x="yes">확인</button></div></div></div>`)
  layer.appendChild(m)
  m.addEventListener('click', e => {
    if (e.target.dataset.x === 'yes') { onYes(); m.remove() }
    else if (e.target.dataset.x === 'no' || e.target === m) m.remove()
  })
}

export function showOffline(info) {
  const layer = $('#modal-layer')
  const m = el(`<div class="modal-bg"><div class="modal"><h3>🍽️ 다녀온 사이</h3>
    <p>${fmtTime(info.dt)} 동안 비웠어${info.capped ? ` (보상은 ${fmtTime(info.t)}까지)` : ''}.</p>
    <p class="off-gain">자동 생산 <b>+${fmt(info.gain)} g</b> <span class="muted">(효율 ${Math.round(info.eff * 100)}%)</span></p>
    <div class="modal-btns"><button class="primary" data-x="ok">받기</button></div></div></div>`)
  layer.appendChild(m)
  m.addEventListener('click', e => { if (e.target.dataset.x === 'ok' || e.target === m) m.remove() })
}
