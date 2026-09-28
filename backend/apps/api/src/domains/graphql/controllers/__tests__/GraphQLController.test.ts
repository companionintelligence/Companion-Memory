import { NotFoundException } from '@nestjs/common';

import type { FeatureService } from '@ci/common/feature';

import { GraphQLController } from '../GraphQLController';

function features(enabled: boolean): FeatureService {
  return { isFeatureEnabled: jest.fn(async () => enabled) } as unknown as FeatureService;
}

describe('GraphQLController', () => {
  it('serves the IDE when the flag is on', async () => {
    const html = await new GraphQLController(features(true)).graphiql();

    expect(html).toContain('<html');
  });

  it('is a 404, not a page, when the flag is off (production default)', async () => {
    await expect(new GraphQLController(features(false)).graphiql()).rejects.toBeInstanceOf(NotFoundException);
  });
});
