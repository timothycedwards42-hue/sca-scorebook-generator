#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const seasonsDir = path.join(repoRoot, 'data', 'seasons');
const indexPath = path.join(repoRoot, 'data', 'index.json');

function walkJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJsonFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

const files = walkJsonFiles(seasonsDir);
const games = [];

for (const file of files) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const g = JSON.parse(raw);
    const relPath = path.relative(repoRoot, file).split(path.sep).join('/');
    const parts = relPath.split('/'); // data/seasons/<season>/<team>/<file>.json
    const season = g.season || parts[2] || 'unknown';
    const team = g.team || parts[3] || 'unknown';
    const opponent = g.opponent || (g.innings && g.innings[0] && g.innings[0].against) || '';
    const round = (g.match && g.match.round) || '';
    const date = (g.match && g.match.date) || '';
    const result = (g.match && g.match.result) || '';
    const rdPrefix = round ? `Rd ${round}: ` : '';
    const dtSuffix = date ? ` (${date})` : '';
    const title = g.title || `${rdPrefix}${team}${opponent ? ' vs ' + opponent : ''}${dtSuffix}`;

    games.push({
      id: g.id || relPath.replace(/^data\/seasons\//, '').replace(/\.json$/, ''),
      path: relPath,
      season,
      team,
      opponent,
      round,
      date,
      result,
      title,
      savedAt: g.savedAt || fs.statSync(file).mtime.toISOString()
    });
  } catch (err) {
    console.error(`Skipping invalid JSON file ${file}: ${err.message}`);
  }
}

games.sort((a, b) => {
  if (a.season !== b.season) return b.season.localeCompare(a.season);
  if (a.team !== b.team) return a.team.localeCompare(b.team);
  const ra = parseInt(a.round, 10);
  const rb = parseInt(b.round, 10);
  if (!Number.isNaN(ra) && !Number.isNaN(rb) && ra !== rb) return ra - rb;
  return (a.date || '').localeCompare(b.date || '') || a.title.localeCompare(b.title);
});

const out = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  games
};

fs.mkdirSync(path.dirname(indexPath), { recursive: true });
fs.writeFileSync(indexPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`Updated ${indexPath} with ${games.length} game(s).`);
