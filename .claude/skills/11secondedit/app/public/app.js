// 11 Second Edit — browser app.
const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || res.statusText);
  return data;
};
const toast = (msg, ms = 2600) => { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); };
const fmt = (s) => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };

const FEATURE_HINTS = {
  enhance_audio: "Auphonic cleanup, leveling and loudness",
  bad_takes: "Claude finds restarts and flubbed lines",
  fillers: "um, uh, and other verbal filler",
  silences: "Tightens long pauses",
  sections: "Hard cut + title between each subject — e.g. every outfit",
  broll: "Uses the b-roll you added in step 2",
  zooms: "Punch-ins on key moments",
  color: "Balanced exposure, contrast and color",
  cta: "End card asking viewers to act",
  captions: "Bold captions, current word highlighted",
  music: "Instrumental bed from ElevenLabs",
  sfx: "Whooshes and pops on cuts",
};

let S = null;          // server snapshot
let view = null;
let edl = null;
let edlStamp = null;
let editing = false;

// ================= state polling & views =================
async function refresh() {
  try { S = await api("/api/state"); } catch { return; }
  const st = S.state.status;
  const next = st === "setup" ? "setup" : st === "requested" || st === "running" || st === "error" ? "progress" : "editor";
  $("#claudeStatus").textContent = S.claudeWaiting ? "Claude is ready" : st === "running" ? "Claude is editing" : "Claude: run /11secondedit";
  $("#claudeStatus").classList.toggle("on", S.claudeWaiting || st === "running");
  $("#newEdit").hidden = st === "setup";
  if (next !== view) { view = next; show(next); }
  if (view === "setup") renderSetup();
  if (view === "progress") renderProgress();
  if (view === "editor") {
    renderExport();
    // Claude (or a script) rebuilt the edit from the terminal: reload it.
    if (edl && S.edlBuiltAt && edlStamp && S.edlBuiltAt !== edlStamp && !editing) { edlStamp = S.edlBuiltAt; loadEditor(); }
  }
}
function show(name) {
  for (const v of ["Setup", "Progress", "Editor"]) $(`#view${v}`).hidden = v.toLowerCase() !== name;
  if (name === "setup") initSetup();
  if (name === "editor") loadEditor();
}
setInterval(refresh, 1000);
refresh();

$("#newEdit").onclick = async () => {
  if (!confirm("Start a new edit? The current project stays saved in the workspace folder.")) return;
  edl = null; await api("/api/new", { method: "POST" }); view = null; refresh();
};

// ================= SETUP =================
let setupReady = false;
function initSetup() {
  if (setupReady) return;
  setupReady = true;
  const list = $("#featureList");
  list.innerHTML = "";
  for (const f of S.features) {
    const row = document.createElement("div");
    row.className = "feature";
    const extra = f.id === "cta" ? `<input type="text" id="ctaText" placeholder="CTA text (optional) — e.g. Follow for part 2" />`
      : f.id === "music" ? `<input type="text" id="musicVibe" placeholder="Music vibe (optional) — e.g. chill lo-fi, upbeat pop" />` : "";
    row.innerHTML = `<div style="flex:1"><div class="label">${f.label}</div><div class="sub">${FEATURE_HINTS[f.id] || ""}</div>${extra}</div>
      <label class="switch"><input type="checkbox" data-f="${f.id}" ${S.settings.features[f.id] ? "checked" : ""}/><span></span></label>`;
    list.appendChild(row);
  }
  list.querySelectorAll("input[data-f]").forEach((el) => (el.onchange = () => { syncExtras(); saveSettings(); }));
  $("#ctaText").value = S.settings.ctaText || "";
  $("#musicVibe").value = S.settings.musicVibe || "";
  $("#notes").value = S.settings.notes || "";
  for (const id of ["ctaText", "musicVibe", "notes"]) $("#" + id).oninput = () => saveSettingsSoon();
  document.querySelectorAll("#formatSeg button").forEach((b) => (b.onclick = () => { S.settings.format = b.dataset.format; renderFormat(); saveSettings(); }));
  renderFormat();
  syncExtras();
  wireDrop($("#dropMain"), $("#fileMain"), (files) => upload(files[0], "source"));
  wireDrop($("#dropBroll"), $("#fileBroll"), async (files) => { for (const f of files) await upload(f, "broll"); });
  $("#editBtn").onclick = startEdit;
}
function renderFormat() { document.querySelectorAll("#formatSeg button").forEach((b) => b.classList.toggle("active", b.dataset.format === S.settings.format)); }
function syncExtras() {
  const f = collectFeatures();
  $("#ctaText").hidden = !f.cta;
  $("#musicVibe").hidden = !f.music;
}
function collectFeatures() { const o = {}; document.querySelectorAll("#featureList input[data-f]").forEach((el) => (o[el.dataset.f] = el.checked)); return o; }
function collectSettings() { return { features: collectFeatures(), format: S.settings.format, ctaText: $("#ctaText").value.trim(), musicVibe: $("#musicVibe").value.trim(), notes: $("#notes").value.trim() }; }
async function saveSettings() { try { await api("/api/settings", { method: "POST", body: collectSettings() }); } catch (e) { toast(e.message); } }
function saveSettingsSoon() { clearTimeout(saveSettingsSoon.t); saveSettingsSoon.t = setTimeout(saveSettings, 500); }

