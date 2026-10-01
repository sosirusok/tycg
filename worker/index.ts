import { env } from 'cloudflare:workers';
import { handleApi } from './api';
import { cleanup } from './cleanup';
import { db } from './http';
import { meterOn, metered } from './meter';
import { allowKvTestFailure } from './storage';
import { bumpJob, remindJob, TICK_A, TICK_B } from './automation';
import { alertJob } from './alerts';

// Three cron triggers (wrangler.jsonc): tick A (자동 끌올), tick B ('끌올 가능' 알림 and 새 글 알림) and the daily cleanup
// (any other expression, as the tests send). With TEST_HOOKS=on (local tests only) the ticks take the
// event's scheduledTime as now, so a test can run a tick at 03:00 KST or next Monday 10:00.
function job(cron: string, scheduledTime: number) {
    const now = (env as Partial<Env>).TEST_HOOKS === 'on' && Number.isFinite(scheduledTime) ? scheduledTime : Date.now();
    if (cron === TICK_A) return () => bumpJob(now);
    // Tick B also sends the 새 글 알림 (WP54); a failed reminder run never stops them.
    if (cron === TICK_B) return async () => {
        const remind = await remindJob(now).catch(e => ({ remindError: e instanceof Error ? e.message : 'unknown' }));
        return { ...remind, ...await alertJob(now) };
    };
    return () => cleanup();
}

// With the test meter on (READ_BUDGET=on, local only), each run's counts are kept in settings
// 'sys:last_cron_meter' (never sent by any public route: 'sys:' keys stay on the server).
async function scheduledRun(run: () => Promise<unknown>) {
    allowKvTestFailure(null);
    if (!meterOn()) return run();
    const { result, meter } = await metered(run);
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
    async scheduled(controller, _env, ctx) {
        const name = controller.cron === TICK_A ? 'Auto bump' : controller.cron === TICK_B ? 'Reminders and alerts' : 'Cleanup';
        ctx.waitUntil(scheduledRun(job(controller.cron, controller.scheduledTime)).then(r => console.log(name + ' finished', r), e => console.error(name + ' failed', e instanceof Error ? e.message : e)));
    },
} satisfies ExportedHandler<Env>;
