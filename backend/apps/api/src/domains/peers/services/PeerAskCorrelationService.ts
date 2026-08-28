import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { type PeerAskCorrelation, PeerAskCorrelationEntity } from '../entities/PeerAskCorrelationEntity';
import type { PeerAskBody } from '../protocol';

export type CorrelationRepository = Repository<PeerAskCorrelationEntity>;

export interface RecordCorrelationDto {
  peerLinkId: string;
  correlationId: string;
  askId: string;
  requestDigest: string;
}

/**
 * The correlation a peer's `askId` refers to on this box, or null.
 *
 * Scoped by peer link so one peer can never name another's ask: the correlation
 * id is minted by the ASKER and is therefore attacker-chosen, and a global
 * lookup would turn it into a probe for ids in use on this box.
 */
export async function findCorrelation(
  repository: CorrelationRepository,
  peerLinkId: string,
  correlationId: string,
): Promise<PeerAskCorrelation | null> {
  const row = await repository.findOne({ where: { peerLinkId, correlationId } });

  return row ? PeerAskCorrelationEntity.toEgressType(row) : null;
}

/** The correlation this box minted for one of its own outbound asks, or null. */
export async function findCorrelationByAskId(
  repository: CorrelationRepository,
  askId: string,
): Promise<PeerAskCorrelation | null> {
  const row = await repository.findOne({ where: { askId } });

  return row ? PeerAskCorrelationEntity.toEgressType(row) : null;
}

/** Write a correlation through whichever repository the caller reached us with. */
export async function recordCorrelation(
  repository: CorrelationRepository,
  data: RecordCorrelationDto,
): Promise<PeerAskCorrelation> {
  const saved = await repository.save(repository.create({ id: uuidv7(), ...data }));

  return PeerAskCorrelationEntity.toEgressType(saved);
}

/**
 * Binds an asker-minted `askId` to the local ask it identifies, per peer link.
 *
 * This is the whole of the idempotency contract `PeerAskBody.askId` always
 * claimed and never had. Both halves of federation read it: the RESPONDER, to
 * replay a repeat rather than create a second ask and to answer a poll, and the
 * ASKER, to name its own outbound ask again after the send returned.
 *
 * ═══ WHY THE QUERIES ARE FREE FUNCTIONS AND THIS IS A THIN WRAPPER ═══
 *
 * {@link PeerAskService} does NOT inject this service. It reaches the same
 * repository through the `EntityManager` it already holds, for the reason its
 * own `persistDisclosure` gives for reaching its transaction the same way:
 * several callers — the DB-backed lifecycle suites among them — construct that
 * service by hand, and growing its constructor breaks them at a distance for a
 * dependency that is one `getRepository` call away. So the query logic lives in
 * functions that take a repository, and there is exactly one implementation of
 * each rather than a second copy inside the service that happens to agree.
 */
@Injectable()
export class PeerAskCorrelationService {
  constructor(
    @InjectRepository(PeerAskCorrelationEntity)
    private readonly repository: CorrelationRepository,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeerAskCorrelationService.name);
  }

  find(peerLinkId: string, correlationId: string): Promise<PeerAskCorrelation | null> {
    return findCorrelation(this.repository, peerLinkId, correlationId);
  }

  findByAskId(askId: string): Promise<PeerAskCorrelation | null> {
    return findCorrelationByAskId(this.repository, askId);
  }

  /**
   * `manager` enrolls the write in a caller-owned transaction; omitted, it runs
   * on its own connection.
   */
  record(data: RecordCorrelationDto, manager?: EntityManager): Promise<PeerAskCorrelation> {
    return recordCorrelation(
      manager ? manager.getRepository(PeerAskCorrelationEntity) : this.repository,
      data,
    );
  }
}

/**
 * Canonical digest of the QUESTION an `askId` was minted for.
 *
 * Only the fields that decide what is disclosed are hashed — the archetype and
 * its constraints. `prompt` and `askerHandle` are display strings that neither
 * the grant evaluator nor the executor reads, so folding them in would make a
 * cosmetic edit look like a different question and refuse a legitimate retry.
 *
 * `JSON.stringify` over a key-sorted copy, not over the parsed object: Zod
 * preserves insertion order, so two byte-identical requests whose JSON listed
 * `from` before `to` and `to` before `from` would otherwise digest differently
 * and the retry would be refused.
 *
 * Pure.
 */
export function requestDigest(body: PeerAskBody): string {
  return createHash('sha256').update(canonicalJson(body.request)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (value != null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);

    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value ?? null);
}
