import { canonicalDataClass, canonicalPurpose, canonicalQueryType } from './canonical';
import type { AskGrant } from './entities/AskGrantEntity';
import {
  decideGrant,
  evaluateGrant,
  type GrantEvaluation,
  type GrantFacts,
  type QueryFacts,
} from './grantMatch';
import { DISCLOSURE_RUNGS } from './policy';
import type { AskActor, AskDelegation, AskGrantScope, AskQuery, DisclosureRung, GrantMode } from './types';

/**
 * The `//@` contract on `decideGrant`, checked against the real code, and `evaluateGrant`
 * checked against a second, brute-force reading of the same rules.
 *
 * LemmaScript proves `decideGrant` (spec/lemmascript) about a model whose strings are Unicode
 * scalar sequences and whose string unions are closed. `evaluateGrant` feeds it from raw rows,
 * through regex-based canonicalizers, `Date` and `localeCompare`, none of which the prover sees.
 * So the generators here deliberately produce what the model leaves out: respellings the
 * canonicalizers fold, astral characters and lone surrogates, ids that collate as equal, and
 * windows written with characters that JavaScript orders differently from Unicode.
 */

/** A small seeded PRNG (mulberry32) so a failure is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

function maybe<T>(random: () => number, value: () => T): T | undefined {
  return random() < 0.5 ? undefined : value();
}

const NOW = new Date('2026-07-15T00:00:00Z');
const CASES = 3000;

const MODES: readonly GrantMode[] = ['auto', 'review', 'block'];
const TYPES = [
  'photos',
  'Photos',
  ' photos ',
  '\u200bphotos',
  '\uff50\uff48\uff4f\uff54\uff4f\uff53',
  'calendar',
  '',
  '   ',
];
const CLASSES = ['photos', 'PHOTOS', 'photos\u00a0', 'medical', '\ud83d\ude00', 'lone\ud800', '', ' '];
const PURPOSES = ['research', 'Research ', 'audit', '   '];
const DELEGATIONS = ['none', 'first-party-only', 'any-agent', 'bogus'] as AskDelegation[];
const ACTORS: AskActor[] = [{ kind: 'person' }, { kind: 'first-party-agent' }, { kind: 'third-party-agent' }];
const CEILINGS = [...DISCLOSURE_RUNGS, 'Full', 'count ', 'summry'];
/** Window bounds: ISO instants, and characters JavaScript orders unlike Unicode (see below). */
const INSTANTS = [
  '2026-07-01T00:00:00Z',
  '2026-07-31T00:00:00Z',
  '2027-01-01T00:00:00Z',
  '\ue000',
  '\ud83d\ude00',
];
/** Ids that tie under localeCompare (a precomposed and a decomposed e-acute), and repeats. */
const IDS = ['g-a', 'g-b', 'g-\u00e9', 'g-e\u0301', '019a-0001', '019a-0002', 'g-a'];

/** Whether a delegation setting admits this actor: matched on kind, nothing declared admits nothing. */
function admits(delegation: AskDelegation, actor: AskActor | undefined): boolean {
  const kind = actor?.kind;

  return (
    actor != null &&
    ((delegation === 'none' && kind === 'person') ||
      (delegation === 'first-party-only' && (kind === 'person' || kind === 'first-party-agent')) ||
      delegation === 'any-agent')
  );
}

/** The same word as the canonicalizers will read it, spelt another way. */
function respell(random: () => number, word: string): string {
  return pick(random, [word, word.toUpperCase(), ` ${word} `, `\u200b${word}`, `${word}\u00a0`]);
}

/** A word from the pool, or (half the time) the ask's own word respelt, so grants often match. */
function near(random: () => number, pool: readonly string[], word: string | undefined): string {
  return word != null && random() < 0.5 ? respell(random, word) : pick(random, pool);
}

function randomScope(random: () => number, query: AskQuery): AskGrantScope | null {
  if (random() < 0.3) {
    return null;
  }

  const scope: AskGrantScope = {};
  const list = (pool: readonly string[], word: string | undefined) =>
    Array.from({ length: Math.floor(random() * 3) }, () => near(random, pool, word));
  const fields: [keyof AskGrantScope, () => unknown][] = [
    ['dataClasses', () => list(CLASSES, query.dataClass)],
    ['archetypes', () => list(TYPES, query.queryType)],
    ['maxDisclosure', () => pick(random, CEILINGS)],
    ['notBefore', () => pick(random, INSTANTS)],
    ['notAfter', () => pick(random, INSTANTS)],
    ['purpose', () => near(random, PURPOSES, query.filters?.purpose as string | undefined)],
    ['delegation', () => pick(random, DELEGATIONS)],
  ];
  for (const [key, value] of fields) {
    if (random() < 0.2) {
      scope[key] = value();
    }
  }

  return scope;
}

