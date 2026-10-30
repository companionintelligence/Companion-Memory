import { Injectable, Optional } from '@nestjs/common';

import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { PersonService, UserContextService } from '@ci/domains/memory';

export type DecisionEngineMode = 'auto' | 'contrastive' | 'generative' | 'hybrid';
export type DecisionEngineUsed = 'contrastive' | 'generative' | 'hybrid' | 'disabled';

export interface ScoreCriterion {
  name: string;
  positive: string;
  negative?: string;
  weight?: number;
}

export interface NoulDecisionResult {
  primitive: 'noul';
  engineUsed: DecisionEngineUsed;
  probability: number;
  decision: boolean;
  margin: number;
  positiveSimilarity: number;
  negativeSimilarity: number;
  latencyMs: number;
}

export interface ChoiceCandidateScore {
  id: string;
  label: string;
  probability: number;
  similarity: number;
}

export interface ChoiceDecisionResult {
  primitive: 'choice';
  engineUsed: DecisionEngineUsed;
  selectedId: string | null;
  selectedLabel: string | null;
  confidence: number;
  margin: number;
  escalatedToGenerative: boolean;
  candidates: ChoiceCandidateScore[];
  latencyMs: number;
}

export interface ScoreCriterionResult {
  name: string;
  probability: number;
  weight: number;
}

export interface ScoreDecisionResult {
  primitive: 'score';
  engineUsed: DecisionEngineUsed;
  compositeScore: number;
  criteria: ScoreCriterionResult[];
  latencyMs: number;
}

export interface RankCandidateInput {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RankedCandidate extends RankCandidateInput {
  score: number;
  probability: number;
  rank: number;
}

export interface RankDecisionResult {
  engineUsed: DecisionEngineUsed;
  items: RankedCandidate[];
  arenaHitCount: number;
  arenaMissCount: number;
  latencyMs: number;
}

export interface DecisionOptions {
  userId?: string;
  engine?: DecisionEngineMode;
  temperature?: number;
  threshold?: number;
  escalationMarginThreshold?: number;
  topK?: number;
}

export interface GenerativeDecisionEvaluator {
  evaluateNoul?(state: string, action: string, negatedAction: string): Promise<number>;
  evaluateChoice?(
    state: string,
    candidates: ReadonlyArray<{ id: string; label: string }>,
  ): Promise<{ selectedId: string; probabilities: Record<string, number> }>;
}

const DEFAULT_TEMPERATURE = 0.12;
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_ESCALATION_MARGIN = 0.15;
const DEFAULT_ARENA_CAPACITY = 512;
const FALLBACK_VECTOR_DIM = 128;

/**
 * In-memory LRU cache of unit-normalized embedding vectors for candidate
 * actions, intents, and rubric poles (`Contrastive-LM/CLM` Action Vector Arena).
 *
 * Because candidate action sets (intent descriptions, tool schemas, yes/no
 * anchors) are reused across turns, caching their unit vectors means each
 * decision only embeds the current `state` once and evaluates all candidates via
 * sub-millisecond dot products.
 */
export class ActionVectorArena {
  private readonly store = new Map<string, number[]>();

  constructor(private readonly maxEntries: number = DEFAULT_ARENA_CAPACITY) {}

  get size(): number {
    return this.store.size;
  }

  get(text: string): number[] | undefined {
    const key = text.trim();
    const existing = this.store.get(key);
    if (!existing) {
      return undefined;
    }

    // Refresh LRU order
    this.store.delete(key);
    this.store.set(key, existing);

    return existing;
  }

  set(text: string, vector: number[]): number[] {
    const key = text.trim();
    const normalized = normalizeVector(vector);
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }

    this.store.set(key, normalized);

    return normalized;
  }

  clear(): void {
    this.store.clear();
  }
}

