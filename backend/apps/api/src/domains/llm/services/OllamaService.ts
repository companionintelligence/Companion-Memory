import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type ChatResponse,
  type GenerateResponse,
  type Message as OllamaMessage,
  type Tool,
  type ToolCall,
  Ollama,
} from 'ollama';

import type { RequestContext } from '@ci/common/context';
import { type ApiKeyCapability, FULL_CAPABILITY } from '@ci/common/decorators';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import config, { UTILITY_MODEL_EXPLICITLY_CONFIGURED } from '@ci/configuration';
import { ModelTierRouter, type RoutingDecision } from '@ci/domains/model-routing';
import {
  ToolRegistry,
  capabilityAllows,
  intentToolName,
  canonicalizeExecutableToolName,
  type ToolInvocationContext,
  type ToolSchema,
} from '@ci/domains/tools';

import { ChatModelPreferenceService } from '../chat-model-preference.module';
import {
  createFirstResponseFetch,
  type FirstResponseFetch,
  isFirstResponseTimeout,
} from '../firstResponseDeadline';
import type { UtilityModelChoice } from '../residency/footprint';
import { boundToolResultForPrompt, toolResultByteBudget } from '../toolResultBudget';
import type { OllamaModel } from '../types';

import { LlmEndpointService } from './LlmEndpointService';
import { ResidencyPlannerService } from './ResidencyPlannerService';

/**
 * Appended to the REQUEST (never stored) for the forced prose round — the one
 * extra generation granted when the tool-round cap lands on tool calls.
 * Withholding the tools alone does not stop the loop on the native path:
 * Ollama parses the model's tool-call template tokens whether or not tools
 * were advertised, so an eager model keeps searching until the cap kills the
 * turn with no prose (measured live: three knowledge_search rounds, then the
 * empty-turn fallback). The instruction is what turns the final round into an
 * answer; the discard in the round's `finally` is what makes it final either way.
 */
const FORCED_PROSE_NUDGE: OllamaMessage = {
  role: 'system',
  content:
    'Tool use for this turn is over — do not call any more tools. Answer the user now in plain prose, ' +
    'grounded in the tool results above. If the results do not fully answer the question, summarize ' +
    'what was found and say what is missing.',
};

/**
 * The model a PERSON is talking to.
 *
 * Despite the name this is `llm.chatModel`, the operator's interactive-chat
 * choice — so it can be, and on real appliances is, a very large model. Prefer
 * {@link UTILITY_MODEL} for anything running on a cron or a queue; see its doc
 * for why sharing one setting between the two silently breaks background work.
 */
export const PROMPT_MODEL = config.llm.chatModel;

/**
 * The model BACKGROUND work should use — extraction, classification, anything
 * whose output is parsed rather than read.
 *
 * Separate from {@link PROMPT_MODEL} because the two jobs want opposite things,
 * and sharing one setting made raising the chat model for quality silently
 * disable every background job on the box: an identical ~1170-token extraction
 * prompt measured over 170s on a 31B model versus 3.6s on a 1B one, cold load
 * included. Prompt evaluation dominates that cost, so neither a longer timeout
 * nor an output cap can recover it — only a smaller model.
 */
export const UTILITY_MODEL = config.llm.utilityModel;
const DEMO_VISION_MODEL = 'gemma3:27b';
const DEMO_TEXT_MODEL = 'qwen3:14b';
const INTERNAL_MODELS = new Set(['nomic-embed-text', 'nomic-embed-text-v2-moe']);

// vLLM / Qwen honor `chat_template_kwargs.enable_thinking`; tool-call parsers
// cover structured tools plus the `<toolcall>` salvage path. Advertise both so
// Chat and Settings can toggle them the same way they do for Ollama.
const OPENAI_MODE_CAPABILITIES = ['completion', 'tools', 'thinking'];

/** How long the boot-time model check waits on the inference backend. */
const PREFLIGHT_TIMEOUT_MS = 5_000;

/**
 * Bound a promise. The timer is cleared on settle and unref'd meanwhile, so a
 * preflight can never be the reason a process refuses to exit.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        handle = setTimeout(() => reject(new Error(message)), ms);
        handle.unref?.();
      }),
    ]);
  } finally {
    if (handle) {
      clearTimeout(handle);
    }
  }
}

/** Outcome of the boot-time check of {@link PROMPT_MODEL} against the served list. */
export interface ChatModelPreflight {
  /** The configured id — `LLM_DEFAULT_CHAT_MODEL`, or the compiled-in default. */
  model: string;

  /** The backend answered AND the configured id is in its list. */
  available: boolean;

  /**
   * The backend answered at all. `false` separates "your model id is wrong" from
   * "the inference server is not up" — two very different operator actions.
   */
  reachable: boolean;

  servedModels: string[];

  /** Served ids that look like a misspelling of {@link model}. Empty when none do. */
  suggestions?: string[];

  /** Why the backend could not be reached. Only set when `reachable` is false. */
  reason?: string;
}

/**
 * Served ids that plausibly are what the configured id MEANT.
 *
 * Deliberately crude — it compares the alphanumeric skeleton, so `qwen/qwen3-vl-30b`
 * and `qwen3-vl:4b` match on `qwen3vl` while `gemma4:e4b` does not. The goal is to
 * turn "that id is wrong" into "here is the one you meant"; anything cleverer would
 * be a fuzzy-matching library's job and would still only be printing a hint.
 */
export function nearestModelIds(configured: string, served: string[]): string[] {
  const skeleton = (id: string) => id.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = skeleton(configured.split('/').pop() ?? configured);

  if (target.length === 0) {
    return [];
  }

  const sharedPrefix = (candidate: string): number => {
    let shared = 0;

    while (shared < candidate.length && shared < target.length && candidate[shared] === target[shared]) {
      shared += 1;
    }

    return shared;
  };

  return (
    served
      .map((id) => ({ id, shared: sharedPrefix(skeleton(id)) }))
      // At least 4 shared characters: enough to bind a model FAMILY (`qwen3`,
      // `gemma`, `llava`) without matching every id that happens to start with `q`.
      .filter((entry) => entry.shared >= 4)
      // Longest shared prefix first, so `qwen3-vl:4b` outranks `qwen3.5:9b` for a
      // configured `qwen/qwen3-vl-30b` rather than losing to it on list order.
      .sort((a, b) => b.shared - a.shared || a.id.localeCompare(b.id))
      .slice(0, 3)
      .map((entry) => entry.id)
  );
}

function chatChunkToGenerateResponse(chunk: ChatResponse): GenerateResponse {
  return {
    model: chunk.model,
    created_at: chunk.created_at,
    response: chunk.message.content,
    done: chunk.done,
    done_reason: chunk.done_reason,
    context: [],
    total_duration: chunk.total_duration,
    load_duration: chunk.load_duration,
    prompt_eval_count: chunk.prompt_eval_count,
    prompt_eval_duration: chunk.prompt_eval_duration,
    eval_count: chunk.eval_count,
    eval_duration: chunk.eval_duration,
  };
}

/**
 * A request context that may also carry the **authority of the principal driving the chat**.
 *
 * Tool calls made from a chat turn are made on behalf of whoever opened that chat, and the model
 * choosing to call `memory.forget` does not grant authority the caller never had. This is how the
 * caller's capability reaches {@link ToolRegistry.executeTool} — which is where it is enforced.
 *
 * Optional so the many in-process callers (`persona`, `schedule`, the listeners) that pass a bare
 * `RequestContext` keep compiling: every one of them passes `enableTools: false` and is the
 * appliance acting as itself, which is full authority. {@link resolveInvocationCapability} makes
 * that reading explicit rather than accidental.
 */
export interface ChatRequestContext extends RequestContext {
  capability?: ApiKeyCapability;
}

