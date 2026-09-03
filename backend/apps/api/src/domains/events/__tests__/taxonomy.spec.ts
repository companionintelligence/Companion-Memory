import { DEAD_LETTER_QUEUE } from '../constants';
import {
  categoryOfEvent,
  categoryOfJob,
  describeJob,
  jobCategoryIndex,
  jobCategorySelector,
  JOB_CATEGORIES,
  JOB_TYPES,
  JOB_TYPES_BY_QUEUE,
  SMART_ROTATION_WORK,
  SMART_ROTATION_WORK_LABELS,
  UNCLASSIFIED_CATEGORY,
} from '../taxonomy';

/**
 * The taxonomy is the layer that makes the dashboard legible: without it, the
 * memory system reads as an undifferentiated wall of `file.uploaded` and
 * `smart.rotation.work`. Its failure mode is silent — an event that loses its
 * entry still renders, just uselessly — so the contract is pinned here.
 */
describe('job taxonomy', () => {
  it('describes the highest-volume events on a real appliance', () => {
    // Measured from pgboss.job + pgboss.archive: these five are ~99% of all
    // jobs ever run on the box this was written against.
    for (const event of [
      'file.uploaded',
      'preview.generated',
      'infer.question.answer',
      'file.updated',
      'smart.rotation.work',
    ]) {
      const descriptor = describeJob(event);

      expect(descriptor.label).not.toBe('Unclassified job');
      expect(descriptor.description.length).toBeGreaterThan(20);
    }
  });

  it('names the activity behind a rotation job rather than the event', () => {
    const generic = describeJob('smart.rotation.work');
    const specific = describeJob('smart.rotation.work', 'graph_enrich');

    // One event covers ten unrelated activities. Showing the event name is the
    // same as showing nothing.
    expect(specific.label).toBe('Enrich graph entities');
    expect(specific.label).not.toBe(generic.label);
    // The description must SAY something, not restate the label — that was the
    // old shape (`${base.description} This run: ${label}.`) and is #2509's
    // complaint. Assert substance instead of an echo.
    expect(specific.description).not.toBe(generic.description);
    expect(specific.description).toMatch(/graph entities already present/);
  });

  it('gives each rotation activity its OWN description, not the parent sentence plus its label', () => {
    // #2509, in the issue's own words: a row called "Infer answers" told you
    // only that the rotation job "depends on its work type … This run: Infer
    // answers." One event covers ten unrelated activities, so the event's
    // description explains none of them.
    const inferred = describeJob('smart.rotation.work', 'answer_infer');
    const generic = describeJob('smart.rotation.work');

    expect(inferred.label).toBe('Infer answers');
    expect(inferred.description).not.toContain('This run:');
    expect(inferred.description).not.toBe(generic.description);
    expect(inferred.description).toMatch(/answer it from what the appliance already knows/);

    // And every activity is covered — a new work type must not ship label-only.
    for (const workType of Object.keys(SMART_ROTATION_WORK)) {
      const descriptor = describeJob('smart.rotation.work', workType);

      expect(descriptor.description).not.toBe(generic.description);
      expect(descriptor.description.length).toBeGreaterThan(60);
    }
  });

  it('falls back to the parent description for an unknown work type', () => {
    // Better a true generic sentence than an invented specific one.
    const unknown = describeJob('smart.rotation.work', 'brand_new_thing');

    expect(unknown.label).toBe('brand_new_thing');
    expect(unknown.description).toBe(describeJob('smart.rotation.work').description);
  });

  it('falls back to the raw work type rather than hiding an unknown one', () => {
    expect(describeJob('smart.rotation.work', 'brand_new_thing').label).toBe('brand_new_thing');
  });

  it('names an unknown event instead of throwing', () => {
    const fingerprinted = describeJob('not.a.real.event', 'nightly', 'search-index');

    expect(fingerprinted.label).toBe('Not a real event · Nightly');
    expect(fingerprinted.description).toContain('`not.a.real.event`');
    expect(fingerprinted.description).toContain('`nightly`');
    expect(fingerprinted.description).toContain('`search-index`');
    // The queue's guess reaches the operator as prose, not as a category — see
    // 'keeps the fingerprint's guess' below for why that distinction matters.
    expect(fingerprinted.description).toContain('`search`');
    expect(fingerprinted.category).toBe(UNCLASSIFIED_CATEGORY);
    expect(describeJob(null).label).toBe('Unclassified job');
  });

  it('guesses from the event prefix when the queue is unknown, in the prose', () => {
    // Neither of these exists in JOB_TYPES — they are stand-ins for whatever
    // event ships next without an entry. The prefix rule still gives an
    // operator a readable name and a hint at which block of this file it
    // belongs in…
    const planning = describeJob('planning.todo-scan');
    const model = describeJob('hbpe.nightly');

    expect(planning.label).toBe('Planning todo scan');
    expect(planning.description).toContain('`planning`');
    expect(model.description).toContain('`llm`');

    // …and the category stays `unclassified`, because that is the only bucket
    // the chips count them in and the filter can return them from.
    expect(planning.category).toBe(UNCLASSIFIED_CATEGORY);
    expect(model.category).toBe(UNCLASSIFIED_CATEGORY);
  });

  it('classifies chat generate as interactive LLM work', () => {
    const descriptor = describeJob('chat.generate');

    expect(descriptor.category).toBe(JOB_CATEGORIES.llm);
    expect(descriptor.interactive).toBe(true);
    expect(describeJob('chat.summarization').interactive).toBeFalsy();
    expect(describeJob('infer.question.answer').category).toBe(JOB_CATEGORIES.llm);
  });

  it('assigns every type to a real category', () => {
    const categories = new Set<string>(Object.values(JOB_CATEGORIES));

    // Collected rather than asserted per-entry so a failure names every bad
    // event at once instead of stopping at the first.
    const miscategorised = Object.entries(JOB_TYPES)
      .filter(([, descriptor]) => !categories.has(descriptor.category))
      .map(([event]) => event);

    const unlabelled = Object.entries(JOB_TYPES)
      .filter(([, descriptor]) => !descriptor.label)
      .map(([event]) => event);

    expect(miscategorised).toEqual([]);
    expect(unlabelled).toEqual([]);
  });

  it('indexes every type under exactly one category', () => {
    const index = jobCategoryIndex();
    const indexed = Object.values(index).flat();

    expect(indexed).toHaveLength(Object.keys(JOB_TYPES).length);
    expect(new Set(indexed).size).toBe(indexed.length);
  });

  it('covers the search-index lifecycle for every indexed entity', () => {
    // These are generated, so a missing one means the generator lost an entity
    // rather than that someone forgot to type it out. product/receipt are
    // covered here because they previously had no entry anywhere in the file.
    for (const entity of ['note', 'person', 'place', 'thread', 'communication', 'product', 'receipt']) {
      for (const verb of ['created', 'updated', 'deleted']) {
        expect(describeJob(`${entity}.${verb}`).category).toBe(JOB_CATEGORIES.search);
      }
    }
  });

  it('resolves content.created to its search-index description, not the stale pipeline duplicate', () => {
    // JOB_TYPES used to carry two literal definitions for content.created —
    // one generated (category 'search'), one hand-written later in the object
    // (category 'pipeline') — and object-literal ordering meant the second,
    // wrong one silently won for every content.* event.
    for (const verb of ['created', 'updated', 'deleted']) {
      const descriptor = describeJob(`content.${verb}`);

      expect(descriptor.category).toBe(JOB_CATEGORIES.search);
    }

    expect(describeJob('content.created').description).toBe('Index a new content record for search');
  });

  it('classifies the newly-added maintenance sweep-request, backfill and lifecycle events', () => {
    for (const event of [
      'maintenance.graph-edge-backfill-request',
      'maintenance.search-index-backfill-request',
      'file.image-description-backfill-request',
      'user.created',
      'ingest.coalesce',
    ]) {
      expect(describeJob(event).label).not.toBe('Unclassified job');
    }
  });

  it('counts an event with no taxonomy entry as `unclassified`, and LABELS it that way too', () => {
    // `describeJob` FINGERPRINTS an unknown event — it mints a readable label
    // from the event/work-type/queue, which is a strictly better row than
    // "Unclassified job". It used to fingerprint the CATEGORY as well, and that
    // was the bug: a category is a filterable fact, `jobCategorySelector`
    // unfolds one back into event names out of JOB_TYPES, and a fingerprinted
    // event is by definition not in there. So the table rendered "Search index"
    // on a row the Search index chip neither counted nor returned — the same
    // contradiction UNCLASSIFIED_CATEGORY was introduced to end, one layer up
    // (measured live: 587 of 9,557 jobs, 54% of the Completed tab).
    expect(categoryOfEvent('some.brand.new.event')).toBe(UNCLASSIFIED_CATEGORY);
    expect(categoryOfEvent(null)).toBe(UNCLASSIFIED_CATEGORY);

    // The label is still fingerprinted…
    expect(describeJob('some.brand.new.event').label).toBe('Some brand new event');
    // …and the category the row DISPLAYS is now the one that counts and selects
    // it. Display, fold and filter are three views of one answer.
    //
    // This assertion used to be its own inverse — `categoryOfEvent(...)` had to
    // NOT equal `describeJob(...).category`, with the divergence written down as
    // deliberate. It was the bug: the guess was rendered in the Category cell of
    // a row no chip counted and no filter returned.
    expect(describeJob('some.brand.new.event').category).toBe(UNCLASSIFIED_CATEGORY);
    expect(describeJob(null).category).toBe(UNCLASSIFIED_CATEGORY);

    // A known event folds to its real category, so the two only diverge where
    // the taxonomy has nothing to say — and now they do not diverge even there.
    expect(categoryOfEvent('chat.generate')).toBe(JOB_CATEGORIES.llm);

    // And the sentinel stays out of the real category enum, or a descriptor
    // could be written against it and the bucket would stop meaning "absent".
    expect(Object.values(JOB_CATEGORIES)).not.toContain(UNCLASSIFIED_CATEGORY);
  });

  it('keeps the fingerprint\u2019s guess, but as prose rather than as a category', () => {
    // The guess is worth showing — it is the fastest pointer at which entry
    // someone should write — it just may not sit in the one field the filter
    // treats as a fact. `search-index` is a FINGERPRINT_QUEUE_CATEGORY key and
    // `file.` a FINGERPRINT_CATEGORY prefix, so both arms are covered.
    const fromQueue = describeJob('zz.no-such-event', null, 'search-index');
    const fromPrefix = describeJob('file.zz-no-such-event', null, 'some-unknown-queue');

    expect(fromQueue.description).toContain('`search`');
    expect(fromQueue.category).toBe(UNCLASSIFIED_CATEGORY);
    expect(fromPrefix.description).toContain('`ingest`');
    expect(fromPrefix.category).toBe(UNCLASSIFIED_CATEGORY);

    // And it still says what to do about it.
    expect(fromQueue.description).toContain('taxonomy.ts');
  });

  it('classifies the events a live appliance was rendering as "Unclassified job"', () => {
    // Measured on the running box: 587 of 9,557 jobs — and 54% of everything on
    // the Completed tab — carried no category, so they were unreachable from the
    // category filter entirely. `retrieval.query` alone was 586 of them.
    // Each entry below is an event with a real listener AND a real producer that
    // simply had no descriptor here.
    const cases: ReadonlyArray<[string, string]> = [
      ['retrieval.query', JOB_CATEGORIES.maintenance],
      ['embed.unfurl-sweep-request', JOB_CATEGORIES.pipeline],
      ['file.preview-sweep-request', JOB_CATEGORIES.pipeline],
      ['maintenance.derivation-run-request', JOB_CATEGORIES.graph],
    ];

    for (const [event, category] of cases) {
      const descriptor = describeJob(event);

      expect(descriptor.label).not.toBe('Unclassified job');
      expect(descriptor.category).toBe(category);
      // A label with no description is only half a classification — the
      // dashboard shows the description in the expanded row.
      expect(descriptor.description.length).toBeGreaterThan(20);
    }
  });

  it('names the chat-turn memory producer rather than leaving it unclassified', () => {
    // TurnFragmentCron fans this out one job per user; on the Jobs dashboard a
    // per-user fan-out with no entry here is a wall of identical event names.
    const descriptor = describeJob('agent-memory.turn-fragments');

    expect(descriptor.label).not.toBe('Unclassified job');
    expect(descriptor.category).toBe(JOB_CATEGORIES.ingest);
    expect(descriptor.description.length).toBeGreaterThan(20);
  });

  it('drops the promotion_review rotation-work label the migration already retired', () => {
    expect(SMART_ROTATION_WORK_LABELS.promotion_review).toBeUndefined();
    expect(Object.keys(SMART_ROTATION_WORK_LABELS)).not.toContain('promotion_review');
  });

  it('disambiguates an event two unrelated listeners share by the queue each runs on', () => {
    // communication.created fires on both `search-index` (indexing) and
    // `people-linking` (graph stub-Person creation) — real queue names from
    // CommunicationSearchIndexListener / CommunicationParticipantLinkListener.
    const indexing = describeJob('communication.created', null, 'search-index');
    const linking = describeJob('communication.created', null, 'people-linking');

    expect(indexing.category).toBe(JOB_CATEGORIES.search);
    expect(linking.category).toBe(JOB_CATEGORIES.graph);
    expect(linking.label).not.toBe(indexing.label);

    // Without a queue, or on a queue with no override, the event-only
    // description is still the fallback — existing single-listener callers
    // are unaffected.
    expect(describeJob('communication.created').category).toBe(JOB_CATEGORIES.search);
    expect(describeJob('communication.created', null, 'some-other-queue').category).toBe(
      JOB_CATEGORIES.search,
    );
  });

  it('disambiguates content.created between search-indexing and the pipeline arrival dispatch', () => {
    // Real queue names from ContentSearchIndexListener / StageArrivalListener.
    const indexing = describeJob('content.created', null, 'search-index');
    const arrival = describeJob('content.created', null, 'pipeline-index');

    expect(indexing.category).toBe(JOB_CATEGORIES.search);
    expect(arrival.category).toBe(JOB_CATEGORIES.pipeline);
  });

  it('disambiguates user.created between saved-search seeding and inbox provisioning', () => {
    // Real queue names from SeedDefaultSavedSearchesListener (default) /
    // InboxProvisionListener (import-inbox-provision).
    const seeded = describeJob('user.created', null, 'default');
    const provisioned = describeJob('user.created', null, 'import-inbox-provision');

    expect(seeded.category).toBe(JOB_CATEGORIES.personalization);
    expect(provisioned.category).toBe(JOB_CATEGORIES.import);
    expect(provisioned.label).not.toBe(seeded.label);
  });

  it('files the per-visit browser classification under the model, not the search index', () => {
    // `browseractivity.created` has TWO listeners: BrowserActivitySearchIndexListener
    // on `search-index`, and BrowserActivityInsightListener on its own 1-slot
    // `browser-activity-insight` queue, which runs an Ollama classification per
    // browsed page. Only the generated search-index descriptor existed, so an
    // operator filtering by Model to see what is queued against a saturated
    // Ollama did not see the highest-frequency model call on the box.
    const indexing = describeJob('browseractivity.created', null, 'search-index');
    const insight = describeJob('browseractivity.created', null, 'browser-activity-insight');

    expect(indexing.category).toBe(JOB_CATEGORIES.search);
    expect(insight.category).toBe(JOB_CATEGORIES.llm);
    expect(insight.label).not.toBe(indexing.label);

    // …and the Model filter can actually reach it, which the label alone does
    // not guarantee — see the invariant suite at the bottom of this file.
    expect(jobCategorySelector(JOB_CATEGORIES.llm).includeQueueKeys).toContain(
      'browseractivity.created::browser-activity-insight',
    );
    expect(jobCategorySelector(JOB_CATEGORIES.search).excludeQueueKeys).toContain(
      'browseractivity.created::browser-activity-insight',
    );
  });

  it('disambiguates answer.created between search-indexing and home confirmation', () => {
    // Real queue names from AnswerSearchIndexListener (search-index) /
    // HomeConfirmListener (default — no queue option given).
    const indexing = describeJob('answer.created', null, 'search-index');
    const homeConfirm = describeJob('answer.created', null, 'default');

    expect(indexing.category).toBe(JOB_CATEGORIES.search);
    expect(homeConfirm.category).toBe(JOB_CATEGORIES.graph);
  });
});

