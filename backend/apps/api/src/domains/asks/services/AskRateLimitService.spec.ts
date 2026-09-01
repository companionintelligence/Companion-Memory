import { HttpException, HttpStatus } from '@nestjs/common';

import { InMemoryConsumptionStore } from '@ci/domains/consumption';

import { AskRateLimitService } from './AskRateLimitService';

function makeService() {
  const logger = { setContext: jest.fn() };

  return new AskRateLimitService(new InMemoryConsumptionStore(), logger as never);
}

/**
 * `consume` is ASYNC now that the window is durable (#2365), so every
 * expectation here awaits. That is not a formality: an unawaited call whose
 * limit was exceeded becomes an unhandled rejection rather than a caught 429,
 * which crashed the jest worker outright rather than failing a test.
 */
describe('AskRateLimitService.consume', () => {
  it('allows attempts under the per-user limit', async () => {
    const service = makeService();

    for (let i = 0; i < 20; i++) {
      await expect(service.consume('asker-1', 1_000 + i)).resolves.toBeUndefined();
    }
  });

  it('throws HTTP 429 once a SINGLE user exceeds the window limit', async () => {
    const service = makeService();

    for (let i = 0; i < 20; i++) {
      await service.consume('asker-1', 1_000 + i);
    }

    let caught: unknown;
    try {
      await service.consume('asker-1', 1_020);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect((caught as HttpException).getResponse()).toMatchObject({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      retryAfterMs: expect.any(Number),
    });
  });

  // The abuse control is PER-ASKER. A shared key (e.g. a bug that keyed the
  // window on something constant, or on the responder instead of the asker)
  // would let one asker's flood exhaust every other asker's allowance against
  // the same responder's inbox.
  it('keeps each userId in its OWN window — one user hitting the limit does not throttle another', async () => {
    const service = makeService();

    for (let i = 0; i < 20; i++) {
      await service.consume('asker-flood', 1_000 + i);
    }

    await expect(service.consume('asker-flood', 1_020)).rejects.toBeInstanceOf(HttpException);

    // A different asker, same instant, must be unaffected.
    await expect(service.consume('asker-quiet', 1_020)).resolves.toBeUndefined();
  });

  it('lets a user retry once their window has slid past the offending attempts', async () => {
    const service = makeService();

    for (let i = 0; i < 20; i++) {
      await service.consume('asker-1', i * 1000); // spread across the window
    }

    await expect(service.consume('asker-1', 19_000)).rejects.toBeInstanceOf(HttpException);

    // 61 seconds after the first attempt: the whole first window has expired.
    await expect(service.consume('asker-1', 61_000)).resolves.toBeUndefined();
  });
});
