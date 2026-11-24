/**
 * Starter asks offered by the empty Chat.
 *
 * These are not invented copy. Every line is a natural-language trigger phrase
 * declared by a shipped intent in the backend tool catalogue — the `phrases`
 * field on each tool schema in `backend/apps/api/src/domains/tools/tools/`,
 * collected by `IntentCatalogService.getManifest()` and published at
 * `GET /api/intents` (also the `intents://catalog` MCP resource). Quoting them
 * verbatim guarantees each starter lands on a capability Companion actually
 * has, and keeps one source of truth for "what can I ask this thing".
 *
 * Only slot-free phrases can be sent as-is; the templated ones ("Where is
 * $place", "Find $name") are deliberately excluded because a tap has nothing to
 * fill the slot with. The list is kept short — roughly one per domain — so it
 * stays scannable on a phone.
 *
 * Reading them from `/api/intents` at runtime was considered and rejected: the
 * endpoint is scope-guarded and the empty state must render instantly and
 * offline, so a network round trip would gate the first thing a user sees.
 *
 * ### Flags
 *
 * The intents answer whether or not the surface they talk about is switched
 * on, so a stock install used to offer "What does tomorrow look like for me"
 * with no Forecast page to open and "What is on Brief" with no Brief home. A
 * starter that names a hidden surface is a starter that teaches the user the
 * product has features it does not show them. Each entry therefore says which
 * feature flag its surface sits behind (`requires`), and
 * {@link starterPromptsFor} drops the ones whose flag is off.
 */
interface StarterPrompt {
  readonly text: string;
  /** The feature flag of the surface this ask talks about; absent = always offered. */
  readonly requires?: string;
}

const STARTER_CATALOGUE: readonly StarterPrompt[] = [
  // brief.list — Brief is the Today surface: derived insights, anomalies and actions.
  { text: 'What is on Brief', requires: 'today.page' },
  // brief.list (its "actions" leg) — same surface.
  { text: 'Any suggested actions', requires: 'today.page' },
  // forecast.read
  { text: 'What does tomorrow look like for me', requires: 'forecast.page' },
  // forecast.calibration
  { text: 'How accurate are my predictions', requires: 'forecast.page' },
  // anomalies.recent — its own tool, useful with or without the Today page
  { text: 'Anything unusual lately' },
  // insights.explain
  { text: 'What is associated with my mood', requires: 'insights.page' },
  // places.next
  { text: 'Where do I usually go next' },
  // people.relationships
  { text: 'Who is my family' },
  // knowledge.preferences
  { text: 'What are my preferences' },
  // import.list_sources
  { text: 'What can you import', requires: 'import.page' },
  // import.run_status — the ask a first-run user actually has after onboarding
  { text: 'How is my import going', requires: 'import.page' },
];

/** Every starter, flags ignored. What the catalogue holds; not what a given appliance shows. */
export const STARTER_PROMPTS: readonly string[] = STARTER_CATALOGUE.map((prompt) => prompt.text);

/** The starters worth offering on THIS appliance: those whose surface is switched on. */
export function starterPromptsFor(isFeatureEnabled: (flag: string) => boolean): string[] {
  return STARTER_CATALOGUE.filter(
    (prompt) => prompt.requires === undefined || isFeatureEnabled(prompt.requires),
  ).map((prompt) => prompt.text);
}

const TOPICS: ReadonlyArray<{ readonly label: string; readonly requires?: string }> = [
  { label: 'Memory' },
  { label: 'Plan', requires: 'planning.page' },
  { label: 'Forecast', requires: 'forecast.page' },
  { label: 'Brief', requires: 'today.page' },
];

/** The areas Chat can be asked about here — the composer hint must not name pages that are off. */
export function chatTopicsFor(isFeatureEnabled: (flag: string) => boolean): string[] {
  return TOPICS.filter((topic) => topic.requires === undefined || isFeatureEnabled(topic.requires)).map(
    (topic) => topic.label,
  );
}

/** "Memory", "Memory or Plan", "Memory, Plan or Forecast" — for hint copy. */
export function joinTopics(topics: readonly string[], conjunction = 'or'): string {
  if (topics.length <= 1) {
    return topics.join('');
  }

  return `${topics.slice(0, -1).join(', ')} ${conjunction} ${topics[topics.length - 1]}`;
}

/**
 * The starters above that a chat with no tools cannot be trusted to answer.
 *
 * Five of them are the trigger phrase of an intent whose data is NOT in what a turn is handed up
 * front (accuracy, anomalies, mood, next place, imports). The sixth, "What is on Brief", is: the
 * Brief snapshot rides on every turn. But a 1B model with no tools still invents Brief items now
 * and then (measured on gemma3:1b, the default tool-less model: one reply in four with the old
 * prompt, one in twenty after it was rebalanced, e.g. "send it to Trudy" when no such person is in
 * the data). A starter is the one question the app itself put in the person's mouth, and an
 * invented action in their Brief is worse than a starter that is not there.
 *
 * The other four (suggested actions, tomorrow, family, preferences) are covered by the Plan /
 * Forecast / Brief snapshots and the user context every turn carries, so they still work with
 * tools off.
 *
 * With tools off the empty Chat offers only those: a model that cannot call `places.next` answers
 * "Where do I usually go next" with a made-up place, a literal `tool_code` block, or the bare word
 * "Brief.list" (all seen on an iOS QA run).
 */
export const TOOL_STARTER_PROMPTS: ReadonlySet<string> = new Set([
  'What is on Brief', // brief.list: answerable from the snapshot, but still invented on a 1B model
  'How accurate are my predictions', // forecast.calibration
  'Anything unusual lately', // anomalies.recent
  'What is associated with my mood', // insights.explain
  'Where do I usually go next', // places.next
  'What can you import', // import.list_sources
]);
