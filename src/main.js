// ============================================================================
//  신우 키우기 — 진입점 (계정 1/2/3 선택 · 슬롯별 클라우드 공유)
// ============================================================================
import './style.css'
import { buildGachaPool, THEMES } from './data.js'
import { defaultState, defaultRuntime, computeStats, tick, applyOffline } from './engine.js'
import { loadLocal, saveLocal, sharedLoad, sharedSave, pickNewer, CLOUD } from './state.js'
import { initUI, render, applyStage, toast, showOffline } from './ui.js'
import { CHAR_ART, img } from './assets.js'

const app = document.querySelector('#app')
let G = null, loopTimer = null, lastTick = 0, lastLocalSave = 0, slot = 1

boot()

async function boot() {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null }
  window.removeEventListener('visibilitychange', vis)
  window.removeEventListener('beforeunload', onUnload)
  G = null
  app.className = ''
  app.innerHTML = `<div class="slot-bg"><div class="slot-card">
    <div class="auth-logo">${img(CHAR_ART.s5, 'auth-char')}</div>
    <h1>신우 키우기</h1>
    <p class="auth-sub">계정을 선택하세요 · 어느 기기에서도 같은 계정으로 이어집니다</p>
    <div class="slots" id="slots"><div class="slot-loading">계정 불러오는 중…</div></div>
  </div></div>`

  const states = {}
  for (let s = 1; s <= 3; s++) {
    const local = loadLocal('slot' + s)
    let cloud = null
    try { const c = await sharedLoad(s); if (c) cloud = c.state } catch {}
    states[s] = pickNewer(local, cloud)
  }
  const slotsEl = document.querySelector('#slots')
  slotsEl.innerHTML = [1, 2, 3].map(s => {
    const st = states[s]
    const info = st ? `Lv.${st.level} · ${THEMES[st.stage]?.name || ''}` : '비어있음 · 새로 시작'
    return `<button class="slot-btn" data-slot="${s}"><span class="slot-n">계정 ${s}</span><span class="slot-info">${info}</span></button>`
  }).join('')
  if (!CLOUD.available) slotsEl.insertAdjacentHTML('beforeend', `<div class="slot-note">공유 저장 테이블이 아직 없어 이 기기에만 저장돼요.</div>`)
  slotsEl.addEventListener('click', e => { const b = e.target.closest('.slot-btn'); if (!b) return; const s = +b.dataset.slot; startGame(states[s] || defaultState(), s) })
}

function noteText() {
  return CLOUD.available
    ? `☁️ 계정 ${slot} · 어느 기기에서도 이어집니다 (자동 저장)`
    : `계정 ${slot} · 이 기기에 저장 중 (공유 테이블 준비 전)`
}

function startGame(state, s) {
  slot = s
  G = {
    state, rt: defaultRuntime(), stats: null, income: 0, slot: s, userId: 'slot' + s,
    pool: buildGachaPool(), cloudNote: noteText(),
    recompute() { this.stats = computeStats(this.state) },
    onSwitch: switchAccount,
  }
  G.recompute()
  applyStage(state.stage)
  const off = applyOffline(state, G.stats, Date.now())
  initUI(G)
  render()
  if (off) showOffline(off)
  if (!CLOUD.available) toast('공유 저장 테이블이 아직 없어요 — 이 기기에만 저장돼요', 'warn')

  lastTick = Date.now(); lastLocalSave = Date.now()
  if (loopTimer) clearInterval(loopTimer)
  loopTimer = setInterval(loop, 100)
  window.addEventListener('visibilitychange', vis)
  window.addEventListener('beforeunload', onUnload)
}

function vis() { if (document.hidden) saveNow() }
function onUnload() { saveNow() }

function switchAccount() {
  saveNow(true)
  boot()
}

function loop() {
  const now = Date.now()
  let dt = (now - lastTick) / 1000; lastTick = now
  if (dt > 2) dt = 2; if (dt < 0) dt = 0
  G.stats = computeStats(G.state)
  const ev = tick(G.state, G.stats, G.rt, dt, now)
  G.income = ev.income
  if (ev.leveledUp > 0) toast(`레벨 업! Lv.${G.state.level}`, 'gold')
  render()
  if (now - lastLocalSave > 2000) saveNow(false)
}

function saveNow(force = true) {
  if (!G) return
  G.state.lastSeen = Date.now()
  lastLocalSave = G.state.lastSeen
  saveLocal('slot' + slot, G.state)
  sharedSave(slot, G.state, force).then(() => { const n = noteText(); if (n !== G.cloudNote) G.cloudNote = n })
}
