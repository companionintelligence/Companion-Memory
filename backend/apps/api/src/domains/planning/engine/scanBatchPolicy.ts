/**
 * How many inbox or memory items one scan call may see.
 *
 * Context length is a hard cap on tokens. It does not pick the batch size.
 * The batch is the smallest of the context budget, a cognitive cap for the
 * model, and a complexity budget so a few long threads fill a call before a
 * pile of short notes does.
 */

export const INPUT_CONTEXT_FRACTION = 0.3;
export const COMPLEXITY_FILL = 0.8;
/** Model calls one scan tick will spend before leaving the rest for the next tick. */
export const MAX_SCAN_CALLS_PER_TICK = 8;
/** Rows fetched per page. The old scan stopped at 30 and never saw the rest. */
export const SCAN_PAGE_SIZE = 200;
/** Clean batches at the current size before the next batch may try one step up. */
export const CLEAN_STREAK_BEFORE_PROBE = 2;

const PROBE_STEPS = [2, 3, 4, 6, 8, 10, 12] as const;

export interface ScanSource {
  id: string;
  tokens: number;
  complexity: number;
}

export interface PackedLimits {
  maxItems: number;
  maxInputTokens: number;
}

export function cognitiveCap(parameterBillions: number | null): number {
  if (parameterBillions == null || parameterBillions < 10) {
    return 4;
  }

  if (parameterBillions <= 30) {
    return 8;
  }

  return 12;
}

/**
 * Cold-start item count. The window only picks a starting range; observed
 * accuracy replaces it. Unknown or small models start at the low end.
 */
export function startingItems(contextTokens: number, cap: number): number {
  let start = 2;

  if (contextTokens >= 100_000) {
    start = 6;
  } else if (contextTokens >= 64_000) {
    start = 4;
  } else if (contextTokens >= 40_000) {
    start = 3;
  }

  return Math.max(1, Math.min(cap, start));
}

/** Input tokens a normal call may spend. About 10k on a 32k window, 30k on 100k. */
export function inputTokenBudget(contextTokens: number): number {
  const window = Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : 8_192;

  return Math.max(256, Math.floor(window * INPUT_CONTEXT_FRACTION));
}

export function outputTokenCap(items: number): number {
  return Math.max(400, Math.max(1, items) * 120);
}

export function nextProbe(current: number, cap: number): number {
  const higher = PROBE_STEPS.find((step) => step > current && step <= cap);

  return higher ?? Math.min(current, cap);
}

export function sourceLoad(
  tokens: number,
  extras: { attachment?: boolean; longThread?: boolean } = {},
): { tokens: number; complexity: number } {
  const bounded = Number.isFinite(tokens) && tokens > 0 ? tokens : 1;
  let complexity = Math.min(0.7, bounded / 4_000);

  if (extras.attachment) {
    complexity += 0.15;
  }

  if (extras.longThread) {
    complexity += 0.1;
  }

  return { tokens: bounded, complexity: Math.min(1, Math.max(0.05, complexity)) };
}

/**
 * Take the longest prefix that stays inside the item cap, the token cap, and
 * the complexity fill. A single oversized source is still returned alone so
 * it gets a turn instead of blocking the queue.
 */
export function packBatch<T extends ScanSource>(sources: readonly T[], limits: PackedLimits): T[] {
  const batch: T[] = [];
  let tokens = 0;
  let complexity = 0;
  const maxItems = Math.max(1, limits.maxItems);

  for (const source of sources) {
    if (batch.length >= maxItems) {
      break;
    }

    const overTokens = tokens + source.tokens > limits.maxInputTokens;
    const overComplexity = complexity + source.complexity > COMPLEXITY_FILL;

    if (batch.length > 0 && (overTokens || overComplexity)) {
      break;
    }

    batch.push(source);
    tokens += source.tokens;
    complexity += source.complexity;
  }

  return batch;
}

export interface OperatingPoint {
  items: number;
  streak: number;
}

/**
 * Per utility model and task. In process, so a restart relearns from the cold
 * start; within a process the last clean size is where the next batch begins.
 */
export class ScanOperatingPoints {
  private readonly rows = new Map<string, OperatingPoint>();

  recommend(key: string, coldStart: number): number {
    return this.rows.get(key)?.items ?? coldStart;
  }

  noteClean(key: string, items: number, cap: number): number {
    const row = this.rows.get(key) ?? { items, streak: 0 };

    if (items >= row.items) {
      row.streak += 1;

      if (row.streak >= CLEAN_STREAK_BEFORE_PROBE) {
        row.items = nextProbe(row.items, cap);
        row.streak = 0;
      }
    } else {
      row.streak = 1;
    }

    this.rows.set(key, row);

    return row.items;
  }

  noteFailed(key: string, items: number): number {
    const pinned = Math.max(1, Math.floor(items / 2));
    this.rows.set(key, { items: pinned, streak: 0 });

    return pinned;
  }

  clear(): void {
    this.rows.clear();
  }
}

export const scanOperatingPoints = new ScanOperatingPoints();

export function operatingKey(modelId: string, task: 'inbox' | 'memory'): string {
  return `${task}:${modelId}`;
}

/** Ollama `/api/show` details.parameter_size, e.g. "7.6B" or "405M". */
export function parseParameterBillions(raw: string | null | undefined): number | null {
  if (raw == null) {
    return null;
  }

  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([bBmM])?/);

  if (!match) {
    return null;
  }

  const value = Number(match[1]);

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return match[2]?.toLowerCase() === 'm' ? value / 1_000 : value;
}
