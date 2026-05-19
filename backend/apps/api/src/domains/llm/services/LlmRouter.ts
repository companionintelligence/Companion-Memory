import { Inject, Injectable, Optional } from '@nestjs/common';

import { ContextService } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { DEFAULT_MODEL_POLICIES, type ModelPolicy } from '../policy/ModelPolicy';
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatResponseChunk,
  EmbedOptions,
  LlmProvider,
  LlmTask,
} from '../providers/LlmProvider';
import { OllamaProvider } from '../providers/OllamaProvider';

import { LlmInvocationLogger } from './LlmInvocationLogger';

/**
 * Plan 04 §3.3 — picks the right provider per task. Today only OllamaProvider
 * is registered, so every call routes locally; AnthropicProvider /
 * OpenAIProvider will register themselves in follow-ups when the user has a
 * provider_key configured and the policy allows external.
 *
 * Callers describe their *task*, not their *model*. Model selection is the
 * router's job.
 */
@Injectable()
export class LlmRouter {
  private readonly providers = new Map<string, LlmProvider>();

  private policies: Record<LlmTask, ModelPolicy> = DEFAULT_MODEL_POLICIES;

  constructor(
    private readonly ollama: OllamaProvider,
    private readonly logger: LoggerService,
    // Optional so the unit test (which instantiates LlmRouter directly) keeps
    // working. Production wires the logger via Nest DI.
    @Optional() @Inject(LlmInvocationLogger) private readonly invocationLogger?: LlmInvocationLogger,
  ) {
    this.logger.setContext(LlmRouter.name);
    this.register(ollama);
  }

  register(provider: LlmProvider): void {
    this.providers.set(provider.name, provider);
    this.logger.log('LLM provider registered', { name: provider.name });
  }

  setPolicy(task: LlmTask, policy: ModelPolicy): void {
    this.policies[task] = policy;
  }

  getPolicy(task: LlmTask): ModelPolicy {
    return this.policies[task];
  }

  /**
   * Pick a provider for the given task. Today this is always Ollama; once
   * AnthropicProvider/OpenAIProvider register themselves, this consults the
   * policy and the available provider keys (plan 04 §3.3).
   */
  pickProvider(task: LlmTask, requiredCapability: keyof LlmProvider['capabilities']): LlmProvider {
    const candidates = [...this.providers.values()].filter((p) => p.capabilities[requiredCapability]);

    if (candidates.length === 0) {
      throw new Error(
        `No LLM provider available with capability '${String(requiredCapability)}' for task ${task}`,
      );
    }

    // Stable default: prefer 'ollama' for local-friendly tasks, fall back to
    // first registered for anything else. The full policy-driven selection
    // lands when an external provider is added.
    const local = candidates.find((p) => p.name === 'ollama');
    const policy = this.policies[task];

    if (policy.preference === 'local' || !policy.allowExternal) {
      return local ?? candidates[0];
    }

    // 'balanced' / 'high-quality': pick the first non-local if any, else local.
    const external = candidates.find((p) => p.name !== 'ollama');

    return external ?? local ?? candidates[0];
  }

  async embed(task: LlmTask, text: string, opts: EmbedOptions = {}): Promise<number[]> {
    const provider = this.pickProvider(task, 'embed');
    const startedAt = Date.now();
    let status: 'ok' | 'error' = 'ok';
    let errorKind: string | undefined;

    try {
      return await provider.embed(text, opts);
    } catch (err) {
      status = 'error';
      errorKind = err instanceof Error ? err.name : 'UnknownError';
      throw err;
    } finally {
      this.recordInvocation({
        task,
        provider: provider.name,
        model: opts.model ?? 'default',
        latencyMs: Date.now() - startedAt,
        status,
        errorKind,
      });
    }
  }

  async chat(task: LlmTask, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    const provider = this.pickProvider(task, 'chat');
    const startedAt = Date.now();
    let status: 'ok' | 'error' = 'ok';
    let errorKind: string | undefined;
    let response: ChatResponse | undefined;

    try {
      response = await provider.chat(messages, opts);

      return response;
    } catch (err) {
      status = 'error';
      errorKind = err instanceof Error ? err.name : 'UnknownError';
      throw err;
    } finally {
      this.recordInvocation({
        task,
        provider: provider.name,
        model: opts.model ?? 'default',
        latencyMs: Date.now() - startedAt,
        inputTokens: response?.usage?.inputTokens,
        outputTokens: response?.usage?.outputTokens,
        status,
        errorKind,
      });
    }
  }

  async *chatStream(
    task: LlmTask,
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): AsyncIterable<ChatResponseChunk> {
    const provider = this.pickProvider(task, 'stream');
    const startedAt = Date.now();
    let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
    let status: 'ok' | 'error' | 'aborted' = 'ok';
    let errorKind: string | undefined;

    try {
      for await (const chunk of provider.chatStream(messages, opts)) {
        if (chunk.usage) {
          lastUsage = chunk.usage;
        }

        yield chunk;
      }
    } catch (err) {
      const aborted = err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
      status = aborted ? 'aborted' : 'error';
      errorKind = err instanceof Error ? err.name : 'UnknownError';
      throw err;
    } finally {
      this.recordInvocation({
        task,
        provider: provider.name,
        model: opts.model ?? 'default',
        latencyMs: Date.now() - startedAt,
        inputTokens: lastUsage?.inputTokens,
        outputTokens: lastUsage?.outputTokens,
        status,
        errorKind,
      });
    }
  }

  private recordInvocation(record: {
    task: LlmTask;
    provider: string;
    model: string;
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
    status: 'ok' | 'error' | 'aborted';
    errorKind?: string;
  }): void {
    if (!this.invocationLogger) {
      return;
    }

    const ctx = ContextService.getContext();

    this.invocationLogger.record({
      ...record,
      actorId: ctx?.actorId ?? ctx?.userId,
    });
  }
}
