#!/usr/bin/env node
/**
 * Local Web App for SCA Digital Scorebook + PlayCricket CSV Sync
 *
 * Usage:
 *   npm start
 *   node scripts/local-server.mjs [--port 3456] [--open]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const PORT = (portIdx >= 0 && parseInt(argv[portIdx + 1], 10)) || 3456;
const AUTO_OPEN = argv.includes('--open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

let activeChild = null;

function slugify(str, fallback = 'unknown') {
  const s = String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

function deriveLibrarySeason(seasonStr) {
  const m = String(seasonStr || '').match(/(\d{4})\s*[\/\-]\s*(\d{2,4})/);
  if (m) return `${m[1]}-${m[2].slice(-2)}`;
  return slugify(seasonStr, 'season');
}

const SYNC_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PlayCricket Sync — SCA Scorebook</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f1f5f9;
    color: #0f172a;
  }
  header {
    background: #1e293b;
    color: #fff;
    padding: 12px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; }
  header a {
    color: #e2e8f0;
    text-decoration: none;
    background: #334155;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12.5px;
    font-weight: 600;
  }
  header a:hover { background: #475569; }
  main {
    max-width: 820px;
    margin: 24px auto;
    padding: 0 16px 40px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .card {
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    padding: 18px 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  .card h2 {
    margin: 0 0 12px;
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: #334155;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .full { grid-column: 1 / -1; }
  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #334155;
    margin-bottom: 4px;
  }
  input[type="text"] {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    font-size: 13px;
  }
  input[type="text"]:focus {
    outline: none;
    border-color: #2563eb;
    box-shadow: 0 0 0 2px rgba(37,99,235,0.15);
  }
  .checks {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
    margin-top: 10px;
    font-size: 12.5px;
    color: #334155;
  }
  .checks label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
    margin: 0;
    cursor: pointer;
  }
  .btn-row {
    display: flex;
    gap: 10px;
    margin-top: 14px;
    align-items: center;
  }
  button {
    border: none;
    border-radius: 6px;
    padding: 9px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .btn-primary { background: #2563eb; color: #fff; }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-primary:disabled { background: #94a3b8; cursor: not-allowed; }
  .btn-danger { background: #dc2626; color: #fff; }
  .btn-danger:hover { background: #b91c1c; }
  .btn-danger:disabled { background: #cbd5e1; color: #64748b; cursor: not-allowed; }
  .status-pill {
    font-size: 12px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 999px;
    background: #e2e8f0;
    color: #334155;
  }
  .status-pill.running { background: #dbeafe; color: #1d4ed8; }
  .status-pill.ok { background: #dcfce7; color: #15803d; }
  .status-pill.err { background: #fee2e2; color: #b91c1c; }
  pre#log {
    margin: 0;
    background: #0f172a;
    color: #e2e8f0;
    padding: 14px;
    border-radius: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.5;
    min-height: 240px;
    max-height: 460px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .hint { font-size: 11.5px; color: #64748b; margin-top: 4px; }
</style>
</head>
<body>
<header>
  <h1>PlayCricket Ball-by-Ball Sync</h1>
  <a href="/">← Back to Scorebook</a>
</header>
<main>
  <form id="syncForm" class="card">
    <h2>Download &amp; Import to Match Library</h2>
    <div class="grid">
      <div class="full">
        <label for="org">Association / Club (PlayCricket Organisation)</label>
        <input type="text" id="org" required value="North Shore Junior Cricket Association - Rep Teams" placeholder="e.g. North Shore Junior Cricket Association - Rep Teams">
      </div>
      <div>
        <label for="season">PlayCricket Season</label>
        <input type="text" id="season" required value="Summer 2026/27" placeholder="e.g. Summer 2026/27">
      </div>
      <div>
        <label for="gradeOrTeam">Grade or Team Name</label>
        <input type="text" id="gradeOrTeam" required value="North Shore U13/1" placeholder="e.g. North Shore U13/1">
      </div>
      <div>
        <label for="comp">Competition Label (optional)</label>
        <input type="text" id="comp" value="NSJCA Rep Teams" placeholder="e.g. NSJCA Rep Teams">
      </div>
      <div>
        <label for="librarySeason">Library Season Folder (optional)</label>
        <input type="text" id="librarySeason" value="" placeholder="Auto-derived (e.g. 2026-27)">
      </div>
    </div>
    <div class="checks">
      <label><input type="checkbox" id="importToLibrary" checked> Auto-import downloaded CSVs into Match Library (<code>data/seasons/</code>)</label>
      <label><input type="checkbox" id="listOnly"> Dry run (list matches only)</label>
      <label><input type="checkbox" id="overwrite"> Re-download existing CSVs</label>
    </div>
    <div class="btn-row">
      <button type="submit" id="btnRun" class="btn-primary">Run Sync</button>
      <button type="button" id="btnStop" class="btn-danger" disabled>Stop</button>
      <span id="statusPill" class="status-pill">Idle</span>
    </div>
    <div class="hint">After importing, refresh the Match Library in the Scorebook (and commit/push <code>data/</code> when you want them live on GitHub Pages).</div>
  </form>

  <div class="card">
    <h2>Live Output</h2>
    <pre id="log">Ready. Fill in Organisation, Season, and Grade/Team above and click "Run Sync".</pre>
  </div>
</main>
<script>
  const form = document.getElementById('syncForm');
  const logEl = document.getElementById('log');
  const btnRun = document.getElementById('btnRun');
  const btnStop = document.getElementById('btnStop');
  const pill = document.getElementById('statusPill');

  function setPill(text, cls) {
    pill.textContent = text;
    pill.className = 'status-pill' + (cls ? ' ' + cls : '');
  }

  function appendLog(txt) {
    logEl.textContent += txt;
    logEl.scrollTop = logEl.scrollHeight;
  }

  btnStop.addEventListener('click', async () => {
    await fetch('/api/stop', { method: 'POST' });
    appendLog('\\n[Stopped by user]\\n');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    logEl.textContent = '';
    btnRun.disabled = true;
    btnStop.disabled = false;
    setPill('Running...', 'running');

    const payload = {
      org: document.getElementById('org').value.trim(),
      season: document.getElementById('season').value.trim(),
      gradeOrTeam: document.getElementById('gradeOrTeam').value.trim(),
      comp: document.getElementById('comp').value.trim(),
      librarySeason: document.getElementById('librarySeason').value.trim(),
      importToLibrary: document.getElementById('importToLibrary').checked,
      listOnly: document.getElementById('listOnly').checked,
      overwrite: document.getElementById('overwrite').checked
    };

    try {
      const resp = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let finalOk = resp.ok;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        appendLog(chunk);
        if (chunk.includes('[SYNC_FAILED]')) finalOk = false;
      }
      setPill(finalOk ? 'Completed' : 'Finished with errors', finalOk ? 'ok' : 'err');
    } catch (err) {
      appendLog('\\nRequest error: ' + err.message + '\\n');
      setPill('Error', 'err');
    } finally {
      btnRun.disabled = false;
      btnStop.disabled = true;
    }
  });
</script>
</body>
</html>`;

function runStep(cmd, args, res) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: repoRoot });
    activeChild = child;
    child.stdout.on('data', d => res.write(d));
    child.stderr.on('data', d => res.write(d));
    child.on('error', err => {
      res.write(`\nProcess error: ${err.message}\n`);
      activeChild = null;
      resolve(1);
    });
    child.on('close', code => {
      activeChild = null;
      resolve(code ?? 1);
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(urlObj.pathname);

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/stop' && req.method === 'POST') {
    if (activeChild) {
      activeChild.kill('SIGTERM');
      activeChild = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stopped: true }));
    return;
  }

  if (pathname === '/api/sync' && req.method === 'POST') {
    if (activeChild) {
      res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('A sync job is already running. Click Stop or wait for it to finish.\n[SYNC_FAILED]\n');
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Invalid request JSON: ${err.message}\n[SYNC_FAILED]\n`);
      return;
    }

    const { org, season, gradeOrTeam, comp, librarySeason, importToLibrary, listOnly, overwrite } = body;
    if (!org || !season || !gradeOrTeam) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Organisation, Season, and Grade/Team are required.\n[SYNC_FAILED]\n');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked'
    });

    const outDir = path.join(repoRoot, 'downloads', slugify(season), slugify(gradeOrTeam));
    const dlArgs = [
      path.join(repoRoot, 'scripts', 'download-playcricket-csvs.mjs'),
      '--org', org,
      '--season', season,
      '--team', gradeOrTeam,
      '--out', outDir
    ];
    if (listOnly) dlArgs.push('--list-only');
    if (overwrite) dlArgs.push('--overwrite');

    res.write(`=== Step 1: Downloading Ball-by-Ball CSVs ===\n`);
    const dlCode = await runStep(process.execPath, dlArgs, res);
    if (dlCode !== 0) {
      res.write(`\nDownloader exited with code ${dlCode}.\n[SYNC_FAILED]\n`);
      res.end();
      return;
    }

    if (!listOnly && importToLibrary) {
      const libSeason = librarySeason || deriveLibrarySeason(season);
      res.write(`\n=== Step 2: Importing CSVs into Match Library (data/seasons/${slugify(libSeason)}/${slugify(gradeOrTeam)}/) ===\n`);
      const impArgs = [
        path.join(repoRoot, 'scripts', 'import-csvs-to-library.mjs'),
        '--dir', outDir,
        '--season', libSeason,
        '--team', gradeOrTeam,
        '--club', org,
        '--grade', gradeOrTeam
      ];
      if (comp) impArgs.push('--comp', comp);
      const impCode = await runStep(process.execPath, impArgs, res);
      if (impCode !== 0) {
        res.write(`\nImporter exited with code ${impCode}.\n[SYNC_FAILED]\n`);
        res.end();
        return;
      }
    }

    res.write(`\nAll done!\n`);
    res.end();
    return;
  }

  if (pathname === '/sync') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SYNC_PAGE_HTML);
    return;
  }

  // Static files from repoRoot
  const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const fullPath = path.resolve(repoRoot, relPath);
  if (!fullPath.startsWith(repoRoot) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(fullPath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(fullPath).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`SCA Scorebook local web app running at ${url}`);
  console.log(`PlayCricket Sync page available at      ${url}/sync`);
  console.log('Press Ctrl+C to stop.');
  if (AUTO_OPEN) {
    const opener = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'start' : 'xdg-open');
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  }
});
