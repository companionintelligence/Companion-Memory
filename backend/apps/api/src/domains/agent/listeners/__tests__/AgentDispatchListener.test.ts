import type { Acknowledgement } from '@ci/domains/events';

import { AgentDispatchListener } from '../AgentDispatchListener';

function makeAck(): Acknowledgement {
  return { jobId: 'pgboss-job-9', done: jest.fn(), fail: jest.fn(), defer: jest.fn() };
}

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), log: jest.fn(), warn: jest.fn() } as never;
}

/** The agent job's own uuid7, the id `ci.agent_jobs` is keyed on. */
const AGENT_JOB_ID = '01a061f8-755e-731f-9d11-a60906902ffa';

/**
 * The listener at the centre of the dispatch incident, which had no test at all.
 *
 * The event bus used to merge `jobId: <pgboss id>` into every delivered payload,
 * overwriting the agent job id this listener puts there. So the doorbell rang
 * for a job that does not exist: OpenClaw 404'd fetching its packet and the
 * stale reaper closed the job reporting that it had never checked in — blaming
 * the one part of the chain that was working.
 *
 * Nothing distinguished a correct fix from one that swapped the two ids the
 * other way round, which is exactly what these tests are for.
 */
describe('AgentDispatchListener.handleDispatch', () => {
  it('wakes the harness for the AGENT job, never the queue job', async () => {
    const doorbell = { wakeOpenClaw: jest.fn(async () => true) };
    const listener = new AgentDispatchListener(doorbell as never, makeLogger());
    const ack = makeAck();

    await listener.handleDispatch({ userId: 'user-1', jobId: AGENT_JOB_ID, threadId: 'thread-1' }, ack);

    expect(doorbell.wakeOpenClaw).toHaveBeenCalledWith(AGENT_JOB_ID);
    // The id that used to arrive here, and must not.
    expect(doorbell.wakeOpenClaw).not.toHaveBeenCalledWith('pgboss-job-9');
  });

  it('defers rather than completing, because the harness reports out of band', async () => {
    const doorbell = { wakeOpenClaw: jest.fn(async () => true) };
    const ack = makeAck();

    await new AgentDispatchListener(doorbell as never, makeLogger()).handleDispatch(
      { userId: 'user-1', jobId: AGENT_JOB_ID, threadId: 'thread-1' },
      ack,
    );

    expect(ack.defer).toHaveBeenCalledTimes(1);
    expect(ack.done).not.toHaveBeenCalled();
    expect(ack.fail).not.toHaveBeenCalled();
  });

  it('fails the job when the doorbell misses, so pg-boss retries it', async () => {
    // The retry path only became reachable once the doorbell stopped reporting
    // an undeliverable wake as delivered; this pins that it is still wired.
    const doorbell = { wakeOpenClaw: jest.fn(async () => false) };
    const ack = makeAck();

    await new AgentDispatchListener(doorbell as never, makeLogger()).handleDispatch(
      { userId: 'user-1', jobId: AGENT_JOB_ID, threadId: 'thread-1' },
      ack,
    );

    expect(ack.fail).toHaveBeenCalledTimes(1);
    expect(ack.defer).not.toHaveBeenCalled();
    // The message names the agent job, which is the id an operator can look up.
    expect(String((ack.fail as jest.Mock).mock.calls[0][0])).toContain(AGENT_JOB_ID);
  });
});
