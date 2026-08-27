import { DEFAULT_FOLD_KEEP_TURNS, foldHistory, isSyntheticActionMessage } from '../foldHistory';

interface TestMessage {
  id: string;
  role: string;
  content: string;
  toolCalls?: Record<string, unknown>[] | null;
  images?: string[];
}

let seq = 0;

function user(content: string, extra: Partial<TestMessage> = {}): TestMessage {
  return { id: `u${seq++}`, role: 'user', content, toolCalls: null, ...extra };
}

function assistant(content: string, toolCalls: Record<string, unknown>[] | null = null): TestMessage {
  return { id: `a${seq++}`, role: 'assistant', content, toolCalls };
}

function toolResult(content: string): TestMessage {
  return { id: `t${seq++}`, role: 'tool', content, toolCalls: null };
}

function call(name: string): Record<string, unknown> {
  return { function: { name, arguments: {} } };
}

/**
 * The exact row shape `persistTurn` writes for one tool round: an assistant row
 * carrying `tool_calls` (usually with empty content), one `role: 'tool'` row per
 * call holding the stringified result, then the prose follow-up.
 */
function toolTurn(question: string, prose: string, results: string[]): TestMessage[] {
  return [
    user(question),
    assistant(
      '',
      results.map((_, index) => call(`tool_${index}`)),
    ),
    ...results.map((result) => toolResult(result)),
    assistant(prose),
  ];
}

beforeEach(() => {
  seq = 0;
});

