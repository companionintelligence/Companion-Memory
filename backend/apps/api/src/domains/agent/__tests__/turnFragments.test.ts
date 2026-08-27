import { buildTurnFragment, stripThinking, turnFragmentId } from '../turnFragments';

/**
 * The two rules that make the chat-turn producer safe to run on a loop:
 * the fragment id is a pure function of the TURN (never of its text), and the
 * fragment text never carries the model's reasoning block.
 */
describe('turnFragmentId', () => {
  const input = { userId: 'user-1', threadId: 'thread-1', promptMessageId: 'prompt-1' };

  it('is stable across calls', () => {
    expect(turnFragmentId(input)).toBe(turnFragmentId(input));
  });

  it('has UUID shape with the v8 variant bits set', () => {
    const id = turnFragmentId(input);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('separates users, threads and prompts', () => {
    const ids = new Set([
      turnFragmentId(input),
      turnFragmentId({ ...input, userId: 'user-2' }),
      turnFragmentId({ ...input, threadId: 'thread-2' }),
      turnFragmentId({ ...input, promptMessageId: 'prompt-2' }),
    ]);

    expect(ids.size).toBe(4);
  });
});

describe('stripThinking', () => {
  it('removes a closed reasoning block', () => {
    expect(stripThinking('<think>maybe it is Tuesday</think>It is Wednesday.')).toBe('It is Wednesday.');
  });

  it('removes an unterminated reasoning block from a cancelled stream', () => {
    expect(stripThinking('<think>still working on it')).toBe('');
  });

  it('leaves ordinary text alone', () => {
    expect(stripThinking('  Book the flight.  ')).toBe('Book the flight.');
  });
});

describe('buildTurnFragment', () => {
  const base = { maxSideChars: 2000, minFragmentChars: 40 };

  it('pairs the prompt with every assistant row of the turn', () => {
    const fragment = buildTurnFragment({
      ...base,
      threadTitle: 'Trip planning',
      prompt: 'Where should we stay in Lisbon for the Easter week?',
      replies: ['Looking at neighbourhoods.', 'Alfama suits you best.'],
    });

    expect(fragment).not.toBeNull();
    expect(fragment?.title).toBe('[chat-turn] Trip planning');
    expect(fragment?.content).toBe(
      'User: Where should we stay in Lisbon for the Easter week?\n' +
        'Assistant: Looking at neighbourhoods.\n\nAlfama suits you best.',
    );
  });

  it('never carries the reasoning block into the fragment', () => {
    const fragment = buildTurnFragment({
      ...base,
      threadTitle: null,
      prompt: 'Which of my colleagues speaks Portuguese?',
      replies: ['<think>Maybe Ana? No idea really.</think>Ana does, per her profile.'],
    });

    expect(fragment?.content).not.toContain('<think>');
    expect(fragment?.content).not.toContain('No idea really');
    expect(fragment?.content).toContain('Ana does, per her profile.');
    expect(fragment?.title).toBe('[chat-turn]');
  });

  it('skips a turn whose only assistant output was reasoning or tool calls', () => {
    expect(
      buildTurnFragment({
        ...base,
        prompt: 'What is on my calendar tomorrow morning before ten?',
        replies: ['', '<think>calling the calendar tool</think>'],
      }),
    ).toBeNull();
  });

  it('skips a pleasantry under the floor', () => {
    expect(buildTurnFragment({ ...base, prompt: 'thanks!', replies: ['np'] })).toBeNull();
  });

  it('clamps each side independently', () => {
    const fragment = buildTurnFragment({
      ...base,
      maxSideChars: 10,
      prompt: 'a'.repeat(200),
      replies: ['b'.repeat(200)],
    });

    expect(fragment?.content).toBe(`User: ${'a'.repeat(10)}…\nAssistant: ${'b'.repeat(10)}…`);
  });
});
