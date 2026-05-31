// ============================================================================
//  신우 키우기 — 진입점 (공유 저장: 누가 접속하든 같은 진행상황으로 이어짐)
// ============================================================================
import './style.css'
import { buildGachaPool } from './data.js'
import { defaultState, defaultRuntime, computeStats, tick, applyOffline } from './engine.js'
import { loadLocal, saveLocal, sharedLoad, sharedSave, pickNewer, CLOUD } from './state.js'
import { initUI, render, applyStage, toast, showOffline } from './ui.js'

const app = document.querySelector('#app')
let G = null, loopTimer = null, lastTick = 0, lastLocalSave = 0

boot()

async function boot() {
  app.innerHTML = `<div class="loading"><div class="spin"></div><p>불러오는 중…</p></div>`
  const local = loadLocal('shared')
  let cloud = null
  try { const c = await sharedLoad(); if (c) cloud = c.state } catch {}
  const state = pickNewer(local, cloud) || defaultState()
  startGame(state)
}

function noteText() {
  return CLOUD.available
    ? '☁️ 공유 진행상황 — 어디서 접속해도 이어집니다 (자동 저장)'
    : '이 기기에 저장 중 — 공유 저장 테이블 준비 후 모든 기기 동기화'
}

function startGame(state) {
  G = {
    state, rt: defaultRuntime(), stats: null, income: 0, user: null, userId: 'shared',
    pool: buildGachaPool(), cloudNote: noteText(),
    recompute() { this.stats = computeStats(this.state) },
    onLogout: null,
  }
  G.recompute()
  applyStage(state.stage)
  const off = applyOffline(state, G.stats, Date.now())
  initUI(G)
  render()
  if (off) showOffline(off)
  if (!CLOUD.available) toast('공유 저장 테이블이 아직 없어요 — 지금은 이 기기에만 저장돼요', 'warn')

  lastTick = Date.now(); lastLocalSave = Date.now()
  if (loopTimer) clearInterval(loopTimer)
  loopTimer = setInterval(loop, 100)
  window.addEventListener('visibilitychange', () => { if (document.hidden) saveNow() })
  window.addEventListener('beforeunload', saveNow)
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
  saveLocal('shared', G.state)
  sharedSave(G.state, force).then(() => { const n = noteText(); if (n !== G.cloudNote) G.cloudNote = n })
}
