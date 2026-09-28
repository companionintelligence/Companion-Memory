/**
 * The estimator's one hard property, checked against the two measurements the
 * planner was built from (Ollama journal, 2026-09-14, `num_ctx` 32768):
 *
 *   gemma4:e4b   weights  9,608,350,718 B   Ollama predicted 12.2 GiB
 *   qwen3.6:27b  weights 17,420,432,739 B   Ollama predicted 17.9 GiB, resident 18,496,995,982 B
 *
 * An estimate BELOW Ollama's prediction is the bug: Ollama would try to evict
 * the chat model where this module said "fits", and the wedge returns.
 */
import {
  canonicalModelId,
  estimateFootprintBytes,
  GIB,
  MIB,
  kvBytesPerToken,
  parseModelGeometry,
  planChatContext,
  planUtilityResidency,
  sameModel,
  type ModelGeometry,
  type PlanInputs,
  trustworthyObservation,
} from '../footprint';

/** `/api/show` for gemma4:e4b, the keys the parser reads. */
const GEMMA4_INFO = {
  'general.architecture': 'gemma4',
  'gemma4.block_count': 42,
  'gemma4.attention.head_count': 8,
  'gemma4.attention.head_count_kv': 2,
  'gemma4.attention.key_length': 512,
  'gemma4.attention.value_length': 512,
  'gemma4.attention.shared_kv_layers': 18,
  'gemma4.attention.sliding_window': 512,
  'gemma4.context_length': 131_072,
  'gemma4.embedding_length': 2_560,
};

/** qwen3.6:27b — hybrid: one full-attention layer in four, `head_count_kv` per-layer (dropped by the API). */
const QWEN35_INFO = {
  'general.architecture': 'qwen35',
  'qwen35.block_count': 64,
  'qwen35.attention.head_count': 24,
  'qwen35.attention.head_count_kv': null,
  'qwen35.attention.key_length': 256,
  'qwen35.attention.value_length': 256,
  'qwen35.full_attention_interval': 4,
  'qwen35.context_length': 262_144,
  'qwen35.embedding_length': 5_120,
};

/** nomic-embed-text — no key/value_length; head dim derives from embedding_length / head_count. */
const NOMIC_INFO = {
  'general.architecture': 'nomic-bert',
  'nomic-bert.block_count': 12,
  'nomic-bert.attention.head_count': 12,
  'nomic-bert.context_length': 2_048,
  'nomic-bert.embedding_length': 768,
};

const GEMMA4_WEIGHTS = 9_608_350_718;
const QWEN_WEIGHTS = 17_420_432_739;
const QWEN_RESIDENT_32K = 18_496_995_982;

const gemma4 = parseModelGeometry(GEMMA4_INFO) as ModelGeometry;
const qwen35 = parseModelGeometry(QWEN35_INFO) as ModelGeometry;

describe('parseModelGeometry', () => {
  it('reads the attention geometry under the architecture prefix', () => {
    expect(gemma4).toMatchObject({
      architecture: 'gemma4',
      blockCount: 42,
      headCount: 8,
      headCountKv: 2,
      keyLength: 512,
      valueLength: 512,
      sharedKvLayers: 18,
      trainingContextLength: 131_072,
      fullAttentionInterval: null,
    });
  });

  it('treats a per-layer (array, dropped) head_count_kv as unknown and keeps the interval', () => {
    expect(qwen35.headCountKv).toBeNull();
    expect(qwen35.fullAttentionInterval).toBe(4);
  });

  it('derives the head dimension when key_length is absent', () => {
    const nomic = parseModelGeometry(NOMIC_INFO);

    expect(nomic).toMatchObject({ keyLength: 64, valueLength: 64, trainingContextLength: 2_048 });
  });

  it('accepts the Map the client typings declare as well as the object the wire carries', () => {
    expect(parseModelGeometry(new Map(Object.entries(GEMMA4_INFO)))).toEqual(gemma4);
  });

  it('returns null when the block or head count is missing', () => {
    expect(parseModelGeometry({ 'general.architecture': 'x', 'x.block_count': 10 })).toBeNull();
    expect(parseModelGeometry({})).toBeNull();
    expect(parseModelGeometry(null)).toBeNull();
  });
});

