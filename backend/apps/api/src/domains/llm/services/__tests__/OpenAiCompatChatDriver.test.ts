import type { Message as OllamaMessage, Tool } from 'ollama';

import config from '@ci/configuration';

import {
  extractEmbeddedToolCalls,
  isResponseFormatRejection,
  OpenAiCompatChatDriver,
  toOpenAiMessages,
  toOpenAiTools,
  toResponseFormat,
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

  it('joins neighbouring text turns of one role, which the Qwen template refuses at the end of a transcript', () => {
    // The thread-title job's excerpt of a tool turn: every assistant row kept, the tool rows dropped.
    const result = toOpenAiMessages([
      { role: 'user', content: 'find rabbits' },
      { role: 'assistant', content: 'Looking.' },
      { role: 'assistant', content: 'The tool threw an error.' },
      { role: 'assistant', content: 'Here are three photos.' },
    ]);

    expect(result).toEqual([
      { role: 'user', content: 'find rabbits' },
      { role: 'assistant', content: 'Looking.\n\nThe tool threw an error.\n\nHere are three photos.' },
    ]);
  });

  it('keeps assistant tool-call turns and their tool results apart from the text around them', () => {
    const result = toOpenAiMessages([
      { role: 'user', content: 'find rabbits' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'media_findPhotos', arguments: { query: 'rabbits' } } }],
      },
      { role: 'tool', content: '[]' },
      { role: 'assistant', content: 'Nothing found.' },
      { role: 'assistant', content: 'Sorry.' },
    ]);

    expect(result.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(result[3]).toEqual({ role: 'assistant', content: 'Nothing found.\n\nSorry.' });
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

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

describe('toResponseFormat', () => {
  it("maps Ollama's format onto the OpenAI response_format", () => {
    expect(toResponseFormat(undefined)).toBeUndefined();
    expect(toResponseFormat('json')).toEqual({ type: 'json_object' });
    expect(toResponseFormat(SCHEMA)).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: SCHEMA },
    });
  });

  it('degrades a schema to json_object once the backend has refused schemas', () => {
    expect(toResponseFormat(SCHEMA, true)).toEqual({ type: 'json_object' });
  });
});

describe('isResponseFormatRejection', () => {
  const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

  it('recognises a 4xx that blames the response format', () => {
    expect(isResponseFormatRejection(apiError(400, '400 response_format json_schema is not supported'))).toBe(
      true,
    );
    expect(isResponseFormatRejection(apiError(400, '400 Failed to parse grammar'))).toBe(true);
  });

  it('leaves every other failure alone', () => {
    expect(
      isResponseFormatRejection(apiError(400, '400 the request exceeds the available context size')),
    ).toBe(false);
    expect(isResponseFormatRejection(apiError(500, '500 json_schema backend crashed'))).toBe(false);
    expect(isResponseFormatRejection(new Error('fetch failed'))).toBe(false);
  });
});

