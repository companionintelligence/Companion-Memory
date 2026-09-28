import type { Message as OllamaMessage } from 'ollama';

import { guardToolResultRound } from '@ci/common/prompt/untrustedBlock';

import { savedKnowledgeWrapUp } from '../OllamaService';

/**
 * `savedKnowledgeWrapUp` — the branchy pure function deciding whether a
 * tool-only assistant turn gets a synthetic "Saved." line appended so the user
 * is not left staring at silence after the model quietly called a write tool
 * and said nothing itself. Zero coverage before this file, despite being pure
 * and cheap to test exhaustively.
 */

function toolMsg(content: unknown): OllamaMessage {
  return { role: 'tool', content: typeof content === 'string' ? content : JSON.stringify(content) };
}

function assistantToolCall(): OllamaMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'memory.remember', arguments: {} } }],
  } as OllamaMessage;
}

function assistantProse(text: string): OllamaMessage {
  return { role: 'assistant', content: text };
}

describe('savedKnowledgeWrapUp', () => {
  it('returns null when the assistant never called a tool at all', () => {
    const messages: OllamaMessage[] = [
      { role: 'user', content: 'remember I like ramen' },
      assistantProse('Got it — remembered that you like ramen.'),
    ];

    expect(savedKnowledgeWrapUp(messages)).toBeNull();
  });

  it('returns null when the assistant already produced prose alongside the tool call', () => {
    const messages: OllamaMessage[] = [
      assistantToolCall(),
      toolMsg({ createdNodes: 1 }),
      assistantProse("I've saved that for you."),
    ];

    expect(savedKnowledgeWrapUp(messages)).toBeNull();
  });

  it('treats a <think>-only assistant message as having no prose', () => {
    // The thinking block is stripped before checking for real content — a
    // reasoning model that only "thought" and called a tool must still get
    // the "Saved." synthesis, not be mistaken for one that already answered.
    const messages: OllamaMessage[] = [
      {
        role: 'assistant',
        content: '<think>deciding what to remember</think>',
        tool_calls: assistantToolCall().tool_calls,
      } as OllamaMessage,
      toolMsg({ createdNodes: 2 }),
    ];

    expect(savedKnowledgeWrapUp(messages)).toBe('Saved.');
  });

  it('returns "Saved." for a tool-only turn that actually created nodes', () => {
    const messages: OllamaMessage[] = [
      assistantToolCall(),
      toolMsg({ createdNodes: 3, createdRelationships: 0 }),
    ];

    expect(savedKnowledgeWrapUp(messages)).toBe('Saved.');
  });

  it('counts createdRelationships toward the total, same as createdNodes', () => {
    const messages: OllamaMessage[] = [
      assistantToolCall(),
      toolMsg({ createdNodes: 0, createdRelationships: 2 }),
    ];

    expect(savedKnowledgeWrapUp(messages)).toBe('Saved.');
  });

  it('sums across MULTIPLE tool results in the same turn', () => {
    const messages: OllamaMessage[] = [
      assistantToolCall(),
      toolMsg({ createdNodes: 1 }),
      toolMsg({ createdNodes: 0, createdRelationships: 1 }),
    ];

    expect(savedKnowledgeWrapUp(messages)).toBe('Saved.');
  });

  it('returns null when a tool ran but created nothing (a lookup, not a write)', () => {
    const messages: OllamaMessage[] = [assistantToolCall(), toolMsg({ found: true })];

    expect(savedKnowledgeWrapUp(messages)).toBeNull();
  });

  it('skips a tool result reporting an error rather than counting it as a save', () => {
    const messages: OllamaMessage[] = [
      assistantToolCall(),
      toolMsg({ error: 'entity not found', createdNodes: 5 }), // createdNodes must be ignored alongside an error
    ];

    expect(savedKnowledgeWrapUp(messages)).toBeNull();
  });

  it('tolerates a non-JSON tool payload without throwing, and without counting it as a save', () => {
    const messages: OllamaMessage[] = [assistantToolCall(), toolMsg('not json at all')];

    expect(savedKnowledgeWrapUp(messages)).toBeNull();
  });

  it('still reads a save summary from the guarded first result of a round', () => {
    // `handleToolCalls` prefixes the round's first tool message with the
    // untrusted-content guard; the wrap-up must see through it or every
    // single-tool "remember this" turn would lose its "Saved." reply.
    const [guarded] = guardToolResultRound([JSON.stringify({ createdNodes: 1, createdRelationships: 0 })]);
    const messages: OllamaMessage[] = [assistantToolCall(), toolMsg(guarded)];

    expect(savedKnowledgeWrapUp(messages)).toBe('Saved.');
  });

  it('ignores tool messages with empty content', () => {
    const messages: OllamaMessage[] = [assistantToolCall(), { role: 'tool', content: '' }];

    expect(savedKnowledgeWrapUp(messages)).toBeNull();
  });

  it('a mix of a failed and a successful tool call still reports "Saved."', () => {
    const messages: OllamaMessage[] = [
      assistantToolCall(),
      toolMsg({ error: 'first tool failed' }),
      toolMsg({ createdNodes: 1 }),
    ];

    expect(savedKnowledgeWrapUp(messages)).toBe('Saved.');
  });
});