/**
 * The category filter has to agree with the category LABEL.
 *
 * `describeJob` resolves a row's category from the (event, queue) pair, but the
 * Jobs list used to select a category from `JOB_TYPES` alone. The two disagreed
 * for every event in `JOB_TYPES_BY_QUEUE`: `GET /jobs?category=search` returned
 * rows the same response labelled `graph` and `pipeline`, and `category=graph`
 * could not find them at all. These pin the two halves together — a new
 * queue-scoped entry that crosses a category boundary breaks a test here rather
 * than quietly mis-filtering the table.
 */
describe('jobCategorySelector', () => {
  /** Resolve a pair key the way `describeJob` does, for cross-checking. */
  function categoryOf(key: string): string {
    const [event = '', queue = ''] = key.split('::');

    return describeJob(event, null, queue).category;
  }

  it('moves a queue-scoped event OUT of the category its base entry names', () => {
    const search = jobCategorySelector(JOB_CATEGORIES.search);

    // The base entries are all category `search` …
    expect(search.events).toContain('communication.created');
    expect(search.events).toContain('content.created');
    expect(search.events).toContain('answer.created');

    // … but on these queues they are not, so the filter must subtract them.
    expect(search.excludeQueueKeys).toContain('communication.created::people-linking');
    expect(search.excludeQueueKeys).toContain('content.created::pipeline-index');
    expect(search.excludeQueueKeys).toContain('answer.created::default');
  });

  it('moves a queue-scoped event INTO the category its queue names', () => {
    const graph = jobCategorySelector(JOB_CATEGORIES.graph);

    expect(graph.includeQueueKeys).toContain('communication.created::people-linking');
    expect(graph.includeQueueKeys).toContain('answer.created::default');
    // `content.created` on pipeline-index belongs to `pipeline`, not `graph`.
    expect(graph.includeQueueKeys).not.toContain('content.created::pipeline-index');

    expect(jobCategorySelector(JOB_CATEGORIES.pipeline).includeQueueKeys).toContain(
      'content.created::pipeline-index',
    );
  });

  it('agrees with describeJob for every queue-scoped pair, in both directions', () => {
    for (const category of Object.values(JOB_CATEGORIES)) {
      const selector = jobCategorySelector(category);

      for (const key of selector.includeQueueKeys) {
        expect(categoryOf(key)).toBe(category);
      }

      for (const key of selector.excludeQueueKeys) {
        expect(categoryOf(key)).not.toBe(category);
      }
    }
  });

  it('never both includes and excludes the same pair', () => {
    for (const category of Object.values(JOB_CATEGORIES)) {
      const { includeQueueKeys, excludeQueueKeys } = jobCategorySelector(category);
      const overlap = includeQueueKeys.filter((key) => excludeQueueKeys.includes(key));

      expect(overlap).toEqual([]);
    }
  });

  it('an unknown category selects nothing at all', () => {
    const selector = jobCategorySelector('not-a-real-category');

    expect(selector.events).toEqual([]);
    expect(selector.includeQueueKeys).toEqual([]);
    expect(selector.excludeQueueKeys).toEqual([]);
  });

  it('never carries a queue-scoped entry for an event with no base entry', () => {
    // The `unclassified` filter branch is the complement of JOB_TYPES' KEYS, so
    // an event that exists only in JOB_TYPES_BY_QUEUE would be selected both by
    // `unclassified` (no base entry) and by the pair's own category — the one
    // shape that breaks the one-category-per-row invariant proved below.
    for (const key of Object.keys(JOB_TYPES_BY_QUEUE)) {
      const [event = ''] = key.split('::');

      expect(JOB_TYPES[event]).toBeDefined();
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DISPLAY = FOLD = FILTER, for every row.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three pieces of code answer "what category is this job?", in three places and
 * three languages: `describeJob` labels the row, `categoryOfJob` counts it into
 * a chip, and `jobCategorySelector` builds the SQL that returns it when the chip
 * is clicked. A row is only honest when all three say the same thing, and this
 * codebase has now had the same class of bug three times over from them not:
 *
 *   1. An unknown event rendered "Maintenance"; Maintenance did not return it.
 *   2. A fingerprinted event rendered "Search index"; Search index neither
 *      counted nor returned it.
 *   3. `content.created` on `pipeline-index` rendered "Pipeline" and Pipeline
 *      returned it, while the SEARCH chip was the one that counted it.
 *
 * Rather than a regression test per incident, this pins the invariant itself.
 */
describe('the category of a row is one answer, not three', () => {
  /**
   * `applyFilters`' category predicate, transcribed into JS.
   *
   * For a real category it emits
   *   (event IN selector.events AND `event::queue` NOT IN excludeQueueKeys)
   *   OR `event::queue` IN includeQueueKeys
   * and for `unclassified`, the complement of JOB_TYPES' keys. Keeping the
   * transcription here — rather than reaching into the service — is what lets
   * this run without a database; `JobQueryService.spec.ts` proves the SQL
   * actually emitted matches it.
   */
  function filterSelects(category: string, event: string | null, queue: string): boolean {
    if (category === UNCLASSIFIED_CATEGORY) {
      return event == null || JOB_TYPES[event] === undefined;
    }

    if (event == null) {
      return false;
    }

    const { events, includeQueueKeys, excludeQueueKeys } = jobCategorySelector(category);
    const key = `${event}::${queue}`;

    return (events.includes(event) && !excludeQueueKeys.includes(key)) || includeQueueKeys.includes(key);
  }

  /**
   * Rows that between them cover every branch: a plain single-listener event,
   * every queue-scoped pair on BOTH its queues, an unknown event on a queue the
   * fingerprint recognises and on one it does not, a row with no event name at
   * all, and — the case that forces the fallback — the dead-letter copy of a
   * pair event, whose queue column no longer says where it ran.
   */
  const ROWS: ReadonlyArray<readonly [event: string | null, queue: string]> = [
    ['note.created', 'search-index'],
    ['chat.generate', 'llm'],
    ['content.created', 'search-index'],
    ['content.created', 'pipeline-index'],
    ['communication.created', 'search-index'],
    ['communication.created', 'people-linking'],
    ['answer.created', 'search-index'],
    ['answer.created', 'default'],
    ['user.created', 'default'],
    ['user.created', 'import-inbox-provision'],
    ['browseractivity.created', 'search-index'],
    ['browseractivity.created', 'browser-activity-insight'],
    // The queue is gone: pg-boss rewrote it on the dead-letter copy.
    ['content.created', DEAD_LETTER_QUEUE],
    ['browseractivity.created', DEAD_LETTER_QUEUE],
    ['zz.no-such-event', 'search-index'],
    ['zz.no-such-event', 'a-queue-nobody-has-heard-of'],
    ['file.zz-no-such-event', 'default'],
    [null, DEAD_LETTER_QUEUE],
  ];

  const ALL_BUCKETS = [...Object.values(JOB_CATEGORIES), UNCLASSIFIED_CATEGORY];

  it.each(ROWS)('%s on %s is counted, labelled and returned as one category', (event, queue) => {
    const selecting = ALL_BUCKETS.filter((bucket) => filterSelects(bucket, event, queue));

    // Exactly one chip returns this row. Two would double-count it in the
    // totals; none would make it unreachable from the filter row entirely.
    expect(selecting).toHaveLength(1);

    const [category] = selecting;

    // The chip that returns it is the chip that counted it…
    expect(categoryOfJob(event, queue)).toBe(category);
    // …and is what the row's own Category cell says.
    expect(describeJob(event, null, queue).category).toBe(category);
  });

  it('resolves a dead-lettered row by its event alone, exactly as the filter does', () => {
    // The one place fold and filter must BOTH degrade rather than both resolve.
    // `content.created` means `pipeline` on `pipeline-index`, but the copy on
    // the dead-letter queue has lost that, and no amount of taxonomy can get it
    // back — so both sides answer from the event, and the row stays selectable
    // under the category it is shown as. 43% of rows on a live appliance are in
    // this state, which is why it is the fallback and not an edge case.
    expect(categoryOfJob('content.created', 'pipeline-index')).toBe(JOB_CATEGORIES.pipeline);
    expect(categoryOfJob('content.created', DEAD_LETTER_QUEUE)).toBe(JOB_CATEGORIES.search);
    expect(categoryOfJob('content.created', null)).toBe(JOB_CATEGORIES.search);
    expect(categoryOfJob('content.created', DEAD_LETTER_QUEUE)).toBe(categoryOfEvent('content.created'));
  });
});
