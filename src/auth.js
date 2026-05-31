// ============================================================================
//  인증 — 아이디 / 비밀번호 (Supabase Auth, 아이디는 내부적으로 이메일로 매핑)
// ============================================================================
import { supabase } from './supabase.js'

const EMAIL_DOMAIN = 'sinwoo.game'

export function idToEmail(username) {
  return `${username.trim().toLowerCase()}@${EMAIL_DOMAIN}`
}
export function emailToId(email) {
  if (!email) return ''
  return email.replace('@' + EMAIL_DOMAIN, '')
}

export function validateId(id) {
  const v = (id || '').trim()
  if (!/^[A-Za-z0-9_가-힣]{2,20}$/.test(v)) return '아이디는 2~20자(한글/영문/숫자/_)로 입력해줘'
  return null
}
export function validatePw(pw) {
  if (!pw || pw.length < 6) return '비밀번호는 6자 이상이어야 해'
  return null
}

export async function signUp(id, pw) {
  const { data, error } = await supabase.auth.signUp({ email: idToEmail(id), password: pw })
  if (error) throw error
  return data
}
export async function signIn(id, pw) {
  const { data, error } = await supabase.auth.signInWithPassword({ email: idToEmail(id), password: pw })
  if (error) throw error
  return data
}
export async function signOut() {
  await supabase.auth.signOut()
}
export async function getSession() {
  const { data } = await supabase.auth.getSession()
  return data.session
}

// 흔한 에러 메시지 한국어화
export function authErrorKo(err) {
  const m = (err && (err.message || err.error_description)) || String(err)
  if (/Invalid login credentials/i.test(m)) return '아이디 또는 비밀번호가 틀렸어'
  if (/already registered|already been registered|User already/i.test(m)) return '이미 존재하는 아이디야'
  if (/Email not confirmed/i.test(m)) return '이메일 인증이 필요한 설정이야 (Supabase에서 Confirm email 끄기)'
  if (/Password should be/i.test(m)) return '비밀번호는 6자 이상이어야 해'
  if (/rate limit|too many/i.test(m)) return '잠깐 너무 많이 시도했어. 잠시 후 다시.'
  return m
}
