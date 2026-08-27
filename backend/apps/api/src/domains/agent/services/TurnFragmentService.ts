import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { MessageEntity } from '@ci/domains/conversations';

import { TURN_FRAGMENT_SOURCE, buildTurnFragment, turnFragmentId } from '../turnFragments';

import { AgentMemoryService } from './AgentMemoryService';

/** Resolved once at import, like every other consumer of `config`. */
export const TURN_FRAGMENT_SETTINGS = {
  intervalMinutes: config.agentMemory.turnFragments.intervalMinutes,
  lookbackMinutes: config.agentMemory.turnFragments.lookbackMinutes,
  settleMinutes: config.agentMemory.turnFragments.settleMinutes,
  maxTurnsPerUser: config.agentMemory.turnFragments.maxTurnsPerUser,
  minFragmentChars: config.agentMemory.turnFragments.minFragmentChars,
  maxSideChars: config.agentMemory.turnFragments.maxSideChars,
} as const;

export interface TurnFragmentWindow {
  /** Inclusive lower bound on `ci.messages.updated_at`. */
  since: Date;
  /** Exclusive upper bound — `now - settleMinutes`, never `now`. */
  until: Date;
}

export interface TurnFragmentOutcome {
  /** Turns the window produced, after the truncation guard. */
  turns: number;
  /** Fragments actually inserted. */
  written: number;
  /** Turns that already had a fragment, or were not worth one. */
  skipped: number;
}

/**
 * The producer half of `ci.agent_memories`.
 *
 * Until this existed the table had exactly one writer — `POST /memory/write`,
 * behind `ApiKeyGuard` — so the appliance's own web chat could not reach it
 * even with a session, and on a stock box the table was empty by
 * construction. Everything downstream read from an empty table:
 * `MemoryCompactionCron`, the `agent-memory.created` search-index listener,
 * and `RecallService`'s raw-message channel.
 *
 * A turn is one `ci.messages` prompt row plus every assistant row written
 * against it (`parent_message_id`), in a thread that is no longer generating.
 * Assistant rows are joined to their prompt directly rather than reconstructed
 * by scanning the thread, so a tool-calling turn that produced four assistant
 * rows collapses to one fragment instead of four.
 */
@Injectable()
export class TurnFragmentService {
  constructor(
    @InjectRepository(MessageEntity)
    private readonly messageRepository: Repository<MessageEntity>,
    private readonly agentMemoryService: AgentMemoryService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(TurnFragmentService.name);
  }

  /**
   * The window a tick covers.
   *
   * `until` trails `now` by `settleMinutes` because the fragment id is keyed on
   * the prompt rather than the text, so the FIRST write for a turn is the one
   * that sticks: reading a tool chain mid-flight would freeze a half-finished
   * reply as the permanent fragment. `since` reaches back further than one
   * interval so a tick lost to a restart is picked up by the next one instead
   * of leaving a permanent hole.
   */
  resolveWindow(now: Date = new Date()): TurnFragmentWindow {
    const until = new Date(now.getTime() - TURN_FRAGMENT_SETTINGS.settleMinutes * 60_000);

    return {
      since: new Date(until.getTime() - TURN_FRAGMENT_SETTINGS.lookbackMinutes * 60_000),
      until,
    };
  }

  /**
   * Users with at least one settled, completed turn in the window — the
   * audience the cron fans out over. Distinct at the database rather than in
   * memory: a busy thread is thousands of rows for one user id.
   */
  async listUsersWithCompletedTurns(window: TurnFragmentWindow): Promise<string[]> {
    const rows: Array<{ user_id: string | null }> = await this.completedTurnQuery(window, false)
      .select('message.user_id', 'user_id')
      .distinct(true)
      .getRawMany();

    return rows.map((row) => row.user_id).filter((userId): userId is string => Boolean(userId));
  }

