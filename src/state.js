// ============================================================================
//  저장 / 불러오기 — 로컬(localStorage) + 클라우드(Supabase)
//  로컬은 항상 동작. 클라우드는 로그인 + saves 테이블 있을 때 동기화.
// ============================================================================
import { supabase } from './supabase.js'
import { defaultState } from './engine.js'

export const CLOUD = { available: true, lastError: null }

export function migrate(raw) {
  const base = defaultState()
  if (!raw || typeof raw !== 'object') return base
  const s = { ...base, ...raw }
  s.generators = Array.isArray(raw.generators) && raw.generators.length === base.generators.length
    ? raw.generators.map(n => Number(n) || 0) : base.generators
  s.skills = (raw.skills && typeof raw.skills === 'object') ? raw.skills : {}
  s.gacha = (raw.gacha && typeof raw.gacha === 'object') ? raw.gacha : {}
  s.stats = { ...base.stats, ...(raw.stats || {}) }
  return s
}

const keyFor = userId => `sinwoo_save_${userId || 'guest'}`

export function loadLocal(userId) {
  try {
    const raw = localStorage.getItem(keyFor(userId))
    if (!raw) return null
    return migrate(JSON.parse(raw))
  } catch { return null }
}

export function saveLocal(userId, state) {
  try { localStorage.setItem(keyFor(userId), JSON.stringify(state)) } catch {}
}

export async function cloudLoad(userId) {
  if (!userId) return null
  try {
    const { data, error } = await supabase
      .from('saves').select('data, updated_at').eq('user_id', userId).maybeSingle()
    if (error) { handleCloudError(error); return null }
    CLOUD.available = true
    return data ? { state: migrate(data.data), updatedAt: data.updated_at } : null
  } catch (e) { handleCloudError(e); return null }
}

let lastCloudWrite = 0
export async function cloudSave(userId, state, force = false) {
  if (!userId || !CLOUD.available) return false
  const now = Date.now()
  if (!force && now - lastCloudWrite < 15000) return false // 최대 15초마다
  lastCloudWrite = now
  try {
    const { error } = await supabase.from('saves')
      .upsert({ user_id: userId, data: state, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    if (error) { handleCloudError(error); return false }
    CLOUD.available = true
    return true
  } catch (e) { handleCloudError(e); return false }
}

function handleCloudError(e) {
  const msg = (e && (e.message || e.error_description || e.code)) || String(e)
  CLOUD.lastError = msg
  // 테이블 없음 / 권한 등 → 클라우드 비활성, 로컬로만 동작
  if (/relation .*saves.* does not exist/i.test(msg) || /could not find the table/i.test(msg) ||
      /schema cache/i.test(msg) || /404/.test(msg) || /42P01/.test(msg)) {
    CLOUD.available = false
  }
  console.warn('[cloud]', msg)
}

// 로컬/클라우드 중 더 최신(lastSeen 기준) 선택
export function pickNewer(localState, cloudState) {
  if (!cloudState) return localState
  if (!localState) return cloudState
  return (cloudState.lastSeen || 0) >= (localState.lastSeen || 0) ? cloudState : localState
}
