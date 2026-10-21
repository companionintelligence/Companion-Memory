import { OllamaPriorityQueue } from '../OllamaPriorityQueue';

describe('OllamaPriorityQueue', () => {
  it('dispatches higher-priority tasks (interactive > user_job > background) ahead of queued lower-priority work', async () => {
    let clock = 1_000;
    const queue = new OllamaPriorityQueue({
      maxConcurrent: 1,
      pauseBackgroundDuringInteractive: true,
      now: () => clock,
    });

    const order: string[] = [];
    let releaseFirst!: () => void;

    // Occupy the single slot with an initial user_job
    const firstRunning = queue.run('user_job', async () => {
      order.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first:end');
    });

    await Promise.resolve();

    // Enqueue background, then user_job, then interactive while slot is occupied
    clock = 1_100;
    const bgPromise = queue.run('background', async () => {
      order.push('background');
    });

    clock = 1_200;
    const jobPromise = queue.run('user_job', async () => {
      order.push('user_job');
    });

    clock = 1_300;
    const interactivePromise = queue.run('interactive', async () => {
      order.push('interactive');
    });

    expect(queue.getSnapshot().totalQueued).toBe(3);

    clock = 1_500;
    releaseFirst();
    await Promise.all([firstRunning, bgPromise, jobPromise, interactivePromise]);

    expect(order).toEqual(['first:start', 'first:end', 'interactive', 'user_job', 'background']);
    const snapshot = queue.getSnapshot();
    expect(snapshot.byPriority.interactive.completed).toBe(1);
    expect(snapshot.byPriority.user_job.completed).toBe(2);
    expect(snapshot.byPriority.background.completed).toBe(1);
    expect(snapshot.byPriority.interactive.avgWaitMs).toBe(200);
  });

  it('holds back background (P2) tasks while an interactive (P0) turn is in flight even with spare concurrency', async () => {
    const queue = new OllamaPriorityQueue({
      maxConcurrent: 2,
      pauseBackgroundDuringInteractive: true,
    });

    let releaseInteractive!: () => void;
    let backgroundStarted = false;

    const interactiveRun = queue.run('interactive', async () => {
      await new Promise<void>((resolve) => {
        releaseInteractive = resolve;
      });
    });

    const backgroundRun = queue.run('background', async () => {
      backgroundStarted = true;
    });

    // Yield a microtask turn: background must still be queued because interactive is in flight
    await Promise.resolve();
    expect(backgroundStarted).toBe(false);
    expect(queue.getSnapshot().byPriority.background.queued).toBe(1);

    releaseInteractive();
    await Promise.all([interactiveRun, backgroundRun]);
    expect(backgroundStarted).toBe(true);
  });

  it('evicts a queued task immediately when its AbortSignal fires without running the task body', async () => {
    const queue = new OllamaPriorityQueue({ maxConcurrent: 1 });
    let releaseFirst!: () => void;

    const first = queue.run('interactive', async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });

    const controller = new AbortController();
    let ranAbortedTask = false;
    const second = queue.run(
      'background',
      async () => {
        ranAbortedTask = true;
      },
      controller.signal,
    );

    controller.abort(new Error('caller timed out'));

    await expect(second).rejects.toThrow('caller timed out');
    expect(ranAbortedTask).toBe(false);
    expect(queue.getSnapshot().byPriority.background.abortedWhileQueued).toBe(1);

    releaseFirst();
    await first;
  });
});
