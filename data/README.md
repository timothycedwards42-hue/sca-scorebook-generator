# Cricket Match Data Archive (`data/`)

This folder stores individual cricket matches as structured JSON files organised by **season** and **team**, so they can be:

- Reloaded into `index.html` at any time (locally or on GitHub Pages)
- Combined into a multi-game **Season Scorebook PDF**
- Analysed externally for **season averages**, **player career stats**, or **coach's reports**

## Folder Layout

```text
data/
  index.json                              # Auto-maintained catalog read by index.html
  seasons/
    <season-slug>/                        # e.g. 2025-26/
      <team-slug>/                        # e.g. mosman-u10-boland/
        rd01-vs-mosman-u10-mccabe.json    # One reusable JSON file per match
```

## Adding Games

1. Open `index.html` and load a match (CSV, PlayHQ scorecard, ball-by-ball text, and match details).
2. In the **Match Library (Repo `data/seasons/`)** panel:
   - Enter the **Season** (e.g. `2025-26`) and **Team Folder** (e.g. `Mosman U10 Boland`).
   - Click **Save to Repo Folder** (Chrome/Edge) and select this repository root — it writes `data/seasons/<season>/<team>/<game>.json` and updates `data/index.json` automatically.
   - Or click **Download Game .json** (any browser), place the file in `data/seasons/<season>/<team>/`, and run:
     ```bash
     node scripts/rebuild-index.mjs
     ```
3. Commit and push `data/` to GitHub so the games are version-controlled and available on GitHub Pages.

## Game JSON Schema (`schemaVersion: 1`)

Each game file contains both **clean parsed stats** (ready for scripts/AI reports/averages) and **raw inputs** (for full fidelity reloading in the scorebook generator):

- `schemaVersion`: `1`
- `id`: `"<season-slug>/<team-slug>/<game-slug>"`
- `season`, `team`, `opponent`, `savedAt`
- `match`: `{ comp, club, grade, venue, toss, round, date, result, scorers }`
- `innings`: Array of 2 innings objects, each containing:
  - `side`, `team`, `against`, `isStage1`, `totalScore`, `totalWickets`, `totalOvers`
  - `extras`: `{ byes, legByes, wides, noBalls, penalty, total }`
  - `batters`: `[{ name, runs, balls, howOut, bowlerOut, isDNB, events }]`
  - `bowlers`: `[{ name, overs, maidens, wides, noBalls, wickets, runs }]`
  - `fow`: Fall of wickets array
  - `deliveries`: Normalized ball-by-ball delivery array
- `raw`: `{ innings1, innings2 }` preserving the original CSV, PlayHQ scorecard, PlayHQ ball-by-ball text, and formatting options.
