import { GUARDS_METADATA } from '@nestjs/common/constants';

import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { GraphResolver } from '../GraphResolver';

describe('GraphResolver', () => {
  // It was the one resolver without a guard: anonymous callers failed only because no strategy set
  // the request context, which skipped the guard's own checks (a deleted account, a key's capability).
  it('runs the same authentication guard as every other resolver', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, GraphResolver)).toContain(JwtOrApiKeyAuthGuard);
  });
});
