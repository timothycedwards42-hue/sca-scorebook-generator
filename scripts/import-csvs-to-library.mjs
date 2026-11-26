#!/usr/bin/env node
/**
 * Import a folder of PlayCricket Ball-by-Ball CSVs into data/seasons/<season>/<team>/
 * and rebuild data/index.json.
 *
 * Usage:
 *   node scripts/import-csvs-to-library.mjs \
 *     --dir downloads/summer-2026-27/north-shore-u13-1 \
 *     --season "2026-27" \
 *     --team "North Shore U13/1" \
 *     --comp "NSJCA Rep Teams"
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { dir: '', season: '', team: '', comp: '', club: '', grade: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir' && argv[i + 1]) args.dir = argv[++i];
    else if (a === '--season' && argv[i + 1]) args.season = argv[++i];
    else if (a === '--team' && argv[i + 1]) args.team = argv[++i];
    else if (a === '--comp' && argv[i + 1]) args.comp = argv[++i];
    else if (a === '--club' && argv[i + 1]) args.club = argv[++i];
    else if (a === '--grade' && argv[i + 1]) args.grade = argv[++i];
  }
  return args;
}

function slugify(str, fallback = 'unknown') {
  const s = String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

function splitCSVLine(line, delim = ',') {
  const res = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delim && !inQuotes) {
      res.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  res.push(cur);
  return res;
}

function cleanInningsLabel(raw) {
  return String(raw || '')
    .replace(/^\d+(?:st|nd|rd|th)\s+innings\s*[-–—:]\s*/i, '')
    .trim();
}

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

function parseFilenameMeta(fileName) {
  const base = fileName.replace(/\.csv$/i, '');
  const mIdx = base.match(/^(\d+)-/);
  const round = mIdx ? String(parseInt(mIdx[1], 10)) : '';
  const mDate = base.match(/(?:mon|tue|wed|thu|fri|sat|sun)-(\d{1,2})-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(\d{4})/i);
  let date = '';
  if (mDate) {
    const dd = mDate[1].padStart(2, '0');
    const mm = MONTHS[mDate[2].toLowerCase()] || '01';
    date = `${dd}/${mm}/${mDate[3]}`;
  }
  return { round, date };
}

