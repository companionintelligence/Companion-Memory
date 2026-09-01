/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT EACH JOB ACTUALLY DOES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The queue is named after its mechanism and the event after its trigger, so a
 * dashboard built from raw names tells an operator that `file.uploaded` is on
 * `image-description` — two facts that, together, still do not say what the
 * appliance is doing or whether it matters. Watching a live box, the entire
 * memory system reads as an undifferentiated wall of `file.uploaded`,
 * `preview.generated` and `smart.rotation.work`.
 *
 * This is the missing layer: for every event the codebase can emit, what it
 * does in plain language, which part of the system it belongs to, and whether a
 * human is waiting on it. The UI groups and filters by `category`, so "what is
 * happening in the memory system right now" becomes a question with an answer.
 *
 * Keeping it as data rather than scattering labels through the frontend means
 * the API can group by category in SQL, and an event that gains a listener
 * without gaining an entry here shows up as `unclassified` rather than silently
 * looking like everything else.
 */

/**
 * The part of the appliance a job belongs to.
 *
 * Deliberately coarse. These are the buckets an operator actually reasons in
 * when something is slow or stuck — not the module layout.
 */
export const JOB_CATEGORIES = {
  /** Making things findable: search index writes and embeddings. */
  search: 'search',
  /** Turning raw captures into memory: parsing, previews, dimensions, detection. */
  ingest: 'ingest',
  /** Adding meaning: descriptions, geocoding, location estimates, inference. */
  enrich: 'enrich',
  /** The life graph: people, places, visits, relationships. */
  graph: 'graph',
  /** The staged pipeline (index → enrich → embed) and its control plane. */
  pipeline: 'pipeline',
  /** Pulling data in from connected accounts. */
  import: 'import',
  /** Talking to a model: chat summaries, answer inference. */
  llm: 'llm',
  /** Feed, questions, dossier — what the companion shows the user. */
  personalization: 'personalization',
  /** Plan automation: memory todo scan, process, event revise, verify-done. */
  planning: 'planning',
  /** Housekeeping: rotation, dead letters, telemetry, backfills. */
  maintenance: 'maintenance',
} as const;

export type JobCategory = (typeof JOB_CATEGORIES)[keyof typeof JOB_CATEGORIES];

export interface JobTypeDescriptor {
  /** Short human name for a table cell. */
  readonly label: string;
  readonly category: JobCategory;
  /** One sentence: what this job does, and why it exists. */
  readonly description: string;
  /**
   * True when a person is plausibly waiting on this right now — a chat turn, an
   * upload showing a spinner. Lets the UI separate "the box is busy" from "the
   * box is busy with something someone asked for".
   */
  readonly interactive?: boolean;
}

/**
 * Entity lifecycle events all mean the same thing to the search index, so they
 * are generated rather than written out 40 times.
 */
function searchIndexTypes(entity: string, label: string): Record<string, JobTypeDescriptor> {
  const verbs: Array<[string, string]> = [
    ['created', `Index a new ${label} for search`],
    ['updated', `Re-index an edited ${label}`],
    ['deleted', `Remove a deleted ${label} from the search index`],
  ];

  return Object.fromEntries(
    verbs.map(([verb, description]) => [
      `${entity}.${verb}`,
      {
        label: `${label} ${verb}`,
        category: JOB_CATEGORIES.search,
        description,
      } satisfies JobTypeDescriptor,
    ]),
  );
}

