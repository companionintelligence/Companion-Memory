import { canonicalDataClass, canonicalPurpose, canonicalQueryType } from './canonical';
import type { AskGrant } from './entities/AskGrantEntity';
import { DISCLOSURE_RUNGS } from './policy';
import type { AskActor, AskDelegation, AskQuery, DisclosureRung, GrantMode } from './types';

export { canonicalDataClass, canonicalPurpose, canonicalQueryType };

/**
 * Outcome of evaluating an ask against the owner's standing grants.
 *
 * This and {@link GrantEvaluation} are declared here, beside the function that
 * produces them, rather than in types.ts: lsc reads a type from another file
 * only when a verified function takes it as a parameter, and these are only
 * ever returned.
 */
export type GrantDecision = 'auto' | 'review' | 'deny';

/** Result of {@link evaluateGrant}. */
export interface GrantEvaluation {
  decision: GrantDecision;
  /** The grant that decided the outcome, when one matched. */
  grantId?: string;
  /**
   * Ceiling the deciding grant imposes on any answer (its `scope.maxDisclosure`).
   * The caller combines this with the asker's tier ceiling by taking the LESSER
   * of the two, so neither can loosen the other.
   */
  maxDisclosure?: DisclosureRung;
}

/**
 * Pure, per-query consent evaluation — the heart of the ask gate.
 *
 * Given the owner's standing grants for one grantee and the grantee's ask,
 * decide whether the ask is auto-answered, routed to owner review, or denied.
 * The evaluation is **deny-biased and review-by-default**:
 *
 * - a matching `block` grant always wins → `deny`;
 * - else a matching `auto` grant → `auto`;
 * - else a matching `review` grant → `review`;
 * - else (no matching grant) → `review` — owner review is the floor, there is
 *   never implicit open access.
 *
 * `block` taking precedence over `auto` means a narrow block can always override
 * a broad standing pre-authorization (the safe default).
 *
 * A `null` data class — on the GRANT or on the ASK — is read in OPPOSITE
 * directions on the two paths: a wildcard for `block`, never a wildcard for
 * `auto`, because both readings must resolve toward denial. See
 * {@link autoGrantNamesQueryClass}.
 *
 * The decision itself is {@link decideGrant}, which this function feeds: it
 * puts every string the gate compares through its canonicalizer, decides each
 * grant's liveness against `now`, and resolves each ceiling, once and up front.
 * What is left is pure enough for LemmaScript, and `decideGrant` is proved
 * against the rules above (spec/lemmascript/README.md).
 *
 * @param grants MUST already be scoped to (owner = responder, grantee = asker);
 *   this function does not re-check ownership.
 */
export function evaluateGrant(
  query: AskQuery,
  grants: readonly AskGrant[],
  now: Date = new Date(),
): GrantEvaluation {
  const tieBreaks = idOrder(grants);

  return decideGrant(
    factsOfQuery(query),
    grants.map((grant, index) => factsOfGrant(grant, now, tieBreaks[index])),
  );
}

/**
 * The ask as {@link decideGrant} reads it.
 *
 * `queryType`, `dataClass` and `purpose` are canonical: `canonicalQueryType`,
 * `canonicalDataClass` and `canonicalPurpose` of what the asker sent, `null`
 * where that names nothing. `from`, `to` and the purpose are read from
 * `filters` only when they are strings.
 */
export interface QueryFacts {
  queryType: string | null;
  dataClass: string | null;
  from: string | undefined;
  to: string | undefined;
  purpose: string | null;
  actor: AskActor | undefined;
}

/**
 * One standing grant as {@link decideGrant} reads it.
 *
 * - `active` is {@link isGrantActive} at the evaluation instant.
 * - `queryType` and `dataClass` are canonical, `null` where they name nothing.
 * - `dataClasses` and `archetypes` are the scope's lists, canonicalized with
 *   the entries that name nothing dropped. `undefined` means the scope has no
 *   such list, which is different from an empty one.
 * - `notBefore`, `notAfter` and `delegation` are the scope's values, or
 *   `undefined` where the scope leaves them out.
 * - `purpose` is `undefined` when the scope states no purpose, and otherwise
 *   `canonicalPurpose` of the one it states.
 * - `ceiling` is {@link ceilingOf} and `ceilingRank` its {@link ceilingRank}.
 * - `tieBreak` is the grant's position in id order (see {@link idOrder}).
 */
