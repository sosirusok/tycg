// The Pages folder for the public address (WP67, scripts/pages-out.mjs). Node only, no network, no build:
// it runs the script on a fake build in a temp folder and checks what deploy.yml uploads.
//   - out/ is a copy of the screens without _redirects, _headers or 404.html, and a second run leaves no
//     stale file behind;
//   - out/_worker.js hands the original request to the APP binding (imported and called with a fake
//     binding) and answers 503 with a JSON error without one;
//   - out/_routes.json includes exactly the Worker's run_worker_first routes from wrangler.jsonc;
//   - wrangler.json binds APP to the Worker by name with the Worker's compatibility_date;
//   - --redirect writes exactly '/* <address>/:splat 301' and refuses anything but an https address
//     (Workers drop any other redirect target);
//   - src/, worker/ and shared/ name no site address (links use location.origin or the request's own).
// node tests/verify-pages-out.mjs
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/pages-out.mjs');
const { BINDING, UNAVAILABLE, routesFor } = await import(pathToFileURL(script).href);
const { experimental_readRawConfig } = createRequire(import.meta.url)('wrangler');
const worker = experimental_readRawConfig({ config: path.join(root, 'wrangler.jsonc') }).rawConfig;

let failures = 0;
function check(ok, message) {
    if (ok) return;
    failures++;
    console.error('verify-pages-out: ' + message);
}
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
const files = dir => readdirSync(dir, { recursive: true }).map(f => f.split(path.sep).join('/')).sort();

