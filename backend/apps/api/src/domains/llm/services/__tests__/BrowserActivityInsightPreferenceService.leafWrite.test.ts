import type { UserServiceContext } from '@ci/common/context';
import {
  FakePropertiesRow,
  fakePersonServiceOver,
  flushAsync,
} from '@ci/domains/__tests__/support/plannerPropertiesRow';

import { BrowserActivityInsightPreferenceService } from '../BrowserActivityInsightPreferenceService';

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
    service: new BrowserActivityInsightPreferenceService(
      person.service as never,
      userContextService as never,
    ),
  };
}

/** Drives a `setEnabled` call past its one `findById` read (an existence check, not a stale-read hazard here — see the test below). */
async function setEnabled(
  service: BrowserActivityInsightPreferenceService,
  person: ReturnType<typeof fakePersonServiceOver>,
  enabled: boolean,
): Promise<boolean> {
  const write = service.setEnabled(CONTEXT, enabled);
  await flushAsync();
  person.pendingReads.forEach((release) => release());

  return write;
}

describe('BrowserActivityInsightPreferenceService.setEnabled writes one leaf', () => {
  it('sends `planner.browser_activity_insight_enabled` as a leaf path, never a rebuilt planner object', async () => {
    const { service, person } = harness();

    await setEnabled(service, person, true);

    expect(person.patchCalls).toStrictEqual([]);
    expect(person.leafCalls).toHaveLength(1);
    expect(person.leafCalls[0]!.map((leaf) => leaf.path.join('.'))).toStrictEqual([
      'planner.browser_activity_insight_enabled',
      'planner.source',
    ]);
    expect(person.leafCalls[0]![0]!.value).toBe(true);
  });

  it('does not touch a trust mode set alongside it', async () => {
    const { service, person, row } = harness();

    await setEnabled(service, person, true);

    expect(row.planner.browser_activity_insight_enabled).toBe(true);
    expect(row.planner.trust_mode).toBe('balanced');
  });
});

describe('BrowserActivityInsightPreferenceService.isEnabled', () => {
  it('defaults to false when the leaf was never set', async () => {
    const { service, person } = harness();

    const read = service.isEnabled(CONTEXT.userId!);
    await flushAsync();
    person.pendingReads.forEach((release) => release());

    await expect(read).resolves.toBe(false);
  });

  it('reflects a value written by setEnabled', async () => {
    const { service, person } = harness();

    await setEnabled(service, person, true);

    const read = service.isEnabled(CONTEXT.userId!);
    await flushAsync();
    person.pendingReads.forEach((release) => release());

    await expect(read).resolves.toBe(true);
  });
});
