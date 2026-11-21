// Step: color. Measures the footage with HyperFrames' deterministic analyzer and saves a
// bounded primary correction to work/color.json. build-composition applies it as a
// non-destructive media treatment on every footage clip (the source file is not re-graded).
import fs from "node:fs";
import path from "node:path";
import { currentProjectDir, p, run, writeJSON, readJSON, hyperframesArgs, round } from "./lib.mjs";

const dir = currentProjectDir();
const work = p(dir, "work");
const tmp = path.join(work, "color_probe");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, "assets"), { recursive: true });
try { fs.linkSync(path.join(work, "master.mp4"), path.join(tmp, "assets", "v.mp4")); }
catch { fs.copyFileSync(path.join(work, "master.mp4"), path.join(tmp, "assets", "v.mp4")); }
const info = readJSON(path.join(work, "source_info.json"));
fs.writeFileSync(path.join(tmp, "index.html"), `<!doctype html><html><head><meta charset="UTF-8"></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${info.master.duration}" data-width="${info.master.width}" data-height="${info.master.height}" data-no-timeline>
<video id="v" class="clip seg" src="assets/v.mp4" data-start="0" data-duration="${info.master.duration}" muted playsinline></video></div></body></html>`);

const r = run("npx", hyperframesArgs("media-treatment", "--project", tmp, "--selector", "video.seg", "--analyze", "--json"));
const res = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
const m = res.measured || {};
const s = res.suggestedPatch?.adjust || {};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Deterministic polish on top of the analyzer's technical fix, tuned for phone footage on social.
const adjust = { ...s };
if (!adjust.exposure && m.yAvg) {
  const diff = 118 - m.yAvg;                       // aim for a bright, face-friendly mid-tone
  if (Math.abs(diff) > 12) adjust.exposure = round(clamp(diff / 110, -0.4, 0.45), 3);
}
const range = (m.yHigh ?? 200) - (m.yLow ?? 30);
adjust.contrast = round(clamp((adjust.contrast || 0) + (range < 120 ? 0.12 : 0.05), -0.2, 0.25), 3);
const sat = m.satAvg ?? 70;
adjust.vibrance = round(sat < 50 ? 0.16 : sat < 70 ? 0.09 : 0.03, 3);
for (const k of Object.keys(adjust)) if (!adjust[k]) delete adjust[k];

const grading = { adjust };
writeJSON(path.join(work, "color.json"), { grading, measured: m, diagnosis: res.diagnosis || [] });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Color: ${JSON.stringify(adjust)}  (${(res.diagnosis || []).join("; ")})`);
