import type { UserServiceContext } from '@ci/common/context';
import {
  FakePropertiesRow,
  fakePersonServiceOver,
  flushAsync,
} from '@ci/domains/__tests__/support/plannerPropertiesRow';

import { ImageDescriptionPreferenceService } from '../ImageDescriptionPreferenceService';

const SELF_ID = 'self-entity-1';
const CONTEXT = { userId: 'user-1' } as UserServiceContext;

function harness() {
  const row = new FakePropertiesRow({
    first_name: 'Ada',
    planner: { trust_mode: 'balanced', source: 'onboarding' },
  });
  const person = fakePersonServiceOver(row, SELF_ID);
  const userContextService = { getSelfIdentity: async () => ({ entityId: SELF_ID }) };
  const sent: unknown[] = [];
  const eventService = {
    send: async (...args: unknown[]) => {
      sent.push(args);
    },
  };

  return {
    row,
    person,
    sent,
    service: new ImageDescriptionPreferenceService(
      person.service as never,
      userContextService as never,
      eventService as never,
    ),
  };
}

describe('ImageDescriptionPreferenceService.setEnabled writes one leaf', () => {
  it('sends `planner.image_description_enabled` as a leaf path, never a rebuilt planner object', async () => {
    const { service, person } = harness();

    const write = service.setEnabled(CONTEXT, true);
    await flushAsync();
    person.pendingReads.forEach((release) => release());
    await write;

    expect(person.patchCalls).toStrictEqual([]);
    expect(person.leafCalls).toHaveLength(1);
    expect(person.leafCalls[0]!.map((leaf) => leaf.path.join('.'))).toStrictEqual([
      'planner.image_description_enabled',
      'planner.source',
    ]);
    expect(person.leafCalls[0]![0]!.value).toBe(true);
  });

  it('does not clobber a trust mode another writer committed after our read', async () => {
    const { service, person, row } = harness();

    const write = service.setEnabled(CONTEXT, true);
    await flushAsync();
    expect(person.pendingReads).toHaveLength(1);

    // The autonomy dial moves while we are holding a stale read of `planner`.
    row.setLeaves([{ path: ['planner', 'trust_mode'], value: 'cautious' }]);

    person.pendingReads.forEach((release) => release());
    await write;

    expect(row.planner.image_description_enabled).toBe(true);
    // Sending a rebuilt `planner` here would put trust_mode back to 'balanced',
    // silently widening what the appliance may do without asking.
    expect(row.planner.trust_mode).toBe('cautious');
  });

  it('still reads the prior value to decide whether to request a backfill', async () => {
    const { service, person, sent } = harness();

    const first = service.setEnabled(CONTEXT, true);
    await flushAsync();
    person.pendingReads.forEach((release) => release());
    await first;
    expect(sent).toHaveLength(1);

    service.invalidate(CONTEXT.userId!);
    const second = service.setEnabled(CONTEXT, true);
    await flushAsync();
    person.pendingReads.forEach((release) => release());
    await second;

    // Already enabled — no second backfill.
    expect(sent).toHaveLength(1);
  });
});
