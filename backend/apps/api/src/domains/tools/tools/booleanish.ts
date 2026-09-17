import { z } from 'zod';

/**
 * A boolean tool parameter that also accepts the strings small local models
 * actually send.
 *
 * Measured live on 2026-09-16: qwen3.6:27b called `media.findPhotos` with
 * `countOnly: "true"`, the Zod schema rejected the string, and the turn ended
 * on the empty-turn fallback with no answer. The model's intent was not in
 * doubt — only its JSON typing was. This is the same accommodation
 * `writeKnowledgeCoerce.ts` makes for `memory.remember`, narrowed to one type.
 *
 * Deliberately NOT `z.coerce.boolean()`, which is `Boolean(value)` and turns
 * the string "false" into `true`. Only the spellings below are mapped; any
 * other string still fails validation, so a garbled argument is still an
 * error rather than a silent `true`.
 */
const TRUE_SPELLINGS = new Set(['true', 'yes', '1', 'on']);
const FALSE_SPELLINGS = new Set(['false', 'no', '0', 'off']);

export function coerceBooleanish(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (TRUE_SPELLINGS.has(normalized)) {
    return true;
  }

  if (FALSE_SPELLINGS.has(normalized)) {
    return false;
  }

  return value;
}

/** Drop-in for `z.boolean()` in a tool input schema. Chain `.optional()` / `.default()` as usual. */
export function booleanish() {
  return z.preprocess(coerceBooleanish, z.boolean());
}
