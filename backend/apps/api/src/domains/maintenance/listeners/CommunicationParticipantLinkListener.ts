import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SYSTEM_USER, toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import {
  EntityIdentifierService,
  type GraphEntityInputDto,
  GraphIngestService,
  type IdentifierKey,
  type IdentifierKind,
  normalizeIdentifier,
} from '@ci/domains/graph';
import { CommunicationService } from '@ci/domains/memory';
import { CommunicationCreatedEvent, type CommunicationCreatedPayload } from '@ci/domains/memory/events';

/**
 * sourceSystem the on-ingest stub Person entities are stamped with — matches
 * the backfill so a stub created either way lands on the same linked-key row.
 */
const STUB_SOURCE_SYSTEM = 'communications:participant';

/**
 * On-ingest people-linker for {@link CommunicationCreatedEvent}.
 *
 * Fires for every single-row `CommunicationService.create` (interactive creates
 * and the legacy in-server importer transforms). Resolves the raw participant
 * strings in `participants_metadata.{from,to,cc,bcc}` against the
 * `ci.entity_identifiers` index, creates stub Person entities for any
 * previously-unseen identifiers, and writes the resolved ids back onto the
 * row's `from_entity_id` / `to_entity_ids` columns. Closes the long-standing
 * TODO at `CommunicationService.create`.
 *
 * NOTE — bulk path is deliberately excluded: `CommunicationService.createMany`
 * does NOT emit a per-row `CommunicationCreatedEvent` (the per-row pgboss
 * fan-out was the dominant cost at importer scale). The post-load backfill
 * (`PersonStubBackfillService` + `CommunicationLinkBackfillService`) is the
 * canonical path for bulk-loaded rows. Both call the same
 * `GraphIngestService.ingest` / `EntityIdentifierService` machinery, so a row
 * the listener processes and a row the backfill processes look identical
 * downstream.
 *
 * Lives in `maintenance` (not `memory`) because the listener depends on
 * `GraphIngestService` from `GraphModule`, which itself imports `MemoryModule`
 * — a maintenance-side listener avoids the cycle.
 */