/**
 * The authority a chat turn's tool calls run with.
 *
 * Absent means "not an outside caller" — the same reading `apiKeyCapabilityOf` gives a session:
 * a background job or an internal service is the appliance acting on its own behalf. Any surface
 * that accepts an outside request MUST set it (see OllamaController, which reads it off the
 * express request); leaving it unset there is what the ungated-LLM-path bug was.
 */
function resolveInvocationCapability(context: ChatRequestContext): ApiKeyCapability {
  return context.capability ?? FULL_CAPABILITY;
}

interface BasePromptOptions {
  signal?: AbortSignal;
  enableTools?: boolean;
  enableThinking?: boolean;
  /**
   * Context window to ask the backend for, in tokens (Ollama `options.num_ctx`).
   * Absent leaves the backend's own default alone, which is what every caller
   * did before {@link ContextBudget} existed.
   */
  numCtx?: number;
  /**
   * Cap on the model's own answer, in tokens. Maps to OpenAI `max_tokens` on
   * the compat path and to Ollama `options.num_predict` on the native one.
   *
   * An earlier revision of this comment claimed native Ollama had no separate
   * output cap and that `num_ctx` bounding the whole transcript was the only
   * lever, so this was sent on the OpenAI-compat path alone. That is wrong:
   * `options.num_predict` is exactly an output cap and the pinned client
   * declares it (`ollama@0.5.17`, `Options.num_predict: number`). The mistake
   * had teeth, because the native path is the one that runs here — an
   * unbounded `num_predict` combined with a grammar-constrained unbounded
   * array (`format` holding a JSON Schema whose `items` has no `maxItems`)
   * lets a single call generate until the context window is full. That is
   * what made a 60s budget unmeetable for the planning scan, on a prompt of
   * only ~1.6k tokens.
   */
  maxOutputTokens?: number;
  /**
   * `'json'` asks for syntactically valid JSON and nothing more — the model is
   * still free to invent key names, which small models reliably do. A JSON
   * Schema object instead constrains generation to that shape via grammar, so
   * the caller gets the fields it asked for rather than valid-but-unusable
   * JSON. Prefer the schema form for anything that will be parsed.
   */
  format?: string | Record<string, unknown>;
  /**
   * How long the backend should keep this model resident after the call
   * (Ollama `keep_alive`; a duration string like `'30m'`, or seconds).
   *
   * Absent leaves the server default alone (`OLLAMA_KEEP_ALIVE`, 5 minutes).
   * That default is the reason a periodic job pays a cold model load on most
   * runs: a scan that fires less often than the eviction window always finds
   * the model gone, and reloading a large one costs far more than the call
   * itself. Worse, the load happens INSIDE the caller's timeout budget, so a
   * job whose generation would comfortably fit still fails.
   */
  keepAlive?: string | number;
}

/**
 * Which model a call runs on: a specific id, or the UTILITY tier.
 *
 * `tier: 'utility'` replaces the old `model: UTILITY_MODEL` at every background
 * call site. The difference is that the tier is RESOLVED per call by
 * {@link OllamaService.resolveUtilityModel} — into the utility model at a
 * context that provably fits beside what is already on the GPU, or into the
 * resident chat model when it cannot — instead of being a constant that asked
 * Ollama to load whatever was configured and hoped it fit. See
 * `residency/footprint.ts` for the wedge that hope produced.
 */
type ModelSelection = { model: string; tier?: undefined } | { tier: 'utility'; model?: undefined };

type PromptOptions = BasePromptOptions & ModelSelection;

/**
 * Options for the paths that always name their model — the streaming chat
 * path and the two `/api/generate` wrappers. Only {@link chat} resolves a tier.
 */
type NamedModelPromptOptions = BasePromptOptions & { model: string };

/** Characters per token, the usual rough English/code ratio. */
const CHARS_PER_TOKEN = 4;

/**
 * Cheap prompt-size estimate for tier routing. Deliberately a character count and
 * not a real tokenizer: the router only needs to know which side of a context
 * window a turn lands on, and loading a tokenizer per turn would cost more than
 * the decision is worth. Rounds up, so a turn is never reported as smaller than
 * it is.
 */
export function estimateInputTokens(messages: OllamaMessage[]): number {
  const characters = messages.reduce((total, message) => total + (message.content?.length ?? 0), 0);

  return Math.ceil(characters / CHARS_PER_TOKEN);
}

interface ValidateModelOptions {
  messages?: OllamaMessage[];
  requestedModel?: string | null;
  enableThinking?: boolean;
  enableTools?: boolean;
}

interface ValidateModelResult {
  model: string;
  enableThinking: boolean;
  enableTools: boolean;
}

/**
 * Settle with `promise`, or reject the moment `signal` aborts — whichever comes
 * first. Without a signal the promise is handed back untouched, so a caller that
 * passes none is completely unaffected.
 *
 * This races; it does not cancel. It is what bounds the parts of a turn that
 * are not a single client call — notably the `validateModel` round trip — and
 * what stops a caller waiting on a host that is down.
 *
 * It is NOT what stops the generation itself. The ollama client posts a
 * one-shot non-streaming request with no signal, so a race here would leave
 * the server generating to completion on an abandoned request; see
 * {@link OllamaService.runNativeChat}, which routes the signal into the
 * client's `fetch` so the socket is genuinely torn down. Both are needed: this
 * bounds the turn, that releases the backend.
 */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Aborted'));

    if (signal.aborted) {
      onAbort();

      // `promise` is already running and nothing downstream will ever look at
      // it, so it still needs a handler or its eventual failure surfaces as an
      // unhandled rejection and takes the process down. The old early return
      // skipped straight past the one below and left exactly that hole: it went
      // unnoticed only because the inner promise usually settled by RESOLVING,
      // which needs no handler. Anything that makes the aborted path fail
      // promptly — a caller that checks the signal before doing work — turns it
      // into a crash.
      promise.catch(() => undefined);

      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });

    // Attaching a rejection handler here also keeps a late failure on an
    // already-abandoned request from surfacing as an unhandled rejection.
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

@Injectable()
export class OllamaService implements OnModuleInit {
  /** `${userId}:${storedModel}` pairs already warned about by resolveEffectiveChatModel. */
  private readonly staleChatModelOverridesWarned = new Set<string>();

  private lastPreflight: ChatModelPreflight | null = null;

  constructor(
    private readonly llmEndpointService: LlmEndpointService,
    private readonly toolRegistry: ToolRegistry,
    private readonly logger: LoggerService,
    private readonly featureService: FeatureService,
    private readonly modelTierRouter: ModelTierRouter,
    // Optional so the many direct `new OllamaService(...)` unit tests that
    // predate this preference keep compiling unchanged. Nest always supplies
    // it in the real app (see LlmCoreModule); its absence degrades exactly to
    // the OLD behaviour — every user gets the single appliance constant,
    // PROMPT_MODEL — which is what those tests already assert.
    private readonly chatModelPreference?: ChatModelPreferenceService,
    // Optional for the same reason. Absent, `tier: 'utility'` resolves to the
    // bare configured UTILITY_MODEL with no context window — the old behaviour.
    private readonly residencyPlanner?: ResidencyPlannerService,
  ) {
    this.logger.setContext(OllamaService.name);
  }