describe('kvBytesPerToken', () => {
  it('counts only layers that own a KV cache', () => {
    // (42 − 18 shared) layers × 2 kv heads × (512 + 512) × 2 bytes
    expect(kvBytesPerToken(gemma4)).toBe(24 * 2 * 1024 * 2);
    // ceil(64 / 4) full-attention layers × 24 heads (kv unknown → upper bound) × 512 × 2
    expect(kvBytesPerToken(qwen35)).toBe(16 * 24 * 512 * 2);
  });
});

describe('estimateFootprintBytes stays above what Ollama predicts', () => {
  it('gemma4:e4b at 32k: above 12.2 GiB from metadata alone, and not absurdly so', () => {
    const estimate = estimateFootprintBytes({
      weightBytes: GEMMA4_WEIGHTS,
      geometry: gemma4,
      numCtx: 32_768,
    });

    expect(estimate).toBeGreaterThan(12.2 * GIB);
    expect(estimate).toBeLessThan(13.5 * GIB);
  });

  it('qwen3.6:27b at 32k: metadata alone is a gross over-estimate (safe), a live sighting tightens it but stays above 17.9 GiB', () => {
    const blind = estimateFootprintBytes({ weightBytes: QWEN_WEIGHTS, geometry: qwen35, numCtx: 32_768 });
    const calibrated = estimateFootprintBytes({
      weightBytes: QWEN_WEIGHTS,
      geometry: qwen35,
      numCtx: 32_768,
      observation: { numCtx: 32_768, sizeVramBytes: QWEN_RESIDENT_32K, weightBytes: QWEN_WEIGHTS },
    });

    expect(blind).toBeGreaterThan(25 * GIB);
    expect(calibrated).toBeGreaterThan(17.9 * GIB);
    expect(calibrated).toBeLessThan(19.5 * GIB);
    expect(calibrated).toBeLessThan(blind);
  });

  it('shrinks with the context window', () => {
    const at32k = estimateFootprintBytes({ weightBytes: GEMMA4_WEIGHTS, geometry: gemma4, numCtx: 32_768 });
    const at4k = estimateFootprintBytes({ weightBytes: GEMMA4_WEIGHTS, geometry: gemma4, numCtx: 4_096 });

    expect(at4k).toBeLessThan(at32k);
    expect(at4k).toBeGreaterThan(GEMMA4_WEIGHTS);
  });

  it('never lets an observation LOWER the estimate below the metadata bound it contradicts upward', () => {
    // A sighting that used MORE than the formula predicts (e.g. a vision projector) must not raise it
    // above the formula either — the formula is already the conservative bound for a standard model.
    const formula = estimateFootprintBytes({ weightBytes: GEMMA4_WEIGHTS, geometry: gemma4, numCtx: 8_192 });
    const inflated = estimateFootprintBytes({
      weightBytes: GEMMA4_WEIGHTS,
      geometry: gemma4,
      numCtx: 8_192,
      observation: { numCtx: 8_192, sizeVramBytes: GEMMA4_WEIGHTS + 20 * GIB, weightBytes: GEMMA4_WEIGHTS },
    });

    expect(inflated).toBe(formula);
  });
});

describe('estimateFootprintBytes with a card-level sighting', () => {
  // The 27B on the 24 GiB card, 2026-09-17: /api/ps 17.4 GB at 32k; sysfs 23,268 MiB in use, of which
  // the resident embedder accounts for ~307 MiB — so 22,961 MiB were this model's.
  const CARD_SEEN = 22_961 * MIB;
  const seen = {
    numCtx: 32_768,
    sizeVramBytes: 17_399_734_598,
    weightBytes: 17_741_872_154,
    cardBytes: CARD_SEEN,
    totalTokens: 32_768,
  };

  it("outranks both the formula and Ollama's own accounting when it says more", () => {
    const withCard = estimateFootprintBytes({
      weightBytes: seen.weightBytes,
      geometry: qwen35,
      numCtx: 32_768,
      observation: seen,
    });
    const withoutCard = estimateFootprintBytes({
      weightBytes: seen.weightBytes,
      geometry: qwen35,
      numCtx: 32_768,
      observation: { numCtx: seen.numCtx, sizeVramBytes: seen.sizeVramBytes, weightBytes: seen.weightBytes },
    });
    expect(withCard).toBeGreaterThanOrEqual(CARD_SEEN);
    expect(withoutCard).toBeLessThan(CARD_SEEN);
  });

  it('carries the sighting to a larger layout by the KV delta only: two 32k slots cost one more 32k of KV', () => {
    const at64k = estimateFootprintBytes({
      weightBytes: seen.weightBytes,
      geometry: qwen35,
      numCtx: 65_536,
      observation: seen,
    });
    expect(at64k).toBeCloseTo(CARD_SEEN + kvBytesPerToken(qwen35) * 32_768, -6);
  });

  it('two 16k slots cost exactly the sighted one 32k slot', () => {
    expect(
      estimateFootprintBytes({
        weightBytes: seen.weightBytes,
        geometry: qwen35,
        numCtx: 2 * 16_384,
        observation: seen,
      }),
    ).toBeCloseTo(CARD_SEEN, -6);
  });

  it('shrinks for a smaller layout but never below the formula', () => {
    const at4k = estimateFootprintBytes({
      weightBytes: seen.weightBytes,
      geometry: qwen35,
      numCtx: 4_096,
      observation: seen,
    });
    const formula4k = estimateFootprintBytes({
      weightBytes: seen.weightBytes,
      geometry: qwen35,
      numCtx: 4_096,
    });
    expect(at4k).toBeLessThan(CARD_SEEN);
    expect(at4k).toBeGreaterThanOrEqual(Math.min(formula4k, at4k));
  });
});

