// Builds nothing: run `pnpm build` first. Applies local D1 migrations, starts the
// built Worker on 127.0.0.1:8790 and runs every API verification suite against it.
import { access, readFile, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startPreviewServer } from '../tests/fixtures/preview-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
// The copy lint needs no build or server, so it runs first and stops the run on a forbidden phrase.
if (spawnSync(process.execPath, ['tests/copy-lint.mjs'], { cwd: root, stdio: 'inherit' }).status !== 0) process.exit(1);
// The static migration check (additive only from 0016 on) needs no server either.
if (spawnSync(process.execPath, ['tests/verify-migrations.mjs'], { cwd: root, stdio: 'inherit' }).status !== 0) process.exit(1);
const config = 'dist/zombiego_market/wrangler.json';
await access(config).catch(() => { throw new Error('빌드 결과가 없습니다. 먼저 pnpm build를 실행해 주세요.'); });

const wrangler = './node_modules/wrangler/bin/wrangler.js';
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
const children = new Set();
function child(args, options = {}) {
    const p = spawn(process.execPath, args, { cwd: root, env, detached: process.platform !== 'win32', ...options });
    children.add(p);
    p.once('exit', () => children.delete(p));
    return p;
}
function stop(p, signal = 'SIGTERM') {
    if (p.exitCode !== null) return;
    try { process.platform === 'win32' ? p.kill(signal) : process.kill(-p.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function completed(p, ms) {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(p); }, ms);
    try {
        const [code, signal] = await once(p, 'exit');
        if (timedOut) throw new Error('검증 제한 시간을 초과했습니다.');
        if (code !== 0) throw new Error(`검증이 실패했습니다 (${signal ?? code}).`);
    } finally { clearTimeout(timer); }
}
// The 링크 미리보기 fixture (WP48), in this process on a free 127.0.0.1 port; the 8790 Worker sends its
// preview fetches there (PREVIEW_TEST_ORIGIN).
let preview = null;
async function cleanup() {
    await preview?.close().catch(() => {});
    preview = null;
    const active = [...children];
    active.forEach(p => stop(p));
    await Promise.race([Promise.all(active.map(p => p.exitCode === null ? once(p, 'exit') : null)), delay(3000)]);
    active.forEach(p => stop(p, 'SIGKILL'));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });

async function waitFor(origin, server) {
    let log = '';
    server.stdout.on('data', d => { log += d; });
    server.stderr.on('data', d => { log += d; });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error('로컬 서버가 시작 전에 종료되었습니다.\n' + log.slice(-3000));
        try {
            const r = await fetch(origin + '/api/auth/me', { signal: AbortSignal.timeout(2000) });
            await r.arrayBuffer();
            if (r.ok) return;
        } catch { /* wait for the Worker */ }
        await delay(250);
    }
    throw new Error('로컬 서버 시작 시간을 초과했습니다.\n' + log.slice(-3000));
}

