/**
 * Bounds on the tool-result text that rides back into the follow-up prompt.
 *
 * Tool results are the one block of prompt text that bypasses the context
 * budget entirely: `prepareTurn` admits conversation history against
 * `promptBudgetBytes`, but `handleToolCalls` runs mid-stream and used to
 * append `JSON.stringify(result)` verbatim. Measured live the first time
 * knowledge_search actually returned rows: 25 full entity rows serialized to
 * ~40KB, the follow-up prompt hit the 8192-token window at `n_tokens = 8191,
 * truncated = 1`, and the model had exactly one token of room — it generated
 * "Here" and stopped. The turn ended on the empty-turn fallback.
 *
 * Same byte-not-token reasoning as `contextBudget.ts`: `tokens <= bytes`, so a
 * byte cap is a token cap with no tokenizer shipped. It under-fills English
 * JSON; it never overflows.
 */

/**
 * Longest string field a serialized result may carry. A communication row's
 * `content` is unbounded (multi-KB messages are common); the model needs the
 * gist and the identifiers, not the transcript — it can quote the id and the
 * caller can fetch the full row.
 */
const STRING_FIELD_CAP = 320;

/**
 * The share of the model's context window granted to one round's tool
 * results, in bytes. A quarter of an 8K window is 2KB — roughly the three or
 * four best results with their strings capped — which leaves the admitted
 * conversation and the output reserve intact around it.
 */
const WINDOW_SHARE = 4;
const MIN_TOOL_RESULT_BYTES = 2_048;
const MAX_TOOL_RESULT_BYTES = 16_384;

/** Assumed window when the caller did not pass one (native Ollama default sizing). */
const DEFAULT_ASSUMED_NUM_CTX = 8_192;

export function toolResultByteBudget(numCtx?: number | null): number {
  const window = numCtx != null && numCtx > 0 ? numCtx : DEFAULT_ASSUMED_NUM_CTX;

  return Math.min(Math.max(Math.floor(window / WINDOW_SHARE), MIN_TOOL_RESULT_BYTES), MAX_TOOL_RESULT_BYTES);
}

function truncateStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > STRING_FIELD_CAP ? `${value.slice(0, STRING_FIELD_CAP)}…` : value;
  }

  if (Array.isArray(value)) {
    return value.map(truncateStrings);
  }

  if (value != null && typeof value === 'object') {
    // JSON.stringify would serialize these through toJSON (a Date becomes its
    // ISO string); walking their entries instead flattens them to `{}` —
    // measured live as `"time": {}` on every search result, erasing the very
    // timestamps the model cites.
    const toJson = (value as { toJSON?: unknown }).toJSON;

    if (typeof toJson === 'function') {
      return truncateStrings((toJson as () => unknown).call(value));
    }

    const out: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = truncateStrings(entry);
    }

    return out;
  }

  return value;
}

/**
 * Serialize a tool result for the follow-up prompt, spending at most
 * `budgetBytes`.
 *
 * Arrays (the common shape — search results) keep whole leading items until
 * the budget is spent, then close with a marker element naming how many were
 * dropped, so the text stays valid JSON and the model knows the list was cut
 * rather than exhaustive. Anything else is string-capped and, as a last
 * resort, hard-truncated — a capped-but-broken tail beats an overflowed
 * window, which loses the WHOLE turn.
 */
export function boundToolResultForPrompt(value: unknown, budgetBytes: number): string {
  const compact = truncateStrings(value);

  if (Array.isArray(compact)) {
    const kept: unknown[] = [];
    // Reserve room for the closing marker element before spending the budget
    // on items, so appending it can never itself overflow.
    const markerReserve = 96;
    let spent = 2; // '[' + ']'

    for (const item of compact) {
      const serialized = JSON.stringify(item) ?? 'null';
      const cost = serialized.length + (kept.length > 0 ? 1 : 0);

      if (spent + cost > budgetBytes - markerReserve) {
        break;
      }

      kept.push(item);
      spent += cost;
    }

    let consumed = kept.length;

    // The first item alone can exceed the whole budget (one oversized
    // result) — the loop above then keeps nothing, and the caller used to
    // get back only the omission marker: none of the data it asked for.
    // Hard-truncate that first item the same way the non-array branch below
    // does, wrapped so the result stays valid, parseable JSON, and push it
    // instead so a partial version of the data reaches the model.
    if (kept.length === 0 && compact.length > 0) {
      const firstSerialized = JSON.stringify(compact[0]) ?? 'null';
      const previewBudget = Math.max(0, budgetBytes - markerReserve - 40);

      kept.push({ truncated: true, preview: `${firstSerialized.slice(0, previewBudget)}…[truncated]` });
      consumed = 1;
    }

    const omitted = compact.length - consumed;

    if (omitted > 0) {
      kept.push(`[${omitted} more results omitted — refine the query to narrow them down]`);
    }

    return JSON.stringify(kept);
  }

  const serialized = JSON.stringify(compact) ?? 'null';

  if (serialized.length <= budgetBytes) {
    return serialized;
  }

  return `${serialized.slice(0, Math.max(0, budgetBytes - 12))}…[truncated]`;
}
