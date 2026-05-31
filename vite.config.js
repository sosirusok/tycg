import { defineConfig } from 'vite'

// GitHub Pages serves this project under /tycg/, so assets must use that base.
// (If we later move to a custom domain or root host, change base back to '/'.)
export default defineConfig({
  base: '/tycg/',
})
