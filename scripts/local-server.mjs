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
import { spawn, execFileSync } from 'node:child_process';
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
let lookupBrowser = null;
let lookupPage = null;
let lookupBusy = false;

async function getLookupPage() {
  if (lookupPage && !lookupPage.isClosed()) return lookupPage;
  const playwright = await import('playwright');
  if (!lookupBrowser || !lookupBrowser.isConnected()) {
    lookupBrowser = await playwright.chromium.launch({ headless: true });
  }
  const ctx = await lookupBrowser.newContext({ viewport: { width: 1280, height: 1000 } });
  lookupPage = await ctx.newPage();
  await lookupPage.goto('https://play.cricket.com.au/stats?cat=ballByBall', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await lookupPage.locator('#stats-org-search').waitFor({ state: 'visible', timeout: 15000 });
  return lookupPage;
}

async function searchPlayCricketOrgs(query) {
  const page = await getLookupPage();
  const clearBtn = page.getByRole('button', { name: 'Clear Search' });
  if (await clearBtn.isVisible().catch(() => false)) {
    await clearBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);
  }
  const searchBox = page.locator('#stats-org-search');
  await searchBox.click({ timeout: 5000 });
  await searchBox.fill(String(query || '').trim().slice(0, 20));
  const listbox = page.locator('[role="listbox"]:visible').first();
  await listbox.waitFor({ state: 'visible', timeout: 8000 });
  const opts = listbox.locator('[role="option"]:visible');
  await opts.first().waitFor({ state: 'visible', timeout: 8000 });
  const rawTexts = await opts.allInnerTexts();
  return rawTexts.map(t => t.trim()).filter(Boolean);
}