const tmp = mkdtempSync(path.join(tmpdir(), 'pages-out-'));
try {
    // A fake build with every file Pages would treat as its own setting.
    const client = path.join(tmp, 'client');
    mkdirSync(path.join(client, 'assets'), { recursive: true });
    mkdirSync(path.join(client, 'icons', 'deep'), { recursive: true });
    const index = '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>';
    writeFileSync(path.join(client, 'index.html'), index);
    writeFileSync(path.join(client, 'assets', 'app.js'), 'console.log(1);');
    writeFileSync(path.join(client, 'icons', 'deep', 'a.png'), 'png');
    writeFileSync(path.join(client, 'sw.js'), 'self.addEventListener("push", () => {});');
    writeFileSync(path.join(client, '_redirects'), '/* https://old.example/:splat 301\n');
    writeFileSync(path.join(client, '_headers'), '/*\n  X-Test: 1\n');
    writeFileSync(path.join(client, '404.html'), 'not found');
    writeFileSync(path.join(client, 'icons', '404.html'), 'not found');

    const pages = path.join(tmp, 'pages'), out = path.join(pages, 'out');
    const first = run('--assets', client, '--out', pages, '--config', path.join(root, 'wrangler.jsonc'), '--project', 'zhstrade');
    check(first.status === 0, `the folder run failed: ${first.stderr}`);

    // The copy: every screen file, none of the Pages setting files, plus _worker.js and _routes.json.
    const want = ['_routes.json', '_worker.js', 'assets', 'assets/app.js', 'icons', 'icons/deep', 'icons/deep/a.png', 'index.html', 'sw.js'];
    check(JSON.stringify(files(out)) === JSON.stringify(want), `out/ holds ${JSON.stringify(files(out))}, want ${JSON.stringify(want)}`);
    check(readFileSync(path.join(out, 'index.html'), 'utf8') === index, 'out/index.html differs from the build');
    check(existsSync(path.join(client, '_redirects')) && existsSync(path.join(client, '404.html')), 'the build folder itself was changed');

    // _worker.js: the binding gets the very same Request object (address, cookies, Origin, CF-Connecting-IP).
    const copy = path.join(tmp, 'worker-copy.mjs');
    copyFileSync(path.join(out, '_worker.js'), copy);
    const pagesWorker = (await import(pathToFileURL(copy).href)).default;
    const request = new Request('https://zhstrade.pages.dev/api/auth/login', { method: 'POST', headers: { Origin: 'https://zhstrade.pages.dev', 'CF-Connecting-IP': '203.0.113.7', Cookie: 'zg_session=x' }, body: '{}' });
    let seen = null;
    const answer = new Response('{"ok":true}', { status: 200, headers: { 'Set-Cookie': 'zg_session=y; HttpOnly; Secure' } });
    const passed = await pagesWorker.fetch(request, { [BINDING]: { fetch: r => { seen = r; return answer; } } });
    check(seen === request, '_worker.js did not hand the original request to the binding');
    check(passed === answer, '_worker.js did not return the Worker response as is');
    const missing = await pagesWorker.fetch(new Request('https://zhstrade.pages.dev/api/health'), {});
    check(missing.status === 503, `without the binding _worker.js answered ${missing.status}, want 503`);
    check((missing.headers.get('content-type') || '').startsWith('application/json'), 'the 503 is not JSON');
    const missingBody = await missing.json().catch(() => null);
    check(missingBody?.error === UNAVAILABLE, `the 503 body is ${JSON.stringify(missingBody)}`);

    // _routes.json: exactly the Worker's run_worker_first routes.
    const routes = JSON.parse(readFileSync(path.join(out, '_routes.json'), 'utf8'));
    check(JSON.stringify(routes) === JSON.stringify({ version: 1, include: worker.assets.run_worker_first, exclude: [] }), `_routes.json is ${JSON.stringify(routes)}, want include ${JSON.stringify(worker.assets.run_worker_first)}`);
    check(JSON.stringify(routesFor(undefined).include) === '["/api/*"]', 'no run_worker_first must mean /api/*');
    check(JSON.stringify(routesFor(true).include) === '["/*"]', 'run_worker_first true must mean every path');
    check(JSON.stringify(routesFor(['/api/*', '!/api/docs/*'])) === JSON.stringify({ version: 1, include: ['/api/*'], exclude: ['/api/docs/*'] }), "a '!' route must become an exclude");

    // wrangler.json: the Pages config wrangler pages deploy applies (service binding, compatibility date).
    const config = JSON.parse(readFileSync(path.join(pages, 'wrangler.json'), 'utf8'));
    const wantConfig = { name: 'zhstrade', pages_build_output_dir: './out', compatibility_date: worker.compatibility_date, services: [{ binding: 'APP', service: worker.name }] };
    check(JSON.stringify(config) === JSON.stringify(wantConfig), `wrangler.json is ${JSON.stringify(config)}, want ${JSON.stringify(wantConfig)}`);
    check(worker.name === 'zombiego-market', `the Worker is named ${worker.name}; deploy.yml binds the Pages project to WORKER_NAME`);

    // A second run replaces out/ completely (deploy.yml may reuse the folder).
    writeFileSync(path.join(out, 'stale.txt'), 'old');
    const second = run('--assets', client, '--out', pages, '--config', path.join(root, 'wrangler.jsonc'), '--project', 'zhstrade');
    check(second.status === 0 && !existsSync(path.join(out, 'stale.txt')), 'a second run left a stale file in out/');
    check(run('--assets', client, '--out', path.join(client, 'pages'), '--config', path.join(root, 'wrangler.jsonc')).status !== 0, 'an out folder inside the build must be refused');
    check(run('--assets', client, '--out', pages, '--config', path.join(root, 'wrangler.jsonc'), '--project', 'Bad_Name').status !== 0, 'a bad project name must be refused');
    const foreign = path.join(tmp, 'foreign');
    mkdirSync(foreign);
    writeFileSync(path.join(foreign, 'wrangler.json'), '{"name":"other","main":"index.js"}');
    check(run('--assets', client, '--out', foreign, '--config', path.join(root, 'wrangler.jsonc')).status !== 0
        && readFileSync(path.join(foreign, 'wrangler.json'), 'utf8').includes('"other"'), 'a folder with another wrangler.json must be refused and left as is');

    // --redirect: the exact line, from an address with or without a trailing slash.
    const target = path.join(tmp, 'target');
    mkdirSync(target);
    writeFileSync(path.join(target, 'index.html'), index);
    for (const to of ['https://zhstrade.pages.dev', 'https://zhstrade.pages.dev/']) {
        const r = run('--redirect', target, '--to', to);
        check(r.status === 0, `--redirect --to ${to} failed: ${r.stderr}`);
        const line = existsSync(path.join(target, '_redirects')) ? readFileSync(path.join(target, '_redirects'), 'utf8') : '';
        check(line === '/* https://zhstrade.pages.dev/:splat 301\n', `--to ${to} wrote ${JSON.stringify(line)}`);
    }
    rmSync(path.join(target, '_redirects'));
    for (const to of ['http://zhstrade.pages.dev', 'http://127.0.0.1:8883', 'https://zhstrade.pages.dev:8443', 'https://zhstrade.pages.dev/board', 'https://zhstrade.pages.dev/?a=1', 'zhstrade.pages.dev', 'ftp://zhstrade.pages.dev']) {
        check(run('--redirect', target, '--to', to).status !== 0, `--redirect --to ${to} must be refused`);
    }
    check(!existsSync(path.join(target, '_redirects')), 'a refused --redirect still wrote _redirects');
    check(run('--redirect', path.join(tmp, 'nowhere'), '--to', 'https://zhstrade.pages.dev').status !== 0, '--redirect into a folder without index.html must be refused');
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

// No site address in the code: share links, og tags, push and mail use location.origin or the request's own.
const HOSTS = /\b[\w-]+\.(?:workers\.dev|pages\.dev)\b|sosirusok\.workers|zombiego-market\.[a-z]/i;
for (const dir of ['src', 'worker', 'shared']) {
    for (const name of readdirSync(path.join(root, dir), { recursive: true })) {
        if (!/\.(?:ts|tsx|js|mjs|css|html)$/.test(name)) continue;
        const text = readFileSync(path.join(root, dir, name), 'utf8');
        const hit = text.match(HOSTS);
        check(!hit, `${dir}/${name} names a site address (${hit?.[0]}); use location.origin or new URL(req.url).origin`);
    }
}
const indexHtml = readFileSync(path.join(root, 'index.html'), 'utf8').match(HOSTS);
check(!indexHtml, `index.html names a site address (${indexHtml?.[0]})`);

if (failures) {
    console.error(`verify-pages-out: ${failures} check(s) failed`);
    process.exit(1);
}
console.log('PASS verify-pages-out (Pages folder, _worker.js hand-off, _routes.json, service binding, redirect line, no site address in code)');
