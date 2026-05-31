// ============================================================================
//  에셋 로더 — src/assets/ 의 SVG들을 자동 수집(빌드시 URL로 변환, base 경로 자동)
//  파일이 아직 없으면 해당 맵이 비고, UI는 폴백(둥근 색칸)으로 그린다.
// ============================================================================
const _biz  = import.meta.glob('./assets/biz/*.svg',  { eager: true, query: '?url', import: 'default' })
const _food = import.meta.glob('./assets/food/*.svg', { eager: true, query: '?url', import: 'default' })
const _char = import.meta.glob('./assets/char/*.svg', { eager: true, query: '?url', import: 'default' })
const _ui   = import.meta.glob('./assets/ui/*.svg',   { eager: true, query: '?url', import: 'default' })
const _bg   = import.meta.glob('./assets/bg/*.svg',   { eager: true, query: '?url', import: 'default' })

const stem = p => p.split('/').pop().replace('.svg', '')
const toMap = glob => { const m = {}; for (const p in glob) m[stem(p)] = glob[p]; return m }

export const BIZ_ART  = toMap(_biz)
export const FOOD_ART = toMap(_food)
export const CHAR_ART = toMap(_char)
export const UI_ART   = toMap(_ui)
export const BG_ART   = toMap(_bg)

// <img> 태그(없으면 폴백 span). cls 로 크기/모양 제어.
export function img(url, cls = '', extra = '') {
  if (!url) return `<span class="art fallback ${cls}" ${extra}></span>`
  return `<img class="art ${cls}" src="${url}" alt="" draggable="false" ${extra}>`
}
