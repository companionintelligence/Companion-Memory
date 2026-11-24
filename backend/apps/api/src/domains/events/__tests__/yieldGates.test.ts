import { YIELD_GATE_TIMEOUT_MS, YieldGateRegistry } from '../yieldGates';

/**
 * The registry's one rule: a gate that cannot give a straight answer reads as
 * OPEN, so a broken gate costs GPU contention and never a frozen queue. The
 * worker loop tests in PGBossEventService.worker.spec.ts cover the same rule
 * end to end; these pin the registry's own contract.
 */
describe('YieldGateRegistry.shouldYield', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    YieldGateRegistry.clear();
    jest.useRealTimers();
  });

  it('passes an answer given in time straight through', async () => {
    YieldGateRegistry.register('gate', async () => true);

    await expect(YieldGateRegistry.shouldYield('gate')).resolves.toBe(true);
  });

  it('reads a gate that never answers as open once the bound passes', async () => {
    YieldGateRegistry.register('gate', () => new Promise<boolean>(() => undefined));

    let answer: boolean | undefined;
    void YieldGateRegistry.shouldYield('gate').then((value) => {
      answer = value;
    });

    await jest.advanceTimersByTimeAsync(YIELD_GATE_TIMEOUT_MS - 1);
    expect(answer).toBeUndefined();

    await jest.advanceTimersByTimeAsync(1);
    expect(answer).toBe(false);
  });

  it('reads a gate that throws synchronously as open', async () => {
    YieldGateRegistry.register('gate', () => {
      throw new Error('database gone');
    });

    await expect(YieldGateRegistry.shouldYield('gate')).resolves.toBe(false);
  });

  it('absorbs a rejection that arrives after the bound', async () => {
    let rejectLate: (reason: Error) => void = () => undefined;

    YieldGateRegistry.register(
      'gate',
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectLate = reject;
        }),
    );

    const answer = YieldGateRegistry.shouldYield('gate', 10);

    await jest.advanceTimersByTimeAsync(10);
    await expect(answer).resolves.toBe(false);

    // Unhandled, this would be a process exit (application.ts).
    rejectLate(new Error('late'));
    await jest.advanceTimersByTimeAsync(1);
  });
});