  /**
   * Check the configured chat model against what the backend actually serves,
   * at boot, and say so LOUDLY when it is not there.
   *
   * ── Why ────────────────────────────────────────────────────────────────────
   *
   * `PROMPT_MODEL` is `LLM_DEFAULT_CHAT_MODEL`, resolved once at import. Every
   * background inference path passes it straight to
   * {@link OllamaService.validateModel}, which throws `Invalid model specified:
   * <id>` — per job, forever, with nothing at boot to say the id was wrong. On a
   * live appliance that produced 36 identical dead letters from
   * `infer.question.answer` alone, all of them `Invalid model specified:
   * qwen/qwen3-vl-30b` — a vLLM/HuggingFace-style repo id set against an Ollama
   * backend that has never had a tag by that name. One ERROR line at boot turns
   * that from a slow leak into a thing an operator reads once.
   *
   * ── Failure handling ───────────────────────────────────────────────────────
   *
   * Never throws. A misconfigured model must not stop the server from booting —
   * chat is one feature of an appliance whose job is to keep ingesting — and the
   * whole point is that the operator gets to READ the diagnosis.
   *
   * An UNREACHABLE backend is a warn, not an error: at boot the inference server
   * routinely has not accepted connections yet, and "could not verify" is a
   * different claim from "your model id is wrong". Only a backend that answered,
   * with a list that does not contain the configured id, is an ERROR.
   *
   * The list call is bounded by {@link PREFLIGHT_TIMEOUT_MS}. A refused
   * connection fails instantly, but a host that ACCEPTS and then never answers
   * would otherwise hold `onModuleInit` — and therefore the whole boot — open
   * indefinitely, which is a far worse failure than the one being diagnosed.
   */
  async onModuleInit(): Promise<void> {
    await this.preflightChatModel();
  }

  /** The most recent {@link preflightChatModel} result, or null before the first run. */
  get chatModelPreflight(): ChatModelPreflight | null {
    return this.lastPreflight;
  }

  /**
   * The SILENT half of {@link preflightChatModel}: ask the backend what it
   * serves, compare it with the configured id, and return the verdict — with no
   * log line and no write to {@link lastPreflight}.
   *
   * Split out because the diagnosis and the check have opposite audiences. The
   * boot check wants to be loud exactly once; a REPEATED caller — the deep
   * health route polls this on every request, and that route is unauthenticated
   * — must not be able to spam the log or overwrite the boot-time record that
   * {@link chatModelPreflight} publishes.
   *
   * `timeoutMs` is a parameter for the same reason: a poller's budget is much
   * shorter than boot's, and a check that outlives its caller's budget can only
   * ever report the caller's timeout instead of naming the backend.
   */
  async checkChatModel(timeoutMs: number = PREFLIGHT_TIMEOUT_MS): Promise<ChatModelPreflight> {
    const model = PROMPT_MODEL;
    let served: string[];

    try {
      served = await withTimeout(
        this.listServedChatModelIds(),
        timeoutMs,
        `the LLM backend did not list its models within ${timeoutMs}ms`,
      );
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);

      return { model, available: false, reachable: false, servedModels: [], reason };
    }

    if (served.includes(model)) {
      return { model, available: true, reachable: true, servedModels: served };
    }

