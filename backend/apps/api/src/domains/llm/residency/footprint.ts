/**
 * GPU footprint estimation and the co-residency decision for the utility model.
 *
 * Pure functions only — no I/O, no config. `ResidencyPlannerService` gathers
 * the inputs (Ollama's `/api/ps`, `/api/show`, `/api/tags`; the GPU's memory
 * counters) and calls {@link planUtilityResidency}.
 *
 * ## The failure this prevents
 *
 * Ollama's scheduler decides whether a second model fits from ITS OWN
 * prediction, and when the prediction says no it evicts the least-recently
 * used runner. A chat model that is never idle (an HBPE labeler firing ~190
 * requests per ten minutes keeps it that way) cannot be evicted, so the load
 * request for the utility model waits — and every later request for any
 * non-resident model queues behind it with no log line. Embeds then hit their
 * 270 s timeout and jobs their 600 s `JobTimeoutError`. That is the wedge of
 * 2026-09-14, and it was triggered by CI-Server asking for `gemma4:e4b` beside a
 * resident `qwen3.6:27b` on a 24 GiB card.
 *
 * The rule here is therefore: **a utility call never triggers an eviction.**
 * If the utility model is not already resident and cannot fit beside what is,
 * the call goes to the resident chat model instead.
 *
 * ## Why the estimate must stay ABOVE Ollama's prediction
 *
 * Ollama admits on its prediction, not on actual usage. If this estimate says
 * "fits" when Ollama's says "does not", Ollama still tries to evict, and the
 * wedge recurs. So the estimate must be at least as pessimistic as Ollama's for
 * the same model and context. Two measured points (journal, 2026-09-14, both at
 * `num_ctx` 32768):
 *
 *   | model        | weight file | Ollama predicted | actual resident |
 *   |--------------|-------------|------------------|-----------------|
 *   | gemma4:e4b   |  8.95 GiB   |    12.2 GiB      |   (not loaded)  |
 *   | qwen3.6:27b  | 16.22 GiB   |    17.9 GiB      |   17.23 GiB     |
 *
 * {@link estimateFootprintBytes} gives 12.7 GiB and 29 GiB for those two from
 * metadata alone (the second is wildly over because the formula counts every
 * layer as full attention, and qwen3.5 is three-quarters linear attention);
 * with one live observation of qwen3.6:27b it tightens to 18.5 GiB — still
 * above 17.9. Over-estimating costs a slower background job on the chat model.
 * Under-estimating costs the wedge. The asymmetry decides every tie here.
 */

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;

/**
 * Context windows the planner tries for the utility model, largest first. The
 * top rung matches Ollama's own VRAM-based default on a 24 GiB card
 * (`default_num_ctx=32768`), so a utility model that fits at the top rung runs
 * exactly as it would have without the planner — just without the eviction.
 */
export const UTILITY_CONTEXT_LADDER: readonly number[] = [32_768, 16_384, 8_192, 4_096];

/** Bytes per KV-cache element. Ollama's default cache type is f16. */
export const KV_BYTES_PER_ELEMENT = 2;

/**
 * Runner memory that does not scale with context: the llama-server compute
 * buffers, the CUDA/HIP scratch pool, the graph. Sized so the metadata-only
 * estimate for `gemma4:e4b` (the tighter of the two measured cases above)
 * lands ~0.5 GiB above Ollama's prediction rather than ~0.25 GiB.
 */
export const FIXED_RUNNER_OVERHEAD_BYTES = 768 * MIB;

/**
 * Multiplier applied to a LIVE measurement's context-dependent bytes before
 * trusting it. Ollama's prediction ran 1.67× the measured dynamic bytes for
 * qwen3.6:27b (1.68 GiB predicted above the weights vs 1.01 GiB actually
 * resident above them); 1.5× plus {@link FIXED_RUNNER_OVERHEAD_BYTES} clears it.
 */
export const OBSERVATION_SAFETY_FACTOR = 1.5;