function randomGrant(random: () => number, query: AskQuery): AskGrant {
  const past = new Date(NOW.getTime() - 86_400_000);
  const future = new Date(NOW.getTime() + 86_400_000);

  return {
    id: pick(random, IDS),
    ownerUserId: 'owner',
    granteeUserId: 'asker',
    granteePeerLinkId: null,
    resourceType: null,
    resourceId: null,
    queryType: near(random, TYPES, query.queryType),
    dataClass: random() < 0.3 ? null : near(random, CLASSES, query.dataClass),
    scope: randomScope(random, query),
    mode: pick(random, MODES),
    purpose: null,
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: random() < 0.15 ? pick(random, [past, future]) : null,
    expiresAt: random() < 0.25 ? pick(random, [past, future, NOW]) : null,
    revocationReason: null,
    version: 1,
    supersedesGrantId: null,
  } as AskGrant;
}

function randomQuery(random: () => number): AskQuery {
  const filters: Record<string, unknown> = {};
  if (random() < 0.6) {
    filters.from = pick(random, [...INSTANTS, 20260701]);
  }

  if (random() < 0.6) {
    filters.to = pick(random, INSTANTS);
  }

  if (random() < 0.4) {
    filters.purpose = pick(random, PURPOSES);
  }

  return {
    queryType: pick(random, TYPES),
    ...(random() < 0.7 ? { dataClass: pick(random, CLASSES) } : {}),
    prompt: 'do you have photos of us?',
    ...(random() < 0.5 ? { actor: pick(random, ACTORS) } : {}),
    filters,
  };
}

/**
 * The rules as the docs state them, read straight off the raw rows: no facts, no up-front
 * canonicalization, a filter per rule, and the strictest grant by a sort. Agreeing with this on
 * every generated case is what ties the proved core to the shell that feeds it.
 */
function bruteForce(query: AskQuery, grants: readonly AskGrant[]): GrantEvaluation {
  const type = canonicalQueryType(query.queryType);
  const cls = canonicalDataClass(query.dataClass);
  const from = typeof query.filters?.from === 'string' ? query.filters.from : undefined;
  const to = typeof query.filters?.to === 'string' ? query.filters.to : undefined;
  const purpose = canonicalPurpose(
    typeof query.filters?.purpose === 'string' ? query.filters.purpose : undefined,
  );

  const live = (g: AskGrant) => g.revokedAt == null && (g.expiresAt == null || g.expiresAt > NOW);
  const sameType = (g: AskGrant) => canonicalQueryType(g.queryType) === type;
  const listed = (g: AskGrant) => (g.scope?.dataClasses ?? []).map((c) => canonicalDataClass(c));
  const classFits = (g: AskGrant) =>
    sameType(g) &&
    (canonicalDataClass(g.dataClass) == null || canonicalDataClass(g.dataClass) === cls) &&
    (g.scope?.dataClasses == null || (cls != null && listed(g).includes(cls)));
  const scopeFits = (g: AskGrant) => {
    const s = g.scope;

    return (
      (s?.archetypes == null || s.archetypes.map((a) => canonicalQueryType(a)).includes(type ?? '')) &&
      (s?.notBefore == null || (from != null && !(from < s.notBefore))) &&
      (s?.notAfter == null || (to != null && !(to > s.notAfter))) &&
      (s?.delegation == null || admits(s.delegation, query.actor)) &&
      (s?.purpose == null || purpose === canonicalPurpose(s.purpose))
    );
  };

  const ceiling = (g: AskGrant): DisclosureRung | undefined => {
    const declared = g.scope?.maxDisclosure;
    if (declared == null) {
      return undefined;
    }

    const canonical = canonicalDataClass(declared);

    return DISCLOSURE_RUNGS.find((rung) => rung === canonical) ?? 'none';
  };

  const rank = (g: AskGrant) => {
    const c = ceiling(g);

    return c == null ? DISCLOSURE_RUNGS.length : DISCLOSURE_RUNGS.indexOf(c);
  };

  const strictest = (gs: AskGrant[]) =>
    [...gs].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))[0];

  const block = grants.find(
    (g) => live(g) && g.mode === 'block' && sameType(g) && (cls == null || classFits(g)),
  );
  if (block) {
    return { decision: 'deny', grantId: block.id };
  }

  const fits = grants.filter((g) => live(g) && g.mode !== 'block' && classFits(g) && scopeFits(g));
  const names = (g: AskGrant) =>
    cls != null && (canonicalDataClass(g.dataClass) != null || g.scope?.dataClasses != null);
  const auto = strictest(fits.filter((g) => g.mode === 'auto' && names(g)));
  if (auto) {
    return { decision: 'auto', grantId: auto.id, maxDisclosure: ceiling(auto) };
  }

  const review =
    strictest(fits.filter((g) => g.mode === 'review')) ?? strictest(fits.filter((g) => g.mode === 'auto'));
  if (review) {
    return { decision: 'review', grantId: review.id, maxDisclosure: ceiling(review) };
  }

  return { decision: 'review' };
}

