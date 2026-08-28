import { COALESCE_STAGES, INGEST_KIND_STAGES, stagesForDestination } from '../owedStages';

describe('owedStages', () => {
  it('never owes extract_graph for GPS or things', () => {
    expect(INGEST_KIND_STAGES.position).not.toContain('extract_graph');
    expect(INGEST_KIND_STAGES.things).not.toContain('extract_graph');
    expect(COALESCE_STAGES).not.toContain('extract_graph');
  });

  it('positions owe reverse_position rather than event reverse_geocode', () => {
    expect(INGEST_KIND_STAGES.position).toEqual(['reverse_position', 'estimate_locations', 'search_index']);
  });

  it('maps capture destinations onto the kind table', () => {
    expect(stagesForDestination('position')).toBe(INGEST_KIND_STAGES.position);
    expect(stagesForDestination('communications')).toBe(INGEST_KIND_STAGES.communications);
    expect(stagesForDestination('browser_activity')).toBe(INGEST_KIND_STAGES.browser_activity);
    expect(stagesForDestination('notes')).toEqual([]);
  });

  it('coalesce is the union of kind-owed stages without LLM graph', () => {
    const union = new Set<string>();
    for (const stages of Object.values(INGEST_KIND_STAGES)) {
      for (const stage of stages) {
        union.add(stage);
      }
    }

    expect(new Set(COALESCE_STAGES)).toEqual(union);
  });

  it('shares GPS reverse+estimate with the device outbox; search_index is server-only', () => {
    // Device POSITION_FINISH_STAGES in outboxFlush.ts is this prefix. Search
    // indexing of named GPS is the coalesce / finish search_index leg so a
    // phone drain does not wait on embeddings before ack.
    const DEVICE_POSITION_FINISH_STAGES = ['reverse_position', 'estimate_locations'];
    expect(INGEST_KIND_STAGES.position.slice(0, 2)).toEqual(DEVICE_POSITION_FINISH_STAGES);
    expect(INGEST_KIND_STAGES.position).toContain('search_index');
  });
});
