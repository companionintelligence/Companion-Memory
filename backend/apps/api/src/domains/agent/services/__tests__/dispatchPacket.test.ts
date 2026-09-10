import { buildDispatchPacket } from '../../dispatchPacket';

describe('buildDispatchPacket', () => {
  it('builds a four-turn briefing with the user ask last', () => {
    const packet = buildDispatchPacket({
      jobId: 'job-1',
      threadId: 'thread-1',
      taskId: 'task-1',
      title: 'Book the dentist',
      body: 'Mochi needs a cleaning',
      sourceKind: 'Task',
      sourceId: 'task-1',
      ask: 'Call Dr. Chen Friday morning',
    });

    expect(packet.mode).toBe('both');
    expect(packet.turns).toHaveLength(4);
    expect(packet.turns[0].role).toBe('system');
    expect(packet.turns[0].content).toContain('fail the same step twice');
    expect(packet.turns[3]).toEqual({
      role: 'user',
      content: 'Call Dr. Chen Friday morning',
    });
    expect(packet.turns[1].content).toContain('Mochi needs a cleaning');
  });

  it('defaults the ask to the title', () => {
    const packet = buildDispatchPacket({
      jobId: 'job-1',
      threadId: 'thread-1',
      title: 'File taxes',
      sourceKind: 'NoteType',
      sourceId: 'note-1',
    });

    expect(packet.turns[3].content).toBe('Do this: File taxes');
  });

  it('does not tell the harness its key is weaker than it is', () => {
    // The packet used to brief every dispatch with "Your connect key is write,
    // never full." That became false when the managed-app gate landed:
    // `capabilityForApp` mints ci-openclaw at FULL precisely so a destructive
    // intent becomes an approval card instead of a flat 403.
    //
    // A model that believes it holds only `write` will route AROUND the action
    // the gate exists to intercept, or read the TOOL_QUEUED 200 as a failure
    // and retry into duplicate cards. This packet is the harness's only in-band
    // statement of its own authority, so it has to be the true one.
    const packet = buildDispatchPacket({
      jobId: 'job-1',
      threadId: 'thread-1',
      title: 'Book the dentist',
      sourceKind: 'task',
      sourceId: 'task-1',
    });

    const system = packet.turns.map((turn) => turn.content).join('\n');

    expect(system).not.toMatch(/key is write/i);
    expect(system).not.toMatch(/never full/i);
  });

  it('tells the harness what a gated call actually does, and not to retry it', () => {
    const packet = buildDispatchPacket({
      jobId: 'job-1',
      threadId: 'thread-1',
      title: 'Book the dentist',
      sourceKind: 'task',
      sourceId: 'task-1',
    });

    const system = packet.turns.map((turn) => turn.content).join('\n');

    // The three facts a harness needs to behave correctly at the gate: the call
    // is queued rather than refused, the id it can name, and that re-issuing it
    // makes a second card rather than a status check.
    expect(system).toMatch(/TOOL_QUEUED/);
    expect(system).toMatch(/pendingActionId/);
    expect(system).toMatch(/SECOND card/i);
  });
});
