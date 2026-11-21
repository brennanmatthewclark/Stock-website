// Step: sfx. Makes one file per effect type used in edl.json (ElevenLabs sound generation when
// ELEVENLABS_API_KEY is set, otherwise synthesised with FFmpeg). Cached in work/sfx/<type>.mp3.
import fs from "node:fs";
import path from "node:path";
import { currentProjectDir, p, readJSON, run } from "./lib.mjs";

const dir = currentProjectDir();
const edl = readJSON(p(dir, "edl.json"));
const sfxDir = path.join(p(dir, "work"), "sfx");
fs.mkdirSync(sfxDir, { recursive: true });
const key = process.env.ELEVENLABS_API_KEY;

const PROMPTS = {
  whoosh: ["Fast clean airy whoosh transition, short, for video editing", 0.8],
  pop: ["Soft bubbly UI pop, short and clean", 0.5],
  ding: ["Bright pleasant notification ding, single hit", 1.0],
  click: ["Crisp mouse click, single", 0.5],
  swoosh: ["Quick swoosh swipe transition", 0.6],
  boom: ["Deep cinematic bass hit impact, short", 1.2],
  camera: ["Camera shutter click", 0.6],
};
const SYNTH = {
  whoosh: ["anoisesrc=d=0.6:c=pink:a=0.6", "highpass=f=500,lowpass=f=5000,afade=t=in:d=0.3:curve=exp,afade=t=out:st=0.3:d=0.3"],
  swoosh: ["anoisesrc=d=0.4:c=white:a=0.4", "bandpass=f=2500:w=2000,afade=t=in:d=0.15,afade=t=out:st=0.15:d=0.25"],
  pop: ["sine=f=660:d=0.12", "vibrato=f=30:d=0.5,afade=t=out:st=0.02:d=0.1"],
  ding: ["sine=f=1320:d=0.8", "afade=t=out:st=0.05:d=0.75"],
  click: ["anoisesrc=d=0.03:c=white:a=0.8", "highpass=f=2000,afade=t=out:d=0.03"],
  boom: ["sine=f=55:d=1.0", "afade=t=out:st=0.05:d=0.95,volume=3"],
  camera: ["anoisesrc=d=0.12:c=white:a=0.6", "highpass=f=1500,afade=t=out:st=0.02:d=0.1"],
};

const types = [...new Set(edl.sfx.map((s) => s.type))];
for (const type of types) {
  const out = path.join(sfxDir, `${type}.mp3`);
  if (fs.existsSync(out)) continue;
  let done = false;
  if (key) {
    const [text, dur] = PROMPTS[type] || [`${type} sound effect, short, clean`, 0.8];
    const res = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, duration_seconds: dur, prompt_influence: 0.5 }),
    });
    if (res.ok) { fs.writeFileSync(out, Buffer.from(await res.arrayBuffer())); done = true; }
    else console.error(`ElevenLabs SFX "${type}" failed: ${res.status}; synthesising instead.`);
  }
  if (!done) {
    const [src, af] = SYNTH[type] || SYNTH.pop;
    run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", src, "-af", af, "-ar", "44100", "-ac", "2", "-b:a", "160k", out]);
  }
}
console.log(`SFX: ${edl.sfx.length} hits using ${types.join(", ") || "none"} (${key ? "ElevenLabs" : "synthesised"})`);
