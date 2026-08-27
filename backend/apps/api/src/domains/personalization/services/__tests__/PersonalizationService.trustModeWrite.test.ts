import type { UserServiceContext } from '@ci/common/context';
import {
  FakePropertiesRow,
  fakePersonServiceOver,
  flushAsync,
} from '@ci/domains/__tests__/support/plannerPropertiesRow';

import { PersonalizationService } from '../PersonalizationService';

const SELF_ID = 'self-entity-1';
const CONTEXT = { userId: 'user-1' } as UserServiceContext;

function harness() {
  const row = new FakePropertiesRow({
    first_name: 'Ada',
    planner: { trust_mode: 'balanced', source: 'onboarding' },
  });
  const person = fakePersonServiceOver(row, SELF_ID);
  const userContextService = { getSelfIdentity: async () => ({ entityId: SELF_ID }) };

  return {
    row,
    person,
    service: new PersonalizationService(person.service as never, userContextService as never),
  };
}

describe('PersonalizationService.updateTrustMode writes one leaf', () => {
  it('sends `planner.trust_mode` as a leaf path, never a rebuilt planner object', async () => {
    const { service, person } = harness();

    const write = service.updateTrustMode(CONTEXT, 'cautious');
    await flushAsync();
    person.pendingReads.forEach((release) => release());
    await write;

    // The top-level shallow merge is what loses other writers' leaves.
    expect(person.patchCalls).toStrictEqual([]);
    expect(person.leafCalls).toHaveLength(1);
    expect(person.leafCalls[0]!.map((leaf) => leaf.path.join('.'))).toStrictEqual([
      'planner.trust_mode',
      'planner.source',
    ]);
    expect(person.leafCalls[0]![0]!.value).toBe('cautious');
  });

  it('does not clobber a sibling leaf another writer committed after our read', async () => {
    const { service, person, row } = harness();

    // We read...
    const write = service.updateTrustMode(CONTEXT, 'cautious');
    await flushAsync();
    expect(person.pendingReads).toHaveLength(1);

    // ...the other settings writer (ImageDescriptionPreferenceService, whose
    // domain this spec may not import) commits its own leaf...
    row.setLeaves([{ path: ['planner', 'image_description_enabled'], value: true }]);

    // ...and only then does our write land.
    person.pendingReads.forEach((release) => release());
    await write;

    expect(row.planner.trust_mode).toBe('cautious');
    // Sending a rebuilt `planner` here would resurrect the pre-read absence.
    expect(row.planner.image_description_enabled).toBe(true);
    expect(row.properties.first_name).toBe('Ada');
  });
});
