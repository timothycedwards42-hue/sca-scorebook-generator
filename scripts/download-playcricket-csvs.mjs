#!/usr/bin/env node
/**
 * Download Ball-by-Ball CSV reports from https://play.cricket.com.au/stats
 *
 * Usage:
 *   npm run download-csvs -- --org "Mosman" --season "2025/26" --grade "U10" --team "Mosman U10 Boland"
 *
 * Options:
 *   --org <name>        Association or Club name (matched case-insensitively)
 *   --season <name>     Season label (e.g. "2025/26" or "2025-26")
 *   --grade <name>      Grade / Competition name (substring match)
 *   --team <name>       Optional team filter applied to Match names (substring match)
 *   --out <dir>         Output directory (default: downloads/<season>/<team-or-grade>)
 *   --delay <ms>        Delay between match downloads in ms (default: 2000)
 *   --headed            Show browser window while running
 *   --list-only         List matched games without downloading CSVs
 *   --overwrite         Re-download CSVs even if the file already exists
 *   --help              Show this help message
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const STATS_URL = 'https://play.cricket.com.au/stats?cat=ballByBall';

function parseArgs(argv) {
  const args = {
    url: '',
    org: '',
    season: '',
    grade: '',
    gradeIndex: -1,
    team: '',
    out: '',
    delay: 2000,
    headed: false,
    listOnly: false,
    overwrite: false,
    csvOnly: false,
    scrapeMatch: '',
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--headed') args.headed = true;
    else if (a === '--list-only') args.listOnly = true;
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--csv-only') args.csvOnly = true;
    else if (a === '--url' && argv[i + 1]) args.url = argv[++i];
    else if (a === '--scrape-match' && argv[i + 1]) args.scrapeMatch = argv[++i];
    else if (a === '--org' && argv[i + 1]) args.org = argv[++i];
    else if (a === '--season' && argv[i + 1]) args.season = argv[++i];
    else if (a === '--grade' && argv[i + 1]) args.grade = argv[++i];
    else if (a === '--grade-index' && argv[i + 1]) args.gradeIndex = parseInt(argv[++i], 10);
    else if (a === '--team' && argv[i + 1]) args.team = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--delay' && argv[i + 1]) args.delay = Math.max(500, parseInt(argv[++i], 10) || 2000);
  }
  return args;
}

function printHelp() {
  console.log(`
PlayCricket Ball-by-Ball CSV Downloader

Usage:
  npm run download-csvs -- --org "Mosman" --season "2025/26" --grade "U10" [--team "Mosman U10 Boland"]

Options:
  --org <name>        Association or Club name (searched in "Search Organisations")
  --season <name>     Season label (e.g. "2025/26")
  --grade <name>      Grade name (partial or exact match)
  --team <name>       Optional team name to filter matches in the grade
  --out <dir>         Output directory (default: downloads/<season>/<team-or-grade>)
  --delay <ms>        Pause between match downloads in ms (default: 2000)
  --headed            Show the Chromium browser window
  --list-only         Print matching games without downloading
  --overwrite         Overwrite existing CSV files (default skips already-downloaded files)
  --help              Show this help
`.trim());
}

function slugify(str, fallback = 'unknown') {
  const s = String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

function normalizeMatchText(s) {
  return String(s || '').toLowerCase().replace(/[\/\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonicalizeTokens(s) {
  const cleaned = String(s || '')
    .toLowerCase()
    .replace(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)\b/g, '$1$2$3')
    .replace(/\b(\d{1,2})\s*(am|pm)\b/g, '$1$2')
    .replace(/\bu\s+(\d+)\b/g, 'u$1')
    .replace(/\bstage\s*(\d+)\b/g, 's$1')
    .replace(/\bdiv(?:ision)?\s*(\d+)\b/g, 'd$1')
    .replace(/\bovers\b/g, 'over')
    .replace(/\bsat\b/g, 'saturday')
    .replace(/\bsun\b/g, 'sunday')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return cleaned ? cleaned.split(/\s+/) : [];
}

function tokensMatchAll(candidateStr, queryStr) {
  const qTokens = canonicalizeTokens(queryStr);
  if (qTokens.length === 0) return false;
  const cSet = new Set(canonicalizeTokens(candidateStr));
  return qTokens.every(t => cSet.has(t));
}

function findMatchingOption(options, query) {
  const q = normalizeMatchText(query);
  if (!q) return null;
  // 1. Exact normalized match
  const exact = options.find(o => normalizeMatchText(o) === q);
  if (exact) return exact;
  // 2. Substring match
  const partial = options.filter(o => normalizeMatchText(o).includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return partial[0];
  // 3. Word-order-insensitive canonical token match (e.g. "S3 U15" or "U15 20 Overs" -> "Saturday 3.30pm U15 S3 20 Over")
  const tokenMatches = options.filter(o => tokensMatchAll(o, query));
  if (tokenMatches.length === 1) return tokenMatches[0];
  if (tokenMatches.length > 1) {
    // Prefer a unique option with the fewest extra tokens
    const scored = tokenMatches
      .map(o => ({ opt: o, len: canonicalizeTokens(o).length }))
      .sort((a, b) => a.len - b.len);
    if (scored[0].len < scored[1].len) return scored[0].opt;
  }
  return null;
}

async function promptMissingArgs(args) {
  if (args.org && args.season && (args.grade || args.team)) return args;
  const rl = readline.createInterface({ input, output });
  try {
    if (!args.org) args.org = (await rl.question('Association / Club name: ')).trim();
    if (!args.season) args.season = (await rl.question('Season (e.g. 2025/26): ')).trim();
    if (!args.grade && !args.team) args.grade = (await rl.question('Grade or Team name (partial match ok): ')).trim();
    if (!args.team) args.team = (await rl.question('Optional Match team filter (press Enter to skip): ')).trim();
  } finally {
    rl.close();
  }
  return args;
}

async function waitForEnabled(locator, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false)) {
      return;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for control to become enabled.`);
}

async function readOpenOptions(scopeLocator) {
  const opts = scopeLocator.locator('[role="option"]:visible');
  await opts.first().waitFor({ state: 'visible', timeout: 10000 });
  const count = await opts.count();
  const texts = [];
  for (let i = 0; i < count; i++) {
    const t = (await opts.nth(i).innerText()).trim();
    if (t) texts.push(t);
  }
  return { opts, texts };
}

async function getDropdownScope(page, trigger) {
  const controlsId = await trigger.getAttribute('aria-controls').catch(() => null);
  if (controlsId) {
    const controlled = page.locator(`#${controlsId}`);
    if (await controlled.count().catch(() => 0) > 0) return controlled;
  }
  return page;
}

async function selectCustomDropdown(page, labelName, query, exactIdx = -1) {
  const trigger = page.getByRole('button', { name: labelName, exact: true });
  await waitForEnabled(trigger, 15000);
  await trigger.click({ force: true, timeout: 10000 });

  const scope = await getDropdownScope(page, trigger);
  const { opts, texts } = await readOpenOptions(scope);
  if (exactIdx >= 0 && exactIdx < texts.length) {
    await opts.nth(exactIdx).click({ force: true, timeout: 10000 });
    return texts[exactIdx];
  }
  const chosen = findMatchingOption(texts, query);
  if (!chosen) {
    await page.keyboard.press('Escape').catch(() => {});
    const preview = texts.slice(0, 25).map(t => `  - ${t}`).join('\n');
    const more = texts.length > 25 ? `\n  ... and ${texts.length - 25} more` : '';
    throw new Error(
      `Could not find "${query}" in "${labelName}" dropdown.\nAvailable options:\n${preview}${more}`
    );
  }

  const idx = texts.indexOf(chosen);
  await opts.nth(idx).click({ force: true, timeout: 10000 });
  return chosen;
}

async function selectOrganisation(page, orgQuery) {
  const searchBox = page.locator('#stats-org-search');
  await searchBox.waitFor({ state: 'visible', timeout: 15000 });
  await searchBox.click();
  // PlayCricket's #stats-org-search input has maxlength="20"
  const typed = orgQuery.trim().slice(0, 20);
  await searchBox.fill(typed);

  const listbox = page.locator('[role="listbox"]:visible').first();
  await listbox.waitFor({ state: 'visible', timeout: 10000 });
  const { opts, texts } = await readOpenOptions(listbox);
  const chosen = findMatchingOption(texts, orgQuery);
  if (!chosen) {
    const preview = texts.slice(0, 20).map(t => `  - ${t}`).join('\n');
    throw new Error(
      `Could not find organisation matching "${orgQuery}".\nMatching results:\n${preview}`
    );
  }
  const idx = texts.indexOf(chosen);
  await opts.nth(idx).click();
  return chosen;
}

async function listMatchesInDropdown(page) {
  const trigger = page.getByRole('button', { name: 'Match', exact: true });
  await waitForEnabled(trigger, 15000);
  await trigger.click();
  const scope = await getDropdownScope(page, trigger);
  const { texts } = await readOpenOptions(scope);
  await page.keyboard.press('Escape').catch(() => {});
  return texts.filter(t => !/^select match$/i.test(t));
}

async function downloadSingleMatch(page, matchName, outFile) {
  const trigger = page.getByRole('button', { name: 'Match', exact: true });
  await waitForEnabled(trigger, 15000);
  await trigger.click();

  const scope = await getDropdownScope(page, trigger);
  const { opts, texts } = await readOpenOptions(scope);
  const idx = texts.indexOf(matchName);
  if (idx === -1) {
    await page.keyboard.press('Escape').catch(() => {});
    throw new Error(`Match "${matchName}" not found in Match dropdown.`);
  }
  await opts.nth(idx).click();

  // Click Generate report if enabled (some views auto-load on match select)
  const genBtn = page.getByRole('button', { name: /generate report/i });
  await page.waitForTimeout(500);
  if (await genBtn.isVisible().catch(() => false) && await genBtn.isEnabled().catch(() => false)) {
    await genBtn.click();
  }

  // Wait for Export / Download toolbar button in the MUI DataGrid
  const exportBtn = page.getByRole('button', { name: 'Export' });
  await exportBtn.waitFor({ state: 'visible', timeout: 20000 });
  await exportBtn.click();

  const csvMenuItem = page.getByRole('menuitem', { name: /comma-separated values \(csv\)/i });
  await csvMenuItem.waitFor({ state: 'visible', timeout: 10000 });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    csvMenuItem.click()
  ]);

  await download.saveAs(outFile);
  let matchId = '';
  try {
    matchId = new URL(page.url()).searchParams.get('matchId') || '';
  } catch {}
  return matchId;
}

async function scrapeMatchPage(matchPage, matchId) {
  const baseUrl = `https://play.cricket.com.au/match/${matchId}`;
  await matchPage.goto(`${baseUrl}?tab=scorecard`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await matchPage.locator('table[aria-label="Batting players"]').first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
  await matchPage.waitForTimeout(1000);

  // Extract match summary info (result / venue) from page header text
  const headerInfo = await matchPage.evaluate(() => {
    const bodyText = document.body ? document.body.innerText : '';
    const lines = bodyText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let result = '';
    for (const l of lines.slice(0, 35)) {
      if (/\b(won by|tied|draw|abandoned|no result|washout)\b/i.test(l) && l.length < 120) {
        result = l;
        break;
      }
    }
    return { result };
  });

  const extractCurrentScorecard = async () => {
    return await matchPage.evaluate(() => {
      const readTableRows = (ariaLabel) => {
        const tbl = document.querySelector(`table[aria-label="${ariaLabel}"]`);
        if (!tbl) return [];
        const rows = [];
        tbl.querySelectorAll('tbody tr').forEach(tr => {
          const cells = Array.from(tr.querySelectorAll('th, td'))
            .filter(td => window.getComputedStyle(td).display !== 'none')
            .map(td => (td.innerText || '').trim());
          if (cells.length > 0 && cells.some(Boolean)) rows.push(cells);
        });
        return rows;
      };

      const batRows = readTableRows('Batting players');
      const bowlRows = readTableRows('Bowling players');
      const fieldRows = readTableRows('Fielding players');

      // Try to read total/extras text from the scorecard panel
      const panelText = (document.querySelector('main')?.innerText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      let totalLine = '';
      let oversLine = '';
      let extrasLine = '';
      for (let i = 0; i < panelText.length; i++) {
        if (/^extras$/i.test(panelText[i]) && panelText[i + 1]) {
          extrasLine = panelText[i + 1];
        }
        if (/^total$/i.test(panelText[i]) && panelText[i + 1]) {
          totalLine = panelText[i + 1];
          if (panelText[i + 2] && /overs?/i.test(panelText[i + 2])) oversLine = panelText[i + 2];
        }
      }

      // Active innings radio label
      const checkedRadio = document.querySelector('[role="radiogroup"] input[type="radio"]:checked, [role="radiogroup"] [role="radio"][aria-checked="true"]');
      const radioContainer = checkedRadio ? (checkedRadio.closest('label') || checkedRadio) : null;
      const radioLabel = radioContainer ? (radioContainer.innerText || checkedRadio.getAttribute('aria-label') || '').trim() : '';

      return { batRows, bowlRows, fieldRows, extrasLine, totalLine, oversLine, radioLabel };
    });
  };

  const formatScorecardText = (raw, batTeamName, bowlTeamName) => {
    const out = [];
    if (raw.batRows.length > 0) {
      out.push(`${batTeamName || 'Innings'} Batting`, 'Batters', 'R', 'B', '4S', '6s', 'SR');
      raw.batRows.forEach(cells => {
        // PlayCricket 1280px visible columns: [Name, Dismissal, R, B, 4s, 6s, SR]
        // (If only 6 cells, Name+Dismissal are combined in cell 0)
        let name = '';
        let dismissal = '';
        let statOffset = 2;
        if (cells.length >= 7) {
          name = String(cells[0] || '').split(/\r?\n/)[0].trim();
          dismissal = String(cells[1] || '').replace(/\s+/g, ' ').trim();
          statOffset = 2;
        } else {
          const firstLines = String(cells[0] || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
          name = firstLines[0] || '';
          dismissal = firstLines.slice(1).join(' ');
          statOffset = 1;
        }
        if (!name || /^(extras|total)$/i.test(name)) return;
        if (/^did not bat$/i.test(dismissal)) return;
        if (!dismissal) dismissal = 'not out';
        const r = cells[statOffset] ?? '-';
        const b = cells[statOffset + 1] ?? '-';
        const f4 = cells[statOffset + 2] ?? '0';
        const s6 = cells[statOffset + 3] ?? '0';
        const sr = cells[statOffset + 4] ?? '0.00';
        out.push(name, dismissal, r, b, f4, s6, sr);
      });
      if (raw.extrasLine) out.push('Extras', raw.extrasLine);
      if (raw.totalLine) {
        out.push('Total', raw.totalLine);
        if (raw.oversLine) out.push(raw.oversLine);
      }
    }
    if (raw.bowlRows.length > 0) {
      out.push(`${bowlTeamName || 'Opposition'} Bowling`, 'Bowlers', 'O', 'M', 'R', 'W', 'HT', 'E', 'WD', 'NB');
      raw.bowlRows.forEach(cells => {
        const name = String(cells[0] || '').split(/\r?\n/)[0].trim();
        if (!name) return;
        const o = cells[1] ?? '0';
        const m = cells[2] ?? '0';
        const r = cells[3] ?? '0';
        const w = cells[4] ?? '0';
        const econ = cells[5] ?? '0.00';
        const wd = cells[6] ?? '0';
        const nb = cells[7] ?? '0';
        if ((parseFloat(o) || 0) === 0 && (parseInt(r, 10) || 0) === 0 && (parseInt(w, 10) || 0) === 0 && (parseInt(wd, 10) || 0) === 0 && (parseInt(nb, 10) || 0) === 0) {
          return;
        }
        out.push(name, o, m, r, w, '0', econ, wd, nb);
      });
    }
    if (raw.fieldRows.length > 0) {
      out.push('Fielders', 'CF', 'CWK', 'ROU', 'ROA', 'S');
      raw.fieldRows.forEach(cells => {
        const name = String(cells[0] || '').split(/\r?\n/)[0].trim();
        if (!name) return;
        const c = cells[1] ?? '0';
        const ro = cells[2] ?? '0';
        const st = cells[3] ?? '0';
        out.push(name, c, '0', ro, '0', st);
      });
    }
    return out.join('\n');
  };

  const getInningsRadios = async () => {
    const byRole = matchPage.getByRole('radio');
    const c1 = await byRole.count().catch(() => 0);
    if (c1 >= 2) return { locator: byRole, count: c1 };
    const byLabel = matchPage.locator('[role="radiogroup"] label');
    const c2 = await byLabel.count().catch(() => 0);
    if (c2 >= 2) return { locator: byLabel, count: c2 };
    return { locator: byRole, count: Math.max(1, c1) };
  };

  const scRadios = await getInningsRadios();
  const rawScorecards = [];

  for (let idx = 0; idx < Math.min(scRadios.count, 2); idx++) {
    if (scRadios.count > 1) {
      await scRadios.locator.nth(idx).click({ force: true, timeout: 8000 }).catch(() => {});
      await matchPage.waitForTimeout(800);
    }
    rawScorecards.push(await extractCurrentScorecard());
  }

  // Switch to Ball-by-Ball tab
  const bbbTexts = [];
  const bbbTab = matchPage.getByRole('tab', { name: /ball by ball/i });
  if (await bbbTab.isVisible().catch(() => false)) {
    await bbbTab.click({ force: true, timeout: 8000 }).catch(() => {});
    await matchPage.waitForTimeout(1000);

    const bbbRadios = await getInningsRadios();
    for (let idx = 0; idx < Math.min(bbbRadios.count, 2); idx++) {
      if (bbbRadios.count > 1) {
        await bbbRadios.locator.nth(idx).click({ force: true, timeout: 8000 }).catch(() => {});
        await matchPage.waitForTimeout(800);
      }
      const bbbText = await matchPage.evaluate(() => {
        const articles = Array.from(document.querySelectorAll('article'));
        if (articles.length > 0) {
          return articles.map(a => (a.innerText || '').trim()).filter(Boolean).join('\n');
        }
        return '';
      });
      bbbTexts.push(bbbText);
    }
  }

  const innings = rawScorecards.map((raw, idx) => ({
    index: idx + 1,
    radioLabel: raw.radioLabel,
    scorecard: formatScorecardText(raw, raw.radioLabel || `Innings ${idx + 1}`, ''),
    playhqText: bbbTexts[idx] || ''
  }));

  return {
    matchId,
    url: `${baseUrl}?tab=scorecard`,
    result: headerInfo.result || '',
    innings
  };
}

async function saveErrorScreenshot(page, label) {
  try {
    const errDir = path.resolve('errors');
    fs.mkdirSync(errDir, { recursive: true });
    const file = path.join(errDir, `${slugify(label, 'error')}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

async function main() {
  let args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.scrapeMatch && !args.url) {
    args = await promptMissingArgs(args);
    if (!args.org || !args.season || (!args.grade && !args.team)) {
      console.error('Error: --org, --season, and --grade (or --team) are required (or pass --url). Run with --help for usage.');
      process.exit(1);
    }
  }

  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    console.error('Playwright is not installed yet. Run:\n  npm install && npx playwright install chromium');
    process.exit(1);
  }

  const browser = await playwright.chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  const matchPage = await context.newPage();

  if (args.scrapeMatch) {
    try {
      const scraped = await scrapeMatchPage(matchPage, args.scrapeMatch);
      if (args.out) {
        fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
        fs.writeFileSync(path.resolve(args.out), JSON.stringify(scraped, null, 2) + '\n', 'utf8');
        console.log(`Scraped ${args.scrapeMatch} -> ${args.out} (${scraped.innings.length} innings)`);
      } else {
        console.log(JSON.stringify(scraped, null, 2));
      }
    } finally {
      await browser.close();
    }
    return;
  }

  try {
    let chosenSeason = args.season || 'season';
    let chosenThird = args.grade || args.team || 'team';
    let thirdLabel = 'Grade';

    if (args.url) {
      let targetUrl = args.url.trim();
      try {
        const u = new URL(targetUrl);
        if (!u.searchParams.get('cat')) u.searchParams.set('cat', 'ballByBall');
        targetUrl = u.toString();
      } catch {}
      console.log(`Opening direct stats URL: ${targetUrl} ...`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForEnabled(page.getByRole('button', { name: 'Match', exact: true }), 20000);
      await page.waitForTimeout(1000);
    } else {
      console.log(`Opening ${STATS_URL} ...`);
      await page.goto(STATS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Confirm Ball by Ball is active; select it if needed
      const orgInput = page.locator('#stats-org-search');
      const orgReady = await orgInput.waitFor({ state: 'visible', timeout: 12000 }).then(() => true).catch(() => false);
      if (!orgReady) {
        await selectCustomDropdown(page, 'Category', 'Ball by Ball');
      }

      const chosenOrg = await selectOrganisation(page, args.org);
      console.log(`Organisation: ${chosenOrg}`);
      await page.waitForTimeout(800);

      chosenSeason = await selectCustomDropdown(page, 'Season', args.season);
      console.log(`Season:       ${chosenSeason}`);
      await page.waitForTimeout(1400);

      // Associations expose a "Grade" dropdown; Clubs expose a "Team" dropdown
      const gradeBtn = page.getByRole('button', { name: 'Grade', exact: true });
      const teamBtn = page.getByRole('button', { name: 'Team', exact: true });
      const hasTeamBtn = await teamBtn.isVisible().catch(() => false);
      const hasGradeBtn = await gradeBtn.isVisible().catch(() => false);
      if (hasTeamBtn && !hasGradeBtn) thirdLabel = 'Team';

      const thirdQuery = thirdLabel === 'Team' ? (args.team || args.grade) : (args.grade || args.team);
      chosenThird = await selectCustomDropdown(page, thirdLabel, thirdQuery, args.gradeIndex);
      console.log(`${(thirdLabel + ':').padEnd(14)}${chosenThird}`);
      await page.waitForTimeout(1000);
    }

    const allMatches = await listMatchesInDropdown(page);
    const matchFilter = ((args.url || thirdLabel === 'Grade') && args.team) ? args.team : '';
    const matches = matchFilter
      ? allMatches.filter(m => normalizeMatchText(m).includes(normalizeMatchText(matchFilter)) || tokensMatchAll(m, matchFilter))
      : allMatches;

    console.log(`Found ${matches.length} matching game(s)${matchFilter ? ` for "${matchFilter}"` : ''} (out of ${allMatches.length} available).`);

    if (matches.length === 0) {
      if (allMatches.length > 0) {
        console.log('Available matches:');
        allMatches.forEach(m => console.log(`  - ${m}`));
      }
      process.exit(0);
    }

    if (args.listOnly) {
      matches.forEach((m, i) => console.log(`${i + 1}. ${m}`));
      process.exit(0);
    }

    const outDir = args.out
      ? path.resolve(args.out)
      : path.resolve('downloads', slugify(chosenSeason), slugify(matchFilter || chosenThird));
    fs.mkdirSync(outDir, { recursive: true });
    console.log(`Saving CSVs to: ${outDir}\n`);

    let downloaded = 0;
    let skipped = 0;
    const failed = [];

    for (let i = 0; i < matches.length; i++) {
      const matchName = matches[i];
      const fileName = `${String(i + 1).padStart(2, '0')}-${slugify(matchName, 'match')}.csv`;
      const outFile = path.join(outDir, fileName);
      const sidecarFile = outFile.replace(/\.csv$/i, '.playhq.json');

      const csvExists = fs.existsSync(outFile);
      const sidecarExists = fs.existsSync(sidecarFile);

      if (!args.overwrite && csvExists && (args.csvOnly || sidecarExists)) {
        console.log(`[${i + 1}/${matches.length}] [NOTICE] Already downloaded — ignored: ${fileName}`);
        skipped++;
        continue;
      }

      let ok = false;
      let lastErr = null;
      let matchId = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`[${i + 1}/${matches.length}] Downloading${attempt > 1 ? ' (retry)' : ''}: ${matchName}`);
          matchId = await downloadSingleMatch(page, matchName, outFile);
          downloaded++;
          ok = true;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < 2) await page.waitForTimeout(1500);
        }
      }

      if (ok && !args.csvOnly && matchId && (args.overwrite || !sidecarExists)) {
        try {
          console.log(`  Fetching Scorecard & Ball-by-Ball (matchId: ${matchId})...`);
          const scraped = await scrapeMatchPage(matchPage, matchId);
          fs.writeFileSync(sidecarFile, JSON.stringify(scraped, null, 2) + '\n', 'utf8');
        } catch (err) {
          console.warn(`  [WARN] Could not scrape match page for ${matchId}: ${err.message}`);
        }
      }

      if (!ok) {
        const shot = await saveErrorScreenshot(page, matchName);
        console.error(`  FAILED: ${lastErr?.message || lastErr}${shot ? ` (screenshot: ${shot})` : ''}`);
        failed.push({ matchName, error: lastErr?.message || String(lastErr) });
      }

      if (i < matches.length - 1) {
        await page.waitForTimeout(args.delay);
      }
    }

    console.log(`\nDone! Downloaded: ${downloaded}, Ignored (already downloaded): ${skipped}, Failed: ${failed.length}`);
    if (skipped > 0) {
      console.log(`[NOTICE] ${skipped} CSV file(s) were already downloaded and ignored (pass --overwrite to re-download).`);
    }
    if (failed.length > 0) {
      console.error('Failed matches:');
      failed.forEach(f => console.error(`  - ${f.matchName}: ${f.error}`));
      process.exitCode = 1;
    }
  } catch (err) {
    const shot = await saveErrorScreenshot(page, 'fatal');
    console.error(`\nError: ${err.message}`);
    if (shot) console.error(`Saved diagnostic screenshot: ${shot}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
