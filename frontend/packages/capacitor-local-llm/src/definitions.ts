import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Lifecycle of a model on disk.
 * - `not_downloaded` — never fetched, or removed via {@link LocalLlmPlugin.deleteModel}.
 * - `downloading` — a resumable WorkManager download is in flight.
 * - `ready` — the model file is fully on disk and loadable.
 * - `error` — the last download attempt failed (see `error` on {@link ModelStatusResult}).
 */
export type LocalLlmModelStatus = 'not_downloaded' | 'downloading' | 'ready' | 'error';

/** Which compute backend runs the model. `gpu` is OpenCL/Vulkan on Android and Metal on iOS. */
export type LocalLlmAccelerator = 'cpu' | 'gpu';

/**
 * What a model can do beyond plain text chat, mirroring the capability flags in Google AI Edge
 * Gallery's model allowlist (`llm_thinking`, `llmSupportImage`, …).
 * - `thinking` — emits a separate reasoning channel that `enableThinking` turns on.
 * - `vision` — accepts `images` on {@link GenerateOptions}.
 * - `tools` — its chat template carries tool-call slots, so the intent tools bind.
 */
export type LocalLlmCapability = 'thinking' | 'vision' | 'tools';

/** Result of {@link LocalLlmPlugin.isAvailable} — a pure capability probe, no side effects. */
export interface LocalLlmAvailability {
  /** Whether this device can plausibly run at least one on-device model. */
  available: boolean;
  /** Human-readable reason when `available` is false (e.g. "insufficient RAM"). */
  reason?: string;
  /** Total physical RAM. Compared against a model's `minDeviceMemoryBytes` to gate the bigger ones. */
  totalMemoryBytes?: number;
  /** Free space where models are stored. Compared against a model's remaining download size. */
  freeDiskBytes?: number;
}

export interface ModelIdOptions {
  /** Identifier of a known model, e.g. `'gemma-4-e2b-it'`. See `LOCAL_LLM_MODELS`. */
  modelId: string;
}

export interface DownloadModelOptions extends ModelIdOptions {
  /** Direct download URL for the model's `.litertlm` file (Hugging Face `resolve` link). */
  url: string;
}

export interface ModelStatusResult {
  status: LocalLlmModelStatus;
  /** Bytes written so far. Present while `status` is `downloading` or after a failed attempt. */
  bytesDownloaded?: number;
  /** Total expected bytes, when known. */
  totalBytes?: number;
  /** Failure message, present when `status` is `error`. */
  error?: string;
}

export interface ModelDownloadProgressEvent {
  modelId: string;
  status: LocalLlmModelStatus;
  bytesDownloaded: number;
  totalBytes: number;
  /** Why the download failed. Present exactly when `status` is `error`. */
  error?: string;
}

export interface LoadModelOptions extends ModelIdOptions {
  /** Sampler + context overrides. Omit to use the model's recommended defaults. */
  maxTokens?: number;
  topK?: number;
  topP?: number;
  temperature?: number;
  /**
   * Preferred backend. Omit for the model's first listed accelerator. A `gpu` request that fails
   * to initialise (unsupported delegate, out of GPU memory) retries on the CPU rather than
   * rejecting — see `fellBackToCpu` on the result.
   */
  accelerator?: LocalLlmAccelerator;
  /**
   * Turn on multi-token prediction (Gemma 4's built-in speculative decoding) when the model file
   * carries it. Ignored, not rejected, for a file that does not.
   */
  enableSpeculativeDecoding?: boolean;
}

/** Decode-speed numbers for one generation, the same trio Gallery's benchmark card reports. */
export interface GenerationStats {
  /** Milliseconds from the request until the first token arrived. */
  timeToFirstTokenMs: number;
  /** Milliseconds from the request until the last token. */
  totalMs: number;
  /** Tokens produced. */
  outputTokens: number;
  /** Tokens per second across the decode phase (after the first token). */
  decodeTokensPerSecond: number;
  /** True when `outputTokens` counts streamed chunks because the runtime gave no token count. */
  tokensEstimated: boolean;
}