let lastSourceName = null;
let lastBrollKey = null;
function renderSetup() {
  const src = S.source;
  const filled = $("#dropMain .drop-filled"), empty = $("#dropMain .drop-empty");
  filled.hidden = !src; empty.hidden = !!src;
  if (src && src.name !== lastSourceName) {
    lastSourceName = src.name;
    $("#mainPreview").src = src.url + "#t=0.5";
    $("#mainName").textContent = src.name;
    const i = src.info;
    $("#mainMeta").textContent = i ? `${i.width}×${i.height} · ${fmt(i.duration)} · ${i.hasAudio ? "audio" : "no audio"}` : "";
  }
  const key = S.broll.map((b) => b.name).join("|");
  if (key !== lastBrollKey) {
    lastBrollKey = key;
    $("#brollList").innerHTML = S.broll.map((b) => {
      const isImg = /\.(png|jpe?g|webp|gif)$/i.test(b.name);
      const media = isImg ? `<img src="${b.url}" alt="">` : `<video src="${b.url}#t=0.5" muted preload="metadata"></video>`;
      return `<div class="broll-item">${media}<button title="Remove" data-rm="${encodeURIComponent(b.name)}">×</button><div class="name">${b.name}</div></div>`;
    }).join("");
    $("#brollList").querySelectorAll("[data-rm]").forEach((b) => (b.onclick = async () => { await api(`/api/broll?name=${b.dataset.rm}`, { method: "DELETE" }); refresh(); }));
  }
  $("#editBtn").disabled = !src;
  $("#editHint").textContent = !src ? "Upload a video to continue." : S.claudeWaiting ? "Claude Code is connected and ready." : "Keep the Claude Code session that ran /11secondedit open — it picks up the job.";
}
function wireDrop(zone, input, onFiles) {
  input.onchange = () => input.files.length && onFiles([...input.files]);
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add("over"); };
  zone.ondragleave = () => zone.classList.remove("over");
  zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove("over"); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); };
}
function upload(file, kind) {
  const zone = kind === "source" ? $("#dropMain") : $("#dropBroll");
  const prog = zone.querySelector(".progress"), bar = prog.querySelector(".bar");
  prog.hidden = false; bar.style.width = "0%";
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?kind=${kind}&name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && (bar.style.width = `${(e.loaded / e.total) * 100}%`);
    xhr.onload = () => {
      prog.hidden = true;
      if (xhr.status >= 400) { try { toast(JSON.parse(xhr.responseText).error); } catch { toast("Upload failed"); } }
      refresh(); resolve();
    };
    xhr.onerror = () => { prog.hidden = true; toast("Upload failed"); resolve(); };
    xhr.send(file);
  });
}
async function startEdit() {
  $("#editBtn").disabled = true;
  try { await api("/api/edit", { method: "POST", body: collectSettings() }); refresh(); }
  catch (e) { toast(e.message); $("#editBtn").disabled = false; }
}