export interface GrantFacts {
  id: string;
  mode: GrantMode;
  active: boolean;
  queryType: string | null;
  dataClass: string | null;
  dataClasses: string[] | undefined;
  archetypes: string[] | undefined;
  notBefore: string | undefined;
  notAfter: string | undefined;
  delegation: AskDelegation | undefined;
  purpose: string | null | undefined;
  ceiling: DisclosureRung | undefined;
  ceilingRank: number;
  tieBreak: number;
}

/**
 * The ask's side of matching, canonicalized.
 *
 * BOTH SIDES, THROUGH THE SAME NORMALIZER. `grantMatch` once compared the two
 * `queryType` strings RAW while `dataClass` beside them went through
 * `canonicalDataClass` — so a block pinned to `photos` denied `photos` and let
 * `Photos`, `PHOTOS` and `'photos '` past, into review, where a broad `auto`
 * grant or a tired tap answers them. canonical.ts already carried the warning
 * that any normalization here must be mirrored by every consumer; it was never
 * applied to the field beside the one it was written for. Building both sides
 * here, with the same three canonicalizers, is what keeps them mirrored.
 */
function factsOfQuery(query: AskQuery): QueryFacts {
  // `canonicalPurpose`, not `canonicalDataClass`. Same normalizer today,
  // different contract — a data class is a token from a closed vocabulary and
  // may one day be aliased or singularized; a purpose is a human phrase and
  // must not be.
  const asked = typeof query.filters?.purpose === 'string' ? query.filters.purpose : undefined;

  return {
    queryType: canonicalQueryType(query.queryType),
    dataClass: canonicalDataClass(query.dataClass),
    from: typeof query.filters?.from === 'string' ? query.filters.from : undefined,
    to: typeof query.filters?.to === 'string' ? query.filters.to : undefined,
    purpose: canonicalPurpose(asked),
    actor: query.actor ?? undefined,
  };
}

/** The grant's side of matching. See {@link GrantFacts} for what each field holds. */
function factsOfGrant(grant: AskGrant, now: Date, tieBreak: number): GrantFacts {
  const scope = grant.scope;
  const ceiling = ceilingOf(grant);

  return {
    id: grant.id,
    mode: grant.mode,
    active: isGrantActive(grant, now),
    queryType: canonicalQueryType(grant.queryType),
    dataClass: canonicalDataClass(grant.dataClass),
    // The two lists are getters, so each is canonicalized only when the matcher
    // reads it, at the point it always was. A jsonb value there that is not an
    // array still throws where it did, and no sooner.
    //
    // An empty list means "no classes permitted" and matches nothing; an
    // unscoped grant omits the key and leaves this `undefined`.
    get dataClasses() {
      const scopedClasses = scope?.dataClasses;

      return scopedClasses == null
        ? undefined
        : scopedClasses.map(canonicalDataClass).filter((c): c is string => c != null);
    },
    // The ask's queryType IS its archetype, so the archetype scope goes through
    // the queryType normalizer rather than a hand-rolled `trim().toLowerCase()`
    // — a third spelling of "canonical" in this file is a third place for the
    // two sides to drift apart.
    get archetypes() {
      return scope?.archetypes == null
        ? undefined
        : scope.archetypes.map((a) => canonicalQueryType(a)).filter((a): a is string => a != null);
    },
    notBefore: scope?.notBefore ?? undefined,
    notAfter: scope?.notAfter ?? undefined,
    delegation: scope?.delegation ?? undefined,
    purpose: scope?.purpose == null ? undefined : canonicalPurpose(scope.purpose),
    ceiling,
    ceilingRank: ceilingRank(ceiling),
    tieBreak,
  };
}