describe('foldHistory', () => {
  it('leaves a thread shorter than the window completely untouched', () => {
    const messages = [...toolTurn('q1', 'a1', ['{"hits":1}']), ...toolTurn('q2', 'a2', ['{"hits":2}'])];

    expect(foldHistory(messages, 3)).toStrictEqual(messages);
    expect(foldHistory(messages, 3)).toHaveLength(messages.length);
  });

  it('drops the tool_calls payload and its paired tool rows together on stale turns', () => {
    const messages = [
      ...toolTurn('what did I do', 'you went running', ['{"events":["run"]}', '{"places":["park"]}']),
      user('q2'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
      user('q4'),
      assistant('a4'),
    ];

    const folded = foldHistory(messages, 3);

    expect(folded).toHaveLength(8);
    expect(folded.map((message) => message.role)).toStrictEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    // No tool row and no tool_calls array survives the fold.
    expect(folded.some((message) => message.role === 'tool')).toBe(false);
    expect(folded.every((message) => (message.toolCalls?.length ?? 0) === 0)).toBe(true);
    // And the raw result JSON is gone from the prompt entirely.
    expect(JSON.stringify(folded)).not.toContain('events');
    expect(JSON.stringify(folded)).not.toContain('places');
  });

  it('annotates the surviving assistant prose with the elided call count', () => {
    const messages = [
      ...toolTurn('q1', 'you went running', ['{"a":1}', '{"b":2}']),
      user('q2'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
      user('q4'),
    ];

    const folded = foldHistory(messages, 3);

    expect(folded[1]).toStrictEqual({
      ...messages[4],
      content: 'you went running\n\n(2 tool calls elided)',
    });
  });

  it('singularises the note for a single elided call', () => {
    const messages = [
      ...toolTurn('q1', 'done', ['{"a":1}']),
      user('q2'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
      user('q4'),
    ];

    expect(foldHistory(messages, 3)[1].content).toBe('done\n\n(1 tool call elided)');
  });

  it('keeps the newest K turns byte-for-byte, tool rows included', () => {
    const stale = toolTurn('q1', 'a1', ['STALE_RESULT_PAYLOAD']);
    const recent = [
      ...toolTurn('q2', 'a2', ['RECENT_RESULT_2']),
      ...toolTurn('q3', 'a3', ['RECENT_RESULT_3']),
      ...toolTurn('q4', 'a4', ['RECENT_RESULT_4']),
    ];

    const folded = foldHistory([...stale, ...recent], 3);

    expect(folded.slice(-recent.length)).toStrictEqual(recent);
    expect(folded.slice(-recent.length)).toHaveLength(12);
    expect(JSON.stringify(folded)).toContain('RECENT_RESULT_2');
    expect(JSON.stringify(folded)).not.toContain('STALE_RESULT_PAYLOAD');
  });

  it('preserves the user message verbatim inside a folded turn, images and all', () => {
    // resolveModel picks the vision model off `message.images`, which hang off
    // user messages. The rule keeps every user message, so model selection is
    // unchanged by the fold — pin it, because a variant that dropped an old
    // user message would silently change which model runs the turn.
    const withImage = user('what is this', { images: ['photo-key'] });
    const messages = [
      withImage,
      assistant('', [call('vision.describe')]),
      toolResult('{"caption":"a dog"}'),
      assistant('a dog'),
      user('q2'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
      user('q4'),
    ];

    const folded = foldHistory(messages, 3);

    expect(folded[0]).toStrictEqual(withImage);
    expect(folded.filter((message) => message.role === 'user')).toHaveLength(4);
    expect(folded.some((message) => (message.images?.length ?? 0) > 0)).toBe(true);
  });

  it('never folds the synthetic action prompt', () => {
    const action: TestMessage = {
      id: 'action:abc-123',
      role: 'assistant',
      content: 'Confirm your home address.',
      toolCalls: null,
    };
    const messages = [
      action,
      ...toolTurn('q1', 'a1', ['{"stale":true}']),
      user('q2'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
      user('q4'),
    ];

    const folded = foldHistory(messages, 3);

    expect(folded[0]).toStrictEqual(action);
    expect(isSyntheticActionMessage(action)).toBe(true);
    expect(isSyntheticActionMessage(messages[1])).toBe(false);
  });

  it('does not hang the elision note on the synthetic action prompt', () => {
    // The action prompt is an assistant row, so a naive "annotate the last
    // assistant message" would target it when the stale turn has no prose.
    const action: TestMessage = {
      id: 'action:abc-123',
      role: 'assistant',
      content: 'Confirm your home address.',
      toolCalls: null,
    };
    const messages = [
      action,
      user('q1'),
      assistant('', [call('memory.recall')]),
      toolResult('{"stale":true}'),
      user('q2'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
      user('q4'),
    ];

    const folded = foldHistory(messages, 3);

    expect(folded[0].content).toBe('Confirm your home address.');
    expect(folded[2]).toStrictEqual({
      ...messages[2],
      content: '(1 tool call elided)',
      toolCalls: null,
    });
  });

  it('will not annotate the synthetic action prompt even when it trails a stale turn', () => {
    // Today `ensureActionPrompt` always prepends, so the prompt lands before
    // the first user message. This pins the pure-function contract rather than
    // that ordering: the prompt is never rewritten, wherever it sits.
    const action: TestMessage = {
      id: 'action:abc-123',
      role: 'assistant',
      content: 'Confirm your home address.',
      toolCalls: null,
    };
    const messages = [
      user('q1'),
      assistant('', [call('memory.recall')]),
      toolResult('{"stale":true}'),
      action,
      user('q2'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
      user('q4'),
    ];

    const folded = foldHistory(messages, 3);

    expect(folded[1]).toStrictEqual(action);
    expect(folded[2]).toStrictEqual({
      ...messages[1],
      content: '(1 tool call elided)',
      toolCalls: null,
    });
  });

  it('keeps an assistant tool-call row that also carried prose', () => {
    const messages = [
      user('q1'),
      assistant('let me look that up', [call('memory.recall')]),
      toolResult('{"stale":true}'),
      user('q2'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
      user('q4'),
    ];

    const folded = foldHistory(messages, 3);

    expect(folded[1]).toStrictEqual({
      ...messages[1],
      content: 'let me look that up\n\n(1 tool call elided)',
      toolCalls: null,
    });
  });

  it('counts orphaned tool rows when the assistant call row is missing', () => {
    // An aborted turn can persist result rows whose announcing assistant row
    // never made it. The pair is still dropped, and the count still reports.
    const messages = [
      user('q1'),
      toolResult('{"stale":1}'),
      toolResult('{"stale":2}'),
      assistant('a1'),
      user('q2'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
      user('q4'),
    ];

    const folded = foldHistory(messages, 3);

    expect(folded[1].content).toBe('a1\n\n(2 tool calls elided)');
    expect(folded.some((message) => message.role === 'tool')).toBe(false);
  });

  it('leaves a stale turn that used no tools completely alone', () => {
    const messages = [
      user('q1'),
      assistant('a1'),
      user('q2'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
      user('q4'),
      assistant('a4'),
    ];

    expect(foldHistory(messages, 3)).toStrictEqual(messages);
  });

  it('folds every stale turn, not just the oldest', () => {
    const messages = [
      ...toolTurn('q1', 'a1', ['{"s":1}']),
      ...toolTurn('q2', 'a2', ['{"s":2}', '{"s":3}']),
      user('q3'),
      assistant('a3'),
      user('q4'),
      assistant('a4'),
      user('q5'),
    ];

    const folded = foldHistory(messages, 3);

    expect(folded.map((message) => message.content)).toStrictEqual([
      'q1',
      'a1\n\n(1 tool call elided)',
      'q2',
      'a2\n\n(2 tool calls elided)',
      'q3',
      'a3',
      'q4',
      'a4',
      'q5',
    ]);
  });

  it('does not mutate the messages it was handed', () => {
    const messages = [
      ...toolTurn('q1', 'a1', ['{"s":1}']),
      user('q2'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
      user('q4'),
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));

    foldHistory(messages, 3);

    expect(messages).toStrictEqual(snapshot);
  });

  it('folds every turn when the window is zero', () => {
    const messages = [...toolTurn('q1', 'a1', ['{"s":1}']), ...toolTurn('q2', 'a2', ['{"s":2}'])];

    const folded = foldHistory(messages, 0);

    expect(folded).toHaveLength(4);
    expect(folded.some((message) => message.role === 'tool')).toBe(false);
  });

  it('defaults to a generous window', () => {
    expect(DEFAULT_FOLD_KEEP_TURNS).toBe(3);

    const messages = [
      ...toolTurn('q1', 'a1', ['STALE_RESULT_PAYLOAD']),
      ...toolTurn('q2', 'a2', ['RECENT_RESULT_2']),
      ...toolTurn('q3', 'a3', ['RECENT_RESULT_3']),
      ...toolTurn('q4', 'a4', ['RECENT_RESULT_4']),
    ];

    expect(foldHistory(messages)).toStrictEqual(foldHistory(messages, DEFAULT_FOLD_KEEP_TURNS));
    expect(JSON.stringify(foldHistory(messages))).not.toContain('STALE_RESULT_PAYLOAD');
    expect(JSON.stringify(foldHistory(messages))).toContain('RECENT_RESULT_2');
  });

  it('handles an empty thread', () => {
    expect(foldHistory([] as TestMessage[], 3)).toStrictEqual([]);
  });
});
