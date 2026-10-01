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

import type { LocalLlmAccelerator } from './localLlmCatalog';

/**
 * - `appliance` — always the CI-Server. The on-device model is never used.
 * - `auto` — the appliance first; when it cannot be reached, answer on-device instead.
 * - `device` — always on-device, even with the appliance reachable (airplane mode, or privacy).
 */
export type LocalLlmMode = 'appliance' | 'auto' | 'device';

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

  return {
    mode: isMode(value.mode) ? value.mode : DEFAULT_LOCAL_LLM_PREFS.mode,
    modelId: typeof value.modelId === 'string' && value.modelId ? value.modelId : null,
    accelerator: isAccelerator(value.accelerator) ? value.accelerator : null,
    thinking: typeof value.thinking === 'boolean' ? value.thinking : DEFAULT_LOCAL_LLM_PREFS.thinking,
    speculativeDecoding:
      typeof value.speculativeDecoding === 'boolean'
        ? value.speculativeDecoding
        : DEFAULT_LOCAL_LLM_PREFS.speculativeDecoding,
    intentTools:
      typeof value.intentTools === 'boolean' ? value.intentTools : DEFAULT_LOCAL_LLM_PREFS.intentTools,
  };
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
