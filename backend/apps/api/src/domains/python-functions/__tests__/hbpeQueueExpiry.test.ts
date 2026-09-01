import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PYTHON_FUNCTION_QUEUE_OPTIONS } from '../types';

/**
 * The hbpe queue's `expireInSeconds` is a cross-language invariant: it bounds a
 * run whose length is decided entirely by the Python sidecar. Asserting it
 * against constants declared in `types.ts` would be vacuous — reverting the fix
 * reverts those too — so everything on the right-hand side here is parsed out
 * of the HBPE sources that actually set the runtime.
 */
const HBPE_SRC = resolve(__dirname, '../../../../../hbpe/src/ci/hbpe');

const readHbpe = (file: string): string => readFileSync(resolve(HBPE_SRC, file), 'utf8');

/** `HBPE_LABEL_BUDGET_SECONDS` default from ci.hbpe.config.Settings. */
function labelBudgetSeconds(): number {
  const match = /HBPE_LABEL_BUDGET_SECONDS",\s*"(\d+)"/.exec(readHbpe('config.py'));

  if (!match) {
    throw new Error('HBPE_LABEL_BUDGET_SECONDS default not found in hbpe/config.py');
  }

  return Number(match[1]);
}

/**
 * Sum of `ci.hbpe.functions.STEP_ETA_SECONDS` for every step the nightly runs
 * AFTER `label` — i.e. the pipeline tail that the label budget does not cover.
 * `queued` is not a step and `label` is the budget itself, so both are dropped.
 */
function postLabelEtaSeconds(): number {
  const table = /STEP_ETA_SECONDS: dict\[str, int\] = \{([\s\S]*?)\n\}/.exec(readHbpe('functions.py'));

  if (!table) {
    throw new Error('STEP_ETA_SECONDS table not found in hbpe/functions.py');
  }

  const entries = [...table[1].matchAll(/"([a-z0-9_]+)":\s*(\d+)/g)];

  expect(entries.length).toBeGreaterThan(5);

  return entries
    .filter(([, name]) => name !== 'queued' && name !== 'label')
    .reduce((total, [, , seconds]) => total + Number(seconds), 0);
}

describe('py-fn-hbpe queue expiry', () => {
  /**
   * `label_unlabeled` runs to `started_at + label_budget_seconds` whenever the
   * backlog outlasts it, and only THEN does the nightly run label_summaries →
   * sweeps → serialize → train/export → lora → recurrence → drift → cache. An
   * expiry equal to the budget therefore expires a healthy run mid-tail, which
   * pg-boss reports as a failure and re-dispatches behind a concurrency-1
   * runner instead of recovering anything.
   */
  it('exceeds the python label budget by at least the pipeline tail that follows it', () => {
    const budget = labelBudgetSeconds();
    const tail = postLabelEtaSeconds();

    expect(PYTHON_FUNCTION_QUEUE_OPTIONS.hbpe.expireInSeconds).toBeGreaterThanOrEqual(budget + tail);
  });

  /**
   * STEP_ETA_SECONDS is self-described as a set of conservative guesses and is
   * optimistic by ~3x in practice, so the bar above is necessary but not
   * sufficient. These are measured post-label tails from the dev appliance's
   * own pg-boss history (`nightly` bdb5b4a6, whose label step had already
   * errored out, and `ensure_bootstrap` 60cb9ea9 the same day) — the window has
   * to clear the largest of them on top of a fully spent labeling budget.
   */
  it('clears the longest measured pipeline tail on top of a fully spent budget', () => {
    const longestObservedTailSeconds = 12_820;

    expect(PYTHON_FUNCTION_QUEUE_OPTIONS.hbpe.expireInSeconds).toBeGreaterThanOrEqual(
      labelBudgetSeconds() + longestObservedTailSeconds,
    );
  });
});
