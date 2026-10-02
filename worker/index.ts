import { env } from 'cloudflare:workers';
import { handleApi } from './api';
import { cleanup } from './cleanup';
import { db } from './http';
import { meterOn, metered } from './meter';
import { allowKvTestFailure } from './storage';
import { bumpJob, dropJob, remindJob, TICK_A, TICK_B, type TickShare } from './automation';
import { alertJob } from './alerts';
import { sharePage } from './share';
import { pushJob } from './push';

// Three cron triggers (wrangler.jsonc): tick A (자동 끌올), tick B ('끌올 가능' 알림, 새 글 알림, 웹 푸시) and the daily cleanup
// (any other expression, as the tests send). With TEST_HOOKS=on (local tests only) the ticks take the
// event's scheduledTime as now, so a test can run a tick at 03:00 KST or next Monday 10:00.
function job(cron: string, scheduledTime: number) {
    const now = (env as Partial<Env>).TEST_HOOKS === 'on' && Number.isFinite(scheduledTime) ? scheduledTime : Date.now();
    // Tick A also runs 자동 가격 내리기 (WP56) after 자동 끌올, so its bumps see this tick's auto bumps in the
    // tab caps; a failed drop run never undoes the bumps, and a failed bump run never stops the drops.
    if (cron === TICK_A) return async () => {
        const bump = await bumpJob(now).catch(e => ({ bumpError: e instanceof Error ? e.message : 'unknown' }));
        // The drop bumps share 자동 끌올's caps of this tick (per tab, per tick, one per member).
        const { share, ...log } = bump as typeof bump & { share?: TickShare };
        const drop = await dropJob(now, share).catch(e => ({ dropError: e instanceof Error ? e.message : 'unknown' }));
        return { ...log, drop };
    };
    // Tick B also sends the 새 글 알림 (WP54); a failed reminder run never stops them. The queued 웹 푸시
    // go last (WP64), sized by what the run used so far, and also after a failed 새 글 알림 run.
    if (cron === TICK_B) return async () => {
        const remind = await remindJob(now).catch(e => ({ remindError: e instanceof Error ? e.message : 'unknown' }));
        const push = () => pushJob(now).catch(e => ({ pushError: e instanceof Error ? e.message : 'unknown' }));
        let alerts: Awaited<ReturnType<typeof alertJob>>;
        try { alerts = await alertJob(now); }
        catch (e) { await push(); throw e; }
        return { ...remind, ...alerts, push: await push() };
    };
    return () => cleanup();
}

// Every run counts its D1 calls, statements and fetches (worker/meter.ts): tick B's pushJob sizes its sends
// by them. With the test meter on (READ_BUDGET=on, local only), each run's counts are kept in settings
// 'sys:last_cron_meter' (never sent by any public route: 'sys:' keys stay on the server).
async function scheduledRun(run: () => Promise<unknown>) {
    allowKvTestFailure(null);
    const { result, meter } = await metered(run);
    if (!meterOn()) return result;
    const now = Date.now();
    await db().prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
        .bind('sys:last_cron_meter', JSON.stringify({ ...meter, at: now }), now).run();
    return result;
}

// Static files are served by Workers Static Assets before this Worker runs
// (see "run_worker_first" in wrangler.jsonc). Only /api/* and the share address /p/* (WP59: the
// post's og: tags in index.html) reach this handler. The context lets a request push to the members it
// reached after its response (WP64, worker/push.ts).
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/')) return handleApi(request, ctx);
        // Local test servers run without static assets (scripts/test-local.mjs), so without the binding too.
        if (!env.ASSETS) return new Response('Not found', { status: 404 });
        if (url.pathname.startsWith('/p/') && (request.method === 'GET' || request.method === 'HEAD')) return sharePage(request, env.ASSETS);
        return env.ASSETS.fetch(request);
    },
    async scheduled(controller, _env, ctx) {
        const name = controller.cron === TICK_A ? 'Auto bump and price drop' : controller.cron === TICK_B ? 'Reminders and alerts' : 'Cleanup';
        ctx.waitUntil(scheduledRun(job(controller.cron, controller.scheduledTime)).then(r => console.log(name + ' finished', r), e => console.error(name + ' failed', e instanceof Error ? e.message : e)));
    },
} satisfies ExportedHandler<Env>;