export function normalizeVector(vec: readonly number[]): number[] {
  let normSq = 0;
  for (let i = 0; i < vec.length; i += 1) {
    normSq += vec[i] * vec[i];
  }

  const norm = Math.sqrt(normSq);
  if (norm === 0) {
    return vec.map(() => 0);
  }

  return vec.map((v) => v / norm);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) {
    return 0;
  }

  let dot = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
  }

  return Math.max(-1, Math.min(1, dot));
}

/**
 * Deterministic hashed character-trigram + word-unigram projection into a
 * unit-normalized $\mathbb{R}^{128}$ vector. Used when the external embedding
 * service is offline or in unit tests without an embedding daemon.
 */
export function deterministicTextEmbedding(text: string, dim: number = FALLBACK_VECTOR_DIM): number[] {
  const vec = Array.from({ length: dim }, () => 0);
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return vec;
  }

  const words = cleaned.split(' ');
  for (const word of words) {
    if (!word) {
      continue;
    }

    const h1 = fnv1aHash(word);
    const idx = h1 % dim;
    const sign = (h1 & 1) === 0 ? 1 : -1;
    vec[idx] += sign * 1.5;

    const padded = `^${word}$`;
    for (let i = 0; i <= padded.length - 3; i += 1) {
      const trigram = padded.slice(i, i + 3);
      const h2 = fnv1aHash(trigram);
      const triIdx = h2 % dim;
      const triSign = (h2 & 1) === 0 ? 1 : -1;
      vec[triIdx] += triSign * 0.5;
    }
  }

  return normalizeVector(vec);
}

function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function softmax(logits: readonly number[], temperature: number): number[] {
  if (logits.length === 0) {
    return [];
  }

  const tau = Math.max(0.01, temperature);
  const scaled = logits.map((x) => x / tau);
  const maxLogit = Math.max(...scaled);
  const exps = scaled.map((x) => Math.exp(x - maxLogit));
  const sumExp = exps.reduce((acc, v) => acc + v, 0) || 1;

  return exps.map((v) => v / sumExp);
}

/**
 * Dual-engine decision service implementing both:
 * 1. **System 1 — Contrastive Decision Layer (`Contrastive-LM/CLM` pattern)**:
 *    Sub-10ms embedding-geometry primitives (`noul`, `choice`, `score`, `rank`)
 *    backed by {@link ActionVectorArena}.
 * 2. **System 2 — Generative Decision Layer**:
 *    Deliberative evaluation / fallback when confidence margin is ambiguous or
 *    when the user disables the contrastive layer in Settings.
 */
@Injectable()
export class ContrastiveDecisionService {
  private readonly arena = new ActionVectorArena();

  private generativeEvaluator?: GenerativeDecisionEvaluator;

  constructor(
    @Optional() private readonly embeddingService?: EmbeddingGenerationService,
    @Optional() private readonly personService?: PersonService,
    @Optional() private readonly userContextService?: UserContextService,
  ) {}

  setGenerativeEvaluator(evaluator: GenerativeDecisionEvaluator | undefined): void {
    this.generativeEvaluator = evaluator;
  }

  getArenaStats(): { size: number } {
    return { size: this.arena.size };
  }

  clearArena(): void {
    this.arena.clear();
  }