export const JOB_TYPES: Readonly<Record<string, JobTypeDescriptor>> = {
  // ── Search index ────────────────────────────────────────────────────────
  ...searchIndexTypes('note', 'note'),
  ...searchIndexTypes('event', 'calendar event'),
  ...searchIndexTypes('item', 'item'),
  ...searchIndexTypes('place', 'place'),
  ...searchIndexTypes('person', 'person'),
  ...searchIndexTypes('concept', 'concept'),
  ...searchIndexTypes('content', 'content record'),
  ...searchIndexTypes('answer', 'answer'),
  ...searchIndexTypes('thread', 'thread'),
  ...searchIndexTypes('message', 'message'),
  ...searchIndexTypes('communication', 'communication'),
  ...searchIndexTypes('browseractivity', 'browsing record'),
  ...searchIndexTypes('position', 'GPS fix'),
  ...searchIndexTypes('product', 'product'),
  ...searchIndexTypes('receipt', 'receipt'),
  'agent-memory.created': {
    label: 'Agent memory saved',
    category: JOB_CATEGORIES.search,
    description: 'Index something the agent chose to remember so it can be recalled later.',
  },
  'agent-memory.deleted': {
    label: 'Agent memory removed',
    category: JOB_CATEGORIES.search,
    description: 'Drop a forgotten agent memory from the search index.',
  },
  'agent-memory.turn-fragments': {
    label: 'Remember a chat turn',
    category: JOB_CATEGORIES.ingest,
    description:
      'Turn one user\u2019s finished chat turns into raw memory fragments, so what was said in chat can be recalled later and compacted into the graph.',
  },

  // ── Ingest ──────────────────────────────────────────────────────────────
  'file.created': {
    label: 'File registered',
    category: JOB_CATEGORIES.ingest,
    description: 'A file record exists; index it so it is searchable by name and metadata.',
  },
  'file.uploaded': {
    label: 'File uploaded',
    category: JOB_CATEGORIES.ingest,
    description:
      'The fan-out point for everything a new file needs: preview generation, document parsing, thing extraction and search indexing all hang off this one event. By far the highest-volume job on the appliance.',
  },
  'file.updated': {
    label: 'File changed',
    category: JOB_CATEGORIES.ingest,
    description: 'Re-index a file whose metadata changed.',
  },
  'file.deleted': {
    label: 'File removed',
    category: JOB_CATEGORIES.ingest,
    description: 'Drop a deleted file from the search index.',
  },
  'preview.generated': {
    label: 'Preview ready',
    category: JOB_CATEGORIES.ingest,
    description:
      'A thumbnail or preview finished rendering. Triggers image description, so a backlog here stalls every downstream vision job.',
  },
  'document.parsed': {
    label: 'Document parsed',
    category: JOB_CATEGORIES.ingest,
    description: 'Text was extracted from a document; index its chunks so the contents are searchable.',
  },
  'cv.detections.captured': {
    label: 'Objects detected',
    category: JOB_CATEGORIES.ingest,
    description: 'Store what the vision model found in a captured frame.',
  },
  'file.media-dimensions-backfill-request': {
    label: 'Backfill media dimensions',
    category: JOB_CATEGORIES.ingest,
    description: 'Fill in width and height for media that was imported without them.',
  },

  // ── Enrichment ──────────────────────────────────────────────────────────
  'event.geocode-batch-request': {
    label: 'Geocode locations',
    category: JOB_CATEGORIES.enrich,
    description:
      'Turn place names and coordinates into structured locations. Egresses to a metered provider, so this is rate-limited on purpose.',
  },
  'event.estimate-location-batch-request': {
    label: 'Estimate locations',
    category: JOB_CATEGORIES.enrich,
    description: 'Infer where something happened when it carries no explicit location.',
  },
  'file.image-description-backfill-request': {
    label: 'Backfill image descriptions',
    category: JOB_CATEGORIES.enrich,
    description:
      'Image description was turned back on; re-fire preview.generated for originals still missing a description (skipped while off, or previously failed on a text-only model).',
  },

  // ── Life graph ──────────────────────────────────────────────────────────
  'graph.person.created': {
    label: 'Person added to graph',
    category: JOB_CATEGORIES.graph,
    description: 'Record a newly recognised person as a node in the life graph.',
  },
  'graph.family.members.added': {
    label: 'Family linked',
    category: JOB_CATEGORIES.graph,
    description: 'Connect family relationships between people in the graph.',
  },
  'graph.preference.added': {
    label: 'Preference recorded',
    category: JOB_CATEGORIES.graph,
    description: 'Store something learned about what the user likes or avoids.',
  },
  'graph.preferences.added': {
    label: 'Preferences recorded',
    category: JOB_CATEGORIES.graph,
    description: 'Store a batch of learned preferences.',
  },
  'graph.location.created': {
    label: 'Location added to graph',
    category: JOB_CATEGORIES.graph,
    description: 'Record a place as a node in the life graph.',
  },
  'graph.visit.recorded': {
    label: 'Visit recorded',
    category: JOB_CATEGORIES.graph,
    description: 'Link a person or place to a point in time they were visited.',
  },
  'graph.connection.created': {
    label: 'Connection recorded',
    category: JOB_CATEGORIES.graph,
    description: 'Record a relationship between two people in the graph.',
  },
  'graph.node.upserted': {
    label: 'Graph node written',
    category: JOB_CATEGORIES.graph,
    description: 'Create or update a node in the life graph.',
  },
  'graph.node.updated': {
    label: 'Graph node updated',
    category: JOB_CATEGORIES.graph,
    description: 'Update an existing life-graph node.',
  },
  'graph.node.deleted': {
    label: 'Graph node deleted',
    category: JOB_CATEGORIES.graph,
    description: 'Remove a node from the life graph.',
  },
  'graph.relationship.upserted': {
    label: 'Graph edge written',
    category: JOB_CATEGORIES.graph,
    description: 'Create or update an edge between two life-graph nodes.',
  },
  'graph.relationship.deleted': {
    label: 'Graph edge deleted',
    category: JOB_CATEGORIES.graph,
    description: 'Remove an edge from the life graph.',
  },

  // ── Pipeline ────────────────────────────────────────────────────────────
  'pipeline.slice': {
    label: 'Pipeline slice',
    category: JOB_CATEGORIES.pipeline,
    description:
      'One batch of entities through one pipeline stage. The unit of work the staged pipeline actually schedules.',
  },
  'pipeline.sweep': {
    label: 'Pipeline sweep',
    category: JOB_CATEGORIES.pipeline,
    description: 'Look for entities whose stage version is behind and queue slices for them.',
  },
  'pipeline.dead_letter.reap': {
    label: 'Harvest dead letters',
    category: JOB_CATEGORIES.pipeline,
    description:
      'Copy exhausted-retry jobs out of the dead-letter queue into a durable table so the failure survives pg-boss retention.',
  },
  'maintenance.graph-edge-backfill-request': {
    label: 'Kick graph-edge sweep',
    category: JOB_CATEGORIES.pipeline,
    description:
      "Start an immediate promote.edge_* sweep for the requesting user so a bulk load's rows reach the graph without waiting for the next scheduled sweep.",
  },
  'maintenance.search-index-backfill-request': {
    label: 'Kick search-index sweep',
    category: JOB_CATEGORIES.pipeline,
    description:
      "Start an immediate embed+vector sweep of the requested entity types for the requesting user so a bulk load's rows become searchable without waiting for the next scheduled sweep.",
  },
  'ingest.coalesce': {
    label: 'Coalesce ingest',
    category: JOB_CATEGORIES.pipeline,
    description:
      'Server-side finish for a bulk /v1 push: a delayed singleton that runs enrichment even if the client never calls finish.',
  },

  // ── Import / ETL ────────────────────────────────────────────────────────
  'connectionSyncJob.execute': {
    label: 'Sync connected account',
    category: JOB_CATEGORIES.import,
    description:
      'Fetch a page of data from a connected provider (mail, calendar, photos). Rate-limited to one endpoint per connection at a time.',
  },
  'connectionSyncJob.transform': {
    label: 'Transform synced data',
    category: JOB_CATEGORIES.import,
    description: 'Map a provider payload into the appliance memory model.',
  },
  'import.stage': {
    label: 'Import stage',
    category: JOB_CATEGORIES.import,
    description: 'One stage of a bulk archive import. Long-running; runs in the worker process.',
  },

  // ── LLM ─────────────────────────────────────────────────────────────────
  'chat.generate': {
    label: 'Generate chat reply',
    category: JOB_CATEGORIES.llm,
    description: 'Run one chat turn on the model. Survives leaving the page; Stop cancels it.',
    interactive: true,
  },
  'chat.summarization': {
    label: 'Summarize conversation',
    category: JOB_CATEGORIES.llm,
    description: 'Condense a chat thread so it fits future prompts.',
  },
  'infer.question.answer': {
    label: 'Infer an answer',
    category: JOB_CATEGORIES.llm,
    description:
      'Answer an open question about the user from what the appliance already knows, rather than asking them.',
  },
  'python.function.run': {
    label: 'Run analysis function',
    category: JOB_CATEGORIES.llm,
    description:
      'Hand work to the Python sidecar (summaries, behavioural pattern extraction). Completion is reported back by webhook, so these sit `active` while the sidecar works.',
  },

  // ── Personalization ─────────────────────────────────────────────────────
  'action.created': {
    label: 'Action suggested',
    category: JOB_CATEGORIES.personalization,
    description: 'A suggested action was generated; queue it for the feed.',
  },
  'summary.created': {
    label: 'Summary ready',
    category: JOB_CATEGORIES.personalization,
    description: 'A summary was generated; queue it for the feed.',
  },
  'context.prompt.persist': {
    label: 'Persist context prompt',
    category: JOB_CATEGORIES.personalization,
    description: 'Save the generated dossier the companion uses to sound like it knows the user.',
  },
  'question.created': {
    label: 'Question raised',
    category: JOB_CATEGORIES.personalization,
    description: 'A new question about the user was raised for the feed.',
  },
  'user.created': {
    label: 'Default searches seeded',
    category: JOB_CATEGORIES.personalization,
    description:
      'Seed the starter saved-search library for a new account so the catalog exists before the first visit to Saved Searches.',
  },

  // ── Planning ────────────────────────────────────────────────────────────
  'planning.todo_scan': {
    label: 'Scan memory for to-dos',
    category: JOB_CATEGORIES.planning,
    description:
      'Recall the last stretch of memory, surface possible to-dos, dedupe against the backlog, and auto-add or propose based on the trust dial.',
  },
  'planning.inbox_scan': {
    label: 'Triage inbox into to-dos',
    category: JOB_CATEGORIES.planning,
    description:
      'Read recent inbound email and messages, surface possible to-dos, and auto-add or propose based on the trust dial. Hands-off may also place them on the calendar.',
  },
  'planning.todo_process': {
    label: 'Process open to-dos',
    category: JOB_CATEGORIES.planning,
    description:
      'Append knowledge, revise, reparent, or close open tasks from stream evidence — or ask on Plan when confidence is low.',
  },
  'planning.event_now': {
    label: 'Revise planned events now',
    category: JOB_CATEGORIES.planning,
    description:
      'As planned blocks enter the present, revise or cancel them when memory shows plans changed.',
  },
  'planning.verify_done': {
    label: 'Verify scheduled work done',
    category: JOB_CATEGORIES.planning,
    description:
      'After a scheduled block ends, look for completion evidence and auto-complete or ask the user on Plan.',
  },
  'task.created': {
    label: 'Task created',
    category: JOB_CATEGORIES.planning,
    description: 'A planning task was created (manual or automation).',
  },
  'task.updated': {
    label: 'Task updated',
    category: JOB_CATEGORIES.planning,
    description: 'A planning task was updated.',
  },
  'task.deleted': {
    label: 'Task deleted',
    category: JOB_CATEGORIES.planning,
    description: 'A planning task was deleted.',
  },

  // ── Maintenance ─────────────────────────────────────────────────────────
  'smart.rotation.work': {
    label: 'Scheduled upkeep',
    category: JOB_CATEGORIES.maintenance,
    description:
      'The rotating maintenance job. What it actually does depends on its work type — feed questions, dossier summaries, graph linking and so on.',
  },
  'tool.invoked': {
    label: 'Tool telemetry',
    category: JOB_CATEGORIES.maintenance,
    description: 'Record that an agent tool ran, for usage reporting.',
  },
} as const;

