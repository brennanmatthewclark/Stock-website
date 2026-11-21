// Starts (or reuses) the local 11 Second Edit server and opens the app in the browser.
// Also prints a preflight report of tools and API keys.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { workspaceDir, readJSON, which, SKILL_DIR, run } from "./lib.mjs";

const ws = workspaceDir();
const report = [];
const major = Number(process.versions.node.split(".")[0]);
report.push(`node ${process.versions.node}${major < 18 ? "  ✗ needs Node 18+" : "  ✓"}`);
report.push(`ffmpeg ${which("ffmpeg") ? "✓" : "✗ missing — install FFmpeg"}`);
let wx = process.env.WHISPERX_BIN || which("whisperx");
if (!wx) { try { run(which("python3") || "python", ["-c", "import whisperx"]); wx = "python -m whisperx"; } catch {} }
report.push(`whisperx ${wx ? "✓" : "✗ missing — run: pip install whisperx"}`);
report.push(`AUPHONIC_API_KEY ${process.env.AUPHONIC_API_KEY ? "✓ set" : "— not set (local FFmpeg cleanup will be used)"}`);
report.push(`ELEVENLABS_API_KEY ${process.env.ELEVENLABS_API_KEY ? "✓ set" : "— not set (no music; sound effects synthesised locally)"}`);

async function alive(url) {
  try { const r = await fetch(url + "/api/state", { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
function openBrowser(url) {
  if (process.argv.includes("--no-open")) return;
  const o = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(o[0], o[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
}

const info = readJSON(path.join(ws, "server.json"), null);
let url = info?.url;
if (url && (await alive(url))) {
  openBrowser(url);
} else {
  const logFile = path.join(ws, "server.log");
  const out = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [path.join(SKILL_DIR, "app", "server.js"), "--no-open"], { detached: true, stdio: ["ignore", out, out], env: process.env, cwd: process.cwd() });
  child.unref();
  url = null;
  for (let i = 0; i < 50 && !url; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const j = readJSON(path.join(ws, "server.json"), null);
    if (j && j.pid === child.pid && (await alive(j.url))) url = j.url;
  }
  if (!url) { console.error(`Server failed to start. See ${logFile}`); process.exit(1); }
  openBrowser(url);
}
console.log(`11 Second Edit is open at ${url}`);
console.log(`Workspace: ${ws}`);
console.log(report.map((l) => "  " + l).join("\n"));
