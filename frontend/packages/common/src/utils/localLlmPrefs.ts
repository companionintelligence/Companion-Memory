/**
 * How the user wants chat routed between the appliance and the on-device model, persisted per device.
 *
 * This is deliberately per-device browser storage and not a server-side preference: whether *this
 * phone* answers on its own depends on which model is downloaded *to this phone*, so a value synced
 * from another device would name a model that is not here.
 *
 * The default is `appliance`. The on-device model is opt-in, because a 0.6–4B model answering when
 * a far stronger appliance model is one request away is a quality regression the user should choose,
 * not discover.
 */

import { type LocalLlmAccelerator, findLocalLlmModel } from './localLlmCatalog';

/**
 * - `appliance` — always the CI-Server. The on-device model is never used.
 * - `auto` — the appliance first; when it cannot be reached, answer on-device instead.
 * - `device` — always on-device, even with the appliance reachable (airplane mode, or privacy).
 */
export type LocalLlmMode = 'appliance' | 'auto' | 'device';

/** Sampler overrides for the on-device model. A field left out uses the model's own default. */
export interface LocalLlmSampling {
  temperature?: number;
  topP?: number;
  topK?: number;
}

/**
 * What a stored answer setting is clamped to, whether it was typed in Settings or read back from storage.
 * The Settings screen sets its inputs' `min` and `max` from this same table, so a field and the clamp cannot
 * drift apart. The two token limits only bound what is stored: the native runtime still applies its own
 * context-window, thermal and availability limits, so a reply can end sooner than the limit says.
 */
export const LOCAL_LLM_BOUNDS = {
  temperature: { min: 0, max: 2 },
  // Floored above 0: a top P of 0 is degenerate, so it is not offered.
  topP: { min: 0.05, max: 1 },
  topK: { min: 1, max: 100 },
  maxOutputTokens: { min: 128, max: 8192 },
  thinkingTokenBudget: { min: 64, max: 2048 },
} as const;

interface Bounds {
  min: number;
  max: number;
}

export interface LocalLlmPrefs {
  mode: LocalLlmMode;
  /** The model chat runs on. `null` until the user picks (or downloads) one. */
  modelId: string | null;
  /** `null` = the model's own default (its first listed accelerator). */
  accelerator: LocalLlmAccelerator | null;
  /** Ask a thinking-capable model to reason first. */
  thinking: boolean;
  /** Multi-token prediction for models that carry it. */
  speculativeDecoding: boolean;
  /** Bind the appliance's intents as tools so the model answers from memory when it can reach it. */
  intentTools: boolean;
  /** Device-only sampler overrides. Omitted fields use the selected model's defaults. */
  sampling?: LocalLlmSampling;
  /** The most tokens one whole reply, reasoning included, may take. Omitted: whatever the context window has left. */
  maxOutputTokens?: number;
  /** The most tokens the model may spend reasoning before it answers. Omitted: the runtime's own cap. */
  thinkingTokenBudget?: number;
}

export const DEFAULT_LOCAL_LLM_PREFS: LocalLlmPrefs = {
  mode: 'appliance',
  modelId: null,
  accelerator: null,
  thinking: false,
  speculativeDecoding: true,
  intentTools: true,
};

const STORAGE_KEY = 'ci.localLlm.prefs';

type Listener = (prefs: LocalLlmPrefs) => void;

const listeners = new Set<Listener>();
let cached: LocalLlmPrefs | null = null;

function isMode(value: unknown): value is LocalLlmMode {
  return value === 'appliance' || value === 'auto' || value === 'device';
}

function isAccelerator(value: unknown): value is LocalLlmAccelerator {
  return value === 'cpu' || value === 'gpu';
}