/**
 * Each grant's position when the grants are sorted by id, for the tie-break in
 * {@link strictestOf}.
 *
 * `localeCompare` is out of reach of the proof, so the order is fixed here and
 * handed to {@link decideGrant} as a number. The sort is stable, so two ids
 * that compare equal keep the order they arrived in. That is the outcome
 * `[...grants].sort(...)` gave when the comparison lived in `strictestOf`.
 */
function idOrder(grants: readonly AskGrant[]): number[] {
  const order = grants.map((_, index) => index).sort((a, b) => grants[a].id.localeCompare(grants[b].id));
  const positions: number[] = [];
  order.forEach((index, position) => {
    positions[index] = position;
  });

  return positions;
}

/**
 * The decision {@link evaluateGrant} returns, from facts it has already
 * canonicalized. Pure, and proved with LemmaScript: the `//@` lines below are
 * the contract, `grantMatch.dfy` is the proof.
 *
 * In words: a covering active `block` always decides, and decides `deny`; an
 * `auto` decision names an active `auto` grant that covers the ask on every
 * field and names the ask's class, and no other such grant is stricter; an ask
 * that names no data class is never auto-answered; and anything else is owner
 * review.
 */
export function decideGrant(query: QueryFacts, grants: readonly GrantFacts[]): GrantEvaluation {
  //@ verify
  //@ ensures forall(g: GrantFacts, grants.includes(g) && g.active && g.mode === 'block' && blockCoversQuery(g, query) ==> \result.decision === 'deny')
  //@ ensures \result.decision === 'deny' ==> exists(g: GrantFacts, grants.includes(g) && g.active && g.mode === 'block' && blockCoversQuery(g, query) && \result.grantId === g.id)
  //@ ensures \result.decision === 'auto' ==> exists(g: GrantFacts, grants.includes(g) && g.active && g.mode === 'auto' && grantMatchesQuery(g, query) && autoGrantNamesQueryClass(g, query) && \result.grantId === g.id && \result.maxDisclosure === g.ceiling && forall(o: GrantFacts, grants.includes(o) && o.active && o.mode === 'auto' && grantMatchesQuery(o, query) && autoGrantNamesQueryClass(o, query) ==> g.ceilingRank <= o.ceilingRank))
  //@ ensures \result.decision === 'review' && \result.grantId !== undefined ==> exists(g: GrantFacts, grants.includes(g) && g.active && g.mode !== 'block' && grantMatchesQuery(g, query) && \result.grantId === g.id && \result.maxDisclosure === g.ceiling)
  //@ ensures query.dataClass === null ==> \result.decision !== 'auto'
  //@ ensures \result.grantId === undefined ==> \result.decision === 'review'
  const active = grants.filter((grant) => grant.active);

  // Blocks are evaluated CONSERVATIVELY (see blockCoversQuery): an ask that
  // omits its data class cannot be proven to fall outside a class-scoped block,
  // so it is treated as covered. This closes the bypass where an asker evades a
  // narrow block by simply not naming the class it targets, then rides a broad
  // `auto` grant. A matching block always wins → deny.
  const block = active.find((grant) => grant.mode === 'block' && blockCoversQuery(grant, query));
  if (block) {
    return { decision: 'deny', grantId: block.id };
  }

  // Positive grants (auto / review) match strictly on the declared class.
  const matches = active.filter((grant) => grant.mode !== 'block' && grantMatchesQuery(grant, query));

  // An `auto` grant must additionally NAME the class it pre-authorizes
  // (see autoGrantNamesQueryClass) — a class-less auto grant is not a wildcard.
  const auto = strictestOf(
    matches.filter((grant) => grant.mode === 'auto' && autoGrantNamesQueryClass(grant, query)),
  );
  if (auto) {
    return { decision: 'auto', grantId: auto.id, maxDisclosure: auto.ceiling };
  }

  // An explicit `review` grant is preferred as the basis; failing that, an
  // `auto` grant that matched but was too broad to auto-answer is DOWNGRADED to
  // review rather than dropped. The owner said something about this asker and
  // this query type, so the ask belongs in their inbox with that grant named —
  // the only thing withheld is the automatic answer.
  const review =
    strictestOf(matches.filter((grant) => grant.mode === 'review')) ??
    strictestOf(matches.filter((grant) => grant.mode === 'auto'));
  if (review) {
    return { decision: 'review', grantId: review.id, maxDisclosure: review.ceiling };
  }

  return { decision: 'review' };
}

