import { SYSTEM_USER } from '@ci/common/context';

import { CommunicationSearchIndexListener } from '../CommunicationSearchIndexListener';

// The removal handler is the cascade-delete that stops new orphans from row
// deletes (#1). It must delete BOTH the embedding and the vector for the
// (entity_type, entity_id) pair, under the system context, regardless of which
// user originally owned the row.
describe('CommunicationSearchIndexListener.indexRemove', () => {
  function makeListener() {
    const embeddingService = { remove: jest.fn().mockResolvedValue(true) };
    const vectorService = { remove: jest.fn().mockResolvedValue(true) };
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const listener = new CommunicationSearchIndexListener(
      null as never, // communicationService — unused by indexRemove
      null as never, // embeddingGenerationService — unused by indexRemove
      embeddingService as never,
      vectorService as never,
      logger as never,
    );

    return { listener, embeddingService, vectorService };
  }

  it('removes the embedding and the vector keyed by (communication, id)', async () => {
    const { listener, embeddingService, vectorService } = makeListener();

    await listener.indexRemove({ communicationId: 'comm-123' } as never);

    expect(embeddingService.remove).toHaveBeenCalledTimes(1);
    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'communication', entityId: 'comm-123' },
    );

    expect(vectorService.remove).toHaveBeenCalledTimes(1);
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'communication', entityId: 'comm-123' },
    );
  });
});