// ================= PROGRESS =================
function renderProgress() {
  const st = S.state;
  const ol = $("#checklist");
  ol.innerHTML = st.steps.map((s) => `<li class="${s.status}"><span class="dot"></span><div><div class="lbl">${s.label}</div>${s.detail ? `<div class="detail">${escapeHtml(s.detail)}</div>` : ""}</div></li>`).join("");
  const waiting = st.status === "requested";
  $("#progressTitle").textContent = st.status === "error" ? "Something went wrong" : waiting ? "Waiting for Claude Code…" : "Editing your video…";
  $("#progressSub").textContent = waiting
    ? (S.claudeWaiting ? "Claude is picking up the job…" : "Go back to your Claude Code session — it starts as soon as /11secondedit is waiting. (Or type /11secondedit again.)")
    : st.status === "error" ? "" : "Claude Code is working through each step. You can leave this tab open.";
  $("#progressError").hidden = !st.error;
  $("#progressError").textContent = st.error || "";
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ================= EDITOR =================
const P = {
  playing: false, out: 0, segIdx: 0, inCta: false, ctaClock: 0, lastSfx: -1,
  sfxAudio: {}, music: new Audio(), brollEls: [], scale: 1,
};
let userEdits = { cut: [], restore: [] };
const undoStack = [];

async function loadEditor() {
  try { edl = await api("/api/edl"); } catch { return; }
  try { userEdits = await api("/api/user-edits"); } catch {}
  edlStamp = S.edlBuiltAt;
  $("#pvMain").src = `/files/${edl.source}`;
  setupEditor();
}

function setupEditor() {
  const W = edl.width, H = edl.height;
  // Fit the W×H design canvas into the available space.
  const maxH = Math.min(window.innerHeight - 330, 760);
  const maxW = Math.min($(".player-col").clientWidth || 600, 900);
  P.scale = Math.min(maxW / W, Math.max(260, maxH) / H);
  const frame = $("#frame");
  frame.style.width = `${W * P.scale}px`;
  frame.style.height = `${H * P.scale}px`;
  const c = $("#canvas");
  c.style.width = `${W}px`; c.style.height = `${H}px`; c.style.transform = `scale(${P.scale})`;
  const portrait = H > W;

  // colour approximation for the live preview (the export uses HyperFrames' real grade)
  const a = edl.color?.grading?.adjust || {};
  $("#pvMain").style.filter = edl.color ? `brightness(${1 + (a.exposure || 0) * 0.5}) contrast(${1 + (a.contrast || 0)}) saturate(${1 + (a.vibrance || 0) + (a.saturation || 0)})` : "";

  // b-roll layers
  const layer = $("#pvBroll");
  layer.innerHTML = "";
  P.brollEls = edl.broll.map((b) => {
    const el = document.createElement(b.type === "image" ? "img" : "video");
    el.src = `/files/${b.file}`;
    if (b.type !== "image") { el.muted = true; el.playsInline = true; el.preload = "auto"; }
    el.style.display = "none";
    layer.appendChild(el);
    return el;
  });

  // title pill, captions, CTA geometry (mirrors the composition)
  const t = $("#pvTitle"); t.style.top = `${portrait ? 330 : 90}px`; t.querySelector("span").style.fontSize = `${portrait ? 58 : 50}px`;
  const cap = $("#pvCaption");
  cap.style.width = `${W}px`;
  cap.style.padding = portrait ? "0 220px 0 120px" : "0 160px";
  if (portrait) { cap.style.top = "1010px"; cap.style.bottom = ""; } else { cap.style.bottom = "110px"; cap.style.top = ""; }
  const ci = $("#pvCta .cta-inner"); ci.style.left = `${portrait ? 120 : 240}px`; ci.style.right = `${portrait ? 200 : 240}px`;
  $("#pvCta .cta-title").style.fontSize = `${portrait ? 96 : 88}px`;
  $("#pvCta .cta-sub").style.fontSize = `${portrait ? 52 : 44}px`;
  $("#pvCta .cta-btn").style.fontSize = `${portrait ? 54 : 46}px`;
  if (edl.cta) { $("#pvCta .cta-title").textContent = edl.cta.title; $("#pvCta .cta-sub").textContent = edl.cta.subtitle || ""; }

  // audio
  if (edl.music) { P.music.src = `/files/${edl.music.file}`; P.music.preload = "auto"; } else P.music.removeAttribute("src");
  for (const type of new Set(edl.sfx.map((s) => s.type))) {
    if (!P.sfxAudio[type]) { const au = new Audio(`/files/work/sfx/${type}.mp3`); au.preload = "auto"; P.sfxAudio[type] = au; }
  }

  renderTranscript();
  renderTimeline();
  renderStats();
  seek(Math.min(P.out, edl.duration - 0.01));
}

// ---------- playback engine (virtual cut list over the working copy) ----------
const segAt = (out) => edl.segments.findIndex((s) => out >= s.outStart && out < s.outEnd);
function seek(out) {
  out = Math.max(0, Math.min(edl.duration - 0.001, out));
  P.out = out;
  const k = segAt(out);
  P.inCta = k === -1;
  if (!P.inCta) { P.segIdx = k; const s = edl.segments[k]; $("#pvMain").currentTime = s.srcStart + (out - s.outStart); }
  else { P.ctaClock = performance.now() - (out - edl.speechDuration) * 1000; $("#pvMain").pause(); }
  P.lastSfx = out;
  syncMusic(true);
  drawOverlays();
}
function play() {
  if (!edl) return;
  if (P.out >= edl.duration - 0.05) seek(0);
  P.playing = true;
  $("#playBtn").textContent = "❚❚"; $("#bigPlay").hidden = true;
  if (!P.inCta) $("#pvMain").play().catch(() => {});
  syncMusic(true);
  tick();
}
function pause() {
  P.playing = false;
  $("#playBtn").textContent = "▶"; $("#bigPlay").hidden = false;
  $("#pvMain").pause(); P.music.pause();
  P.brollEls.forEach((el) => el.pause && el.pause());
}
function syncMusic(force) {
  if (!edl?.music || $("#muteMusic").checked) { P.music.pause(); return; }
  P.music.volume = Math.min(1, edl.music.volume * 2.2);
  if (force || Math.abs(P.music.currentTime - P.out) > 0.3) P.music.currentTime = P.out;
  if (P.playing && P.music.paused) P.music.play().catch(() => {});
  if (!P.playing) P.music.pause();
}
function tick() {
  if (!P.playing) return;
  const v = $("#pvMain");
  if (!P.inCta) {
    const s = edl.segments[P.segIdx];
    if (v.currentTime >= s.srcEnd - 0.03) {
      const next = edl.segments[P.segIdx + 1];
      if (next) { P.segIdx++; v.currentTime = next.srcStart; P.out = next.outStart; }
      else if (edl.cta) { P.inCta = true; v.pause(); P.out = edl.speechDuration; P.ctaClock = performance.now(); }
      else { P.out = edl.duration; pause(); drawOverlays(); return; }
    } else {
      P.out = s.outStart + Math.max(0, v.currentTime - s.srcStart);
    }
  } else {
    P.out = edl.speechDuration + (performance.now() - P.ctaClock) / 1000;
    if (P.out >= edl.duration) { P.out = edl.duration; pause(); drawOverlays(); return; }
  }
  // sound effects crossing the playhead
  for (const s of edl.sfx) if (s.out > P.lastSfx && s.out <= P.out) { const au = P.sfxAudio[s.type]; if (au) { au.currentTime = 0; au.volume = 0.6; au.play().catch(() => {}); } }
  P.lastSfx = P.out;
  syncMusic(false);
  drawOverlays();
  requestAnimationFrame(tick);
}
function drawOverlays() {
  const t = P.out;
  // zoom
  const z = edl.zooms.find((z) => t >= z.outStart && t < z.outEnd);
  let scale = 1;
  if (z) scale = z.style === "push" ? 1 + (z.scale - 1) * Math.min(1, (t - z.outStart) / 0.4) : z.scale;
  $("#pvStage").style.transform = `scale(${scale})`;
  // b-roll
  edl.broll.forEach((b, k) => {
    const el = P.brollEls[k], on = t >= b.outStart && t < b.outEnd;
    el.style.display = on ? "block" : "none";
    if (b.type === "image") { if (on) el.style.transform = `scale(${1 + 0.08 * (t - b.outStart) / (b.outEnd - b.outStart)})`; return; }
    if (on) {
      const want = (b.mediaStart || 0) + (t - b.outStart);
      if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want;
      if (P.playing && el.paused) el.play().catch(() => {});
      if (!P.playing) el.pause();
    } else if (!el.paused) el.pause();
  });
  // flash on subject change
  const fl = edl.transitions.find((x) => t >= x.out - 0.04 && t < x.out + 0.26);
  $("#pvFlash").style.opacity = fl ? String(0.85 * (1 - (t - (fl.out - 0.04)) / 0.3)) : "0";
  // section title
  const sec = edl.sections.find((s) => s.showTitle && t >= s.out + 0.15 && t < s.out + 1.75);
  const tt = $("#pvTitle");
  tt.style.opacity = sec ? "1" : "0";
  if (sec) tt.querySelector("span").textContent = sec.title;
  // captions
  const cap = $("#pvCaption");
  const g = edl.captions.find((g) => t >= g.outStart && t < g.outEnd);
  if (!g) { cap.innerHTML = ""; cap.dataset.g = ""; }
  else {
    const key = `${g.outStart}`;
    if (cap.dataset.g !== key) {
      cap.dataset.g = key;
      const portrait = edl.height > edl.width;
      const chars = g.words.reduce((n, w) => n + w.text.length + 1, 0);
      const base = portrait ? 88 : 76, maxW = portrait ? 740 : 1600;
      cap.style.fontSize = `${Math.max(44, Math.min(base, Math.floor((maxW / 1.15) / (chars * 0.72))))}px`;
      cap.innerHTML = g.words.map((w) => `<span>${escapeHtml(w.text)}</span>`).join(" ");
    }
    [...cap.children].forEach((sp, j) => { const w = g.words[j]; sp.classList.toggle("on", t >= w.outStart && t < Math.max(w.outEnd, w.outStart + 0.08)); });
  }
  // CTA
  $("#pvCta").style.opacity = edl.cta && t >= edl.cta.outStart ? "1" : "0";
  // UI
  $("#timeLabel").textContent = `${fmt(t)} / ${fmt(edl.duration)}`;
  const track = $("#tlRows .tl-track");
  if (track) $("#playhead").style.left = `${track.offsetLeft + (t / edl.duration) * track.clientWidth}px`;
  highlightWord(t);
}

$("#playBtn").onclick = () => (P.playing ? pause() : play());
$("#bigPlay").onclick = play;
$("#frame").addEventListener("click", (e) => { if (e.target.id !== "bigPlay") P.playing ? pause() : play(); });
$("#muteMusic").onchange = () => syncMusic(true);
document.addEventListener("keydown", (e) => {
  if (view !== "editor" || e.target.closest("input,textarea")) return;
  if (e.code === "Space" && !e.target.closest(".transcript")) { e.preventDefault(); P.playing ? pause() : play(); }
  if ((e.key === "Delete" || e.key === "Backspace") && selectedWordIds().length) { e.preventDefault(); cutSelection(); }
  if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); undo(); }
});
window.addEventListener("resize", () => edl && view === "editor" && setupEditor());

