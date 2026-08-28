import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService, embedSkipReason, shouldEmbedType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type Position, PositionService } from '@ci/domains/position';
import {
  PositionCreatedEvent,
  PositionRemovedEvent,
  PositionUpdatedEvent,
  type PositionCreatedPayload,
  type PositionDeletedPayload,
  type PositionUpdatedPayload,
} from '@ci/domains/position/events';

import { EmbeddingService } from '../services/EmbeddingService';
import { IndexSkipService } from '../services/IndexSkipService';
import { VectorService } from '../services/VectorService';
import { type WeightedText } from '../types';

function placeLabel(position: Position): string | null {
  const address = position.address?.trim();
  if (address) {
    return address;
  }

  const city = [position.city, position.region, position.country].filter(Boolean).join(', ');

  return city.length > 0 ? city : null;
}

/** A user changes their timezone rarely; re-fetching every 15m keeps the query volume low without letting a stale zone haunt indexed text for the life of the process. */
export const TIMEZONE_CACHE_TTL_MS = 15 * 60_000;

function resolveTimeZone(timeZone: string | null | undefined): string {
  const candidate = timeZone?.trim();
  if (!candidate) {
    return 'UTC';
  }

  try {
    Intl.DateTimeFormat('en-US', { timeZone: candidate });

    return candidate;
  } catch {
    return 'UTC';
  }
}

/** `{local date} {local time}` in the user's IANA zone, matching n_places day buckets. */
export function formatLocalPositionStamp(time: Date, timeZone: string): string {
  const zone = resolveTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(time);

  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  let hour = value('hour');
  if (hour === '24') {
    hour = '00';
  }

  return `${value('year')}-${value('month')}-${value('day')} ${hour}:${value('minute')}`;
}

@Injectable()
export class PositionSearchIndexListener {
  private readonly timezoneByUser = new Map<string, { timezone: string; expiresAt: number }>();

  constructor(
    private readonly positionService: PositionService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly indexSkipService: IndexSkipService,
    private readonly vectorService: VectorService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PositionSearchIndexListener.name);
  }

  @OnEvent(PositionCreatedEvent, { queue: 'search-index' })
  async indexPosition(payload: PositionCreatedPayload | PositionUpdatedPayload) {
    await this.upsertPosition(payload);
  }

  @OnEvent(PositionUpdatedEvent, { queue: 'search-index' })
  async updatePosition(payload: PositionCreatedPayload | PositionUpdatedPayload) {
    await this.upsertPosition(payload);
  }

  @OnEvent(PositionRemovedEvent, { queue: 'search-index' })
  async unindexPosition(payload: PositionDeletedPayload) {
    const context = { userId: SYSTEM_USER } satisfies ServiceContext;
    await this.embeddingService.remove(context, { entityType: 'position', entityId: payload.positionId });
    await this.vectorService.remove(context, { entityType: 'position', entityId: payload.positionId });
  }

  private async upsertPosition(payload: PositionCreatedPayload | PositionUpdatedPayload) {
    const context = { userId: SYSTEM_USER } satisfies ServiceContext;
    const position = await this.positionService.findById(context, payload.positionId);

    if (position == null) {
      this.logger.warn('Position not found, skipping indexing', { positionId: payload.positionId });

      return;
    }

    const label = placeLabel(position);
    if (!label || !position.location) {
      await this.indexSkipService.recordSkip({
        entityType: 'position',
        entityId: position.id,
        reason: 'unnamed',
      });

      return;
    }

    const timezone = await this.userTimeZone(position.userId);
    const representative = await this.isHourCellRepresentative(position, timezone);
    if (!representative) {
      await this.indexSkipService.recordSkip({
        entityType: 'position',
        entityId: position.id,
        reason: 'downsampled',
      });

      return;
    }

    const stamp = formatLocalPositionStamp(new Date(position.time), timezone);
    const text = `${stamp} at ${label}`;
    const skipReason = embedSkipReason(text);

    if (!shouldEmbedType('position')) {
      return;
    }

    if (skipReason != null) {
      await this.indexSkipService.recordSkip({
        entityType: 'position',
        entityId: position.id,
        reason: skipReason,
      });

      return;
    }

    const embedding = await this.embeddingGenerationService.generateEmbedding(text);
    await this.embeddingService.upsert(
      { userId: position.userId },
      { entityType: 'position', entityId: position.id, embedding },
    );
    await this.indexSkipService.clearSkip({ entityType: 'position', entityId: position.id });

    const searchableText: WeightedText[] = [{ text, weight: 8 }];
    await this.vectorService.upsert(
      { userId: position.userId },
      { entityType: 'position', entityId: position.id, searchableText },
    );
  }

  private async userTimeZone(userId: string): Promise<string> {
    const cached = this.timezoneByUser.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.timezone;
    }

    const rows = (await this.dataSource.query(`SELECT timezone FROM ci.users WHERE id = $1`, [
      userId,
    ])) as Array<{
      timezone: string | null;
    }>;
    const timezone = resolveTimeZone(rows[0]?.timezone);
    this.timezoneByUser.set(userId, { timezone, expiresAt: Date.now() + TIMEZONE_CACHE_TTL_MS });

    return timezone;
  }

  private async isHourCellRepresentative(position: Position, timeZone: string): Promise<boolean> {
    const coords = position.location?.coordinates;
    const lng = Number(coords?.[0]);
    const lat = Number(coords?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return false;
    }

    const rows = (await this.dataSource.query(
      `
      SELECT p.id::text AS id
        FROM ci.position p
       WHERE p.user_id = $1
         AND p.location IS NOT NULL
         AND COALESCE(btrim(p.address), '') <> ''
         AND date_trunc('hour', p.time AT TIME ZONE $5)
           = date_trunc('hour', $2::timestamptz AT TIME ZONE $5)
         AND round(ST_Y(p.location::geometry)::numeric, 3) = round($3::numeric, 3)
         AND round(ST_X(p.location::geometry)::numeric, 3) = round($4::numeric, 3)
       ORDER BY p.time, p.id
       LIMIT 1
      `,
      [position.userId, position.time, lat, lng, timeZone],
    )) as Array<{ id: string }>;

    return rows[0]?.id === position.id;
  }
}