describe('evaluateGrant against a brute-force reading of the rules', () => {
  it('agrees on decision, grant, ceiling and the keys it returns, seed 11', () => {
    const random = prng(11);

    for (let i = 0; i < CASES; i++) {
      const query = randomQuery(random);
      const grants = Array.from({ length: Math.floor(random() * 6) }, () => randomGrant(random, query));

      // toStrictEqual: `maxDisclosure: undefined` and a missing key are different answers.
      expect(evaluateGrant(query, grants, NOW)).toStrictEqual(bruteForce(query, grants));
    }
  });

  it('gives the same answer whatever order the rows arrive in, seed 12', () => {
    const random = prng(12);

    for (let i = 0; i < CASES; i++) {
      // Distinct ids: with two rows sharing an id the answer names the same grant either way.
      const query = randomQuery(random);
      const grants = Array.from({ length: Math.floor(random() * 6) }, () => randomGrant(random, query)).map(
        (grant, index) => ({ ...grant, id: `019a-${index}` }) as AskGrant,
      );
      const shuffled = [...grants].sort(() => random() - 0.5);
      const decided = evaluateGrant(query, grants, NOW);

      if (decided.decision !== 'deny') {
        expect(evaluateGrant(query, shuffled, NOW)).toStrictEqual(decided);
      } else {
        expect(evaluateGrant(query, shuffled, NOW).decision).toBe('deny');
      }
    }
  });

  /**
   * The model orders strings by Unicode scalar and JavaScript by UTF-16 code unit, so an astral
   * character sorts above U+E000 in the proof and below it at runtime. The proved clause is
   * "a covered ask is not before notBefore", and it holds under the runtime's own `<`.
   */
  it('reads a validity window with JavaScript string order', () => {
    const astral = '\ud83d\ude00';
    const privateUse = '\ue000';

    expect(astral < privateUse).toBe(true);
    expect(astral.codePointAt(0)! > privateUse.codePointAt(0)!).toBe(true);

    const windowed = {
      ...randomGrant(prng(13), { queryType: 'photos', prompt: 'p' }),
      id: 'w',
      mode: 'auto',
      queryType: 'photos',
      dataClass: 'photos',
      revokedAt: null,
      expiresAt: null,
      scope: { notBefore: privateUse },
    } as AskGrant;
    const ask = (from: string): AskQuery => ({
      queryType: 'photos',
      dataClass: 'photos',
      prompt: 'p',
      filters: { from },
    });

    expect(evaluateGrant(ask(astral), [windowed], NOW)).toStrictEqual({ decision: 'review' });
    expect(evaluateGrant(ask('\uffff'), [windowed], NOW).decision).toBe('auto');
  });
});

function randomFacts(random: () => number, index: number, query: QueryFacts): GrantFacts {
  const ceiling = maybe(random, () => pick(random, DISCLOSURE_RUNGS));
  const sometimes = <T>(value: () => T): T | undefined => (random() < 0.2 ? value() : undefined);
  const word = (pool: readonly string[], own: string | null) =>
    random() < 0.5 && own !== null ? own : pick(random, pool);

  return {
    id: pick(random, IDS),
    mode: pick(random, MODES),
    active: random() < 0.8,
    queryType: random() < 0.1 ? null : word(['photos', 'calendar'], query.queryType),
    dataClass: random() < 0.3 ? null : word(['photos', 'medical'], query.dataClass),
    dataClasses: sometimes(() =>
      Array.from({ length: Math.floor(random() * 3) }, () => word(['photos', 'medical'], query.dataClass)),
    ),
    archetypes: sometimes(() => [word(['photos', 'calendar', ''], query.queryType)]),
    notBefore: sometimes(() => pick(random, INSTANTS)),
    notAfter: sometimes(() => pick(random, INSTANTS)),
    delegation: sometimes(() => pick(random, DELEGATIONS.slice(0, 3))),
    purpose: random() < 0.8 ? undefined : random() < 0.3 ? null : word(['research', 'audit'], query.purpose),
    ceiling,
    ceilingRank: ceiling == null ? DISCLOSURE_RUNGS.length : DISCLOSURE_RUNGS.indexOf(ceiling),
    tieBreak: index,
  };
}