async function waitForEnabledControl(locator, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false)) {
      return true;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function lookupOrgOptions(orgName, seasonName) {
  const page = await getLookupPage();
  const targetLow = String(orgName || '').trim().toLowerCase();

  // First check if the org is already visible in the open search listbox from Search
  let clicked = false;
  const openListbox = page.locator('[role="listbox"]:visible').first();
  if (await openListbox.isVisible().catch(() => false)) {
    const openOpts = openListbox.locator('[role="option"]:visible');
    const openTexts = (await openOpts.allInnerTexts()).map(t => t.trim());
    const idx = openTexts.findIndex(t => t.toLowerCase() === targetLow);
    if (idx >= 0) {
      await openOpts.nth(idx).click({ force: true, timeout: 8000 });
      clicked = true;
    }
  }

  if (!clicked) {
    const clearBtn = page.getByRole('button', { name: 'Clear Search' });
    if (await clearBtn.isVisible().catch(() => false)) {
      await clearBtn.click({ force: true, timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
    const searchBox = page.locator('#stats-org-search');
    await searchBox.click({ force: true, timeout: 5000 });
    await searchBox.fill(String(orgName || '').trim().slice(0, 20));
    await openListbox.waitFor({ state: 'visible', timeout: 10000 });
    const orgOpts = openListbox.locator('[role="option"]:visible');
    await orgOpts.first().waitFor({ state: 'visible', timeout: 10000 });
    const orgTexts = (await orgOpts.allInnerTexts()).map(t => t.trim());
    const idx = orgTexts.findIndex(t => t.toLowerCase() === targetLow);
    await orgOpts.nth(idx >= 0 ? idx : 0).click({ force: true, timeout: 8000 });
  }

  await page.waitForTimeout(500);

  const readDropdown = async (labelName) => {
    const trigger = page.getByRole('button', { name: labelName, exact: true });
    const ready = await waitForEnabledControl(trigger, 10000);
    if (!ready) return { items: [], opts: null };
    await trigger.click({ force: true, timeout: 8000 });
    const controlsId = await trigger.getAttribute('aria-controls').catch(() => null);
    const scope = controlsId && (await page.locator(`#${controlsId}`).count().catch(() => 0)) > 0
      ? page.locator(`#${controlsId}`)
      : page;
    const opts = scope.locator('[role="option"]:visible');
    await opts.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    const items = (await opts.allInnerTexts()).map(t => t.trim());
    return { items, opts };
  };

  const seasonRes = await readDropdown('Season');
  const seasons = seasonRes.items.filter(Boolean);
  let chosenSeason = '';
  if (seasonRes.opts && seasonRes.items.length > 0) {
    let sIdx = seasonName ? seasonRes.items.findIndex(s => s.toLowerCase().includes(seasonName.toLowerCase())) : -1;
    if (sIdx < 0) sIdx = seasonRes.items.findIndex(Boolean);
    if (sIdx >= 0) {
      chosenSeason = seasonRes.items[sIdx];
      await seasonRes.opts.nth(sIdx).click({ force: true, timeout: 8000 });
      await page.waitForTimeout(600);
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }

  let thirdLabel = 'Grade';
  const teamBtn = page.getByRole('button', { name: 'Team', exact: true });
  const gradeBtn = page.getByRole('button', { name: 'Grade', exact: true });
  for (let w = 0; w < 25; w++) {
    if (await teamBtn.isVisible().catch(() => false)) { thirdLabel = 'Team'; break; }
    if (await gradeBtn.isVisible().catch(() => false)) { thirdLabel = 'Grade'; break; }
    await page.waitForTimeout(200);
  }

  const thirdRes = await readDropdown(thirdLabel);
  await page.keyboard.press('Escape').catch(() => {});
  return { seasons, chosenSeason, thirdLabel, thirdOptions: thirdRes.items.filter(Boolean) };
}

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
  <div style="display:flex; gap:8px;">
    <a href="/enrich">Submit / Enrich Data</a>
    <a href="/">← Back to Scorebook</a>
  </div>
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
        <label for="librarySeason">Library Season Folder Override (optional)</label>
        <input type="text" id="librarySeason" value="" placeholder="Auto-derived (e.g. 2026-27)">
      </div>
      <div>
        <label for="libraryTeam">Library Team Folder Override (optional)</label>
        <input type="text" id="libraryTeam" value="" placeholder="Auto from Grade/Team">
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
      libraryTeam: document.getElementById('libraryTeam').value.trim(),
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

const ENRICH_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Submit &amp; Enrich Match Data — SCA Scorebook</title>
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
  .layout {
    max-width: 1240px;
    margin: 20px auto;
    padding: 0 16px 40px;
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 16px;
    align-items: start;
  }
  .card {
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    padding: 16px 18px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  .card h2 {
    margin: 0 0 10px;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: #334155;
  }
  .filters {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 10px;
  }
  select, input[type="text"], textarea {
    width: 100%;
    padding: 7px 9px;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    font-size: 12.5px;
    font-family: inherit;
  }
  textarea {
    min-height: 120px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
    resize: vertical;
  }
  label {
    display: block;
    font-size: 11.5px;
    font-weight: 600;
    color: #334155;
    margin-bottom: 4px;
  }
  .game-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 70vh;
    overflow-y: auto;
  }
  .game-item {
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 8px 10px;
    cursor: pointer;
    background: #f8fafc;
    transition: border-color 0.15s, background 0.15s;
  }
  .game-item:hover { border-color: #93c5fd; background: #eff6ff; }
  .game-item.active { border-color: #2563eb; background: #dbeafe; }
  .game-title { font-size: 12px; font-weight: 600; color: #0f172a; margin-bottom: 5px; }
  .badges { display: flex; gap: 5px; flex-wrap: wrap; }
  .badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 999px;
  }
  .badge.ok { background: #dcfce7; color: #166534; }
  .badge.miss { background: #f1f5f9; color: #64748b; border: 1px solid #cbd5e1; }
  .meta-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    margin-bottom: 14px;
  }
  .innings-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  .innings-box {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .innings-box h3 {
    margin: 0;
    font-size: 13px;
    color: #1e293b;
  }
  .btn-row {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: 14px;
    flex-wrap: wrap;
  }
  button, .btn-link {
    border: none;
    border-radius: 6px;
    padding: 9px 15px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    display: inline-block;
  }
  .btn-primary { background: #2563eb; color: #fff; }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-primary:disabled { background: #94a3b8; cursor: not-allowed; }
  .btn-secondary { background: #e2e8f0; color: #1e293b; }
  .btn-secondary:hover { background: #cbd5e1; }
  .status {
    font-size: 12.5px;
    font-weight: 600;
    color: #047857;
  }
  .status.err { color: #b91c1c; }
  .empty-state {
    color: #64748b;
    font-size: 13px;
    padding: 24px 0;
    text-align: center;
  }
  @media (max-width: 900px) {
    .layout { grid-template-columns: 1fr; }
    .innings-grid, .meta-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<header>
  <h1>Submit &amp; Enrich Match Data</h1>
  <div style="display:flex; gap:8px;">
    <a href="/sync">PlayCricket Sync</a>
    <a href="/">← Back to Scorebook</a>
  </div>
</header>
<div class="layout">
  <div class="card">
    <h2>Saved Games (data/seasons/)</h2>
    <div class="filters">
      <select id="filterSeason"><option value="">All Seasons</option></select>
      <select id="filterTeam"><option value="">All Teams</option></select>
    </div>
    <div id="gameList" class="game-list"></div>
  </div>

  <div class="card">
    <div id="noSelection" class="empty-state">
      Select a game on the left to paste its PlayHQ Scorecard View and Detailed Ball-by-Ball text.
    </div>
    <form id="enrichForm" style="display:none;">
      <h2 id="selectedHeader">Selected Game</h2>
      <div class="meta-grid">
        <div><label for="mRound">Round</label><input type="text" id="mRound"></div>
        <div><label for="mDate">Date</label><input type="text" id="mDate" placeholder="DD/MM/YYYY"></div>
        <div><label for="mVenue">Venue / Ground</label><input type="text" id="mVenue"></div>
        <div><label for="mToss">Toss Won By</label><input type="text" id="mToss"></div>
        <div><label for="mResult">Result</label><input type="text" id="mResult"></div>
        <div><label for="mScorers">Scorers</label><input type="text" id="mScorers"></div>
      </div>

      <div class="innings-grid">
        <div class="innings-box">
          <h3 id="inn1Title">Innings 1</h3>
          <div>
            <label for="inn1Scorecard">PlayHQ Scorecard View (1st or combined)</label>
            <textarea id="inn1Scorecard" placeholder="Paste PlayHQ Scorecard View for Innings 1 (or both innings)..."></textarea>
          </div>
          <div>
            <label for="inn1BallByBall">Detailed PlayHQ Ball-by-Ball Text</label>
            <textarea id="inn1BallByBall" placeholder="Paste PlayHQ Ball-by-Ball commentary for Innings 1..."></textarea>
          </div>
        </div>

        <div class="innings-box">
          <h3 id="inn2Title">Innings 2</h3>
          <div>
            <label for="inn2Scorecard">PlayHQ Scorecard View (2nd innings)</label>
            <textarea id="inn2Scorecard" placeholder="Paste PlayHQ Scorecard View for Innings 2..."></textarea>
          </div>
          <div>
            <label for="inn2BallByBall">Detailed PlayHQ Ball-by-Ball Text</label>
            <textarea id="inn2BallByBall" placeholder="Paste PlayHQ Ball-by-Ball commentary for Innings 2..."></textarea>
          </div>
        </div>
      </div>

      <div class="btn-row">
        <button type="submit" id="btnSave" class="btn-primary">Save to Match Library</button>
        <a id="btnOpenScorebook" class="btn-link btn-secondary" href="/" target="_blank">Open in Scorebook →</a>
        <span id="saveStatus" class="status"></span>
      </div>
    </form>
  </div>
</div>

<script>
  let indexData = { games: [] };
  let selectedEntry = null;
  let selectedGameObj = null;

  const filterSeason = document.getElementById('filterSeason');
  const filterTeam = document.getElementById('filterTeam');
  const gameListEl = document.getElementById('gameList');
  const noSelectionEl = document.getElementById('noSelection');
  const formEl = document.getElementById('enrichForm');
  const statusEl = document.getElementById('saveStatus');

  function setStatus(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (isErr ? ' err' : '');
  }

  async function loadIndex() {
    const resp = await fetch('/data/index.json?t=' + Date.now());
    indexData = await resp.json();
    populateFilters();
    renderGameList();
  }

  function populateFilters() {
    const games = indexData.games || [];
    const prevS = filterSeason.value;
    const prevT = filterTeam.value;
    const seasons = Array.from(new Set(games.map(g => g.season).filter(Boolean))).sort().reverse();
    filterSeason.innerHTML = '<option value="">All Seasons</option>';
    seasons.forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s;
      filterSeason.appendChild(o);
    });
    if (seasons.includes(prevS)) filterSeason.value = prevS;

    const curS = filterSeason.value;
    const teams = Array.from(new Set(games.filter(g => !curS || g.season === curS).map(g => g.team).filter(Boolean))).sort();
    filterTeam.innerHTML = '<option value="">All Teams</option>';
    teams.forEach(t => {
      const o = document.createElement('option');
      o.value = t; o.textContent = t;
      filterTeam.appendChild(o);
    });
    if (teams.includes(prevT)) filterTeam.value = prevT;
  }

  function renderGameList() {
    const s = filterSeason.value;
    const t = filterTeam.value;
    const filtered = (indexData.games || []).filter(g => (!s || g.season === s) && (!t || g.team === t));
    gameListEl.innerHTML = '';
    if (filtered.length === 0) {
      gameListEl.innerHTML = '<div class="empty-state">No games found.</div>';
      return;
    }
    filtered.forEach(g => {
      const div = document.createElement('div');
      div.className = 'game-item' + (selectedEntry && selectedEntry.path === g.path ? ' active' : '');
      div.innerHTML =
        '<div class="game-title"></div>' +
        '<div class="badges">' +
          '<span class="badge ' + (g.hasCsv ? 'ok' : 'miss') + '">CSV ' + (g.hasCsv ? '✓' : '–') + '</span>' +
          '<span class="badge ' + (g.hasScorecard ? 'ok' : 'miss') + '">Scorecard ' + (g.hasScorecard ? '✓' : '–') + '</span>' +
          '<span class="badge ' + (g.hasBallByBall ? 'ok' : 'miss') + '">Ball-by-Ball ' + (g.hasBallByBall ? '✓' : '–') + '</span>' +
        '</div>';
      div.querySelector('.game-title').textContent = g.title;
      div.addEventListener('click', () => selectGame(g));
      gameListEl.appendChild(div);
    });
  }

  async function selectGame(entry) {
    selectedEntry = entry;
    renderGameList();
    setStatus('Loading...', false);
    const resp = await fetch('/' + entry.path + '?t=' + Date.now());
    selectedGameObj = await resp.json();

    noSelectionEl.style.display = 'none';
    formEl.style.display = 'block';
    document.getElementById('selectedHeader').textContent = selectedGameObj.title || entry.title;
    document.getElementById('btnOpenScorebook').href = '/?game=' + encodeURIComponent(entry.path);

    const m = selectedGameObj.match || {};
    document.getElementById('mRound').value = m.round || '';
    document.getElementById('mDate').value = m.date || '';
    document.getElementById('mVenue').value = m.venue || '';
    document.getElementById('mToss').value = m.toss || '';
    document.getElementById('mResult').value = m.result || '';
    document.getElementById('mScorers').value = m.scorers || '';

    const r1 = (selectedGameObj.raw && selectedGameObj.raw.innings1) || {};
    const r2 = (selectedGameObj.raw && selectedGameObj.raw.innings2) || {};
    document.getElementById('inn1Title').textContent = 'Innings 1 — ' + (r1.team || 'Side 1');
    document.getElementById('inn2Title').textContent = 'Innings 2 — ' + (r2.team || 'Side 2');
    document.getElementById('inn1Scorecard').value = r1.scorecard || '';
    document.getElementById('inn1BallByBall').value = r1.playhqText || '';
    document.getElementById('inn2Scorecard').value = r2.scorecard || '';
    document.getElementById('inn2BallByBall').value = r2.playhqText || '';
    setStatus('', false);
  }

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedEntry || !selectedGameObj) return;
    const btn = document.getElementById('btnSave');
    btn.disabled = true;
    setStatus('Saving...', false);

    selectedGameObj.match = Object.assign({}, selectedGameObj.match || {}, {
      round: document.getElementById('mRound').value.trim(),
      date: document.getElementById('mDate').value.trim(),
      venue: document.getElementById('mVenue').value.trim(),
      toss: document.getElementById('mToss').value.trim(),
      result: document.getElementById('mResult').value.trim(),
      scorers: document.getElementById('mScorers').value.trim()
    });
    selectedGameObj.raw = selectedGameObj.raw || { innings1: {}, innings2: {} };
    selectedGameObj.raw.innings1 = selectedGameObj.raw.innings1 || {};
    selectedGameObj.raw.innings2 = selectedGameObj.raw.innings2 || {};
    selectedGameObj.raw.innings1.scorecard = document.getElementById('inn1Scorecard').value;
    selectedGameObj.raw.innings1.playhqText = document.getElementById('inn1BallByBall').value;
    selectedGameObj.raw.innings2.scorecard = document.getElementById('inn2Scorecard').value;
    selectedGameObj.raw.innings2.playhqText = document.getElementById('inn2BallByBall').value;
    selectedGameObj.savedAt = new Date().toISOString();

    try {
      const resp = await fetch('/api/save-game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedEntry.path, payload: selectedGameObj })
      });
      const out = await resp.json();
      if (!resp.ok || !out.ok) throw new Error(out.error || 'Save failed');
      await loadIndex();
      setStatus('Saved to ' + selectedEntry.path + '!', false);
    } catch (err) {
      setStatus('Error: ' + err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  filterSeason.addEventListener('change', () => { populateFilters(); renderGameList(); });
  filterTeam.addEventListener('change', renderGameList);
  loadIndex();
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
      if (body.length > 20 * 1024 * 1024) reject(new Error('Body too large'));
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

  if (pathname === '/api/presets' && req.method === 'GET') {
    const presetsPath = path.join(repoRoot, 'data', 'sync-presets.json');
    let presets = [];
    try {
      if (fs.existsSync(presetsPath)) {
        const parsed = JSON.parse(fs.readFileSync(presetsPath, 'utf8'));
        if (Array.isArray(parsed)) presets = parsed;
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(presets));
    return;
  }

  if (pathname === '/api/lookup-orgs' && req.method === 'GET') {
    const q = (urlObj.searchParams.get('q') || '').trim();
    if (q.length < 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Enter at least 2 characters to search.' }));
      return;
    }
    if (lookupBusy) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'A PlayCricket lookup is already in progress.' }));
      return;
    }
    lookupBusy = true;
    try {
      const results = await searchPlayCricketOrgs(q);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results }));
    } catch (err) {
      lookupPage = null;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    } finally {
      lookupBusy = false;
    }
    return;
  }

  if (pathname === '/api/lookup-options' && req.method === 'GET') {
    const org = (urlObj.searchParams.get('org') || '').trim();
    const season = (urlObj.searchParams.get('season') || '').trim();
    if (!org) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Organisation is required.' }));
      return;
    }
    if (lookupBusy) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'A PlayCricket lookup is already in progress.' }));
      return;
    }
    lookupBusy = true;
    try {
      const data = await lookupOrgOptions(org, season);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...data }));
    } catch (err) {
      lookupPage = null;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    } finally {
      lookupBusy = false;
    }
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

    const { org, season, grade, grades, team, gradeOrTeam, comp, librarySeason, libraryTeam, importToLibrary, withMatchData, listOnly, overwrite } = body;
    const effTeam = (team || '').trim();
    const gradeList = Array.isArray(grades) && grades.length > 0
      ? grades.map(g => String(g || '').trim()).filter(Boolean)
      : [(grade || '').trim()].filter(Boolean);
    const singleFallback = effTeam || (gradeOrTeam || '').trim();
    const targets = gradeList.length > 0 ? gradeList : (singleFallback ? [singleFallback] : []);

    if (!org || !season || targets.length === 0) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Organisation, Season, and at least one Grade/Team are required.\n[SYNC_FAILED]\n');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked'
    });

    const folderSeason = (librarySeason || '').trim() || deriveLibrarySeason(season);
    const isBulk = targets.length > 1;
    let anyFailed = false;

    for (let tIdx = 0; tIdx < targets.length; tIdx++) {
      const curGrade = gradeList.length > 0 ? targets[tIdx] : '';
      const curTargetLabel = effTeam || curGrade || targets[tIdx];
      const folderTeam = (!isBulk && (libraryTeam || '').trim()) ? (libraryTeam || '').trim() : curTargetLabel;

      if (isBulk) {
        res.write(`\n==============================\n[${tIdx + 1}/${targets.length}] ${curTargetLabel}\n==============================\n`);
      }

      // Persist this sync configuration to data/sync-presets.json for 1-click reuse
      try {
        const presetsPath = path.join(repoRoot, 'data', 'sync-presets.json');
        let presets = [];
        if (fs.existsSync(presetsPath)) {
          const parsed = JSON.parse(fs.readFileSync(presetsPath, 'utf8'));
          if (Array.isArray(parsed)) presets = parsed;
        }
        const entry = {
          label: `${folderTeam} — ${season}`,
          org,
          season,
          grade: curGrade,
          team: effTeam,
          comp: (comp || '').trim(),
          librarySeason: (librarySeason || '').trim(),
          libraryTeam: (!isBulk ? (libraryTeam || '').trim() : ''),
          lastUsed: new Date().toISOString()
        };
        const idx = presets.findIndex(p =>
          p.org.toLowerCase() === org.toLowerCase() &&
          p.season.toLowerCase() === season.toLowerCase() &&
          (p.grade || '').toLowerCase() === curGrade.toLowerCase() &&
          (p.team || '').toLowerCase() === effTeam.toLowerCase()
        );
        if (idx >= 0) presets[idx] = entry;
        else presets.unshift(entry);
        presets.sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')));
        fs.mkdirSync(path.dirname(presetsPath), { recursive: true });
        fs.writeFileSync(presetsPath, JSON.stringify(presets, null, 2) + '\n', 'utf8');
      } catch {}

      const outDir = path.join(repoRoot, 'downloads', slugify(folderSeason), slugify(folderTeam));
      const dlArgs = [
        path.join(repoRoot, 'scripts', 'download-playcricket-csvs.mjs'),
        '--org', org,
        '--season', season,
        '--out', outDir
      ];
      if (curGrade) dlArgs.push('--grade', curGrade);
      if (effTeam) dlArgs.push('--team', effTeam);
      if (!curGrade && !effTeam) dlArgs.push('--team', curTargetLabel);
      if (listOnly) dlArgs.push('--list-only');
      if (overwrite) dlArgs.push('--overwrite');
      if (withMatchData === false) dlArgs.push('--csv-only');

      res.write(`=== Step 1: Downloading Ball-by-Ball CSVs ===\n`);
      const dlCode = await runStep(process.execPath, dlArgs, res);
      if (dlCode !== 0) {
        res.write(`\nDownloader exited with code ${dlCode} for "${curTargetLabel}".\n`);
        anyFailed = true;
        continue;
      }

      if (!listOnly && importToLibrary) {
        res.write(`\n=== Step 2: Importing CSVs into Match Library ===\n`);
        const impArgs = [
          path.join(repoRoot, 'scripts', 'import-csvs-to-library.mjs'),
          '--dir', outDir,
          '--season', folderSeason,
          '--team', folderTeam,
          '--club', org,
          '--grade', curGrade || folderTeam
        ];
        if (!isBulk && (libraryTeam || '').trim()) impArgs.push('--force-team');
        if (overwrite) impArgs.push('--overwrite');
        if (comp) impArgs.push('--comp', comp);
        const impCode = await runStep(process.execPath, impArgs, res);
        if (impCode !== 0) {
          res.write(`\nImporter exited with code ${impCode} for "${curTargetLabel}".\n`);
          anyFailed = true;
        } else {
          try {
            fs.rmSync(outDir, { recursive: true, force: true });
            res.write(`Cleaned up temporary downloads folder: ${path.relative(repoRoot, outDir)}\n`);
          } catch {}
        }
      }
    }

    if (anyFailed) {
      res.write(`\nFinished with some errors.\n[SYNC_FAILED]\n`);
    } else {
      res.write(`\nAll done!\n`);
    }
    res.end();
    return;
  }

  if (pathname === '/api/save-pdf' && req.method === 'POST') {
    let browser;
    try {
      const body = await readJsonBody(req);
      const svgPages = Array.isArray(body.pages) ? body.pages.filter(Boolean) : [];
      if (svgPages.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'No scorebook pages provided.' }));
        return;
      }
      const paperSize = body.paperSize === 'A3' ? 'A3' : 'A4';
      const dims = paperSize === 'A3'
        ? { w: '404mm', h: '282mm' }
        : { w: '282mm', h: '196mm' };

      const cleanSeg = (s) => String(s || '')
        .replace(/[\/\\:*?"<>|]+/g, '-')
        .replace(/\.\.+/g, '.')
        .replace(/\s+/g, ' ')
        .trim();

      const rawName = cleanSeg(body.fileName || 'Scorebook');
      const fileName = /\.pdf$/i.test(rawName) ? rawName : `${rawName}.pdf`;
      const seasonDir = cleanSeg(body.season || '');
      const teamDir = cleanSeg(body.team || '');

      const scorebooksRoot = path.resolve(repoRoot, 'scorebooks');
      const targetParts = [scorebooksRoot];
      if (seasonDir) targetParts.push(seasonDir);
      if (teamDir) targetParts.push(teamDir);
      targetParts.push(fileName);

      const fullTarget = path.resolve(...targetParts);
      if (!fullTarget.startsWith(scorebooksRoot + path.sep)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid target path outside scorebooks/' }));
        return;
      }

      const relOut = path.relative(repoRoot, fullTarget);
      if (fs.existsSync(fullTarget) && !body.overwrite) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, exists: true, path: relOut }));
        return;
      }

      const htmlDoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @page { size: ${paperSize} landscape; margin: 5mm; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .print-page {
    width: 100%;
    height: ${dims.h};
    margin: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    page-break-inside: avoid;
    break-inside: avoid;
    page-break-after: always;
    break-after: page;
  }
  .print-page:last-child { page-break-after: auto; break-after: auto; }
  .print-page svg {
    width: ${dims.w};
    height: ${dims.h};
    max-width: 100%;
    max-height: 100%;
    display: block;
  }
</style>
</head>
<body>
${svgPages.map(svg => `<div class="print-page">${svg}</div>`).join('\n')}
</body>
</html>`;

      const playwright = await import('playwright');
      browser = await playwright.chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.setContent(htmlDoc, { waitUntil: 'load' });
      fs.mkdirSync(path.dirname(fullTarget), { recursive: true });
      await page.pdf({
        path: fullTarget,
        preferCSSPageSize: true,
        printBackground: true
      });
      await browser.close();
      browser = null;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: relOut, pages: svgPages.length }));
    } catch (err) {
      if (browser) await browser.close().catch(() => {});
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (pathname === '/api/save-game' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const relPath = String(body.path || '').replace(/^\/+/, '');
      if (!relPath.startsWith('data/seasons/') || !relPath.endsWith('.json') || relPath.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid target path. Must be under data/seasons/*.json' }));
        return;
      }
      const fullTarget = path.resolve(repoRoot, relPath);
      const seasonsRoot = path.resolve(repoRoot, 'data', 'seasons');
      if (!fullTarget.startsWith(seasonsRoot + path.sep)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Path escapes data/seasons/' }));
        return;
      }
      fs.mkdirSync(path.dirname(fullTarget), { recursive: true });
      fs.writeFileSync(fullTarget, JSON.stringify(body.payload, null, 2) + '\n', 'utf8');
      execFileSync(process.execPath, [path.join(__dirname, 'rebuild-index.mjs')], { stdio: 'ignore' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: relPath }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (pathname === '/sync') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SYNC_PAGE_HTML);
    return;
  }

  if (pathname === '/enrich') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ENRICH_PAGE_HTML);
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