/** Human labels for the `smart.rotation.work` work types. */
export const SMART_ROTATION_WORK_LABELS: Readonly<Record<string, string>> = {
  question_feed: 'Refresh feed questions',
  answer_infer: 'Infer answers',
  schedule_sync: 'Sync schedule',
  insights: 'Generate insights',
  summaries: 'Summaries / dossier',
  graph_link: 'Link graph entities',
  graph_enrich: 'Enrich graph entities',
  context_prompt: 'Rebuild context prompt',
  hydrate_answers: 'Hydrate answers',
  hydrate_things: 'Hydrate things',
};

const UNCLASSIFIED: JobTypeDescriptor = {
  label: 'Unclassified job',
  category: JOB_CATEGORIES.maintenance,
  description:
    'No taxonomy entry for this event name. Either it is new, or it was renamed without updating domains/events/taxonomy.ts.',
};

/**
 * JOB_TYPES is keyed by event name only, so a name two independent listeners
 * share on different queues can only carry one description — whichever was
 * registered last wins and the other listener is mislabeled. This is the
 * disambiguation table for the events where that has actually happened: keyed
 * by `${event}::${queue}`, checked before falling back to JOB_TYPES.
 */
const JOB_TYPES_BY_QUEUE: Readonly<Record<string, JobTypeDescriptor>> = {
  // content.created also drives the pipeline's on-arrival dispatch — a
  // different job from the search-indexing JOB_TYPES entry below.
  'content.created::pipeline-index': {
    label: 'Content staged',
    category: JOB_CATEGORIES.pipeline,
    description: 'New raw content arrived and needs to enter the pipeline.',
  },
  // communication.created also drives on-ingest people-linking, run on its own
  // queue so it never waits behind a search-indexing job.
  'communication.created::people-linking': {
    label: 'Communication participants linked',
    category: JOB_CATEGORIES.graph,
    description:
      "Resolve a communication's participants against the entity-identifier index, minting stub Person entities for anyone not yet known.",
  },
  // user.created also provisions the new account's inbox drop folders, on its
  // own queue so a slow mount can never hold up saved-search seeding.
  'user.created::import-inbox-provision': {
    label: 'Inbox folders provisioned',
    category: JOB_CATEGORIES.import,
    description:
      "Create a new account's inbox drop folders on the mount as soon as the user row exists, rather than waiting for a restart or the first Inbox visit.",
  },
  // answer.created also confirms the seeded home question, on the default
  // queue — unrelated to the search-indexing job of the same event name.
  'answer.created::default': {
    label: 'Home confirmed from answer',
    category: JOB_CATEGORIES.graph,
    description:
      'When an answer resolves the seeded home question, write the same LIVES_IN edge the selector persist path uses and refresh daily metrics.',
  },
};

