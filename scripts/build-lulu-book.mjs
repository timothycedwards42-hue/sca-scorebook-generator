#!/usr/bin/env node
/**
 * Build Lulu-ready A4 Landscape Left-Coil-Bound Season Scorebook PDFs:
 *   - Cover.pdf            (2-page Front + Back Cover with 3.2mm bleed & 14mm coil safe zone)
 *   - Interior.pdf         (A4 Landscape 297x210mm with alternating 14mm left/right duplex coil gutter)
 *   - Proof-With-Guides.pdf (Interior with red dashed trim & 12.7mm coil punch zone overlay for review)
 *
 * Usage:
 *   node scripts/build-lulu-book.mjs --season "2026-27" --team "North Shore U13/1"
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { season: '', team: '', out: '', subtitle: '', accent: '#1b2a4a' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--season' && argv[i + 1]) args.season = argv[++i];
    else if (a === '--team' && argv[i + 1]) args.team = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--subtitle' && argv[i + 1]) args.subtitle = argv[++i];
    else if (a === '--accent' && argv[i + 1]) args.accent = argv[++i];
  }
  return args;
}

function slugify(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSeasonLabel(s) {
  return String(s || '').replace('-', '/');
}

function buildCoverHtml({ team, season, club, grade, games, accent, showGuides }) {
  const seasonLabel = formatSeasonLabel(season);
  const completedCount = games.length;
  const rowsHtml = games.map((g, idx) => {
    const rd = g.match?.round ? `Rd ${g.match.round}` : `Game ${idx + 1}`;
    const dt = g.match?.date || '';
    const opp = g.opponent || 'Opponent';
    const res = g.match?.result || '';
    return `<tr>
      <td class="c-rd">${escHtml(rd)}</td>
      <td class="c-dt">${escHtml(dt)}</td>
      <td class="c-opp">${escHtml(opp)}</td>
      <td class="c-res">${escHtml(res)}</td>
    </tr>`;
  }).join('\n');

  const guideOverlayFront = showGuides ? `
    <div class="guide-bleed"></div>
    <div class="guide-coil-left"><span>COIL PUNCH ZONE (12.7mm)</span></div>` : '';
  const guideOverlayBack = showGuides ? `
    <div class="guide-bleed"></div>
    <div class="guide-coil-right"><span>COIL PUNCH ZONE (12.7mm)</span></div>` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  /* A4 Landscape (297x210mm) + 3.2mm bleed on all 4 sides = 303.4mm x 216.4mm */
  @page { size: 303.4mm 216.4mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: ${accent};
  }
  .cover-page {
    position: relative;
    width: 303.4mm;
    height: 216.4mm;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
  }
  .cover-page:last-child { page-break-after: auto; break-after: auto; }

  /* FRONT COVER (coil on LEFT edge: 3.2mm bleed + 14mm coil margin = 17.2mm) */
  .front {
    background: linear-gradient(135deg, ${accent} 0%, #0f172a 100%);
    color: #fff;
    padding: 18mm 18mm 18mm 26mm;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .accent-bar {
    position: absolute;
    left: 17.2mm;
    top: 0;
    bottom: 0;
    width: 3mm;
    background: linear-gradient(180deg, #f59e0b 0%, #d97706 100%);
  }
  .front-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 0.4mm solid rgba(255,255,255,0.22);
    padding-bottom: 5mm;
  }
  .badge {
    font-size: 9.5pt;
    font-weight: 700;
    letter-spacing: 2.2px;
    text-transform: uppercase;
    color: #fbbf24;
  }
  .season-pill {
    font-size: 11pt;
    font-weight: 700;
    padding: 2mm 5mm;
    border: 0.4mm solid rgba(251,191,36,0.7);
    border-radius: 2mm;
    color: #fef3c7;
  }
  .front-center {
    margin: auto 0;
    padding: 8mm 0;
  }
  .kicker {
    font-size: 11pt;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: #cbd5e1;
    margin-bottom: 4mm;
  }
  .team-title {
    font-size: 38pt;
    font-weight: 800;
    line-height: 1.08;
    margin: 0 0 5mm 0;
    color: #ffffff;
  }
  .grade-sub {
    font-size: 16pt;
    font-weight: 500;
    color: #fbbf24;
    margin: 0 0 3mm 0;
  }
  .club-sub {
    font-size: 11.5pt;
    color: #cbd5e1;
    margin: 0;
  }
  .front-bottom {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    border-top: 0.4mm solid rgba(255,255,255,0.22);
    padding-top: 5mm;
    font-size: 9.5pt;
    color: #94a3b8;
  }
  .front-bottom strong { color: #f8fafc; }

  /* BACK COVER (coil on RIGHT edge when flipped: 3.2mm bleed + 14mm coil margin = 17.2mm right) */
  .back {
    background: #f8fafc;
    color: #0f172a;
    padding: 16mm 26mm 16mm 18mm;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .back-accent {
    position: absolute;
    right: 17.2mm;
    top: 0;
    bottom: 0;
    width: 3mm;
    background: ${accent};
  }
  .back h2 {
    margin: 0 0 2mm 0;
    font-size: 16pt;
    color: ${accent};
    letter-spacing: 0.4px;
  }
  .back .sub {
    margin: 0 0 6mm 0;
    font-size: 9.5pt;
    color: #475569;
  }
  table.summary {
    width: 100%;
    border-collapse: collapse;
    font-size: 8.8pt;
  }
  table.summary th {
    text-align: left;
    background: ${accent};
    color: #fff;
    padding: 2.2mm 3mm;
    font-size: 8pt;
    text-transform: uppercase;
    letter-spacing: 0.6px;
  }
  table.summary td {
    padding: 2mm 3mm;
    border-bottom: 0.25mm solid #cbd5e1;
    vertical-align: top;
  }
  table.summary tr:nth-child(even) td { background: #f1f5f9; }
  .c-rd { width: 12%; font-weight: 700; color: ${accent}; white-space: nowrap; }
  .c-dt { width: 14%; white-space: nowrap; color: #475569; }
  .c-opp { width: 38%; font-weight: 600; }
  .c-res { width: 36%; color: #334155; }
  .back-footer {
    font-size: 8pt;
    color: #64748b;
    display: flex;
    justify-content: space-between;
    border-top: 0.3mm solid #cbd5e1;
    padding-top: 3mm;
  }

  /* PROOF GUIDES */
  .guide-bleed {
    position: absolute;
    inset: 3.2mm;
    border: 0.35mm dashed #ef4444;
    pointer-events: none;
  }
  .guide-coil-left, .guide-coil-right {
    position: absolute;
    top: 3.2mm;
    bottom: 3.2mm;
    width: 12.7mm;
    background: rgba(239, 68, 68, 0.14);
    border: 0.35mm dashed #dc2626;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }
  .guide-coil-left { left: 3.2mm; }
  .guide-coil-right { right: 3.2mm; }
  .guide-coil-left span, .guide-coil-right span {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: 7pt;
    font-weight: 700;
    color: #dc2626;
    letter-spacing: 1px;
  }
</style>
</head>
<body>
  <div class="cover-page front">
    <div class="accent-bar"></div>
    <div class="front-top">
      <div class="badge">Sydney Cricket Association · Official Scorebook</div>
      <div class="season-pill">Season ${escHtml(seasonLabel)}</div>
    </div>
    <div class="front-center">
      <div class="kicker">Season Match Record</div>
      <h1 class="team-title">${escHtml(team)}</h1>
      ${grade ? `<p class="grade-sub">${escHtml(grade)}</p>` : ''}
      ${club ? `<p class="club-sub">${escHtml(club)}</p>` : ''}
    </div>
    <div class="front-bottom">
      <div><strong>${completedCount} Match${completedCount === 1 ? '' : 'es'}</strong> · Complete Ball-by-Ball &amp; Traditional Scorebook</div>
      <div>A4 Landscape · Coil Bound</div>
    </div>
    ${guideOverlayFront}
  </div>

  <div class="cover-page back">
    <div class="back-accent"></div>
    <div>
      <h2>${escHtml(team)} — ${escHtml(seasonLabel)} Season Schedule</h2>
      <p class="sub">${escHtml(club || grade || 'Season Match Summary')}</p>
      <table class="summary">
        <thead>
          <tr><th>Round</th><th>Date</th><th>Opponent</th><th>Result</th></tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
    <div class="back-footer">
      <span>Generated by SCA Digital Scorebook</span>
      <span>${escHtml(team)} · Season ${escHtml(seasonLabel)}</span>
    </div>
    ${guideOverlayBack}
  </div>
</body>
</html>`;
}

function buildInteriorHtml({ team, season, club, grade, games, renderedPages, accent, showGuides }) {
  const seasonLabel = formatSeasonLabel(season);

  // Page 1 (Odd / Right-hand page -> 14mm LEFT coil gutter): Title & Contents page
  const indexRows = games.map((g, idx) => {
    const rd = g.match?.round ? `Rd ${g.match.round}` : `Game ${idx + 1}`;
    const dt = g.match?.date || '';
    const opp = g.opponent || 'Opponent';
    const res = g.match?.result || '';
    const startPg = 2 + idx * 2;
    return `<tr>
      <td class="i-rd">${escHtml(rd)}</td>
      <td class="i-dt">${escHtml(dt)}</td>
      <td class="i-opp">${escHtml(opp)}</td>
      <td class="i-res">${escHtml(res)}</td>
      <td class="i-pg">pp. ${startPg}–${startPg + 1}</td>
    </tr>`;
  }).join('\n');

  const makeGuide = (isOdd) => {
    if (!showGuides) return '';
    const sideClass = isOdd ? 'guide-coil-left' : 'guide-coil-right';
    return `<div class="guide-trim"></div><div class="${sideClass}"><span>COIL PUNCH ZONE (12.7mm)</span></div>`;
  };

  // Build pages array: Page 1 is contents (odd), then each scorebook SVG page
  const pageBlocks = [];
  pageBlocks.push(`
    <div class="sheet odd">
      <div class="contents-wrap">
        <div class="contents-header">
          <div>
            <div class="contents-kicker">Season ${escHtml(seasonLabel)} · Official Scorebook</div>
            <h1>${escHtml(team)}</h1>
            <div class="contents-sub">${escHtml([grade, club].filter(Boolean).join(' · '))}</div>
          </div>
          <div class="contents-count">${games.length} Matches</div>
        </div>
        <table class="idx-table">
          <thead>
            <tr><th>Round</th><th>Date</th><th>Opponent</th><th>Result</th><th>Pages</th></tr>
          </thead>
          <tbody>
            ${indexRows}
          </tbody>
        </table>
      </div>
      <div class="page-foot"><span>${escHtml(team)} — Season ${escHtml(seasonLabel)}</span><span>Page 1</span></div>
      ${makeGuide(true)}
    </div>
  `);

  renderedPages.forEach((p, idx) => {
    const pageNum = idx + 2; // Page 2 = even (left-hand, coil on RIGHT), Page 3 = odd (right-hand, coil on LEFT)
    const isOdd = (pageNum % 2) === 1;
    const cls = isOdd ? 'odd' : 'even';
    pageBlocks.push(`
      <div class="sheet ${cls}">
        <div class="svg-slot">${p.svg}</div>
        <div class="page-foot">
          <span>${escHtml(p.caption)}</span>
          <span>Page ${pageNum}</span>
        </div>
        ${makeGuide(isOdd)}
      </div>
    `);
  });

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  /* Standard A4 Landscape trim: 297mm x 210mm */
  @page { size: 297mm 210mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .sheet {
    position: relative;
    width: 297mm;
    height: 210mm;
    overflow: hidden;
    page-break-inside: avoid;
    break-inside: avoid;
    page-break-after: always;
    break-after: page;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .sheet:last-child { page-break-after: auto; break-after: auto; }

  /* Duplex alternating 14mm coil gutter:
     - Odd (right-hand) pages: coil on LEFT  -> 14mm left, 6mm right
     - Even (left-hand) pages: coil on RIGHT -> 6mm left, 14mm right */
  .sheet.odd  { padding: 5.5mm 6mm 4mm 14mm; }
  .sheet.even { padding: 5.5mm 14mm 4mm 6mm; }

  .svg-slot {
    width: 277mm;
    height: 194.5mm;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .svg-slot svg {
    width: 277mm;
    height: 194.5mm;
    display: block;
  }
  .page-foot {
    height: 5mm;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 7.2pt;
    color: #64748b;
    padding: 0 1mm;
  }

  /* Contents page */
  .contents-wrap {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 4mm 2mm;
  }
  .contents-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    border-bottom: 0.7mm solid ${accent};
    padding-bottom: 4mm;
    margin-bottom: 6mm;
  }
  .contents-kicker {
    font-size: 8.5pt;
    font-weight: 700;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: #d97706;
    margin-bottom: 1.5mm;
  }
  .contents-header h1 {
    margin: 0;
    font-size: 24pt;
    color: ${accent};
  }
  .contents-sub {
    font-size: 10pt;
    color: #475569;
    margin-top: 1.5mm;
  }
  .contents-count {
    font-size: 11pt;
    font-weight: 700;
    color: ${accent};
    background: #eff6ff;
    border: 0.35mm solid #bfdbfe;
    padding: 2mm 4.5mm;
    border-radius: 2mm;
  }
  table.idx-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 9pt;
  }
  table.idx-table th {
    text-align: left;
    background: ${accent};
    color: #fff;
    padding: 2.3mm 3mm;
    font-size: 8pt;
    text-transform: uppercase;
    letter-spacing: 0.6px;
  }
  table.idx-table td {
    padding: 2.1mm 3mm;
    border-bottom: 0.25mm solid #e2e8f0;
  }
  table.idx-table tr:nth-child(even) td { background: #f8fafc; }
  .i-rd { width: 10%; font-weight: 700; color: ${accent}; white-space: nowrap; }
  .i-dt { width: 13%; color: #475569; white-space: nowrap; }
  .i-opp { width: 35%; font-weight: 600; }
  .i-res { width: 32%; color: #334155; }
  .i-pg { width: 10%; text-align: right; font-weight: 600; color: #475569; white-space: nowrap; }

  /* PROOF GUIDES */
  .guide-trim {
    position: absolute;
    inset: 0;
    border: 0.35mm dashed #ef4444;
    pointer-events: none;
  }
  .guide-coil-left, .guide-coil-right {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 12.7mm;
    background: rgba(239, 68, 68, 0.14);
    border: 0.35mm dashed #dc2626;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }
  .guide-coil-left { left: 0; }
  .guide-coil-right { right: 0; }
  .guide-coil-left span, .guide-coil-right span {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: 7pt;
    font-weight: 700;
    color: #dc2626;
    letter-spacing: 1px;
  }
</style>
</head>
<body>
${pageBlocks.join('\n')}
</body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.season || !args.team) {
    console.error('Usage: node scripts/build-lulu-book.mjs --season "2026-27" --team "North Shore U13/1"');
    process.exit(1);
  }

  const indexPath = path.join(repoRoot, 'data', 'index.json');
  const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const teamLow = args.team.toLowerCase();
  const seasonLow = args.season.toLowerCase();

  const matching = idx.games
    .filter(g => String(g.season || '').toLowerCase() === seasonLow && String(g.team || '').toLowerCase() === teamLow)
    .sort((a, b) => {
      const ra = parseInt(a.round, 10) || 999;
      const rb = parseInt(b.round, 10) || 999;
      if (ra !== rb) return ra - rb;
      return String(a.path || '').localeCompare(String(b.path || ''));
    });

  if (matching.length === 0) {
    console.error(`No games found in data/index.json for season="${args.season}" team="${args.team}".`);
    process.exit(1);
  }

  const games = matching.map(g => JSON.parse(fs.readFileSync(path.join(repoRoot, g.path), 'utf8')));
  const firstMeta = games[0]?.match || {};
  const club = firstMeta.club || '';
  const grade = args.subtitle || firstMeta.grade || firstMeta.comp || '';

  const outDir = args.out
    ? path.resolve(args.out)
    : path.join(repoRoot, 'scorebooks', 'lulu', slugify(args.season), slugify(args.team));
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Building Lulu A4 Landscape Left-Coil Book for "${args.team}" (${args.season}) — ${games.length} match(es)...`);

  const playwright = await import('playwright');
  const browser = await playwright.chromium.launch({ headless: true });

  try {
    // 1. Render all match scorebook SVGs using index.html's exact rendering engine
    const renderPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await renderPage.goto(`file://${path.join(repoRoot, 'index.html')}`, { waitUntil: 'domcontentloaded' });
    await renderPage.waitForTimeout(300);

    const renderedPages = [];
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      const svgs = await renderPage.evaluate((gameDoc) => {
        loadGameArchiveObject(gameDoc);
        const host = document.getElementById('printContainer') || document.body;
        const out = [];
        for (const sideNum of [1, 2]) {
          const st = inningsStore[sideNum];
          if (!st || (!st.csv && !st.scorecard)) continue;
          const svg = svgEl('svg', {
            viewBox: '16 16 968 718',
            preserveAspectRatio: 'none',
            xmlns: 'http://www.w3.org/2000/svg'
          });
          // Attach to live DOM before rendering so SVG getComputedTextLength() works accurately!
          svg.style.width = '1000px';
          svg.style.height = '750px';
          host.appendChild(svg);
          renderScorebookTo(svg, st, sharedMeta);
          svg.removeAttribute('style');
          out.push({ sideNum, team: st.team, against: st.against, svg: svg.outerHTML });
          svg.remove();
        }
        return out;
      }, g);

      const rdLabel = g.match?.round ? `Rd ${g.match.round}` : `Game ${i + 1}`;
      const dtLabel = g.match?.date ? ` (${g.match.date})` : '';
      svgs.forEach(s => {
        renderedPages.push({
          svg: s.svg,
          caption: `${rdLabel}${dtLabel} · Innings ${s.sideNum}: ${s.team} vs ${s.against || g.opponent || ''}`
        });
      });
    }
    await renderPage.close();

    // 2. Render Cover.pdf, Interior.pdf, and Proof-With-Guides.pdf
    const pdfPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    const coverPath = path.join(outDir, 'Cover.pdf');
    await pdfPage.setContent(buildCoverHtml({
      team: args.team, season: args.season, club, grade, games, accent: args.accent, showGuides: false
    }), { waitUntil: 'load' });
    await pdfPage.pdf({ path: coverPath, preferCSSPageSize: true, printBackground: true });

    const interiorPath = path.join(outDir, 'Interior.pdf');
    await pdfPage.setContent(buildInteriorHtml({
      team: args.team, season: args.season, club, grade, games, renderedPages, accent: args.accent, showGuides: false
    }), { waitUntil: 'load' });
    await pdfPage.pdf({ path: interiorPath, preferCSSPageSize: true, printBackground: true });

    const proofPath = path.join(outDir, 'Proof-With-Guides.pdf');
    await pdfPage.setContent(buildInteriorHtml({
      team: args.team, season: args.season, club, grade, games, renderedPages, accent: args.accent, showGuides: true
    }), { waitUntil: 'load' });
    await pdfPage.pdf({ path: proofPath, preferCSSPageSize: true, printBackground: true });

    await pdfPage.close();

    const totalInteriorPages = 1 + renderedPages.length;
    const readmeText = [
      `Lulu Print-Ready Scorebook — ${args.team} (${formatSeasonLabel(args.season)})`,
      `================================================================`,
      ``,
      `Files generated:`,
      `  1. Cover.pdf             — Front & Back Cover (303.4mm x 216.4mm incl. 3.2mm bleed)`,
      `  2. Interior.pdf          — ${totalInteriorPages} pages (A4 Landscape 297mm x 210mm, 14mm alternating left/right coil gutter)`,
      `  3. Proof-With-Guides.pdf — Visual proof with red dashed 12.7mm coil punch zone overlay`,
      ``,
      `Recommended Lulu.com settings:`,
      `  - Book Size:     A4 Landscape (297 x 210 mm / 11.69 x 8.27 in)`,
      `  - Binding Type:  Coil Bound (Left Edge)`,
      `  - Interior:      Standard Color or Premium Color, 80# White Uncoated`,
      `  - Cover Finish:  Matte or Glossy`,
      ``,
      `Review Proof-With-Guides.pdf in macOS Preview first to confirm no text/borders enter the red coil punch zone.`,
      ``
    ].join('\n');
    fs.writeFileSync(path.join(outDir, 'LULU-SPECS.txt'), readmeText, 'utf8');

    const relDir = path.relative(repoRoot, outDir);
    console.log(`\nDone! Generated Lulu Book in ${relDir}/:`);
    console.log(`  - ${path.join(relDir, 'Cover.pdf')} (2 pages)`);
    console.log(`  - ${path.join(relDir, 'Interior.pdf')} (${totalInteriorPages} pages)`);
    console.log(`  - ${path.join(relDir, 'Proof-With-Guides.pdf')} (${totalInteriorPages} pages with coil/trim guides)`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Error building Lulu book:', err.message);
  process.exit(1);
});
