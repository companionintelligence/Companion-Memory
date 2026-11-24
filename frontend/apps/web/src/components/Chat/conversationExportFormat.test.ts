import { describe, expect, it } from 'vitest';

import { buildConversationExport } from './conversationExportFormat';

const messages = [
  { role: 'user', content: 'What did I plan?' },
  { role: 'tool', content: 'Internal tool output' },
  {
    role: 'assistant',
    content: '<think>Private reasoning</think>Meet Sam [M1].',
    grounding: {
      status: 'retrieved',
      sources: [{ citation: 1, text: 'Sam at 10', voice: 'own', ref: { type: 'note', id: 'n1' } }],
    },
    incomplete: true,
  },
];

describe('conversation portability', () => {
  it('exports readable text with sources and incomplete status, excluding hidden reasoning/tool output', () => {
    const file = buildConversationExport('../../Morning 🌞', messages, 'txt');
    expect(file.filename).toBe('Morning.txt');
    expect(file.content).toContain('Companion (incomplete reply)');
    expect(file.content).toContain('Meet Sam [M1].');
    expect(file.content).toContain('[M1] Sam at 10');
    expect(file.content).not.toContain('Private reasoning');
    expect(file.content).not.toContain('Internal tool output');
  });

  it('keeps structured grounding and the original answer in JSON', () => {
    const file = buildConversationExport('Chat', messages, 'json');
    const data = JSON.parse(file.content);
    expect(data.version).toBe(1);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[1].grounding.sources[0].ref.id).toBe('n1');
    expect(data.messages[1].incomplete).toBe(true);
  });
});
