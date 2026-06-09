// e2e/global-teardown.js — stop the server started by global-setup.
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(here, ".e2e-state.json");

export default async function globalTeardown() {
  let pid;
  try { pid = JSON.parse(readFileSync(STATE_FILE, "utf8")).pid; } catch { return; }
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  try { rmSync(STATE_FILE); } catch {}
}
