import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { type Message as OllamaMessage, type ToolCall } from 'ollama';

import { type RequestContext, type ServiceContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { fenceUntrusted, untrustedBlock } from '@ci/common/prompt/untrustedBlock';
import { Channel } from '@ci/common/rpc';
import { MessageService, ThreadService, type Message, type Thread } from '@ci/domains/conversations';
import { DescriptiveQuestionService } from '@ci/domains/daily-metrics';
import { Events, EventService, INTERACTIVE_JOB_PRIORITY } from '@ci/domains/events';
import { FileService } from '@ci/domains/files';
import { ActionService } from '@ci/domains/intelligence';
import { UserContextService } from '@ci/domains/memory';
import { TaskService } from '@ci/domains/planning';
import { HbpeService } from '@ci/domains/predictions';
import { SummaryService } from '@ci/domains/summaries';

import { LLM_QUEUE, type ThreadGenerationStatus } from '../constants';
import { ChatGenerateEvent, type ChatGeneratePayload } from '../events';
import { foldHistory } from '../foldHistory';
import { THREAD_TITLE_SYSTEM_PROMPT, sidebarTitleFromModel } from '../threadTitle';

import { ChatGenerationBroker } from './ChatGenerationBroker';
import { OllamaService, type ChatRequestContext } from './OllamaService';

interface TurnContextOptions {
  leadingAssistantMessages?: OllamaMessage[];
}

/**
 * Names the in-flight snapshot message the base prompt points the model at.
 * Exported so a test can assert none of it ever reaches the system prompt.
 */
export const TURN_CONTEXT_HEADER = '# Live snapshots (current as of this turn)';

/**
 * Same wrap {@link OllamaService.chatStream} uses when it accumulates a turn.
 * Reloading a finished (or throttled) row then parses `<think>` the same way a
 * live THINK+TEXT stream does.
 */
export function persistedAssistantContent(thinking: string, text: string): string {
  return thinking ? `<think>${thinking}</think>${text}` : text;
}

/**
 * Runs one queued chat turn: hydrate messages, call the model, fan tokens to
 * attached viewers, persist the assistant row. Closing the HTTP stream must
 * not stop this — only the broker abort signal does.
 */
@Injectable()
export class ChatTurnService {
  constructor(
    private readonly eventService: EventService,
    @Inject(forwardRef(() => ActionService))
    private readonly actionService: ActionService,
    private readonly messageService: MessageService,
    private readonly ollamaService: OllamaService,
    private readonly threadService: ThreadService,
    private readonly fileService: FileService,
    private readonly userContextService: UserContextService,
    private readonly taskService: TaskService,
    private readonly hbpeService: HbpeService,
    private readonly summaryService: SummaryService,
    private readonly descriptiveQuestionService: DescriptiveQuestionService,
    private readonly broker: ChatGenerationBroker,
    private readonly logger: LoggerService,
    private readonly featureService: FeatureService,
  ) {
    this.logger.setContext(ChatTurnService.name);
  }

  async setGenerationStatus(context: ServiceContext, threadId: string, status: ThreadGenerationStatus) {
    await this.threadService.update(context, threadId, { generationStatus: status });
  }

  async execute(payload: ChatGeneratePayload): Promise<void> {
    const requestContext: ChatRequestContext = {
      userId: payload.ownerId,
      capability: payload.capability,
    };
    const serviceContext = toServiceContext(requestContext);
    const signal = this.broker.signal(payload.threadId);
    const thread = await this.threadService.findById(serviceContext, payload.threadId);

    if (thread == null) {
      this.broker.complete(payload.threadId);

      return;
    }

    // Stop / delete set status to idle (and abort the broker) before this
    // worker may run — after an API restart there is no in-process signal.
    if (signal.aborted || thread.generationStatus === 'idle') {
      await this.finishCanceled(serviceContext, payload);

      return;
    }

    await this.setGenerationStatus(serviceContext, payload.threadId, 'running');

    const messages = await this.messageService.findByThreadId(serviceContext, thread.id);
    const conversation = messages.filter((message) => message.id !== payload.assistantMessageId);
    const seededMessages = await this.ensureActionPrompt(serviceContext, thread, conversation);
    // Turns older than the newest few replay as prose only: their tool_calls
    // and the paired role:'tool' result rows are dropped together. Folding
    // before resolveMessage also skips getFileContent for elided rows.
    const foldedMessages = foldHistory(seededMessages);
    const inputMessages: OllamaMessage[] = await Promise.all(
      foldedMessages.map((message) => this.resolveMessage(requestContext, message)),
    );

    const { model, enableThinking, enableTools } = await this.ollamaService.resolveModel(requestContext, {
      messages: inputMessages,
      requestedModel: payload.model,
      enableThinking: payload.enableThinking,
      enableTools: payload.enableTools,
    });

    const systemPromptEnabled = await this.featureService.isFeatureEnabled('enable.system.prompt');

    let leadingAssistantMessages: OllamaMessage[] = [];
    let conversationMessages = inputMessages;

    if (systemPromptEnabled) {
      [leadingAssistantMessages, conversationMessages] = this.extractLeadingAssistantMessages(inputMessages);
    }

    // The system prompt must stay byte-identical from turn to turn: it is the
    // prefix of every request, and a single changed byte invalidates the whole
    // KV prefix cache in llama.cpp / Ollama. Everything that moves between
    // turns (Plan / Forecast / Brief / Stats, and the proactive-suggestion
    // preamble) goes into `turnContext` instead, which is injected just before
    // the newest user turn — see `insertTurnContext`.
    const systemPrompt = systemPromptEnabled
      ? await this.buildSystemPrompt(requestContext)
      : await this.buildL0OnlySystemPrompt(requestContext);

    const turnContext = systemPromptEnabled
      ? await this.buildTurnContext(requestContext, { leadingAssistantMessages })
      : null;

    const messagesWithSystem: OllamaMessage[] = [
      ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
      ...this.insertTurnContext(conversationMessages, turnContext),
    ];

    let lastPersist = 0;
    let latestText = '';
    let latestThink = '';
    let failed = false;
    let generated: OllamaMessage[] = [];

    try {
      const stream = await this.ollamaService.chatStream(requestContext, messagesWithSystem, {
        model,
        signal,
        enableTools,
        enableThinking,
      });

      for await (const chunk of stream) {
        // Native Ollama can put thinking and content on the same chunk; vLLM
        // (OpenAI-compat) yields them as separate deltas. Handle both.
        if (chunk.message?.content) {
          latestText += chunk.message.content;
          this.broker.publish(payload.threadId, { channel: Channel.TEXT, text: chunk.message.content });
        }

        if (chunk.message?.thinking) {
          latestThink += chunk.message.thinking;
          this.broker.publish(payload.threadId, { channel: Channel.THINK, text: chunk.message.thinking });
        }

        if (chunk.message?.tool_calls?.length) {
          this.broker.publish(payload.threadId, {
            channel: Channel.TOOL,
            text: JSON.stringify(chunk.message.tool_calls),
          });
        }

        const now = Date.now();

        if ((latestText || latestThink) && now - lastPersist >= 500) {
          lastPersist = now;
          await this.messageService.update(serviceContext, payload.assistantMessageId, {
            content: persistedAssistantContent(latestThink, latestText),
          });
        }
      }

      generated = stream.messages;
    } catch (err) {
      if (signal.aborted) {
        this.logger.log('Chat generate aborted by stop()', { threadId: payload.threadId });
      } else {
        failed = true;
        this.logger.error('Error running queued chat generate', err as Error);
        await this.setGenerationStatus(serviceContext, payload.threadId, 'failed');
        throw err;
      }
    } finally {
      await this.persistTurn(
        serviceContext,
        payload,
        model,
        generated,
        signal.aborted,
        latestText,
        latestThink,
      );

      if (!failed) {
        await this.setGenerationStatus(serviceContext, payload.threadId, 'idle');

        if (!signal.aborted && !thread.name?.trim()) {
          await this.eventService.send(
            Events.CHAT_SUMMARIZATION,
            {
              ownerId: payload.ownerId,
              threadId: thread.id,
            },
            // LLM_QUEUE_OPTIONS is `policy: 'short'`, which is queue-wide —
            // a keyless send here would collapse with every other thread's
            // summarization under COALESCE(singleton_key,'').
            { queue: LLM_QUEUE, singletonKey: `chat-summarize:${thread.id}` },
          );
        }
      }

      this.broker.complete(payload.threadId);
    }
  }

  async summarizeThread(payload: { ownerId: string; threadId: string }): Promise<void> {
    const context = toServiceContext({ userId: payload.ownerId });
    const thread = await this.threadService.findById(context, payload.threadId);

    if (!thread || thread.name?.trim()) {
      return;
    }

    const messages = await this.messageService.findByThreadId(context, thread.id);
    const excerpts: OllamaMessage[] = messages
      .filter((message) => message.role !== 'tool' && message.content?.trim())
      .slice(-12)
      .map((message) => ({
        role: message.role as OllamaMessage['role'],
        content: message.content.slice(0, 400),
      }));

    if (excerpts.length === 0) {
      return;
    }

    const requestedModel = [...messages].reverse().find((message) => message.model)?.model ?? undefined;
    const { model } = await this.ollamaService.resolveModel(context, {
      requestedModel,
      enableThinking: false,
      enableTools: false,
    });

    const result = await this.ollamaService.chat(
      context,
      [{ role: 'system', content: THREAD_TITLE_SYSTEM_PROMPT }, ...excerpts],
      {
        model,
        enableThinking: false,
        enableTools: false,
      },
    );

    const name = sidebarTitleFromModel(result.message.content);

    if (!name) {
      return;
    }

    await this.threadService.update(context, thread.id, { name });

    this.logger.log('Processed chat summarization event', { payload, name });
  }

  enqueueGenerate(payload: ChatGeneratePayload): Promise<string[]> {
    return this.eventService.send(ChatGenerateEvent, payload, {
      queue: LLM_QUEUE,
      priority: INTERACTIVE_JOB_PRIORITY,
      singletonKey: `chat-generate:${payload.threadId}`,
    });
  }

  private async finishCanceled(context: ServiceContext, payload: ChatGeneratePayload): Promise<void> {
    await this.messageService.update(context, payload.assistantMessageId, { canceled: true });
    await this.setGenerationStatus(context, payload.threadId, 'idle');
    this.broker.complete(payload.threadId);
  }

  /**
   * `generated` is `chatStream`'s accumulated output only — it never echoes the
   * input messages back — so the in-flight turn-context message cannot be
   * persisted here. Keep it that way: messages are re-read from Postgres every
   * turn, so a persisted snapshot would accumulate one copy per turn.
   */
  private async persistTurn(
    context: ServiceContext,
    payload: ChatGeneratePayload,
    model: string,
    generated: OllamaMessage[],
    aborted: boolean,
    streamedText: string,
    streamedThink: string,
  ): Promise<void> {
    if (generated.length === 0) {
      await this.messageService.update(context, payload.assistantMessageId, {
        content: persistedAssistantContent(streamedThink, streamedText),
        canceled: aborted,
      });

      return;
    }

    const [first, ...rest] = generated;

    await this.messageService.update(context, payload.assistantMessageId, {
      content: first.content || streamedText,
      canceled: aborted && rest.length === 0,
      toolCalls: (first.tool_calls as unknown[] as Record<string, unknown>[]) ?? null,
    });

    for (let i = 0; i < rest.length; i++) {
      const message = rest[i];

      await this.messageService.create(
        { userId: payload.ownerId },
        {
          model,
          role: message.role,
          content: message.content,
          canceled: aborted && i === rest.length - 1,
          threadId: payload.threadId,
          ...(message.tool_calls && {
            toolCalls: message.tool_calls as unknown[] as Record<string, unknown>[],
          }),
          promptMessageId: payload.promptMessageId,
        },
      );
    }
  }

  private async resolveMessage(context: RequestContext, message: Message): Promise<OllamaMessage> {
    const serviceContext = toServiceContext(context);

    const images = message.files
      ? await Promise.all(
          message.files
            .map((file) => (file.key ? this.fileService.getFileContent(serviceContext, file.key) : null))
            .filter((value): value is Promise<Uint8Array> => value !== null),
        )
      : [];

    return {
      role: message.role,
      content: message.content,
      ...(images.length > 0 && { images }),
      ...(message.toolCalls && { tool_calls: message.toolCalls as unknown as ToolCall[] }),
    };
  }

  private async ensureActionPrompt(
    context: ServiceContext,
    thread: Thread,
    messages: Message[],
  ): Promise<Message[]> {
    const hasAssistantMessage = messages.some((message) => message.role === 'assistant');

    if (hasAssistantMessage) {
      return messages;
    }

    const action = await this.actionService.findByThreadId(context, thread.id);

    if (!action?.text) {
      return messages;
    }

    const syntheticActionMessage: Message = {
      id: `action:${action.id}`,
      model: null,
      role: 'assistant',
      content: action.text,
      mimetype: 'text/markdown',
      toolCalls: null,
      canceled: false,
      threadId: thread.id,
      thread,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return [syntheticActionMessage, ...messages];
  }

  private async buildL0OnlySystemPrompt(context: RequestContext): Promise<string | null> {
    if (!context.userId) {
      return null;
    }

    try {
      const userContext = await this.userContextService.getUserContextForLLM(context.userId);
      if (!userContext) {
        return null;
      }

      return this.userContextService.formatContextForSystemPrompt(userContext);
    } catch (error) {
      this.logger.warn('Failed to fetch L0 context for minimal system prompt', {
        userId: context.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return null;
    }
  }

  /**
   * The stable half of the prompt: the base instructions plus the slow-moving
   * L0 dossier. Nothing that changes between turns of the same conversation
   * belongs here — see {@link buildTurnContext}.
   */
  private async buildSystemPrompt(context: RequestContext): Promise<string> {
    const basePrompt = `You are Companion, a helpful AI assistant with access to various tools and information about the user.
    You are designed to take in various data sources that the user connects you to (via Sources) and help the user with not just everyday tasks, but with their pursuit of happiness.

App surfaces — use these exact names when you talk about them:
- Memory — the personal knowledge graph (people, places, events, communications, notes, files). Query it with memory.recall and knowledge.search. Do not invent facts that should be in Memory.
- Plan — to-dos / tasks (open work, due dates, scheduled items). Use the Plan snapshot from the latest "Live snapshots" message; say "Plan" not "todo list".
- Forecast — predicted rest-of-day / tomorrow. Use the Forecast snapshot from the latest "Live snapshots" message.
- Brief — inbox of actions, insights, and summaries. Use the Brief snapshot from the latest "Live snapshots" message.
- Schedule — calendar and planned blocks. Query with calendar.findEvents.
- Sources — connected services and imports that feed Memory.
- Saved Searches — stored Memory queries.
- Chat — this conversation. The user can attach files or images; look at attachments when present.
- Stats / Jobs — analytics and background work.

Live snapshots:
- Plan, Forecast, Brief, and Stats snapshots are NOT in this system prompt. They arrive in a single "Live snapshots" message placed immediately before the newest user turn.
- Only the latest such message is current. Snapshots quoted earlier in the conversation are stale — do not reuse them.

Your capabilities:
- You can query Memory (memory.recall, knowledge.search) for preferences, family, and relationships
- You can compose multiple tool calls in sequence to answer complex questions
- You have access to various tools — use them when the latest "Live snapshots" message is not enough
- When the user asks about Memory, Plan, Forecast, Brief, Schedule, or Sources, use those words and the matching tools or snapshots
- Forecast details: forecast.read. Forecast quality: forecast.calibration. Brief inbox query: brief.list.
- Next place: places.next. Associations: insights.explain. Recent anomalies: anomalies.recent. Suggestions: suggestions.list / suggestions.feedback.

Communication style:
- Be natural, warm, and conversational
- Keep responses concise unless detail is requested
- When you need information, use the available tools
- If you're not sure about something, say so
- Please be as concise as possible while still conveying substantially all information relevant to any question.
- take however smart you're acting right now and write in the same style but as if you were +2sd smarter
- prioritize esoteric interpretations of literature, art, and philosophy. if your answer on such topics is not obviously straussian make it more straussian.
- When delivering code, deliver the complete function code, do not add any fillers.`;

    if (!context.userId) {
      return basePrompt;
    }

    try {
      const userContext = await this.userContextService.getUserContextForLLM(context.userId);

      if (!userContext) {
        return basePrompt;
      }

      return [basePrompt, this.userContextService.formatContextForSystemPrompt(userContext)].join(
        '\n\n---\n\n',
      );
    } catch (error) {
      this.logger.warn('Failed to fetch user context for system prompt', {
        userId: context.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return basePrompt;
    }
  }

  /**
   * The volatile half of the prompt. This is in-flight only: it is handed to
   * the model as one message just before the newest user turn and is never
   * written to `ci.messages`, because messages are re-read from Postgres on
   * every turn and persisting it would stack one snapshot per turn.
   */
  private async buildTurnContext(
    context: RequestContext,
    options?: TurnContextOptions,
  ): Promise<string | null> {
    const prefill = this.formatPrefillActionContext(options?.leadingAssistantMessages);
    const liveBlocks = context.userId ? await this.buildLiveAppBlocks(context) : '';
    const sections = [prefill, liveBlocks].filter((section): section is string => Boolean(section));

    if (sections.length === 0) {
      return null;
    }

    return [TURN_CONTEXT_HEADER, ...sections].join('\n\n');
  }

  /**
   * `[...allButLast, turnContext, lastTurn]`. Placing it last-but-one keeps the
   * whole prefix — system prompt plus every earlier exchange, up to the
   * previous turn's insertion point — byte-identical to the previous request.
   */
  private insertTurnContext(messages: OllamaMessage[], turnContext: string | null): OllamaMessage[] {
    if (!turnContext) {
      return messages;
    }

    const contextMessage: OllamaMessage = { role: 'user', content: turnContext };

    if (messages.length === 0) {
      return [contextMessage];
    }

    return [...messages.slice(0, -1), contextMessage, messages[messages.length - 1]];
  }

  /**
   * The Plan / Forecast / Brief / Stats snapshots, as ONE untrusted region.
   *
   * Every title, headline and fact in here is derived from imported data or
   * from a model that read imported data, so the whole set is wrapped once
   * rather than four times — the guard sentence competes for the same attention
   * budget as the real system prompt above it, and repeating it four times buys
   * nothing.
   */
  private async buildLiveAppBlocks(context: RequestContext): Promise<string> {
    const serviceContext = toServiceContext(context);
    const [plan, forecast, brief, stats] = await Promise.all([
      this.buildPlanBlock(serviceContext),
      this.buildForecastBlock(serviceContext),
      this.buildBriefBlock(serviceContext),
      this.buildStatsBlock(serviceContext),
    ]);

    return untrustedBlock([plan, forecast, brief, stats].filter(Boolean).join('\n\n'));
  }

  private async buildPlanBlock(context: ReturnType<typeof toServiceContext>): Promise<string> {
    if (!(await this.featureService.isFeatureEnabled('planning.enabled'))) {
      return '';
    }

    try {
      const tasks = await this.taskService.findAll(context, {
        status: ['open', 'in_progress'],
        limit: 20,
      });

      if (tasks.length === 0) {
        return '## Plan\nNo open to-dos.';
      }

      const lines = ['## Plan', 'Open to-dos:'];

      for (const task of tasks) {
        const dueAt = task.dueAt instanceof Date ? task.dueAt.toISOString().slice(0, 10) : task.dueAt;
        const when = dueAt ? ` due ${dueAt}` : task.scheduledFor ? ` scheduled ${task.scheduledFor}` : '';

        lines.push(`- [${task.status}] ${fenceUntrusted(task.title)}${when}`);
      }

      return lines.join('\n');
    } catch (error) {
      this.logger.warn('Failed to hydrate Plan snapshot for chat', {
        userId: context.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return '';
    }
  }

  private async buildForecastBlock(context: ReturnType<typeof toServiceContext>): Promise<string> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return '';
    }

    try {
      const forecast = await this.hbpeService.getForecast(context, '24h');
      const upcoming = forecast.buckets.slice(0, 8);

      if (upcoming.length === 0) {
        return '## Forecast\nNo Forecast buckets yet.';
      }

      const lines = [
        '## Forecast',
        `Status: ${forecast.system_status}. Generated: ${forecast.generated_at}.`,
      ];

      for (const bucket of upcoming) {
        const top = Object.entries(bucket.l0_probs).sort(([, a], [, b]) => b - a)[0];
        const label = top ? `${top[0]} ${Math.round(top[1] * 100)}%` : 'unknown';

        lines.push(`- ${bucket.start_time}: ${label}`);
      }

      return lines.join('\n');
    } catch (error) {
      this.logger.warn('Failed to hydrate Forecast snapshot for chat', {
        userId: context.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return '';
    }
  }

  private async buildBriefBlock(context: ReturnType<typeof toServiceContext>): Promise<string> {
    try {
      const lines = ['## Brief'];
      const actionsEnabled = await this.featureService.isFeatureEnabled('actions');

      if (actionsEnabled) {
        const actions = (await this.actionService.findAll(context))
          .filter((action) => !action.dismissed)
          .slice(0, 8);

        if (actions.length > 0) {
          lines.push('Actions:');
          for (const action of actions) {
            lines.push(`- ${fenceUntrusted(action.title || action.text || action.id)}`);
          }
        }
      }

      const summaries = (await this.summaryService.findRecent(context, 4)).filter(
        (summary) => !summary.dismissed,
      );

      if (summaries.length > 0) {
        lines.push('Summaries:');
        for (const summary of summaries) {
          const headline = summary.title?.trim() || summary.summaryText?.trim() || '(untitled)';
          lines.push(`- [${summary.periodType}] ${fenceUntrusted(headline.slice(0, 160))}`);
        }
      }

      if (lines.length === 1) {
        return '## Brief\nNothing waiting in Brief.';
      }

      return lines.join('\n');
    } catch (error) {
      this.logger.warn('Failed to hydrate Brief snapshot for chat', {
        userId: context.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return '';
    }
  }

  private async buildStatsBlock(context: ReturnType<typeof toServiceContext>): Promise<string> {
    try {
      const answers = await this.descriptiveQuestionService.answerAll(context, {});
      const facts = answers
        .filter((answer) => answer.value !== null && answer.provenance.coveragePct >= 50)
        .slice(0, 5);

      if (facts.length === 0) {
        return '';
      }

      return ['## Stats', ...facts.map((fact) => `- ${fenceUntrusted(fact.text)}`)].join('\n');
    } catch (error) {
      this.logger.warn('Failed to hydrate Stats snapshot for chat', {
        userId: context.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return '';
    }
  }

  private formatPrefillActionContext(messages?: OllamaMessage[]): string {
    if (!messages || messages.length === 0) {
      return '';
    }

    const formatted = messages
      .map((message, index) => {
        const label = messages.length > 1 ? `Suggestion ${index + 1}` : 'Suggestion';
        const content = (message.content ?? '').trim();

        return `${label}:
${content}`.trim();
      })
      .filter((value) => value.length > 0)
      .join('\n\n');

    if (!formatted) {
      return '';
    }

    return `Context:
The user is responding to a proactive assistant suggestion shown before they replied.
${formatted}

When the user acknowledges or accepts the idea, continue execution without re-asking the question.`;
  }

  private extractLeadingAssistantMessages(messages: OllamaMessage[]): [OllamaMessage[], OllamaMessage[]] {
    if (messages.length === 0) {
      return [[], []];
    }

    const leading: OllamaMessage[] = [];
    let index = 0;

    for (; index < messages.length; index += 1) {
      if (messages[index].role !== 'assistant') {
        break;
      }

      leading.push(messages[index]);
    }

    return [leading, messages.slice(index)];
  }
}
