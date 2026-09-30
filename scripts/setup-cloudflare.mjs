import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const placeholder = "00000000-0000-4000-8000-000000000000";
const secretNames = ["MANAGER_PASSWORD_HASH", "MANAGER_PASSWORD_SALT"];

export function selectAccount(accounts, configured, requested) {
  if (configured && requested && configured !== requested) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID가 wrangler.jsonc의 account_id와 다릅니다. 다른 계정에 배포하지 않도록 중단했습니다.");
  }
  const selected = requested || configured || (accounts.length === 1 ? accounts[0].id : "");
  if (!selected) throw new Error("사용할 계정을 고를 수 없습니다. CLOUDFLARE_ACCOUNT_ID를 지정해 주세요.");
  if (!accounts.some((account) => account.id === selected)) {
    throw new Error("지정한 Cloudflare 계정에 대한 인증을 확인하지 못했습니다.");
  }
  return selected;
}

export function verifyDatabase(binding, databases) {
  if (!binding?.database_id || binding.database_id === placeholder) {
    throw new Error("실제 D1 ID가 없습니다. D1을 생성한 뒤 wrangler.jsonc의 DB database_id를 설정해 주세요.");
  }
  const matched = databases.find((database) => database.uuid === binding.database_id);
  if (!matched || matched.name !== binding.database_name) {
    throw new Error("설정한 D1 ID와 이름이 현재 계정의 데이터베이스와 일치하지 않습니다. 기존 설정을 덮어쓰지 않습니다.");
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: { ...process.env, CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
    timeout: 180000,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    ...options,
  });
  if (result.error || result.status !== 0) {
    // Never echo captured auth output or a secret-bearing child environment.
    throw new Error(options.failure || `명령이 완료되지 않았습니다: ${args.slice(0, 3).join(" ")}`);
  }
  return result.stdout || "";
}

function wrangler(args, options = {}) {
  return run(process.execPath, [
    "--import", "./scripts/runtime-env.mjs", "./node_modules/wrangler/bin/wrangler.js",
    ...args, "--config", "wrangler.jsonc",
  ], options);
}

function jsonCommand(args, failure) {
  const output = wrangler(args, { capture: true, failure });
  try { return JSON.parse(output); }
  catch { throw new Error("Wrangler가 예상한 JSON을 반환하지 않았습니다. 자원 설정을 변경하지 않았습니다."); }
}

function packageScript(name) {
  if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, "run", name]);
  } else {
    run("pnpm", ["run", name], { shell: process.platform === "win32" });
  }
}

function managerSecrets() {
  const values = {};
  const file = path.join(projectRoot, ".dev.vars");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(MANAGER_PASSWORD_HASH|MANAGER_PASSWORD_SALT)\s*=\s*["']?([a-f0-9]{64})["']?\s*$/i);
      if (match) values[match[1]] = match[2];
    }
  }
  for (const name of secretNames) {
    if (process.env[name]) values[name] = process.env[name];
  }
  if (Object.keys(values).length === 0) return null;
  if (!secretNames.every((name) => /^[a-f0-9]{64}$/i.test(values[name] || ""))) {
    throw new Error("매니저 해시와 salt를 모두 올바른 64자리 16진수로 설정해 주세요. 원문 비밀번호는 사용하지 않습니다.");
  }
  return values;
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log("사용법: pnpm cloudflare:check 또는 pnpm cloudflare:deploy\n스크립트 기본값 --check는 인증과 기존 D1/R2 연결만 확인합니다.\n--deploy는 확인 후 타입 검사, 빌드, 원격 마이그레이션, Worker 배포를 실행합니다.\n자원을 삭제하거나 자동 생성하지 않으며, 로그인이나 계정 선택을 자동으로 진행하지 않습니다.");
    return;
  }
  if (args.length > 1 || args.some((arg) => !["--check", "--deploy"].includes(arg))) {
    throw new Error("지원하지 않는 인자입니다. --help로 사용법을 확인해 주세요.");
  }
  const deploy = args[0] === "--deploy";
  const config = JSON.parse(readFileSync(path.join(projectRoot, "wrangler.jsonc"), "utf8"));
  const database = config.d1_databases?.find((binding) => binding.binding === "DB");
  const bucket = config.r2_buckets?.find((binding) => binding.binding === "BUCKET");
  if (!config.name || !bucket?.bucket_name) throw new Error("Worker 이름과 BUCKET 바인딩을 설정해 주세요.");

  const identity = jsonCommand(["whoami", "--json"], "Cloudflare 인증을 확인하지 못했습니다. 먼저 wrangler login을 완료하거나 CLOUDFLARE_API_TOKEN을 설정해 주세요. 서버와 DB는 변경하지 않았습니다.");
  if (!identity.loggedIn || !Array.isArray(identity.accounts)) throw new Error("Cloudflare 인증 정보를 확인하지 못했습니다.");
  process.env.CLOUDFLARE_ACCOUNT_ID = selectAccount(identity.accounts, config.account_id, process.env.CLOUDFLARE_ACCOUNT_ID);
  const databases = jsonCommand(["d1", "list", "--json"], "D1 목록을 읽지 못했습니다. 계정과 D1 권한을 확인해 주세요.");
  if (!Array.isArray(databases)) throw new Error("D1 목록 형식을 확인하지 못했습니다.");
  verifyDatabase(database, databases);
  const bucketInfo = jsonCommand(["r2", "bucket", "info", bucket.bucket_name, "--json"], "R2 버킷 정보를 읽지 못했습니다. 버킷 존재 여부와 접근 권한을 확인해 주세요. 버킷을 자동 생성하거나 공개하지 않습니다.");
  if (bucketInfo.name !== bucket.bucket_name) throw new Error("R2 버킷 이름이 설정과 다릅니다.");
  console.log(`인증 및 자원 확인 완료: ${config.name}, ${database.database_name}, ${bucket.bucket_name}`);
  if (!deploy) {
    console.log("읽기 전용 확인이 끝났습니다. 운영 데이터와 설정은 변경하지 않았습니다.");
    return;
  }

  const secrets = managerSecrets();
  if (!secrets) {
    const existing = jsonCommand(["secret", "list", "--format", "json"], "매니저 비밀값이 없습니다. README의 초기 매니저 설정을 먼저 완료해 주세요.");
    if (!Array.isArray(existing) || !secretNames.every((name) => existing.some((secret) => secret.name === name))) {
      throw new Error("초기 매니저 비밀값 두 개가 필요합니다. README의 초기 매니저 설정을 완료해 주세요.");
    }
  }
  packageScript("typecheck");
  packageScript("build");
  packageScript("db:migrate:remote");
  const secretFile = path.join(projectRoot, ".wrangler", `deploy-secrets-${process.pid}.json`);
  let wroteSecrets = false;
  try {
    if (secrets) {
      mkdirSync(path.dirname(secretFile), { recursive: true });
      writeFileSync(secretFile, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
      wroteSecrets = true;
    }
    run(process.execPath, [
      "--import", "./scripts/runtime-env.mjs", "./node_modules/wrangler/bin/wrangler.js",
      "deploy", "--config", "dist/server/wrangler.json",
      ...(secrets ? ["--secrets-file", secretFile] : []),
    ]);
    console.log("배포 명령이 완료되었습니다. 출력된 주소에서 게시판 조회, 로그인, 사진 업로드를 확인해 주세요.");
  } finally {
    if (wroteSecrets) rmSync(secretFile, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
