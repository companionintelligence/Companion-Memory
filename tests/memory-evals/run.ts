/**
 * Memory eval harness — entrypoint.
 *
 * Today this script:
 *   1. Discovers every `suites/*.yaml` file.
 *   2. Parses them.
 *   3. Prints a scorecard with `pending` status for each suite.
 *
 * Follow-ups wire it to:
 *   - Testcontainers (clean Postgres + migrations + seed corpus).
 *   - The in-process MCP module so queries hit the same canonical surface
 *     external agents use.
 *   - Per-query scoring per the rules in
 *     docs/architecture/plan/12-memory-evals.md §3.1.
 *
 * The script is intentionally `console.log`-driven: the runner is a
 * stand-alone tool, not a NestJS process.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Resolve relative to this script's directory regardless of CWD. Use CJS-style
// __dirname so we don't depend on import.meta.url (the project targets CJS).
const SUITES_DIR = join(__dirname, 'suites');
const OUT_DIR = join(__dirname, '.out');

interface SuiteFile {
  name: string;
  path: string;
  raw: string;
}

function discoverSuites(): SuiteFile[] {
  if (!existsSync(SUITES_DIR)) {
    return [];
  }

  return readdirSync(SUITES_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => ({
      name: f.replace(/\.yaml$/, ''),
      path: join(SUITES_DIR, f),
      raw: readFileSync(join(SUITES_DIR, f), 'utf-8'),
    }));
}

function renderScorecard(suites: SuiteFile[]): string {
  const lines = ['# Memory Eval Scorecard', '', `_Run at ${new Date().toISOString()}_`, ''];

  if (suites.length === 0) {
    lines.push('No suites configured yet. See `tests/memory-evals/README.md`.');

    return lines.join('\n');
  }

  lines.push('| Suite | Status | Notes |');
  lines.push('|---|---|---|');
  for (const s of suites) {
    lines.push(`| ${s.name} | ⏸ pending | runner not yet wired to DB |`);
  }

  return lines.join('\n');
}

function main(): number {
  const filter = process.argv[2];
  let suites = discoverSuites();

  if (filter) {
    suites = suites.filter((s) => s.name.includes(filter));
  }

  console.log(`Discovered ${suites.length} suite(s)${filter ? ` matching "${filter}"` : ''}.`);

  const scorecard = renderScorecard(suites);
  console.log('');
  console.log(scorecard);

  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  writeFileSync(join(OUT_DIR, 'scorecard.md'), `${scorecard}\n`);
  console.log('');
  console.log(`Wrote ${join(OUT_DIR, 'scorecard.md')}`);

  // Exit 0 — the harness itself ran. Suite-level pass/fail will set the
  // exit code once the runner is wired to a real DB.
  return 0;
}

process.exit(main());
