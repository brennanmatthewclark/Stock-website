#!/usr/bin/env node
// 11 Second Edit — local server. Zero dependencies (Node 18+).
// Serves the browser app, accepts uploads, exposes project state, and runs deterministic
// scripts (rebuild after transcript edits, export render). Editorial decisions are made by Claude Code.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  workspaceDir, readJSON, writeJSON, readState, updateState, defaultSettings, enabledSteps,
  FEATURES, STEPS, ffprobe, SKILL_DIR, hyperframesArgs,
} from "../scripts/lib.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(APP_DIR, "public");
const SCRIPTS = path.join(SKILL_DIR, "scripts");
const WS = workspaceDir();
const args = process.argv.slice(2);
const wantPort = Number(args[args.indexOf("--port") + 1]) || Number(process.env.PORT) || 4111;
const noOpen = args.includes("--no-open");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4",
  ".mov": "video/quicktime", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".txt": "text/plain; charset=utf-8",
};

// ---------- project ----------
function newProject() {
  const id = "edit-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = path.join(WS, id);
  for (const d of ["source", "broll", "work", "renders"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  writeJSON(path.join(dir, "settings.json"), defaultSettings());
  writeJSON(path.join(dir, "state.json"), { status: "setup", steps: [], log: [] });
  writeJSON(path.join(WS, "current.json"), { dir, id });
  return dir;
}
function projectDir() {
  const ptr = path.join(WS, "current.json");
  if (fs.existsSync(ptr)) {
    const { dir } = readJSON(ptr);
    if (fs.existsSync(dir)) return dir;
  }
  return newProject();
}
const safeName = (n) => path.basename(String(n || "file")).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
const listFiles = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => !f.startsWith(".")) : []);

function snapshot() {
  const dir = projectDir();
  const settings = readJSON(path.join(dir, "settings.json"), defaultSettings());
  const state = readState(dir);
  const src = listFiles(path.join(dir, "source"))[0];
  let sourceInfo = null;
  if (src) sourceInfo = readJSON(path.join(dir, "work", "source_info.json"), null)?.originalInfo || null;
  const hb = readJSON(path.join(WS, "claude-waiting.json"), null);
  return {
    project: { id: path.basename(dir), dir },
    settings, state, features: FEATURES, steps: STEPS,
    source: src ? { name: src, url: `/files/source/${encodeURIComponent(src)}`, info: sourceInfo } : null,
    broll: listFiles(path.join(dir, "broll")).map((f) => ({ name: f, url: `/files/broll/${encodeURIComponent(f)}` })),
    hasEdl: fs.existsSync(path.join(dir, "edl.json")),
    edlBuiltAt: fs.existsSync(path.join(dir, "edl.json")) ? fs.statSync(path.join(dir, "edl.json")).mtimeMs : null,
    claudeWaiting: !!(hb && Date.now() - hb.t < 5000),
  };
}

