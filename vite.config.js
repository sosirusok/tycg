import { defineConfig } from 'vite'

// 프로덕션은 GitHub Pages 하위경로 /tycg/, 로컬 dev는 루트 /.
// 저사양(학교) 노트북 OOM 방지를 위해 gzip 크기 보고를 끔.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/tycg/' : '/',
  build: {
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2000,
  },
}))
