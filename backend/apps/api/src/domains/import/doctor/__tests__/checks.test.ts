import { INGEST_REFRESH_COLUMNS } from '@ci/common/persistence';

import { DOCTOR_CHECKS, DOCTOR_CHECK_IDS, findCheck } from '../checks';

/**
 * The registry's own contract.
 *
 * These are cheap assertions about metadata, which is exactly why they earn
 * their place: a check with a duplicate id silently shadows another one in every
 * `--check` filter, a check whose SQL forgets the `count` column reports 0
 * forever, and a check written with a plain quoted string instead of
 * `String.raw` loses its backslashes and quietly widens its own predicate. All
 * three still RUN. None of them would fail a smoke test. So the shape is
 * asserted here, and the predicates themselves are validated where they can only
 * be validated — against a real Postgres, which is what `ci doctor` is.
 */
describe('doctor check registry', () => {
  it('has unique ids', () => {
    expect(new Set(DOCTOR_CHECK_IDS).size).toBe(DOCTOR_CHECKS.length);
  });

  it('gives every check a severity, a title, a scope and a remedy', () => {
    for (const check of DOCTOR_CHECKS) {
      expect(check.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(['high', 'medium']).toContain(check.severity);
      expect(check.title.length).toBeGreaterThan(20);
      expect(check.scope).toMatch(/^ci(_search|_import)?\./);
      // The remedy is the field an agent acts on. A one-word one is worse than
      // useless: it reads as guidance and carries none.
      expect(check.remedy.length).toBeGreaterThan(60);
    }
  });

  it('keeps every check to a single statement returning a count', () => {
    for (const check of DOCTOR_CHECKS) {
      expect(check.sql).toMatch(/AS count/);
      // One statement per check is what makes a slow check survivable — see the
      // file header. A stray semicolon would smuggle in a second one, which
      // TypeORM would run without complaint and whose result would be the one
      // that came back.
      expect(check.sql).not.toContain(';');
    }
  });

  it('did not lose its backslashes to a non-raw string literal', () => {
    // The failure this guards against is invisible at runtime: `'\.'` is `.`,
    // `'\d'` is `d`, and `'\FFFC'` is `FFFC`, so a mis-quoted predicate still
    // compiles, still runs, and just matches the wrong rows. Two specimens, one
    // per shape, are enough to catch a whole file converted by a careless edit.
    expect(findCheck('comms-placeholder-content')?.sql).toContain(String.raw`U&'\FFFC'`);
    expect(findCheck('position-not-a-place-name')?.sql).toContain(String.raw`\.(jpe?g|png|heic`);
  });

  it('content-media-mimetype-mismatch excludes the deliberate watch/listen sentinel, not just NULL', () => {
    // netflix.ts, hulu.ts, disney_plus.ts, youtube.ts and _youtube_activity.ts
    // all write 'application/dash+xml' on purpose for a "you watched this"
    // record that was never downloaded as a file — contentFacetsSql.ts's
    // OTHER_MEDIA_TYPE bucket exists for exactly these rows. On a full Drive
    // corpus import this check found 68,533 of them alongside 14 real
    // mismatches (Amazon ebooks/purchases); without the exclusion the sentinel
    // buries the signal this check exists to surface.
    const sql = findCheck('content-media-mimetype-mismatch')?.sql ?? '';

    expect(sql).toContain("mimetype <> 'application/dash+xml'");
    // The NULL exclusion this one sits beside must still be there too.
    expect(sql).toContain('mimetype IS NOT NULL');
  });

  it('names the guard or migration each mirrored predicate came from', () => {
    // Every check that copies a predicate from elsewhere must say where from,
    // so the two are maintained together. A null is allowed — the pipeline and
    // date checks have no twin — but a path that points at nothing recognizable
    // is a stale reference, which is the failure this catches.
    for (const check of DOCTOR_CHECKS) {
      if (check.mirrors != null) {
        expect(check.mirrors).toMatch(/^(db\/postgres\/migrations\/|src\/domains\/)/);
      }
    }
  });

  it('marks the checks a machine may act on alone as high, and the judgement calls as medium', () => {
    // Pinned because severity IS the gate: promoting one of these to high would
    // start failing an agent's loop on data that is correct, and demoting one
    // would stop the loop noticing a defect that really shipped.
    expect(findCheck('capture-events-without-content')?.severity).toBe('high');
    // chat.db really contains messages Apple never joined to a conversation,
    // so a NULL thread_id can be the honest value and the count never reaches
    // zero on a real iMessage corpus — not machine-actionable, hence medium.
    expect(findCheck('comms-missing-thread-id')?.severity).toBe('medium');
    // A calendar legitimately holds events that have not happened yet.
    expect(findCheck('events-dated-in-future')?.severity).toBe('medium');
    // A phone-shaped name is the honest fallback when the export named nobody.
    expect(findCheck('person-bare-phone-name')?.severity).toBe('medium');
    // HIGH, unlike its neighbour above: a contact card filed as a Concept is not
    // a judgement call. Four parsers have shipped this exact omission, the repair
    // is known, and the predicate reaches zero on a clean corpus — the bar for high.
    expect(findCheck('contact-cards-typed-as-concept')?.severity).toBe('high');
  });

  it('covers every defect class the 2026-08 import audit found', () => {
    // Named individually rather than counted, so deleting a check is a
    // deliberate act with a test to update rather than a number that drifts.
    for (const id of [
      'comms-missing-thread-id',
      'comms-missing-participants',
      'comms-placeholder-content',
      'position-not-a-place-name',
      'person-name-garbage',
      'person-duplicate-names',
      'events-location-without-name',
      'capture-events-without-content',
      'blank-social-affiliation-content',
      'content-media-mimetype-mismatch',
      'pipeline-overdue-retries',
      'pipeline-dead-letters',
      'pipeline-orphan-shards',
      'events-missing-search-vector',
      'communications-missing-search-vector',
      'events-dated-before-1990',
      'events-dated-in-future',
      'events-timestamped-at-import',
    ]) {
      expect(DOCTOR_CHECK_IDS).toContain(id);
    }
  });

  it('carries the cross-pipeline identity acceptance metric as two medium checks', () => {
    // docs/design/cross-pipeline-identity.md §5: after an archive import and a
    // connection sync of one account, records in the overlap window carry two
    // arrivals. Medium on both, because each has an honest non-zero floor
    // (the fallback lane is designed; a mailbox loses mail the archive kept).
    expect(findCheck('identity-fallback-lane-rows')?.severity).toBe('medium');
    expect(findCheck('identity-unconverged-in-overlap')?.severity).toBe('medium');
    expect(findCheck('identity-fallback-lane-rows')?.sql).toContain("LIKE 'fallback:%'");
    expect(findCheck('identity-unconverged-in-overlap')?.sql).toContain('ci.record_sources');
    // Pairs per PLATFORM, and an arrival with no platform pairs with nothing.
    expect(findCheck('identity-unconverged-in-overlap')?.sql).toContain('w.platform = a.platform');
    expect(findCheck('identity-unconverged-in-overlap')?.sql).toContain('rs.platform IS NOT NULL');
    // The overlap check excludes what the fallback check counts, so the two
    // numbers add up rather than double-count.
    expect(findCheck('identity-unconverged-in-overlap')?.sql).toContain("NOT LIKE 'fallback:%'");
  });

  it('promises a re-import heal only for columns a re-ingest actually refreshes', () => {
    // The remedy is the field an agent acts on, and for the communications
    // checks it makes a claim the ingest contract either backs or contradicts.
    // `comms-missing-thread-id` used to say "a re-import heals every
    // recoverable one" while `thread_id` was NOT in
    // INGEST_REFRESH_COLUMNS.communication — so the ON CONFLICT DO UPDATE
    // (CommunicationService.createMany) left the stored NULL exactly as it
    // was, and an operator who followed the advice re-ran a multi-hour import
    // for nothing. `comms-placeholder-content` makes the same promise and is
    // CORRECT, because `content` and `preview` are on the list.
    //
    // Pinned in both directions on purpose: adding thread_id to the refresh set
    // later fails this test too, which is the moment to rewrite the remedy
    // rather than leave two sources of truth disagreeing.
    const columnUnderTest: Record<string, string> = {
      'comms-missing-thread-id': 'thread_id',
      'comms-missing-participants': 'from_entity_id',
      'comms-placeholder-content': 'content',
    };

    for (const [id, column] of Object.entries(columnUnderTest)) {
      const remedy = findCheck(id)?.remedy ?? '';
      // Sentence-bounded, so "a re-import will NOT correct one" in one sentence
      // and "heals" in another cannot read as a promise.
      const promisesHeal = /re-import[^.]*\bheals?\b|\bheals?\b[^.]*re-import/i.test(remedy);

      expect({ id, promisesHeal }).toEqual({
        id,
        promisesHeal: INGEST_REFRESH_COLUMNS.communication.includes(column),
      });
    }
  });

  it('finds a check by id and nothing by a wrong one', () => {
    expect(findCheck('pipeline-dead-letters')?.severity).toBe('high');
    expect(findCheck('comms-null-thread')).toBeUndefined();
  });
});

describe('position-not-a-place-name must not drift from the guard it mirrors', () => {
  /**
   * `isNotAPlaceName` has FOUR arms and its own docstring says so: "an arm added
   * here needs its twin there". #2137 added the fourth (`isTitleText`) and
   * updated NOT_A_PLACE_NAME_SQL in PositionPlacePromoteStage, but not this
   * check — so the standing check reported a clean bill of health for exactly
   * the class that arm exists to reject: an Uber trip sentence, a clipped tweet
   * body.
   *
   * Asserted against the SQL text rather than a live database because the drift
   * is what matters: a check missing an arm is silently, permanently blind, and
   * nothing else in the tree notices.
   */
  /**
   * Comments stripped before asserting. The check SQL is a String.raw template
   * carrying `--` comment lines — this PR added twelve of them directly above
   * the arms below — so a plain substring assertion cannot tell live predicate
   * text from an arm someone commented out. Stripping them means these
   * assertions can only be satisfied by SQL that actually runs.
   */
  const sql = () => (findCheck('position-not-a-place-name')?.sql ?? '').replace(/^\s*--.*$/gm, '');

  it('carries the coordinate, URI, media-filename and UUID arms', () => {
    expect(sql()).toContain(String.raw`\.(jpe?g|png|heic`);
    expect(sql()).toContain('[a-z][a-z0-9+.-]*://');
    expect(sql()).toContain('[0-9a-f]{8}-[0-9a-f]{4}');
    // The coordinate arm — this check's largest population by far (its own
    // remedy cites 64,917 rows, and migration 20260818212254 exists solely for
    // bare coordinate pairs). It was named in this test's title and asserted
    // nowhere: deleting the whole arm left every assertion green. Mirrors
    // PositionPlacePromoteStage.spec.ts, which pins it the same way.
    expect(sql()).toMatch(/waypoint/i);
  });

  it('carries the title arm too — the one that drifted', () => {
    // U+2026: the clip mark, meaning the value is a PREFIX of longer text.
    expect(sql()).toContain('\u2026');
    expect(sql()).toContain('[!?]');
    expect(sql()).toContain('regexp_split_to_array');
  });

  it('bounds place names at the same 14 words the guard does', () => {
    // A different number here is drift wearing the right shape.
    expect(sql()).toMatch(/regexp_split_to_array\([^)]*\)[^>]*>\s*14/);
  });
});

