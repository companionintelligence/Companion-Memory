import type { RequestContext } from '@ci/common/context';
import type { NodeService } from '@ci/domains/graph';

import type { Delta } from '../entities/DeltaEntity';
import type { DeltaService } from '../services/DeltaService';

import { AuditController, getDeltasSchema } from './AuditController';

const OWNER = '00000000-0000-4000-8000-000000000001';
const MERGED_AWAY = '00000000-0000-4000-8000-0000000000a1';
const KEPT = '00000000-0000-4000-8000-0000000000b1';

function delta(overrides: Partial<Delta>): Delta {
  return {
    deltaId: '0193a3c4-0000-7000-8000-000000000001',
    entityId: MERGED_AWAY,
    relationshipId: null,
    nodeType: 'entity',
    entityType: 'Person',
    relationshipType: null,
    fromEntityId: null,
    toEntityId: null,
    changeType: 'merged',
    changedFields: {},
    changeSource: 'PersonMergeService.mergePeople',
    changeReason: null,
    summaryId: null,
    changedAt: new Date('2026-11-15T06:21:44.000Z'),
    changedByUserId: OWNER,
    ownerUserId: OWNER,
    ...overrides,
  };
}

async function deltasFor(rows: Delta[]) {
  const names = new Map([
    [MERGED_AWAY, 'Yuki Tanaka'],
    [KEPT, 'Yuki T.'],
  ]);
  const findByIds = jest.fn(async (_context: unknown, ids: string[]) =>
    ids.map((id) => (names.has(id) ? { entityId: id, entityType: 'Person', name: names.get(id) } : null)),
  );
  const controller = new AuditController(
    { findEvolutionForEntity: jest.fn(async () => rows) } as unknown as DeltaService,
    { findByIds } as unknown as NodeService,
  );

  const response = await controller.getDeltas(
    { userId: OWNER } as RequestContext,
    getDeltasSchema.parse({ entityId: MERGED_AWAY }),
  );

  return response.data.deltas;
}

describe('AuditController.getDeltas', () => {
  it('names the record a merged-away one went into, so Change History can show a name instead of an id', async () => {
    const [merged] = await deltasFor([
      delta({
        changedFields: {
          merged_into_entity_id: { old: null, new: KEPT },
          is_active: { old: true, new: false },
        },
      }),
    ]);

    expect(merged.toEntity).toEqual({ entityId: KEPT, entityType: 'Person', name: 'Yuki T.' });
  });

  it('names it for a merge row written before the merge recorded its before values too', async () => {
    const [merged] = await deltasFor([
      delta({ changedFields: { name: { old: 'Yuki Tanaka' }, merged_into_entity_id: { new: KEPT } } }),
    ]);

    expect(merged.toEntity?.name).toBe('Yuki T.');
  });

  it('names the first record merged into a kept one, so its own page can say whom it took in', async () => {
    const OTHER = '00000000-0000-4000-8000-0000000000c1';
    const [kept] = await deltasFor([
      delta({
        entityId: KEPT,
        changedFields: {
          phones: { old: null, new: ['+1 555 010 0133'] },
          merged_from_entity_ids: { old: null, new: [MERGED_AWAY, OTHER] },
        },
      }),
    ]);

    expect(kept.fromEntity).toEqual({ entityId: MERGED_AWAY, entityType: 'Person', name: 'Yuki Tanaka' });
    expect(kept.toEntity).toBeNull();
  });

  it('leaves toEntity and fromEntity empty on an entity edit that is not a merge', async () => {
    const [edit] = await deltasFor([
      delta({ changeType: 'updated', changedFields: { name: { old: 'Yuki', new: 'Yuki Tanaka' } } }),
    ]);

    expect(edit.toEntity).toBeNull();
    expect(edit.fromEntity).toBeNull();
  });
});
