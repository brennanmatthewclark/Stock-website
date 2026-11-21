---
name: 11secondedit
description: One-click AI video editor. Opens a local browser app where the user uploads raw talking-head footage and optional b-roll, picks features, and clicks Edit Video; Claude then cuts bad takes, fillers and silences, splits subjects, places b-roll, zooms, captions, music, sound effects and a CTA, and builds a HyperFrames composition the user reviews and exports as a 9:16 Reel or 16:9 video. Use when the user types /11secondedit or asks to edit a talking-head video into a Reel.
allowed-tools: Bash(node *), Bash(npx *), Bash(ffmpeg *), Bash(ffprobe *), Bash(pip install whisperx), Read, Write, Edit
---

# 11 Second Edit

You are the editor. The browser app collects footage and settings; **scripts do everything deterministic** (probing, encoding, audio, transcription, cut maths, captions, composition, render); **you make the editorial calls** (what to cut, where things go) by reading the word-timestamped transcript and writing `decisions.json`.

`SKILL` below means the directory holding this file (`.claude/skills/11secondedit`). Run every command from the project root so all scripts share one workspace (`./11secondedit-projects/`, or `$ELEVEN_SECOND_EDIT_HOME`).

## Rules (never break these)

1. **Never modify the original video.** It lives read-only in `<project>/source/`. Scripts only read it; all work happens on copies in `<project>/work/`. Never pass a `source/` path as an output to any command.
2. **Never cut mid-word.** You choose cuts by *word index* only; `build-edl.mjs` turns them into cut points in the gaps between words. Never hand-edit times in `edl.json` or `composition/index.html` — change `decisions.json` and rebuild.
3. **API keys live in the environment** (`AUPHONIC_API_KEY`, `ELEVENLABS_API_KEY`, in the shell or a `.env` at the project root). Never print, echo, log or write them anywhere else. If one is missing, the scripts fall back or skip; tell the user, don't ask them to paste a key into chat.
4. Anything deterministic goes through a script. Your judgement goes into `decisions.json`.

## 1. Start the app

```bash
node SKILL/scripts/start.mjs
```