describe('pipeline-orphan-shards must not report the control plane’s intended not_due state', () => {
  /**
   * As first written this check matched EVERY `pending` shard under a finished
   * run and told the operator that "whatever slice of the corpus they covered is
   * simply missing from that stage". That is the state `PipelineControlService`
   * creates on purpose: a leg with candidates that is merely not DUE keeps its
   * shard rather than being marked `done` — saying `done` about it would put a
   * falsehood in the run progress view — and the run is finalised anyway, because
   * `pipeline_runs_active_uniq` allows one unfinished run per user and holding it
   * open until a weekly stage comes round would lock the user out of "reprocess".
   * All twelve rows the check reported on the live appliance were that state, and
   * the remedy it printed — re-run the stage — recovers nothing, because a shard
   * carries a NULL cursor and the work is re-derived from `ci.pipeline_state`.
   *
   * Asserted against the SQL and remedy TEXT for the same reason the
   * `position-not-a-place-name` block above is: the predicate is one line of a
   * statement only a real Postgres can run, and the failure being guarded is that
   * line going missing again — after which the check quietly goes back to
   * reporting a healthy appliance as data loss, and nothing else notices.
   */
  const check = () => findCheck('pipeline-orphan-shards');

  it('excludes runs the control tick finalised as not_due, and does so NULL-safely', () => {
    expect(check()?.sql).toContain(String.raw`r.detail->>'finalizedReason' IS DISTINCT FROM 'not_due'`);
    // `IS DISTINCT FROM`, never `<>`: under `<>` a NULL reason evaluates to NULL,
    // the row is filtered out, and every run finalised before `finalizedReason`
    // existed silently stops being checked at all.
    expect(check()?.sql).not.toMatch(/finalizedReason'\s*(<>|!=)/);
  });

  it('still reports a shard left behind by a run that claimed it was drained', () => {
    // The narrowing is ONE excluded reason, not an allow-list: `drained` and
    // `cancelled` both stay in scope, because a leg that never reported under
    // either of them is precisely the contradiction this check exists for.
    expect(check()?.sql).not.toMatch(/'drained'|'cancelled'/);
    expect(check()?.sql).toContain("s.status IN ('pending', 'running')");
    expect(check()?.sql).toContain('r.finished_at IS NOT NULL');
  });

  it('no longer tells the operator a slice of the corpus is missing', () => {
    const remedy = check()?.remedy ?? '';

    expect(remedy).not.toMatch(/missing from that stage|Re-run the stage/);
    // The remedy is the field an agent acts on, so it has to name where the work
    // actually lives — the ledger, not the shard. Without that sentence the
    // honest predicate still produces the dishonest action.
    expect(remedy).toContain('ci.pipeline_state');
  });
});