function randomQueryFacts(random: () => number): QueryFacts {
  return {
    queryType: random() < 0.15 ? null : pick(random, ['photos', 'calendar']),
    dataClass: random() < 0.35 ? null : pick(random, ['photos', 'medical']),
    from: maybe(random, () => pick(random, INSTANTS)),
    to: maybe(random, () => pick(random, INSTANTS)),
    purpose: random() < 0.5 ? null : pick(random, ['research', 'audit']),
    actor: maybe(random, () => pick(random, ACTORS)),
  };
}

/** The predicates `decideGrant`'s contract names, restated from their own contracts. */
const classFits = (g: GrantFacts, q: QueryFacts) =>
  g.queryType === q.queryType &&
  (g.dataClass === null || g.dataClass === q.dataClass) &&
  (g.dataClasses === undefined || (q.dataClass !== null && g.dataClasses.includes(q.dataClass)));
const blockCovers = (g: GrantFacts, q: QueryFacts) =>
  g.queryType === q.queryType && (q.dataClass === null || classFits(g, q));
const scopeFits = (g: GrantFacts, q: QueryFacts) =>
  (g.archetypes === undefined || g.archetypes.includes(q.queryType ?? '')) &&
  (g.notBefore === undefined || (q.from !== undefined && !(q.from < g.notBefore))) &&
  (g.notAfter === undefined || (q.to !== undefined && !(q.to > g.notAfter))) &&
  (g.delegation === undefined || admits(g.delegation, q.actor)) &&
  (g.purpose === undefined || q.purpose === g.purpose);
const fits = (g: GrantFacts, q: QueryFacts) => classFits(g, q) && scopeFits(g, q);
const namesClass = (g: GrantFacts, q: QueryFacts) =>
  q.dataClass !== null && (g.dataClass !== null || g.dataClasses !== undefined);
/** Whether `g` is the strictest of `others`, and first in id order among the equally strict. */
const strictestAmong = (g: GrantFacts, others: readonly GrantFacts[]) =>
  others.every(
    (o) => g.ceilingRank < o.ceilingRank || (g.ceilingRank === o.ceilingRank && g.tieBreak <= o.tieBreak),
  );

describe('decideGrant: the proved contract, run on the real function', () => {
  it('holds every clause, seed 21', () => {
    const random = prng(21);

    for (let i = 0; i < CASES; i++) {
      const query = randomQueryFacts(random);
      const grants = Array.from({ length: Math.floor(random() * 7) }, (_, index) =>
        randomFacts(random, index, query),
      );
      const result = decideGrant(query, grants);
      const named = (g: GrantFacts) => g.id === result.grantId;

      const covering = grants.filter((g) => g.active && g.mode === 'block' && blockCovers(g, query));
      if (covering.length > 0) {
        expect(result.decision).toBe('deny');
      }

      if (result.decision === 'deny') {
        expect(covering.some(named)).toBe(true);
      }

      if (result.decision === 'auto') {
        const candidates = grants.filter(
          (g) => g.active && g.mode === 'auto' && fits(g, query) && namesClass(g, query),
        );

        expect(
          candidates.some(
            (g) => named(g) && g.ceiling === result.maxDisclosure && strictestAmong(g, candidates),
          ),
        ).toBe(true);
      }

      if (result.decision === 'review' && result.grantId !== undefined) {
        const matching = (mode: GrantMode) =>
          grants.filter((g) => g.active && g.mode === mode && fits(g, query));

        expect(
          grants.some(
            (g) =>
              g.active &&
              (g.mode === 'review' || g.mode === 'auto') &&
              fits(g, query) &&
              named(g) &&
              g.ceiling === result.maxDisclosure &&
              strictestAmong(g, matching(g.mode)) &&
              (g.mode === 'review' || matching('review').length === 0),
          ),
        ).toBe(true);
      }

      if (query.dataClass === null) {
        expect(result.decision).not.toBe('auto');
      }

      if (result.grantId === undefined) {
        expect(result.decision).toBe('review');
      }
    }
  });

  it('never lets a class-less auto grant, or a class-less ask, be auto-answered, seed 22', () => {
    const random = prng(22);

    for (let i = 0; i < CASES; i++) {
      const query = randomQueryFacts(random);
      const grants = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, index) => ({
        ...randomFacts(random, index, query),
        mode: 'auto' as const,
        dataClass: null,
        dataClasses: undefined,
      }));

      expect(decideGrant(query, grants).decision).not.toBe('auto');
    }
  });
});
