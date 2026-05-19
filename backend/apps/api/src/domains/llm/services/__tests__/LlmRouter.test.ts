import type { LoggerService } from '@ci/common/logging';

import type { LlmProvider, LlmProviderCapabilities } from '../../providers/LlmProvider';
import { LlmRouter } from '../LlmRouter';

class FakeProvider implements LlmProvider {
  constructor(
    public readonly name: string,
    public readonly capabilities: LlmProviderCapabilities = {
      embed: true,
      chat: true,
      toolCalls: false,
      stream: true,
    },
  ) {}

  async embed() {
    return [0];
  }

  async chat() {
    return { text: this.name };
  }

  async *chatStream() {
    yield { delta: this.name, done: true };
  }
}

function makeLogger(): LoggerService {
  return {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as LoggerService;
}

describe('LlmRouter', () => {
  it('falls back to local-only providers when policy preference is local', () => {
    const local = new FakeProvider('ollama');
    const router = new LlmRouter(local as unknown as never, makeLogger());

    router.register(new FakeProvider('anthropic'));

    router.setPolicy('embed', {
      task: 'embed',
      preference: 'local',
      allowExternal: false,
      piiEgress: 'never',
    });

    expect(router.pickProvider('embed', 'embed').name).toBe('ollama');
  });

  it('prefers external when policy allows and preference != local', () => {
    const local = new FakeProvider('ollama');
    const router = new LlmRouter(local as unknown as never, makeLogger());

    router.register(new FakeProvider('anthropic'));

    router.setPolicy('chat', {
      task: 'chat',
      preference: 'high-quality',
      allowExternal: true,
      piiEgress: 'with-redaction',
    });

    expect(router.pickProvider('chat', 'chat').name).toBe('anthropic');
  });

  it('forces local when allowExternal is false even with high-quality preference', () => {
    const local = new FakeProvider('ollama');
    const router = new LlmRouter(local as unknown as never, makeLogger());

    router.register(new FakeProvider('anthropic'));

    router.setPolicy('chat', {
      task: 'chat',
      preference: 'high-quality',
      allowExternal: false,
      piiEgress: 'never',
    });

    expect(router.pickProvider('chat', 'chat').name).toBe('ollama');
  });

  it('throws when no provider exposes the required capability', () => {
    const noStream = new FakeProvider('ollama', { embed: true, chat: true, toolCalls: false, stream: false });
    const router = new LlmRouter(noStream as unknown as never, makeLogger());

    expect(() => router.pickProvider('chat', 'stream')).toThrow();
  });
});