  /**
   * `Noul` — binary probability $P(\text{yes} \mid \text{state}, \text{action})$.
   */
  async noul(
    state: string,
    action: string,
    options: DecisionOptions & { negatedAction?: string } = {},
  ): Promise<NoulDecisionResult> {
    const startedAt = Date.now();
    const negatedAction = options.negatedAction ?? `not ${action}`;
    const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    const escalationMargin = options.escalationMarginThreshold ?? DEFAULT_ESCALATION_MARGIN;

    const effectiveMode = await this.resolveEffectiveEngine(options.userId, options.engine);
    if (effectiveMode === 'disabled') {
      return {
        primitive: 'noul',
        engineUsed: 'disabled',
        probability: 0.5,
        decision: false,
        margin: 0,
        positiveSimilarity: 0,
        negativeSimilarity: 0,
        latencyMs: Date.now() - startedAt,
      };
    }

    if (effectiveMode === 'generative') {
      const prob = await this.runGenerativeNoul(state, action, negatedAction);
      const margin = Math.abs(prob - (1 - prob));

      return {
        primitive: 'noul',
        engineUsed: 'generative',
        probability: prob,
        decision: prob >= threshold,
        margin,
        positiveSimilarity: prob,
        negativeSimilarity: 1 - prob,
        latencyMs: Date.now() - startedAt,
      };
    }

    const stateVec = await this.embedState(state);
    const [posVec, negVec] = await Promise.all([
      this.embedCandidate(action),
      this.embedCandidate(negatedAction),
    ]);

    const posSim = cosineSimilarity(stateVec, posVec.vector);
    const negSim = cosineSimilarity(stateVec, negVec.vector);
    const [pYes, pNo] = softmax([posSim, negSim], temperature);
    const margin = Math.abs(pYes - pNo);

    if (effectiveMode === 'hybrid' && margin < escalationMargin) {
      const genProb = await this.runGenerativeNoul(state, action, negatedAction);
      const blendedProb = 0.5 * pYes + 0.5 * genProb;

      return {
        primitive: 'noul',
        engineUsed: 'hybrid',
        probability: blendedProb,
        decision: blendedProb >= threshold,
        margin: Math.abs(blendedProb - (1 - blendedProb)),
        positiveSimilarity: posSim,
        negativeSimilarity: negSim,
        latencyMs: Date.now() - startedAt,
      };
    }

    return {
      primitive: 'noul',
      engineUsed: 'contrastive',
      probability: pYes,
      decision: pYes >= threshold,
      margin,
      positiveSimilarity: posSim,
      negativeSimilarity: negSim,
      latencyMs: Date.now() - startedAt,
    };
  }

  /**
   * `Choice` — k-way categorical distribution $P(a_i \mid \text{state})$ over
   * candidate actions/intents.
   */
  async choice(
    state: string,
    candidates: ReadonlyArray<string | { id: string; label: string }>,
    options: DecisionOptions = {},
  ): Promise<ChoiceDecisionResult> {
    const startedAt = Date.now();
    const normalizedCandidates = candidates.map((c, idx) =>
      typeof c === 'string' ? { id: String(idx), label: c } : c,
    );

    if (normalizedCandidates.length === 0) {
      return {
        primitive: 'choice',
        engineUsed: 'disabled',
        selectedId: null,
        selectedLabel: null,
        confidence: 0,
        margin: 0,
        escalatedToGenerative: false,
        candidates: [],
        latencyMs: Date.now() - startedAt,
      };
    }

    const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    const escalationMargin = options.escalationMarginThreshold ?? DEFAULT_ESCALATION_MARGIN;
    const effectiveMode = await this.resolveEffectiveEngine(options.userId, options.engine);

    if (effectiveMode === 'disabled') {
      const uniform = 1 / normalizedCandidates.length;

      return {
        primitive: 'choice',
        engineUsed: 'disabled',
        selectedId: null,
        selectedLabel: null,
        confidence: uniform,
        margin: 0,
        escalatedToGenerative: false,
        candidates: normalizedCandidates.map((c) => ({
          id: c.id,
          label: c.label,
          probability: uniform,
          similarity: 0,
        })),
        latencyMs: Date.now() - startedAt,
      };
    }

    if (effectiveMode === 'generative') {
      const gen = await this.runGenerativeChoice(state, normalizedCandidates);

      return this.buildChoiceResultFromProbs(
        normalizedCandidates,
        gen.probabilities,
        gen.probabilities,
        'generative',
        true,
        startedAt,
      );
    }

    const stateVec = await this.embedState(state);
    const candidateVecs = await Promise.all(normalizedCandidates.map((c) => this.embedCandidate(c.label)));
    const similarities = candidateVecs.map((cv) => cosineSimilarity(stateVec, cv.vector));
    const probs = softmax(similarities, temperature);

    const scored: ChoiceCandidateScore[] = normalizedCandidates
      .map((c, i) => ({
        id: c.id,
        label: c.label,
        probability: probs[i],
        similarity: similarities[i],
      }))
      .sort((a, b) => b.probability - a.probability);

    const topProb = scored[0]?.probability ?? 0;
    const secondProb = scored[1]?.probability ?? 0;
    const margin = topProb - secondProb;

    if (effectiveMode === 'hybrid' && normalizedCandidates.length > 1 && margin < escalationMargin) {
      const gen = await this.runGenerativeChoice(state, normalizedCandidates);
      const blendedProbs: Record<string, number> = {};
      const simMap: Record<string, number> = {};
      for (const item of scored) {
        const gProb = gen.probabilities[item.id] ?? 1 / normalizedCandidates.length;
        blendedProbs[item.id] = 0.5 * item.probability + 0.5 * gProb;
        simMap[item.id] = item.similarity;
      }

      return this.buildChoiceResultFromProbs(
        normalizedCandidates,
        blendedProbs,
        simMap,
        'hybrid',
        true,
        startedAt,
      );
    }

    return {
      primitive: 'choice',
      engineUsed: 'contrastive',
      selectedId: scored[0]?.id ?? null,
      selectedLabel: scored[0]?.label ?? null,
      confidence: topProb,
      margin,
      escalatedToGenerative: false,
      candidates: scored,
      latencyMs: Date.now() - startedAt,
    };
  }

