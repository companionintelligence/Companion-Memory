import type { OrchestrateStage } from '@ci/domains/maintenance';

/**
 * Bulk `/v1` destination → enrichment legs the rows owe after materialize.
 *
 * Mirrored on the device outbox (`outboxFlush.ts`). GPS-only never owes
 * `extract_graph`. `search_index` for positions is the same orchestrate leg
 * (now includes `position` in BACKFILLABLE_ENTITIES); the listener downsamples.
 */
export const INGEST_KIND_STAGES = {
  events: ['geocode', 'reverse_geocode', 'link_events', 'search_index'],
  communications: ['extract_people', 'link_communications', 'search_index'],
  content: ['search_index'],
  things: ['reverse_object', 'search_index'],
  browser_activity: ['search_index'],
  position: ['reverse_position', 'estimate_locations', 'search_index'],
} as const satisfies Record<string, readonly OrchestrateStage[]>;

export type IngestKind = keyof typeof INGEST_KIND_STAGES;

/**
 * Server self-heal runs the union of every kind's owed stages so a delayed
 * singleton cannot drop a later kind's keys. Never includes `extract_graph`.
 */
export const COALESCE_STAGES: readonly OrchestrateStage[] = [
  'extract_people',
  'link_communications',
  'link_events',
  'geocode',
  'reverse_geocode',
  'reverse_position',
  'reverse_object',
  'estimate_locations',
  'search_index',
];

export function stagesForDestination(destination: string): readonly OrchestrateStage[] {
  if (destination === 'browser_activity') {
    return INGEST_KIND_STAGES.browser_activity;
  }

  if (destination in INGEST_KIND_STAGES) {
    return INGEST_KIND_STAGES[destination as IngestKind];
  }

  return [];
}