// ---------- transcript ----------
function renderTranscript() {
  const box = $("#transcript");
  const sectionAt = new Map();
  for (const s of edl.sections) {
    const w = edl.words.find((w) => !w.removed && w.outStart !== null && w.outStart >= s.out - 0.001);
    if (w && s.title) sectionAt.set(w.i, s.title);
  }
  let html = "";
  edl.words.forEach((w, k) => {
    if (sectionAt.has(w.i)) html += `<span class="sec">${escapeHtml(sectionAt.get(w.i))}</span>`;
    const prev = edl.words[k - 1];
    if (prev && w.start - prev.end >= 0.6) html += `<span class="pause"> ⟨${(w.start - prev.end).toFixed(1)}s⟩ </span>`;
    const cls = ["w", w.removed ? "removed" : "", w.reason === "filler" ? "filler" : ""].join(" ");
    html += `<span class="${cls}" data-i="${w.i}" title="${w.removed ? "Cut: " + escapeHtml(w.reason || "") + " — click to restore" : fmt(w.outStart)}">${escapeHtml(w.text)}</span> `;
  });
  box.innerHTML = html;
}
$("#transcript").addEventListener("click", (e) => {
  const sp = e.target.closest(".w");
  if (!sp || !window.getSelection().isCollapsed) return;
  const w = edl.words[Number(sp.dataset.i)];
  if (w.removed) applyEdit([], [w.i]);
  else { seek(w.outStart); }
});
document.addEventListener("selectionchange", () => { $("#cutBtn").disabled = !selectedWordIds().length; });
function selectedWordIds() {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return [];
  const range = sel.getRangeAt(0);
  if (!$("#transcript").contains(range.commonAncestorContainer)) return [];
  return [...$("#transcript").querySelectorAll(".w")].filter((el) => range.intersectsNode(el) && !el.classList.contains("removed")).map((el) => Number(el.dataset.i));
}
function cutSelection() {
  const ids = selectedWordIds();
  if (!ids.length) return;
  window.getSelection().removeAllRanges();
  applyEdit(ids, []);
}
$("#cutBtn").onclick = cutSelection;
$("#undoBtn").onclick = undo;
async function applyEdit(cut, restore) {
  undoStack.push(JSON.parse(JSON.stringify(userEdits)));
  const c = new Set(userEdits.cut), r = new Set(userEdits.restore);
  for (const i of cut) { c.add(i); r.delete(i); }
  for (const i of restore) { if (c.has(i)) c.delete(i); else r.add(i); }
  await pushEdits({ cut: [...c], restore: [...r] }, cut.length ? `Cut ${cut.length} word${cut.length > 1 ? "s" : ""}` : "Restored");
}
async function undo() { if (undoStack.length) await pushEdits(undoStack.pop(), "Undone"); }
async function pushEdits(next, msg) {
  const keep = P.out;
  pause();
  toast("Updating edit…", 10000);
  editing = true;
  try {
    userEdits = next;
    edl = await api("/api/edits", { method: "POST", body: userEdits });
    edlStamp = (await api("/api/state")).edlBuiltAt;
    P.out = Math.min(keep, edl.duration - 0.01);
    setupEditor();
    toast(msg);
  } catch (e) { toast("Edit failed: " + e.message, 5000); }
  editing = false;
  $("#undoBtn").disabled = !undoStack.length;
}
let lastHi = null;
function highlightWord(t) {
  const w = edl.words.find((w) => !w.removed && t >= w.outStart && t < w.outEnd);
  const el = w ? $(`#transcript .w[data-i="${w.i}"]`) : null;
  if (el === lastHi) return;
  lastHi?.classList.remove("now");
  el?.classList.add("now");
  if (el && P.playing) {
    const box = $("#transcript"), top = el.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 40) box.scrollTop = top - 60;
  }
  lastHi = el;
}

