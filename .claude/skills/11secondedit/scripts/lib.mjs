// Shared helpers for 11 Second Edit. Everything here is deterministic.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HYPERFRAMES_VERSION = "0.9.79";

// ---------- env (.env files; API keys never leave env) ----------
export function loadEnv() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(SKILL_DIR, ".env"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

// ---------- workspace / project ----------
export function workspaceDir() {
  const dir = process.env.ELEVEN_SECOND_EDIT_HOME || path.join(process.cwd(), "11secondedit-projects");
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
}

export function currentProjectDir() {
  const flag = process.argv.indexOf("--project");
  if (flag !== -1 && process.argv[flag + 1]) return path.resolve(process.argv[flag + 1]);
  const pointer = path.join(workspaceDir(), "current.json");
  if (!fs.existsSync(pointer)) throw new Error("No active project. Start the app with /11secondedit first.");
  return JSON.parse(fs.readFileSync(pointer, "utf8")).dir;
}

export function p(projectDir, ...parts) {
  return path.join(projectDir, ...parts);
}

export function readJSON(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Could not read ${file}: ${e.message}`);
  }
}

export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- features ----------
export const FEATURES = [
  { id: "enhance_audio", label: "Enhance audio", default: true },
  { id: "bad_takes", label: "Remove bad takes and false starts", default: true },
  { id: "fillers", label: "Remove filler words", default: true },
  { id: "silences", label: "Remove silences", default: true },
  { id: "sections", label: "Cut between subjects (e.g. each outfit)", default: true },
  { id: "broll", label: "Add b-roll", default: true },
  { id: "zooms", label: "Add zoom cuts", default: true },
  { id: "color", label: "Auto color correction", default: true },
  { id: "cta", label: "Call to action card at the end", default: true },
  { id: "captions", label: "Animated word-by-word captions", default: true },
  { id: "music", label: "Background music", default: true },
  { id: "sfx", label: "Sound effects", default: true },
];

// Ordered pipeline. `always` steps run regardless of toggles.
export const STEPS = [
  { id: "prepare", label: "Prepare footage (original stays untouched)", always: true },
  { id: "enhance_audio", label: "Enhance audio" },
  { id: "transcribe", label: "Transcribe with word timestamps", always: true },
  { id: "bad_takes", label: "Remove bad takes and false starts" },
  { id: "fillers", label: "Remove filler words" },
  { id: "silences", label: "Remove silences" },
  { id: "sections", label: "Cut between subjects" },
  { id: "broll", label: "Place b-roll" },
  { id: "zooms", label: "Add zoom cuts" },
  { id: "color", label: "Auto color correction" },
  { id: "cta", label: "Call to action card" },
  { id: "captions", label: "Animated captions" },
  { id: "music", label: "Background music" },
  { id: "sfx", label: "Sound effects" },
  { id: "compose", label: "Build HyperFrames composition", always: true },
];

export function defaultSettings() {
  const features = {};
  for (const f of FEATURES) features[f.id] = f.default;
  return { features, format: "9:16", notes: "", ctaText: "", musicVibe: "" };
}

export function enabledSteps(settings) {
  return STEPS.filter((s) => s.always || settings.features?.[s.id]);
}

// ---------- state / progress ----------
export function statePath(dir) {
  return p(dir, "state.json");
}

export function readState(dir) {
  return readJSON(statePath(dir), { status: "idle", steps: [], log: [] });
}

export function updateState(dir, mutate) {
  const s = readState(dir);
  mutate(s);
  s.updatedAt = new Date().toISOString();
  writeJSON(statePath(dir), s);
  return s;
}

export function setStep(dir, id, status, detail) {
  return updateState(dir, (s) => {
    const step = s.steps.find((x) => x.id === id);
    if (!step) return;
    step.status = status;
    if (detail !== undefined) step.detail = detail;
    if (status === "running") step.startedAt = new Date().toISOString();
    if (status === "done" || status === "skipped" || status === "error") step.finishedAt = new Date().toISOString();
    s.log = [...(s.log || []), { t: new Date().toISOString(), step: id, status, detail: detail || "" }].slice(-200);
  });
}

// ---------- processes ----------
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 200, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}):\n${(r.stderr || "").slice(-4000)}`);
  }
  return r;
}

export function runAsync(cmd, args, opts = {}, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts });
    let out = "";
    let err = "";
    const handle = (buf, isErr) => {
      const text = buf.toString();
      if (isErr) err += text; else out += text;
      if (onLine) text.split(/\r|\n/).filter(Boolean).forEach((l) => onLine(l));
    };
    child.stdout?.on("data", (b) => handle(b, false));
    child.stderr?.on("data", (b) => handle(b, true));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} exited ${code}\n${err.slice(-4000)}`));
    });
  });
}

export function which(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

export function ffprobe(file) {
  const r = run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  let width = v ? v.width : 0;
  let height = v ? v.height : 0;
  // Respect rotation metadata from phones.
  const rot = Number(v?.tags?.rotate ?? v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0);
  if (Math.abs(rot) === 90 || Math.abs(rot) === 270) [width, height] = [height, width];
  const [n, d] = (v?.avg_frame_rate || "30/1").split("/").map(Number);
  return {
    duration: Number(j.format.duration || v?.duration || a?.duration || 0),
    width,
    height,
    fps: d ? n / d : 30,
    hasVideo: !!v,
    hasAudio: !!a,
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    rotation: rot,
  };
}

export function hyperframesArgs(...args) {
  return ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, ...args];
}

export function round(n, d = 3) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export function log(...a) {
  console.log("[11secondedit]", ...a);
}