/**
 * Describe a job from its event name and (for rotation work) its work type.
 * `queue` disambiguates the handful of events two unrelated listeners share —
 * see {@link JOB_TYPES_BY_QUEUE} — and is optional because most callers don't
 * need it: JOB_TYPES already covers events with a single listener.
 *
 * Never throws and never returns undefined: an unknown event is a gap in this
 * file, not a reason for the dashboard to fail.
 */
export function describeJob(
  event: string | null,
  workType?: string | null,
  queue?: string | null,
): JobTypeDescriptor {
  if (!event) {
    return UNCLASSIFIED;
  }

  const base = (queue != null ? JOB_TYPES_BY_QUEUE[`${event}::${queue}`] : undefined) ?? JOB_TYPES[event];

  if (!base) {
    return UNCLASSIFIED;
  }

  // The rotation job is one event covering eleven unrelated activities; naming
  // the activity is the whole point of showing it.
  if (event === 'smart.rotation.work' && workType) {
    return {
      ...base,
      label: SMART_ROTATION_WORK_LABELS[workType] ?? workType,
      description: `${base.description} This run: ${SMART_ROTATION_WORK_LABELS[workType] ?? workType}.`,
    };
  }

  return base;
}

/**
 * How to select a category, given that a category is not just a set of events.
 *
 * `describeJob` resolves a row's category from the (event, queue) PAIR, because
 * a handful of events mean different things on different queues — see
 * {@link JOB_TYPES_BY_QUEUE}. A filter built from {@link JOB_TYPES} alone
 * therefore disagrees with the label the same endpoint puts on the row: asking
 * for `search` returned jobs the response itself called `graph` and `pipeline`
 * (`communication.created` on `people-linking`, `content.created` on
 * `pipeline-index`, `answer.created` on `default`), and asking for `graph`
 * missed them.
 *
 * So a category is its event names, MINUS the pairs a queue moves out of it,
 * PLUS the pairs a queue moves into it. Returned as three lists rather than a
 * predicate because the caller filtering by this is SQL over tens of thousands
 * of rows, not a loop.
 */