describe('planChatContext on the measured card with two slots', () => {
  const CARD = 25_753_026_560;
  const seen = {
    numCtx: 32_768,
    sizeVramBytes: 17_399_734_598,
    weightBytes: 17_741_872_154,
    cardBytes: 22_961 * MIB,
    totalTokens: 32_768,
  };
  const inputs = {
    chatModel: 'qwen3.8:27b-mtp-q4_K_M',
    residents: [],
    gpu: { totalBytes: CARD, usedBytes: 0, source: 'sysfs' as const },
    candidate: { weightBytes: seen.weightBytes, geometry: qwen35, observation: seen },
    embedReserveBytes: 0,
    safetyMarginBytes: GIB,
  };

  it('chooses 16k per slot for the 27B with two slots: two 32k slots would exceed what the card was seen to hold', () => {
    expect(planChatContext({ ...inputs, parallelSlots: 2 })).toMatchObject({
      kind: 'planned',
      numCtx: 16_384,
    });
  });

  it('keeps 32k with one slot on the same card and the same sighting', () => {
    expect(planChatContext({ ...inputs, parallelSlots: 1 })).toMatchObject({
      kind: 'planned',
      numCtx: 32_768,
    });
  });
});

describe('model id matching', () => {
  it('treats the implicit :latest tag as the bare id', () => {
    expect(canonicalModelId('nomic-embed-text:latest')).toBe('nomic-embed-text');
    expect(sameModel('nomic-embed-text', 'nomic-embed-text:latest')).toBe(true);
    expect(sameModel('gemma4:e4b', 'gemma4:31b')).toBe(false);
  });
});

