// Deterministic: edl.json → composition/ (a HyperFrames project).
//   composition/index.html                 the whole edit as one HTML composition
//   composition/compositions/captions.html  word-by-word caption track
//   composition/assets/                     links to the working media (the original is never referenced)
import fs from "node:fs";
import path from "node:path";
import { currentProjectDir, p, readJSON, run, ffprobe, hyperframesArgs, HYPERFRAMES_VERSION } from "./lib.mjs";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (x) => Number(x.toFixed(3));

function linkAsset(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { force: true });
  try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
}

export function buildComposition(dir, { applyColor = true } = {}) {
  const edl = readJSON(p(dir, "edl.json"));
  const comp = p(dir, "composition");
  const assets = path.join(comp, "assets");
  fs.mkdirSync(path.join(comp, "compositions"), { recursive: true });
  fs.rmSync(assets, { recursive: true, force: true });
  fs.mkdirSync(assets, { recursive: true });

  const W = edl.width, H = edl.height, D = Math.max(0.5, edl.duration);
  const portrait = H > W;
  linkAsset(p(dir, edl.source), path.join(assets, "source.mp4"));

  const body = [];
  const tl = [];
  let lane = 0;

  // ---- footage: one trimmed clip per kept segment, inside an untimed stage that zooms ----
  body.push(`<div id="stage">`);
  edl.segments.forEach((s, k) => {
    body.push(`  <video id="seg-${k}" class="clip seg" src="assets/source.mp4" data-start="${n(s.outStart)}" data-duration="${n(s.outEnd - s.outStart)}" data-media-start="${n(s.srcStart)}" data-has-audio="true" data-track-index="${lane}" playsinline></video>`);
  });
  body.push(`</div>`);
  lane++;

  tl.push(`tl.set("#stage", { scale: 1, transformOrigin: "50% 38%" }, 0);`);
  for (const z of edl.zooms) {
    if (z.style === "push") tl.push(`tl.fromTo("#stage", { scale: 1 }, { scale: ${z.scale}, duration: ${n(Math.min(0.5, (z.outEnd - z.outStart) * 0.6))}, ease: "power2.out" }, ${n(z.outStart)});`);
    else tl.push(`tl.set("#stage", { scale: ${z.scale} }, ${n(z.outStart)});`);
    tl.push(`tl.set("#stage", { scale: 1 }, ${n(z.outEnd)});`);
  }

  // ---- b-roll ----
  let z = 10;
  edl.broll.forEach((b, k) => {
    const name = `broll-${k}${path.extname(b.file)}`;
    linkAsset(p(dir, b.file), path.join(assets, "broll", name));
    const dur = n(b.outEnd - b.outStart);
    if (b.type === "image") {
      body.push(`<div class="broll-wrap" id="bw-${k}" style="z-index:${z++}"><img id="broll-${k}" class="clip broll" src="assets/broll/${name}" data-start="${n(b.outStart)}" data-duration="${dur}" data-track-index="${lane}" alt=""></div>`);
      tl.push(`tl.fromTo("#bw-${k}", { scale: 1.0 }, { scale: 1.08, duration: ${dur}, ease: "none" }, ${n(b.outStart)});`);
    } else {
      body.push(`<div class="broll-wrap" id="bw-${k}" style="z-index:${z++}"><video id="broll-${k}" class="clip broll" src="assets/broll/${name}" data-start="${n(b.outStart)}" data-duration="${dur}" data-media-start="${n(b.mediaStart || 0)}" data-track-index="${lane}" muted playsinline></video></div>`);
    }
  });
  if (edl.broll.length) lane++;

  // ---- subject changes: flash + optional title pill ----
  edl.transitions.forEach((t, k) => {
    const start = n(Math.max(0, t.out - 0.04));
    body.push(`<div id="flash-${k}" class="clip flash" data-start="${start}" data-duration="0.3" data-track-index="${lane}" style="z-index:40"><div class="flash-fill" id="flash-${k}-fill"></div></div>`);
    tl.push(`tl.fromTo("#flash-${k}-fill", { opacity: 0.85 }, { opacity: 0, duration: 0.26, ease: "power2.out" }, ${start});`);
  });
  edl.sections.forEach((s, k) => {
    if (!s.showTitle) return;
    const start = n(s.out + 0.15), dur = 1.6;
    if (start + dur > edl.speechDuration) return;
    body.push(`<div id="stitle-${k}" class="clip section-title" data-start="${start}" data-duration="${dur}" data-track-index="${lane}" style="z-index:30"><div class="pill" id="stitle-${k}-pill">${esc(s.title)}</div></div>`);
    tl.push(`tl.fromTo("#stitle-${k}-pill", { y: -30, opacity: 0, scale: 0.9 }, { y: 0, opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)" }, ${start});`);
    tl.push(`tl.to("#stitle-${k}-pill", { opacity: 0, y: -20, duration: 0.2, ease: "power2.in" }, ${n(start + dur - 0.25)});`);
  });
  lane++;

  // ---- captions (sub-composition) ----
  if (edl.captions.length) {
    writeCaptions(path.join(comp, "compositions", "captions.html"), edl, W, H, portrait);
    body.push(`<div id="captions" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="${n(Math.max(0.5, edl.speechDuration))}" data-track-index="${lane++}" data-track-kind="captions" data-width="${W}" data-height="${H}" style="z-index:50"></div>`);
  } else {
    fs.rmSync(path.join(comp, "compositions", "captions.html"), { force: true });
  }

  // ---- call to action ----
  if (edl.cta) {
    const c = edl.cta, s = n(c.outStart);
    body.push(`<div id="cta" class="clip" data-start="${s}" data-duration="${n(c.duration)}" data-track-index="${lane++}" style="z-index:60">
  <div class="cta-bg" id="cta-bg"></div>
  <div class="cta-inner">
    <div class="cta-title" id="cta-title">${esc(c.title)}</div>
    ${c.subtitle ? `<div class="cta-sub" id="cta-sub">${esc(c.subtitle)}</div>` : ""}
    <div class="cta-btn" id="cta-btn">Follow ➜</div>
  </div>
</div>`);
    tl.push(`tl.fromTo("#cta-bg", { opacity: 0 }, { opacity: 1, duration: 0.25 }, ${s});`);
    tl.push(`tl.fromTo("#cta-title", { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: "power3.out" }, ${n(s + 0.1)});`);
    if (c.subtitle) tl.push(`tl.fromTo("#cta-sub", { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: "power3.out" }, ${n(s + 0.25)});`);
    tl.push(`tl.fromTo("#cta-btn", { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: "back.out(2.2)" }, ${n(s + 0.45)});`);
    tl.push(`tl.to("#cta-btn", { scale: 1.06, duration: 0.35, yoyo: true, repeat: ${Math.max(0, Math.floor((c.duration - 1) / 0.35) - 1)}, ease: "sine.inOut" }, ${n(s + 0.9)});`);
  }

  // ---- audio: music bed + sound effects ----
  if (edl.music) {
    linkAsset(p(dir, edl.music.file), path.join(assets, "music.mp3"));
    body.push(`<audio id="music" class="clip" src="assets/music.mp3" data-start="0" data-duration="${n(D)}" data-volume="${edl.music.volume}" data-fade-in="0.4" data-fade-out="1.5" data-track-index="${lane++}"></audio>`);
  }
  if (edl.sfx.length) {
    const durs = {};
    edl.sfx.forEach((s, k) => {
      const file = p(dir, "work", "sfx", `${s.type}.mp3`);
      if (!fs.existsSync(file)) return;
      if (!durs[s.type]) {
        linkAsset(file, path.join(assets, "sfx", `${s.type}.mp3`));
        try { durs[s.type] = ffprobe(file).duration; } catch { durs[s.type] = 0.6; }
      }
      const dur = n(Math.min(durs[s.type], D - s.out));
      if (dur > 0.02) body.push(`<audio id="sfx-${k}" class="clip" src="assets/sfx/${s.type}.mp3" data-start="${n(s.out)}" data-duration="${dur}" data-volume="0.45" data-track-index="${lane}"></audio>`);
    });
    lane++;
  }

  const html = `<!doctype html>
<html lang="en" data-resolution="${portrait ? "portrait" : "landscape"}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <!-- Generated by 11 Second Edit from edl.json. Re-generated on every edit: change the EDL, not this file. -->
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; font-family: "Montserrat", sans-serif; }
      #stage { position: absolute; inset: 0; overflow: hidden; z-index: 1; }
      #stage video { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; object-fit: cover; }
      .broll-wrap { position: absolute; inset: 0; overflow: hidden; }
      .broll { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; object-fit: cover; }
      .flash { position: absolute; inset: 0; }
      .flash-fill { position: absolute; inset: 0; background: #fff; opacity: 0; }
      .section-title { position: absolute; left: 0; right: 0; top: ${portrait ? 330 : 90}px; height: 160px; display: flex; justify-content: center; align-items: flex-start; }
      .pill { display: inline-block; padding: 18px 40px; border-radius: 999px; background: #FFE14D; color: #111; font-weight: 900; font-size: ${portrait ? 58 : 50}px; text-transform: uppercase; letter-spacing: 0.02em; box-shadow: 0 10px 40px rgba(0,0,0,.35); }
      #cta { position: absolute; inset: 0; }
      .cta-bg { position: absolute; inset: 0; background: radial-gradient(120% 80% at 50% 30%, #2b2bff 0%, #12124a 55%, #07071a 100%); }
      .cta-inner { position: absolute; left: ${portrait ? 120 : 240}px; right: ${portrait ? 200 : 240}px; top: 0; bottom: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 36px; text-align: center; }
      .cta-title { color: #fff; font-weight: 900; text-wrap: balance; font-size: ${portrait ? 96 : 88}px; line-height: 1.05; letter-spacing: -0.02em; }
      .cta-sub { color: #c9ccff; font-weight: 700; font-size: ${portrait ? 52 : 44}px; }
      .cta-btn { display: inline-block; padding: 26px 64px; border-radius: 999px; background: #FFE14D; color: #111; font-weight: 900; font-size: ${portrait ? 54 : 46}px; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${n(D)}" data-width="${W}" data-height="${H}" data-fps="30">
${body.map((l) => "      " + l).join("\n")}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${tl.join("\n      ")}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(comp, "index.html"), html);
  fs.writeFileSync(path.join(comp, "hyperframes.json"), JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } }, null, 2));
  fs.writeFileSync(path.join(comp, "meta.json"), JSON.stringify({ id: path.basename(dir), name: "11 Second Edit", createdAt: new Date().toISOString() }, null, 2));
  fs.writeFileSync(path.join(comp, "package.json"), JSON.stringify({ name: "11secondedit-composition", private: true, type: "module", scripts: { dev: `npx --yes hyperframes@${HYPERFRAMES_VERSION} preview`, check: `npx --yes hyperframes@${HYPERFRAMES_VERSION} check`, render: `npx --yes hyperframes@${HYPERFRAMES_VERSION} render` } }, null, 2));

  // ---- colour: non-destructive grade on every footage clip ----
  if (applyColor && edl.color?.grading && edl.segments.length) {
    const gradingFile = p(dir, "work", "color_grading.json");
    fs.writeFileSync(gradingFile, JSON.stringify(edl.color.grading));
    run("npx", hyperframesArgs("media-treatment", "--project", comp, "--selector", "video.seg", "--grading", gradingFile, "--apply", "--json"));
  }
  return { file: path.join(comp, "index.html"), duration: D };
}

function writeCaptions(file, edl, W, H, portrait) {
  const maxWidth = portrait ? 740 : 1600;
  const base = portrait ? 88 : 76;
  const groups = edl.captions.map((g, k) =>
    `    <div class="cg" id="cg-${k}">${g.words.map((w, j) => `<span class="cw" id="cw-${k}-${j}">${esc(w.text)}</span>`).join(" ")}</div>`).join("\n");
  const data = edl.captions.map((g) => ({ s: n(g.outStart), e: n(g.outEnd), w: g.words.map((w) => [n(w.outStart), n(w.outEnd)]), t: g.words.map((w) => w.text).join(" ") }));
  const html = `<template>
  <style>
    #root { position: absolute; inset: 0; overflow: visible; }
    .cg { position: absolute; left: 0; width: ${W}px; ${portrait ? "top: 1010px;" : "bottom: 110px;"} text-align: center; font-family: "Montserrat", sans-serif; font-weight: 900; text-transform: uppercase; color: #fff; line-height: 1.1; opacity: 0; visibility: hidden; overflow: visible; padding: ${portrait ? "0 220px 0 120px" : "0 160px"}; }
    .cw { display: inline-block; margin: 0 0.12em; -webkit-text-stroke: 10px #000; paint-order: stroke fill; text-shadow: 0 6px 24px rgba(0,0,0,.45); }
  </style>
  <div id="root" data-composition-id="captions" data-width="${W}" data-height="${H}">
${groups}
  </div>
  <script>
    (function () {
      const G = ${JSON.stringify(data)};
      const tl = gsap.timeline({ paused: true });
      const fit = window.__hyperframes && window.__hyperframes.fitTextFontSize;
      G.forEach(function (g, k) {
        const el = document.getElementById("cg-" + k);
        let size = ${base};
        if (fit) { try { size = Math.min(${base}, fit(g.t.toUpperCase(), { fontFamily: "Montserrat", fontWeight: 900, maxWidth: ${Math.round(maxWidth / 1.15)}, baseFontSize: ${base}, minFontSize: 44 }).fontSize); } catch (e) {} }
        el.style.fontSize = size + "px";
        tl.set(el, { visibility: "visible" }, g.s);
        tl.fromTo(el, { opacity: 0, scale: 0.86, y: 18 }, { opacity: 1, scale: 1, y: 0, duration: 0.12, ease: "back.out(2)" }, g.s);
        g.w.forEach(function (w, j) {
          const sp = document.getElementById("cw-" + k + "-" + j);
          tl.fromTo(sp, { color: "#ffffff", scale: 1 }, { color: "#FFE14D", scale: 1.15, duration: 0.08, ease: "power2.out" }, Math.max(g.s, w[0]));
          tl.to(sp, { color: "#ffffff", scale: 1, duration: 0.08, ease: "power2.in" }, Math.max(g.s + 0.08, Math.min(g.e - 0.1, w[1])));
        });
        tl.to(el, { opacity: 0, duration: 0.08, ease: "power2.in" }, g.e - 0.08);
        tl.set(el, { opacity: 0, visibility: "hidden" }, g.e);
      });
      window.__timelines["captions"] = tl;
    })();
  </script>
</template>
`;
  fs.writeFileSync(file, html);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = currentProjectDir();
  const r = buildComposition(dir, { applyColor: !process.argv.includes("--no-color") });
  console.log(`Composition: ${r.file} (${r.duration.toFixed(2)}s)`);
}
