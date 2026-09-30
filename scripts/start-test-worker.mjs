import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";

const configUrl = new URL("../dist/server/wrangler.json", import.meta.url);
const config = JSON.parse(await readFile(configUrl, "utf8"));
const worker = await unstable_dev(fileURLToPath(new URL(config.main, configUrl)), {
  config: fileURLToPath(configUrl),
  local: true,
  ip: "127.0.0.1",
  port: 8790,
  inspectorPort: 0,
  persistTo: fileURLToPath(new URL("../.wrangler/state", import.meta.url)),
  experimental: {
    // A test run must keep the compiled Worker fixed. The development registry
    // can otherwise restart it while a mutation request is still in flight.
    disableDevRegistry: true,
    disableExperimentalWarning: true,
    forceLocal: true,
    testMode: true,
  },
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await worker.stop();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
await worker.waitUntilExit();