  /**
   * Distils one user's completed turns in the window into memory fragments.
   *
   * Idempotent by construction: every turn's fragment id is a pure function of
   * (user, thread, prompt message), so a replay after a crash — or a second
   * job for an overlapping window — finds the row already there and skips it.
   */
  async distillForUser(userId: string, window: TurnFragmentWindow): Promise<TurnFragmentOutcome> {
    const context = toServiceContext({ userId });
    const limit = TURN_FRAGMENT_SETTINGS.maxTurnsPerUser;
    // One extra assistant row per turn is the common case (a tool chain adds
    // more), so the row budget is generous relative to the turn budget; the
    // truncation guard below is what actually enforces `maxTurnsPerUser`.
    const rowLimit = limit * 4;
    const rows = await this.completedTurnQuery(window, true)
      .innerJoinAndSelect('message.promptMessage', 'prompt')
      .andWhere('message.user_id = :userId', { userId })
      .andWhere('prompt.role = :promptRole', { promptRole: 'user' })
      // Prompt id first so every assistant row of one turn stays contiguous and
      // the truncation guard can drop a partial group whole. Message ids are
      // uuid7, so this is also chronological.
      .orderBy('prompt.id', 'ASC')
      .addOrderBy('message.id', 'ASC')
      .limit(rowLimit)
      .getMany();

    const turns = this.groupIntoTurns(rows, rows.length === rowLimit, limit);

    if (turns.length === 0) {
      return { turns: 0, written: 0, skipped: 0 };
    }

    const candidates = turns.flatMap((turn) => {
      const fragment = buildTurnFragment({
        threadTitle: turn.threadTitle,
        prompt: turn.prompt,
        replies: turn.replies,
        maxSideChars: TURN_FRAGMENT_SETTINGS.maxSideChars,
        minFragmentChars: TURN_FRAGMENT_SETTINGS.minFragmentChars,
      });

      return fragment == null
        ? []
        : [
            {
              id: turnFragmentId({ userId, threadId: turn.threadId, promptMessageId: turn.promptMessageId }),
              threadId: turn.threadId,
              fragment,
            },
          ];
    });

    if (candidates.length === 0) {
      return { turns: turns.length, written: 0, skipped: turns.length };
    }

    // One round trip for the whole batch rather than a findOne per turn — the
    // steady state of this cron is "everything in the window is already
    // written", so the existence check is the hot path.
    const existing = new Set(
      (
        await this.agentMemoryService.findByIds(
          context,
          candidates.map((candidate) => candidate.id),
        )
      ).map((memory) => memory.id),
    );

    let written = 0;

    for (const candidate of candidates) {
      if (existing.has(candidate.id)) {
        continue;
      }

      await this.agentMemoryService.create(context, {
        id: candidate.id,
        content: candidate.fragment.content,
        title: candidate.fragment.title,
        source: TURN_FRAGMENT_SOURCE,
        sessionId: candidate.threadId,
      });

      written += 1;
    }

    this.logger.log('Chat-turn fragments written', {
      userId,
      turns: turns.length,
      written,
      skipped: turns.length - written,
    });

    return { turns: turns.length, written, skipped: turns.length - written };
  }

  /**
   * Assistant rows of settled, completed turns inside the window.
   *
   * `generationStatus = 'idle'` is the "completed" test: a thread mid-turn is
   * `queued` or `running`, and `ChatTurnService` only returns it to `idle`
   * after `persistTurn`. Archived threads are excluded because their messages
   * are soft-removed alongside them.
   */
  private completedTurnQuery(window: TurnFragmentWindow, hydrateThread: boolean) {
    const query = this.messageRepository.createQueryBuilder('message');

    // Same relation, same alias either way — the audience scan wants the join
    // for its predicates only, the distillation wants the thread title too.
    if (hydrateThread) {
      query.innerJoinAndSelect('message.thread', 'thread');
    } else {
      query.innerJoin('message.thread', 'thread');
    }

    return query
      .where('message.role = :role', { role: 'assistant' })
      .andWhere('message.canceled = false')
      .andWhere('thread.isArchived = false')
      .andWhere('thread.generationStatus = :idle', { idle: 'idle' })
      .andWhere('message.updatedAt >= :since', { since: window.since })
      .andWhere('message.updatedAt < :until', { until: window.until });
  }

  /**
   * Folds assistant rows onto their prompt.
   *
   * `truncated` says the row limit was hit, in which case the LAST group may be
   * missing rows the next page holds. It is dropped rather than written short:
   * the fragment id ignores content, so a partial fragment written now would
   * never be corrected — the next tick would see the id already present and
   * skip it forever.
   */
  private groupIntoTurns(
    rows: MessageEntity[],
    truncated: boolean,
    maxTurns: number,
  ): Array<{
    threadId: string;
    promptMessageId: string;
    threadTitle: string | null;
    prompt: string;
    replies: string[];
  }> {
    const byPrompt = new Map<
      string,
      {
        threadId: string;
        promptMessageId: string;
        threadTitle: string | null;
        prompt: string;
        replies: string[];
      }
    >();

    for (const row of rows) {
      const prompt = row.promptMessage;
      const thread = row.thread;

      if (prompt == null || thread == null) {
        continue;
      }

      const existing = byPrompt.get(prompt.id);

      if (existing) {
        existing.replies.push(row.content ?? '');
        continue;
      }

      byPrompt.set(prompt.id, {
        threadId: thread.id,
        promptMessageId: prompt.id,
        threadTitle: thread.name ?? null,
        prompt: prompt.content ?? '',
        replies: [row.content ?? ''],
      });
    }

    const turns = [...byPrompt.values()];

    if (truncated && turns.length > 0) {
      turns.pop();
    }

    return turns.slice(0, maxTurns);
  }
}
