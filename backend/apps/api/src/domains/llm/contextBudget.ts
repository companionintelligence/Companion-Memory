import { TIER_PROFILES } from '@ci/domains/model-routing';

/**
 * The chat path's context budget, and the admission order that fits a thread
 * into it.
 *
 * ## Where the number comes from
 *
 * CI-Hub already decides how big a context window this appliance can afford:
 * `packages/backend/src/modules/inference/context-length.util.ts`
 * (`recommendContextLength`) walks a memory ladder — free-for-context MB after
 * the model's weights → 4K/8K/16K/32K/64K — and caps the result by the model's
 * own maximum window. Hub then hands that number to every app it launches as
 * **`CI_LLM_NUM_CTX`**. CI-Server has never read it. This module does.
 *
 * When the env var is absent (a standalone ci-server, a dev box, a CI run, or a
 * Hub whose manifest for this app never mapped `num_ctx`), the chat path asks
 * the residency planner for the window this machine can actually carry —
 * `ResidencyPlannerService.resolveChatContextTokens` — and passes it in as
 * `measuredContextTokens`. Only when that cannot be proven either (no GPU
 * counters, an OpenAI-compatible backend, a model the backend does not serve)
 * does the last resort apply: `TIER_PROFILES.on_device.maxContextTokens` from
 * `domains/model-routing/services/ModelTierRouter.ts`. That number is a guess
 * by its own doc comment ("set to 8K to match typical local Ollama defaults"),
 * so it is the fallback of the fallback and never the primary.
 *
 * ## Why the budget is measured in BYTES and there is no bytes-per-token factor
 *
 * A tokenizer maps a byte sequence to tokens; no BPE/SentencePiece vocabulary
 * contains a token shorter than one byte, so for any input
 *
 *     tokens(input) <= byteLength(input)
 *
 * That inequality is what makes a byte cap usable without shipping a
 * tokenizer: admitting at most **N bytes** guarantees at most **N tokens**.
 *
 * The tempting `budgetBytes = tokens * 3` (or 4) is a *different* claim — that
 * text averages ~3 bytes per token. That is an average over English prose, not
 * a bound. Code, CJK, base64 and punctuation-dense text all run far closer to
 * 1 byte/token, and a multiplier there admits 3x the window and overflows. So
 * the budget here is deliberately conservative: 1 byte = 1 token of headroom.
 * It under-fills English threads. It never overflows.
 */

/** Env var CI-Hub exports with the hardware-appropriate `num_ctx`. */
export const NUM_CTX_ENV_VAR = 'CI_LLM_NUM_CTX';

/** Share of the window held back for the model's own answer. */
const OUTPUT_RESERVE_FRACTION = 0.25;
const MIN_OUTPUT_RESERVE_TOKENS = 256;
const MAX_OUTPUT_RESERVE_TOKENS = 4_096;

/**
 * Share held back for the system prompt (base prompt + L0 profile + the Plan /
 * Forecast / Brief / Stats snapshots). The system prompt is never trimmed — it
 * is assembled after admission and is the appliance's own voice — so this is a
 * reservation, not a cap. When the assembled prompt exceeds it, the pre-flight
 * log says so rather than the prompt being silently cut.
 */
const SYSTEM_RESERVE_FRACTION = 0.25;
const MIN_SYSTEM_RESERVE_TOKENS = 512;
const MAX_SYSTEM_RESERVE_TOKENS = 8_192;

/** A thread never gets less than this, however small the configured window. */
const MIN_PROMPT_BUDGET_BYTES = 2_048;

/** How many times a context-overflow failure may halve the history budget. */
export const MAX_CONTEXT_SHRINK_LEVEL = 2;

export type ContextBudgetSource = typeof NUM_CTX_ENV_VAR | 'residency-planner' | 'tier-profile';

