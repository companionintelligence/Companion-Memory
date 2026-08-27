import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Lifecycle of a model on disk.
 * - `not_downloaded` — never fetched, or removed via {@link LocalLlmPlugin.deleteModel}.
 * - `downloading` — a resumable WorkManager download is in flight.
 * - `ready` — the model file is fully on disk and loadable.
 * - `error` — the last download attempt failed (see `error` on {@link ModelStatusResult}).
 */
export type LocalLlmModelStatus = 'not_downloaded' | 'downloading' | 'ready' | 'error';

/** Result of {@link LocalLlmPlugin.isAvailable} — a pure capability probe, no side effects. */
export interface LocalLlmAvailability {
  /** Whether this device can plausibly run the on-device model at all. */
  available: boolean;
  /** Human-readable reason when `available` is false (e.g. "insufficient RAM"). */
  reason?: string;
}

export interface ModelIdOptions {
  /** Identifier of a known model, e.g. `'qwen3-0.6b-int4'`. See `LOCAL_LLM_MODELS`. */
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
}

export interface LoadModelOptions extends ModelIdOptions {
  /** Sampler + context overrides. Omit to use the model's recommended defaults. */
  maxTokens?: number;
  topK?: number;
  topP?: number;
  temperature?: number;
}

export interface GenerateOptions {
  prompt: string;
  maxTokens?: number;
  topK?: number;
  topP?: number;
  temperature?: number;
}

export interface GenerateResult {
  text: string;
}

export interface LoadModelResult {
  /** How many intents were bound as callable tools. `0` = the model runs without tools. */
  toolCount: number;
}

export interface ConfigureIntentToolsOptions {
  /** Pass `false` to drop any configured appliance and run the model without tools. */
  enabled?: boolean;
  /** The configured CI-Server origin (the same value `@ci/common`'s `apiBase` resolves). */
  baseUrl?: string;
  /** The device's API key — sent as `x-api-key`, exactly as the iOS App Intents already do. */
  apiKey?: string;
}

/** Emitted by `generateStream()`; one or more partials followed by a final `done: true`. */
export interface LlmTokenEvent {
  /** Incremental text since the last event. Empty on the terminal `done: true` event. */
  partial: string;
  done: boolean;
}

/**
 * Android-only Capacitor plugin surface for on-device LLM inference (Google LiteRT-LM).
 * Reached at runtime via `window.Capacitor.Plugins.LocalLLM` — see
 * `@ci/common/src/utils/nativeBridge.ts` (`generateOffline`) for the actual call site;
 * the web app never imports this package directly.
 */
export interface LocalLlmPlugin {
  /**
   * Pure capability probe: Android API level, free RAM (`ActivityManager.MemoryInfo`)
   * against a floor, and free disk space. Performs no downloads and has no side effects.
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

  /** Delete a downloaded model's files, freeing disk space. */
  deleteModel(options: ModelIdOptions): Promise<void>;

  /**
   * Load a downloaded model into memory (LiteRT-LM `Engine` + `Conversation`), CPU backend.
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

/**
 * Known downloadable models. Only one is offered today: Qwen3-0.6B, int4-quantized —
 * the same model and file iOS ships (`LocalLLMModels.swift`), not the `gemma3-1b-it-int4`
 * this used to point at.
 *
 * That older entry sat on `litert-community/Gemma3-1B-IT`, a repo Hugging Face now serves
 * `gated: "auto"` — an anonymous in-app download got `401 GatedRepo` for every user who
 * had not already fetched the file by hand, which was every new install. Re-verified
 * before this change (`curl -s https://huggingface.co/api/models/litert-community/Qwen3-0.6B`
 * → `"gated": false`; a ranged download returns `206`/`accept-ranges: bytes`). `.litertlm`
 * is the engine's native bundle format and loads on Android exactly like the `.task` files
 * this catalog used to list — nothing else about `LocalLlmEngine.load()` changes.
 */
export const LOCAL_LLM_MODELS = {
  'qwen3-0.6b-int4': {
    modelId: 'qwen3-0.6b-int4',
    label: 'Qwen3 0.6B (int4)',
    /** Hugging Face `resolve` link for the `.litertlm` file consumed by LiteRT-LM's `Engine`. */
    url: 'https://huggingface.co/litert-community/Qwen3-0.6B/resolve/main/Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm?download=true',
    /** litert-community/Qwen3-0.6B, `Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm`. */
    sizeBytes: 344_437_808,
    /** Approximate peak RSS while loaded, per Google's model card — used for the RAM floor. */
    estimatedPeakMemoryBytes: 2_147_483_648,
    defaultConfig: { topK: 64, topP: 0.95, temperature: 1.0, maxTokens: 1024 },
  },
} as const;

export type LocalLlmModelId = keyof typeof LOCAL_LLM_MODELS;
