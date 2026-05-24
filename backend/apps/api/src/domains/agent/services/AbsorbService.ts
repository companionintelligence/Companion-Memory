import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { CommunicationService, CommunicationType, type UpdateCommunicationDto } from '@ci/domains/memory';

import type { AbsorbDto, AbsorbResult } from '../types';

@Injectable()
export class AbsorbService {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AbsorbService.name);
  }

  async absorb(context: UserServiceContext, dto: AbsorbDto): Promise<AbsorbResult> {
    try {
      await this.doAbsorb(context, dto);

      return { ok: true };
    } catch (err) {
      this.logger.warn(`Absorb failed for user ${context.userId}: ${err}`);

      return { ok: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async doAbsorb(context: UserServiceContext, dto: AbsorbDto): Promise<void> {
    const content = JSON.stringify(dto.messages);
    const summary = this.buildSummary(dto.messages);

    // Upsert by sessionId: one row per session, updated as the conversation grows.
    // Without a sessionId we cannot deduplicate — just insert and move on.
    if (dto.sessionId) {
      const existing = await this.communicationService.findByThreadId(context, dto.sessionId);

      if (existing.length > 0) {
        const row = existing[0];

        // Content unchanged — nothing to do
        if (row.content === content) {
          return;
        }

        const update: UpdateCommunicationDto = { content, summary };
        await this.communicationService.update(context, row.id, update);

        return;
      }
    }

    // New session (or sessionId-less call) — create a fresh record
    await this.communicationService.create(context, {
      time: new Date(),
      communication_type: CommunicationType.CHAT,
      direction: 'inbound',
      content,
      subject: dto.sessionId,
      thread_id: dto.sessionId,
      category: 'agent-conversation',
      summary,
    });
  }

  private buildSummary(messages: Array<{ role: string; content: string }>): string {
    const userMessages = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content.slice(0, 120))
      .join(' | ');

    return userMessages.slice(0, 500) || 'Agent conversation';
  }
}
