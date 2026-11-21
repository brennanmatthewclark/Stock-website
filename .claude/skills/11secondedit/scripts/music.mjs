// Step: music. Generates an instrumental bed with the ElevenLabs Music API.
// Usage: node music.mjs "<prompt>"   (needs ELEVENLABS_API_KEY; length follows edl.json)
import fs from "node:fs";
import path from "node:path";
import { currentProjectDir, p, readJSON, run } from "./lib.mjs";

const dir = currentProjectDir();
const args = process.argv.slice(2).filter((a, i, arr) => a !== "--project" && arr[i - 1] !== "--project");
const prompt = args.join(" ") || readJSON(p(dir, "decisions.json"), {}).music?.prompt ||
  "Upbeat, modern, minimal lo-fi pop instrumental for a social media talking-head video. Light drums, warm synths, no vocals.";
const edl = readJSON(p(dir, "edl.json"));
const key = process.env.ELEVENLABS_API_KEY;
if (!key) { console.log("SKIPPED: ELEVENLABS_API_KEY is not set (add it to .env)."); process.exit(0); }

// Headroom so later transcript edits never run out of music; the composition fades it out.
const ms = Math.round(Math.min(300, Math.max(10, edl.duration + 10)) * 1000);
const res = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
  method: "POST",
  headers: { "xi-api-key": key, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt, music_length_ms: ms, model_id: "music_v1", force_instrumental: true }),
});
if (!res.ok) { console.error(`ElevenLabs music failed: ${res.status} ${await res.text()}`); process.exit(1); }
const out = path.join(p(dir, "work"), "music.mp3");
fs.writeFileSync(out + ".tmp", Buffer.from(await res.arrayBuffer()));
// Normalise loudness so the volume in the mix is predictable.
run("ffmpeg", ["-y", "-v", "error", "-i", out + ".tmp", "-af", "loudnorm=I=-16:TP=-1.5", "-ar", "44100", "-b:a", "192k", out]);
fs.rmSync(out + ".tmp");
console.log(`Music: ${(ms / 1000).toFixed(0)}s — "${prompt}"`);
