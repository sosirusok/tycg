import { supabase } from './supabase.js'
import './style.css'

const app = document.querySelector('#app')

function render(session) {
  if (session) {
    const user = session.user
    app.innerHTML = `
      <div class="card">
        <h1>접속 성공 ✅</h1>
        <p>로그인된 계정: <b>${user.email ?? user.id}</b></p>
        <p class="muted">이 세션은 새로고침해도 유지되고, 다른 기기에서 같은 계정으로
        로그인하면 동일하게 이어집니다. (아직 게임 내용은 없습니다 — 인프라 테스트 화면)</p>
        <button id="logout">로그아웃</button>
      </div>`
    document.querySelector('#logout').onclick = async () => {
      await supabase.auth.signOut()
    }
  } else {
    app.innerHTML = `
      <div class="card">
        <h1>TYCG</h1>
        <p class="muted">회원가입 또는 로그인 (인프라 테스트)</p>
        <input id="email" type="email" placeholder="이메일" autocomplete="username" />
        <input id="password" type="password" placeholder="비밀번호 (6자 이상)" autocomplete="current-password" />
        <div class="row">
          <button id="signup">회원가입</button>
          <button id="login" class="primary">로그인</button>
        </div>
        <p id="msg" class="msg"></p>
      </div>`

    const emailEl = document.querySelector('#email')
    const passEl = document.querySelector('#password')
    const msg = document.querySelector('#msg')
    const show = (t, ok = false) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'ok' : 'err') }

    document.querySelector('#signup').onclick = async () => {
      const { error } = await supabase.auth.signUp({ email: emailEl.value, password: passEl.value })
      if (error) show(error.message)
      else show('가입 완료! 이메일 확인이 필요할 수 있어요. 바로 로그인도 시도해 보세요.', true)
    }
    document.querySelector('#login').onclick = async () => {
      const { error } = await supabase.auth.signInWithPassword({ email: emailEl.value, password: passEl.value })
      if (error) show(error.message)
    }
  }
}

// Initial state + react to auth changes
async function init() {
  const { data } = await supabase.auth.getSession()
  render(data.session)
  supabase.auth.onAuthStateChange((_event, session) => render(session))
}
init()