@Injectable()
export class CommunicationParticipantLinkListener {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly entityIdentifierService: EntityIdentifierService,
    private readonly graphIngestService: GraphIngestService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(CommunicationParticipantLinkListener.name);
  }

  @OnEvent(CommunicationCreatedEvent, { queue: 'people-linking' })
  async handleCreated(payload: CommunicationCreatedPayload): Promise<void> {
    // Read the row as the system user so the listener doesn't depend on the
    // creator's context being threaded through PGBoss.
    const communication = await this.communicationService.findById(
      { userId: SYSTEM_USER },
      payload.communicationId,
    );

    if (communication == null) {
      this.logger.warn('Communication not found, skipping people-linking', {
        communicationId: payload.communicationId,
      });

      return;
    }

    if (communication.userId == null) {
      this.logger.warn('Communication has no owner, skipping people-linking', {
        communicationId: communication.id,
      });

      return;
    }

    const fromAlreadySet = communication.fromEntityId != null;
    const toAlreadySet = Array.isArray(communication.toEntityIds) && communication.toEntityIds.length > 0;
    if (fromAlreadySet && toAlreadySet) {
      // Nothing to do — the creator pre-resolved both sides.
      return;
    }

    const meta = communication.participantsMetadata ?? {};

    // Build the distinct identifier set for this row. First-seen raw
    // participant wins the display name slot, mirroring the backfill.
    const seenByComposite = new Map<string, { key: IdentifierKey; rawName: string }>();
    const collect = (raw: string | null) => {
      const key = classify(raw);
      if (key == null) {return;}

      const composite = `${key.kind}:${key.valueNormalized}`;
      if (seenByComposite.has(composite)) {return;}

      seenByComposite.set(composite, { key, rawName: (raw ?? '').trim() });
    };

    if (!fromAlreadySet) {
      collect(readString(meta.from));
    }

    if (!toAlreadySet) {
      for (const raw of readStringArray(meta.to)) {collect(raw);}

      for (const raw of readStringArray(meta.cc)) {collect(raw);}

      for (const raw of readStringArray(meta.bcc)) {collect(raw);}
    }

    if (seenByComposite.size === 0) {
      return;
    }

    const ownerId = communication.userId;
    const allKeys = [...seenByComposite.values()].map((s) => s.key);
    const existing = await this.entityIdentifierService.findEntityIdsByIdentifiers(ownerId, allKeys);

    const newEntities: GraphEntityInputDto[] = [];
    for (const [composite, seen] of seenByComposite) {
      if (existing.has(composite)) {continue;}

      const propertyKey = seen.key.kind === 'email' ? 'emails' : 'phones';
      newEntities.push({
        key: `${STUB_SOURCE_SYSTEM}:${seen.key.kind}:${seen.key.valueNormalized}`,
        entityType: 'Person',
        name: seen.rawName.length > 0 ? seen.rawName : seen.key.valueNormalized,
        sourceSystem: STUB_SOURCE_SYSTEM,
        properties: { [propertyKey]: [seen.key.valueNormalized] },
      });
    }

    if (newEntities.length > 0) {
      const ingestResult = await this.graphIngestService.ingest(toServiceContext({ userId: ownerId }), {
        entities: newEntities,
        relationships: [],
      });

      if (ingestResult.errors.length > 0) {
        this.logger.warn('Stub Person ingest reported errors', {
          communicationId: communication.id,
          errors: ingestResult.errors,
        });
      }
    }

    // Re-resolve so the newly-ingested identifiers participate in the link.
    const resolved =
      newEntities.length > 0
        ? await this.entityIdentifierService.findEntityIdsByIdentifiers(ownerId, allKeys)
        : existing;

    const lookup = (raw: string | null): string | null => {
      const key = classify(raw);
      if (key == null) {return null;}

      return resolved.get(`${key.kind}:${key.valueNormalized}`) ?? null;
    };

    const fromId = fromAlreadySet ? null : lookup(readString(meta.from));

    let toIds: string[] | null = null;
    if (!toAlreadySet) {
      const ids: string[] = [];
      for (const raw of readStringArray(meta.to)) {
        const id = lookup(raw);
        if (id != null) {ids.push(id);}
      }

      toIds = ids.length > 0 ? [...new Set(ids)] : null;
    }

    if (fromId == null && toIds == null) {
      // Nothing resolved — the row stays as it was. Idempotent.
      return;
    }

    // Targeted, partition-key-scoped UPDATE — TimescaleDB chunk-local, NULL
    // guards keep it idempotent, no Updated event re-fires so the search
    // listener doesn't redundantly re-embed the same content.
    await this.dataSource.query(
      `UPDATE ci.communications
          SET from_entity_id = COALESCE($3::uuid, from_entity_id),
              to_entity_ids  = CASE
                                 WHEN $4::uuid[] IS NOT NULL
                                      AND (to_entity_ids IS NULL OR cardinality(to_entity_ids) = 0)
                                 THEN $4::uuid[]
                                 ELSE to_entity_ids
                               END
        WHERE user_id = $1
          AND id = $2`,
      [ownerId, communication.id, fromId, toIds],
    );
  }
}

/**
 * Classify a raw participant string as an email or phone and normalize it with
 * the SAME shared rule the identifier index uses. Mirrors the helpers in
 * CommunicationLinkBackfillService / PersonStubBackfillService — kept inline
 * because the three paths must agree byte-for-byte on what counts as a match.
 */
function classify(raw: string | null): IdentifierKey | null {
  if (raw == null) {return null;}

  const trimmed = raw.trim();
  if (trimmed.length === 0) {return null;}

  const kind: IdentifierKind = trimmed.includes('@') ? 'email' : 'phone';
  const valueNormalized = normalizeIdentifier(kind, trimmed);
  if (valueNormalized == null) {return null;}

  return { kind, valueNormalized };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }

  return [];
}
