import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { type AskAnswer, AskAnswerEntity } from '../entities/AskAnswerEntity';
import type { CreateAskAnswerDto } from '../types';

/**
 * Persists and retrieves the disclosure-filtered {@link AskAnswerEntity}. The
 * answer holds only entity references + a templated summary; the raw matching
 * nodes never leave the box. Visibility is enforced by the caller against the
 * parent ask (asker or responder), so this service does not re-scope by user.
 */
@Injectable()
export class AskAnswerService {
  constructor(
    @InjectRepository(AskAnswerEntity)
    private readonly answerRepository: Repository<AskAnswerEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AskAnswerService.name);
  }

  /**
   * Store the answer produced for an ask. Insert-only — see below.
   *
   * `manager` enrolls the insert in a caller-owned transaction so the answer and
   * its audit row commit together. That matters MORE here than anywhere else in
   * this domain: the insert-only guard makes a half-finished disclosure
   * permanent, because the retry hits the conflict instead of repairing the
   * missing audit.
   */
  async create(data: CreateAskAnswerDto, manager?: EntityManager): Promise<AskAnswer> {
    const repository = this.repository(manager);
    const existing = await repository.findOne({ where: { askId: data.askId } });

    // An answer is a TERMINAL disclosure record, so this is insert-only. It used
    // to reuse `existing.id` and save, which made the row mutable after the fact:
    // a second run with no redaction rewrote a fully-redacted answer to fully
    // disclosed, and because the audit is written by `complete` — which by then
    // refuses the terminal ask — the audit kept the ORIGINAL count. The owner's
    // redaction was reversible and the audit log said otherwise.
    if (existing != null) {
      throw new ConflictException(`Ask ${data.askId} already has an answer`);
    }

    const record = repository.create({
      id: data.id ?? uuidv7(),
      askId: data.askId,
      form: data.answer.form,
      answerSource: data.answerSource ?? 'peer',
      summary: data.answer.summary,
      disclosedEntities: data.answer.items,
      disclosedCount: data.answer.disclosedCount,
      withheldCount: data.answer.withheldCount,
      consentBasis: data.answer.consentBasis,
    });

    const entity = await repository.save(record);

    return AskAnswerEntity.toEgressType(entity);
  }

  /** The answer for an ask, or null if it has not been answered yet. */
  async findByAskId(askId: string): Promise<AskAnswer | null> {
    const entity = await this.answerRepository.findOne({ where: { askId } });

    return entity ? AskAnswerEntity.toEgressType(entity) : null;
  }

  /** The transaction's repository when one is supplied, otherwise the injected one. */
  private repository(manager?: EntityManager): Repository<AskAnswerEntity> {
    return manager ? manager.getRepository(AskAnswerEntity) : this.answerRepository;
  }
}
