import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const database = config.d1_databases?.find((entry) => entry.binding === "DB");
const id = database?.database_id;
if (!id || id === "00000000-0000-4000-8000-000000000000" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  console.error("원격 DB가 설정되지 않았습니다. wrangler.jsonc의 DB database_id를 실제 D1 ID로 바꿔 주세요.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [
  "--import", "./scripts/runtime-env.mjs",
  "./node_modules/wrangler/bin/wrangler.js",
  "d1", "migrations", "apply", "DB", "--remote", "--config", "wrangler.jsonc",
], { cwd: projectRoot, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
