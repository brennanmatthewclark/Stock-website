// Deterministic analysis that Claude reads before making editorial decisions.
// Writes work/analysis.json, work/transcript.txt (word-indexed), scene thumbnails and b-roll thumbnails.
import fs from "node:fs";
import path from "node:path";
import { currentProjectDir, p, readJSON, writeJSON, run, ffprobe, round } from "./lib.mjs";

const dir = currentProjectDir();
const work = p(dir, "work");
const transcript = readJSON(path.join(work, "transcript.json"));
const words = transcript.words;
const info = readJSON(path.join(work, "source_info.json"));

// ---- filler words (pure word list; context-dependent fillers like "like" are left to Claude) ----
const FILLERS = new Set(["um", "umm", "ummm", "uh", "uhh", "uhm", "er", "erm", "ah", "ahh", "hmm", "hm", "mm", "mmm", "mhm"]);
const norm = (t) => t.toLowerCase().replace(/[^a-z']/g, "");
const fillers = words.filter((w) => FILLERS.has(norm(w.text))).map((w) => w.i);

// ---- silences: gaps between words ----
const gaps = [];
for (let i = 1; i < words.length; i++) {
  const g = words[i].start - words[i - 1].end;
  if (g >= 0.35) gaps.push({ afterWord: i - 1, start: words[i - 1].end, end: words[i].start, duration: round(g) });
}
const lead = words.length ? words[0].start : info.master.duration;
const tail = words.length ? info.master.duration - words[words.length - 1].end : 0;

// ---- visual scene changes (outfit changes, location changes) ----
const sceneDir = path.join(work, "scenes");
fs.rmSync(sceneDir, { recursive: true, force: true });
fs.mkdirSync(sceneDir, { recursive: true });
const sd = run("ffmpeg", ["-hide_banner", "-i", path.join(work, "master.mp4"), "-an",
  "-vf", "scale=160:-2,select='gt(scene,0.32)',showinfo", "-f", "null", "-"], { allowFail: true });
const scenes = [];
for (const m of (sd.stderr || "").matchAll(/pts_time:([0-9.]+)/g)) {
  const t = Number(m[1]);
  if (!scenes.length || t - scenes[scenes.length - 1].time > 1.0) scenes.push({ time: round(t) });
}
const thumb = (t, file) => run("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", path.join(work, "master.mp4"), "-frames:v", "1", "-vf", "scale=320:-2", file], { allowFail: true });
scenes.forEach((s, k) => { s.thumb = `work/scenes/scene_${k}.jpg`; thumb(s.time + 0.3, p(dir, s.thumb)); });
// A contact sheet (one frame every ~N s) so Claude can see the whole video at a glance.
const every = Math.max(2, Math.ceil(info.master.duration / 24));
run("ffmpeg", ["-y", "-v", "error", "-i", path.join(work, "master.mp4"), "-vf",
  `fps=1/${every},scale=240:-2,drawtext=text='%{pts\\:hms}':x=6:y=6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6,tile=6x4`,
  "-frames:v", "1", path.join(work, "contact_sheet.jpg")], { allowFail: true });

// ---- user b-roll ----
const brollDir = p(dir, "broll");
const broll = [];
if (fs.existsSync(brollDir)) {
  fs.mkdirSync(path.join(work, "broll_thumbs"), { recursive: true });
  for (const f of fs.readdirSync(brollDir).filter((f) => !f.startsWith("."))) {
    const full = path.join(brollDir, f);
    const isImage = /\.(png|jpe?g|webp|gif)$/i.test(f);
    let duration = null;
    if (!isImage) { try { duration = round(ffprobe(full).duration, 2); } catch {} }
    const t = `work/broll_thumbs/${f}.jpg`;
    run("ffmpeg", ["-y", "-v", "error", ...(isImage ? [] : ["-ss", String(Math.min(1, (duration || 2) / 2))]), "-i", full, "-frames:v", "1", "-vf", "scale=320:-2", p(dir, t)], { allowFail: true });
    broll.push({ file: `broll/${f}`, type: isImage ? "image" : "video", duration, thumb: t });
  }
}

writeJSON(path.join(work, "analysis.json"), {
  duration: info.master.duration, wordCount: words.length, fillers, gaps, leadSilence: round(lead), tailSilence: round(tail),
  scenes, broll, contactSheet: "work/contact_sheet.jpg", contactSheetEvery: every,
});

// ---- the word-indexed transcript Claude edits from ----
const lines = [];
lines.push(`# Transcript (${words.length} words, ${info.master.duration.toFixed(1)}s). Format: [start] #index word ...`);
lines.push(`# Fillers auto-detected: ${fillers.join(", ") || "none"}`);
lines.push(`# Visual scene changes at: ${scenes.map((s) => s.time + "s").join(", ") || "none"}`);
for (const seg of transcript.segments) {
  const parts = [];
  for (let i = seg.firstWord; i <= seg.lastWord; i++) {
    const w = words[i];
    const gap = i > seg.firstWord ? w.start - words[i - 1].end : 0;
    if (gap >= 0.35) parts.push(`⟨${gap.toFixed(1)}s⟩`);
    parts.push(`#${i} ${w.text}`);
  }
  lines.push(`[${seg.start.toFixed(2)}] ${parts.join(" ")}`);
}
fs.writeFileSync(path.join(work, "transcript.txt"), lines.join("\n") + "\n");
console.log(`Analysis: ${fillers.length} fillers, ${gaps.length} pauses ≥0.35s, ${scenes.length} scene changes, ${broll.length} b-roll files.`);
console.log(`Read: ${path.join(work, "transcript.txt")}`);