describe('OpenAiCompatChatDriver.chat with a JSON Schema format', () => {
  function driverWith(create: jest.Mock) {
    const driver = new OpenAiCompatChatDriver('http://backend.invalid/v1', 'key');
    (
      driver as unknown as { client: { chat: { completions: { create: jest.Mock } } } }
    ).client.chat.completions.create = create;

    return driver;
  }

  const reply = { choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] };
  const request = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }], format: SCHEMA };

  it('sends json_schema', async () => {
    const create = jest.fn(async (_body: Record<string, unknown>) => reply);

    await driverWith(create).chat(request);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      response_format: { type: 'json_schema', json_schema: { name: 'response', schema: SCHEMA } },
    });
  });

  it('retries once with json_object when the backend refuses schemas, then stops asking', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('400 json_schema not supported'), { status: 400 }))
      .mockResolvedValue(reply);
    const driver = driverWith(create);

    await expect(driver.chat(request)).resolves.toMatchObject({ message: { content: '{"ok":true}' } });
    await driver.chat(request);

    expect(create.mock.calls.map(([body]) => body.response_format.type)).toEqual([
      'json_schema',
      'json_object',
      'json_object',
    ]);
  });

  it('does not retry an unrelated failure', async () => {
    const create = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('404 model not found'), { status: 404 }));

    await expect(driverWith(create).chat(request)).rejects.toThrow('model not found');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAiCompatChatDriver.chatStream and tool markup', () => {
  function streamingDriver(deltas: Array<Record<string, unknown>>) {
    const driver = new OpenAiCompatChatDriver('http://backend.invalid/v1', 'key');
    const create = jest.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        for (const delta of deltas) {
          yield { choices: [{ delta }] };
        }
      },
    }));
    (
      driver as unknown as { client: { chat: { completions: { create: jest.Mock } } } }
    ).client.chat.completions.create = create;

    return { driver, create };
  }

  async function collect(
    iterator: AsyncGenerator<{ message: { content?: string; tool_calls?: unknown[] } }>,
  ) {
    const content: string[] = [];
    const toolCalls: unknown[] = [];

    for await (const chunk of iterator) {
      if (chunk.message.content) {
        content.push(chunk.message.content);
      }

      toolCalls.push(...(chunk.message.tool_calls ?? []));
    }

    return { content: content.join(''), toolCalls };
  }

  // What Lemonade streamed in the forced prose round on 2026-09-30, as text.
  const apologyThenMarkup = [
    { content: 'The tool threw an error — maxResults was sent as a string. Retrying with a number.\n\n' },
    { content: '<tool_call>\n<function=media_findPhotos>\n<parameter=maxResults>\n15\n</parameter>\n' },
    { content: '<parameter=query>\nrabbits\n</parameter>\n</function>\n</tool_call>' },
  ];
  const request = { model: 'm', messages: [{ role: 'user' as const, content: 'rabbits' }] };

  it('salvages markup into a tool call on a salvage round', async () => {
    const { driver } = streamingDriver(apologyThenMarkup);

    const { content, toolCalls } = await collect(driver.chatStream({ ...request, salvageTools: true }));

    expect(content).toBe(
      'The tool threw an error — maxResults was sent as a string. Retrying with a number.',
    );
    expect(toolCalls).toEqual([
      { function: { name: 'media_findPhotos', arguments: { maxResults: '15', query: 'rabbits' } } },
    ]);
  });

  it('strips the markup and emits no tool call when told to discard it (the forced prose round)', async () => {
    const { driver } = streamingDriver(apologyThenMarkup);

    const { content, toolCalls } = await collect(driver.chatStream({ ...request, discardToolMarkup: true }));

    expect(content).toBe(
      'The tool threw an error — maxResults was sent as a string. Retrying with a number.',
    );
    expect(toolCalls).toEqual([]);
  });

  it("drops the engine's own structured tool calls too when discarding", async () => {
    const { driver } = streamingDriver([
      { content: 'One moment.' },
      {
        tool_calls: [{ index: 0, function: { name: 'media_findPhotos', arguments: '{"query":"rabbits"}' } }],
      },
    ]);

    const { content, toolCalls } = await collect(driver.chatStream({ ...request, discardToolMarkup: true }));

    expect(content).toBe('One moment.');
    expect(toolCalls).toEqual([]);
  });

  it('still streams plain text as it arrives when nothing about the round involves tools', async () => {
    const { driver } = streamingDriver([{ content: 'Hello' }, { content: ' there' }]);

    const { content } = await collect(driver.chatStream(request));

    expect(content).toBe('Hello there');
  });
});

describe('OpenAiCompatChatDriver.chat usage and deadline', () => {
  function driverWith(create: jest.Mock) {
    const driver = new OpenAiCompatChatDriver('http://backend.invalid/v1', 'key');
    (
      driver as unknown as { client: { chat: { completions: { create: jest.Mock } } } }
    ).client.chat.completions.create = create;

    return driver;
  }

  const request = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('reports the token counts the backend returned', async () => {
    const create = jest.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 5400, completion_tokens: 37, total_tokens: 5437 },
    }));

    await expect(driverWith(create).chat(request)).resolves.toMatchObject({
      prompt_eval_count: 5400,
      eval_count: 37,
    });
  });

  it('reports zero when the backend sent no usage block', async () => {
    const create = jest.fn(async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));

    await expect(driverWith(create).chat(request)).resolves.toMatchObject({
      prompt_eval_count: 0,
      eval_count: 0,
    });
  });

  async function streamed(chunks: Array<Record<string, unknown>>) {
    const create = jest.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    }));
    const out = [];

    for await (const chunk of driverWith(create).chatStream(request)) {
      out.push(chunk);
    }

    return out;
  }

  it('reports the usage block a stream ends with on the final chunk', async () => {
    // The usage block rides a last chunk with no choices at all.
    const chunks = await streamed([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [], usage: { prompt_tokens: 6690, completion_tokens: 178 } },
    ]);

    expect(chunks.at(-1)).toMatchObject({ done: true, prompt_eval_count: 6690, eval_count: 178 });
  });

  it('reports zero for a stream that carried no usage block', async () => {
    const chunks = await streamed([{ choices: [{ delta: { content: 'ok' } }] }]);

    expect(chunks.at(-1)).toMatchObject({ done: true, prompt_eval_count: 0, eval_count: 0 });
  });

  it('lets one call set its own deadline, and defaults to the configured one', async () => {
    const create = jest.fn(async (_body: unknown, _opts: { timeout?: number }) => ({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    }));
    const driver = driverWith(create);

    await driver.chat({ ...request, timeoutMs: 300_000 });
    await driver.chat(request);

    expect(create.mock.calls[0][1].timeout).toBe(300_000);
    expect(create.mock.calls[1][1].timeout).toBe(config.llm.firstResponseTimeoutMs);
  });
});
