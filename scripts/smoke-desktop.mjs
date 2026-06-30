import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDesktopSmoke } from "../desktop/lib/desktop-smoke.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const result = await runDesktopSmoke(rootDir);
  console.log(`Desktop smoke test passed on port ${result.port}. App PID: ${result.pid}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