// ---------- helpers ----------
function send(res, code, body, headers = {}) {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(code, { "Content-Type": isObj ? "application/json" : "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 5e6) reject(new Error("Body too large")); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
function serveFile(req, res, file, { download = false } = {}) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, "Not found");
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" };
  if (download) headers["Content-Disposition"] = `attachment; filename="${path.basename(file)}"`;
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    if (start >= size || start < 0) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    end = Math.min(end, size - 1);
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": size });
  fs.createReadStream(file).pipe(res);
}
function runScript(name, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, name), "--project", projectDir(), ...extra], { env: process.env });
    let err = "", out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || out || `${name} failed`))));
  });
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const route = `${req.method} ${url.pathname}`;
  const dir = projectDir();

  if (route === "GET /api/state") return send(res, 200, snapshot());

  if (route === "POST /api/new") { newProject(); return send(res, 200, snapshot()); }

  if (route === "POST /api/upload") {
    const kind = url.searchParams.get("kind") === "broll" ? "broll" : "source";
    if (readState(dir).status !== "setup" && kind === "source") return send(res, 409, { error: "Start a new edit to change the main video." });
    const target = path.join(dir, kind);
    fs.mkdirSync(target, { recursive: true });
    if (kind === "source") for (const f of listFiles(target)) { const fp = path.join(target, f); try { fs.chmodSync(fp, 0o644); } catch {} fs.rmSync(fp, { force: true }); }
    const file = path.join(target, safeName(url.searchParams.get("name")));
    const ws = fs.createWriteStream(file);
    req.pipe(ws);
    ws.on("finish", () => {
      let info = null;
      try { info = ffprobe(file); } catch {}
      if (kind === "source") {
        if (!info?.hasVideo) { fs.rmSync(file, { force: true }); return send(res, 400, { error: "That file doesn't look like a video FFmpeg can read." }); }
        try { fs.chmodSync(file, 0o444); } catch {}
        writeJSON(path.join(dir, "work", "source_info.json"), { original: path.relative(dir, file), originalInfo: info });
      }
      send(res, 200, { ok: true, name: path.basename(file), info });
    });
    ws.on("error", (e) => send(res, 500, { error: e.message }));
    return;
  }

  if (route === "DELETE /api/broll") {
    fs.rmSync(path.join(dir, "broll", safeName(url.searchParams.get("name"))), { force: true });
    return send(res, 200, snapshot());
  }

  if (route === "POST /api/settings") {
    const body = await readBody(req);
    const cur = readJSON(path.join(dir, "settings.json"), defaultSettings());
    writeJSON(path.join(dir, "settings.json"), { ...cur, ...body, features: { ...cur.features, ...(body.features || {}) } });
    return send(res, 200, snapshot());
  }

  if (route === "POST /api/edit") {
    const body = await readBody(req);
    if (!listFiles(path.join(dir, "source")).length) return send(res, 400, { error: "Upload a video first." });
    const cur = readJSON(path.join(dir, "settings.json"), defaultSettings());
    const settings = { ...cur, ...body, features: { ...cur.features, ...(body.features || {}) } };
    writeJSON(path.join(dir, "settings.json"), settings);
    updateState(dir, (s) => {
      s.status = "requested";
      s.requestedAt = new Date().toISOString();
      s.steps = enabledSteps(settings).map((st) => ({ id: st.id, label: st.label, status: "pending" }));
      s.log = [];
      s.error = null;
      s.export = null;
    });
    return send(res, 200, snapshot());
  }

  if (route === "GET /api/edl") {
    const f = path.join(dir, "edl.json");
    return fs.existsSync(f) ? send(res, 200, readJSON(f)) : send(res, 404, { error: "No edit yet" });
  }

  if (route === "GET /api/user-edits") return send(res, 200, readJSON(path.join(dir, "user-edits.json"), { cut: [], restore: [] }));

  if (route === "POST /api/edits") {
    const body = await readBody(req);
    const clean = (a) => [...new Set((a || []).map(Number).filter(Number.isInteger))].sort((x, y) => x - y);
    writeJSON(path.join(dir, "user-edits.json"), { cut: clean(body.cut), restore: clean(body.restore) });
    try {
      await runScript("rebuild.mjs");
      return send(res, 200, readJSON(path.join(dir, "edl.json")));
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (route === "POST /api/export") {
    const st = readState(dir);
    if (st.export?.status === "rendering") return send(res, 409, { error: "Already rendering" });
    updateState(dir, (s) => { s.export = { status: "rendering", progress: 0 }; });
    const child = spawn(process.execPath, [path.join(SCRIPTS, "render.mjs"), "--project", dir], { env: process.env, stdio: "ignore", detached: true });
    child.unref();
    return send(res, 200, snapshot());
  }

  if (route === "GET /api/download") {
    const rel = readState(dir).export?.file;
    if (!rel) return send(res, 404, "No render yet");
    return serveFile(req, res, path.join(dir, rel), { download: true });
  }

  if (route === "POST /api/studio") {
    const comp = path.join(dir, "composition");
    if (!fs.existsSync(path.join(comp, "index.html"))) return send(res, 400, { error: "No composition yet." });
    const port = 3002;
    const child = spawn("npx", hyperframesArgs("preview", comp, "--port", String(port), "--no-open", "--background"), { stdio: "ignore", detached: true, env: process.env });
    child.unref();
    return send(res, 200, { url: `http://localhost:${port}` });
  }

  if (req.method === "GET" && url.pathname.startsWith("/files/")) {
    const rel = decodeURIComponent(url.pathname.slice("/files/".length));
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep)) return send(res, 403, "Forbidden");
    return serveFile(req, res, file);
  }

  if (req.method === "GET") {
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden");
    return serveFile(req, res, file);
  }
  send(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: e.message }); });
});
server.requestTimeout = 0; // large uploads

function listen(port, attempts = 0) {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && attempts < 20) return listen(port + 1, attempts + 1);
    throw e;
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    projectDir();
    writeJSON(path.join(WS, "server.json"), { url, pid: process.pid, startedAt: new Date().toISOString() });
    console.log(`11 Second Edit running at ${url}`);
    console.log(`Workspace: ${WS}`);
    if (!noOpen) {
      const opener = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
      try { spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
    }
  });
}
listen(wantPort);
