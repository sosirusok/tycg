// Builds nothing: run `pnpm build` first. Applies local D1 migrations, starts the
// built Worker on 127.0.0.1:8790 and runs every API verification suite against it.
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

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
async function cleanup() {
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

const base = 'http://127.0.0.1:8790';
// TEST_SUITES=perks,roles runs only the suites whose file name contains one of the words.
const only = (process.env.TEST_SUITES || '').split(',').map(v => v.trim()).filter(Boolean);
const pick = list => only.length ? list.filter(f => only.some(w => f.includes(w))) : list;
try {
    await completed(child([wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--config', 'wrangler.jsonc'], { stdio: 'inherit' }), 90000);
    // Rate limits and settings from earlier local runs must not leak into this run.
    // The 플러스 무료 체험 window (0016_plus_trial) starts now and is closed right away, so the suites
    // keep 일반 sign-ups; verify-trial opens it for itself.
    const trialSettings = `INSERT INTO settings(key,value,updated_at) VALUES('sys:trial_start','${Date.now()}',0),('sys:trial_end','-1',0);`;
    await completed(child([wrangler, 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc', '--command', 'DELETE FROM rate_limits; DELETE FROM settings; ' + trialSettings + " UPDATE settings SET value='-1' WHERE key='sys:trial_end';"], { stdio: 'ignore' }), 60000);
    // POST_LIMITS=relaxed lifts the post caps (open posts, posts per day, same title) on this server only,
    // so these suites can post freely. The strict 8791 server below checks the caps (verify-perks).
    const server = child([wrangler, 'dev', '--config', config, '--local', '--persist-to', '.wrangler/state', '--ip', '127.0.0.1', '--port', '8790', '--inspector-port', '0',
        '--var', 'MANAGER_PASSWORD:' + (process.env.TEST_MANAGER_PASSWORD || 'local-manager-password'), '--var', 'POST_LIMITS:relaxed'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(base, server);
    for (const suite of pick(['tests/verify-market.mjs', 'tests/verify-membership.mjs', 'tests/verify-fixes.mjs', 'tests/verify-copy.mjs', 'tests/verify-trade2.mjs', 'tests/verify-accounts.mjs', 'tests/verify-roles.mjs', 'tests/verify-chat.mjs', 'tests/verify-cafe.mjs', 'tests/verify-conveniences.mjs', 'tests/verify-sanctions.mjs', 'tests/verify-reviews.mjs'])) {
        await completed(child([suite], { stdio: 'inherit', env: { ...env, TEST_BASE_URL: base, TEST_MANAGER_PASSWORD: process.env.TEST_MANAGER_PASSWORD || 'local-manager-password' } }), 180000);
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
    const fallback = child([wrangler, 'dev', '--config', noR2, '--local', '--persist-to', '.wrangler/state', '--ip', '127.0.0.1', '--port', '8791', '--inspector-port', '0', '--test-scheduled',
        '--var', 'MANAGER_PASSWORD:' + (process.env.TEST_MANAGER_PASSWORD || 'local-manager-password')], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor('http://127.0.0.1:8791', fallback);
    for (const suite of pick(['tests/verify-storage.mjs', 'tests/verify-perks.mjs', 'tests/verify-cleanup.mjs', 'tests/verify-trial.mjs'])) {
        await completed(child([suite], { stdio: 'inherit', env: { ...env, TEST_BASE_URL: 'http://127.0.0.1:8791', TEST_MANAGER_PASSWORD: process.env.TEST_MANAGER_PASSWORD || 'local-manager-password' } }), 180000);
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await cleanup();
}
