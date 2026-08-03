import type { Message as OllamaMessage, Tool } from 'ollama';

import { toOpenAiMessages, toOpenAiTools } from '../OpenAiCompatChatDriver';

describe('toOpenAiMessages', () => {
  it('passes plain system/user/assistant messages through', () => {
    const messages: OllamaMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ];

    expect(toOpenAiMessages(messages)).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ]);
  });

  it('pairs positional Ollama tool results with synthesized tool_call ids', () => {
    const messages: OllamaMessage[] = [
      { role: 'user', content: 'What is the weather in two cities?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'get_weather', arguments: { city: 'Oslo' } } },
          { function: { name: 'get_weather', arguments: { city: 'Lima' } } },
        ],
      },
      { role: 'tool', content: '{"temp":3}' },
      { role: 'tool', content: '{"temp":24}' },
    ];

    const converted = toOpenAiMessages(messages);
    const assistant = converted[1] as {
      tool_calls: { id: string; function: { name: string; arguments: string } }[];
    };

    expect(assistant.tool_calls).toHaveLength(2);
    expect(assistant.tool_calls[0].function.arguments).toBe('{"city":"Oslo"}');

    // The Nth tool message must reference the Nth assistant tool_call id.
    expect(converted[2]).toEqual({
      role: 'tool',
      tool_call_id: assistant.tool_calls[0].id,
      content: '{"temp":3}',
    });
    expect(converted[3]).toEqual({
      role: 'tool',
      tool_call_id: assistant.tool_calls[1].id,
      content: '{"temp":24}',
    });
    expect(assistant.tool_calls[0].id).not.toBe(assistant.tool_calls[1].id);
  });

  it('converts Ollama image attachments to data-URL content parts', () => {
    const messages: OllamaMessage[] = [
      { role: 'user', content: 'Describe this', images: ['aGVsbG8='] as unknown as Uint8Array[] },
    ];

    const [converted] = toOpenAiMessages(messages);

    expect(converted.content).toEqual([
      { type: 'text', text: 'Describe this' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aGVsbG8=' } },
    ]);
  });
});

describe('toOpenAiTools', () => {
  it('maps the Ollama tool schema onto OpenAI function tools', () => {
    const tools: Tool[] = [
      {
        type: 'function',
        function: {
          name: 'memory_search',
          description: 'Search memory',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Search query' } },
            required: ['query'],
          },
        },
      },
    ];

    expect(toOpenAiTools(tools)).toEqual([
      {
        type: 'function',
        function: {
          name: 'memory_search',
          description: 'Search memory',
          parameters: tools[0].function.parameters,
        },
      },
    ]);
  });
});
