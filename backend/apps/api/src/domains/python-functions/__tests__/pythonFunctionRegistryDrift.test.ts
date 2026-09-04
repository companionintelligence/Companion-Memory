import { readFileSync } from 'fs';
import path from 'path';

import { PYTHON_FUNCTIONS } from '../types';

/**
 * `PYTHON_FUNCTIONS` is a dispatch allowlist that mirrors two registries living
 * in another language, in another app, with no build-time link to this file:
 * `FUNCTIONS` in ci.summary.functions and ci.hbpe.functions. The comment above
 * each of those says "must stay in sync" — and that comment was the only thing
 * enforcing it.
 *
 * It drifted. `hourly_summary_backfill` was added to the summary sidecar's
 * registry so a 24-hour recovery could go to a worker pool instead of holding
 * an HTTP request open, but nothing added it here, and `dispatch()` rejects an
 * unknown name before it ever reaches a queue — so the queued path existed on
 * one side of the boundary only. A name missing here is not a type error and
 * not a failing sidecar test; it is a runtime throw at the call site, on a code
 * path nobody exercises until an operator needs recovery.
 *
 * So: parse the files the sidecars actually ship and compare.
 */
const SIDECAR_REGISTRIES: ReadonlyArray<{
  target: keyof typeof PYTHON_FUNCTIONS;
  file: string;
}> = [
  { target: 'summary', file: '../../../../../summary/src/ci/summary/functions.py' },
  { target: 'hbpe', file: '../../../../../hbpe/src/ci/hbpe/functions.py' },
];

/**
 * Names bound in the sidecar's `FUNCTIONS = { ... }` dict.
 *
 * Deliberately anchored on the assignment rather than on any `"name":` pair in
 * the file — the modules are full of dict literals, and matching them all would
 * make this test pass for the wrong reason.
 */
function sidecarFunctionNames(file: string): string[] {
  const source = readFileSync(path.resolve(__dirname, file), 'utf8');
  const start = source.indexOf('FUNCTIONS = {');

  expect(start).toBeGreaterThan(-1);

  const body = source.slice(start, source.indexOf('}', start));
  const names: string[] = [];
  const entry = /^\s*"([a-z0-9_]+)":/gm;
  let match: RegExpExecArray | null;

  while ((match = entry.exec(body)) !== null) {
    names.push(match[1]);
  }

  return names;
}

describe('PYTHON_FUNCTIONS mirrors the sidecar runner registries', () => {
  it.each(SIDECAR_REGISTRIES)('$target has no name the sidecar cannot run', ({ target, file }) => {
    const sidecar = sidecarFunctionNames(file);

    expect(sidecar.length).toBeGreaterThan(0);
    // Dispatching a name the runner does not implement fails three retries deep
    // in the queue instead of at the call site — the exact thing the allowlist
    // exists to prevent.
    for (const name of PYTHON_FUNCTIONS[target]) {
      expect(sidecar).toContain(name);
    }
  });

  it.each(SIDECAR_REGISTRIES)('$target can dispatch everything the sidecar runs', ({ target, file }) => {
    // The direction that actually drifted. A sidecar function with no entry
    // here is unreachable: PythonFunctionService.dispatch throws on the name
    // before enqueuing, so the capability ships dead.
    expect([...PYTHON_FUNCTIONS[target]].sort()).toEqual(sidecarFunctionNames(file).sort());
  });
});