// TEST_PORT_BASE (default 8790) lets two checkouts run their gates at once: the main server uses the
// base port and the strict/cron server the next one.
const PORT = Number(process.env.TEST_PORT_BASE || 8790);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65000) throw new Error('TEST_PORT_BASE must be a port number.');
const strictBase = `http://127.0.0.1:${PORT + 1}`;
const base = `http://127.0.0.1:${PORT}`;
// TEST_SUITES=perks,roles runs only the suites whose file name contains one of the words.
const only = (process.env.TEST_SUITES || '').split(',').map(v => v.trim()).filter(Boolean);
const pick = list => only.length ? list.filter(f => only.some(w => f.includes(w))) : list;
// 웹 푸시 (WP64): a fresh P-256 key pair for this run, as deploy.yml makes once for the site. Both servers get
// the keys; only 8791 gets PUSH_TEST=on, which lets verify-push subscribe its mock push service on 127.0.0.1.
const vapidKeys = (() => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { kty, crv, x, y, d } = privateKey.export({ format: 'jwk' }), pub = publicKey.export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]).toString('base64url');
    return ['--var', 'VAPID_PRIVATE_KEY:' + JSON.stringify({ kty, crv, x, y, d }), '--var', 'VAPID_PUBLIC_KEY:' + point, '--var', 'VAPID_SUBJECT:https://zombiego-market.test'];
})();
try {
    await completed(child([wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--config', 'wrangler.jsonc'], { stdio: 'inherit' }), 90000);
    // Rate limits and settings from earlier local runs must not leak into this run.
    // The 플러스 무료 체험 window (0016_plus_trial) starts now and is closed right away, so the suites
    // keep 일반 sign-ups; verify-trial opens it for itself.
    const trialSettings = `INSERT INTO settings(key,value,updated_at) VALUES('sys:trial_start','${Date.now()}',0),('sys:trial_end','-1',0);`;
    // The 엘리트 주간 요약 (WP63) counts this week as done, as 0048 does when it is applied, so no tick B of
    // the run writes 'weekly' 알림 unless a suite asks for it (verify-stats moves the setting back).
    const weeklySettings = `INSERT INTO settings(key,value,updated_at) VALUES('sys:weekly_last','${Date.now()}',0);`;
    // Posts an earlier run placed ahead of now (새 글 우선, WP44: 1 hour) go back to their creation time,
    // so they never push this run's posts off a board's first page.
    const ahead = `UPDATE posts SET bumped_at=created_at WHERE bumped_at>${Date.now()};`;
    await completed(child([wrangler, 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc', '--command', 'DELETE FROM rate_limits; DELETE FROM settings; ' + trialSettings + weeklySettings + " UPDATE settings SET value='-1' WHERE key='sys:trial_end'; " + ahead], { stdio: 'ignore' }), 60000);
    // POST_LIMITS=relaxed lifts the post caps (open posts, posts per day, same title) on this server only,
    // so these suites can post freely. The strict 8791 server below checks the caps (verify-perks).
    preview = await startPreviewServer();
    const server = child([wrangler, 'dev', '--config', config, '--local', '--persist-to', '.wrangler/state', '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-port', '0',
        '--var', 'MANAGER_PASSWORD:' + (process.env.TEST_MANAGER_PASSWORD || 'local-manager-password'), '--var', 'POST_LIMITS:relaxed', '--var', 'PREVIEW_TEST_ORIGIN:' + preview.origin, ...vapidKeys], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(base, server);
    // verify-ladder (WP68) is a unit suite that reads the latest season from this server's config.
    // verify-push runs here too (TEST_PHASE=main): without PUSH_TEST an http endpoint is refused.
    for (const suite of pick(['tests/verify-market.mjs', 'tests/verify-ladder.mjs', 'tests/verify-membership.mjs', 'tests/verify-fixes.mjs', 'tests/verify-copy.mjs', 'tests/verify-trade2.mjs', 'tests/verify-accounts.mjs', 'tests/verify-roles.mjs', 'tests/verify-admin-parity.mjs', 'tests/verify-chat.mjs', 'tests/verify-cafe.mjs', 'tests/verify-conveniences.mjs', 'tests/verify-sanctions.mjs', 'tests/verify-reviews.mjs', 'tests/verify-parity.mjs', 'tests/verify-content.mjs', 'tests/verify-comments.mjs', 'tests/verify-chat-auto.mjs', 'tests/verify-push.mjs'])) {
        await completed(child([suite], { stdio: 'inherit', env: { ...env, TEST_BASE_URL: base, PREVIEW_TEST_ORIGIN: preview.origin, TEST_MANAGER_PASSWORD: process.env.TEST_MANAGER_PASSWORD || 'local-manager-password', ...suite.includes('verify-push') ? { TEST_PHASE: 'main' } : {} } }), 180000);
    }
    const exited = server.exitCode === null ? once(server, 'exit') : null;
    stop(server);
    await exited;

    // Same Worker without the R2 binding: photos must fall back to D1. Local dev
    // delivers test cron events only to a Worker without static assets, so this
    // server also leaves out the assets and checks the daily cleanup.
    const built = JSON.parse(await readFile(config, 'utf8'));
    delete built.r2_buckets;
    delete built.assets;
    const noR2 = path.join(path.dirname(config), 'wrangler.no-r2.json');
    await writeFile(noR2, JSON.stringify(built));
    // READ_BUDGET=on turns on the read and call meter (worker/meter.ts) on this server only: responses
    // carry X-Rows-Read and friends, and the cron stores its counts in settings 'sys:last_cron_meter'.
    const fallback = child([wrangler, 'dev', '--config', noR2, '--local', '--persist-to', '.wrangler/state', '--ip', '127.0.0.1', '--port', String(PORT + 1), '--inspector-port', '0', '--test-scheduled',
        '--var', 'MANAGER_PASSWORD:' + (process.env.TEST_MANAGER_PASSWORD || 'local-manager-password'), '--var', 'READ_BUDGET:on', '--var', 'TEST_HOOKS:on', ...vapidKeys, '--var', 'PUSH_TEST:on'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(strictBase, fallback);
    // verify-deals (WP43) runs on this strict server, so completing posts and trade records meet the
    // real post caps, and so does verify-dup (WP44: 같은 매물, the allowance, prints), and verify-alerts (WP50: 알림함, its cron rows and read costs).
    // verify-alerts-posts (WP54) runs tick B's 새 글 알림 the same way (and sets the cursor with wrangler d1 execute).
    // verify-auto (WP52) runs the 자동 끌올 ticks at chosen times (TEST_HOOKS=on: the event's ?time= is the tick's now),
    // and verify-auto-drop (WP56) the 자동 가격 내리기 in the same tick, on the days after.
    // verify-promo (WP53) checks the 광고 placements against the strict rules.
    // verify-auto-bulk (WP58) runs 일괄 변경 against the real wallet, 다시 올리기 against the WP44 placement and
    // 자동 매칭 in tick B (cursor and pause times set with wrangler d1 execute).
    // verify-stats (WP63) checks 판매 통계, 대표 글 and 인기순 against the real post rules, and the 주간 요약 in tick B.
    // verify-providers (WP66) needs the read meter and X-Test-Now (TEST_HOOKS=on) and removes its 200 seeded providers.
    // verify-push (WP64) runs a mock push service: inline pushes, the queue of tick B, failures and the keys.
    // verify-chat-live (WP69) reads the meter: a send in ≤ 2 D1 calls, and the long poll's calls and timing.
    // verify-search (WP70) seeds 20,000 posts too and checks the posts_fts search with the meter.
    // verify-step5-fixes (R3 step 5 review) reads the meter: a post with 70+ season tags within 45 statements.
    // verify-budget stays last: it seeds 20,000 posts and removes them at the end.
    for (const suite of pick(['tests/verify-storage.mjs', 'tests/verify-perks.mjs', 'tests/verify-cleanup.mjs', 'tests/verify-trial.mjs', 'tests/verify-deals.mjs', 'tests/verify-dup.mjs', 'tests/verify-alerts.mjs', 'tests/verify-alerts-posts.mjs', 'tests/verify-auto.mjs', 'tests/verify-auto-drop.mjs', 'tests/verify-auto-bulk.mjs', 'tests/verify-promo.mjs', 'tests/verify-stats.mjs', 'tests/verify-providers.mjs', 'tests/verify-push.mjs', 'tests/verify-chat-live.mjs', 'tests/verify-search.mjs', 'tests/verify-step5-fixes.mjs', 'tests/verify-budget.mjs'])) {
        // verify-auto, verify-alerts-posts, verify-perks (45 calls), verify-stats and verify-dup (about 60 calls) set
        // up their scenarios with wrangler d1 execute (about 1.7 s a call, 4-5 s on a busy machine), so they get
        // longer; verify-perks also uploads 121 photos and fires the cron twice, and verify-search seeds 20,000 posts.
        const long = ['verify-auto', 'verify-alerts-posts', 'verify-perks', 'verify-stats', 'verify-dup', 'verify-search'].some(name => suite.includes(name));
        await completed(child([suite], { stdio: 'inherit', env: { ...env, TEST_BASE_URL: strictBase, TEST_MANAGER_PASSWORD: process.env.TEST_MANAGER_PASSWORD || 'local-manager-password' } }), long ? 480000 : 180000);
    }
    const fallbackExited = fallback.exitCode === null ? once(fallback, 'exit') : null;
    stop(fallback);
    await fallbackExited;

    // KV photos (WP45): the no-R2 config plus a local PHOTOS namespace, on a short-lived server on 8791
    // (reused once the server above has exited, so pnpm test only ever uses 8790 and 8791)
    // without assets (so the cron can be triggered). verify-kv runs twice: as is, then with
    // KV_TEST_FAIL=on (every KV put and delete throws). Then the R2 mover: the same server with both R2
    // and KV bound, for the mover part of verify-parity.
    const kvNamespaces = [{ binding: 'PHOTOS', id: 'zombiego-market-photos-local' }];
    const kvConfig = path.join(path.dirname(config), 'wrangler.kv.json');
    await writeFile(kvConfig, JSON.stringify({ ...built, kv_namespaces: kvNamespaces }));
    const withR2 = JSON.parse(await readFile(config, 'utf8'));
    delete withR2.assets;
    const moverConfig = path.join(path.dirname(config), 'wrangler.mover.json');
    await writeFile(moverConfig, JSON.stringify({ ...withR2, kv_namespaces: kvNamespaces }));
    const phases = [
        { suite: 'tests/verify-kv.mjs', config: kvConfig, vars: [], phase: 'main' },
        { suite: 'tests/verify-kv.mjs', config: kvConfig, vars: ['--var', 'KV_TEST_FAIL:on'], phase: 'fail' },
        { suite: 'tests/verify-parity.mjs', config: moverConfig, vars: [], phase: 'mover' },
    ].filter(p => pick([p.suite]).length);
    for (const p of phases) {
        const kvServer = child([wrangler, 'dev', '--config', p.config, '--local', '--persist-to', '.wrangler/state', '--ip', '127.0.0.1', '--port', String(PORT + 1), '--inspector-port', '0', '--test-scheduled',
            '--var', 'MANAGER_PASSWORD:' + (process.env.TEST_MANAGER_PASSWORD || 'local-manager-password'), '--var', 'TEST_HOOKS:on', ...p.vars], { stdio: ['ignore', 'pipe', 'pipe'] });
        await waitFor(strictBase, kvServer);
        await completed(child([p.suite], { stdio: 'inherit', env: { ...env, TEST_BASE_URL: strictBase, TEST_PHASE: p.phase, TEST_MANAGER_PASSWORD: process.env.TEST_MANAGER_PASSWORD || 'local-manager-password' } }), 180000);
        const kvExited = kvServer.exitCode === null ? once(kvServer, 'exit') : null;
        stop(kvServer);
        await kvExited;
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await cleanup();
}