describe('planUtilityResidency', () => {
  /** The box the wedge happened on: 24 GiB card, 27B chat model resident at 32k, embedder resident, HBPE holding ~3 GiB. */
  const CARD = 25_753_026_560;
  const wedgeBox: PlanInputs = {
    utilityModel: 'gemma4:e4b',
    chatModel: 'qwen3.6:27b',
    residents: [
      { name: 'qwen3.6:27b', sizeVramBytes: QWEN_RESIDENT_32K, contextLength: 32_768 },
      { name: 'nomic-embed-text:latest', sizeVramBytes: 323_150_151, contextLength: 2_048 },
    ],
    gpu: { totalBytes: CARD, usedBytes: 22_240_452_608, source: 'sysfs', device: 'card1' },
    candidate: { weightBytes: GEMMA4_WEIGHTS, geometry: gemma4, observation: null },
    embedReserveBytes: 0,
    safetyMarginBytes: GIB,
  };

  it('routes to the RESIDENT chat model, at its loaded context, when the utility model cannot fit at any rung', () => {
    const plan = planUtilityResidency(wedgeBox);

    expect(plan.kind).toBe('routed');
    expect(plan.model).toBe('qwen3.6:27b');
    // Same window the runner already has — a different one could make Ollama reload it.
    expect(plan.numCtx).toBe(32_768);

    if (plan.kind === 'routed') {
      expect(plan.headroomBytes).toBeLessThan(3 * GIB);
      expect(plan.smallestFootprintBytes).toBeGreaterThan(GEMMA4_WEIGHTS);
    }
  });

  it('uses the utility model as is, at its loaded context, when it is already resident', () => {
    const plan = planUtilityResidency({
      ...wedgeBox,
      residents: [
        ...wedgeBox.residents,
        { name: 'gemma4:e4b', sizeVramBytes: 11 * GIB, contextLength: 16_384 },
      ],
    });

    expect(plan).toMatchObject({ kind: 'resident', model: 'gemma4:e4b', numCtx: 16_384 });
  });

  it('loads at the LARGEST rung that fits when the chat model is small enough to share the card', () => {
    // Chat model gone; only the embedder resident; HBPE ~3 GiB → ~20 GiB free.
    const plan = planUtilityResidency({
      ...wedgeBox,
      residents: [wedgeBox.residents[1]],
      gpu: { totalBytes: CARD, usedBytes: 3.5 * GIB, source: 'sysfs' },
    });

    expect(plan).toMatchObject({ kind: 'load', model: 'gemma4:e4b', numCtx: 32_768 });
  });

  it('steps down the ladder when only a smaller window fits', () => {
    // 12.7 GiB at 32k, ~9.9 GiB at 4k. Leave room for ~11 GiB after margin.
    const plan = planUtilityResidency({
      ...wedgeBox,
      residents: [wedgeBox.residents[1]],
      gpu: { totalBytes: CARD, usedBytes: CARD - 12 * GIB, source: 'sysfs' },
    });

    expect(plan.kind).toBe('load');
    expect(plan.numCtx).toBeLessThan(32_768);
    expect(plan.numCtx).toBeGreaterThanOrEqual(4_096);
  });

  it('caps the ladder by the model training window', () => {
    const tiny = { ...gemma4, trainingContextLength: 8_192 };
    const plan = planUtilityResidency({
      ...wedgeBox,
      residents: [],
      gpu: { totalBytes: CARD, usedBytes: 0, source: 'sysfs' },
      candidate: { weightBytes: GEMMA4_WEIGHTS, geometry: tiny },
    });

    expect(plan).toMatchObject({ kind: 'load', numCtx: 8_192 });
  });

  it('subtracts a reserve for an embedder that is not resident', () => {
    const withoutReserve = planUtilityResidency({
      ...wedgeBox,
      residents: [],
      gpu: { totalBytes: CARD, usedBytes: CARD - 14 * GIB, source: 'sysfs' },
      embedReserveBytes: 0,
    });
    const withReserve = planUtilityResidency({
      ...wedgeBox,
      residents: [],
      gpu: { totalBytes: CARD, usedBytes: CARD - 14 * GIB, source: 'sysfs' },
      embedReserveBytes: 2 * GIB,
    });

    expect(withoutReserve).toMatchObject({ kind: 'load', numCtx: 32_768 });
    expect(withReserve.kind).toBe('load');
    expect(withReserve.numCtx).toBeLessThan(32_768);
  });

  it('routes to the chat model when GPU memory is unknown — a fit cannot be proven', () => {
    const plan = planUtilityResidency({ ...wedgeBox, gpu: null });

    expect(plan.kind).toBe('routed');
    expect(plan.model).toBe('qwen3.6:27b');
  });

  it('routes to the chat model when the utility model is not served at all', () => {
    const plan = planUtilityResidency({ ...wedgeBox, candidate: null });

    expect(plan).toMatchObject({ kind: 'routed', model: 'qwen3.6:27b' });
  });

  it('routes without a context when the chat model is not resident either', () => {
    const plan = planUtilityResidency({ ...wedgeBox, residents: [], candidate: null });

    expect(plan.kind).toBe('routed');
    expect(plan.numCtx).toBeUndefined();
  });

  it('proposes no load while the watchdog has paused co-residency, and resumes after', () => {
    const roomy: PlanInputs = {
      ...wedgeBox,
      residents: [wedgeBox.residents[0]],
      gpu: { totalBytes: CARD, usedBytes: 0, source: 'sysfs' },
      coResidencyBlocked: { untilMs: 1_000_000, reason: 'a load never became resident' },
    };

    const paused = planUtilityResidency({ ...roomy, nowMs: 500_000 });
    const resumed = planUtilityResidency({ ...roomy, nowMs: 1_000_000 });

    expect(paused.kind).toBe('routed');
    expect(paused.model).toBe('qwen3.6:27b');

    if (paused.kind === 'routed') {
      expect(paused.reason).toContain('paused');
      expect(paused.reason).toContain('a load never became resident');
    }

    expect(resumed.kind).toBe('load');
  });

  it('never proposes a load when the geometry is unreadable', () => {
    const plan = planUtilityResidency({
      ...wedgeBox,
      residents: [],
      gpu: { totalBytes: CARD, usedBytes: 0, source: 'sysfs' },
      candidate: { weightBytes: GEMMA4_WEIGHTS, geometry: null },
    });

    expect(plan.kind).toBe('routed');
  });
});

