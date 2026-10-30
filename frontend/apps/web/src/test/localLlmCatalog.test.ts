import {
  evaluateModelFit,
  findLocalLlmModel,
  formatBytes,
  gpuAllowedOn,
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
    // Nothing on iOS since 2026-10-13: its on-device chat is to come from Apple Intelligence.
    expect(localLlmModelsFor('ios').map((m) => m.modelId)).toEqual([]);
    expect(localLlmModelsFor('android').map((m) => m.modelId)).toEqual(['gemma-4-e2b-it', 'gemma-4-e4b-it']);
  });

  it('only advertises vision on models that can see', () => {
    expect(
      LOCAL_LLM_MODEL_LIST.filter((m) => m.capabilities.includes('vision')).map((m) => m.modelId),
    ).toEqual(['gemma-4-e2b-it', 'gemma-4-e4b-it']);
  });

  it('pins Gemma 4 E2B to a revision that loads on LiteRT-LM 0.18.0, not to whatever main is now', () => {
    // Qwen3-0.6B's `main` was re-exported under the catalog on 2026-09-20 and every download failed its size
    // check; every entry is pinned the same way, commit and size together. This is the 2026-06-05 re-export.
    const e2b = LOCAL_LLM_CATALOG['gemma-4-e2b-it'];

    expect(e2b.commitHash).toBe('361a4010ad6d88fc5c86e148e333c0342b99763d');
    expect(e2b.sizeBytes).toBe(2_588_147_712);
  });

  it('offers nothing below 6 GB: such a phone has no offline chat rather than a model that cannot do the job', () => {
    // 6 GB is Gemma 4 E2B on the CPU (its GPU needs 8 GB). Dropped on 2026-10-13: Qwen3-0.6B (4 GB) could emit a
    // tool call but never act on the result; Qwen3-1.7B (6 GB on paper) needs ~3.3 GB of graphics memory on the
    // GPU and was killed on an 8 GB phone.
    expect(Math.min(...LOCAL_LLM_MODEL_LIST.map((m) => m.minDeviceMemoryBytes))).toBe(6 * GIB);
    expect(LOCAL_LLM_MODEL_LIST.every((m) => m.capabilities.includes('tools'))).toBe(true);
  });

  it('withholds the GPU under a model’s GPU floor, and never sets that floor under the model’s own', () => {
    const e2b = LOCAL_LLM_CATALOG['gemma-4-e2b-it'];

    expect(e2b.gpuMinDeviceMemoryBytes).toBe(8 * GIB);
    expect(gpuAllowedOn(e2b, 6 * GIB)).toBe(false);
    expect(gpuAllowedOn(e2b, 8 * GIB)).toBe(true);
    expect(gpuAllowedOn(e2b, 12 * GIB)).toBe(true);
    // Unknown memory passes: the native side is the enforcer and reports `gpuWithheld`.
    expect(gpuAllowedOn(e2b, undefined)).toBe(true);
    // A model without a GPU backend is never allowed one, whatever the memory.
    expect(gpuAllowedOn({ ...e2b, accelerators: ['cpu'] }, 16 * GIB)).toBe(false);

    for (const model of LOCAL_LLM_MODEL_LIST) {
      expect(model.gpuMinDeviceMemoryBytes, model.modelId).toBeGreaterThanOrEqual(model.minDeviceMemoryBytes);
    }
  });

  it('finds a model by id', () => {
    expect(findLocalLlmModel('gemma-4-e2b-it')?.label).toBe('Gemma 4 E2B');
    expect(findLocalLlmModel('missing')).toBeUndefined();
  });
});

describe('evaluateModelFit', () => {
  const qwen25 = LOCAL_LLM_CATALOG['gemma-4-e2b-it'];

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

  it('forgets a stored model the catalog no longer ships, keeping the rest of the preference', () => {
    // Seen on a device the day Qwen3-0.6B was dropped: the saved id reached requireModel() from the
    // settings section and the whole On-device card showed "Unknown on-device model: qwen3-0.6b-int4".
    const parsed = parseLocalLlmPrefs(
      JSON.stringify({ mode: 'device', modelId: 'qwen3-0.6b-int4', thinking: true }),
    );

    expect(parsed).toEqual({ ...DEFAULT_LOCAL_LLM_PREFS, mode: 'device', modelId: null, thinking: true });
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

    setLocalLlmPrefs({ mode: 'auto', modelId: 'gemma-4-e2b-it' });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'auto', modelId: 'gemma-4-e2b-it' }),
    );

    resetLocalLlmPrefsCache();
    expect(getLocalLlmPrefs()).toMatchObject({ mode: 'auto', modelId: 'gemma-4-e2b-it' });

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