/**
 * The grant that decides, when SEVERAL of the owner's grants cover the same ask.
 *
 * Nothing stops an owner from holding two live grants that both match — the
 * Grant Manager writes a row per (grantee, queryType) posture and `supersede`
 * only closes out the one row it was pointed at, so an owner who wrote "auto,
 * summary only" and later "auto" (no ceiling) for the same asker has both
 * standing. This used to be `matches.find(...)`, i.e. whichever row Postgres
 * happened to return first: `GrantService.evaluate` issues an unordered
 * `SELECT`, so the ceiling on the answer was decided by heap order, and the
 * SAME ask could be capped at `summary` before a VACUUM and disclosed in full
 * after it.
 *
 * Two properties, in this order:
 *
 * 1. STRICTEST WINS. A ceiling is a restriction the owner wrote down; when two
 *    of them apply, honouring the looser one discards an instruction. This is
 *    the same rule `narrowestRung` enforces when combining a grant ceiling with
 *    a tier ceiling — a source that says less must never erase one that says
 *    more. A grant declaring NO ceiling sorts last (it restricts nothing), so
 *    it can only ever be chosen when no matching grant declares one.
 * 2. TIE-BROKEN BY ID, so the outcome is a function of the grants alone. Grant
 *    ids are uuidv7, so this resolves to the OLDEST matching grant at equal
 *    strictness — stable across re-evaluations of the same ask, which is what
 *    makes `consentBasis` reproducible in the audit. The id order arrives as
 *    `tieBreak`, fixed by {@link idOrder} before the facts are built.
 *
 * Note that the returned grant's own `ceiling` IS the narrowest across the
 * whole set, precisely because that is what it was chosen on — the caller does
 * not need to fold the ceilings separately.
 */
function strictestOf(grants: readonly GrantFacts[]): GrantFacts | undefined {
  //@ verify
  //@ ensures grants.length === 0 <==> \result === undefined
  //@ ensures \result !== undefined ==> grants.includes(\result)
  //@ ensures \result !== undefined ==> forall(g: GrantFacts, grants.includes(g) ==> \result.ceilingRank <= g.ceilingRank)
  //@ ensures \result !== undefined ==> forall(g: GrantFacts, grants.includes(g) && g.ceilingRank === \result.ceilingRank ==> \result.tieBreak <= g.tieBreak)
  let strictest: GrantFacts | undefined = undefined;
  for (const grant of grants) {
    //@ invariant (strictest === undefined) === (_grant_idx === 0)
    //@ invariant strictest !== undefined ==> exists(k: nat, k < _grant_idx && grants[k] === strictest)
    //@ invariant strictest !== undefined ==> forall(k: nat, k < _grant_idx ==> strictest.ceilingRank <= grants[k].ceilingRank)
    //@ invariant strictest !== undefined ==> forall(k: nat, k < _grant_idx && grants[k].ceilingRank === strictest.ceilingRank ==> strictest.tieBreak <= grants[k].tieBreak)
    if (
      strictest === undefined ||
      grant.ceilingRank < strictest.ceilingRank ||
      (grant.ceilingRank === strictest.ceilingRank && grant.tieBreak < strictest.tieBreak)
    ) {
      strictest = grant;
    }
  }

  return strictest;
}