  /**
   * `Score` — multi-criterion weighted rubric evaluation over `state`.
   */
  async score(
    state: string,
    criteria: ReadonlyArray<ScoreCriterion>,
    options: DecisionOptions = {},
  ): Promise<ScoreDecisionResult> {
    const startedAt = Date.now();
    if (criteria.length === 0) {
      return {
        primitive: 'score',
        engineUsed: 'disabled',
        compositeScore: 0,
        criteria: [],
        latencyMs: Date.now() - startedAt,
      };
    }

    const results: ScoreCriterionResult[] = [];
    let weightedSum = 0;
    let totalWeight = 0;
    let engineUsed: DecisionEngineUsed = 'contrastive';

    for (const criterion of criteria) {
      const weight = criterion.weight ?? 1;
      const noulRes = await this.noul(state, criterion.positive, {
        ...options,
        negatedAction: criterion.negative ?? `not ${criterion.positive}`,
      });
      engineUsed = noulRes.engineUsed;
      results.push({
        name: criterion.name,
        probability: noulRes.probability,
        weight,
      });
      weightedSum += noulRes.probability * weight;
      totalWeight += weight;
    }

    return {
      primitive: 'score',
      engineUsed,
      compositeScore: totalWeight > 0 ? weightedSum / totalWeight : 0,
      criteria: results,
      latencyMs: Date.now() - startedAt,
    };
  }