export interface GenerateOptions {
  prompt: string;
  maxTokens?: number;
  topK?: number;
  topP?: number;
  temperature?: number;
  /**
   * Ask a `thinking`-capable model to reason before answering. The reasoning arrives separately
   * (`thought` on {@link LlmTokenEvent} / {@link GenerateResult}), never mixed into the answer.
   * Defaults to `false`; ignored by models without the capability.
   */
  enableThinking?: boolean;
  /**
   * The most tokens the model may spend reasoning before it must answer. Omit for the native default,
   * a quarter of the model's context window: without a cap a small model reasons until the window is
   * full and stops with no answer. Ignored when `enableThinking` is off.
   */
  thinkingTokenBudget?: number;
  /** The most tokens the whole reply (reasoning included) may take. Omit for whatever the window has left. */
  maxOutputTokens?: number;
  /**
   * Images to put in front of the prompt, as bare base64 (no `data:` prefix) JPEG or PNG. Only
   * honoured by `vision` models; any other model rejects the call rather than dropping them.
   */
  images?: string[];
}

export interface GenerateResult {
  text: string;
  /** The reasoning channel, when `enableThinking` was set on a model that has one. */
  thought?: string;
  stats?: GenerationStats;
}

export interface LoadModelResult {
  /** How many intents were bound as callable tools. `0` = the model runs without tools. */
  toolCount: number;
  /** The backend the model actually loaded on (may differ from the request after a fallback). */
  accelerator: LocalLlmAccelerator;
  /** True when a `gpu` request could not initialise and the CPU was used instead. */
  fellBackToCpu: boolean;
  /** The GPU was wanted but withheld because the device is under the model's `gpuMinDeviceMemoryBytes`. */
  gpuWithheld?: boolean;
  /** Whether multi-token prediction is active for this load. */
  speculativeDecoding: boolean;
}

/** Result of {@link LocalLlmPlugin.getLoadedModel}. */
export interface LoadedModelResult {
  loaded: boolean;
  /** Present when `loaded`. */
  modelId?: string;
  /** Present when `loaded`. */
  accelerator?: LocalLlmAccelerator;
}

export interface ConfigureIntentToolsOptions {
  /** Pass `false` to drop any configured appliance and run the model without tools. */
  enabled?: boolean;
  /** The configured CI-Server origin (the same value `@ci/common`'s `apiBase` resolves). */
  baseUrl?: string;
  /** The device's API key — sent as `x-api-key`, exactly as the iOS App Intents already do. */
  apiKey?: string;
  /**
   * The connection chip's answer at the time of the call (`@ci/common`'s `ConnectionMode`). Anything
   * but `connected` makes the phone's own search (below) answer `knowledge_search` ahead of the
   * appliance's, whose call would fail anyway. The native side has no probe of its own.
   */
  connectionMode?: 'connected' | 'local' | 'cached' | 'fresh';
  /**
   * The phone's synced replica (PowerSync, SQLCipher-encrypted by `@capacitor-community/sqlite`),
   * which the native side reads directly to answer `knowledge_search` when the appliance's catalog
   * cannot be fetched or the app is not connected. Omit when there is no replica.
   */
  localSearch?: {
    /** The file under the app's databases directory, as the SQLite plugin names it: `<dbName>SQLite.db`. */
    databaseFile: string;
  };
}

/** Emitted by `generateStream()`; one or more partials followed by a final `done: true`. */
export interface LlmTokenEvent {
  /** Incremental answer text since the last event. Empty on the terminal `done: true` event. */
  partial: string;
  /** Incremental reasoning text (the `thought` channel). Absent unless `enableThinking` produced some. */
  thought?: string;
  done: boolean;
  /** Present only on the terminal `done: true` event of a generation that ran to completion. */
  stats?: GenerationStats;
}

