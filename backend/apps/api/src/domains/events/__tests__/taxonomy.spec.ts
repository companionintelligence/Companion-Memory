import {
  categoryOfEvent,
  describeJob,
  jobCategoryIndex,
  jobCategorySelector,
  JOB_CATEGORIES,
  JOB_TYPES,
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

    // One event covers eleven unrelated activities. Showing the event name is
    // the same as showing nothing.
    expect(specific.label).toBe('Enrich graph entities');
    expect(specific.label).not.toBe(generic.label);
    expect(specific.description).toContain('Enrich graph entities');
  });

  it('falls back to the raw work type rather than hiding an unknown one', () => {
    expect(describeJob('smart.rotation.work', 'brand_new_thing').label).toBe('brand_new_thing');
  });

  it('classifies an unknown event instead of throwing', () => {
    const fingerprinted = describeJob('not.a.real.event', 'nightly', 'search-index');

    expect(fingerprinted.label).toBe('Not a real event · Nightly');
    expect(fingerprinted.category).toBe(JOB_CATEGORIES.search);
    expect(fingerprinted.description).toContain('`not.a.real.event`');
    expect(fingerprinted.description).toContain('`nightly`');
    expect(fingerprinted.description).toContain('`search-index`');
    expect(describeJob(null).label).toBe('Unclassified job');
  });

  it('guesses a category from the event prefix when the queue is unknown', () => {
    expect(describeJob('planning.todo-scan').category).toBe(JOB_CATEGORIES.planning);
    expect(describeJob('planning.todo-scan').label).toBe('Planning todo scan');
    expect(describeJob('hbpe.nightly').category).toBe(JOB_CATEGORIES.llm);
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

  it('counts an event with no taxonomy entry as `unclassified`, whatever the row is labelled', () => {
    // `describeJob` now FINGERPRINTS an unknown event — it mints a readable
    // label and GUESSES a category from the prefix or queue, which is a strictly
    // better row than "Unclassified job". But a guess is not filterable: the
    // category filter unfolds a category back into event names out of JOB_TYPES,
    // and a fingerprinted event is by definition not in there.
    //
    // So counting must NOT follow the guess. `categoryOfEvent` is the fold the
    // chips, the category chart and the sampled metrics all share, and it has to
    // agree with what clicking a chip returns — otherwise a chip reads a number
    // that selecting it cannot reproduce, which is the bug this bucket exists to
    // end (measured live: 587 of 9,557 jobs, 54% of the Completed tab).
    expect(categoryOfEvent('some.brand.new.event')).toBe(UNCLASSIFIED_CATEGORY);
    expect(categoryOfEvent(null)).toBe(UNCLASSIFIED_CATEGORY);

    // The fingerprint is free to guess a real category for DISPLAY…
    expect(describeJob('some.brand.new.event').label).toBe('Some brand new event');
    // …and the fold still refuses to follow it.
    expect(categoryOfEvent('some.brand.new.event')).not.toBe(
      describeJob('some.brand.new.event').category,
    );

    // A known event folds to its real category, so the two only diverge where
    // the taxonomy has nothing to say.
    expect(categoryOfEvent('chat.generate')).toBe(JOB_CATEGORIES.llm);

    // And the sentinel stays out of the real category enum, or a descriptor
    // could be written against it and the bucket would stop meaning "absent".
    expect(Object.values(JOB_CATEGORIES)).not.toContain(UNCLASSIFIED_CATEGORY);
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
});