    // `qwen/qwen3-vl-30b` vs the served `qwen3-vl:4b` is the real case: the
    // family is right and the spelling is not, so the near-misses travel with
    // the verdict — they are what make the boot ERROR below actionable rather
    // than just accusatory.
    return {
      model,
      available: false,
      reachable: true,
      servedModels: served,
      suggestions: nearestModelIds(model, served),
    };
  }

  async preflightChatModel(): Promise<ChatModelPreflight> {
    const preflight = await this.checkChatModel();
    const { model, servedModels: served, suggestions = [] } = preflight;

    if (!preflight.reachable) {
      this.logger.warn(
        `Could not verify the configured chat model "${model}" — the inference backend did not answer. ` +
          `If it is still starting this is expected; if it stays unreachable, every LLM job will fail.`,
        { model, reason: preflight.reason },
      );
    } else if (preflight.available) {
      this.logger.log(`Chat model "${model}" is served by the active LLM backend`, {
        model,
        servedModels: served.length,
      });
    } else {
      this.logger.error(
        `Configured chat model "${model}" is NOT served by the active LLM backend. ` +
          `Every background inference job (question answering, summaries, titles) will fail with ` +
          `"Invalid model specified: ${model}" and land in ci.pipeline_dead_letters. ` +
          `Set LLM_DEFAULT_CHAT_MODEL to one of the ${served.length} served ids` +
          `${suggestions.length > 0 ? ` — did you mean ${suggestions.map((id) => `"${id}"`).join(' or ')}?` : ''}` +
          `${served.length > 0 ? ` Served: ${served.join(', ')}.` : ' The backend is serving no chat models at all.'}`,
      );
    }

    return (this.lastPreflight = preflight);
  }

  private get ollama(): Ollama {
    return new Ollama({ host: this.llmEndpointService.getOllamaHost() });
  }

  /**
   * A per-request client whose wait for the backend's FIRST response is
   * bounded by `llm.firstResponseTimeoutMs` — see `firstResponseDeadline.ts`
   * for the failure this closes. Every generation goes through one of these;
   * only the metadata calls (`list`, `show`, `ps`) use the bare getter above.
   *
   * `Config.fetch` is the one seam the client leaves open (see runNativeChat's
   * doc comment for the measurements), so the deadline and the caller's
   * signal both reach the socket through it. Construction is trivial and
   * undici pools sockets process-wide, so a client per request costs nothing.
   */
  private boundedClient(
    model: string,
    signal?: AbortSignal,
  ): { client: Ollama; deadline: FirstResponseFetch } {
    const deadline = createFirstResponseFetch({
      model,
      deadlineMs: config.llm.firstResponseTimeoutMs,
      signal,
    });

    return {
      client: new Ollama({ host: this.llmEndpointService.getOllamaHost(), fetch: deadline.fetch }),
      deadline,
    };
  }

  /**
   * The error a caller should see when a request went through
   * {@link boundedClient} and failed: the typed deadline error when the
   * deadline fired (however the client re-wrapped the abort), the original
   * otherwise.
   */
  private static surfaceDeadline(deadline: FirstResponseFetch, err: unknown): unknown {
    const fired = deadline.error();

    if (fired == null || isFirstResponseTimeout(err)) {
      return err;
    }

    fired.cause = err;

    return fired;
  }

  /**
   * One non-streaming native `/api/chat` turn that a signal can actually stop.
   *
   * {@link abortable} alone cannot stop one. It races the caller's promise
   * against the signal, so an abort frees the CALLER while the request stays
   * in flight and the server generates to completion, holding its model slot
   * the whole time. For a periodic job that retries on timeout that is
   * actively harmful rather than merely wasteful: every timed-out attempt
   * leaves a full-length generation running, and the next attempt queues
   * behind the pile its predecessors left. A run of retries can therefore make
   * a loaded backend progressively LESS able to answer, which is exactly the
   * failure that motivated this method — observed as ten consecutive planning
   * scans aborting at their 60s budget while the backend never went idle.
   *
   * The signal reaches the socket through a wrapped `fetch`, and that detail is
   * load-bearing — the obvious approaches do not work:
   *
   *   - The client's own `abort()` is a NO-OP here. It walks
   *     `ongoingStreamedRequests`, and only the streaming branch ever registers
   *     one; the non-streaming branch posts with `{ headers }` and no signal at
   *     all (`ollama@0.5.17`, `browser.mjs` `processStreamableRequest`). Calling
   *     it on a non-streaming turn iterates an empty array.
   *   - `ChatRequest` has no per-request `signal` field to pass instead.
   *
   * `Config.fetch` is the one seam the client leaves open, so injecting the
   * signal there is what actually tears the request down. Verified against the
   * pinned client with a server that accepts the POST and never answers:
   * `abort()` leaves the socket open and the promise pending, the wrapped fetch
   * closes the socket and rejects.
   */
  private async runNativeChat({
    model,
    messages,
    format,
    tools,
    signal,
    numCtx,
    maxOutputTokens,
    keepAlive,
    enableThinking = false,
  }: {
    model: string;
    messages: OllamaMessage[];
    format?: string | Record<string, unknown>;
    tools?: Tool[];
    signal?: AbortSignal;
    numCtx?: number;
    maxOutputTokens?: number;
    keepAlive?: string | number;
    enableThinking?: boolean;
  }): Promise<ChatResponse> {
    // A signal that is ALREADY aborted must not start a generation at all.
    // `runChat` awaits `validateModel` — its own network round trip — before
    // getting here, so on a slow host the budget can expire in that window.
    // Without this guard the caller has already been freed by `abortable`, and
    // the request issued below would be orphaned the instant it starts: an
    // abort listener attached to an already-aborted signal never fires.
    signal?.throwIfAborted();

    const { client, deadline } = this.boundedClient(model, signal);

    try {
      return await client.chat({
        model,
        messages,
        // Always explicit. Omitting `think` hands the decision to the server,
        // and Ollama's default for a thinking-capable model is ON — so every
        // background call (image descriptions, thing vision, titles) was paying
        // for a private chain of thought it never read: measured ~5s of a 7s
        // Gemma description, and far more on a 27B model. `false` is accepted by
        // models without the capability; only `true` is rejected.
        think: enableThinking === true,
        ...(format && { format }),
        ...(tools && tools.length > 0 && { tools }),
        ...(keepAlive != null && { keep_alive: keepAlive }),
        // `num_ctx` used to be sent on the streaming path only, so every
        // non-streaming (background) call got Ollama's VRAM-based default —
        // 32768 on a 24 GiB card — whatever the planner or caller wanted. It
        // shares the `options` bag with `num_predict`; neither may clobber the
        // other (see chatStream for the same shape).
        ...(((numCtx != null && numCtx > 0) || (maxOutputTokens != null && maxOutputTokens > 0)) && {
          options: {
            ...(numCtx != null && numCtx > 0 && { num_ctx: numCtx }),
            ...(maxOutputTokens != null && maxOutputTokens > 0 && { num_predict: maxOutputTokens }),
          },
        }),
      });
    } catch (err: unknown) {
      throw OllamaService.surfaceDeadline(deadline, err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getAvailableModels(context: RequestContext): Promise<OllamaModel[]> {
    const openAiDriver = this.llmEndpointService.getOpenAiDriver();

    if (openAiDriver) {
      const modelIds = await openAiDriver.listModels();

      return modelIds
        .map((id) => this.parseOllamaModel(id))
        .filter((model) => !INTERNAL_MODELS.has(model.name))
        .map((model) => ({
          ...model,
          capabilities: OPENAI_MODE_CAPABILITIES,
          vision: false,
          tools: true,
          thinking: true,
        }));
    }

    const result = await this.ollama.list();
    const models = result.models.map((model) => this.parseOllamaModel(model.name));
    const visibleModels = models.filter((model) => !INTERNAL_MODELS.has(model.name));

    return await Promise.all(
      visibleModels.map(async (model) => {
        const capabilities = await this.fetchModelCapabilities(model.model, {
          throwOnError: false,
        });

        return {
          ...model,
          capabilities,
          vision: capabilities.includes('vision'),
          tools: capabilities.includes('tools'),
          thinking: capabilities.includes('thinking'),
        };
      }),
    );
  }

  async getModelCapabilities(context: RequestContext, requestedModel: string): Promise<string[]> {
    await this.validateModel(context, requestedModel);

    return await this.fetchModelCapabilities(requestedModel);
  }

  async generateStream(
    context: RequestContext,
    prompt: string,
    { model, signal }: NamedModelPromptOptions,
  ): Promise<AsyncGenerator<GenerateResponse> & { buffer: string }> {
    const chunks: string[] = [];
    const openAiDriver = this.llmEndpointService.getOpenAiDriver();

    const stream = (async function* (self) {
      if (openAiDriver) {
        const iterator = openAiDriver.chatStream({
          model,
          messages: [{ role: 'user', content: prompt }],
          signal,
          enableThinking: false,
        });

        for await (const chunk of iterator) {
          if (chunk.message.content) {
            chunks.push(chunk.message.content);
          }

          yield chatChunkToGenerateResponse(chunk);
        }

        return;
      }

      const { client } = self.boundedClient(model, signal);
      const iterator = await client.generate({
        model,
        prompt,
        stream: true,
      });

      signal?.addEventListener('abort', () => {
        iterator.abort();
      });

      for await (const chunk of iterator) {
        if (chunk && !!chunk.response) {
          chunks.push(chunk.response);
        }

        yield chunk;
      }
    })(this);

    Object.defineProperty(stream, 'buffer', {
      enumerable: true,
      get: () => chunks.join(''),
    });

    return stream as typeof stream & { buffer: string };
  }

  async generate(
    context: RequestContext,
    prompt: string,
    { model }: Omit<NamedModelPromptOptions, 'signal'>,
  ): Promise<GenerateResponse> {
    await this.validateModel(context, model);

    const openAiDriver = this.llmEndpointService.getOpenAiDriver();

    if (openAiDriver) {
      const response = await openAiDriver.chat({
        model,
        messages: [{ role: 'user', content: prompt }],
      });

      return chatChunkToGenerateResponse(response);
    }

    const { client, deadline } = this.boundedClient(model);

    try {
      return await client.generate({
        model,
        prompt,
      });
    } catch (err: unknown) {
      throw OllamaService.surfaceDeadline(deadline, err);
    }
  }

  async chatStream(
    context: ChatRequestContext,
    messages: OllamaMessage[],
    {
      model,
      signal,
      enableTools = false,
      enableThinking = true,
      numCtx,
      maxOutputTokens,
    }: NamedModelPromptOptions,
  ): Promise<AsyncGenerator<ChatResponse> & { messages: OllamaMessage[]; error?: Error }> {
    await this.validateModel(context, model);

    const inputMessages = messages.slice();
    const availableTools = enableTools ? this.toolsWithinCapability(context) : [];
    const ollamaTools: Tool[] = availableTools.map(this.convertToOllamaTool);
    const openAiDriver = this.llmEndpointService.getOpenAiDriver();

    const textChunks: string[] = [];
    const thinkChunks: string[] = [];
    const toolCalls: ToolCall[] = [];
    const accumulatedMessages: OllamaMessage[] = [];
    // One tool round, then a prose follow-up. Re-advertising tools after a
    // failed/partial remember made Qwen retry for minutes on a 2-slot vLLM.
    // XML dumped into content is still salvaged (salvageTools) without another
    // advertised-tool generate.
    const maxToolRounds = 2;
    let generateRounds = 0;
    // When the follow-up round ALSO comes back as tool calls (salvage can
    // produce them even with no tools advertised), the loop used to execute
    // those calls and then break at the round cap — ending the whole turn with
    // a role:'tool' row as its last message and no prose anywhere. Measured
    // live: two knowledge_search rounds that both returned [], then silence;
    // the viewer saw a chat that never answered. This flag buys exactly one
    // more generation, with tools neither advertised nor salvaged, so the
    // model has to speak to the results it already has.
    let forcedProseRound = false;
    // A backend failure inside the generator is logged and the stream ends
    // quietly (an empty assistant row) rather than throwing at the consumer —
    // long-standing behavior the SSE controller depends on. Recording it here
    // additively lets a caller that CAN do something about a specific failure
    // (ChatTurnService retrying a context overflow with a smaller history
    // budget) see it, without changing what happens to every other caller.
    let streamError: Error | undefined;

    const stream = (async function* (self) {
      do {
        if (signal?.aborted) {
          break;
        }

        let lastChunk: ChatResponse | undefined;
        let handleAbort = () => {};

        let deadline: FirstResponseFetch | undefined;

        textChunks.splice(0, textChunks.length);
        thinkChunks.splice(0, thinkChunks.length);

        const iterationToolCalls = toolCalls.splice(0, toolCalls.length);
        const toolEvaluations = await self.handleToolCalls(
          context,
          iterationToolCalls,
          toolResultByteBudget(numCtx),
        );

        accumulatedMessages.push(...toolEvaluations);

        if (generateRounds >= maxToolRounds) {
          if (iterationToolCalls.length === 0 || forcedProseRound) {
            break;
          }

          forcedProseRound = true;
        }

        generateRounds += 1;
        const iterationWillCallTools =
          enableTools && ollamaTools.length > 0 && generateRounds === 1 && !forcedProseRound;
        // Withholding the tools is not enough to end the tool loop on the
        // native path: Ollama parses the model's tool-call template tokens
        // whether or not tools were advertised, so an eager model just keeps
        // searching (measured live: three knowledge_search rounds, no prose,
        // fallback shown). Request-only, never pushed onto
        // accumulatedMessages — persistTurn writes those as thread rows and a
        // stored system row would replay into every later turn.
        const requestMessages = forcedProseRound
          ? inputMessages.concat(accumulatedMessages, [FORCED_PROSE_NUDGE])
          : inputMessages.concat(accumulatedMessages);

        try {
          if (openAiDriver) {
            const iterator = openAiDriver.chatStream({
              model,
              messages: requestMessages,
              tools: iterationWillCallTools ? ollamaTools : undefined,
              signal,
              enableThinking,
              salvageTools: enableTools && !forcedProseRound,
              maxTokens: maxOutputTokens,
            });

            for await (const chunk of iterator) {
              lastChunk = chunk;

              if (chunk.message.content) {
                textChunks.push(chunk.message.content);
              }

              if (chunk.message.thinking) {
                thinkChunks.push(chunk.message.thinking);
              }

              if (chunk.message.tool_calls) {
                toolCalls.push(...chunk.message.tool_calls);
              }

              yield chunk;
            }
          } else {
            const bounded = self.boundedClient(model, signal);

            deadline = bounded.deadline;

            const iterator = await bounded.client.chat({
              model,
              messages: requestMessages,
              stream: true,
              // Native Ollama: `think` is a first-class flag. vLLM is the other
              // branch above and uses chat_template_kwargs.enable_thinking.
              // Sent explicitly in both directions — see runNativeChat for why
              // an omitted flag is not "off".
              think: enableThinking,
              ...(iterationWillCallTools && { tools: ollamaTools }),
              // Ollama sizes num_ctx from the memory it sees, which on a
              // unified-memory box means the model's full window (and a giant
              // KV cache) for a one-line chat. CI-Hub already computed the
              // right number for this hardware; honor it when it reached us.
              //
              // `num_predict` rides in the same `options` bag and must not
              // clobber it — this branch used to send `num_ctx` alone, so a
              // caller's `maxOutputTokens` was silently dropped on the native
              // streaming path while the OpenAI branch above honored it as
              // `maxTokens`. ChatTurnService passes one, so the primary
              // interactive chat path was the one losing it.
              ...(((numCtx != null && numCtx > 0) || (maxOutputTokens != null && maxOutputTokens > 0)) && {
                options: {
                  ...(numCtx != null && numCtx > 0 && { num_ctx: numCtx }),
                  ...(maxOutputTokens != null && maxOutputTokens > 0 && { num_predict: maxOutputTokens }),
                },
              }),
            });

            handleAbort = () => iterator.abort();

            signal?.addEventListener('abort', handleAbort);

            for await (const chunk of iterator) {
              lastChunk = chunk;

              if (chunk.message.content) {
                textChunks.push(chunk.message.content);
              }

              if (chunk.message.thinking) {
                thinkChunks.push(chunk.message.thinking);
              }

              if (chunk.message.tool_calls) {
                toolCalls.push(...chunk.message.tool_calls);
              }

              yield chunk;
            }
          }

          if (lastChunk?.done) {
            self.logger.log('LLM prompt evaluation completed', {
              model: lastChunk.model,
              totalDuration: lastChunk.total_duration ? lastChunk.total_duration / 1_000_000 : undefined,
              loadDuration: lastChunk.load_duration ? lastChunk.load_duration / 1_000_000 : undefined,
              evalDuration: lastChunk.prompt_eval_duration
                ? lastChunk.prompt_eval_duration / 1_000_000
                : undefined,
              promptCount: lastChunk.prompt_eval_count,
              evalCount: lastChunk.eval_count,
              doneReason: lastChunk.done_reason,
            });
          }
        } catch (err) {
          if (!(err instanceof DOMException && err.name === 'AbortError')) {
            const surfaced = deadline ? OllamaService.surfaceDeadline(deadline, err) : err;
            const error = surfaced as Error;

            streamError = error instanceof Error ? error : new Error(String(surfaced));

            self.logger.error('LLM prompt evaluation completed', {
              model: lastChunk?.model ?? model,
              doneReason: 'error',
              errorMessage: error?.message ?? String(err),
              errorStack: error instanceof Error ? error.stack : undefined,
            });

            break;
          }
        } finally {
          // The forced round's answer is final whatever the model wanted:
          // executing yet another tool call here would hand the turn back to
          // the loop this round exists to end, so any calls it emitted are
          // dropped — from the loop condition below AND from the stored
          // message, where they would misrepresent the turn as still open.
          if (forcedProseRound && toolCalls.length > 0) {
            self.logger.log('Discarding tool calls emitted in the forced prose round', {
              model: lastChunk?.model ?? model,
              discarded: toolCalls.map((call) => call.function.name),
            });
            toolCalls.splice(0, toolCalls.length);
          }

          const think = thinkChunks.join('');
          const content = textChunks.join('');

          const message = {
            role: 'assistant',
            content: (think ? `<think>${think}</think>` : '') + content,
            ...(toolCalls.length > 0 && { tool_calls: toolCalls.slice() }),
          } satisfies OllamaMessage;

          accumulatedMessages.push(message);

          signal?.removeEventListener('abort', handleAbort);

          if (signal?.aborted) {
            self.logger.log('LLM prompt evaluation completed', {
              model: lastChunk?.model ?? model,
              doneReason: 'canceled',
            });
          }
        }
      } while (toolCalls.length > 0);

      const wrapUp = savedKnowledgeWrapUp(accumulatedMessages);
      if (wrapUp && !signal?.aborted) {
        accumulatedMessages.push({ role: 'assistant', content: wrapUp });
        yield {
          model,
          created_at: new Date(),
          message: { role: 'assistant', content: wrapUp },
          done: false,
          done_reason: '',
          total_duration: 0,
          load_duration: 0,
          prompt_eval_count: 0,
          prompt_eval_duration: 0,
          eval_count: 0,
          eval_duration: 0,
        };
      }
    })(this);

    Object.defineProperty(stream, 'messages', {
      enumerable: true,
      get: () => accumulatedMessages,
    });

    Object.defineProperty(stream, 'error', {
      enumerable: true,
      get: () => streamError,
    });

    return stream as typeof stream & { messages: OllamaMessage[]; error?: Error };
  }

  /**
   * `signal` is optional and additive: it now bounds the whole call — the model
   * lookup included, since that is its own round trip to a host that may be
   * down — rather than being dropped from the parameter type as it used to be.
   */
  async chat(
    context: ChatRequestContext,
    messages: OllamaMessage[],
    options: PromptOptions,
  ): Promise<ChatResponse> {
    return abortable(this.runChat(context, messages, options), options.signal);
  }

  private async runChat(
    context: ChatRequestContext,
    messages: OllamaMessage[],
    options: PromptOptions,
  ): Promise<ChatResponse> {
    const {
      enableTools = false,
      format,
      enableThinking = false,
      signal,
      maxOutputTokens,
      keepAlive,
    } = options;
    const selection: UtilityModelChoice =
      options.tier === 'utility' ? await this.resolveUtilityModel() : { model: options.model };
    const model = selection.model;
    // A caller's explicit window wins over the planner's; the planner's fills
    // the gap every background caller used to leave.
    const numCtx = options.numCtx ?? selection.numCtx;

    await this.validateModel(context, model);

    const inputMessages = messages.slice();
    const availableTools = enableTools ? this.toolsWithinCapability(context) : [];
    const ollamaTools: Tool[] = availableTools.map(this.convertToOllamaTool);
    const openAiDriver = this.llmEndpointService.getOpenAiDriver();
    // vLLM / OpenAI-compat only honors `format: 'json'` (json_object). A JSON
    // Schema object is still useful on the native Ollama path; collapse it here
    // so structured callers still get JSON rather than prose.
    const openAiFormat = typeof format === 'string' ? format : format != null ? 'json' : undefined;

    const accumulatedMessages: OllamaMessage[] = [];

    let response: ChatResponse;

    try {
      response = openAiDriver
        ? await openAiDriver.chat({
            model,
            messages: inputMessages,
            tools: enableTools && ollamaTools.length > 0 ? ollamaTools : undefined,
            format: openAiFormat,
            enableThinking,
            signal,
            maxTokens: maxOutputTokens,
          })
        : await this.runNativeChat({
            model,
            messages: inputMessages,
            format,
            tools: enableTools && ollamaTools.length > 0 ? ollamaTools : undefined,
            signal,
            numCtx,
            maxOutputTokens,
            keepAlive,
            enableThinking,
          });
    } catch (err: unknown) {
      // The planner's watchdog wants to know when the call that was supposed
      // to bring the utility model in never got an answer — see
      // ResidencyPlannerService.noteUtilityOutcome for what it does with it.
      if (options.tier === 'utility') {
        this.residencyPlanner?.noteUtilityOutcome(selection, { ok: false, error: err });
      }

      throw err;
    }

    if (options.tier === 'utility') {
      this.residencyPlanner?.noteUtilityOutcome(selection, { ok: true });
    }

    const willCallTools =
      enableTools && response.message.tool_calls && response.message.tool_calls.length > 0;

    accumulatedMessages.push({
      role: response.message.role,
      content: response.message.content,
      ...(willCallTools && { tool_calls: response.message.tool_calls }),
    } satisfies OllamaMessage);

    if (!willCallTools) {
      return response;
    }

    const toolEvaluations = await this.handleToolCalls(
      context,
      response.message.tool_calls ?? [],
      toolResultByteBudget(null),
    );

    accumulatedMessages.push(...toolEvaluations);

    if (openAiDriver) {
      return openAiDriver.chat({
        model,
        messages: inputMessages.concat(accumulatedMessages),
        tools: enableTools && ollamaTools.length > 0 ? ollamaTools : undefined,
        format: openAiFormat,
        enableThinking,
        signal,
        maxTokens: maxOutputTokens,
      });
    }

    // The follow-up turn is a second full generation on a LONGER transcript
    // (the original messages plus every tool result), so it is the more
    // expensive of the two — and it used to be issued bare: no signal, no
    // output cap, no keep_alive. A caller whose budget had already expired got
    // an uncancellable generation here no matter what it passed, which is the
    // same orphaning `runNativeChat` exists to prevent.
    return this.runNativeChat({
      model,
      messages: inputMessages.concat(accumulatedMessages),
      signal,
      numCtx,
      maxOutputTokens,
      keepAlive,
      enableThinking,
    });
  }

  /**
   * What `tier: 'utility'` runs on right now: the configured utility model at
   * a context window that fits beside the models already resident on the GPU,
   * or the resident chat model when that cannot be shown. Delegates to
   * {@link ResidencyPlannerService}; without one (direct construction in unit
   * tests, or a planner that is off) it is the plain configured id, unplanned.
   *
   * Never throws — a planning failure degrades to the old behaviour and the
   * chat call itself reports whatever is actually wrong with the backend.
   */
  async resolveUtilityModel(): Promise<UtilityModelChoice> {
    if (!this.residencyPlanner) {
      return { model: UTILITY_MODEL };
    }

    return this.residencyPlanner.resolveUtilityModel();
  }

  async resolveModel(context: RequestContext, opts?: ValidateModelOptions): Promise<ValidateModelResult> {
    const { messages = [], requestedModel, enableThinking = false, enableTools = false } = opts ?? {};

    let resolvedModel = requestedModel ?? PROMPT_MODEL;
    let resolvedThinking = enableThinking;
    let resolvedTools = enableTools;

    const pinnedDemoModelsEnabled = await this.featureService.isFeatureEnabled('pinned.demo.models');

    if (pinnedDemoModelsEnabled) {
      const hasVisualContent = messages.some((message) => message.images && message.images.length > 0);

      resolvedModel = hasVisualContent ? DEMO_VISION_MODEL : DEMO_TEXT_MODEL;
      resolvedThinking = hasVisualContent ? false : true;
      resolvedTools = hasVisualContent ? false : true;
      await this.validateModel(context, resolvedModel);
    } else {
      resolvedModel = await this.resolveServedChatModel(context, requestedModel, messages);
      resolvedModel = await this.applyTierRouting(resolvedModel, messages, resolvedThinking);
    }

    return {
      model: resolvedModel,
      enableThinking: resolvedThinking,
      enableTools: resolvedTools,
    };
  }

  /**
   * Consult {@link ModelTierRouter} for the chat model, when the operator has opted
   * in via `llm.tierRouting.enabled` (`LLM_TIER_ROUTING_ENABLED`).
   *
   * ── Why this is opt-in ──────────────────────────────────────────────────────
   *
   * The router's on-device context window (`TIER_PROFILES.on_device`, 8_192) is an
   * *estimate* mirroring Apple's on-device/PCC split — its own doc comment says so.
   * Turning that guess into the default escalation threshold for every chat turn
   * would change model selection on every appliance for a number nobody measured.
   * So the flag defaults to `false` and this method returns `baseModel` untouched,
   * reproducing pre-routing selection exactly. An operator who turns it on names
   * the two model ids AND, ideally, the real context window
   * (`LLM_TIER_ROUTING_ON_DEVICE_CONTEXT_TOKENS`), which replaces the estimate.
   *
   * ── What it does NOT touch ──────────────────────────────────────────────────
   *
   * Vision turns. A turn carrying images is resolved by model *capability*
   * (`resolveServedChatModel`), and a tier has no opinion about whether its model
   * can see. Routing is skipped outright so the vision choice survives verbatim.
   *
   * The chosen id flows into whichever driver `chat`/`chatStream` picks — native
   * `ollama.chat` or `OpenAiCompatChatDriver` — because both take their model from
   * this one resolution. Routing is a *selection* concern, not a transport one.
   */
  private async applyTierRouting(
    baseModel: string,
    messages: OllamaMessage[],
    enableThinking: boolean,
  ): Promise<string> {
    const routing = config.llm.tierRouting;

    if (!routing.enabled) {
      return baseModel;
    }

    if (messages.some((message) => message.images && message.images.length > 0)) {
      return baseModel;
    }

    const onDeviceModel = routing.onDeviceModel.trim();
    const escalatedModel = routing.escalatedModel.trim();
    const served = await this.listServedChatModelIds();
    // No escalation target, or one the backend is not serving, is exactly the
    // "PCC unavailable" case the router already knows how to fall back from.
    const cloudAvailable = escalatedModel.length > 0 && served.includes(escalatedModel);

    const decision: RoutingDecision = this.modelTierRouter.decide({
      estimatedInputTokens: estimateInputTokens(messages),
      // A user who asked for thinking asked for deeper reasoning.
      reasoningLevel: enableThinking ? 'deep' : 'moderate',
      cloudAvailable,
      ...(routing.onDeviceContextTokens > 0 && {
        onDeviceContextTokens: routing.onDeviceContextTokens,
      }),
    });

    const target = decision.tier === 'private_cloud' ? escalatedModel : onDeviceModel;
    // An unconfigured or unserved tier model means "no opinion" — keep what the
    // served-model resolution already chose rather than failing the turn.
    const model = target.length > 0 && served.includes(target) ? target : baseModel;

    this.logger.debug('Model tier routing decision', {
      tier: decision.tier,
      reasoningLevel: decision.reasoningLevel,
      downgraded: decision.downgraded,
      reasons: decision.reasons,
      maxContextTokens: decision.profile.maxContextTokens,
      baseModel,
      model,
    });

    return model;
  }

  /**
   * Pick a chat model that is actually loaded on the active backend (vLLM via
   * OpenAI-compat, or Ollama). Config defaults like `gemma3:1b` are only used
   * when that id is in the served list — title jobs and background inference
   * must not fail because the compile-time default is not loaded.
   *
   * When the turn carries images and the backend is native Ollama, prefer a
   * served model that reports the `vision` capability. The stash version still
   * sent images to `PROMPT_MODEL` whenever that id was loaded (usually a
   * text-only chat model). OpenAI-compat backends (vLLM) expose a single chat
   * id — keep that; listeners complete on a non-multimodal 400 rather than
   * inventing `llava:7b`.
   */
  /**
   * The chat model a user's turn actually runs on — including the model a
   * vision turn (a turn carrying images) is shown.
   *
   * `effectiveChatModel` is {@link ChatModelPreferenceService}'s per-user
   * override, falling back to the appliance's {@link PROMPT_MODEL} constant
   * when the user has none. It is the SAME model for a text turn and an
   * image turn — a deliberate simplification over what this method used to
   * do, which was scan every model the backend had installed (not just
   * loaded) for the first one reporting the `vision` capability and silently
   * reroute an image turn onto it. That meant a household appliance with two
   * models pulled could load-swap on every other request depending on
   * whether the last one carried an image — the exact GPU thrash a shared
   * appliance can least afford (each swap is a multi-second reload, and on a
   * VRAM-constrained card it evicts the OTHER model outright).
   *
   * The one exception is {@link UTILITY_MODEL}, and only when
   * {@link UTILITY_MODEL_EXPLICITLY_CONFIGURED} — an operator (or the Hub
   * installer, on hardware with room for two resident models) set
   * `LLM_UTILITY_MODEL` on purpose. If IT reports vision, a vision turn uses
   * it instead of the user's chat model: background vision work (image
   * descriptions, thing-vision extraction) is exactly the kind of job a
   * smaller model should carry, sized to the box by whoever configured it —
   * never guessed at by scanning what happens to be installed.
   *
   * If neither the utility model nor the user's chat model can do vision, this
   * still returns the user's chat model. The two vision listeners already
   * treat the resulting 400 (`isNonMultimodalModelError`) as "complete the
   * job without a description" rather than a failure — silently picking some
   * OTHER model instead would reintroduce the thrash this replaced.
   */
  private async resolveServedChatModel(
    context: RequestContext,
    requestedModel?: string | null,
    messages: OllamaMessage[] = [],
  ): Promise<string> {
    const served = await this.listServedChatModelIds();

    if (served.length === 0) {
      throw new Error('No chat model is currently loaded on vLLM or Ollama');
    }

    const hasVisualContent = messages.some((message) => message.images && message.images.length > 0);

    // Per-model capability probing (both the explicit-request check just
    // below and resolveVisionModel's own) is meaningless on the OpenAI-compat
    // transport: vLLM exposes exactly one served chat id and no way to ask it
    // "can you see" — getAvailableModels hard-codes `vision: false` for that
    // mode. resolveVisionModel already returns the plain effective chat model
    // in that case; skip straight past it rather than calling
    // fetchModelCapabilities against a transport that cannot answer it.
    if (hasVisualContent && !this.llmEndpointService.getOpenAiDriver()) {
      // An explicit, actually-vision-capable request wins outright — this is
      // the interactive Capture flow's own model picker (a person choosing,
      // for this one photo, right now), which must keep working exactly as
      // before. Automatic/background vision work (image descriptions, thing
      // vision) essentially never sets this; requestedModel is undefined and
      // resolution falls straight through to the rule below.
      const requested = requestedModel?.trim();

      if (requested && served.includes(requested)) {
        const requestedCaps = await this.fetchModelCapabilities(requested, { throwOnError: false });

        if (requestedCaps.includes('vision')) {
          return requested;
        }
      }

      const { model } = await this.resolveVisionModel(context.userId, served);

      if (served.includes(model)) {
        return model;
      }
    }

    const effectiveChatModel = await this.resolveEffectiveChatModel(context.userId, served);
    const candidates = [requestedModel, effectiveChatModel].filter((model): model is string =>
      Boolean(model && model.trim()),
    );

    return candidates.find((model) => served.includes(model)) ?? served[0];
  }

  /**
   * The chat model this user's work actually runs on: their Settings → Model
   * override when the backend is serving it, otherwise the appliance default
   * ({@link PROMPT_MODEL}) when THAT is served, otherwise the default anyway
   * and the caller decides (chat falls through to the first served model; a
   * vision probe of an unserved model reads as "cannot see").
   *
   * A stored override naming a model that is no longer installed — the tag
   * was removed or renamed underneath the preference — must not steer
   * anything. Before this it did, twice over: chat skipped the appliance
   * default entirely and landed on whichever model `ollama list` returned
   * first, and {@link resolveVisionModel} probed the missing model's
   * capabilities, got none, and silently switched "Describe images" off for
   * every job (measured 2026-09-16: a stale `qwen3.6:27b` after the tag was
   * removed drained the whole description queue as "disabled"). The
   * preference itself is left in place — the settings page clears it — this
   * only stops it winning. Warned once per user and model per process, not
   * once per queued job.
   */
  private async resolveEffectiveChatModel(userId: string | undefined, served: string[]): Promise<string> {
    const userOverride = userId ? await this.chatModelPreference?.getChatModel(userId) : null;

    if (userOverride && served.includes(userOverride)) {
      return userOverride;
    }

    if (userOverride) {
      const key = `${userId}:${userOverride}`;

      if (!this.staleChatModelOverridesWarned.has(key)) {
        this.staleChatModelOverridesWarned.add(key);
        this.logger.warn(
          'Stored chat model is not served by the active LLM backend; ignoring the preference',
          {
            userId,
            storedModel: userOverride,
            fallbackModel: served.includes(PROMPT_MODEL) ? PROMPT_MODEL : (served[0] ?? null),
          },
        );
      }
    }

    return PROMPT_MODEL;
  }

  /**
   * The single source of truth for "what model does this user's vision work
   * run on, and can it actually see" — shared by {@link resolveServedChatModel}
   * (a chat turn carrying images) and {@link ImageDescriptionPreferenceService}
   * (deciding whether "Describe images" defaults on). Both MUST agree: a
   * setting that defaulted on for a model the chat path would never actually
   * hand images to would describe nothing and look broken.
   *
   * See {@link resolveServedChatModel}'s doc comment for why this is one model
   * for everyone's vision work (barring the opt-in utility-model exception),
   * not a scan of every installed model.
   */
  async resolveVisionModel(
    userId: string | undefined,
    served?: string[],
  ): Promise<{ model: string; supportsVision: boolean }> {
    const servedIds = served ?? (await this.listServedChatModelIds());
    const effectiveChatModel = await this.resolveEffectiveChatModel(userId, servedIds);

    // vLLM/OpenAI-compat exposes one served chat id with no per-model
    // capability probe (getAvailableModels hard-codes `vision: false` for
    // that mode) — there is no second model to prefer, and no way to ask it
    // whether it can see.
    if (this.llmEndpointService.getOpenAiDriver()) {
      return { model: effectiveChatModel, supportsVision: false };
    }

    if (UTILITY_MODEL_EXPLICITLY_CONFIGURED && servedIds.includes(UTILITY_MODEL)) {
      const utilityCaps = await this.fetchModelCapabilities(UTILITY_MODEL, { throwOnError: false });

      if (utilityCaps.includes('vision')) {
        return { model: UTILITY_MODEL, supportsVision: true };
      }
    }

    const caps = await this.fetchModelCapabilities(effectiveChatModel, { throwOnError: false });

    return { model: effectiveChatModel, supportsVision: caps.includes('vision') };
  }

  private async listServedChatModelIds(): Promise<string[]> {
    const openAiDriver = this.llmEndpointService.getOpenAiDriver();

    if (openAiDriver) {
      const modelIds = await openAiDriver.listModels();

      return modelIds.filter((id) => !INTERNAL_MODELS.has(this.parseOllamaModel(id).name));
    }

    const result = await this.ollama.list();

    return result.models
      .map((model: { name: string }) => model.name)
      .filter((name: string) => !INTERNAL_MODELS.has(this.parseOllamaModel(name).name));
  }

  private parseOllamaModel(model: string): OllamaModel {
    const [fullName, tag = 'latest'] = model.split(':');
    const parts = fullName.split('/');

    if (parts.length === 2) {
      const [namespace, name] = parts;

      return {
        model,
        namespace,
        name,
        tag,
      };
    }

    return {
      model,
      namespace: null,
      name: parts[0],
      tag,
    };
  }

  /**
   * The tools to advertise to the model for this caller.
   *
   * Mirrors what MCP's `getToolsForRequest` does for its catalog: do not offer a read-only caller
   * a delete it will be refused. This is presentation, not enforcement — the model can name any
   * tool it likes regardless of what it was shown, which is why the registry re-checks — but a
   * model handed a catalog whose entries fail is a model that retries them.
   */
  private toolsWithinCapability(context: ChatRequestContext): ToolSchema[] {
    const capability = resolveInvocationCapability(context);

    return this.toolRegistry
      .getAgentFacingTools(context)
      .filter((schema) => capabilityAllows(schema.privacy, capability));
  }

  private async handleToolCalls(
    context: ChatRequestContext,
    toolCalls: ToolCall[],
    resultByteBudget: number,
  ): Promise<OllamaMessage[]> {
    if (toolCalls.length === 0) {
      this.logger.debug('No tool calls to evaluate, skipping handling', {
        userId: context.userId,
      });

      return [];
    }

    this.logger.debug('Processing tool calls', {
      toolCallCount: toolCalls.length,
      toolNames: toolCalls.map((tc) => tc.function.name),
      userId: context.userId,
    });

    // The name and arguments below came out of a language model that was reading user-supplied
    // text, so they are attacker-influenced input, not a decision the caller made. The capability
    // carried here is what bounds them: the registry refuses anything above it.
    const invocationContext: ToolInvocationContext = {
      ...context,
      capability: resolveInvocationCapability(context),
    };

    const toolResults = await Promise.all(
      toolCalls.map(async (toolCall) => {
        const { name, arguments: args } = toolCall.function;
        const toolName = canonicalizeExecutableToolName(name);

        try {
          const result = await this.toolRegistry.executeTool(toolName, invocationContext, args);

          return {
            call: toolCall,
            result: result.success ? result.data : { error: result.error },
            success: result.success,
          };
        } catch (error) {
          this.logger.error('Tool execution failed', {
            toolName,
            error: error instanceof Error ? error.message : String(error),
            userId: context.userId,
          });

          return {
            call: toolCall,
            result: { error: 'Tool execution failed' },
            success: false,
          };
        }
      }),
    );

    // Bounded, never raw-stringified: tool results are the one prompt block
    // the context budget does not admit, and an unbounded one loses the whole
    // follow-up turn to window truncation. See toolResultBudget.ts for the
    // measured incident.
    //
    // `resultByteBudget` is the ROUND's share of the context window (see
    // toolResultByteBudget's own doc), not each individual call's — a round
    // with N tool calls must split it N ways, or the round's actual total is
    // N times the intended budget.
    const perCallByteBudget = Math.max(1, Math.floor(resultByteBudget / toolResults.length));

    return toolResults.map(
      ({ result }) =>
        ({
          role: 'tool' as const,
          content: boundToolResultForPrompt(result, perCallByteBudget),
        }) satisfies OllamaMessage,
    );
  }

  private convertToOllamaTool(toolSchema: ToolSchema): Tool {
    return {
      type: 'function',
      function: {
        name: intentToolName(toolSchema.name),
        description: toolSchema.description,
        parameters: toolSchema.parameters,
      },
    };
  }

  private async validateModel(_context: RequestContext, requestedModel: string) {
    const openAiDriver = this.llmEndpointService.getOpenAiDriver();

    if (openAiDriver) {
      const modelIds = await openAiDriver.listModels();

      if (!modelIds.includes(requestedModel)) {
        throw new Error(`Invalid model specified: ${requestedModel}`);
      }

      return;
    }

    const result = await this.ollama.list();
    const validModel = result.models.find((model) => model.name === requestedModel);

    if (!validModel) {
      throw new Error(`Invalid model specified: ${requestedModel}`);
    }
  }

  private async fetchModelCapabilities(
    requestedModel: string,
    options: { throwOnError?: boolean } = {},
  ): Promise<string[]> {
    const { throwOnError = true } = options;

    if (this.llmEndpointService.usesOpenAiDriver()) {
      return OPENAI_MODE_CAPABILITIES;
    }

    try {
      const response = (await this.ollama.show({ model: requestedModel })) as {
        capabilities?: unknown;
      };

      if (!Array.isArray(response.capabilities)) {
        return [];
      }

      return response.capabilities
        .filter((capability): capability is string => typeof capability === 'string')
        .map((capability) => capability.toLowerCase());
    } catch (error) {
      if (throwOnError) {
        throw error;
      }

      this.logger.warn('Failed to fetch Ollama model capabilities while listing models', {
        model: requestedModel,
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }
}

/**
 * Exported for direct unit testing — see `__tests__/OllamaService.savedKnowledgeWrapUp.test.ts`.
 * A tool-only turn (the model called `memory.remember` or similar and produced
 * no prose of its own) leaves the user looking at silence unless something
 * says what happened; a turn that already has prose needs no synthetic
 * addition.
 */
export function savedKnowledgeWrapUp(messages: OllamaMessage[]): string | null {
  const assistants = messages.filter((message) => message.role === 'assistant');
  const hasProse = assistants.some(
    (message) => message.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() !== '',
  );
  const hasTools = assistants.some((message) => (message.tool_calls?.length ?? 0) > 0);
  if (!hasTools || hasProse) {
    return null;
  }

  let created = 0;
  for (const message of messages) {
    if (message.role !== 'tool' || !message.content) {
      continue;
    }

    try {
      const parsed = JSON.parse(message.content) as {
        error?: unknown;
        createdNodes?: number;
        createdRelationships?: number;
      };
      if (parsed.error) {
        continue;
      }

      created += (parsed.createdNodes ?? 0) + (parsed.createdRelationships ?? 0);
    } catch {
      // Tool payloads that are not JSON are not a save summary.
    }
  }

  return created > 0 ? 'Saved.' : null;
}