It starts (or reuses) the local server, opens the browser, and prints a preflight report. If WhisperX is missing, run `pip install whisperx` now (it's needed for transcription). Tell the user in one or two lines: the app is open at the printed URL — upload a video, optionally add b-roll, choose features, click **Edit Video**. Mention any missing API key and its fallback.

## 2. Wait for "Edit Video"

```bash
node SKILL/scripts/wait.mjs        # Bash timeout: 600000
```

- Exit 0: prints the job JSON — `dir` (project), `settings` (feature toggles, `format`, `notes`, `ctaText`, `musicVibe`) and `steps` (enabled step ids, in order).
- Exit 3: still waiting — run it again. Keep waiting until the job arrives (the user may take a while).

## 3. Run each enabled step, in order, reporting progress

Wrap **every** step in `steps` like this so the browser checklist updates:

```bash
node SKILL/scripts/step.mjs start <id>
# ... do the step ...
node SKILL/scripts/step.mjs done <id> "<short result, e.g. 'Removed 3 false starts (6.2s)'>"
```

Use `step.mjs skip <id> "<why>"` when there's nothing to do, `step.mjs error <id> "<why>"` for a non-fatal failure (then continue), and `step.mjs fail "<message>"` if the pipeline cannot continue (prepare or transcribe failing). Keep details short and human.

Start `decisions.json` (in the project dir) as `{}` after transcription and add your keys step by step (schema below). Settings `notes` from the user override the default guidance below.

| id | What to do |
| --- | --- |
| `prepare` | `node SKILL/scripts/prepare.mjs` |
| `enhance_audio` | `node SKILL/scripts/enhance-audio.mjs` (Auphonic, or FFmpeg fallback). |
| `transcribe` | `node SKILL/scripts/transcribe.mjs` then `node SKILL/scripts/analyze.mjs`. Then **Read** `work/transcript.txt` in full, `work/contact_sheet.jpg`, the scene thumbnails listed in `work/analysis.json`, and every b-roll thumbnail in `work/broll_thumbs/`. Sanity-check the transcript (gibberish or mostly empty → `step.mjs fail` with advice to set `WHISPERX_MODEL=medium.en` or larger). |
| `bad_takes` | Find false starts, restarts, flubbed lines, "wait, let me start over", repeated sentences, off-camera chatter, "okay/cut/is it recording" at the start or end. When a line is repeated, keep the **last complete, fluent** take and remove the earlier ones. Write `badTakes`. |
| `fillers` | The script already finds um/uh/er/hmm (`analysis.fillers`). Add context fillers only where they're clearly verbal crutches (a throwaway "like", "you know", "I mean", "so yeah", "basically") to `extraFillers`. Don't remove words that carry meaning. |
| `silences` | Deterministic: long pauses are tightened by `build-edl.mjs`. Report how many pauses ≥0.35s `analysis.gaps` has. |
| `sections` | Split the video by subject: each outfit, product, tip, step or location. Use the transcript **and** the visual scene changes / thumbnails (an outfit change shows as a scene change). Write `sections` (short titles like "Outfit 1", "Look 2: Denim", "Tip 3" — ≤18 chars; `showTitle: false` for an intro). Put chatter between subjects ("ok let me go change", "be right back") in `removeRanges`. Silent moments worth keeping (an outfit spin or reveal, a product close-up) go in `holds` as source-time ranges, 1–3 s each. |
| `broll` | Only if `broll/` has files (else `skip`). Match each clip to what's being said, by what you saw in its thumbnail. 1.5–4 s each, start on a word that names or describes it, never in the first 2 s (the face is the hook), not over a section title, spaced at least 3 s apart. Each clip once unless there are very few. |
| `zooms` | Punch-ins on emphasis: the key claim, punchline, a number, a reveal. Roughly one every 3–6 s of output, scale 1.12–1.25, mostly `"cut"`, `"push"` for the biggest moment or two. Not during b-roll. |
| `color` | `node SKILL/scripts/color.mjs` (measures the footage and saves a bounded correction; applied non-destructively in the composition). |
| `cta` | `cta.title` = `settings.ctaText` if given, else a short CTA from the content ("Follow for part 2", "Save this for your next trip"), ≤ 28 chars; optional `subtitle`; `duration` 2.5. |
| `captions` | Deterministic (grouped from kept words by `build-edl.mjs`). Just mark done. |
| `music` | Write `music.prompt` (instrumental; from `settings.musicVibe` + the video's mood and pace, e.g. "warm upbeat lo-fi pop, light drums, no vocals, 100 bpm") and `music.volume` (0.10–0.15). Then `node SKILL/scripts/build-edl.mjs` and `node SKILL/scripts/music.mjs`. If it prints SKIPPED (no ElevenLabs key), `step.mjs skip music "Set ELEVENLABS_API_KEY to add music"`. |
| `sfx` | Add a few `sfx` hits on moments that deserve one (`pop` on a list item or zoom, `ding` on a reveal; at most one per ~3 s). Whooshes on section cuts and b-roll are automatic. Then `node SKILL/scripts/build-edl.mjs` and `node SKILL/scripts/sfx.mjs`. |
| `compose` | `node SKILL/scripts/build-edl.mjs` then `node SKILL/scripts/build-composition.mjs`. Read the printed summary: if the result is shorter than ~40% of the source or looks wrong, re-check `decisions.json`. Report e.g. "2:14 → 0:47, 38 cuts". |

When a later decision changes the cut (any step after `music`/`sfx` already ran), it's fine: `build-edl.mjs` + `build-composition.mjs` always rebuild everything from `decisions.json`.

## 4. Finish

```bash
node SKILL/scripts/step.mjs finish
```

The browser switches to the editor: live preview, timeline, and a transcript where the user deletes words to cut (rebuilds are deterministic: `rebuild.mjs` via the server, no AI). **Export MP4** renders the HyperFrames composition (`composition/index.html`) with headless Chrome + FFmpeg; **Open in HyperFrames Studio** previews the same composition there.

Tell the user, briefly: the before → after length, what you cut and added (counts), anything skipped (missing keys or tools), and that they can review, delete words in the transcript, and export from the browser. Offer to take notes in chat ("make it punchier", "drop the second outfit") — for those, edit `decisions.json`, run `node SKILL/scripts/rebuild.mjs`, and the open browser reloads the edit by itself.

For another video, the user clicks **New edit** in the browser and runs `/11secondedit` again.

## decisions.json schema

All word references are **indices** from `work/transcript.txt` (`#123`). Ranges are inclusive. Times in `holds` are source seconds.

```json
{
  "badTakes":     [{ "from": 12, "to": 30, "reason": "restarted the intro" }],
  "extraFillers": [57, 58],
  "sections":     [{ "startWord": 0, "title": "Intro", "showTitle": false },
                   { "startWord": 41, "title": "Outfit 1" },
                   { "startWord": 120, "title": "Outfit 2" }],
  "sectionTransition": "flash",
  "removeRanges": [{ "from": 110, "to": 119, "reason": "going to change" }],
  "holds":        [{ "start": 61.2, "end": 63.4, "note": "outfit spin" }],
  "broll":        [{ "file": "broll/beach.mp4", "fromWord": 70, "toWord": 79, "mediaStart": 0 }],
  "zooms":        [{ "fromWord": 45, "toWord": 49, "scale": 1.18, "style": "cut" }],
  "sfx":          [{ "atWord": 45, "type": "pop" }],
  "cta":          { "title": "Follow for part 2", "subtitle": "New looks every week", "duration": 2.5 },
  "music":        { "prompt": "warm upbeat lo-fi pop, no vocals", "volume": 0.12 }
}
```

SFX types: `whoosh`, `swoosh`, `pop`, `ding`, `click`, `boom`, `camera`. Disabled features are ignored by `build-edl.mjs` even if present.

## Files (per project, in the workspace)

`source/` original (read-only) · `broll/` user b-roll · `settings.json` toggles · `state.json` progress · `work/` working copies, transcript, analysis, music, sfx · `decisions.json` your edit · `user-edits.json` the user's transcript cuts · `edl.json` the resolved edit · `composition/` the HyperFrames project · `renders/` exports.

## Troubleshooting

- Browser didn't open: give the user the URL printed by `start.mjs`.
- Port busy: the server picks the next free port; `start.mjs` prints the real URL.
- WhisperX slow on CPU: `WHISPERX_MODEL=base.en` is faster, `medium.en` more accurate; `WHISPERX_DEVICE=cuda` on NVIDIA GPUs.
- Render issues: `cd <project>/composition && npx hyperframes@0.9.79 check` lists problems.