/**
 * Sort key for a ceiling: its position on the disclosure ladder, with "declares
 * no ceiling" placed ABOVE `full`. Absent is not `full` — `full` is a decision
 * the owner made and absent is the lack of one — but for ORDERING they rank the
 * same way round, and keeping them distinct here is what stops an uncapped grant
 * from displacing a capped one at equal rung.
 */
function ceilingRank(rung: DisclosureRung | undefined): number {
  return rung == null ? DISCLOSURE_RUNGS.length : DISCLOSURE_RUNGS.indexOf(rung);
}

/**
 * The grant's own disclosure ceiling, if it declares one.
 *
 * AN UNREADABLE CEILING IS THE STRICTEST ONE, NOT THE ABSENCE OF ONE. `scope`
 * is jsonb, so `maxDisclosure` can hold anything a client or a migration ever
 * wrote there. This used to validate against the rung list and return
 * `undefined` on a miss — which discards the field BEFORE `minRung` can fail
 * closed on it, so a grant reading `maxDisclosure: 'summry'` disclosed MORE
 * than the identical grant reading `'summary'`. A typo in the owner's own
 * restriction must not be the loosest reading of it.
 *
 * The value is canonicalized first (same normalizer as `dataClass`), so a
 * `'Full'` or a `'count '` still resolves to the rung the owner meant; only a
 * value that names no rung at all falls through to `none`. Note the direction:
 * canonicalizing here can only ever RECOVER an owner's intent, because the
 * fallback beneath it is already the tightest rung on the ladder.
 */
function ceilingOf(grant: AskGrant): DisclosureRung | undefined {
  const declared = grant.scope?.maxDisclosure;

  // Absent is genuinely "this grant imposes no ceiling of its own" — only the
  // tier ceiling applies. That is different from present-but-unreadable.
  if (declared == null) {
    return undefined;
  }

  // No `typeof declared === 'string'` guard: `canonicalDataClass` is total over
  // `unknown` and answers `null` for anything that is not a string, which lands
  // on the same fail-closed `none` below.
  const canonical = canonicalDataClass(declared);

  return canonical != null && (DISCLOSURE_RUNGS as readonly string[]).includes(canonical)
    ? (canonical as DisclosureRung)
    : 'none';
}

/**
 * Whether a grant is in force right now.
 *
 * Two INDEPENDENT lifecycle facts, deliberately not merged into one column:
 *
 * - `revokedAt` records an EVENT — "the owner withdrew this at time T". It is
 *   never a schedule. Any non-null value means revoked, full stop, including a
 *   value in the future (clock skew, a replicated row, a hand-written fixture).
 *   This used to read `revokedAt == null || revokedAt > now`, i.e. a future
 *   `revokedAt` counted as still-active — a "scheduled expiry" branch that could
 *   never fire, because `GrantService` only ever stamps `now()`, and that
 *   actively misled anyone who tried to use it: writing a future date there
 *   revoked the grant on the spot as far as every SQL read path was concerned
 *   (`WHERE revoked_at IS NULL`) while this predicate said the opposite. Two
 *   readers of the same column disagreeing about whether consent stands is not
 *   a feature worth keeping.
 * - `expiresAt` is that schedule, as its own column. "I revoked this" and "this
 *   lapsed on its own" are different events and the audit must tell them apart.
 *
 * Exported because the SQL read paths (`GrantService`) can filter `revoked_at`
 * but must apply the same expiry rule in-process, and a second, subtly
 * different copy of this predicate is exactly how a revoked grant keeps
 * answering.
 */
export function isGrantActive(grant: AskGrant, now: Date = new Date()): boolean {
  if (grant.revokedAt != null) {
    return false;
  }

  return grant.expiresAt == null || grant.expiresAt > now;
}

/**
 * Whether a positive (auto/review) grant covers a query. Strict on class: a
 * grant pinned to (or scoped to a set of) data classes only covers asks whose
 * declared class is that class / in that set.
 */
function grantMatchesQuery(grant: GrantFacts, query: QueryFacts): boolean {
  //@ verify
  //@ ensures \result <==> classMatchesQuery(grant, query) && scopeCoversQuery(grant, query)
  return classMatchesQuery(grant, query) && scopeCoversQuery(grant, query);
}

