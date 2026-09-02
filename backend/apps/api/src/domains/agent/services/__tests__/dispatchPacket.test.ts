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
});
