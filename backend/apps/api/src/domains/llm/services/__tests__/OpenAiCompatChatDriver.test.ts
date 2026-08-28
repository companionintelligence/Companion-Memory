import type { Message as OllamaMessage, Tool } from 'ollama';

import {
  extractEmbeddedToolCalls,
  toOpenAiMessages,
  toOpenAiTools,
  vllmThinkingExtraBody,
} from '../OpenAiCompatChatDriver';

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

  it('hoists later system messages into a single leading system turn', () => {
    const messages: OllamaMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'system', content: 'Dossier: lives in NJ.' },
      { role: 'user', content: 'Hi' },
    ];

    expect(toOpenAiMessages(messages)).toEqual([
      { role: 'system', content: 'You are helpful.\n\nDossier: lives in NJ.' },
      { role: 'user', content: 'Hi' },
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

describe('extractEmbeddedToolCalls', () => {
  it('salvages Qwen3.6 XML tool markup that vLLM left in content', () => {
    const content = `Let me record this.

Calling memory_remember...
<toolcall>
<function=knowledgecreateEntity>
<parameter=entityType>
place
</parameter>
<parameter=name>
377 Example Ave
</parameter>
<parameter=properties>
{"address": "377 Example Ave"}
</parameter>
</function>
</toolcall`;

    const { prose, toolCalls } = extractEmbeddedToolCalls(content);

    expect(prose).toContain('Let me record this.');
    expect(prose).not.toContain('<toolcall>');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe('memory_remember');
    expect(toolCalls[0].function.arguments).toEqual({
      operations: [
        {
          kind: 'entity.create',
          entityType: 'place',
          name: '377 Example Ave',
          properties: { address: '377 Example Ave' },
        },
      ],
    });
  });

  it('parses qwen3_coder <tool_call> name-then-json blocks', () => {
    const { prose, toolCalls } = extractEmbeddedToolCalls(
      'On it.\n<tool_call>\nmemory_remember\n{"operations":[{"kind":"entity.create","entityType":"place","name":"Home"}]}\n</tool_call>',
    );

    expect(prose).toBe('On it.');
    expect(toolCalls[0].function.name).toBe('memory_remember');
    expect(toolCalls[0].function.arguments).toMatchObject({
      operations: [{ kind: 'entity.create', entityType: 'place', name: 'Home' }],
    });
  });

  it('sends enable_thinking false unless the UI explicitly turns thinking on', () => {
    expect(vllmThinkingExtraBody(undefined)).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(vllmThinkingExtraBody(false)).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(vllmThinkingExtraBody(true)).toEqual({
      chat_template_kwargs: { enable_thinking: true },
    });
  });

  it('maps mashed memoryremember XML onto memory_remember and strips the markup', () => {
    const content = `Calling memory_remember...
<toolcall>
<function=memoryremember>
<parameter=operations>
{"kind": "entity.create", "entity": {"entityType": "place", "name": "Example Home"}}
</parameter>
</function>
</toolcall`;

    const { prose, toolCalls } = extractEmbeddedToolCalls(content);

    expect(prose).not.toContain('<toolcall>');
    expect(toolCalls[0].function.name).toBe('memory_remember');
  });
});