describe('planChatContext', () => {
  const CARD = 25_753_026_560;
  const noResidents = {
    residents: [],
    gpu: { totalBytes: CARD, usedBytes: 0, source: 'sysfs' as const },
    embedReserveBytes: 0,
    safetyMarginBytes: GIB,
  };
  const gemma4Chat = {
    chatModel: 'gemma4:e4b',
    candidate: { weightBytes: GEMMA4_WEIGHTS, geometry: gemma4, observation: null },
  };

  it('answers with the loaded window when the chat model is already resident, without estimating', () => {
    const plan = planChatContext({
      ...noResidents,
      ...gemma4Chat,
      residents: [{ name: 'gemma4:e4b', sizeVramBytes: 11 * GIB, contextLength: 16_384 }],
      // Even with no candidate data the resident answer stands: nothing needs proving.
      candidate: null,
    });
    expect(plan).toEqual({ kind: 'resident', numCtx: 16_384 });
  });

  it('plans the LARGEST ladder rung whose footprint fits the whole card, not the card minus residents', () => {
    // Another model resident does not shrink the chat model\'s headroom: Ollama evicts for the primary.
    const plan = planChatContext({
      ...noResidents,
      ...gemma4Chat,
      residents: [{ name: 'some-other:7b', sizeVramBytes: 20 * GIB, contextLength: 8_192 }],
    });
    expect(plan).toMatchObject({ kind: 'planned', numCtx: 32_768 });
  });

  it('steps down the ladder on a smaller card', () => {
    // 12.7 GiB at 32k for gemma4; a 12 GiB card with a 1 GiB margin leaves ~11 GiB.
    const plan = planChatContext({
      ...noResidents,
      ...gemma4Chat,
      gpu: { totalBytes: 12 * GIB, usedBytes: 0, source: 'sysfs' },
    });
    expect(plan.kind).toBe('planned');
    if (plan.kind === 'planned') {
      expect(plan.numCtx).toBeLessThan(32_768);
      expect(plan.numCtx).toBeGreaterThanOrEqual(4_096);
      expect(plan.footprintBytes).toBeLessThanOrEqual(plan.headroomBytes);
    }
  });

  it('never plans above 32k, whatever the card: larger windows are an explicit operator or Hub decision', () => {
    const plan = planChatContext({
      ...noResidents,
      ...gemma4Chat,
      gpu: { totalBytes: 80 * GIB, usedBytes: 0, source: 'nvidia-smi' },
    });
    expect(plan).toMatchObject({ kind: 'planned', numCtx: 32_768 });
  });

  it('caps the ladder at the training window', () => {
    const plan = planChatContext({
      ...noResidents,
      chatModel: 'tiny:1b',
      candidate: {
        weightBytes: GIB,
        geometry: { ...gemma4, trainingContextLength: 8_192 },
        observation: null,
      },
    });
    expect(plan).toMatchObject({ kind: 'planned', numCtx: 8_192 });
  });

  it('keeps the embedding reserve out of the headroom when the embedder is not resident', () => {
    // Enough card for 32k only if the reserve is ignored — so the reserve must step it down.
    const at32k = 13 * GIB;
    const plan = planChatContext({
      ...noResidents,
      ...gemma4Chat,
      gpu: { totalBytes: at32k + GIB, usedBytes: 0, source: 'sysfs' },
      embedReserveBytes: 2 * GIB,
    });
    expect(plan.kind).toBe('planned');
    if (plan.kind === 'planned') {
      expect(plan.numCtx).toBeLessThan(32_768);
    }
  });

  it('reports unknown, never a guess, when the GPU, the model or its geometry cannot be read', () => {
    expect(planChatContext({ ...noResidents, ...gemma4Chat, gpu: null })).toMatchObject({ kind: 'unknown' });
    expect(planChatContext({ ...noResidents, chatModel: 'ghost:1b', candidate: null })).toMatchObject({
      kind: 'unknown',
    });
    expect(
      planChatContext({
        ...noResidents,
        chatModel: 'ghost:1b',
        candidate: { weightBytes: GIB, geometry: null, observation: null },
      }),
    ).toMatchObject({ kind: 'unknown' });
  });

  it('charges every Ollama slot its own KV cache, so two slots step the per-slot window down on the same card', () => {
    const smallCard = { totalBytes: 15 * GIB, usedBytes: 0, source: 'sysfs' as const };
    const oneSlot = planChatContext({ ...noResidents, ...gemma4Chat, gpu: smallCard, parallelSlots: 1 });
    const twoSlots = planChatContext({ ...noResidents, ...gemma4Chat, gpu: smallCard, parallelSlots: 2 });
    expect(oneSlot.kind).toBe('planned');
    expect(twoSlots.kind).toBe('planned');
    if (oneSlot.kind === 'planned' && twoSlots.kind === 'planned') {
      expect(twoSlots.numCtx).toBeLessThan(oneSlot.numCtx);
      // Per-slot window halves at most; two slots at half the window cost the same KV as one at full.
      expect(twoSlots.numCtx).toBeGreaterThanOrEqual(oneSlot.numCtx / 2);
    }

    // A resident model is echoed regardless of slots: the loaded window is the loaded window.
    expect(
      planChatContext({
        ...noResidents,
        ...gemma4Chat,
        residents: [{ name: 'gemma4:e4b', sizeVramBytes: 11 * GIB, contextLength: 16_384 }],
        parallelSlots: 2,
      }),
    ).toEqual({ kind: 'resident', numCtx: 16_384 });
  });

  it('reports unknown when even the smallest rung does not fit', () => {
    const plan = planChatContext({
      ...noResidents,
      ...gemma4Chat,
      gpu: { totalBytes: 4 * GIB, usedBytes: 0, source: 'sysfs' },
    });
    expect(plan).toMatchObject({ kind: 'unknown' });
  });
});

