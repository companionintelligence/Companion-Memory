import { ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { OutboundPolicyStore } from '@ci/common/outbound';

import { OutboundPolicyService } from '../OutboundPolicyService';

function build() {
  const query = jest.fn().mockResolvedValue([{ updated_at: new Date('2026-10-03T00:00:00Z') }]);
  const service = new OutboundPolicyService({ query } as unknown as DataSource);

  return { service, query };
}

describe('OutboundPolicyService', () => {
  beforeEach(async () => {
    await OutboundPolicyStore.configure(null);
  });

  afterAll(() => OutboundPolicyStore.stop());

  it('reports every path on by default, in contract order', () => {
    const { paths } = build().service.get();

    expect(paths.map((p) => p.key)).toEqual([
      'crash_reports',
      'place_lookups',
      'link_previews',
      'portal_oauth',
    ]);
    expect(paths.every((p) => p.enabled && !p.locked)).toBe(true);
  });

  it('persists a switch-off and applies it to this process immediately', async () => {
    const { service, query } = build();

    const result = await service.set('place_lookups', false, 'user-1');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ci.outbound_settings'), [
      'place_lookups',
      false,
      'user-1',
    ]);
    expect(result.paths.find((p) => p.key === 'place_lookups')).toMatchObject({
      enabled: false,
      effective: false,
    });
  });

  it('refuses to switch on a path the operator has locked', async () => {
    const original = process.env.CI_LOCAL_ONLY;
    process.env.CI_LOCAL_ONLY = 'true';

    try {
      const { service, query } = build();

      await expect(service.set('crash_reports', true, 'user-1')).rejects.toBeInstanceOf(ConflictException);
      expect(query).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete process.env.CI_LOCAL_ONLY;
      } else {
        process.env.CI_LOCAL_ONLY = original;
      }
    }
  });
});
