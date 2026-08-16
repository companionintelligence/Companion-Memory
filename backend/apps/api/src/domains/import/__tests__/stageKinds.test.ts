import fs from 'node:fs';
import path from 'node:path';

import { IMPORT_STAGE_KINDS, IMPORT_STAGE_WEIGHTS } from '../constants';
import { ImportStageListener } from '../listeners/ImportStageListener';

/**
 * The stage vocabulary is declared in four places that must agree: the kinds
 * list, the weight table, the CHECK constraint in the database, and the runner
 * map in the worker. Adding `media` proved they can drift silently — a run
 * materializes `requested_stages` at creation time, so a kind missing from the
 * default list is not an error anywhere, it simply never runs, and the import
 * reports success having skipped a leg.
 */

describe('import stage kinds', () => {
  it('gives every kind a weight', () => {
    for (const kind of IMPORT_STAGE_KINDS) {
      expect(IMPORT_STAGE_WEIGHTS[kind]).toBeGreaterThan(0);
    }

    expect(Object.keys(IMPORT_STAGE_WEIGHTS).sort()).toEqual([...IMPORT_STAGE_KINDS].sort());
  });

  it('sums the weights to 100 so the rollup is a percentage', () => {
    const total = Object.values(IMPORT_STAGE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);

    expect(total).toBe(100);
  });

  it('registers a runner for every kind', () => {
    // Built with stand-ins rather than the real stages: what is under test is
    // that the worker's map covers the vocabulary, not what the runners do.
    const stub = (kind: string) => ({ kind }) as never;
    const logger = { setContext: jest.fn() } as never;
    const listener = new ImportStageListener(
      {} as never,
      {} as never,
      stub('unpack'),
      stub('parse'),
      stub('media'),
      stub('push'),
      logger,
    );

    const runners = (listener as unknown as { runners: Map<string, unknown> }).runners;

    for (const kind of IMPORT_STAGE_KINDS) {
      expect(runners.has(kind)).toBe(true);
    }
  });

  it('allows every kind in the database CHECK constraint', () => {
    // Read from the migrations rather than a live connection so this runs in
    // the same unit pass as everything else. The newest migration that names
    // the constraint is the one in force.
    const dir = path.join(__dirname, '../../../../db/postgres/migrations');
    const constraintPattern = /CHECK\s*\(kind IN \(([^)]*)\)\)/i;

    const declaring = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .filter((name) => {
        const body = fs.readFileSync(path.join(dir, name), 'utf8');

        return body.includes('import_stages') && constraintPattern.test(body);
      });

    expect(declaring.length).toBeGreaterThan(0);

    const latest = fs.readFileSync(path.join(dir, declaring[declaring.length - 1]), 'utf8');
    // The `up` half only — the `down` half deliberately restores the older,
    // narrower list.
    const up = latest.split('-- migrate:down')[0];
    const allowed = constraintPattern.exec(up)?.[1] ?? '';

    for (const kind of IMPORT_STAGE_KINDS) {
      expect(allowed).toContain(`'${kind}'`);
    }
  });
});