export interface ContextBudget {
  /** `num_ctx` we ask the backend for. */
  maxContextTokens: number;
  reservedOutputTokens: number;
  reservedSystemTokens: number;
  /**
   * Hard upper bound on the BYTES of admitted conversation messages. Because
   * `tokens <= bytes`, staying under this keeps the prompt under
   * `maxContextTokens - reservedOutputTokens - reservedSystemTokens`.
   */
  promptBudgetBytes: number;
  source: ContextBudgetSource;
  /** How many halvings a prior overflow forced. 0 on the first attempt. */
  shrinkLevel: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Parse `CI_LLM_NUM_CTX`. Anything not a positive integer (empty, `auto`,
 * `-1`, `65536.5`) is treated as absent rather than as a window — a bad value
 * must not silently become a tiny or fractional budget.
 */
export function parseNumCtx(raw: string | undefined): number | null {
  if (raw == null) {
    return null;
  }

  const trimmed = raw.trim();

  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveContextBudget(
  options: {
    env?: NodeJS.ProcessEnv;
    shrinkLevel?: number;
    /**
     * The window the residency planner derived from this machine (the loaded
     * window of a resident chat model, or the largest ladder rung whose
     * footprint fits the card). Consulted only when CI-Hub exported nothing:
     * a configured window is an operator's decision and always wins. Anything
     * that is not a positive integer is treated as absent.
     */
    measuredContextTokens?: number | null;
  } = {},
): ContextBudget {
  const env = options.env ?? process.env;
  const shrinkLevel = clamp(Math.floor(options.shrinkLevel ?? 0), 0, MAX_CONTEXT_SHRINK_LEVEL);
  const fromHub = parseNumCtx(env[NUM_CTX_ENV_VAR]);
  const measured =
    typeof options.measuredContextTokens === 'number' &&
    Number.isSafeInteger(options.measuredContextTokens) &&
    options.measuredContextTokens > 0
      ? options.measuredContextTokens
      : null;
  const maxContextTokens = fromHub ?? measured ?? TIER_PROFILES.on_device.maxContextTokens;
  const source: ContextBudgetSource =
    fromHub != null ? NUM_CTX_ENV_VAR : measured != null ? 'residency-planner' : 'tier-profile';

  const reservedOutputTokens = clamp(
    Math.round(maxContextTokens * OUTPUT_RESERVE_FRACTION),
    MIN_OUTPUT_RESERVE_TOKENS,
    MAX_OUTPUT_RESERVE_TOKENS,
  );
  const reservedSystemTokens = clamp(
    Math.round(maxContextTokens * SYSTEM_RESERVE_FRACTION),
    MIN_SYSTEM_RESERVE_TOKENS,
    MAX_SYSTEM_RESERVE_TOKENS,
  );

  const availableTokens = maxContextTokens - reservedOutputTokens - reservedSystemTokens;
  // tokens <= bytes, so one token of headroom buys exactly one byte of prompt.
  // The floor is applied BEFORE the shrink, not after: a shrink only happens
  // because the backend already rejected the previous prompt, and a floor that
  // outranked that evidence would replay the same overflow forever. Liveness is
  // protected by admission instead — the newest user turn is unconditional.
  const baseBudgetBytes = Math.max(MIN_PROMPT_BUDGET_BYTES, Math.max(0, availableTokens));
  const promptBudgetBytes = Math.floor(baseBudgetBytes / 2 ** shrinkLevel);

  return {
    maxContextTokens,
    reservedOutputTokens,
    reservedSystemTokens,
    promptBudgetBytes,
    source,
    shrinkLevel,
  };
}

/**
 * Byte cost of one persisted message as it will be sent. `tool_calls` are
 * serialized into the prompt by both drivers, so their JSON counts.
 */
export function messageBytes(content: string | null | undefined, toolCalls?: unknown): number {
  const contentBytes = content ? Buffer.byteLength(content, 'utf8') : 0;
  const toolBytes = toolCalls ? Buffer.byteLength(JSON.stringify(toolCalls), 'utf8') : 0;

  return contentBytes + toolBytes;
}

export interface AdmissionCandidate {
  role: string;
  bytes: number;
}

export interface AdmissionPlan {
  /** Indices of `candidates` to send, in chronological order. */
  admitted: number[];
  /** Indices dropped for budget, in chronological order. */
  dropped: number[];
  admittedBytes: number;
  budgetBytes: number;
  /**
   * True when the unconditionally-admitted messages alone exceed the budget.
   * Liveness wins — the turn is still sent — but the log must say so.
   */
  overBudget: boolean;
}

/**
 * Group messages into the units admission operates on: an assistant message
 * plus every `tool` message that follows it.
 *
 * This is not cosmetic. `OllamaService.chatStream` emits `role: 'tool'` results
 * and `ChatTurnService.persistTurn` writes them as their own rows, so a
 * newest-first trim that counted messages would happily admit a `tool` result
 * whose `assistant(tool_calls)` fell outside the budget. Both Ollama and the
 * OpenAI-compat backend reject a `tool` message with no matching tool call, so
 * that trim turns a long thread into a hard 400 rather than a shorter prompt.
 */
export function toolSequenceGroups(roles: readonly string[]): number[][] {
  const groups: number[][] = [];

  for (let index = 0; index < roles.length; index += 1) {
    if (roles[index] === 'tool' && groups.length > 0) {
      groups[groups.length - 1].push(index);
    } else {
      groups.push([index]);
    }
  }

  return groups;
}

/**
 * Admission order:
 *
 * 1. **Unconditional** — the leading assistant prefix and the newest user turn.
 *    Liveness over budget: a turn that cannot fit its own question is not a
 *    cheaper turn, it is a broken one.
 *
 *    The leading prefix matters for a reason easy to miss.
 *    `ChatTurnService.ensureActionPrompt` *prepends* a synthetic assistant
 *    message carrying the proactive suggestion the user is replying to, and
 *    `extractLeadingAssistantMessages` only recognises it while it is still
 *    leading. A trim that drops oldest-first would delete it and silently
 *    disable `appendPrefillActionContext` — the model would answer "yes, do
 *    that" with no idea what "that" was.
 *
 * 2. **History, newest-first, one tool sequence at a time.** The scan stops at
 *    the first group that does not fit rather than skipping it to squeeze in
 *    something older: history stays a contiguous recent window, which is what
 *    a reader of the transcript would expect.
 */
export function planContextAdmission(
  candidates: readonly AdmissionCandidate[],
  budgetBytes: number,
): AdmissionPlan {
  if (candidates.length === 0) {
    return { admitted: [], dropped: [], admittedBytes: 0, budgetBytes, overBudget: false };
  }

  const roles = candidates.map((candidate) => candidate.role);
  const groups = toolSequenceGroups(roles);
  const groupBytes = groups.map((group) =>
    group.reduce((total, index) => total + candidates[index].bytes, 0),
  );

  const pinned = new Set<number>();

  // Leading assistant prefix (the synthetic prefill, when present).
  for (let index = 0; index < roles.length && roles[index] === 'assistant'; index += 1) {
    pinned.add(index);
  }

  // Newest user turn and everything after it.
  const lastUserIndex = roles.lastIndexOf('user');

  if (lastUserIndex >= 0) {
    for (let index = lastUserIndex; index < roles.length; index += 1) {
      pinned.add(index);
    }
  }

  // A group is atomic: pinning any member pins the whole tool sequence.
  const pinnedGroups = new Set<number>();

  groups.forEach((group, groupIndex) => {
    if (group.some((index) => pinned.has(index))) {
      pinnedGroups.add(groupIndex);
    }
  });

  const admittedGroups = new Set<number>(pinnedGroups);
  let usedBytes = [...pinnedGroups].reduce((total, groupIndex) => total + groupBytes[groupIndex], 0);
  const overBudget = usedBytes > budgetBytes;

  for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
    if (admittedGroups.has(groupIndex)) {
      continue;
    }

    if (usedBytes + groupBytes[groupIndex] > budgetBytes) {
      break;
    }

    usedBytes += groupBytes[groupIndex];
    admittedGroups.add(groupIndex);
  }

  const admitted: number[] = [];
  const dropped: number[] = [];

  groups.forEach((group, groupIndex) => {
    if (admittedGroups.has(groupIndex)) {
      admitted.push(...group);
    } else {
      dropped.push(...group);
    }
  });

  return { admitted, dropped, admittedBytes: usedBytes, budgetBytes, overBudget };
}

/**
 * Attachment policy — deliberately NOT part of the byte budget.
 *
 * The two costs are unrelated. A 2 MB photo is 2,000,000 bytes of history
 * budget but a few hundred tokens to a vision model, which is why counting
 * image bytes against a 24 KiB text budget would evict the entire conversation
 * to make room for one picture. Images are bounded by their own rules: how many
 * messages may carry them, how many per message, and how big each may be.
 *
 * This is also where the worst term in the old chat path lived:
 * `resolveMessage` re-fetched every attached file's full bytes from Minio and
 * re-inlined them on EVERY turn, for EVERY message in the thread. A three-photo
 * thread re-uploaded three full images to the model forever.
 */
export const MAX_INLINE_IMAGE_MESSAGES = 2;
export const MAX_INLINE_IMAGES_PER_MESSAGE = 4;
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Which admitted messages may re-send their images: the newest
 * {@link MAX_INLINE_IMAGE_MESSAGES} that actually have attachments. Older ones
 * are stubbed in text instead.
 *
 * @param fileCounts attachment count per admitted message, chronological.
 */
export function planInlineAttachments(fileCounts: readonly number[]): boolean[] {
  const inline = fileCounts.map(() => false);
  let remaining = MAX_INLINE_IMAGE_MESSAGES;

  for (let index = fileCounts.length - 1; index >= 0 && remaining > 0; index -= 1) {
    if (fileCounts[index] > 0) {
      inline[index] = true;
      remaining -= 1;
    }
  }

  return inline;
}

/** Text that stands in for attachments the budget refused to re-send. */
export function attachmentStub(count: number): string {
  if (count <= 0) {
    return '';
  }

  return count === 1
    ? '[1 attachment from this conversation was not re-sent with this turn.]'
    : `[${count} attachments from this conversation were not re-sent with this turn.]`;
}

/**
 * Attachment TEXT — a text file, or the parsed text of a PDF — is the opposite case to an image.
 *
 * An image is a few hundred tokens to a vision model however many megabytes it is, so it is bounded
 * by its own rules and kept out of the byte budget. Text costs what it weighs: every byte of it is
 * prompt. So it is bounded three ways, and the third is what makes the first two safe on a small
 * window: a cap per file, a cap on how many files a message may inline, and a share of THIS turn's
 * prompt budget that all of it together may take ({@link INLINE_TEXT_BUDGET_SHARE}). The share is
 * set aside from the history before history is admitted, so a thread that has filled its window
 * still has room for the file the person has just attached to the question they are asking.
 */
export const MAX_INLINE_DOCUMENTS_PER_MESSAGE = 4;
/** The most of one file's text that goes into the prompt, fence and line prefixes included. */
export const MAX_INLINE_TEXT_BYTES_PER_FILE = 32 * 1024;
/** The largest text object that is read whole out of object storage; a bigger one is read as parsed text or not at all. */
export const MAX_INLINE_TEXT_FETCH_BYTES = 1024 * 1024;
/** How many parsed chunks of one file are read for the prompt, however small they are. */
export const MAX_PARSED_CHUNKS_PER_FILE = 64;
export const INLINE_TEXT_BUDGET_SHARE = 0.75;
/** Less room than this for a file's text is not worth a header, so the file is left out and said to be. */
export const MIN_INLINE_TEXT_BYTES = 128;

/**
 * How many bytes of the prompt budget each message's attachment text may take.
 *
 * Newest first, because the newest message is the one being asked about: it claims what it needs up
 * to the turn's share, and an older message that still carries its attachments gets what is left.
 * The answer is added to the message's own bytes when the conversation is admitted, which is how
 * the history that fits shrinks to make room, and it is the ceiling the message's attachment block
 * is then built to — never a promise to fill it.
 *
 * @param demands the most each message could use (0 when it has no attachment text), chronological.
 */
export function planAttachmentTextAllowance(demands: readonly number[], promptBudgetBytes: number): number[] {
  const allowances = demands.map(() => 0);
  let remaining = Math.max(0, Math.floor(promptBudgetBytes * INLINE_TEXT_BUDGET_SHARE));

  for (let index = demands.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const granted = Math.min(Math.max(0, demands[index]), remaining);

    allowances[index] = granted;
    remaining -= granted;
  }

  return allowances;
}

/**
 * True when the backend refused the call because the prompt did not fit its
 * context window.
 *
 * `LLM_QUEUE_OPTIONS` sets `retryLimit: 3`, so without this an overflow is
 * replayed verbatim three times — three guaranteed failures at full prefill
 * cost. Classified, it becomes a retry with a smaller window instead.
 *
 * Matched on wording because every backend words it differently: Ollama and
 * vLLM say "context length", OpenAI `context_length_exceeded`, llama.cpp's
 * server (so Lemonade) "the request exceeds the available context size" with
 * type `exceed_context_size_error`, and TGI "`inputs` tokens + `max_new_tokens`
 * must be <= N".
 */
export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  return (
    lower.includes('context length') ||
    lower.includes('context window') ||
    lower.includes('context size') ||
    lower.includes('maximum context') ||
    lower.includes('context_length_exceeded') ||
    lower.includes('exceed_context_size') ||
    lower.includes('too many tokens') ||
    (lower.includes('prompt') && lower.includes('too long')) ||
    (lower.includes('exceeds') && lower.includes('token')) ||
    (lower.includes('max_new_tokens') && lower.includes('must be <='))
  );
}
