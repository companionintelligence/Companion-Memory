import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { outputTokenCap } from './scanBatchPolicy';
import {
  type ScanCandidate,
  type ScanTodo,
  consolidatePrompt,
  interpretConsolidate,
  isScanContextOverflow,
  todoResponseSchema,
} from './scanTurn';

/**
 * One model call. 60s, not 20: a large local model can spend most of that
 * producing a first token, and a tighter budget made the scans propose
 * nothing — the daily todo scan had never once produced a proposal on an
 * appliance running a large enough local model. The budget is headroom, not
 * the cure: what made the scans complete was the utility tier and the bounded
 * output below.
 */
export const SCAN_TIMEOUT_MS = 60_000;

/**
 * Keep the utility model resident (Ollama `keep_alive`).
 *
 * An hour is for the tier as a whole: the inbox scan runs every 30 minutes,
 * the todo process makes many sequential calls per run, the daily todo scan's
 * own pg-boss retries would each reload the model inside their budget. Cold
 * start on an otherwise idle appliance is a separate problem and wants a
 * warm-up outside the timed section, not a longer keep-alive.
 */
export const SCAN_KEEP_ALIVE = '1h';

/**
 * What a scan needs from the model service, structurally: the engine stays
 * free of the llm domain (and of the import cycle a domain import opens).
 * The Ollama service satisfies this as it is.
 */
export interface ScanModel {
  chat(
    context: never,
    messages: Array<{ role: 'user'; content: string }>,
    options: {
      tier: 'utility';
      enableTools: false;
      format: Record<string, unknown>;
      signal: AbortSignal;
      maxOutputTokens: number;
      keepAlive: string;
    },
  ): Promise<{ done_reason?: string | null; message: { content?: string | null } }>;
  resolveUtilityScanProfile?(): Promise<ScanProfile>;
}

export interface ScanProfile {
  model: string;
  contextTokens: number;
  parameterBillions: number | null;
}

export interface ScanCompletion {
  prompt: string;
  schema: Record<string, unknown>;
  /** Items in the batch; sizes the output cap unless `maxOutputTokens` says otherwise. */
  items: number;
  /** "Todo scan", "Inbox scan", "Todo process": the log lines' subject. */
  label: string;
  logger: LoggerService;
  timeoutMs?: number;
  keepAlive?: string;
  maxOutputTokens?: number;
}

/**
 * One utility-tier structured completion with the scan's budget around it:
 * an abort at `timeoutMs`, a `format` schema, bounded output. `null` means
 * "shrink the batch and try again" — the model hit its output cap, overflowed
 * its context, or failed — and the reason is logged under `label`.
 *
 * Was a verbatim private method in the todo and inbox scan services, and the
 * same wrapper minus the cap check in the todo process service.
 */
export async function completeScan(
  ollama: ScanModel,
  context: UserServiceContext,
  {
    prompt,
    schema,
    items,
    label,
    logger,
    timeoutMs = SCAN_TIMEOUT_MS,
    keepAlive = SCAN_KEEP_ALIVE,
    maxOutputTokens,
  }: ScanCompletion,
): Promise<string | null> {
  const cap = maxOutputTokens ?? outputTokenCap(items);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await ollama.chat(context as never, [{ role: 'user', content: prompt }], {
      tier: 'utility',
      enableTools: false,
      format: schema,
      signal: controller.signal,
      maxOutputTokens: cap,
      keepAlive,
    });

    if (response.done_reason === 'length') {
      logger.warn(`${label} generation hit its output cap; shrinking the batch`, { maxOutputTokens: cap });

      return null;
    }

    return response.message.content || '{}';
  } catch (err) {
    logger.warn(
      isScanContextOverflow(err)
        ? `${label} overflowed the context window; shrinking the batch`
        : `${label} LLM failed; shrinking the batch`,
      { error: err instanceof Error ? err.message : String(err) },
    );

    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The consolidation turn: candidates in, deduplicated to-dos out (or null to shrink the batch). */
export async function consolidateScan(
  ollama: ScanModel,
  context: UserServiceContext,
  candidates: readonly ScanCandidate[],
  options: Pick<ScanCompletion, 'label' | 'logger'>,
): Promise<ScanTodo[] | null> {
  const content = await completeScan(ollama, context, {
    ...options,
    prompt: consolidatePrompt(candidates),
    schema: todoResponseSchema(candidates.length),
    items: candidates.length,
  });

  return content == null ? null : interpretConsolidate(content, candidates);
}

const FALLBACK_PROFILE: ScanProfile = { model: 'utility', contextTokens: 8_192, parameterBillions: null };

/**
 * The utility model's identity, context window and size, for sizing a batch.
 * A backend (or a unit harness) that cannot say gets the conservative profile.
 */
export async function resolveScanProfile(ollama: ScanModel): Promise<ScanProfile> {
  if (typeof ollama.resolveUtilityScanProfile !== 'function') {
    return FALLBACK_PROFILE;
  }

  try {
    return await ollama.resolveUtilityScanProfile();
  } catch {
    return FALLBACK_PROFILE;
  }
}
