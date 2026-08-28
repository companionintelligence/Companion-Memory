import type { UserServiceContext } from '@ci/common/context';

import type { ObjectObservation } from '../entities/ObjectObservationEntity';

import {
  AUTO_RESOLVE_CONFIDENCE_THRESHOLD,
  EMBEDDING_DISTANCE_FLOOR,
  IDENTIFIER_CONFIDENCE,
  LABEL_CONFIDENCE,
  ObjectResolutionService,
  PLACE_PRIOR_CONFIDENCE,
} from './ObjectResolutionService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const OBSERVATION = '00000000-0000-0000-0000-0000000000b1';
const OBJECT = '00000000-0000-0000-0000-0000000000c1';
const OTHER_OBJECT = '00000000-0000-0000-0000-0000000000c2';
const PRODUCT = '00000000-0000-0000-0000-0000000000d1';
const PLACE = '00000000-0000-0000-0000-0000000000e1';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function observation(overrides: Partial<ObjectObservation> = {}): ObjectObservation {
  return {
    id: OBSERVATION,
    userId: USER,
    observedAt: new Date('2026-03-02T10:00:00Z'),
    label: 'coffee mug',
    attributes: {},
    placeEntityId: null,
    confirmedByUser: false,
    resolutionMethod: 'none',
    resolutionConfidence: null,
    resolvedObjectId: null,
    resolvedProductId: null,
    ...overrides,
  } as ObjectObservation;
}

interface QueryPlan {
  /** Rows returned by the embedding probe. */
  embedding?: Array<{ object_id: string; score: string }>;
  /** Rows returned by the place-prior candidate query. */
  placePrior?: Array<{ object_id: string }>;
  /** Rows returned by the label candidate query. */
  label?: Array<{ object_id: string }>;
  /** Owned units of a product, for the identifier rung's model branch. */
  productUnits?: Array<{ object_id: string }>;
}

function makeHarness(plan: QueryPlan = {}) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });

    if (sql.includes('ci_search.embeddings')) {
      return plan.embedding ?? [];
    }

    if (sql.includes("inv.metadata->'mint'->>'place_entity_id'")) {
      return plan.placePrior ?? [];
    }

    if (sql.includes('lower(btrim(base.name)) = $2')) {
      return plan.label ?? [];
    }

    if (sql.includes('product_id = $2::uuid')) {
      return plan.productUnits ?? [];
    }

    return [];
  });

  const findById = jest.fn(async () => observation());
  const resolveObservation = jest.fn(async () => observation());
  const findForReview = jest.fn(async () => []);
  // Typed loosely so individual tests can mockResolvedValue a match; the real
  // return is ObjectIdentifierMatch | null.
  const resolveIdentifier = jest.fn<Promise<unknown>, unknown[]>(async () => null);
  const resolveScan = jest.fn<Promise<unknown>, unknown[]>(async () => null);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new ObjectResolutionService(
    { query } as never,
    { findById, resolve: resolveObservation, findForReview } as never,
    { resolve: resolveIdentifier, resolveScan } as never,
    logger as never,
  );

  return {
    service,
    statements,
    findById,
    resolveObservation,
    findForReview,
    resolveIdentifier,
    resolveScan,
  };
}

