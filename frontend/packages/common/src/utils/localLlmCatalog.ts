/**
 * The on-device model catalog the web layer offers, plus the pure decisions built on it.
 *
 * This is a structural mirror of `LOCAL_LLM_MODELS` in `@ci/capacitor-local-llm`'s
 * `src/definitions.ts`, which stays the source of truth: `@ci/common` cannot import that package
 * (it keeps the web bundle free of `@capacitor/*`-family deps — see `nativeBridge.ts`).
 * `capacitorPluginContract.test.ts` asserts the two — and the Kotlin and Swift catalogs — never
 * drift, so add a model in `definitions.ts` first and copy it here verbatim.
 */

export type LocalLlmAccelerator = 'cpu' | 'gpu';
export type LocalLlmCapability = 'thinking' | 'vision' | 'tools';
export type LocalLlmPlatform = 'android' | 'ios';

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
   * Gemma and Qwen2.5 entries, and this repo's own 4 GiB floor for Qwen3-0.6B.
   */
  minDeviceMemoryBytes: number;
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
 * **Why pin — and why to this revision.** `litert-community/Qwen3-0.6B` `main` moved on 2026-09-20 to a
 * re-export (344,671,744 bytes) that needs LiteRT-LM 0.17.1 or newer. Against this repo's 0.14.0 it fails at
 * `Engine.initialize()` with "Only kv_cache tensors are supported as outputs to prefill", and it also failed every
 * download's size check, because the catalog recorded the older 344,437,808. So this entry pins the last
 * revision that loads on 0.14.0 (`154c5de0…`, exercised on an arm64 emulator). Moving to `main` means bumping
 * LiteRT-LM on both platforms first; repin the commit and the size together, never one alone.
 */
export const LOCAL_LLM_CATALOG = {
  'qwen3-0.6b-int4': {
    modelId: 'qwen3-0.6b-int4',
    label: 'Qwen3 0.6B',
    description: 'Smallest and fastest. Answers short questions and calls tools; runs on almost any phone.',
    url: 'https://huggingface.co/litert-community/Qwen3-0.6B/resolve/154c5de0fc0fc5002a7da570ba8c67edffa32ca2/Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm?download=true',
    sizeBytes: 344_437_808,
    commitHash: '154c5de0fc0fc5002a7da570ba8c67edffa32ca2',
    minDeviceMemoryBytes: 4 * GIB,
    capabilities: ['thinking', 'tools'],
    accelerators: ['cpu'],
    platforms: ['android', 'ios'],
    defaultConfig: { topK: 64, topP: 0.95, temperature: 1.0, maxTokens: 1024 },
  },
  'qwen2.5-1.5b-instruct': {
    modelId: 'qwen2.5-1.5b-instruct',
    label: 'Qwen2.5 1.5B Instruct',
    description: 'A steadier general-purpose chat model, no tool calling. Needs a 6 GB phone.',
    url: 'https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/19edb84c69a0212f29a6ef17ba0d6f278b6a1614/Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.litertlm?download=true',
    sizeBytes: 1_597_931_520,
    commitHash: '19edb84c69a0212f29a6ef17ba0d6f278b6a1614',
    minDeviceMemoryBytes: 6 * GIB,
    capabilities: [],
    accelerators: ['gpu', 'cpu'],
    platforms: ['android', 'ios'],
    defaultConfig: { topK: 20, topP: 0.8, temperature: 0.7, maxTokens: 4096 },
  },
  'gemma-4-e2b-it': {
    modelId: 'gemma-4-e2b-it',
    label: 'Gemma 4 E2B',
    description: 'Google’s multimodal Gemma 4. Reads photos, can reason step by step. Needs an 8 GB phone.',
    url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/7fa1d78473894f7e736a21d920c3aa80f950c0db/gemma-4-E2B-it.litertlm?download=true',
    sizeBytes: 2_583_085_056,
    commitHash: '7fa1d78473894f7e736a21d920c3aa80f950c0db',
    minDeviceMemoryBytes: 8 * GIB,
    capabilities: ['thinking', 'vision', 'tools'],
    accelerators: ['gpu', 'cpu'],
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
    capabilities: ['thinking', 'vision', 'tools'],
    accelerators: ['gpu', 'cpu'],
    platforms: ['android'],
    defaultConfig: { topK: 64, topP: 0.95, temperature: 1.0, maxTokens: 4000 },
  },
} as const satisfies Record<string, LocalLlmModelSpec>;

export type LocalLlmModelId = keyof typeof LOCAL_LLM_CATALOG;

/** Every model in the catalog, in display order. */
export const LOCAL_LLM_MODEL_LIST: readonly LocalLlmModelSpec[] = Object.values(LOCAL_LLM_CATALOG);

/** The catalog entries the given platform ships. */
export function localLlmModelsFor(platform: LocalLlmPlatform): LocalLlmModelSpec[] {
  return LOCAL_LLM_MODEL_LIST.filter((model) => model.platforms.includes(platform));
}

export function findLocalLlmModel(modelId: string): LocalLlmModelSpec | undefined {
  return LOCAL_LLM_MODEL_LIST.find((model) => model.modelId === modelId);
}

/** Free space left over after a download, so the OS and the rest of the app are not starved. */
export const LOCAL_LLM_DISK_HEADROOM_BYTES = 512 * 1024 * 1024;

export interface LocalLlmDeviceFacts {
  /** From `isAvailable().totalMemoryBytes`; `undefined` when the native side did not report it. */
  totalMemoryBytes?: number;
  /** From `isAvailable().freeDiskBytes`. */
  freeDiskBytes?: number;
  /** How much of the model is already on disk (a partial download), which a resume does not re-fetch. */
  bytesOnDisk?: number;
}

export type LocalLlmFit = { ok: true } | { ok: false; reason: string };

/**
 * Whether this device should be offered `model`. The same two checks the native `downloadModel` makes
 * (RAM floor, then disk with headroom) so the UI can grey a row out with the reason instead of letting
 * the tap fail. An unknown fact passes: the native side is the enforcer, this is only the courtesy.
 */
export function evaluateModelFit(model: LocalLlmModelSpec, device: LocalLlmDeviceFacts): LocalLlmFit {
  if (device.totalMemoryBytes !== undefined && device.totalMemoryBytes < model.minDeviceMemoryBytes) {
    return {
      ok: false,
      reason: `Needs at least ${formatBytes(model.minDeviceMemoryBytes)} of RAM; this device reports ${formatBytes(device.totalMemoryBytes)}.`,
    };
  }

  if (device.freeDiskBytes !== undefined) {
    const remaining = Math.max(0, model.sizeBytes - (device.bytesOnDisk ?? 0));
    const needed = remaining + LOCAL_LLM_DISK_HEADROOM_BYTES;

    if (device.freeDiskBytes < needed) {
      return { ok: false, reason: `Needs ${formatBytes(needed)} of free storage.` };
    }
  }

  return { ok: true };
}

/** `1.6 GB` / `344 MB` — binary units, one decimal above a gigabyte, none below. */
export function formatBytes(bytes: number): string {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;

  if (bytes >= GB) {
    return `${(bytes / GB).toFixed(1)} GB`;
  }

  return `${Math.round(bytes / MB)} MB`;
}