/**
 * SECURITY ASYMMETRY — an `auto` grant must NAME the data class it
 * pre-authorizes. Read this before "simplifying" the two null cases into one.
 *
 * `data_class` is nullable, and a null means different things on the two paths
 * on purpose. Both nulls resolve toward DENIAL, which is why they point in
 * opposite directions:
 *
 * - BLOCK (deny broadly = safe): a null is a WILDCARD. A block on the query type
 *   covers every class, and {@link blockCoversQuery} additionally treats an ask
 *   that omits its class as covered — an asker must not escape a block by
 *   declining to name what they are after.
 * - AUTO (allow broadly = UNSAFE): a null is NOT a wildcard. A grant that names
 *   no class pre-authorizes only asks that name no class either. It never
 *   silently extends to a class the owner never considered.
 *
 * The bug this closes: an `auto` grant on query type `photos` with a null
 * `data_class` auto-answered an ask declaring `dataClass: 'medical-records'` —
 * the owner pre-authorized holiday snaps and the asker collected medical
 * records, with no owner review, because null read as "any class". PR #2042
 * hardened the block path against class omission; the auto path kept the
 * wildcard.
 *
 * ═══ THE OTHER HALF: THE ASK MUST NAME ONE TOO ═══
 *
 * The clause above closed the grant-side wildcard and left the ASK-side one
 * open, and that is the same bypass read from the other end. `dataClass` on an
 * ask is OPTIONAL and asker-supplied, so "the owner pre-authorized only what
 * they named" was enforced against a label the asker chooses whether to write.
 * The original rule ended `|| canonicalDataClass(query.dataClass) == null`,
 * i.e. an ask that named no class was covered by a class-less `auto` grant —
 * so an asker after a class the grant never named simply OMITTED the field and
 * was auto-answered anyway.
 *
 * Omitting it is not a narrowing. It is the BROADEST an ask can be:
 * `AskExecutorService` turns a null class into `includeTypes: undefined`, an
 * unfiltered search across every indexed entity type in the owner's memory.
 * (The one class it reads off the prompt, a standalone "photos" or "videos",
 * only narrows that search; it is never a class the gate saw, so it widens
 * nothing here.) A class-less auto grant plus a class-less
 * ask is therefore a standing, unreviewed keyword oracle over the whole corpus,
 * answered from the asker's own prompt.
 *
 * So both sides must name a class, and this is deliberately the MIRROR IMAGE of
 * {@link blockCoversQuery}: there, an ask that omits its class is treated as
 * COVERED by the block ("an asker must not escape a block by declining to name
 * what they are after"); here, it is treated as NOT covered by the auto grant.
 * Both readings resolve toward denial, which is the invariant that decides every
 * null in this file.
 *
 * WHAT THIS COSTS, STATED PLAINLY: an archetype that carries no data class —
 * `relationship` is the one that matters; `availability` already arrives as
 * `calendar` from `toAskQuery` — can no longer be auto-answered by a standing
 * grant. It is DOWNGRADED to review, not denied (see the caller): the owner
 * still sees it, with the grant named, and answers in one tap. Review is the
 * documented floor of this gate, and an unconfined oracle is exactly the shape
 * of ask that should land in front of a human.
 *
 * A grant that pins `data_class`, or enumerates `scope.dataClasses`, has already
 * been narrowed to that class by {@link classMatchesQuery} and needs nothing
 * further here.
 */
function autoGrantNamesQueryClass(grant: GrantFacts, query: QueryFacts): boolean {
  //@ verify
  //@ ensures query.dataClass === null ==> !\result
  //@ ensures grant.dataClass === null && grant.dataClasses === undefined ==> !\result
  //@ ensures query.dataClass !== null && (grant.dataClass !== null || grant.dataClasses !== undefined) ==> \result
  if (query.dataClass == null) {
    return false;
  }

  return grant.dataClass != null || grant.dataClasses !== undefined;
}