function summarizeSideFromRows(sideNum, team, against, rows) {
  const batters = {};
  const batterOrder = [];
  const bowlers = {};
  const bowlerOrder = [];
  const deliveries = [];
  let byes = 0, legByes = 0, wides = 0, noBalls = 0, totalScore = 0, totalWickets = 0;
  const oversSet = new Set();

  // CSV is reverse-chronological; iterate chronologically
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const m = r.outcome.match(/^(.+?)\s+to\s+(.+?)\s*:\s*(.+)$/i);
    if (!m) continue;
    const bowler = m[1].trim();
    const batter = m[2].trim();
    const evRaw = m[3].trim();
    const ev = evRaw.toLowerCase();

    const overNum = parseInt(String(r.ball).split('.')[0], 10) + 1;
    if (!Number.isNaN(overNum)) oversSet.add(overNum);

    let batterRuns = 0, wideRuns = 0, nbRuns = 0, byeRuns = 0, lbRuns = 0;
    let isLegal = true, isWicket = false;

    if (!ev.includes('no run')) {
      const mRun = ev.match(/(\d+)\s*runs?/);
      if (mRun) batterRuns = parseInt(mRun[1], 10);
    }
    if (/\b\d*\s*wd\b|\bwide\b/.test(ev)) {
      const mw = ev.match(/\b(\d+)\s*wd\b/);
      wideRuns = mw ? parseInt(mw[1], 10) : 1;
      isLegal = false;
    }
    if (/\b\d*\s*nb\b|\bno\s*ball\b/.test(ev)) {
      const mn = ev.match(/\b(\d+)\s*nb\b/);
      nbRuns = mn ? parseInt(mn[1], 10) : 1;
      isLegal = false;
    }
    if (/\b\d*lb\b/.test(ev)) {
      const ml = ev.match(/(\d+)\s*lb/);
      lbRuns = ml ? parseInt(ml[1], 10) : 1;
    }
    if (/\b\d+b\b/.test(ev)) {
      const mb = ev.match(/(\d+)b\b/);
      byeRuns = mb ? parseInt(mb[1], 10) : 1;
    }
    if (ev.includes('dismissed') || /\bout\b/.test(ev)) {
      isWicket = true;
    }

    if (!batters[batter]) {
      batters[batter] = { name: batter, runs: 0, balls: 0, howOut: 'Not out', bowlerOut: '', isDNB: false, events: [] };
      batterOrder.push(batter);
    }
    if (!bowlers[bowler]) {
      bowlers[bowler] = { name: bowler, legalBalls: 0, maidens: 0, wides: 0, noBalls: 0, wickets: 0, runs: 0 };
      bowlerOrder.push(bowler);
    }

    const bat = batters[batter];
    const bwl = bowlers[bowler];

    byes += byeRuns;
    legByes += lbRuns;
    wides += wideRuns;
    noBalls += nbRuns;
    totalScore += batterRuns + wideRuns + nbRuns + byeRuns + lbRuns;

    if (wideRuns > 0) {
      bwl.wides += wideRuns;
      bwl.runs += wideRuns;
    } else if (nbRuns > 0) {
      bwl.noBalls += nbRuns;
      bwl.runs += nbRuns + batterRuns;
      bat.balls += 1;
      bat.runs += batterRuns;
      bat.events.push(batterRuns);
    } else {
      bat.balls += 1;
      bwl.legalBalls += 1;
      if (isWicket) {
        totalWickets += 1;
        bat.events.push(0);
        const mDis = evRaw.match(/^(.+?)\s+dismissed$/i);
        const outName = mDis ? mDis[1].trim() : batter;
        if (!batters[outName]) {
          batters[outName] = { name: outName, runs: 0, balls: 0, howOut: 'out', bowlerOut: '', isDNB: false, events: [] };
          batterOrder.push(outName);
        }
        const isRunOut = outName !== batter || ev.includes('run out') || ev.includes('run-out');
        batters[outName].howOut = isRunOut ? 'run out' : 'out';
        batters[outName].bowlerOut = isRunOut ? '' : bowler;
        if (!isRunOut) bwl.wickets += 1;
      } else {
        bat.runs += batterRuns;
        bat.events.push(batterRuns);
        bwl.runs += batterRuns;
      }
    }

    deliveries.push({
      over: overNum,
      ball: r.ball,
      score: String(r.score || '').replace('--', '/'),
      bowler,
      batter,
      batterRuns,
      wideRuns,
      nbRuns,
      byeRuns,
      lbRuns,
      extras: wideRuns + nbRuns + byeRuns + lbRuns,
      isLegal,
      isWicket
    });
  }

  return {
    side: sideNum,
    team,
    against,
    isStage1: false,
    totalScore,
    totalWickets,
    totalOvers: oversSet.size,
    extras: {
      byes,
      legByes,
      wides,
      noBalls,
      penalty: 0,
      total: byes + legByes + wides + noBalls
    },
    batters: batterOrder.map(n => batters[n]),
    bowlers: bowlerOrder.map(n => {
      const b = bowlers[n];
      const full = Math.floor(b.legalBalls / 6);
      const rem = b.legalBalls % 6;
      return {
        name: b.name,
        overs: rem === 0 ? `${full}` : `${full}.${rem}`,
        maidens: b.maidens,
        wides: b.wides,
        noBalls: b.noBalls,
        wickets: b.wickets,
        runs: b.runs
      };
    }),
    fow: [],
    deliveries
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir || !args.season || !args.team) {
    console.error('Usage: node scripts/import-csvs-to-library.mjs --dir <csv-folder> --season "2026-27" --team "North Shore U13/1" [--comp "..."] [--club "..."] [--grade "..."]');
    process.exit(1);
  }

  const srcDir = path.resolve(args.dir);
  const csvFiles = fs.readdirSync(srcDir).filter(f => f.toLowerCase().endsWith('.csv')).sort();
  if (csvFiles.length === 0) {
    console.error(`No .csv files found in ${srcDir}`);
    process.exit(1);
  }

  const seasonSlug = slugify(args.season, 'season');
  const teamSlug = slugify(args.team, 'team');
  const destDir = path.join(repoRoot, 'data', 'seasons', seasonSlug, teamSlug);
  fs.mkdirSync(destDir, { recursive: true });

  let imported = 0;

  for (const fileName of csvFiles) {
    const fullPath = path.join(srcDir, fileName);
    const rawCsv = fs.readFileSync(fullPath, 'utf8').replace(/^\uFEFF/, '');
    const lines = rawCsv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    const header = lines[0];
    const sideBuckets = new Map();
    const sideOrder = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = splitCSVLine(lines[i], ',');
      if (parts.length < 3) continue;
      const innLabel = (parts.slice(3).join(',') || 'Innings 1').trim();
      if (!sideBuckets.has(innLabel)) {
        sideBuckets.set(innLabel, { lines: [header], rows: [] });
        sideOrder.push(innLabel);
      }
      const bucket = sideBuckets.get(innLabel);
      bucket.lines.push(lines[i]);
      bucket.rows.push({
        ball: (parts[0] || '').trim(),
        score: (parts[1] || '').trim(),
        outcome: (parts[2] || '').trim(),
        innings: innLabel
      });
    }

    // PlayCricket lists 2nd innings first in reverse-chronological CSVs; sort so 1st Innings is Side 1
    sideOrder.sort((a, b) => {
      const a1 = /^1st\b/i.test(a) ? 0 : (/^2nd\b/i.test(a) ? 1 : 2);
      const b1 = /^1st\b/i.test(b) ? 0 : (/^2nd\b/i.test(b) ? 1 : 2);
      return a1 - b1;
    });

    const inn1Key = sideOrder[0] || '';
    const inn2Key = sideOrder[1] || '';
    const team1 = cleanInningsLabel(inn1Key) || args.team;
    const team2 = cleanInningsLabel(inn2Key) || 'Opponent';

    const { round, date } = parseFilenameMeta(fileName);
    const rdPrefix = round ? `Rd ${round}: ` : '';
    const dtSuffix = date ? ` (${date})` : '';
    const title = `${rdPrefix}${team1} vs ${team2}${dtSuffix}`;

    const teamWords = args.team.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    const matchScore = (name) => {
      const low = name.toLowerCase();
      return teamWords.reduce((acc, w) => acc + (low.includes(w) ? 1 : 0), 0);
    };
    const opponent = matchScore(team1) >= matchScore(team2) ? team2 : team1;
    const rdSlug = round ? `rd${round.padStart(2, '0')}` : 'match';
    const oppSlug = slugify(opponent, 'opponent');
    const dateSlug = date ? `-${slugify(date, '')}` : '';
    const jsonFileName = `${rdSlug}-vs-${oppSlug}${dateSlug}.json`;
    const id = `${seasonSlug}/${teamSlug}/${jsonFileName.replace(/\.json$/, '')}`;

    const b1 = sideBuckets.get(inn1Key) || { lines: [header], rows: [] };
    const b2 = sideBuckets.get(inn2Key) || { lines: [], rows: [] };

    const payload = {
      schemaVersion: 1,
      id,
      title,
      season: args.season,
      team: args.team,
      opponent,
      savedAt: new Date().toISOString(),
      match: {
        comp: args.comp || '',
        club: args.club || '',
        grade: args.grade || args.team,
        venue: '',
        toss: '',
        round,
        date,
        result: '',
        scorers: 'PlayCricket Ball-by-Ball CSV'
      },
      innings: [
        summarizeSideFromRows(1, team1, team2, b1.rows),
        summarizeSideFromRows(2, team2, team1, b2.rows)
      ],
      raw: {
        innings1: {
          label: team1,
          team: team1,
          against: team2,
          csv: b1.lines.join('\n'),
          scorecard: '',
          playhqText: '',
          matchFormat: 'auto',
          overRule: 'auto',
          dotFormat: 'grouped',
          preSplit: true,
          dismissalCount: 0
        },
        innings2: {
          label: team2,
          team: team2,
          against: team1,
          csv: b2.lines.length > 1 ? b2.lines.join('\n') : '',
          scorecard: '',
          playhqText: '',
          matchFormat: 'auto',
          overRule: 'auto',
          dotFormat: 'grouped',
          preSplit: true,
          dismissalCount: 0
        }
      }
    };

    const destPath = path.join(destDir, jsonFileName);
    fs.writeFileSync(destPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`Imported: ${path.relative(repoRoot, destPath)} (${title})`);
    imported++;
  }

  execFileSync(process.execPath, [path.join(__dirname, 'rebuild-index.mjs')], { stdio: 'inherit' });
  console.log(`\nDone! Imported ${imported} game(s) into data/seasons/${seasonSlug}/${teamSlug}/`);
}

main();
