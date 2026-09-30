import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

process.env.WRANGLER_SEND_METRICS ??= 'false';

// One build produces the static client (dist/client) and the API Worker.
// `vite dev` runs the Worker in workerd with local D1 and R2 emulation.
export default defineConfig({
  plugins: [react(), cloudflare({ inspectorPort: false })],
});