/**
 * Capacitor plugin surface for on-device LLM inference (Google LiteRT-LM). Implemented by this
 * package on Android and by `frontend/apps/ios/ios/App/App/LocalLLM/` on iOS — one JS contract,
 * two native halves, kept in step by `capacitorPluginContract.test.ts`.
 * Reached at runtime via `window.Capacitor.Plugins.LocalLLM` — see
 * `@ci/common/src/utils/localLlm.ts` for the call site; the web app never imports this package
 * directly.
 */
export interface LocalLlmPlugin {
  /**
   * Pure capability probe: OS version and RAM against the smallest catalog model's floor, plus the
   * figures the UI needs to grey out bigger ones (`totalMemoryBytes`, `freeDiskBytes`). Performs no
   * downloads and has no side effects.
   *
   * `totalMemoryBytes` is the *advertised* RAM where the platform can say (Android API 34+
   * `advertisedMem`; otherwise the kernel figure rounded up to a whole GiB) — a phone sold as 8 GB
   * reports ~7.3 GiB raw and would otherwise miss an 8 GiB floor. iOS reports `physicalMemory` as-is,
   * which is a little under the marketing figure, so it errs on the side of not offering a big model.
   */
  isAvailable(): Promise<LocalLlmAvailability>;

  /** Current on-disk status of a model, with byte progress while downloading. */
  getModelStatus(options: ModelIdOptions): Promise<ModelStatusResult>;

  /**
   * Enqueue a resumable, foreground WorkManager download (HTTP Range resume) for the
   * model's file. Progress is reported via the `modelDownloadProgress` event.
   * Resolves once the download is *enqueued*, not once it completes — listen for the
   * `ready`/`error` status via `modelDownloadProgress` or poll `getModelStatus`.
   */
  downloadModel(options: DownloadModelOptions): Promise<void>;

  /**
   * Stop an in-flight download and drop its partial file. A no-op when nothing is downloading.
   * Emits a final `modelDownloadProgress` with `not_downloaded`.
   */
  cancelDownload(options: ModelIdOptions): Promise<void>;

  /** Delete a downloaded model's files, freeing disk space. */
  deleteModel(options: ModelIdOptions): Promise<void>;

  /**
   * Load a downloaded model into memory (LiteRT-LM `Engine` + `Conversation`) on the requested
   * `accelerator`. A repeated identical load is a no-op; a different model or backend unloads first.
   *
   * Two runtime facts the contract inherits (measured on LiteRT-LM 0.14.0): a cancelled conversation
   * cannot be reused, so the next generation after a Stop or a failure starts a fresh conversation and
   * the model forgets earlier turns; and Gemma 4 fixes thinking on or off at a conversation's first turn,
   * so flipping `enableThinking` mid-chat starts a fresh conversation as well.
   *
   * If {@link LocalLlmPlugin.configureIntentTools} has been called, the intent catalog is fetched
   * here and the resulting tools are bound to the conversation — LiteRT-LM fixes the tool set at
   * conversation-creation time, so they cannot be attached later. `toolCount` reports how many were
   * bound; `0` means the model will answer without tools (catalog unreachable, appliance older than
   * manifest 1.2.0, or intent tools never configured).
   */
  loadModel(options: LoadModelOptions): Promise<LoadModelResult>;

  /**
   * Point on-device tool calling at a CI-Server, or disable it.
   *
   * Takes effect on the next {@link LocalLlmPlugin.loadModel}. Credentials are supplied by the
   * caller (the web layer already holds the configured origin and the minted API key) so this
   * plugin never has to know how the app stores them.
   */
  configureIntentTools(options: ConfigureIntentToolsOptions): Promise<void>;

  /** Which model is resident right now — survives a WebView reload, which the JS side does not. */
  getLoadedModel(): Promise<LoadedModelResult>;

