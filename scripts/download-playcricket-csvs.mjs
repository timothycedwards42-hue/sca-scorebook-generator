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
    org: '',
    season: '',
    grade: '',
    team: '',
    out: '',
    delay: 2000,
    headed: false,
    listOnly: false,
    overwrite: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--headed') args.headed = true;
    else if (a === '--list-only') args.listOnly = true;
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--org' && argv[i + 1]) args.org = argv[++i];
    else if (a === '--season' && argv[i + 1]) args.season = argv[++i];
    else if (a === '--grade' && argv[i + 1]) args.grade = argv[++i];
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

function findMatchingOption(options, query) {
  const q = normalizeMatchText(query);
  if (!q) return null;
  const exact = options.find(o => normalizeMatchText(o) === q);
  if (exact) return exact;
  const partial = options.filter(o => normalizeMatchText(o).includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return partial[0];
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

async function selectCustomDropdown(page, labelName, query) {
  const trigger = page.getByRole('button', { name: labelName, exact: true });
  await waitForEnabled(trigger, 15000);
  await trigger.click();

  const scope = await getDropdownScope(page, trigger);
  const { opts, texts } = await readOpenOptions(scope);
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
  await opts.nth(idx).click();
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

  args = await promptMissingArgs(args);
  if (!args.org || !args.season || (!args.grade && !args.team)) {
    console.error('Error: --org, --season, and --grade (or --team) are required. Run with --help for usage.');
    process.exit(1);
  }

  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    console.error('Playwright is not installed yet. Run:\n  npm install && npx playwright install chromium');
    process.exit(1);
  }

  const browser = await playwright.chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
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

    const chosenSeason = await selectCustomDropdown(page, 'Season', args.season);
    console.log(`Season:       ${chosenSeason}`);
    await page.waitForTimeout(800);

    // Associations expose a "Grade" dropdown; Clubs expose a "Team" dropdown
    const gradeBtn = page.getByRole('button', { name: 'Grade', exact: true });
    const teamBtn = page.getByRole('button', { name: 'Team', exact: true });
    let thirdLabel = 'Grade';
    const hasTeamBtn = await teamBtn.isVisible().catch(() => false);
    const hasGradeBtn = await gradeBtn.isVisible().catch(() => false);
    if (hasTeamBtn && !hasGradeBtn) thirdLabel = 'Team';

    const thirdQuery = thirdLabel === 'Team' ? (args.team || args.grade) : (args.grade || args.team);
    const chosenThird = await selectCustomDropdown(page, thirdLabel, thirdQuery);
    console.log(`${(thirdLabel + ':').padEnd(14)}${chosenThird}`);
    await page.waitForTimeout(1000);

    const allMatches = await listMatchesInDropdown(page);
    const matchFilter = (thirdLabel === 'Grade' && args.team) ? args.team : '';
    const matches = matchFilter
      ? allMatches.filter(m => normalizeMatchText(m).includes(normalizeMatchText(matchFilter)))
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

      if (!args.overwrite && fs.existsSync(outFile)) {
        console.log(`[${i + 1}/${matches.length}] Skipping (exists): ${fileName}`);
        skipped++;
        continue;
      }

      let ok = false;
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`[${i + 1}/${matches.length}] Downloading${attempt > 1 ? ' (retry)' : ''}: ${matchName}`);
          await downloadSingleMatch(page, matchName, outFile);
          downloaded++;
          ok = true;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < 2) await page.waitForTimeout(1500);
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

    console.log(`\nDone! Downloaded: ${downloaded}, Skipped: ${skipped}, Failed: ${failed.length}`);
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
