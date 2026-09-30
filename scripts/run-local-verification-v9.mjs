import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
process.chdir(projectRoot);
await access("dist/server/wrangler.json").catch(() => {
  throw new Error("빌드 결과가 없습니다. 먼저 pnpm build를 실행해 주세요.");
});

const children = new Set();
function child(args, options = {}) {
  const process = spawn(globalThis.process.execPath, args, {
    cwd: projectRoot,
    detached: globalThis.process.platform !== "win32",
    ...options,
  });
  children.add(process);
  process.once("exit", () => children.delete(process));
  return process;
}
function stop(process, signal = "SIGTERM") {
  if (process.exitCode !== null) return;
  try {
    if (globalThis.process.platform === "win32") process.kill(signal);
    else globalThis.process.kill(-process.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function completed(process, milliseconds) {
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(process); }, milliseconds);
  const killTimer = setTimeout(() => stop(process, "SIGKILL"), milliseconds + 3000);
  try {
    const [code, signal] = await once(process, "exit");
    if (timedOut) throw new Error("로컬 검증 제한 시간을 초과했습니다.");
    if (code !== 0) throw new Error(`로컬 검증이 실패했습니다 (${signal ?? code}).`);
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
}
async function cleanup() {
  const active = [...children];
  for (const process of active) stop(process);
  await Promise.race([
    Promise.all(active.map((process) => process.exitCode === null ? once(process, "exit") : Promise.resolve())),
    delay(3000),
  ]);
  for (const process of active) stop(process, "SIGKILL");
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
}

try {
  await completed(child([
    "--import", "./scripts/runtime-env.mjs", "./node_modules/wrangler/bin/wrangler.js",
    "d1", "migrations", "apply", "DB", "--local", "--persist-to", ".wrangler/state", "--config", "wrangler.jsonc",
  ], { stdio: "inherit" }), 60000);

  const server = child([
    "--import", "./scripts/runtime-env.mjs", "./scripts/start-test-worker.mjs",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.pipe(process.stdout);
  server.stderr.pipe(process.stderr);
  const deadline = Date.now() + 45000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("로컬 서버가 검증 전에 종료되었습니다.");
    try {
      const response = await fetch("http://127.0.0.1:8790/api/auth/me", { signal: AbortSignal.timeout(2000) });
      await response.arrayBuffer();
      if (response.ok) { ready = true; break; }
    } catch { /* Wait until the local Worker can answer requests. */ }
    await delay(250);
  }
  if (!ready) throw new Error("로컬 서버 시작 시간을 초과했습니다.");

  await completed(child(["scripts/verify-market-v9.mjs"], {
    stdio: "inherit",
    env: { ...process.env, TEST_BASE_URL: "http://127.0.0.1:8790" },
  }), 120000);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
