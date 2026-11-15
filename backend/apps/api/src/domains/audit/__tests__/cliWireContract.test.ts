import type { RequestContext } from '@ci/common/context';
import type { NodeService } from '@ci/domains/graph';

import {
  asQueryString,
  expectFixtureShapes,
  readCliWireFixture,
} from '../../__tests__/support/cliWireFixtures';
import { AuditController, getDeltasSchema } from '../controllers/AuditController';
import type { Delta } from '../entities/DeltaEntity';
import type { DeltaService } from '../services/DeltaService';

/**
 * `ci audit deltas` against `GET /audit/deltas`, through the fixture both
 * suites read (see `__tests__/support/cliWireFixtures.ts`).
 *
 * The controller is the real one: it builds the `{ success, data }` envelope
 * and maps every delta, which is most of what the CLI reads. Only the two
 * services under it are stubbed, with rows typed as the service returns them.
 */

const FIXTURE = 'audit.json';
const OWNER = '00000000-0000-4000-8000-000000000001';

describe('the ci CLI against /audit/deltas', () => {
  const fixture = readCliWireFixture(FIXTURE);
  const query = fixture.deltas.query ?? {};

  /**
   * The schema drops keys it does not know. The CLI used to send its window as
   * `from`/`to`; both vanished here and every answer came back unfiltered.
   */
  it('reads every query parameter the CLI sends', () => {
    const parsed = getDeltasSchema.parse(asQueryString(query));

    expect(Object.keys(parsed).sort()).toEqual(Object.keys(query).sort());
    expect(parsed.since).toEqual(new Date(String(query.since)));
    expect(parsed.until).toEqual(new Date(String(query.until)));
  });

  it('answers in the shape the CLI is tested against', async () => {
    const entityId = String(query.entityId);
    const deltas: Delta[] = [
      {
        deltaId: '0193a3c4-0000-7000-8000-000000000001',
        entityId,
        relationshipId: null,
        nodeType: 'entity',
        entityType: 'Person',
        relationshipType: null,
        fromEntityId: null,
        toEntityId: null,
        changeType: 'updated',
        changedFields: { email: { old: null, new: 'ada@example.com' } },
        changeSource: 'enrichment',
        changeReason: 'contact merged from an import',
        summaryId: null,
        changedAt: new Date('2026-11-10T09:00:00.000Z'),
        changedByUserId: OWNER,
        ownerUserId: OWNER,
      },
    ];
    const findEvolutionForEntity = jest.fn(async () => deltas);
    const controller = new AuditController(
      { findEvolutionForEntity } as unknown as DeltaService,
      {
        findByIds: jest.fn(async () => [{ entityId, entityType: 'Person', name: 'Ada Lovelace' }]),
      } as unknown as NodeService,
    );

    const response = await controller.getDeltas(
      { userId: OWNER } as RequestContext,
      getDeltasSchema.parse(asQueryString(query)),
    );

    expect(findEvolutionForEntity).toHaveBeenCalledWith(
      { userId: OWNER },
      entityId,
      expect.objectContaining({ since: new Date(String(query.since)), until: new Date(String(query.until)) }),
    );
    expectFixtureShapes(FIXTURE, { deltas: response });
  });
});