describe('ObjectResolutionService ladder', () => {
  it('reports none when no rung matches', async () => {
    const harness = makeHarness();

    const candidate = await harness.service.resolve(CONTEXT, observation());

    expect(candidate).toMatchObject({ method: 'none', confidence: null, objectId: null });
  });

  it('prefers a scanned identifier over every weaker rung', async () => {
    const harness = makeHarness({
      embedding: [{ object_id: OTHER_OBJECT, score: '0.99' }],
      label: [{ object_id: OTHER_OBJECT }],
    });
    harness.resolveIdentifier.mockResolvedValue({
      subjectType: 'object_instance',
      subjectId: OBJECT,
      namespace: 'gtin',
      valueNormalized: '00012345678905',
    });

    const candidate = await harness.service.resolve(
      CONTEXT,
      observation({ attributes: { identifier_codes: { gtin: '012345678905' } } }),
    );

    expect(candidate).toMatchObject({
      method: 'identifier',
      confidence: IDENTIFIER_CONFIDENCE,
      objectId: OBJECT,
    });
    // A barcode is an answer — the weaker rungs are never even queried.
    expect(harness.statements.some(({ sql }) => sql.includes('ci_search.embeddings'))).toBe(false);
  });

  it('detects the namespace from the value when the sighting does not say', async () => {
    const harness = makeHarness();
    harness.resolveScan.mockResolvedValue({
      subjectType: 'object_instance',
      subjectId: OBJECT,
      namespace: 'gtin',
      valueNormalized: '00012345678905',
    });

    await harness.service.resolve(CONTEXT, observation({ attributes: { barcode: '012345678905' } }));

    expect(harness.resolveScan).toHaveBeenCalledWith(USER, '012345678905');
  });

  it('refuses to pick one unit when a product claim covers several', async () => {
    const harness = makeHarness({ productUnits: [{ object_id: OBJECT }, { object_id: OTHER_OBJECT }] });
    harness.resolveIdentifier.mockResolvedValue({
      subjectType: 'product_model',
      subjectId: PRODUCT,
      namespace: 'gtin',
      valueNormalized: '00012345678905',
    });

    const candidate = await harness.service.resolve(
      CONTEXT,
      observation({ attributes: { identifier_codes: { gtin: '012345678905' } } }),
    );

    // Two units of one model are indistinguishable by their shared barcode.
    expect(candidate.objectId).toBeNull();
    expect(candidate.productId).toBe(PRODUCT);
  });

  it('resolves a product claim to the single owned unit of that model', async () => {
    const harness = makeHarness({ productUnits: [{ object_id: OBJECT }] });
    harness.resolveIdentifier.mockResolvedValue({
      subjectType: 'product_model',
      subjectId: PRODUCT,
      namespace: 'asin',
      valueNormalized: 'B09XS7JWHH',
    });

    const candidate = await harness.service.resolve(
      CONTEXT,
      observation({ attributes: { identifier_codes: { asin: 'B09XS7JWHH' } } }),
    );

    expect(candidate).toMatchObject({ objectId: OBJECT, productId: PRODUCT });
  });

  it('reports the measured cosine similarity as the embedding rung confidence', async () => {
    const harness = makeHarness({ embedding: [{ object_id: OBJECT, score: '0.87' }] });

    const candidate = await harness.service.resolve(CONTEXT, observation());

    expect(candidate).toMatchObject({ method: 'embedding', objectId: OBJECT, confidence: 0.87 });
  });

  it('orders the embedding query by raw cosine distance against a pseudoconstant probe, so HNSW can serve it', async () => {
    const harness = makeHarness({ embedding: [{ object_id: OBJECT, score: '0.87' }] });

    await harness.service.resolve(CONTEXT, observation());

    const probe = harness.statements.find(({ sql }) => sql.includes('ci_search.embeddings'));

    // The ORDER BY is the raw operator, ascending — `1 - (a <=> b) DESC` is
    // mathematically identical and opaque to the planner.
    expect(probe?.sql).toMatch(
      /ORDER BY e\.embedding <=> \(SELECT o\.embedding FROM ci\.object_observations/,
    );

    // …and its right-hand side is a SCALAR SUBQUERY, never a joined relation.
    // `col <=> other_relation.col` is not an indexable order-by expression at
    // all, so the old `JOIN probe ON TRUE` shape could not use ANY hnsw index.
    // Proved for real in ObjectResolutionService.integration.spec.ts, which
    // reads the actual EXPLAIN; a mock can only check the text.
    expect(probe?.sql).not.toContain('JOIN probe');
    expect(probe?.sql).not.toContain('probe.embedding');

    // <=> (cosine), never <-> (L2): these embeddings are unnormalised.
    expect(probe?.sql).not.toContain('<->');
    // A merged-away unit keeps its embedding until the merge deletes it.
    expect(probe?.sql).toContain('inv.merged_into_object_id IS NULL');
    // The distance floor is applied OUTSIDE the ANN limit, so it filters the
    // one nearest neighbour rather than every candidate.
    expect(probe?.sql).toMatch(/\) nearest\s+WHERE nearest\.distance < \$3::double precision/);
    expect(probe?.params[2]).toBe(EMBEDDING_DISTANCE_FLOOR);
  });

  it('falls to the place prior only when the place names exactly one candidate', async () => {
    const one = makeHarness({ placePrior: [{ object_id: OBJECT }] });
    expect(await one.service.resolve(CONTEXT, observation({ placeEntityId: PLACE }))).toMatchObject({
      method: 'place_prior',
      confidence: PLACE_PRIOR_CONFIDENCE,
      objectId: OBJECT,
    });

    const ambiguous = makeHarness({
      placePrior: [{ object_id: OBJECT }, { object_id: OTHER_OBJECT }],
    });
    expect(await ambiguous.service.resolve(CONTEXT, observation({ placeEntityId: PLACE }))).toMatchObject({
      method: 'none',
    });
  });

  it('skips the place rung entirely when the sighting has no place', async () => {
    const harness = makeHarness({ placePrior: [{ object_id: OBJECT }] });

    await harness.service.resolve(CONTEXT, observation({ placeEntityId: null }));

    expect(harness.statements.some(({ sql }) => sql.includes("metadata->'mint'"))).toBe(false);
  });

  it('offers a bare label match at a confidence below any sane threshold', async () => {
    const harness = makeHarness({ label: [{ object_id: OBJECT }] });

    const candidate = await harness.service.resolve(CONTEXT, observation());

    expect(candidate).toMatchObject({ method: 'label', confidence: LABEL_CONFIDENCE });
    expect(LABEL_CONFIDENCE).toBeLessThan(AUTO_RESOLVE_CONFIDENCE_THRESHOLD);
  });
});

