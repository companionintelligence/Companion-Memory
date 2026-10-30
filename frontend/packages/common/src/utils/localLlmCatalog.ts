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
export const LOCAL_LLM_CATALOG = {
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

export type LocalLlmModelId = keyof typeof LOCAL_LLM_CATALOG;

/** Every model in the catalog, in display order. */
export const LOCAL_LLM_MODEL_LIST: readonly LocalLlmModelSpec[] = Object.values(LOCAL_LLM_CATALOG);

/** The catalog entries the given platform ships. */
export function localLlmModelsFor(platform: LocalLlmPlatform): LocalLlmModelSpec[] {
  return LOCAL_LLM_MODEL_LIST.filter((model) => model.platforms.includes(platform));
}

/**
 * Whether this device may run `model` on the GPU: it must list the GPU, and the device must report at least the
 * model's `gpuMinDeviceMemoryBytes`. Unknown memory passes — the native side is the enforcer and reports
 * `gpuWithheld` on the load result.
 */
export function gpuAllowedOn(model: LocalLlmModelSpec, totalMemoryBytes: number | undefined): boolean {
  if (!model.accelerators.includes('gpu')) {
    return false;
  }

  return totalMemoryBytes === undefined || totalMemoryBytes >= model.gpuMinDeviceMemoryBytes;
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