// ---------- timeline ----------
function renderTimeline() {
  const D = edl.duration;
  const pct = (a, b) => `left:${(a / D) * 100}%;width:${Math.max(0.15, ((b - a) / D) * 100)}%`;
  const row = (label, inner, cls = "") => `<div class="tl-row ${cls}"><div class="lbl">${label}</div><div class="tl-track">${inner}</div></div>`;
  const rows = [];
  rows.push(row("Video", edl.segments.map((s, k) => `<div class="tl-clip seg ${k % 2 ? "alt" : ""}" style="${pct(s.outStart, s.outEnd)}" title="${fmt(s.srcStart)}–${fmt(s.srcEnd)} of original"></div>`).join("") +
    edl.transitions.map((t) => `<div class="tl-mark" style="left:${(t.out / D) * 100}%"></div>`).join("") +
    (edl.cta ? `<div class="tl-clip cta" style="${pct(edl.cta.outStart, D)}">CTA</div>` : ""), "main"));
  if (edl.broll.length) rows.push(row("B-roll", edl.broll.map((b) => `<div class="tl-clip broll" style="${pct(b.outStart, b.outEnd)}" title="${escapeHtml(b.file)}">${escapeHtml(b.file.split("/").pop())}</div>`).join("")));
  if (edl.zooms.length) rows.push(row("Zoom", edl.zooms.map((z) => `<div class="tl-clip zoom" style="${pct(z.outStart, z.outEnd)}">${z.scale.toFixed(2)}×</div>`).join("")));
  if (edl.captions.length) rows.push(row("Captions", edl.captions.map((c) => `<div class="tl-clip cap" style="${pct(c.outStart, c.outEnd)}" title="${escapeHtml(c.words.map((w) => w.text).join(" "))}"></div>`).join("")));
  if (edl.sfx.length) rows.push(row("SFX", edl.sfx.map((s) => `<div class="tl-tick" style="left:${(s.out / D) * 100}%" title="${s.type}"></div>`).join("")));
  if (edl.music) rows.push(row("Music", `<div class="tl-clip music" style="${pct(0, D)}">music</div>`));
  $("#tlRows").innerHTML = rows.join("");
}
$("#timeline").addEventListener("pointerdown", (e) => {
  const track = $("#tlRows .tl-track");
  if (!track) return;
  const go = (ev) => { const r = track.getBoundingClientRect(); seek(((ev.clientX - r.left) / r.width) * edl.duration); };
  go(e);
  const move = (ev) => go(ev);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", () => window.removeEventListener("pointermove", move), { once: true });
});

