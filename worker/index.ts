import { handleApi } from './api';
import { cleanup } from './cleanup';
import { db } from './http';
import { meterOn, metered } from './meter';
import { allowKvTestFailure } from './storage';

// The daily cleanup. With the test meter on (READ_BUDGET=on, local only), its counts are kept in
// settings 'sys:last_cron_meter' (never sent by any public route: 'sys:' keys stay on the server).
async function scheduledRun() {
    allowKvTestFailure(null);
    if (!meterOn()) return cleanup();
    const { result, meter } = await metered(() => cleanup());
    const now = Date.now();
    await db().prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
        .bind('sys:last_cron_meter', JSON.stringify({ ...meter, at: now }), now).run();
    return result;
}

// Static files are served by Workers Static Assets before this Worker runs
// (see "run_worker_first" in wrangler.jsonc). Only /api/* reaches this handler.
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/')) return handleApi(request);
        return env.ASSETS.fetch(request);
    },
    async scheduled(_controller, _env, ctx) {
        ctx.waitUntil(scheduledRun().then(r => console.log('Cleanup finished', r), e => console.error('Cleanup failed', e instanceof Error ? e.message : e)));
    },
} satisfies ExportedHandler<Env>;
