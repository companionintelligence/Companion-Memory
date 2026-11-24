import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { SidecarCircuitBreaker } from '../SidecarCircuitBreaker';

describe('SidecarCircuitBreaker', () => {
  it('opens after failureThreshold consecutive transient failures and short-circuits until resetTimeoutMs', async () => {
    let now = 10_000;
    const breaker = new SidecarCircuitBreaker({
      name: 'hbpe',
      failureThreshold: 3,
      resetTimeoutMs: 30_000,
      now: () => now,
    });

    let calls = 0;
    const failingOp = async () => {
      calls += 1;
      throw new ServiceUnavailableException('connection refused');
    };

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failingOp)).rejects.toThrow(ServiceUnavailableException);
    }

    expect(breaker.getSnapshot().state).toBe('OPEN');
    expect(calls).toBe(3);

    // Subsequent call within cooldown is short-circuited without invoking failingOp
    now = 20_000;
    await expect(breaker.execute(failingOp)).rejects.toThrow(/hbpe sidecar circuit is OPEN/);
    expect(calls).toBe(3);
    expect(breaker.getSnapshot().shortCircuitedCount).toBe(1);

    // Advance past resetTimeoutMs -> transitions to HALF_OPEN and allows a probe
    now = 45_000;
    expect(breaker.getSnapshot().state).toBe('HALF_OPEN');

    const recovered = await breaker.execute(async () => 'ok');
    expect(recovered).toBe('ok');
    expect(breaker.getSnapshot().state).toBe('CLOSED');
    expect(breaker.getSnapshot().consecutiveFailures).toBe(0);
  });

  it('does not trip the circuit on 401/4xx caller errors', async () => {
    const breaker = new SidecarCircuitBreaker({
      name: 'hbpe',
      failureThreshold: 2,
    });

    for (let i = 0; i < 5; i++) {
      await expect(
        breaker.execute(async () => {
          throw new UnauthorizedException('invalid user');
        }),
      ).rejects.toThrow(UnauthorizedException);
    }

    expect(breaker.getSnapshot().state).toBe('CLOSED');
    expect(breaker.getSnapshot().consecutiveFailures).toBe(0);
  });
});