  /**
   * Fast candidate reranker (`POST /model-routing/rank`): ranks candidate intents,
   * tools, or memory fragments against `query` using the ActionVectorArena.
   */
  async rank(
    query: string,
    candidates: ReadonlyArray<RankCandidateInput>,
    options: DecisionOptions = {},
  ): Promise<RankDecisionResult> {
    const startedAt = Date.now();
    const topK = options.topK ?? candidates.length;
    const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

    if (candidates.length === 0) {
      return {
        engineUsed: 'disabled',
        items: [],
        arenaHitCount: 0,
        arenaMissCount: 0,
        latencyMs: Date.now() - startedAt,
      };
    }

    const effectiveMode = await this.resolveEffectiveEngine(options.userId, options.engine);
    if (effectiveMode === 'disabled') {
      const uniform = 1 / candidates.length;

      return {
        engineUsed: 'disabled',
        items: candidates.slice(0, topK).map((c, idx) => ({
          ...c,
          score: 0,
          probability: uniform,
          rank: idx + 1,
        })),
        arenaHitCount: 0,
        arenaMissCount: 0,
        latencyMs: Date.now() - startedAt,
      };
    }

    const queryVec = await this.embedState(query);
    let arenaHitCount = 0;
    let arenaMissCount = 0;

    const embedded = await Promise.all(
      candidates.map(async (candidate) => {
        const res = await this.embedCandidate(candidate.text);
        if (res.cached) {
          arenaHitCount += 1;
        } else {
          arenaMissCount += 1;
        }

        return res.vector;
      }),
    );

    const sims = embedded.map((vec) => cosineSimilarity(queryVec, vec));
    const probs = softmax(sims, temperature);

    let scores = sims.slice();
    let finalProbs = probs.slice();
    let engineUsed: DecisionEngineUsed = 'contrastive';

    if (effectiveMode === 'generative' || effectiveMode === 'hybrid') {
      const gen = await this.runGenerativeChoice(
        query,
        candidates.map((c) => ({ id: c.id, label: c.text })),
      );
      if (effectiveMode === 'generative') {
        engineUsed = 'generative';
        finalProbs = candidates.map((c) => gen.probabilities[c.id] ?? 0);
        scores = finalProbs.slice();
      } else {
        engineUsed = 'hybrid';
        finalProbs = candidates.map((c, idx) => 0.5 * probs[idx] + 0.5 * (gen.probabilities[c.id] ?? 0));
        scores = candidates.map((c, idx) => 0.5 * sims[idx] + 0.5 * (gen.probabilities[c.id] ?? 0));
      }
    }

    const ranked = candidates
      .map((candidate, idx) => ({
        ...candidate,
        score: scores[idx],
        probability: finalProbs[idx],
        rank: 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((item, idx) => ({ ...item, rank: idx + 1 }));

    return {
      engineUsed,
      items: ranked,
      arenaHitCount,
      arenaMissCount,
      latencyMs: Date.now() - startedAt,
    };
  }

  private buildChoiceResultFromProbs(
    candidates: ReadonlyArray<{ id: string; label: string }>,
    probMap: Record<string, number>,
    simMap: Record<string, number>,
    engineUsed: DecisionEngineUsed,
    escalatedToGenerative: boolean,
    startedAt: number,
  ): ChoiceDecisionResult {
    const scored: ChoiceCandidateScore[] = candidates
      .map((c) => ({
        id: c.id,
        label: c.label,
        probability: probMap[c.id] ?? 0,
        similarity: simMap[c.id] ?? 0,
      }))
      .sort((a, b) => b.probability - a.probability);

    const topProb = scored[0]?.probability ?? 0;
    const secondProb = scored[1]?.probability ?? 0;

    return {
      primitive: 'choice',
      engineUsed,
      selectedId: scored[0]?.id ?? null,
      selectedLabel: scored[0]?.label ?? null,
      confidence: topProb,
      margin: topProb - secondProb,
      escalatedToGenerative,
      candidates: scored,
      latencyMs: Date.now() - startedAt,
    };
  }

  private async resolveEffectiveEngine(
    userId: string | undefined,
    requested: DecisionEngineMode | undefined,
  ): Promise<DecisionEngineUsed> {
    const prefs = await this.readUserEnginePrefs(userId);

    if (requested === 'contrastive') {
      return prefs.contrastiveDecisionEnabled ? 'contrastive' : 'disabled';
    }

    if (requested === 'generative') {
      return prefs.generativeDecisionEnabled ? 'generative' : 'disabled';
    }

    if (requested === 'hybrid') {
      if (prefs.contrastiveDecisionEnabled && prefs.generativeDecisionEnabled) {
        return 'hybrid';
      }

      if (prefs.contrastiveDecisionEnabled) {
        return 'contrastive';
      }

      if (prefs.generativeDecisionEnabled) {
        return 'generative';
      }

      return 'disabled';
    }

    // Default ('auto'): use hybrid cascade when both engines are enabled, or whichever is enabled.
    if (prefs.contrastiveDecisionEnabled && prefs.generativeDecisionEnabled) {
      return 'hybrid';
    }

    if (prefs.contrastiveDecisionEnabled) {
      return 'contrastive';
    }

    if (prefs.generativeDecisionEnabled) {
      return 'generative';
    }

    return 'disabled';
  }

  private async readUserEnginePrefs(userId: string | undefined): Promise<{
    contrastiveDecisionEnabled: boolean;
    generativeDecisionEnabled: boolean;
  }> {
    if (!userId || !this.userContextService || !this.personService) {
      return { contrastiveDecisionEnabled: true, generativeDecisionEnabled: true };
    }

    try {
      const selfIdentity = await this.userContextService.getSelfIdentity(userId);
      if (!selfIdentity) {
        return { contrastiveDecisionEnabled: true, generativeDecisionEnabled: true };
      }

      const self = await this.personService.findById({ userId }, selfIdentity.entityId);
      const planner = (self?.properties?.planner ?? {}) as Record<string, unknown>;

      return {
        contrastiveDecisionEnabled: planner.contrastive_decision_enabled !== false,
        generativeDecisionEnabled: planner.generative_decision_enabled !== false,
      };
    } catch {
      return { contrastiveDecisionEnabled: true, generativeDecisionEnabled: true };
    }
  }

  private async embedState(text: string): Promise<number[]> {
    if (this.embeddingService) {
      try {
        const raw = await this.embeddingService.generateEmbedding(text);
        if (Array.isArray(raw) && raw.length > 0) {
          return normalizeVector(raw);
        }
      } catch {
        // Fall through to deterministic projection if embedding daemon is unreachable.
      }
    }

    return deterministicTextEmbedding(text);
  }

  private async embedCandidate(text: string): Promise<{ vector: number[]; cached: boolean }> {
    const cached = this.arena.get(text);
    if (cached) {
      return { vector: cached, cached: true };
    }

    const computed = await this.embedState(text);
    const stored = this.arena.set(text, computed);

    return { vector: stored, cached: false };
  }

  private async runGenerativeNoul(state: string, action: string, negatedAction: string): Promise<number> {
    if (this.generativeEvaluator?.evaluateNoul) {
      return this.generativeEvaluator.evaluateNoul(state, action, negatedAction);
    }

    // Deliberative lexical-overlap + structural polarity fallback when no custom LLM callback is registered.
    const posOverlap = tokenOverlapScore(state, action);
    const negOverlap = tokenOverlapScore(state, negatedAction);
    const [pYes] = softmax([posOverlap, negOverlap], 0.2);

    return pYes;
  }

  private async runGenerativeChoice(
    state: string,
    candidates: ReadonlyArray<{ id: string; label: string }>,
  ): Promise<{ selectedId: string; probabilities: Record<string, number> }> {
    if (this.generativeEvaluator?.evaluateChoice) {
      return this.generativeEvaluator.evaluateChoice(state, candidates);
    }

    const overlaps = candidates.map((c) => tokenOverlapScore(state, c.label));
    const probs = softmax(overlaps, 0.2);
    const probMap: Record<string, number> = {};
    let bestId = candidates[0]?.id ?? '';
    let bestProb = -1;
    candidates.forEach((c, idx) => {
      probMap[c.id] = probs[idx];
      if (probs[idx] > bestProb) {
        bestProb = probs[idx];
        bestId = c.id;
      }
    });

    return { selectedId: bestId, probabilities: probMap };
  }
}

function tokenOverlapScore(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
  const tokensB = new Set(b.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }

  let shared = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) {
      shared += 1;
    }
  }

  return shared / Math.sqrt(tokensA.size * tokensB.size);
}
