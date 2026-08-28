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
 */
export const STARTER_PROMPTS: readonly string[] = [
  'What is on Brief', // brief.list
  'Any suggested actions', // suggestions.list
  'What does tomorrow look like for me', // forecast.read
  'How accurate are my predictions', // forecast.calibration
  'Anything unusual lately', // anomalies.recent
  'What is associated with my mood', // insights.explain
  'Where do I usually go next', // places.next
  'Who is my family', // knowledge family/relationships
  'What are my preferences', // preferences.get
  'What can you import', // import.list_sources
];
