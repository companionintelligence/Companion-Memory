import { STAGE_ID_LIST, STAGE_IDS } from '@ci/domains/pipeline';

import { GraphUtilityService, PERSON_INDEX_LEDGER_STAGES } from '../GraphUtilityService';

/**
 * `dropStalePersonIndex` names the two person index stages as literals, because
 * the pipeline domain imports this one and importing `STAGE_IDS` back would be a
 * cycle. These pin the literals to the ids the pipeline actually declares, so a
 * renamed stage fails here instead of leaving the cleanup deleting nothing. The
 * SQL itself is exercised against Postgres in
 * `listeners/__tests__/GraphEventListener.personRetype.integration.test.ts`.
 */
describe('PERSON_INDEX_LEDGER_STAGES', () => {
  it('names the two stages that index a person, as the pipeline declares them', () => {
    expect([...PERSON_INDEX_LEDGER_STAGES].sort()).toEqual(
      [STAGE_IDS.INDEX_EMBED_PERSON, STAGE_IDS.INDEX_VECTOR_PERSON].sort(),
    );

    for (const stage of PERSON_INDEX_LEDGER_STAGES) {
      expect(STAGE_ID_LIST).toContain(stage);
    }
  });
});

describe('GraphUtilityService.dropStalePersonIndex', () => {
  function makeService(rows: unknown[]) {
    const query = jest.fn(async () => rows);
    const logger = { setContext: jest.fn() };
    const service = new GraphUtilityService({ query } as never, {} as never, logger as never);

    return { service, query };
  }

  it('binds the entity, its owner and the person stages, and reads the counts back', async () => {
    const { service, query } = makeService([{ vectors: 1, embeddings: 2, index_skips: 3, ledger: 4 }]);

    const dropped = await service.dropStalePersonIndex('owner-1', 'entity-1');

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("entity_type <> 'Person'"), [
      'entity-1',
      'owner-1',
      [...PERSON_INDEX_LEDGER_STAGES],
    ]);
    expect(dropped).toEqual({ vectors: 1, embeddings: 2, indexSkips: 3, ledger: 4 });
  });

  it('reports zeros when the statement returns no row', async () => {
    const { service } = makeService([]);

    expect(await service.dropStalePersonIndex('owner-1', 'entity-1')).toEqual({
      vectors: 0,
      embeddings: 0,
      indexSkips: 0,
      ledger: 0,
    });
  });
});
