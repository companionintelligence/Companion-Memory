import type { Message as OllamaMessage, Tool } from 'ollama';

import config from '@ci/configuration';

import {
  extractEmbeddedToolCalls,
  isReasoningEffortRejection,
  isResponseFormatRejection,
  OpenAiCompatChatDriver,
  thinkingBody,
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

/**
 * A model that calls a tool through text writes the markup as its reply, leads with it, or ends on
 * it. Markup inside an answer is a quote, often of an email subject or an invite title somebody
 * else wrote. These pin that only the first kind becomes a call, and only in a round that offered
 * tools.
 */
describe('tool markup salvage is limited to markup that opens or closes the reply', () => {
  const call =
    '<tool_call>\n<function=planning_create_task>\n<parameter=title>\nPay the deposit\n</parameter>\n</function>\n</tool_call>';

  it('salvages the whole reply, a leading block, and a trailing block', () => {
    for (const content of [call, `${call}\nI'll add that.`, `On it.\n${call}`, `${call}\n${call}`]) {
      const { toolCalls } = extractEmbeddedToolCalls(content);

      expect(toolCalls.length).toBeGreaterThan(0);
      expect(toolCalls[0].function).toEqual({
        name: 'planning_create_task',
        arguments: { title: 'Pay the deposit' },
      });
    }
  });

  it('does not salvage markup quoted in the middle of an answer, and still strips it from the prose', () => {
    const content = `You have two new emails.\n1. From the bank: ${call}\n2. From Jo: lunch on Friday?`;

    const { prose, toolCalls } = extractEmbeddedToolCalls(content);

    expect(toolCalls).toEqual([]);
    expect(prose).toBe('You have two new emails.\n1. From the bank: \n2. From Jo: lunch on Friday?');
  });

  it('does not salvage a bare function opener that runs on to the end of a prose reply', () => {
    const content =
      'The invite is titled <function=messaging_send><parameter=chatGuid>abc</parameter> and it starts at 9.';

    expect(extractEmbeddedToolCalls(content).toolCalls).toEqual([]);
  });

  it('does not salvage markup that fenceUntrusted or a tool result defanged', () => {
    expect(extractEmbeddedToolCalls(call.replace(/</g, '<­')).toolCalls).toEqual([]);
  });

  function driverReplying(content: string) {
    const driver = new OpenAiCompatChatDriver('http://backend.invalid/v1', 'key');
    (
      driver as unknown as { client: { chat: { completions: { create: jest.Mock } } } }
    ).client.chat.completions.create = jest.fn(async () => ({
      choices: [{ message: { role: 'assistant', content } }],
    }));

    return driver;
  }

  const tool: Tool = {
    type: 'function',
    function: { name: 'planning_create_task', description: 'Create a task', parameters: { type: 'object' } },
  };

  it('chat() turns markup into a call only when tools were offered', async () => {
    const request = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };

    const withTools = await driverReplying(call).chat({ ...request, tools: [tool] });
    const withoutTools = await driverReplying(call).chat(request);

    expect(withTools.message.tool_calls).toHaveLength(1);
    expect(withoutTools.message.tool_calls ?? []).toEqual([]);
  });

  it('chat() keeps quoted markup out of the reply though it runs nothing', async () => {
    const quoted = `You have one new email. From the bank: ${call} Reply when you can.`;

    const reply = await driverReplying(quoted).chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
    });

    expect(reply.message.tool_calls ?? []).toEqual([]);
    expect(reply.message.content).not.toContain('<tool_call>');
  });

  it('chatStream() turns markup into a call only when asked to salvage', async () => {
    const driver = new OpenAiCompatChatDriver('http://backend.invalid/v1', 'key');
    (
      driver as unknown as { client: { chat: { completions: { create: jest.Mock } } } }
    ).client.chat.completions.create = jest.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: call } }] };
      },
    }));

    const toolCalls: unknown[] = [];
    for await (const chunk of driver.chatStream({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
    })) {
      toolCalls.push(...(chunk.message.tool_calls ?? []));
    }

    expect(toolCalls).toEqual([]);
  });
});

/**
 * Ollama's `/v1` ignores `chat_template_kwargs`, so with only that switch a
 * thinking model reasoned through every background call that asked for
 * thinking off: answer inference on qwen3.5:9b spent 800 of 800 tokens and came
 * back empty, image descriptions on gemma4:e2b 256 of 256.
 */
