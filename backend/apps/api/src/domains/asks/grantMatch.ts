import { canonicalDataClass, canonicalPurpose, canonicalQueryType } from './canonical';
import type { AskGrant } from './entities/AskGrantEntity';
import { DISCLOSURE_RUNGS } from './policy';
import type { AskActor, AskGrantScope, AskQuery, DisclosureRung, GrantEvaluation } from './types';

export { canonicalDataClass, canonicalPurpose, canonicalQueryType };

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
 * @param grants MUST already be scoped to (owner = responder, grantee = asker);
 *   this function does not re-check ownership.
 */
export function evaluateGrant(
  query: AskQuery,
  grants: readonly AskGrant[],
  now: Date = new Date(),
): GrantEvaluation {
  const active = grants.filter((grant) => isGrantActive(grant, now));

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
    return { decision: 'auto', grantId: auto.id, maxDisclosure: ceilingOf(auto) };
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
    return { decision: 'review', grantId: review.id, maxDisclosure: ceilingOf(review) };
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
 *    makes `consentBasis` reproducible in the audit.
 *
 * Note that the returned grant's own `ceilingOf` IS the narrowest across the
 * whole set, precisely because that is what it was sorted on — the caller does
 * not need to fold the ceilings separately.
 */
function strictestOf(grants: readonly AskGrant[]): AskGrant | undefined {
  if (grants.length <= 1) {
    return grants[0];
  }

  return [...grants].sort((a, b) => {
    const byCeiling = ceilingRank(ceilingOf(a)) - ceilingRank(ceilingOf(b));

    return byCeiling !== 0 ? byCeiling : a.id.localeCompare(b.id);
  })[0];
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
function grantMatchesQuery(grant: AskGrant, query: AskQuery): boolean {
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
 * Omitting it is not a narrowing. It is the BROADEST an ask can be: nothing
 * downstream re-derives the class, and `AskExecutorService` turns a null class
 * into `includeTypes: undefined` — an unfiltered search across every indexed
 * entity type in the owner's memory. A class-less auto grant plus a class-less
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
function autoGrantNamesQueryClass(grant: AskGrant, query: AskQuery): boolean {
  if (canonicalDataClass(query.dataClass) == null) {
    return false;
  }

  return canonicalDataClass(grant.dataClass) != null || grant.scope?.dataClasses != null;
}

/**
 * The queryType + data-class half of matching, shared by positive and block
 * grants.
 *
 * Deliberately excludes the narrowing dimensions in {@link scopeCoversQuery}:
 * a block must stay broad (see {@link blockCoversQuery}).
 */
function classMatchesQuery(grant: AskGrant, query: AskQuery): boolean {
  // BOTH SIDES, THROUGH THE SAME NORMALIZER. This compared the two `queryType`
  // strings RAW while `dataClass` two lines down went through
  // `canonicalDataClass` — so a block pinned to `photos` denied `photos` and
  // let `Photos`, `PHOTOS` and `'photos '` past, into review, where a broad
  // `auto` grant or a tired tap answers them. canonical.ts already carried the
  // warning that any normalization here must be mirrored by every consumer; it
  // was never applied to the field beside the one it was written for.
  if (canonicalQueryType(grant.queryType) !== canonicalQueryType(query.queryType)) {
    return false;
  }

  const queryClass = canonicalDataClass(query.dataClass);
  const grantClass = canonicalDataClass(grant.dataClass);

  // A grant that pins a specific data_class only covers asks in that class.
  if (grantClass != null && grantClass !== queryClass) {
    return false;
  }

  // A grant whose scope enumerates data classes requires membership. An empty
  // list means "no classes permitted" — it matches nothing (an unscoped grant
  // omits the `dataClasses` key entirely, leaving `scopedClasses` undefined).
  const scopedClasses = grant.scope?.dataClasses;
  if (scopedClasses != null) {
    const allowed = scopedClasses.map(canonicalDataClass).filter((c): c is string => c != null);
    if (queryClass == null || !allowed.includes(queryClass)) {
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
function scopeCoversQuery(grant: AskGrant, query: AskQuery): boolean {
  const scope = grant.scope;
  if (scope == null) {
    return true;
  }

  // Archetype restriction: the ask's queryType IS its archetype, so it is
  // canonicalized by the queryType normalizer rather than by a hand-rolled
  // `trim().toLowerCase()` — a third spelling of "canonical" in this file is a
  // third place for the two sides to drift apart.
  if (scope.archetypes != null) {
    const allowed = scope.archetypes.map((a) => canonicalQueryType(a)).filter((a): a is string => a != null);
    if (!allowed.includes(canonicalQueryType(query.queryType) ?? '')) {
      return false;
    }
  }

  // Validity window, evaluated against the ask's own window when it declares
  // one. An ask with no window can't be proven inside a bounded grant, so a
  // windowed grant does not cover it.
  const askFrom = typeof query.filters?.from === 'string' ? query.filters.from : undefined;
  const askTo = typeof query.filters?.to === 'string' ? query.filters.to : undefined;

  if (scope.notBefore != null) {
    if (askFrom == null || askFrom < scope.notBefore) {
      return false;
    }
  }

  if (scope.notAfter != null) {
    if (askTo == null || askTo > scope.notAfter) {
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
  if (scope.delegation != null) {
    if (!actorSatisfiesDelegation(query.actor, scope.delegation)) {
      return false;
    }
  }

  // Purpose binding: a purpose-limited grant requires the ask to state that
  // same purpose.
  if (scope.purpose != null) {
    const asked = typeof query.filters?.purpose === 'string' ? query.filters.purpose : undefined;
    // `canonicalPurpose`, not `canonicalDataClass`. Same normalizer today,
    // different contract — a data class is a token from a closed vocabulary and
    // may one day be aliased or singularized; a purpose is a human phrase and
    // must not be.
    //
    // A grant that names a purpose and an ask that states none does NOT match:
    // `canonicalPurpose(undefined)` is null and the grant's is not, so this
    // fails and the ask is downgraded to review. Same shape as every other
    // "the ask must name it too" rule in this file.
    if (canonicalPurpose(asked) !== canonicalPurpose(scope.purpose)) {
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
function blockCoversQuery(grant: AskGrant, query: AskQuery): boolean {
  // Same normalizer as `classMatchesQuery` — this is the OTHER raw comparison,
  // and the one that actually decided a `deny`.
  if (canonicalQueryType(grant.queryType) !== canonicalQueryType(query.queryType)) {
    return false;
  }

  if (canonicalDataClass(query.dataClass) == null) {
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
function actorSatisfiesDelegation(
  actor: AskActor | undefined,
  delegation: NonNullable<AskGrantScope['delegation']>,
): boolean {
  if (actor == null) {
    return false;
  }

  switch (delegation) {
    case 'none':
      return actor.kind === 'person';
    case 'first-party-only':
      return actor.kind === 'person' || actor.kind === 'first-party-agent';
    case 'any-agent':
      // Every kind, including one this build does not recognize — `any-agent`
      // is the owner declining to restrict on this dimension at all, and a
      // future kind must not be narrower than the setting that admits all.
      return true;
    default:
      // An unreadable delegation setting is the STRICTEST reading, not the
      // absence of one — `ceilingOf`'s rule. `scope` is jsonb and can hold
      // anything a client or a migration ever wrote there.
      return false;
  }
}
