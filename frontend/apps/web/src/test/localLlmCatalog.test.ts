import {
  evaluateModelFit,
  findLocalLlmModel,
  formatBytes,
  LOCAL_LLM_CATALOG,
  LOCAL_LLM_DISK_HEADROOM_BYTES,
  LOCAL_LLM_MODEL_LIST,
  localLlmModelsFor,
} from '@ci/common/src/utils/localLlmCatalog';
import {
  DEFAULT_LOCAL_LLM_PREFS,
  getLocalLlmPrefs,
  parseLocalLlmPrefs,
  resetLocalLlmPrefsCache,
  setLocalLlmPrefs,
  subscribeLocalLlmPrefs,
} from '@ci/common/src/utils/localLlmPrefs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_LLM_MODELS } from '../../../../packages/capacitor-local-llm/src/definitions';

const GIB = 1024 * 1024 * 1024;

describe('the on-device model catalog', () => {
  it('is an exact mirror of the plugin package’s LOCAL_LLM_MODELS', () => {
    // @ci/common cannot import the plugin package (it must not pull @capacitor/* into the web bundle),
    // so the catalog is copied — and this is the only thing that stops the copy drifting.
    expect(LOCAL_LLM_CATALOG).toEqual(LOCAL_LLM_MODELS);
  });

  it('pins every download to a commit, never to a moving branch', () => {
    for (const model of LOCAL_LLM_MODEL_LIST) {
      expect(model.commitHash).toMatch(/^[0-9a-f]{40}$/);
      // `resolve/main` is what left Qwen3 failing its size check when the file grew on `main`.
      expect(model.url).not.toMatch(/\/resolve\/main\//);
      expect(model.url).toContain(`/resolve/${model.commitHash}/`);
      expect(model.url.startsWith('https://huggingface.co/')).toBe(true);
    }
  });

  it('has unique ids, real sizes, and a default accelerator drawn from its own list', () => {
    const ids = LOCAL_LLM_MODEL_LIST.map((m) => m.modelId);

    expect(new Set(ids).size).toBe(ids.length);

    for (const model of LOCAL_LLM_MODEL_LIST) {
      expect(model.sizeBytes).toBeGreaterThan(100 * 1024 * 1024);
      expect(model.accelerators.length).toBeGreaterThan(0);
      expect(model.platforms.length).toBeGreaterThan(0);
      expect(model.minDeviceMemoryBytes).toBeGreaterThanOrEqual(4 * GIB);
      expect(model.defaultConfig.maxTokens).toBeGreaterThan(0);
    }
  });

  it('keys each entry by its own modelId', () => {
    for (const [key, model] of Object.entries(LOCAL_LLM_CATALOG)) {
      expect(model.modelId).toBe(key);
    }
  });

  it('offers only ungated models (a gated repo answers an anonymous download with 401)', () => {
    // Gemma 3n, Gemma3-1B and the FunctionGemma fine-tunes are `gated` on Hugging Face. They come back
    // with an HF sign-in flow — until then, listing one is a download that can never succeed.
    for (const model of LOCAL_LLM_MODEL_LIST) {
      expect(model.url).not.toMatch(/gemma-3n|Gemma3-1B|functiongemma/i);
    }
  });

  it('ships Gemma 4 on Android only — iOS has no increased-memory-limit entitlement', () => {
    expect(localLlmModelsFor('ios').map((m) => m.modelId)).toEqual([
      'qwen3-0.6b-int4',
      'qwen2.5-1.5b-instruct',
    ]);
    expect(localLlmModelsFor('android').map((m) => m.modelId)).toEqual([
      'qwen3-0.6b-int4',
      'qwen2.5-1.5b-instruct',
      'gemma-4-e2b-it',
      'gemma-4-e4b-it',
    ]);
  });

  it('only advertises vision on models that can see', () => {
    expect(
      LOCAL_LLM_MODEL_LIST.filter((m) => m.capabilities.includes('vision')).map((m) => m.modelId),
    ).toEqual(['gemma-4-e2b-it', 'gemma-4-e4b-it']);
  });

  it('pins Qwen3 to the revision that loads on LiteRT-LM 0.14.0, not to whatever main is now', () => {
    // `main` was re-exported on 2026-09-20 for LiteRT-LM 0.17.1+: on the 0.14.0 both platforms link it fails at
    // Engine.initialize(), and its size (344,671,744) no longer matches this entry. Bump the runtime first.
    const qwen3 = LOCAL_LLM_CATALOG['qwen3-0.6b-int4'];

    expect(qwen3.commitHash).toBe('154c5de0fc0fc5002a7da570ba8c67edffa32ca2');
    expect(qwen3.sizeBytes).toBe(344_437_808);
  });

  it('finds a model by id', () => {
    expect(findLocalLlmModel('gemma-4-e2b-it')?.label).toBe('Gemma 4 E2B');
    expect(findLocalLlmModel('missing')).toBeUndefined();
  });
});

describe('evaluateModelFit', () => {
  const qwen25 = LOCAL_LLM_CATALOG['qwen2.5-1.5b-instruct'];

  it('passes when nothing is known — the native side is the enforcer', () => {
    expect(evaluateModelFit(qwen25, {})).toEqual({ ok: true });
  });

  it('refuses a model the device does not have the RAM for, naming the requirement', () => {
    const fit = evaluateModelFit(qwen25, { totalMemoryBytes: 4 * GIB });

    expect(fit.ok).toBe(false);
    expect(fit).toMatchObject({ reason: expect.stringContaining('at least 6.0 GB') });
    // Says what the device actually reports too — an iPhone sold as 6 GB reports about 5.6 GB.
    expect(fit).toMatchObject({ reason: expect.stringContaining('reports 4.0 GB') });
  });

  it('refuses when free disk cannot cover the download plus headroom', () => {
    const fit = evaluateModelFit(qwen25, {
      totalMemoryBytes: 8 * GIB,
      freeDiskBytes: qwen25.sizeBytes, // enough for the file, not for the file plus headroom
    });

    expect(fit.ok).toBe(false);
  });

  it('accepts exactly enough disk', () => {
    expect(
      evaluateModelFit(qwen25, {
        totalMemoryBytes: 8 * GIB,
        freeDiskBytes: qwen25.sizeBytes + LOCAL_LLM_DISK_HEADROOM_BYTES,
      }),
    ).toEqual({ ok: true });
  });

  it('credits bytes already on disk, so a nearly finished download is not blocked by a full phone', () => {
    expect(
      evaluateModelFit(qwen25, {
        totalMemoryBytes: 8 * GIB,
        freeDiskBytes: LOCAL_LLM_DISK_HEADROOM_BYTES + 1,
        bytesOnDisk: qwen25.sizeBytes,
      }),
    ).toEqual({ ok: true });
  });

  it('checks memory before disk, so the reason names the harder problem', () => {
    const fit = evaluateModelFit(qwen25, { totalMemoryBytes: 2 * GIB, freeDiskBytes: 1 });

    expect(fit).toMatchObject({ ok: false, reason: expect.stringContaining('RAM') });
  });
});

describe('formatBytes', () => {
  it('uses one decimal from a gigabyte up and whole megabytes below', () => {
    expect(formatBytes(2_583_085_056)).toBe('2.4 GB');
    expect(formatBytes(344_437_808)).toBe('328 MB');
    expect(formatBytes(12 * GIB)).toBe('12.0 GB');
  });
});

describe('on-device preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    resetLocalLlmPrefsCache();
  });

  afterEach(() => {
    localStorage.clear();
    resetLocalLlmPrefsCache();
  });

  it('defaults to the appliance — the on-device model is strictly opt-in', () => {
    expect(getLocalLlmPrefs()).toEqual(DEFAULT_LOCAL_LLM_PREFS);
    expect(DEFAULT_LOCAL_LLM_PREFS.mode).toBe('appliance');
  });

  it('parses field by field, so one corrupt value does not discard the rest', () => {
    const parsed = parseLocalLlmPrefs(
      JSON.stringify({
        mode: 'device',
        modelId: 'gemma-4-e2b-it',
        accelerator: 'tpu', // not a real backend
        thinking: 'yes', // not a boolean
        intentTools: false,
      }),
    );

    expect(parsed).toEqual({
      ...DEFAULT_LOCAL_LLM_PREFS,
      mode: 'device',
      modelId: 'gemma-4-e2b-it',
      accelerator: null,
      thinking: false,
      intentTools: false,
    });
  });

  it('falls back to the defaults for garbage, an array, or nothing', () => {
    expect(parseLocalLlmPrefs('{not json')).toEqual(DEFAULT_LOCAL_LLM_PREFS);
    expect(parseLocalLlmPrefs('42')).toEqual(DEFAULT_LOCAL_LLM_PREFS);
    expect(parseLocalLlmPrefs(null)).toEqual(DEFAULT_LOCAL_LLM_PREFS);
    expect(parseLocalLlmPrefs(JSON.stringify({ mode: 'sometimes' })).mode).toBe('appliance');
  });

  it('persists a change, tells subscribers, and survives a cold read', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLocalLlmPrefs(listener);

    setLocalLlmPrefs({ mode: 'auto', modelId: 'qwen3-0.6b-int4' });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'auto', modelId: 'qwen3-0.6b-int4' }),
    );

    resetLocalLlmPrefsCache();
    expect(getLocalLlmPrefs()).toMatchObject({ mode: 'auto', modelId: 'qwen3-0.6b-int4' });

    unsubscribe();
    setLocalLlmPrefs({ thinking: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('returns a stable snapshot until something changes (a useSyncExternalStore requirement)', () => {
    expect(getLocalLlmPrefs()).toBe(getLocalLlmPrefs());

    const before = getLocalLlmPrefs();

    setLocalLlmPrefs({ thinking: true });
    expect(getLocalLlmPrefs()).not.toBe(before);
  });

  it('still applies a change for the session when storage throws', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => setLocalLlmPrefs({ mode: 'device' })).not.toThrow();
    expect(getLocalLlmPrefs().mode).toBe('device');

    setItem.mockRestore();
  });
});
