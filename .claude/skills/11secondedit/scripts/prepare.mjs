// Step: prepare. Probes the upload and makes working copies. The original is only ever READ.
import fs from "node:fs";
import path from "node:path";
import { currentProjectDir, p, ffprobe, run, writeJSON, readJSON, log, round } from "./lib.mjs";

const dir = currentProjectDir();
const settings = readJSON(p(dir, "settings.json"));
const srcDir = p(dir, "source");
const original = fs.readdirSync(srcDir).filter((f) => !f.startsWith("."))[0];
if (!original) throw new Error("No source video uploaded.");
const originalPath = path.join(srcDir, original);
try { fs.chmodSync(originalPath, 0o444); } catch {}

const info = ffprobe(originalPath);
if (!info.hasVideo) throw new Error("The uploaded file has no video stream.");
const work = p(dir, "work");
fs.mkdirSync(work, { recursive: true });

// Short side capped at 1080 so previews and renders stay fast.
const shortSide = Math.min(info.width, info.height);
const scale = shortSide > 1080 ? (info.width < info.height ? "scale=1080:-2" : "scale=-2:1080") : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
const master = path.join(work, "master.mp4");
log("Encoding constant-frame-rate working copy…");
const audioArgs = info.hasAudio ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] : [];
run("ffmpeg", ["-y", "-v", "error", "-i", originalPath, "-map", "0:v:0", ...audioArgs,
  "-vf", `${scale},fps=30,format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
  "-g", "15", "-movflags", "+faststart", master]);

if (info.hasAudio) {
  run("ffmpeg", ["-y", "-v", "error", "-i", master, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", path.join(work, "voice_raw.wav")]);
} else {
  // Silent track so the rest of the pipeline has something to work with.
  run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `anullsrc=r=48000:cl=mono`, "-t", String(info.duration), "-c:a", "pcm_s16le", path.join(work, "voice_raw.wav")]);
}
// The composition plays edit_source.mp4; enhance_audio may replace its audio later.
fs.copyFileSync(master, path.join(work, "edit_source.mp4"));

const masterInfo = ffprobe(master);
const out = settings.format === "16:9" ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
writeJSON(path.join(work, "source_info.json"), {
  original: path.relative(dir, originalPath),
  originalInfo: info,
  master: { width: masterInfo.width, height: masterInfo.height, fps: 30, duration: round(masterInfo.duration) },
  output: { format: settings.format, ...out, fps: 30 },
});
console.log(`Prepared ${original}: ${info.width}x${info.height}, ${info.duration.toFixed(1)}s, audio=${info.hasAudio}`);
