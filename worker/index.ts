import { handleApi } from './api';

// Static files are served by Workers Static Assets before this Worker runs
// (see "run_worker_first" in wrangler.jsonc). Only /api/* reaches this handler.
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/')) return handleApi(request);
        return env.ASSETS.fetch(request);
    },
} satisfies ExportedHandler<Env>;