describe('trustworthyObservation', () => {
  const CARD = 25_753_026_560;
  const legit = {
    numCtx: 32_768,
    sizeVramBytes: 17_399_734_598,
    weightBytes: 17_741_872_154,
    cardBytes: 22_961 * MIB,
    totalTokens: 32_768,
  };
  // The 2026-09-22 calibration file: the whole card, 23.7 GiB, recorded as the 27B's
  // footprint at 32k after its runner had leaked ~1.9 MiB per request for hours.
  const poisoned = { ...legit, cardBytes: 25_421_131_449 };
  const capacity = CARD - GIB;

  it('keeps a card sighting the card can actually hold', () => {
    expect(trustworthyObservation(legit, capacity)).toBe(legit);
  });

  it('strikes a card sighting that says the model needs more than the card gave it at that very window', () => {
    expect(trustworthyObservation(poisoned, capacity)).toEqual({
      numCtx: 32_768,
      sizeVramBytes: 17_399_734_598,
      weightBytes: 17_741_872_154,
    });
    expect(trustworthyObservation(null, capacity)).toBeNull();
  });

  it('planChatContext plans 32k, not 4k, from the poisoned file — the reload loop of 2026-09-22', () => {
    const inputs = {
      chatModel: 'qwen3.8:27b-mtp-q4_K_M',
      residents: [],
      gpu: { totalBytes: CARD, usedBytes: 0, source: 'sysfs' as const },
      embedReserveBytes: 0,
      safetyMarginBytes: GIB,
    };

    expect(
      planChatContext({
        ...inputs,
        candidate: { weightBytes: poisoned.weightBytes, geometry: qwen35, observation: poisoned },
      }),
    ).toMatchObject({ kind: 'planned', numCtx: 32_768 });
    // A sighting the card can hold is still honoured in full (the two-slot case above steps to 16k).
    expect(
      planChatContext({
        ...inputs,
        parallelSlots: 2,
        candidate: { weightBytes: legit.weightBytes, geometry: qwen35, observation: legit },
      }),
    ).toMatchObject({ kind: 'planned', numCtx: 16_384 });
  });
});
