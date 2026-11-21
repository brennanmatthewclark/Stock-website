// Blocks until the user clicks "Edit Video" in the browser (or until the timeout).
// Prints the job (project dir, settings, enabled steps) as JSON.
// Exit code 0 = job ready, 3 = still waiting (call again).
import fs from "node:fs";
import path from "node:path";
import { workspaceDir, readJSON, readState, enabledSteps, updateState } from "./lib.mjs";

const timeoutSec = Number(process.argv[2] || 540);
const deadline = Date.now() + timeoutSec * 1000;

function check() {
  const ptr = path.join(workspaceDir(), "current.json");
  if (!fs.existsSync(ptr)) return null;
  const { dir } = readJSON(ptr);
  const state = readState(dir);
  if (state.status !== "requested") return null;
  const settings = readJSON(path.join(dir, "settings.json"));
  return { dir, settings, steps: enabledSteps(settings).map((s) => s.id) };
}

const heartbeat = path.join(workspaceDir(), "claude-waiting.json");
while (Date.now() < deadline) {
  try { fs.writeFileSync(heartbeat, JSON.stringify({ t: Date.now() })); } catch {}
  const job = check();
  if (job) {
    fs.rmSync(heartbeat, { force: true });
    updateState(job.dir, (s) => { s.status = "running"; s.startedAt = new Date().toISOString(); });
    console.log(JSON.stringify({ ready: true, ...job }, null, 2));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(JSON.stringify({ ready: false, message: "Still waiting for the user to click Edit Video. Run wait.mjs again." }));
process.exit(3);
