// Deterministic edit decision list. Combines:
//   work/transcript.json   (WhisperX words)
//   work/analysis.json     (auto-detected fillers)
//   decisions.json         (Claude's editorial choices, by word index)
//   user-edits.json        (words the user cut/restored in the browser transcript)
//   settings.json          (feature toggles)
// into edl.json: kept source ranges, output-timeline positions of every word, overlays and captions.
// Every cut lands in the gap BETWEEN two words — never inside one.
import fs from "node:fs";
import path from "node:path";
import { currentProjectDir, p, readJSON, writeJSON, round } from "./lib.mjs";

const PAD_IN = 0.08;      // breathing room before a word
const PAD_OUT = 0.12;     // and after it
const MAX_GAP = 0.3;      // pauses longer than this are tightened when "Remove silences" is on
const SECTION_GAP = 0.05; // padding kept around a subject-change cut

export function buildEdl(dir) {
  const work = p(dir, "work");
  const settings = readJSON(p(dir, "settings.json"));
  const F = settings.features || {};
  const info = readJSON(path.join(work, "source_info.json"));
  const words = readJSON(path.join(work, "transcript.json")).words.map((w) => ({ ...w }));
  const analysis = readJSON(path.join(work, "analysis.json"), {});
  const d = readJSON(p(dir, "decisions.json"), {});
  const edits = readJSON(p(dir, "user-edits.json"), { cut: [], restore: [] });
  const total = info.master.duration;
  const out = settings.format === "16:9" ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
  const clampIdx = (i) => Math.max(0, Math.min(words.length - 1, Number(i)));

  // ---------- 1. which words are removed, and why ----------
  const reason = new Map();
  const mark = (i, why) => { if (words[i] && !reason.has(i)) reason.set(i, why); };
  if (F.bad_takes) for (const r of d.badTakes || []) for (let i = clampIdx(r.from); i <= clampIdx(r.to); i++) mark(i, r.reason ? `bad take: ${r.reason}` : "bad take");
  if (F.sections) for (const r of d.removeRanges || []) for (let i = clampIdx(r.from); i <= clampIdx(r.to); i++) mark(i, r.reason || "between subjects");
  if (F.fillers) {
    for (const i of analysis.fillers || []) mark(i, "filler");
    for (const i of d.extraFillers || []) mark(clampIdx(i), "filler");
  }
  for (const i of edits.restore || []) reason.delete(Number(i));
  for (const i of edits.cut || []) { reason.delete(Number(i)); mark(Number(i), "cut by you"); }
  words.forEach((w) => { w.removed = reason.has(w.i); w.reason = reason.get(w.i) || null; });

  // Section starts (first word of each subject), used to force a clean cut.
  const sectionStarts = new Set();
  const sections = F.sections ? (d.sections || []).map((s) => ({ ...s, startWord: clampIdx(s.startWord ?? s.fromWord ?? 0) })).sort((a, b) => a.startWord - b.startWord) : [];
  sections.forEach((s, k) => { if (k > 0) sectionStarts.add(s.startWord); });

  // ---------- 2. kept source ranges ----------
  const prevEnd = (i) => (i > 0 ? words[i - 1].end : 0);
  const nextStart = (i) => (i < words.length - 1 ? words[i + 1].start : total);
  let ranges = [];
  let lastKept = -1;
  for (const w of words) {
    if (w.removed) continue;
    const isFirst = lastKept === -1;
    const padIn = isFirst && !F.silences ? 0.4 : PAD_IN;
    let a = Math.max(0, prevEnd(w.i), w.start - padIn);
    let b = Math.min(total, nextStart(w.i), w.end + PAD_OUT);
    const prev = ranges[ranges.length - 1];
    const adjacent = lastKept === w.i - 1; // nothing removed in between
    const forcedCut = [...sectionStarts].some((s) => s > lastKept && s <= w.i);
    if (prev && adjacent && !forcedCut && (!F.silences || a - prev.b <= MAX_GAP)) {
      prev.b = b; // keep the natural pause
    } else {
      if (prev && forcedCut) {
        // Subject change: tight cut in the gap (still between words).
        let cutB = words[lastKept].end + SECTION_GAP, cutA = w.start - SECTION_GAP;
        if (cutB > cutA) cutB = cutA = (words[lastKept].end + w.start) / 2;
        prev.b = Math.min(prev.b, cutB);
        a = Math.max(a, cutA);
      }
      ranges.push({ a, b, sectionCut: !!(prev && forcedCut) });
    }
    lastKept = w.i;
  }
  if (!F.silences && ranges.length) ranges[ranges.length - 1].b = Math.min(total, ranges[ranges.length - 1].b + 0.3);

  // Holds: moments Claude keeps with no speech (e.g. showing an outfit). Snapped so they never split a removed word.
  for (const h of d.holds || []) {
    let a = Math.max(0, Number(h.start)), b = Math.min(total, Number(h.end));
    for (const w of words) {
      if (w.start < a && a < w.end) a = w.removed ? w.end : w.start;
      if (w.start < b && b < w.end) b = w.removed ? w.start : w.end;
    }
    if (b - a > 0.1) ranges.push({ a, b, hold: true });
  }
  ranges.sort((x, y) => x.a - y.a);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.a <= last.b + 0.04 && !r.sectionCut) last.b = Math.max(last.b, r.b);
    else merged.push({ ...r, a: last ? Math.max(r.a, last.b) : r.a }); // never overlap
  }
  // Safety net: no boundary may sit inside any word.
  for (const r of merged) {
    for (const w of words) {
      if (w.start < r.a && r.a < w.end) r.a = w.removed ? w.end : w.start;
      if (w.start < r.b && r.b < w.end) r.b = w.removed ? w.start : w.end;
    }
  }
  const segs = merged.filter((r) => r.b - r.a >= 0.05);
  let t = 0;
  const segments = segs.map((r) => {
    const s = { srcStart: round(r.a), srcEnd: round(r.b), outStart: round(t), outEnd: round(t + (r.b - r.a)), sectionCut: !!r.sectionCut };
    t += r.b - r.a;
    return s;
  });
  const speechDuration = round(t);

  // ---------- 3. source time → output time ----------
  const toOut = (src, edge = "start") => {
    for (let k = 0; k < segments.length; k++) {
      const s = segments[k];
      if (src >= s.srcStart && src <= s.srcEnd) return round(s.outStart + (src - s.srcStart));
      if (src < s.srcStart) return edge === "start" ? s.outStart : (k > 0 ? segments[k - 1].outEnd : 0);
    }
    return speechDuration;
  };
  for (const w of words) {
    if (w.removed) continue;
    w.outStart = toOut(w.start, "start");
    w.outEnd = toOut(w.end, "end");
  }
  // A removed word anchor resolves to the nearest kept word.
  const keptNear = (i, dir = 1) => {
    i = clampIdx(i);
    for (let k = i; k >= 0 && k < words.length; k += dir) if (!words[k].removed) return words[k];
    for (let k = i; k >= 0 && k < words.length; k -= dir) if (!words[k].removed) return words[k];
    return null;
  };
  const span = (from, to) => {
    const a = keptNear(from, 1), b = keptNear(to, -1);
    if (!a || !b) return null;
    const s = a.outStart, e = Math.max(b.outEnd, s + 0.3);
    return [round(s), round(Math.min(e, speechDuration))];
  };

  // ---------- 4. overlays ----------
  const sectionOut = sections.map((s, k) => {
    const w = keptNear(s.startWord, 1);
    return { title: s.title || "", showTitle: s.showTitle !== false && !!s.title, out: w ? (k === 0 ? 0 : segments.find((g) => g.srcEnd >= w.start)?.outStart ?? w.outStart) : 0 };
  });
  const transitions = segments.filter((s) => s.sectionCut).map((s) => ({ out: s.outStart, style: d.sectionTransition || "flash" }));

  const broll = [];
  if (F.broll) {
    for (const b of d.broll || []) {
      if (!b.file || !fs.existsSync(p(dir, b.file))) continue;
      const sp = span(b.fromWord, b.toWord);
      if (!sp) continue;
      const meta = (analysis.broll || []).find((x) => x.file === b.file) || {};
      const mediaStart = Number(b.mediaStart || 0);
      let end = sp[1];
      if (meta.type === "video" && meta.duration) end = Math.min(end, sp[0] + meta.duration - mediaStart);
      if (end - sp[0] >= 0.5) broll.push({ file: b.file, type: meta.type || (/\.(png|jpe?g|webp|gif)$/i.test(b.file) ? "image" : "video"), outStart: sp[0], outEnd: round(end), mediaStart });
    }
  }

  const zooms = [];
  if (F.zooms) {
    for (const z of d.zooms || []) {
      const sp = span(z.fromWord, z.toWord);
      if (sp) zooms.push({ outStart: sp[0], outEnd: sp[1], scale: Math.min(1.5, Math.max(1.03, Number(z.scale) || 1.15)), style: z.style === "push" ? "push" : "cut" });
    }
    zooms.sort((a, b) => a.outStart - b.outStart);
    for (let k = 1; k < zooms.length; k++) zooms[k].outStart = Math.max(zooms[k].outStart, zooms[k - 1].outEnd);
  }

  const sfx = [];
  if (F.sfx) {
    for (const s of d.sfx || []) {
      const w = keptNear(s.atWord, 1);
      if (w) sfx.push({ type: s.type || "pop", out: w.outStart });
    }
    for (const tr of transitions) sfx.push({ type: "whoosh", out: Math.max(0, round(tr.out - 0.15)) });
    for (const b of broll) sfx.push({ type: "whoosh", out: Math.max(0, round(b.outStart - 0.12)) });
    sfx.sort((a, b) => a.out - b.out);
    // Never stack two effects closer than 0.4 s.
    for (let k = sfx.length - 1; k > 0; k--) if (sfx[k].out - sfx[k - 1].out < 0.4) sfx.splice(k, 1);
  }

  // ---------- 5. captions (deterministic grouping) ----------
  const captions = [];
  if (F.captions) {
    const maxWords = settings.format === "16:9" ? 4 : 3;
    const maxChars = settings.format === "16:9" ? 26 : 16;
    let g = null;
    const kept = words.filter((w) => !w.removed);
    kept.forEach((w, k) => {
      const prev = kept[k - 1];
      const text = w.text.replace(/^[^\w']+/, "");
      const brk = !g || g.words.length >= maxWords || (g.chars + text.length > maxChars && g.words.length > 0) ||
        /[.!?,;:]$/.test(prev?.text || "") || (prev && w.outStart - prev.outEnd >= 0.15);
      if (brk) { g = { words: [], chars: 0 }; captions.push(g); }
      g.words.push({ i: w.i, text: w.text, outStart: w.outStart, outEnd: w.outEnd });
      g.chars += text.length + 1;
    });
    captions.forEach((c, k) => {
      c.outStart = round(Math.max(0.1, c.words[0].outStart - 0.05));
      const next = captions[k + 1];
      c.outEnd = round(Math.min(next ? next.words[0].outStart - 0.05 : speechDuration, c.words[c.words.length - 1].outEnd + 0.3));
      if (c.outEnd <= c.outStart) c.outEnd = round(c.outStart + 0.2);
      delete c.chars;
    });
  }

  // ---------- 6. CTA, music, colour ----------
  let cta = null;
  if (F.cta) {
    const c = d.cta || {};
    const title = c.title || settings.ctaText || "Follow for more";
    cta = { title, subtitle: c.subtitle || "", outStart: speechDuration, duration: Math.min(5, Math.max(1.5, Number(c.duration) || 2.5)) };
  }
  const duration = round(speechDuration + (cta ? cta.duration : 0));
  const musicFile = path.join(work, "music.mp3");
  const music = F.music && fs.existsSync(musicFile) ? { file: "work/music.mp3", volume: Number(d.music?.volume ?? 0.12) } : null;
  const colorFile = path.join(work, "color.json");
  const color = F.color && fs.existsSync(colorFile) ? readJSON(colorFile) : null;

  const edl = {
    version: 1, builtAt: new Date().toISOString(), format: settings.format, ...out, fps: 30,
    source: "work/edit_source.mp4", sourceDuration: total, sourceSize: { width: info.master.width, height: info.master.height },
    speechDuration, duration, removedSeconds: round(total - speechDuration),
    segments, sections: sectionOut, transitions, broll, zooms, sfx, captions, cta, music, color,
    words: words.map((w) => ({ i: w.i, text: w.text, start: w.start, end: w.end, removed: w.removed, reason: w.reason, outStart: w.outStart ?? null, outEnd: w.outEnd ?? null })),
  };
  writeJSON(p(dir, "edl.json"), edl);
  return edl;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = currentProjectDir();
  const e = buildEdl(dir);
  console.log(`EDL: ${e.segments.length} segments, ${e.sourceDuration.toFixed(1)}s → ${e.duration.toFixed(1)}s ` +
    `(${e.words.filter((w) => w.removed).length} words removed, ${e.broll.length} b-roll, ${e.zooms.length} zooms, ${e.sfx.length} sfx, ${e.captions.length} caption groups)`);
}