/**
 * The queryType + data-class half of matching, shared by positive and block
 * grants.
 *
 * Deliberately excludes the narrowing dimensions in {@link scopeCoversQuery}:
 * a block must stay broad (see {@link blockCoversQuery}).
 */
function classMatchesQuery(grant: GrantFacts, query: QueryFacts): boolean {
  //@ verify
  //@ ensures \result ==> grant.queryType === query.queryType
  //@ ensures \result && grant.dataClass !== null ==> grant.dataClass === query.dataClass
  //@ ensures \result && grant.dataClasses !== undefined ==> query.dataClass !== null && grant.dataClasses.includes(query.dataClass)
  //@ ensures grant.queryType === query.queryType && (grant.dataClass === null || grant.dataClass === query.dataClass) && (grant.dataClasses === undefined || (query.dataClass !== null && grant.dataClasses.includes(query.dataClass))) ==> \result
  //
  // Both sides arrive canonicalized; see `factsOfQuery` for why that matters.
  if (grant.queryType !== query.queryType) {
    return false;
  }

  // A grant that pins a specific data_class only covers asks in that class.
  if (grant.dataClass != null && grant.dataClass !== query.dataClass) {
    return false;
  }

  // A grant whose scope enumerates data classes requires membership. An empty
  // list means "no classes permitted" — it matches nothing (an unscoped grant
  // omits the `dataClasses` key entirely, leaving `dataClasses` undefined).
  if (grant.dataClasses !== undefined) {
    if (query.dataClass == null || !grant.dataClasses.includes(query.dataClass)) {
      return false;
    }
  }

  return true;
}

/**
 * The remaining grant-vocabulary dimensions (archetype, validity window,
 * purpose). Each only ever NARROWS: an absent field imposes no restriction, and
 * a present one that fails to match drops the grant out of consideration.
 *
 * These are checked for POSITIVE grants only — a `block` must never be narrowed
 * by its own scope, or an asker could evade it by falling just outside the
 * window (see {@link blockCoversQuery}).
 */
function scopeCoversQuery(grant: GrantFacts, query: QueryFacts): boolean {
  //@ verify
  //@ ensures \result && grant.archetypes !== undefined && query.queryType !== null ==> grant.archetypes.includes(query.queryType)
  //@ ensures \result && grant.archetypes !== undefined && query.queryType === null ==> grant.archetypes.includes('')
  //@ ensures \result && grant.notBefore !== undefined ==> query.from !== undefined && !(query.from < grant.notBefore)
  //@ ensures \result && grant.notAfter !== undefined ==> query.to !== undefined && !(query.to > grant.notAfter)
  //@ ensures \result && grant.delegation !== undefined ==> actorSatisfiesDelegation(query.actor, grant.delegation)
  //@ ensures \result && grant.purpose !== undefined ==> query.purpose === grant.purpose
  //@ ensures grant.archetypes === undefined && grant.notBefore === undefined && grant.notAfter === undefined && grant.delegation === undefined && grant.purpose === undefined ==> \result
  //
  // Archetype restriction: the ask's queryType IS its archetype, and both
  // arrive through the queryType normalizer (see `factsOfGrant`).
  if (grant.archetypes !== undefined) {
    if (!grant.archetypes.includes(query.queryType ?? '')) {
      return false;
    }
  }

  // Validity window, evaluated against the ask's own window when it declares
  // one. An ask with no window can't be proven inside a bounded grant, so a
  // windowed grant does not cover it.
  if (grant.notBefore !== undefined) {
    if (query.from === undefined || query.from < grant.notBefore) {
      return false;
    }
  }

  if (grant.notAfter !== undefined) {
    if (query.to === undefined || query.to > grant.notAfter) {
      return false;
    }
  }

  // ═══ DELEGATION: WHO MAY EXERCISE THIS GRANT ═══
  //
  // An ask that does NOT say who is acting cannot satisfy a grant that
  // restricts it. That is the same rule `autoGrantNamesQueryClass` applies to
  // the data class, and for the same reason: the field is optional and
  // asker-supplied, so "the owner restricted this to Bob himself" must not be
  // enforced against a label Bob chooses whether to write.
  //
  // Omitting it is not a narrowing — it is the broadest an ask can be. So an
  // undeclared actor drops the grant out of consideration, which DOWNGRADES the
  // ask to owner review rather than denying it (see the caller). The owner then
  // sees it, with the grant named, and answers in one tap.
  if (grant.delegation !== undefined) {
    if (!actorSatisfiesDelegation(query.actor, grant.delegation)) {
      return false;
    }
  }

  // Purpose binding: a purpose-limited grant requires the ask to state that
  // same purpose.
  //
  // A grant that names a purpose and an ask that states none does NOT match:
  // the ask's canonical purpose is null and the grant's is not, so this fails
  // and the ask is downgraded to review. Same shape as every other "the ask
  // must name it too" rule in this file.
  if (grant.purpose !== undefined) {
    if (query.purpose !== grant.purpose) {
      return false;
    }
  }

  return true;
}