describe('ObjectResolutionService.resolveAndApply', () => {
  it('writes a resolution that clears the threshold and touches last_seen', async () => {
    const harness = makeHarness();
    harness.resolveIdentifier.mockResolvedValue({
      subjectType: 'object_instance',
      subjectId: OBJECT,
      namespace: 'gtin',
      valueNormalized: '00012345678905',
    });
    harness.findById.mockResolvedValue(
      observation({ attributes: { identifier_codes: { gtin: '012345678905' } } }),
    );

    const outcome = await harness.service.resolveAndApply(CONTEXT, OBSERVATION);

    expect(outcome?.applied).toBe(true);
    expect(harness.resolveObservation).toHaveBeenCalledWith(CONTEXT, OBSERVATION, {
      resolvedObjectId: OBJECT,
      resolvedProductId: null,
      resolutionMethod: 'identifier',
      resolutionConfidence: IDENTIFIER_CONFIDENCE,
    });

    const touch = harness.statements.find(({ sql }) => sql.includes('SET last_seen_at'));
    // Guarded so a backfill of old photos cannot walk "last seen" backwards.
    expect(touch?.sql).toContain('last_seen_at IS NULL OR last_seen_at < $3');
  });

  it('leaves a below-threshold candidate unwritten', async () => {
    const harness = makeHarness({ label: [{ object_id: OBJECT }] });

    const outcome = await harness.service.resolveAndApply(CONTEXT, OBSERVATION);

    expect(outcome).toMatchObject({ method: 'label', applied: false });
    // An unresolved observation is a question; a wrong resolution is an answer.
    expect(harness.resolveObservation).not.toHaveBeenCalled();
  });

  it('honours a caller-supplied threshold', async () => {
    const harness = makeHarness({ label: [{ object_id: OBJECT }] });

    const outcome = await harness.service.resolveAndApply(CONTEXT, OBSERVATION, { threshold: 0.4 });

    expect(outcome?.applied).toBe(true);
  });

  it('never revises a resolution a human confirmed', async () => {
    const harness = makeHarness({ label: [{ object_id: OBJECT }] });
    harness.findById.mockResolvedValue(
      observation({ confirmedByUser: true, resolvedObjectId: OTHER_OBJECT, resolutionMethod: 'user' }),
    );

    const outcome = await harness.service.resolveAndApply(CONTEXT, OBSERVATION);

    expect(outcome).toMatchObject({ applied: false, objectId: OTHER_OBJECT });
    expect(harness.resolveObservation).not.toHaveBeenCalled();
  });

  it('returns null for an observation that does not exist', async () => {
    const harness = makeHarness();
    harness.findById.mockResolvedValue(null as never);

    expect(await harness.service.resolveAndApply(CONTEXT, OBSERVATION)).toBeNull();
  });

  it('never creates an object row from a sighting', async () => {
    const harness = makeHarness({ embedding: [{ object_id: OBJECT, score: '0.99' }] });

    await harness.service.resolveAndApply(CONTEXT, OBSERVATION);

    // The retired inventory listener wrote speculative possessions straight from a
    // vision guess; ci.object_observations exists to stop exactly that.
    expect(harness.statements.some(({ sql }) => sql.includes('INSERT INTO ci.objects'))).toBe(false);
  });
});
