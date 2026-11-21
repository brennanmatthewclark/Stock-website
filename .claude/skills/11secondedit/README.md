# 11 Second Edit

One-click AI video editor that runs inside Claude Code. Type `/11secondedit`, a local browser app opens, pick your footage and settings, click **Edit Video**, and Claude turns raw talking-head footage into an edited 9:16 Reel (or 16:9).

## Setup (once)

- **Node.js 18+** and **FFmpeg** on your PATH.
- **WhisperX** for local transcription: `pip install whisperx`.
- API keys in a `.env` at your project root (see `.env.example`):
  - `AUPHONIC_API_KEY` — audio enhancement (falls back to a local FFmpeg chain without it).
  - `ELEVENLABS_API_KEY` — background music and sound effects (without it: no music, synthesised SFX).
- HyperFrames is fetched on demand with `npx hyperframes@0.9.79` (uses its own headless Chrome).

## Use

1. In Claude Code: `/11secondedit`
2. In the browser: upload a video → optionally add b-roll → toggle features → **Edit Video**.
3. Watch the checklist; when it's done, review in the editor (preview, timeline, transcript — select words and press Delete to cut), then **Export MP4**.

## How it's built

| Piece | Where |
| --- | --- |
| Skill (the orchestration Claude follows) | `SKILL.md` |
| Local server + browser app (no dependencies) | `app/server.js`, `app/public/` |
| Deterministic scripts | `scripts/` — `prepare` (FFmpeg working copy), `enhance-audio` (Auphonic/FFmpeg), `transcribe` (WhisperX), `analyze` (fillers, pauses, scene changes, thumbnails), `color` (HyperFrames grade analyzer), `music` / `sfx` (ElevenLabs), `build-edl` (word-safe cut list), `build-composition` (HyperFrames `index.html`), `render` |
| Claude's editorial decisions | `<project>/decisions.json` (bad takes, sections, b-roll, zooms, SFX, CTA, music prompt — all by word index) |

Rules baked in: the original video is stored read-only and never written; every cut falls in the gap between two words; API keys are read only from the environment.

Projects live in `./11secondedit-projects/<edit-id>/` (`source/`, `work/`, `decisions.json`, `edl.json`, `composition/`, `renders/`).
