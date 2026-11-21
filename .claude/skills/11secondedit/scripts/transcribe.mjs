// Step: transcribe. Runs WhisperX locally for word-level timestamps.
// Writes work/transcript.json: { language, words: [{ i, text, start, end, score }], segments: [...] }
// Env: WHISPERX_MODEL (default small.en), WHISPERX_DEVICE (cpu|cuda), WHISPERX_COMPUTE_TYPE (int8),
//      WHISPERX_LANGUAGE (e.g. en; auto-detect when unset), WHISPERX_BIN (path to the whisperx CLI).
import fs from "node:fs";
import path from "node:path";
import { currentProjectDir, p, run, runAsync, which, writeJSON, round, log } from "./lib.mjs";

const dir = currentProjectDir();
const work = p(dir, "work");
const audio16 = path.join(work, "voice_16k.wav");
const voice = fs.existsSync(path.join(work, "voice.wav")) ? path.join(work, "voice.wav") : path.join(work, "voice_raw.wav");
run("ffmpeg", ["-y", "-v", "error", "-i", voice, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audio16]);

const outDir = path.join(work, "whisperx");
fs.mkdirSync(outDir, { recursive: true });
const model = process.env.WHISPERX_MODEL || "small.en";
const device = process.env.WHISPERX_DEVICE || "cpu";
const computeType = process.env.WHISPERX_COMPUTE_TYPE || (device === "cpu" ? "int8" : "float16");
const language = process.env.WHISPERX_LANGUAGE || (model.endsWith(".en") ? "en" : "");
// A disfluent prompt nudges Whisper to keep "um"/"uh" instead of silently dropping them.
const prompt = "Umm, so, uh, I was like, you know, thinking... Hmm, okay. Uh, let me, um, start again.";

let cmd = process.env.WHISPERX_BIN || which("whisperx");
let pre = [];
if (!cmd) { cmd = which("python3") || "python"; pre = ["-m", "whisperx"]; }
const args = [...pre, audio16, "--model", model, "--device", device, "--compute_type", computeType,
  "--output_dir", outDir, "--output_format", "json", "--initial_prompt", prompt, "--print_progress", "True"];
if (language) args.push("--language", language);

log(`whisperx model=${model} device=${device}`);
try {
  await runAsync(cmd, args, {}, (l) => { if (/progress|%/i.test(l)) log(l.trim()); });
} catch (e) {
  throw new Error(`WhisperX failed. Install it with: pip install whisperx  (and ffmpeg).\n${e.message}`);
}

const json = JSON.parse(fs.readFileSync(path.join(outDir, "voice_16k.json"), "utf8"));
const words = [];
const segments = [];
for (const seg of json.segments || []) {
  const first = words.length;
  for (const w of seg.words || []) {
    const text = String(w.word || "").trim();
    if (!text) continue;
    words.push({ i: words.length, text, start: w.start, end: w.end, score: w.score ?? null });
  }
  if (words.length > first) segments.push({ start: seg.start, end: seg.end, firstWord: first, lastWord: words.length - 1, text: String(seg.text || "").trim() });
}

// WhisperX leaves some tokens (numbers, symbols) unaligned: give them the space between neighbours.
for (let i = 0; i < words.length; i++) {
  const w = words[i];
  if (typeof w.start === "number" && typeof w.end === "number") continue;
  let j = i;
  while (j < words.length && (typeof words[j].start !== "number" || typeof words[j].end !== "number")) j++;
  const from = i > 0 ? words[i - 1].end : 0;
  const to = j < words.length ? words[j].start : from + 0.4 * (j - i);
  const step = Math.max(0.05, (to - from) / (j - i));
  for (let k = i; k < j; k++) {
    words[k].start = round(from + step * (k - i));
    words[k].end = round(from + step * (k - i + 1));
    words[k].interpolated = true;
  }
  i = j - 1;
}
// Guarantee monotonic, non-overlapping spans so a cut between two words is always well defined.
for (let i = 0; i < words.length; i++) {
  const w = words[i];
  w.start = round(w.start); w.end = round(Math.max(w.end, w.start + 0.02));
  if (i > 0 && w.start < words[i - 1].end) {
    const mid = round((words[i - 1].end + w.start) / 2);
    words[i - 1].end = Math.max(words[i - 1].start + 0.02, mid);
    w.start = Math.max(words[i - 1].end, w.start);
    w.end = Math.max(w.end, w.start + 0.02);
  }
}

writeJSON(path.join(work, "transcript.json"), { language: json.language || language || null, model, words, segments });
console.log(`Transcribed ${words.length} words in ${segments.length} segments.`);
