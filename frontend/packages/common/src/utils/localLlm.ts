/**
 * Web-facing access layer over the native `LocalLLM` plugin — on-device chat via Google's
 * LiteRT-LM, the same engine Google AI Edge Gallery ships. Android implements the plugin in
 * `frontend/packages/capacitor-local-llm`; iOS implements the identical JS contract in
 * `frontend/apps/ios/ios/App/App/LocalLLM/`.
 *
 * Reached through the runtime `window.Capacitor.Plugins` bridge, never an import of the plugin
 * package, so the web bundle stays free of native dependencies — the convention `speech.ts` and
 * `localHub.ts` follow. The interfaces below are structural mirrors of that package's
 * `src/definitions.ts`, which stays the source of truth.
 *
 * Everything here degrades to "unsupported" off-device: on web and desktop {@link probeLocalLlm}
 * says so and every mutating call rejects, so callers branch once on `supported`.
 *
 * ## Where this sits next to `generateOffline`
 *
 * `nativeBridge.generateOffline` is a one-shot "answer this prompt" helper. This module is the
 * model *lifecycle* the settings screen and the chat page need on top of it: what is downloaded,
 * download progress, load/unload, a fresh conversation for "New chat", reasoning + stats streamed
 * alongside the answer.
 */

import { getApiKey } from './apiAuth';
import { getApiBaseUrl, isIosPlatform, isNativePlatform } from './apiBase';
import {
  evaluateModelFit,
  findLocalLlmModel,
  localLlmModelsFor,
  type LocalLlmAccelerator,
  type LocalLlmFit,
  type LocalLlmModelSpec,
  type LocalLlmPlatform,
} from './localLlmCatalog';

export type LocalLlmModelStatus = 'not_downloaded' | 'downloading' | 'ready' | 'error';

export interface LocalLlmAvailability {
  available: boolean;
  reason?: string;
  totalMemoryBytes?: number;
  freeDiskBytes?: number;
}

export interface LocalLlmModelStatusResult {
  status: LocalLlmModelStatus;
  bytesDownloaded?: number;
  totalBytes?: number;
  error?: string;
}

export interface LocalLlmDownloadProgress {
  modelId: string;
  status: LocalLlmModelStatus;
  bytesDownloaded: number;
  totalBytes: number;
  error?: string;
}

export interface LocalLlmGenerationStats {
  timeToFirstTokenMs: number;
  totalMs: number;
  outputTokens: number;
  decodeTokensPerSecond: number;
  tokensEstimated: boolean;
}

export interface LocalLlmTokenEvent {
  partial: string;
  thought?: string;
  done: boolean;
  stats?: LocalLlmGenerationStats;
}

export interface LocalLlmLoadResult {
  toolCount: number;
  accelerator: LocalLlmAccelerator;
  fellBackToCpu: boolean;
  speculativeDecoding: boolean;
}

interface ListenerHandle {
  remove(): Promise<void> | void;
}

/** Structural mirror of `LocalLlmPlugin` in `@ci/capacitor-local-llm`'s `src/definitions.ts`. */
export interface LocalLlmPluginApi {
  isAvailable(): Promise<LocalLlmAvailability>;
  getModelStatus(options: { modelId: string }): Promise<LocalLlmModelStatusResult>;
  downloadModel(options: { modelId: string; url: string }): Promise<void>;
  cancelDownload(options: { modelId: string }): Promise<void>;
  deleteModel(options: { modelId: string }): Promise<void>;
  loadModel(options: {
    modelId: string;
    accelerator?: LocalLlmAccelerator;
    enableSpeculativeDecoding?: boolean;
  }): Promise<LocalLlmLoadResult>;
  getLoadedModel(): Promise<{ loaded: boolean; modelId?: string; accelerator?: LocalLlmAccelerator }>;
  configureIntentTools(options: { enabled?: boolean; baseUrl?: string; apiKey?: string }): Promise<void>;
  resetConversation(): Promise<void>;
  unloadModel(): Promise<void>;
  generateStream(options: { prompt: string; enableThinking?: boolean; images?: string[] }): Promise<void>;
  cancel(): Promise<void>;
  addListener(
    eventName: 'modelDownloadProgress',
    listener: (event: LocalLlmDownloadProgress) => void,
  ): Promise<ListenerHandle>;
  addListener(eventName: 'llmToken', listener: (event: LocalLlmTokenEvent) => void): Promise<ListenerHandle>;
}