/**
 * Whether a `block` grant covers a query. Same as {@link grantMatchesQuery} for
 * a concrete class, but deny-biased for under-specified asks: a block on the
 * queryType covers an ask that omits its data class, so a scoped block cannot be
 * evaded by omission.
 */
function blockCoversQuery(grant: GrantFacts, query: QueryFacts): boolean {
  //@ verify
  //@ ensures \result ==> grant.queryType === query.queryType
  //@ ensures grant.queryType === query.queryType && query.dataClass === null ==> \result
  //@ ensures grant.queryType === query.queryType && grant.dataClass === null && grant.dataClasses === undefined ==> \result
  //@ ensures \result <==> grant.queryType === query.queryType && (query.dataClass === null || classMatchesQuery(grant, query))
  //
  // Canonical on both sides, as in `classMatchesQuery`. This is the other
  // queryType comparison, and the one that actually decides a `deny`.
  if (grant.queryType !== query.queryType) {
    return false;
  }

  if (query.dataClass == null) {
    return true;
  }

  // Note: `classMatchesQuery`, NOT `grantMatchesQuery` — a block is never
  // narrowed by its own window/purpose/archetype scope. Applying those here
  // would let an asker slip past a block by falling just outside its validity
  // window or by omitting the purpose it names.
  return classMatchesQuery(grant, query);
}

/**
 * Whether the declared actor is one this delegation setting admits.
 *
 * Matches on KIND alone. `AskActor.label` is a name the asker writes, and a
 * name is not a commitment — admitting an agent because it called itself
 * something reassuring would make the restriction decorative.
 *
 * An UNDECLARED actor satisfies nothing. Pure.
 */
function actorSatisfiesDelegation(actor: AskActor | undefined, delegation: AskDelegation): boolean {
  //@ verify
  //@ ensures actor === undefined ==> !\result
  //@ ensures \result && delegation === 'none' ==> actor !== undefined && actor.kind === 'person'
  //@ ensures \result && delegation === 'first-party-only' ==> actor !== undefined && actor.kind !== 'third-party-agent'
  //
  // An `if` chain, not a `switch`: lsc 0.6.14 writes a `case 'none':` label as
  // the Option constructor `None`, which Dafny then reads as a catch-all.
  if (actor == null) {
    return false;
  }

  if (delegation === 'none') {
    return actor.kind === 'person';
  }

  if (delegation === 'first-party-only') {
    return actor.kind === 'person' || actor.kind === 'first-party-agent';
  }

  if (delegation === 'any-agent') {
    // Every kind, including one this build does not recognize — `any-agent`
    // is the owner declining to restrict on this dimension at all, and a
    // future kind must not be narrower than the setting that admits all.
    return true;
  }

  // An unreadable delegation setting is the STRICTEST reading, not the
  // absence of one — `ceilingOf`'s rule. `scope` is jsonb and can hold
  // anything a client or a migration ever wrote there.
  return false;
}