/** The attention geometry `/api/show` reports under `model_info`. */
export interface ModelGeometry {
  architecture: string;
  blockCount: number;
  headCount: number;
  /**
   * `null` when the GGUF stores it per layer (hybrid architectures such as
   * qwen3.5 do; the JSON API drops arrays), in which case {@link kvBytesPerToken}
   * falls back to `headCount` — an upper bound.
   */
  headCountKv: number | null;
  keyLength: number;
  valueLength: number;
  /** The model's training window; the ladder is capped by it. */
  trainingContextLength: number | null;
  /** gemma4: layers that reuse another layer's KV and so own none. */
  sharedKvLayers: number;
  /** qwen3.5: one layer in N is full attention; the rest hold ctx-independent state. */
  fullAttentionInterval: number | null;
}

type ModelInfo = Map<string, unknown> | Record<string, unknown>;

function infoValue(info: ModelInfo, key: string): unknown {
  return info instanceof Map ? info.get(key) : info[key];
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * Read the geometry out of a `/api/show` response's `model_info`.
 *
 * Returns `null` when the block count or head count is missing — without
 * those there is no KV estimate, and a caller must treat the model as not
 * plannable rather than guess. `key_length`/`value_length` are optional: older
 * GGUFs (llama, nomic-bert) omit them and the head dimension is
 * `embedding_length / head_count`.
 */
export function parseModelGeometry(modelInfo: ModelInfo | null | undefined): ModelGeometry | null {
  if (!modelInfo) {
    return null;
  }

  const architecture = infoValue(modelInfo, 'general.architecture');

  if (typeof architecture !== 'string' || architecture.length === 0) {
    return null;
  }

  const read = (suffix: string) => infoValue(modelInfo, `${architecture}.${suffix}`);
  const blockCount = positiveInteger(read('block_count'));
  const headCount = positiveInteger(read('attention.head_count'));

  if (blockCount == null || headCount == null) {
    return null;
  }

  const embeddingLength = positiveInteger(read('embedding_length'));
  const derivedHeadDim = embeddingLength != null ? Math.ceil(embeddingLength / headCount) : null;
  const keyLength = positiveInteger(read('attention.key_length')) ?? derivedHeadDim;
  const valueLength = positiveInteger(read('attention.value_length')) ?? keyLength;

  if (keyLength == null || valueLength == null) {
    return null;
  }

  return {
    architecture,
    blockCount,
    headCount,
    headCountKv: positiveInteger(read('attention.head_count_kv')),
    keyLength,
    valueLength,
    trainingContextLength: positiveInteger(read('context_length')),
    sharedKvLayers: positiveInteger(read('attention.shared_kv_layers')) ?? 0,
    fullAttentionInterval: positiveInteger(read('full_attention_interval')),
  };
}

/**
 * f16 KV-cache bytes per token of context, summed over the layers that own a
 * full-attention KV cache.
 *
 * Sliding-window layers (gemma3/gemma4 `sliding_window`) are deliberately
 * counted at full size: the API does not say WHICH layers slide, and counting
 * them all as global is the conservative reading.
 */
export function kvBytesPerToken(geometry: ModelGeometry): number {
  const kvHeads = geometry.headCountKv ?? geometry.headCount;
  let layers = Math.max(1, geometry.blockCount - geometry.sharedKvLayers);

  if (geometry.fullAttentionInterval != null && geometry.fullAttentionInterval > 1) {
    layers = Math.ceil(layers / geometry.fullAttentionInterval);
  }

  return layers * kvHeads * (geometry.keyLength + geometry.valueLength) * KV_BYTES_PER_ELEMENT;
}

/** One `/api/ps` sighting of a model, kept to tighten later estimates. */
export interface ResidencyObservation {
  numCtx: number;
  sizeVramBytes: number;
  weightBytes: number;
  /**
   * What the CARD lost to this model while it was resident, from the GPU counters: sysfs
   * used bytes minus every other resident's `size_vram`. Unlike `sizeVramBytes` (Ollama's
   * own accounting, weights + KV) this includes the vision encoder's compute buffers,
   * llama.cpp scratch and the prompt cache — measured 2026-09-17: 23.0 GiB on the card for
   * a 27B whose `/api/ps` said 16.2 GiB. Recorded only for the largest resident, the one
   * those buffers belong to; absent for the rest and for older files.
   */
  cardBytes?: number;
  /** Total context tokens the runner held at that sighting (per-slot window × slots). */
  totalTokens?: number;
}

export interface FootprintInputs {
  /** The GGUF file size from `/api/tags` — what the weights cost when fully offloaded. */
  weightBytes: number;
  geometry: ModelGeometry;
  numCtx: number;
  observation?: ResidencyObservation | null;
}

/**
 * Predicted resident size of `model` loaded at `numCtx`.
 *
 * The metadata formula is an upper bound (every non-shared layer as full
 * attention). A live observation of the same model tightens it: the bytes it
 * actually used above its weights, scaled to `numCtx`, times
 * {@link OBSERVATION_SAFETY_FACTOR}. The smaller of the two wins, because both
 * are already biased high and the formula alone would refuse hybrid models
 * (qwen3.5) that fit comfortably.
 */
export function estimateFootprintBytes({
  weightBytes,
  geometry,
  numCtx,
  observation,
}: FootprintInputs): number {
  const formula = weightBytes + kvBytesPerToken(geometry) * numCtx + FIXED_RUNNER_OVERHEAD_BYTES;

  if (!observation || observation.numCtx <= 0) {
    return formula;
  }

  const dynamicBytes = Math.max(0, observation.sizeVramBytes - observation.weightBytes);
  const calibrated =
    weightBytes +
    (dynamicBytes / observation.numCtx) * numCtx * OBSERVATION_SAFETY_FACTOR +
    FIXED_RUNNER_OVERHEAD_BYTES;
  const estimate = Math.min(formula, calibrated);

  // A card-level sighting outranks both when it says MORE: it is the only number that
  // includes the buffers neither the formula nor Ollama's `size_vram` know about. It is
  // carried to the requested layout by the KV delta alone — buffers do not grow with
  // context — and never lets the answer drop below what the formula says.
  if (
    observation.cardBytes != null &&
    observation.cardBytes > 0 &&
    observation.totalTokens != null &&
    observation.totalTokens > 0
  ) {
    const measured = observation.cardBytes + kvBytesPerToken(geometry) * (numCtx - observation.totalTokens);

    return Math.max(estimate, measured);
  }

  return estimate;
}

/**
 * A card-level sighting the planner may trust, or the same observation with
 * the card figure struck.
 *
 * The card figure is "everything the counter saw beyond the other residents",
 * and the counter cannot tell a runner's baseline from what it grew into. A
 * runner that leaks (measured 2026-09-22: ~1.9 MiB per request on ROCm, no
 * plateau) is still a resident, so the sighting only ever gets bigger — until
 * it says the model needs more than the card can give at the window it is
 * visibly running at. That is a contradiction, not a measurement: the model
 * IS running there. With the figure kept, every rung of the ladder "fails to
 * fit" and the planner asks for 4k the moment the model is not resident, while
 * every caller that never asked the planner loads it at 32k — the reload loop
 * of 2026-09-22 (29 loads in 3.5 min). `capacityBytes` is what the planner
 * would let the model have on its own: the card less the embedder's reserve
 * and the safety margin.
 */
export function trustworthyObservation(
  observation: ResidencyObservation | null | undefined,
  capacityBytes: number,
): ResidencyObservation | null {
  if (observation == null) {
    return null;
  }

  if (observation.cardBytes != null && observation.cardBytes > capacityBytes) {
    const { cardBytes: _cardBytes, totalTokens: _totalTokens, ...rest } = observation;

    return rest;
  }

  return observation;
}

/** Ollama lists `nomic-embed-text` as `nomic-embed-text:latest`; config says the former. */
export function canonicalModelId(model: string): string {
  const trimmed = model.trim();

  return trimmed.endsWith(':latest') ? trimmed.slice(0, -':latest'.length) : trimmed;
}

export function sameModel(a: string, b: string): boolean {
  return canonicalModelId(a) === canonicalModelId(b);
}

/** One row of `/api/ps`. */
export interface ResidentModel {
  name: string;
  sizeVramBytes: number;
  /** The `num_ctx` it was loaded with; asking for the same value never reloads it. */
  contextLength: number | null;
}

export type GpuMemorySource = 'sysfs' | 'nvidia-smi' | 'config';

export interface GpuMemory {
  totalBytes: number;
  usedBytes: number;
  source: GpuMemorySource;
  /** Card path or GPU name, for the log line. */
  device?: string;
}

/** What is known about the utility model as a LOAD candidate. `null` = not served. */
export interface UtilityCandidate {
  weightBytes: number | null;
  geometry: ModelGeometry | null;
  observation?: ResidencyObservation | null;
}

export interface PlanInputs {
  utilityModel: string;
  chatModel: string;
  residents: readonly ResidentModel[];
  gpu: GpuMemory | null;
  candidate: UtilityCandidate | null;
  /** Memory held back for the embedding model when it is NOT already resident. */
  embedReserveBytes: number;
  safetyMarginBytes: number;
  ladder?: readonly number[];
  /**
   * Set by the watchdog after a planned load never became resident: until
   * this passes, no load is proposed at all. The chat model still serves.
   */
  coResidencyBlocked?: { untilMs: number; reason: string } | null;
  /** Injected for tests; defaults to `Date.now()`. */
  nowMs?: number;
  /** Ollama slots per loaded model (`OLLAMA_NUM_PARALLEL`); each holds a full KV cache. Default 1. */
  parallelSlots?: number;
}

export type UtilityPlanKind = 'resident' | 'load' | 'routed';

/** What a caller passes to `OllamaService.chat` in place of a bare model id. */
export interface UtilityModelChoice {
  model: string;
  /**
   * Absent means the plan named none (a routed call whose chat model is not
   * resident). `OllamaService.chat` then fills it from the chat-context plan,
   * so no call is left to Ollama's own default — a second, silent planner that
   * disagreed with this one on every cold start.
   */
  numCtx?: number;
  /**
   * How the choice was reached. `'load'` means this call is the one that asks
   * Ollama to bring the model in, which is what the watchdog watches.
   */
  kind?: UtilityPlanKind;
}

export type UtilityPlan = UtilityModelChoice &
  (
    | { kind: 'resident'; reason: string }
    | { kind: 'load'; footprintBytes: number; headroomBytes: number }
    | { kind: 'routed'; reason: string; headroomBytes: number | null; smallestFootprintBytes: number | null }
  );

/** The resident chat model to route to, with the context it is already loaded at. */
function routeToChat(
  inputs: PlanInputs,
  reason: string,
  headroomBytes: number | null,
  smallestFootprintBytes: number | null,
): UtilityPlan {
  const residentChat = inputs.residents.find((resident) => sameModel(resident.name, inputs.chatModel));

  return {
    kind: 'routed',
    model: inputs.chatModel,
    ...(residentChat?.contextLength != null &&
      residentChat.contextLength > 0 && { numCtx: residentChat.contextLength }),
    reason,
    headroomBytes,
    smallestFootprintBytes,
  };
}

/**
 * Decide what the next utility call should run on.
 *
 * 1. Already resident → use it, at the context it is loaded with. Sending a
 *    different `num_ctx` can make Ollama reload the runner, which is a
 *    multi-second stall and a memory spike for nothing.
 * 2. Not served, or GPU memory unknown, or no geometry → route to the chat
 *    model. Every one of those is "cannot prove it fits", and the rule is that
 *    a utility call never gambles on an eviction.
 * 3. Otherwise walk the ladder, largest first, and take the first context at
 *    which the estimated footprint fits the live headroom. Nothing fits →
 *    route to the chat model.
 *
 * Headroom is measured against LIVE used memory, so HBPE's direct `/dev/kfd`
 * allocation — invisible to Ollama's own fit check — is already subtracted.
 */
/**
 * Context windows tried for the CHAT model when nothing configured one, largest
 * first. Same rungs as {@link UTILITY_CONTEXT_LADDER}, and the 32k top is
 * deliberate: {@link estimateFootprintBytes} counts weights and KV cache, not
 * the vision encoder's compute buffers or llama.cpp's scratch — measured
 * 2026-09-17, a 27B at 32k held 16.2 GiB by `/api/ps` while the card showed
 * 22.5 GiB in use. A 64k rung would pass the estimate on a 24 GB card and
 * spill to CPU on the real one. Windows above 32k are an operator's or
 * CI-Hub's explicit call, via `CI_LLM_NUM_CTX`, never this planner's.
 */
export const CHAT_CONTEXT_LADDER: readonly number[] = [32_768, 16_384, 8_192, 4_096];

export interface ChatContextInputs {
  chatModel: string;
  residents: ResidentModel[];
  gpu: GpuMemory | null;
  /** Weights, geometry and any live sighting of the chat model; null when the backend does not serve it. */
  candidate: UtilityCandidate | null;
  /** Bytes to keep free for the embedding model when it is not already resident. */
  embedReserveBytes: number;
  safetyMarginBytes: number;
  ladder?: readonly number[];
  /** Ollama slots per loaded model (`OLLAMA_NUM_PARALLEL`); each holds a full KV cache. Default 1. */
  parallelSlots?: number;
}

export type ChatContextPlan =
  /** The chat model is loaded; asking for its loaded window never reloads it. */
  | { kind: 'resident'; numCtx: number }
  /** Not loaded; the largest rung whose estimated footprint fits the card. */
  | { kind: 'planned'; numCtx: number; footprintBytes: number; headroomBytes: number }
  /** Nothing can be proven; the caller keeps its configured fallback. */
  | { kind: 'unknown'; reason: string };

/**
 * The chat model's context window, derived from the machine rather than from a
 * guess, for the case where CI-Hub exported no `CI_LLM_NUM_CTX` (a standalone
 * ci-server, or a manifest that never mapped it).
 *
 * Unlike {@link planUtilityResidency} this does NOT refuse to evict: the chat
 * model is the appliance's primary and Ollama will displace whatever else is
 * resident to load it. Its headroom is therefore the whole card less the
 * embedding model's reserve and the safety margin — not the card less the
 * current residents.
 */
export function planChatContext(inputs: ChatContextInputs): ChatContextPlan {
  const { chatModel, residents, gpu, candidate, embedReserveBytes, safetyMarginBytes } = inputs;
  const ladder = inputs.ladder ?? CHAT_CONTEXT_LADDER;
  const slots = Math.max(1, Math.floor(inputs.parallelSlots ?? 1));

  const resident = residents.find((model) => sameModel(model.name, chatModel));
  if (resident?.contextLength != null && resident.contextLength > 0) {
    return { kind: 'resident', numCtx: resident.contextLength };
  }

  if (gpu == null) {
    return { kind: 'unknown', reason: 'GPU memory is unknown, so a fit cannot be proven' };
  }

  if (candidate == null) {
    return { kind: 'unknown', reason: `"${chatModel}" is not served by the backend` };
  }

  if (candidate.weightBytes == null || candidate.geometry == null) {
    return { kind: 'unknown', reason: `"${chatModel}" reports no usable size or attention geometry` };
  }

  const headroomBytes = gpu.totalBytes - embedReserveBytes - safetyMarginBytes;
  const observation = trustworthyObservation(candidate.observation, headroomBytes);
  const trainingMax = candidate.geometry.trainingContextLength;
  const rungs = ladder.filter((ctx) => trainingMax == null || ctx <= trainingMax);
  const candidates = rungs.length > 0 ? rungs : trainingMax != null ? [trainingMax] : [];

  for (const numCtx of candidates) {
    // `numCtx` is the PER-SLOT window the request will name; the runner allocates KV for
    // every slot, so the footprint is charged for all of them.
    const footprintBytes = estimateFootprintBytes({
      weightBytes: candidate.weightBytes,
      geometry: candidate.geometry,
      numCtx: numCtx * slots,
      observation,
    });
    if (footprintBytes <= headroomBytes) {
      return { kind: 'planned', numCtx, footprintBytes, headroomBytes };
    }
  }

  return { kind: 'unknown', reason: `"${chatModel}" does not fit on the card at any rung of the ladder` };
}

export function planUtilityResidency(inputs: PlanInputs): UtilityPlan {
  const { utilityModel, residents, gpu, candidate, embedReserveBytes, safetyMarginBytes } = inputs;
  const ladder = inputs.ladder ?? UTILITY_CONTEXT_LADDER;

  const resident = residents.find((model) => sameModel(model.name, utilityModel));

  if (resident) {
    return {
      kind: 'resident',
      model: utilityModel,
      ...(resident.contextLength != null && resident.contextLength > 0 && { numCtx: resident.contextLength }),
      reason: 'already resident',
    };
  }

  if (candidate == null) {
    return routeToChat(inputs, `"${utilityModel}" is not served by the backend`, null, null);
  }

  const blocked = inputs.coResidencyBlocked;

  if (blocked && (inputs.nowMs ?? Date.now()) < blocked.untilMs) {
    const remainingMin = Math.ceil((blocked.untilMs - (inputs.nowMs ?? Date.now())) / 60_000);

    return routeToChat(
      inputs,
      `co-residency is paused for ${remainingMin} more min — ${blocked.reason}`,
      null,
      null,
    );
  }

  if (gpu == null) {
    return routeToChat(inputs, 'GPU memory is unknown, so a fit cannot be proven', null, null);
  }

  if (candidate.weightBytes == null || candidate.geometry == null) {
    return routeToChat(inputs, `"${utilityModel}" reports no usable size or attention geometry`, null, null);
  }

  const headroomBytes = gpu.totalBytes - gpu.usedBytes - embedReserveBytes - safetyMarginBytes;
  // Judged against the card, not the headroom: the sighting is contradicted by what the
  // whole card can hold, whatever else happens to be resident right now.
  const observation = trustworthyObservation(
    candidate.observation,
    gpu.totalBytes - embedReserveBytes - safetyMarginBytes,
  );
  const trainingMax = candidate.geometry.trainingContextLength;
  const rungs = ladder.filter((ctx) => trainingMax == null || ctx <= trainingMax);
  // A model whose training window is below the smallest rung still gets one try, at its window.
  const candidates = rungs.length > 0 ? rungs : trainingMax != null ? [trainingMax] : [];

  const slots = Math.max(1, Math.floor(inputs.parallelSlots ?? 1));
  let smallestFootprintBytes: number | null = null;

  for (const numCtx of candidates) {
    const footprintBytes = estimateFootprintBytes({
      weightBytes: candidate.weightBytes,
      geometry: candidate.geometry,
      numCtx: numCtx * slots,
      observation,
    });

    smallestFootprintBytes = footprintBytes;

    if (footprintBytes <= headroomBytes) {
      return { kind: 'load', model: utilityModel, numCtx, footprintBytes, headroomBytes };
    }
  }

  return routeToChat(
    inputs,
    `"${utilityModel}" does not fit beside the resident models at any context`,
    headroomBytes,
    smallestFootprintBytes,
  );
}

export function formatGiB(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) {
    return '?';
  }

  return `${(bytes / GIB).toFixed(1)} GiB`;
}
