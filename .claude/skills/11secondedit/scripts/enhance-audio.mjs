// Step: enhance_audio. Auphonic API when AUPHONIC_API_KEY is set, otherwise a local FFmpeg chain.
// Writes work/voice.wav and re-muxes it into work/edit_source.mp4 (video stream copied untouched).
import fs from "node:fs";
import path from "node:path";
import { currentProjectDir, p, run, log } from "./lib.mjs";

const dir = currentProjectDir();
const work = p(dir, "work");
const raw = path.join(work, "voice_raw.wav");
const out = path.join(work, "voice.wav");
const API = "https://auphonic.com/api";
const key = process.env.AUPHONIC_API_KEY;

async function auphonic() {
  const headers = { Authorization: `Bearer ${key}` };
  const create = await fetch(`${API}/productions.json`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      metadata: { title: "11 Second Edit voice" },
      output_files: [{ format: "wav" }],
      algorithms: { filtering: true, leveler: true, normloudness: true, loudnesstarget: -16, denoise: true, denoiseamount: 0 },
    }),
  });
  if (!create.ok) throw new Error(`Auphonic create failed: ${create.status} ${await create.text()}`);
  const uuid = (await create.json()).data.uuid;
  log("Auphonic production", uuid);

  const form = new FormData();
  form.append("input_file", new Blob([fs.readFileSync(raw)], { type: "audio/wav" }), "voice.wav");
  const up = await fetch(`${API}/production/${uuid}/upload.json`, { method: "POST", headers, body: form });
  if (!up.ok) throw new Error(`Auphonic upload failed: ${up.status} ${await up.text()}`);
  const start = await fetch(`${API}/production/${uuid}/start.json`, { method: "POST", headers });
  if (!start.ok) throw new Error(`Auphonic start failed: ${start.status} ${await start.text()}`);

  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await (await fetch(`${API}/production/${uuid}.json`, { headers })).json();
    const d = st.data;
    if (d.status === 3) {
      const file = d.output_files.find((f) => f.download_url) || d.output_files[0];
      const dl = await fetch(file.download_url, { headers });
      if (!dl.ok) throw new Error(`Auphonic download failed: ${dl.status}`);
      const tmp = path.join(work, "voice_auphonic." + (file.ending || file.format || "wav"));
      fs.writeFileSync(tmp, Buffer.from(await dl.arrayBuffer()));
      run("ffmpeg", ["-y", "-v", "error", "-i", tmp, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out]);
      return "Auphonic (denoise, leveler, -16 LUFS)";
    }
    if (d.status === 2) throw new Error(`Auphonic error: ${d.error_message || d.status_string}`);
    log("Auphonic:", d.status_string);
  }
  throw new Error("Auphonic timed out");
}

function local() {
  // Deterministic fallback: high-pass, FFT denoise, gentle compression, loudness normalisation.
  run("ffmpeg", ["-y", "-v", "error", "-i", raw, "-af",
    "highpass=f=80,afftdn=nf=-25,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,loudnorm=I=-16:TP=-1.5:LRA=11",
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
  return "FFmpeg (denoise, compress, -16 LUFS) — set AUPHONIC_API_KEY for Auphonic";
}

let how;
if (key) {
  try { how = await auphonic(); } catch (e) { log(e.message, "→ falling back to FFmpeg"); how = local() + " (Auphonic failed)"; }
} else {
  how = local();
}

// Swap the enhanced voice into the working copy; the original is never touched.
const tmp = path.join(work, "edit_source.tmp.mp4");
run("ffmpeg", ["-y", "-v", "error", "-i", path.join(work, "master.mp4"), "-i", out, "-map", "0:v:0", "-map", "1:a:0",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart", tmp]);
fs.renameSync(tmp, path.join(work, "edit_source.mp4"));
console.log(how);