export interface JobCategorySelector {
  /** Event names whose base entry is in this category, on any queue. */
  readonly events: readonly string[];
  /** `${event}::${queue}` pairs that resolve INTO this category. */
  readonly includeQueueKeys: readonly string[];
  /** `${event}::${queue}` pairs that resolve OUT of it, despite {@link events}. */
  readonly excludeQueueKeys: readonly string[];
}

export function jobCategorySelector(category: string): JobCategorySelector {
  const events = Object.entries(JOB_TYPES)
    .filter(([, descriptor]) => descriptor.category === category)
    .map(([event]) => event);

  const inCategory = new Set(events);
  const includeQueueKeys: string[] = [];
  const excludeQueueKeys: string[] = [];

  for (const [key, descriptor] of Object.entries(JOB_TYPES_BY_QUEUE)) {
    const [event = ''] = key.split('::');

    if (descriptor.category === category) {
      // Only worth naming when the base entry would not have matched anyway —
      // otherwise `events` already covers this pair on every queue.
      if (!inCategory.has(event)) {
        includeQueueKeys.push(key);
      }

      continue;
    }

    if (inCategory.has(event)) {
      excludeQueueKeys.push(key);
    }
  }

  return { events, includeQueueKeys, excludeQueueKeys };
}

/** Every category, with the event names in it — used to drive the UI filter. */
export function jobCategoryIndex(): Record<JobCategory, string[]> {
  const index = Object.fromEntries(
    Object.values(JOB_CATEGORIES).map((category) => [category, [] as string[]]),
  ) as Record<JobCategory, string[]>;

  for (const [event, descriptor] of Object.entries(JOB_TYPES)) {
    index[descriptor.category].push(event);
  }

  return index;
}
