#!/usr/bin/env node
/**
 * Parse a GitHub Issue Form body (or workflow_dispatch env vars), download games
 * from play.cricket.com.au, import them into data/seasons/, clean up downloads/,
 * and write a Markdown summary to SUMMARY_OUT (default: /tmp/sync-summary.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function parseIssueForm(body) {
  const fields = {};
  const sections = String(body || '').split(/^###\s+/m).slice(1);
  for (const sec of sections) {
    const lines = sec.split(/\r?\n/);
    const heading = (lines[0] || '').trim().toLowerCase();
    const val = lines.slice(1).join('\n').trim();
    const clean = /^_no response_$/i.test(val) ? '' : val;
    if (heading.startsWith('playcricket stats url') || heading.startsWith('playcricket url')) fields.url = clean;
    else if (heading.startsWith('organisation')) fields.org = clean;
    else if (heading === 'season') fields.season = clean;
    else if (heading.startsWith('grade')) fields.grade = clean;
    else if (heading.startsWith('team filter')) fields.team = clean;
    else if (heading.startsWith('library season')) fields.librarySeason = clean;
    else if (heading.startsWith('library team')) fields.libraryTeam = clean;
  }
  return fields;
}

function slugify(s, fallback = 'unknown') {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function deriveSeasonFolder(seasonStr) {
  const m = String(seasonStr || '').match(/(\d{4})\s*[\/\-]\s*(\d{2,4})/);
  if (m) return `${m[1]}-${m[2].slice(-2)}`;
  return slugify(seasonStr, '2026-27');
}

function runNode(scriptRel, args) {
  const res = spawnSync(process.execPath, [path.join(repoRoot, scriptRel), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || ''
  };
}

function writeSummary(md) {
  const outPath = process.env.SUMMARY_OUT || '/tmp/sync-summary.md';
  fs.writeFileSync(outPath, md + '\n', 'utf8');
  console.log(md);
}

function main() {
  const issueBody = process.env.ISSUE_BODY || '';
  const parsed = issueBody ? parseIssueForm(issueBody) : {};

  const url = (process.env.SYNC_URL || parsed.url || '').trim();
  const org = (process.env.SYNC_ORG || parsed.org || '').trim();
  const season = (process.env.SYNC_SEASON || parsed.season || '').trim();
  const grade = (process.env.SYNC_GRADE || parsed.grade || '').trim();
  const team = (process.env.SYNC_TEAM || parsed.team || '').trim();
  const librarySeason = (process.env.SYNC_LIBRARY_SEASON || parsed.librarySeason || deriveSeasonFolder(season)).trim();
  const libraryTeam = (process.env.SYNC_LIBRARY_TEAM || parsed.libraryTeam || team || grade || 'requested-team').trim();

  if (!url && (!org || !season || (!grade && !team))) {
    writeSummary([
      '❌ **Sync could not run — missing required fields.**',
      '',
      'Provide either a **PlayCricket Stats URL** OR **Organisation + Season + Grade/Team**:',
      `- PlayCricket Stats URL: \`${url || '(none)'}\``,
      `- Organisation: \`${org || '(missing)'}\``,
      `- Season: \`${season || '(missing)'}\``,
      `- Grade / Club Team: \`${grade || '(missing)'}\``,
      '',
      'Please edit the issue body and re-apply the `approved` label.'
    ].join('\n'));
    process.exit(1);
  }

  const outDir = path.join(repoRoot, 'downloads', slugify(librarySeason), slugify(libraryTeam));
  const dlArgs = ['--out', outDir, '--delay', '800'];
  if (url) {
    dlArgs.push('--url', url);
  } else {
    dlArgs.push('--org', org, '--season', season);
    if (grade) dlArgs.push('--grade', grade);
  }
  if (team) dlArgs.push('--team', team);

  console.log(url
    ? `Downloading from URL: "${url}" team="${team}"`
    : `Downloading: org="${org}" season="${season}" grade="${grade}" team="${team}"`);
  const dl = runNode('scripts/download-playcricket-csvs.mjs', dlArgs);
  if (dl.status !== 0) {
    const errText = (dl.stderr || dl.stdout || 'Unknown error').trim().slice(-2000);
    writeSummary([
      '❌ **PlayCricket download failed**',
      '',
      ...(url
        ? [`- **URL:** ${url}`]
        : [
            `- **Organisation:** ${org}`,
            `- **Season:** ${season}`,
            `- **Grade / Team:** ${grade}${team ? ` (filter: ${team})` : ''}`
          ]),
      '',
      '```',
      errText,
      '```',
      '',
      'The `approved` label has been removed automatically. Update the issue and click **`approved`** once to retry.'
    ].join('\n'));
    process.exit(1);
  }

  const impArgs = [
    '--dir', outDir,
    '--season', librarySeason,
    '--team', libraryTeam
  ];
  if (org) impArgs.push('--club', org);
  if (grade) impArgs.push('--grade', grade);
  if (process.env.SYNC_LIBRARY_TEAM || parsed.libraryTeam) impArgs.push('--force-team');

  console.log(`Importing from ${outDir} -> ${librarySeason} / ${libraryTeam}`);
  const imp = runNode('scripts/import-csvs-to-library.mjs', impArgs);
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}

  if (imp.status !== 0) {
    const errText = (imp.stderr || imp.stdout || 'Unknown import error').trim().slice(-2000);
    writeSummary([
      '❌ **Import into Match Library failed**',
      '',
      '```',
      errText,
      '```'
    ].join('\n'));
    process.exit(1);
  }

  const importedLines = imp.stdout
    .split(/\r?\n/)
    .filter(l => /^(Imported:|Enriched existing game|\[NOTICE\]|Done!|Updated )/.test(l.trim()))
    .slice(0, 30);

  writeSummary([
    '✅ **PlayCricket Team Sync Complete!**',
    '',
    `- **Organisation:** ${org}`,
    `- **Season:** ${season} (\`${librarySeason}\`)`,
    `- **Grade / Team:** ${grade}${team ? ` (filter: ${team})` : ''}`,
    '',
    '```',
    importedLines.join('\n') || 'Completed.',
    '```',
    '',
    'GitHub Pages will redeploy automatically within ~1–2 minutes.'
  ].join('\n'));
}

main();