  /**
   * Start a fresh conversation on the already-loaded engine, discarding the accumulated turn
   * history (and its KV cache) without paying for a model reload. The "New chat" button calls this.
   * Keeps the tool set that `loadModel` bound. Rejects when no model is loaded.
   */
  resetConversation(): Promise<void>;

  /** Close the active conversation + engine, freeing memory. */
  unloadModel(): Promise<void>;

  /** Non-streaming convenience: buffers the full response and resolves once done. */
  generate(options: GenerateOptions): Promise<GenerateResult>;

  /**
   * Streaming generation. Resolves once generation is complete; subscribe to `llmToken`
   * (via `addListener`) *before* calling this to receive incremental partials.
   */
  generateStream(options: GenerateOptions): Promise<void>;

  /** Cancel the in-flight `generate`/`generateStream` call, if any. */
  cancel(): Promise<void>;

  addListener(
    eventName: 'modelDownloadProgress',
    listenerFunc: (event: ModelDownloadProgressEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'llmToken',
    listenerFunc: (event: LlmTokenEvent) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

/** One downloadable model. The native halves mirror `modelId`, file name, size and defaults. */
export interface LocalLlmModelSpec {
  modelId: string;
  label: string;
  /** One line for a model picker. */
  description: string;
  /**
   * Hugging Face `resolve` link **pinned to a commit**. Never `resolve/main`: the file on `main`
   * moves under you, and the download is verified against `sizeBytes` byte for byte.
   */
  url: string;
  /** The exact size of the file at `url` — the download is rejected if it lands at any other. */
  sizeBytes: number;
  /** The Hugging Face commit `url` is pinned to. */
  commitHash: string;
  /**
   * Total device RAM below which the model is not offered — Gallery's `minDeviceMemoryInGb` for the
   * Gemma entries (the only ones left: see the Android README's model table for what was dropped and why).
   */
  minDeviceMemoryBytes: number;
  /**
   * Total device RAM below which the GPU backend is withheld and the model runs on the CPU, whatever the
   * preference says. Never under `minDeviceMemoryBytes`. The GPU expands int4 weights to fp16 in graphics
   * memory: Gemma 4 E2B measured 2.4 GB of graphics memory and 3.3 GB in all on a Galaxy S23 Ultra's GPU
   * against 0.2 GB and 2.3 GB on its CPU (2026-10-13). The native side enforces it; see `gpuAllowedOn`.
   */
  gpuMinDeviceMemoryBytes: number;
  capabilities: readonly LocalLlmCapability[];
  /** Backends the model runs on, best first. The first entry is the default. */
  accelerators: readonly LocalLlmAccelerator[];
  /** Platforms that ship the model. Gemma 4 is Android-only until iOS carries the increased-memory-limit entitlement. */
  platforms: readonly ('android' | 'ios')[];
  defaultConfig: { topK: number; topP: number; temperature: number; maxTokens: number };
}

const GIB = 1024 * 1024 * 1024;

/**
 * Known downloadable models, taken from Google AI Edge Gallery's model allowlist
 * (`model_allowlists/1_0_19.json`) and cut down to what an anonymous in-app download can fetch.
 *
 * **Every entry is ungated and pinned.** Re-verified when this list was written, with no token:
 * `curl -s https://huggingface.co/api/models/<repo>` → `"gated": false`, and a ranged GET of the
 * pinned URL answers `206` with `content-range: bytes 0-0/<sizeBytes>`.
 *
 * **Left out on purpose:** Gemma 3n (`google/gemma-3n-*`, gated `manual`), Gemma3-1B-IT
 * (`gated: auto`) and the FunctionGemma fine-tunes (`gated: auto`). Each needs a Hugging Face
 * account and licence click-through — the same `401 GatedRepo` that once left Android with no
 * downloadable model at all. They come back with an HF sign-in flow, not before.
 *
 * **Why pin.** `resolve/main` moves under a catalog: on 2026-09-20 `litert-community/Qwen3-0.6B` became a
 * re-export (344,671,744 bytes) that needs LiteRT-LM 0.17.1 or newer, and every download failed its size
 * check against the older revision recorded here until the catalog was repinned. Since the LiteRT-LM 0.18.0
 * bump the pin IS that re-export (`a6e678a1…`); repin the commit and the size together, never one alone, and
 * only to a revision that loads on the runtime both platforms link.
 */
export const LOCAL_LLM_MODELS = {
  'gemma-4-e2b-it': {
    modelId: 'gemma-4-e2b-it',
    label: 'Gemma 4 E2B',
    description:
      'Google’s multimodal Gemma 4. Reads photos, can reason step by step. Needs a 6 GB phone; the GPU is optional from 8 GB.',
    // Repinned 2026-10-13 to the 2026-06-05 re-export of the plain bundle (the card asks for a re-download of files
    // from before 2026-05-05). Measured on an S23 Ultra against the 2026-04-01 bundle (2_583_085_056 bytes, 7fa1d784…):
    // identical behaviour, including the GPU backend's corruption of numbers read from tool responses (dates come
    // back as "206-1-03 00:25 UTC"; the CPU backend reads them exactly) — that is the runtime, not the bundle. The
    // repository's `-gpu` bundle (2026-08-07) was tried and rejected: text-only, no speculative decoding, gibberish on
    // this phone's GPU, and no CPU signature at all.
    url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/361a4010ad6d88fc5c86e148e333c0342b99763d/gemma-4-E2B-it.litertlm?download=true',
    sizeBytes: 2_588_147_712,
    commitHash: '361a4010ad6d88fc5c86e148e333c0342b99763d',
    // 6 GB on the CPU, the GPU from 8 GB — measured, see the field's doc.
    minDeviceMemoryBytes: 6 * GIB,
    gpuMinDeviceMemoryBytes: 8 * GIB,
    capabilities: ['thinking', 'vision', 'tools'],
    // CPU first (2026-10-13): on LiteRT-LM 0.18 the GPU backend corrupts digits read from tool responses with
    // Gemma 4 ("206-1-03 00:25 UTC" for 2026-10-03), the CPU reads them exactly; LiteRT-LM #2202 is open with no
    // fix. The GPU stays an explicit choice for speed (7–11 s a tool turn against 15–22 s).
    accelerators: ['cpu', 'gpu'],
    platforms: ['android'],
    defaultConfig: { topK: 64, topP: 0.95, temperature: 1.0, maxTokens: 4000 },
  },
  'gemma-4-e4b-it': {
    modelId: 'gemma-4-e4b-it',
    label: 'Gemma 4 E4B',
    description: 'The larger Gemma 4: the best answers on device, and slower. Needs a 12 GB phone.',
    url: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/9695417f248178c63a9f318c6e0c56cb917cb837/gemma-4-E4B-it.litertlm?download=true',
    sizeBytes: 3_654_467_584,
    commitHash: '9695417f248178c63a9f318c6e0c56cb917cb837',
    minDeviceMemoryBytes: 12 * GIB,
    gpuMinDeviceMemoryBytes: 12 * GIB,
    capabilities: ['thinking', 'vision', 'tools'],
    // CPU first (2026-10-13): on LiteRT-LM 0.18 the GPU backend corrupts digits read from tool responses with
    // Gemma 4 ("206-1-03 00:25 UTC" for 2026-10-03), the CPU reads them exactly; LiteRT-LM #2202 is open with no
    // fix. The GPU stays an explicit choice for speed (7–11 s a tool turn against 15–22 s).
    accelerators: ['cpu', 'gpu'],
    platforms: ['android'],
    defaultConfig: { topK: 64, topP: 0.95, temperature: 1.0, maxTokens: 4000 },
  },
} as const satisfies Record<string, LocalLlmModelSpec>;

export type LocalLlmModelId = keyof typeof LOCAL_LLM_MODELS;
