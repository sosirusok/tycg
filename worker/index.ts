import { handleApi } from './api';
import { cleanup } from './cleanup';

// Static files are served by Workers Static Assets before this Worker runs
// (see "run_worker_first" in wrangler.jsonc). Only /api/* reaches this handler.
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/')) return handleApi(request);
        return env.ASSETS.fetch(request);
    },
    async scheduled(_controller, _env, ctx) {
        ctx.waitUntil(cleanup().then(r => console.log('Cleanup finished', r), e => console.error('Cleanup failed', e instanceof Error ? e.message : e)));
    },
} satisfies ExportedHandler<Env>;
