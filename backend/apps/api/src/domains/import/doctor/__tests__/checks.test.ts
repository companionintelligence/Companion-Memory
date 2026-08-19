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
 * be validated — against a real Postgres, which is what `ci-import doctor` is.
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

  it('finds a check by id and nothing by a wrong one', () => {
    expect(findCheck('pipeline-dead-letters')?.severity).toBe('high');
    expect(findCheck('comms-null-thread')).toBeUndefined();
  });
});