/** Parse whatever is in storage into a valid record, field by field — a bad field falls back, never throws. */
export function parseLocalLlmPrefs(raw: string | null): LocalLlmPrefs {
  if (!raw) {
    return { ...DEFAULT_LOCAL_LLM_PREFS };
  }

  let value: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(raw);

    value = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { ...DEFAULT_LOCAL_LLM_PREFS };
  }

  const sampling = normalizeSampling(value.sampling);
  const maxOutputTokens = boundedNumber(value.maxOutputTokens, LOCAL_LLM_BOUNDS.maxOutputTokens, true);
  const thinkingTokenBudget = boundedNumber(
    value.thinkingTokenBudget,
    LOCAL_LLM_BOUNDS.thinkingTokenBudget,
    true,
  );

  return {
    mode: isMode(value.mode) ? value.mode : DEFAULT_LOCAL_LLM_PREFS.mode,
    // A stored id the catalog no longer ships reads as "no model": a preference saved before a model was
    // dropped (Qwen3-0.6B and Qwen2.5 on 2026-10-13), or synced from another device, must not reach the
    // strict catalog lookups downstream — on a device that surfaced as "Unknown on-device model" across
    // the whole settings section.
    modelId: typeof value.modelId === 'string' && findLocalLlmModel(value.modelId) ? value.modelId : null,
    accelerator: isAccelerator(value.accelerator) ? value.accelerator : null,
    thinking: typeof value.thinking === 'boolean' ? value.thinking : DEFAULT_LOCAL_LLM_PREFS.thinking,
    speculativeDecoding:
      typeof value.speculativeDecoding === 'boolean'
        ? value.speculativeDecoding
        : DEFAULT_LOCAL_LLM_PREFS.speculativeDecoding,
    intentTools:
      typeof value.intentTools === 'boolean' ? value.intentTools : DEFAULT_LOCAL_LLM_PREFS.intentTools,
    // Left out, not set to `undefined`, when absent or damaged: no override means the model's own default.
    ...(sampling ? { sampling } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(thinkingTokenBudget !== undefined ? { thinkingTokenBudget } : {}),
  };
}

/**
 * `value` clamped into `bounds` (rounded first when `integer`). Anything that is not a finite number — a
 * string, `null`, `NaN`, an infinity — comes back `undefined`, so a damaged field is dropped rather than
 * guessed at, and the caller falls back to the model's default.
 */
function boundedNumber(value: unknown, { min, max }: Bounds, integer = false): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, integer ? Math.round(value) : value))
    : undefined;
}

/** The sampler overrides worth keeping, each clamped; `undefined` when none of them survive. */
function normalizeSampling(value: unknown): LocalLlmSampling | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const input = value as LocalLlmSampling;
  const temperature = boundedNumber(input.temperature, LOCAL_LLM_BOUNDS.temperature);
  const topP = boundedNumber(input.topP, LOCAL_LLM_BOUNDS.topP);
  const topK = boundedNumber(input.topK, LOCAL_LLM_BOUNDS.topK, true);
  const result = {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
  };

  return Object.keys(result).length ? result : undefined;
}

function readStorage(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private windows and blocked site data throw on access; the defaults are a fine answer.
    return null;
  }
}

/** The current preferences. The same object until they change, so it is safe as a `useSyncExternalStore` snapshot. */
export function getLocalLlmPrefs(): LocalLlmPrefs {
  cached ??= parseLocalLlmPrefs(readStorage());

  return cached;
}

export function setLocalLlmPrefs(patch: Partial<LocalLlmPrefs>): LocalLlmPrefs {
  const next = { ...getLocalLlmPrefs(), ...patch };

  // Clamped on the way in as well as on the way out, so a value typed into Settings is what chat uses at once,
  // not only after the next launch re-reads storage. Passing `undefined` clears an override.
  next.sampling = normalizeSampling(next.sampling);
  next.maxOutputTokens = boundedNumber(next.maxOutputTokens, LOCAL_LLM_BOUNDS.maxOutputTokens, true);
  next.thinkingTokenBudget = boundedNumber(
    next.thinkingTokenBudget,
    LOCAL_LLM_BOUNDS.thinkingTokenBudget,
    true,
  );

  cached = next;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not persisted, still applied for this session.
  }

  listeners.forEach((listener) => listener(next));

  return next;
}

export function subscribeLocalLlmPrefs(listener: Listener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop the in-memory copy so the next read goes back to storage. */
export function resetLocalLlmPrefsCache(): void {
  cached = null;
}