describe('turning thinking off on every OpenAI-compatible backend', () => {
  const vllmRefusal = () =>
    Object.assign(
      new Error(
        "400 1 validation error for ChatCompletionRequest\nreasoning_effort\n  Input should be 'low', 'medium' or 'high'",
      ),
      { status: 400 },
    );

  function driverWith(create: jest.Mock) {
    const driver = new OpenAiCompatChatDriver('http://backend.invalid/v1', 'key');
    (
      driver as unknown as { client: { chat: { completions: { create: jest.Mock } } } }
    ).client.chat.completions.create = create;

    return driver;
  }

  const reply = { choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] };
  const request = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };
  const emptyStream = () => ({
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: 'ok' } }] };
    },
  });

  it('adds reasoning_effort "none" beside the vLLM switch whenever thinking is off', () => {
    expect(thinkingBody(undefined)).toEqual({
      chat_template_kwargs: { enable_thinking: false },
      reasoning_effort: 'none',
    });
    expect(thinkingBody(false)).toEqual({
      chat_template_kwargs: { enable_thinking: false },
      reasoning_effort: 'none',
    });
    expect(thinkingBody(true)).toEqual({ chat_template_kwargs: { enable_thinking: true } });
    expect(thinkingBody(false, true)).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });

  it('recognises a backend refusing the field, and nothing else', () => {
    expect(isReasoningEffortRejection(vllmRefusal())).toBe(true);
    expect(
      isReasoningEffortRejection(
        Object.assign(new Error("400 invalid reasoning value: 'none'"), { status: 400 }),
      ),
    ).toBe(true);
    expect(
      isReasoningEffortRejection(Object.assign(new Error('400 json_schema not supported'), { status: 400 })),
    ).toBe(false);
    expect(
      isReasoningEffortRejection(Object.assign(new Error('500 reasoning_effort crashed'), { status: 500 })),
    ).toBe(false);
    expect(isReasoningEffortRejection(new Error('fetch failed'))).toBe(false);
  });

  it('chat() sends it when thinking is off and leaves it out when thinking is on', async () => {
    const create = jest.fn(async (_body: Record<string, unknown>) => reply);
    const driver = driverWith(create);

    await driver.chat({ ...request, enableThinking: false });
    await driver.chat({ ...request, enableThinking: true });

    expect(create.mock.calls[0][0]).toMatchObject({
      reasoning_effort: 'none',
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(create.mock.calls[1][0]).not.toHaveProperty('reasoning_effort');
  });

  it('chat() retries once without it when the backend refuses it, then stops sending it', async () => {
    const create = jest.fn().mockRejectedValueOnce(vllmRefusal()).mockResolvedValue(reply);
    const driver = driverWith(create);

    await expect(driver.chat(request)).resolves.toMatchObject({ message: { content: '{"ok":true}' } });
    await driver.chat(request);

    expect(create.mock.calls.map(([body]) => 'reasoning_effort' in body)).toEqual([true, false, false]);
    expect(create.mock.calls[1][0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
  });

  it('chat() still falls back from json_schema on a backend that refuses both', async () => {
    const SCHEMA_ONLY = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const create = jest
      .fn()
      .mockRejectedValueOnce(vllmRefusal())
      .mockRejectedValueOnce(Object.assign(new Error('400 json_schema not supported'), { status: 400 }))
      .mockResolvedValue(reply);

    await driverWith(create).chat({ ...request, format: SCHEMA_ONLY });

    expect(
      create.mock.calls.map(([body]) => [body.response_format.type, 'reasoning_effort' in body]),
    ).toEqual([
      ['json_schema', true],
      ['json_schema', false],
      ['json_object', false],
    ]);
  });

  it('chat() does not retry a refusal when thinking was asked for', async () => {
    const create = jest.fn().mockRejectedValue(vllmRefusal());

    await expect(driverWith(create).chat({ ...request, enableThinking: true })).rejects.toThrow(
      'reasoning_effort',
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('chatStream() sends it, and retries once without it on a refusal', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(vllmRefusal())
      .mockImplementation(async () => emptyStream());
    const driver = driverWith(create);

    const drain = async () => {
      const chunks: unknown[] = [];

      for await (const chunk of driver.chatStream(request)) {
        chunks.push(chunk);
      }

      return chunks;
    };

    await expect(drain()).resolves.not.toHaveLength(0);
    await drain();

    expect(create.mock.calls.map(([body]) => 'reasoning_effort' in body)).toEqual([true, false, false]);
  });
});
