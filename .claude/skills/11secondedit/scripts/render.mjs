// Export: renders composition/index.html to MP4 with HyperFrames (headless Chrome + FFmpeg).
// Progress goes to state.json → export, which the browser polls.
import fs from "node:fs";
import path from "node:path";
import { currentProjectDir, p, runAsync, updateState, hyperframesArgs } from "./lib.mjs";

const dir = currentProjectDir();
const quality = process.argv.includes("--draft") ? "draft" : "delivery";
const renders = p(dir, "renders");
fs.mkdirSync(renders, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(renders, `11secondedit-${stamp}.mp4`);
const setExport = (patch) => updateState(dir, (s) => { s.export = { ...(s.export || {}), ...patch }; });

setExport({ status: "rendering", progress: 0, file: null, error: null, startedAt: new Date().toISOString() });
let last = 0;
try {
  await runAsync("npx", hyperframesArgs("render", p(dir, "composition"), "-o", out, "--quality", quality, "--fps", "30"), { env: { ...process.env, HYPERFRAMES_NO_UPDATE_CHECK: "1" } }, (line) => {
    const m = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    if (m) {
      const pct = Math.min(99, Number(m[1]));
      if (pct - last >= 2) { last = pct; setExport({ progress: pct }); }
    }
  });
  if (!fs.existsSync(out)) throw new Error("Render finished but no file was written.");
  setExport({ status: "done", progress: 100, file: path.relative(dir, out), finishedAt: new Date().toISOString() });
  console.log(`Rendered ${out}`);
} catch (e) {
  setExport({ status: "error", error: e.message.slice(-1500) });
  console.error(e.message);
  process.exit(1);
}