function renderStats() {
  const removed = edl.words.filter((w) => w.removed);
  const by = {};
  for (const w of removed) { const k = (w.reason || "").split(":")[0]; by[k] = (by[k] || 0) + 1; }
  $("#stats").innerHTML = `<b>${fmt(edl.sourceDuration)}</b> → <b>${fmt(edl.duration)}</b> · ${edl.segments.length} cuts · ${removed.length} words removed` +
    (Object.keys(by).length ? `<br>${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(" · ")}` : "");
}

// ---------- export ----------
$("#exportBtn").onclick = async () => { try { await api("/api/export", { method: "POST" }); refresh(); } catch (e) { toast(e.message); } };
$("#studioBtn").onclick = async () => {
  try { const r = await api("/api/studio", { method: "POST" }); toast("Starting HyperFrames Studio…"); setTimeout(() => window.open(r.url, "_blank"), 3500); }
  catch (e) { toast(e.message); }
};
function renderExport() {
  const ex = S.state.export;
  const busy = ex?.status === "rendering";
  $("#exportBtn").disabled = busy;
  $("#exportBtn").textContent = busy ? "Rendering…" : ex?.status === "done" ? "Export again" : "Export MP4";
  $("#exportProgress").hidden = !busy;
  $("#exportProgress .bar").style.width = `${ex?.progress || 0}%`;
  $("#exportStatus").textContent = busy ? `Rendering with HyperFrames… ${Math.round(ex.progress || 0)}%` : ex?.status === "error" ? `Render failed: ${ex.error?.split("\n").slice(-3).join(" ")}` : ex?.status === "done" ? `Saved to ${ex.file}` : "";
  const dl = $("#downloadLink");
  dl.hidden = ex?.status !== "done";
  if (ex?.status === "done") dl.href = `/api/download?f=${encodeURIComponent(ex.file)}`;
}