/** The `LocalLLM` plugin off the runtime Capacitor bridge, or undefined when absent. */
export function localLlmPlugin(): LocalLlmPluginApi | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return (window as unknown as { Capacitor?: { Plugins?: { LocalLLM?: LocalLlmPluginApi } } }).Capacitor
    ?.Plugins?.LocalLLM;
}

/** Which native shell we are in, or `null` on web/desktop, where there is no on-device engine. */
export function localLlmPlatform(): LocalLlmPlatform | null {
  if (!isNativePlatform()) {
    return null;
  }

  return isIosPlatform() ? 'ios' : 'android';
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export interface LocalLlmModelState {
  spec: LocalLlmModelSpec;
  status: LocalLlmModelStatusResult;
  /** Whether this device may download/run the model, with the reason when it may not. */
  fit: LocalLlmFit;
}

export interface LocalLlmProbe {
  /** False on web/desktop or when the shell was built without the plugin. */
  supported: boolean;
  platform: LocalLlmPlatform | null;
  availability: LocalLlmAvailability;
  models: LocalLlmModelState[];
  loaded: { loaded: boolean; modelId?: string; accelerator?: LocalLlmAccelerator };
}

const UNSUPPORTED: LocalLlmProbe = {
  supported: false,
  platform: null,
  availability: { available: false, reason: 'On-device models run in the iOS and Android apps.' },
  models: [],
  loaded: { loaded: false },
};

/**
 * One round of bridge calls that answers everything the settings screen shows: can this device do it
 * at all, which models are on disk, which are affordable, and which (if any) is resident. Never
 * throws — a bridge failure reads as "unsupported" with the reason attached, because a settings
 * page that crashes on a broken plugin is worse than one that says "not available".
 */
export async function probeLocalLlm(): Promise<LocalLlmProbe> {
  const platform = localLlmPlatform();
  const plugin = localLlmPlugin();

  if (!platform || !plugin) {
    return UNSUPPORTED;
  }

  try {
    const availability = await plugin.isAvailable();
    const specs = localLlmModelsFor(platform);
    const [statuses, loaded] = await Promise.all([
      Promise.all(specs.map((spec) => plugin.getModelStatus({ modelId: spec.modelId }))),
      plugin.getLoadedModel().catch(() => ({ loaded: false as const })),
    ]);

    return {
      supported: true,
      platform,
      availability,
      loaded,
      models: specs.map((spec, index) => ({
        spec,
        status: statuses[index],
        fit: evaluateModelFit(spec, {
          totalMemoryBytes: availability.totalMemoryBytes,
          freeDiskBytes: availability.freeDiskBytes,
          bytesOnDisk: statuses[index].status === 'ready' ? spec.sizeBytes : statuses[index].bytesDownloaded,
        }),
      })),
    };
  } catch (error) {
    return {
      ...UNSUPPORTED,
      platform,
      availability: {
        available: false,
        reason: error instanceof Error ? error.message : 'The on-device model engine did not respond.',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Download management
// ---------------------------------------------------------------------------

function requirePlugin(): LocalLlmPluginApi {
  const plugin = localLlmPlugin();

  if (!plugin || !isNativePlatform()) {
    throw new Error('On-device models are only available in the iOS and Android apps.');
  }

  return plugin;
}

function requireModel(modelId: string): LocalLlmModelSpec {
  const spec = findLocalLlmModel(modelId);

  if (!spec) {
    throw new Error(`Unknown on-device model: ${modelId}`);
  }

  return spec;
}

/** Start (or resume) a model download from its pinned catalog URL. Resolves once it is enqueued. */
export async function downloadLocalLlmModel(modelId: string): Promise<void> {
  const spec = requireModel(modelId);

  await requirePlugin().downloadModel({ modelId, url: spec.url });
}

export async function cancelLocalLlmDownload(modelId: string): Promise<void> {
  requireModel(modelId);
  await requirePlugin().cancelDownload({ modelId });
}

export async function deleteLocalLlmModel(modelId: string): Promise<void> {
  requireModel(modelId);

  const plugin = requirePlugin();
  const { loaded, modelId: loadedId } = await plugin.getLoadedModel();

  // Unlink a resident model's file out from under it and the next token read faults.
  if (loaded && loadedId === modelId) {
    await plugin.unloadModel();
  }

  await plugin.deleteModel({ modelId });
}

/** Subscribe to download progress. Returns the unsubscribe function; a no-op one off-device. */
export function onLocalLlmDownloadProgress(listener: (event: LocalLlmDownloadProgress) => void): () => void {
  const plugin = localLlmPlugin();

  if (!plugin || !isNativePlatform()) {
    return () => {};
  }

  let cancelled = false;
  let handle: ListenerHandle | undefined;

  void plugin
    .addListener('modelDownloadProgress', listener)
    .then((registered) => {
      if (cancelled) {
        void registered.remove();
      } else {
        handle = registered;
      }
    })
    .catch(() => {});

  return () => {
    cancelled = true;
    void handle?.remove();
  };
}

/** Whether `modelId` is fully on disk and so can answer a chat turn. `false` off-device or on any bridge error. */
export async function isLocalLlmReady(modelId: string | null | undefined): Promise<boolean> {
  const plugin = localLlmPlugin();

  if (!modelId || !localLlmPlatform() || !plugin) {
    return false;
  }

  try {
    return (await plugin.getModelStatus({ modelId })).status === 'ready';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadLocalLlmOptions {
  accelerator?: LocalLlmAccelerator;
  /** Multi-token prediction, where the model file has it. */
  enableSpeculativeDecoding?: boolean;
  /** Bind the appliance's published intents as tools. Off, or with no appliance, the model runs toolless. */
  useIntentTools?: boolean;
}

/**
 * Make `modelId` the resident model, loading it if needed. A no-op when that model is already loaded
 * on the requested backend — the load is a multi-second, gigabyte-scale operation and chat calls this
 * on every turn.
 *
 * Intent tools are bound *here*, because LiteRT-LM fixes the tool set when the conversation is
 * created. They need the appliance origin and API key; with either missing the model loads toolless
 * rather than failing.
 */
export async function ensureLocalLlmLoaded(
  modelId: string,
  options: LoadLocalLlmOptions = {},
): Promise<LocalLlmLoadResult | { alreadyLoaded: true; accelerator: LocalLlmAccelerator }> {
  const spec = requireModel(modelId);
  const plugin = requirePlugin();
  const current = await plugin.getLoadedModel();
  const wanted = effectiveAccelerator(spec, options.accelerator);
  const fallbackKey = `${modelId}:${wanted}`;

  // Already resident on the backend we would ask for — or on the CPU because that very request already fell
  // back once. Without the second clause a GPU request that cannot start (so the model sits on the CPU) would
  // reload the model on every message, wiping its conversation each time.
  if (
    current.loaded &&
    current.modelId === modelId &&
    (!current.accelerator ||
      current.accelerator === wanted ||
      (current.accelerator === 'cpu' && gpuFallbacks.has(fallbackKey)))
  ) {
    return { alreadyLoaded: true, accelerator: current.accelerator ?? wanted };
  }

  const baseUrl = getApiBaseUrl();
  const apiKey = getApiKey();
  const canBindTools = Boolean(
    options.useIntentTools && baseUrl && apiKey && spec.capabilities.includes('tools'),
  );

  await plugin.configureIntentTools(
    canBindTools ? { enabled: true, baseUrl, apiKey: apiKey ?? undefined } : { enabled: false },
  );

  const result = await plugin.loadModel({
    modelId,
    accelerator: wanted,
    enableSpeculativeDecoding: options.enableSpeculativeDecoding,
  });

  if (result.fellBackToCpu) {
    gpuFallbacks.add(fallbackKey);
  } else {
    gpuFallbacks.delete(fallbackKey);
  }

  return result;
}

/** `model:accelerator` requests that already fell back to the CPU this session. */
const gpuFallbacks = new Set<string>();

/**
 * The backend to ask for: the user's preference when this model can run on it, otherwise the model's own
 * default. A preference is remembered across model changes (`gpu` chosen for Qwen2.5, then the user picks
 * CPU-only Qwen3), and asking Qwen3 for `gpu` would never match the `cpu` it reports back.
 */
function effectiveAccelerator(
  spec: LocalLlmModelSpec,
  preferred: LocalLlmAccelerator | undefined,
): LocalLlmAccelerator {
  return preferred && spec.accelerators.includes(preferred) ? preferred : spec.accelerators[0];
}

export async function unloadLocalLlm(): Promise<void> {
  await requirePlugin().unloadModel();
}

/** Forget the conversation so far (the "New chat" button). Harmless when nothing is loaded. */
export async function resetLocalLlmConversation(): Promise<void> {
  const plugin = localLlmPlugin();

  if (!plugin || !isNativePlatform()) {
    return;
  }

  try {
    const { loaded } = await plugin.getLoadedModel();

    if (loaded) {
      await plugin.resetConversation();
    }
  } catch {
    // A conversation that cannot be reset is about to be replaced by the next load; not worth a toast.
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface StreamLocalLlmOptions {
  enableThinking?: boolean;
  /** Bare base64 JPEG/PNG, vision models only. */
  images?: string[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onThought?: (thought: string) => void;
}

export interface StreamLocalLlmResult {
  text: string;
  thought: string;
  stats?: LocalLlmGenerationStats;
  /** True when the turn did not run to completion: the caller aborted, or the device cut it short (heat). */
  cancelled: boolean;
}

/**
 * A turn that ran to completion and produced nothing: no answer, no reasoning, zero tokens. On LiteRT-LM 0.14.0 that
 * is exactly what a conversation whose context window is full does — every later turn returns `done` at once with
 * no chunks, until the conversation is reset (measured on an emulator: a 966-token reply in Qwen3's 1024-token
 * window left no room, and the next request came back empty). A *stopped* turn has no stats, so it never matches.
 */
export function isContextExhausted(result: StreamLocalLlmResult): boolean {
  return !result.cancelled && result.text === '' && result.thought === '' && result.stats?.outputTokens === 0;
}

/** One native generation at a time: the plugin has a single conversation and a single `llmToken` stream. */
let generationQueue: Promise<unknown> = Promise.resolve();

/**
 * Stream one turn through the resident model, calling `onText`/`onThought` as tokens arrive. The
 * caller must have loaded a model ({@link ensureLocalLlmLoaded}); the conversation accumulates turn
 * history natively, so pass only the *new* user message.
 *
 * Calls are serialised, so two overlapping chats cannot interleave tokens on the shared event.
 */
export function streamLocalLlm(
  prompt: string,
  options: StreamLocalLlmOptions = {},
): Promise<StreamLocalLlmResult> {
  const run = generationQueue.then(() => runStream(prompt, options));

  generationQueue = run.catch(() => {});

  return run;
}

async function runStream(prompt: string, options: StreamLocalLlmOptions): Promise<StreamLocalLlmResult> {
  const plugin = requirePlugin();
  const { signal } = options;

  if (signal?.aborted) {
    return { text: '', thought: '', cancelled: true };
  }

  let text = '';
  let thought = '';
  let stats: LocalLlmGenerationStats | undefined;
  let cancelled = false;

  // Subscribe before starting: the native side emits from the moment generation begins.
  const handle = await plugin.addListener('llmToken', (event) => {
    if (event.partial) {
      text += event.partial;
      options.onText?.(event.partial);
    }

    if (event.thought) {
      thought += event.thought;
      options.onThought?.(event.thought);
    }

    if (event.done && event.stats) {
      stats = event.stats;
    }
  });

  const onAbort = () => {
    cancelled = true;
    void plugin.cancel().catch(() => {});
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await plugin.generateStream({
      prompt,
      enableThinking: options.enableThinking,
      images: options.images && options.images.length > 0 ? options.images : undefined,
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    void handle.remove();
  }

  // A generation the native side stopped — the caller's Stop, or a thermal cutoff the device forced — resolves
  // normally with a bare terminal event and no stats. Stats exist only for a turn that ran to completion.
  return { text, thought, stats, cancelled: cancelled || !stats };
}
