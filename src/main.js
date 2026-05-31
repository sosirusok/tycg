// ============================================================================
//  신우 키우기 — 진입점 (인증 → 게임 부팅 → 루프 → 저장)
// ============================================================================
import './style.css'
import { buildGachaPool } from './data.js'
import { defaultState, defaultRuntime, computeStats, incomePerSec, tick, applyOffline } from './engine.js'
import { loadLocal, saveLocal, cloudLoad, cloudSave, pickNewer, CLOUD } from './state.js'
import { initUI, render, applyStage, toast, showOffline } from './ui.js'
import { CHAR_ART, img } from './assets.js'
import { signIn, signUp, signOut, getSession, emailToId, idToEmail, validateId, validatePw, authErrorKo } from './auth.js'

const app = document.querySelector('#app')
let G = null
let loopTimer = null
let lastTick = 0
let lastLocalSave = 0

boot()

async function boot() {
  app.innerHTML = `<div class="loading"><div class="spin"></div><p>불러오는 중…</p></div>`
  let session = null
  try { session = await getSession() } catch {}
  if (session) startGame(session.user)
  else renderAuth()
}

// ---------------------------------------------------------------------------
//  로그인 / 회원가입 화면
// ---------------------------------------------------------------------------
function renderAuth(prefillMsg) {
  app.className = ''
  app.innerHTML = `
  <div class="auth-bg">
    <div class="auth-card">
      <div class="auth-logo">${img(CHAR_ART.s5, 'auth-char')}</div>
      <h1>신우 키우기</h1>
      <p class="auth-sub">아이디로 가입하면 어느 기기에서나 이어서 플레이!</p>
      <input id="a-id" placeholder="아이디 (2~20자)" autocomplete="username" />
      <input id="a-pw" type="password" placeholder="비밀번호 (6자 이상)" autocomplete="current-password" />
      <div class="auth-btns">
        <button id="a-login" class="primary">로그인</button>
        <button id="a-signup" class="ghost">회원가입</button>
      </div>
      <p id="a-msg" class="auth-msg">${prefillMsg || ''}</p>
      <button id="a-guest" class="linkbtn">로그인 없이 둘러보기 (이 기기에만 저장)</button>
    </div>
  </div>`
  const idEl = document.querySelector('#a-id'), pwEl = document.querySelector('#a-pw'), msg = document.querySelector('#a-msg')
  const setMsg = (t, ok) => { msg.textContent = t; msg.className = 'auth-msg ' + (ok ? 'ok' : 'err') }
  const run = async (mode) => {
    const id = idEl.value.trim(), pw = pwEl.value
    const e1 = validateId(id); if (e1) return setMsg(e1)
    const e2 = validatePw(pw); if (e2) return setMsg(e2)
    setMsg(mode === 'login' ? '로그인 중…' : '가입 중…', true)
    try {
      if (mode === 'signup') await signUp(id, pw)
      else await signIn(id, pw)
      let s = await getSession()
      if (!s && mode === 'signup') { await signIn(id, pw); s = await getSession() }
      if (!s) return setMsg('세션을 만들지 못했어. 다시 시도해줘.')
      startGame(s.user)
    } catch (err) { setMsg(authErrorKo(err)) }
  }
  document.querySelector('#a-login').onclick = () => run('login')
  document.querySelector('#a-signup').onclick = () => run('signup')
  document.querySelector('#a-guest').onclick = () => startGame(null)
  pwEl.addEventListener('keydown', e => { if (e.key === 'Enter') run('login') })
}

// ---------------------------------------------------------------------------
//  게임 시작
// ---------------------------------------------------------------------------
async function startGame(authUser) {
  const user = authUser ? { id: emailToId(authUser.email), uuid: authUser.id } : null
  const userId = user ? user.uuid : null

  app.innerHTML = `<div class="loading"><div class="spin"></div><p>저장 데이터 동기화 중…</p></div>`
  const local = loadLocal(userId)
  let cloud = null
  if (user) { const c = await cloudLoad(userId); if (c) cloud = c.state }
  let state = pickNewer(local, cloud) || defaultState()

  G = {
    state, rt: defaultRuntime(), stats: null, income: 0, user, userId,
    pool: buildGachaPool(),
    cloudNote: cloudNoteText(user),
    recompute() { this.stats = computeStats(this.state) },
    onLogout: doLogout,
  }
  G.recompute()
  applyStage(state.stage)

  // 오프라인 보상
  const off = applyOffline(state, G.stats, Date.now())

  initUI(G)
  render()
  if (off) showOffline(off)
  if (user && !CLOUD.available) toast('클라우드 저장 테이블이 아직 없어 — 지금은 이 기기에만 저장돼', 'warn')

  // 루프
  lastTick = Date.now()
  lastLocalSave = Date.now()
  if (loopTimer) clearInterval(loopTimer)
  loopTimer = setInterval(loop, 100)

  window.addEventListener('visibilitychange', () => { if (document.hidden) saveNow() })
  window.addEventListener('beforeunload', saveNow)
}

function cloudNoteText(user) {
  if (!user) return '게스트 모드 — 진행상황은 이 브라우저에만 저장돼요. 로그인하면 클라우드 동기화!'
  return CLOUD.available ? `@${user.id} · 클라우드 자동 저장 중 ☁️` : `@${user.id} · 로컬 저장(클라우드 테이블 미설정)`
}

function loop() {
  const now = Date.now()
  let dt = (now - lastTick) / 1000
  lastTick = now
  if (dt > 2) dt = 2          // 절전/탭전환 중 과보상 방지(오프라인은 재접속 시 별도 처리)
  if (dt < 0) dt = 0

  G.stats = computeStats(G.state)
  const ev = tick(G.state, G.stats, G.rt, dt, now)
  G.income = ev.income
  if (ev.leveledUp > 0) toast(`레벨 업! Lv.${G.state.level} (+SP, +🧊)`, 'gold')

  render()

  if (now - lastLocalSave > 2000) { saveNow(false) }
}

function saveNow(force = true) {
  if (!G) return
  G.state.lastSeen = Date.now()
  lastLocalSave = G.state.lastSeen
  saveLocal(G.userId, G.state)
  if (G.user) {
    cloudSave(G.userId, G.state, force).then(ok => {
      const note = cloudNoteText(G.user)
      if (note !== G.cloudNote) G.cloudNote = note
    })
  }
}

async function doLogout() {
  saveNow(true)
  try { await signOut() } catch {}
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null }
  G = null
  renderAuth('로그아웃 됐어. 다시 로그인하면 이어서 플레이할 수 있어.')
}
