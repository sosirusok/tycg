import { defineConfig } from 'vite'

// 프로덕션(빌드)에서는 GitHub Pages 하위경로 /tycg/ 사용,
// 로컬 dev 에서는 루트 / 로 서빙(미리보기 편의).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/tycg/' : '/',
}))
