import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import { GeocodeService } from '@ci/domains/geocode';
import { PlaceService } from '@ci/domains/memory';
import { ItemUpdatedEvent } from '@ci/domains/memory/events';

const DEFAULT_PAGE = 200;
const DEFAULT_MAX = 2000;

export interface ObjectReverseResult {
  examined: number;
  placed: number;
  skipped: number;
  status: 'ok' | 'noop';
}

/**
 * Reverse-geocode object pins onto `last_seen_place_entity_id`.
 * No new column — the FK already exists; this is the missing writer.
 */
@Injectable()
export class ObjectReverseService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly geocodeService: GeocodeService,
    private readonly placeService: PlaceService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ObjectReverseService.name);
  }

  async reverse(userId: string, options: { limit?: number } = {}): Promise<ObjectReverseResult> {
    const maxIds = options.limit ?? DEFAULT_MAX;
    const context = { userId } satisfies UserServiceContext;
    const placedIds: string[] = [];
    let examined = 0;
    let skipped = 0;
    let cursor: string | null = null;

    while (examined < maxIds) {
      const pageSize = Math.min(DEFAULT_PAGE, maxIds - examined);
      const rows = (await this.dataSource.query(
        `
        SELECT object_id::text AS id,
               ST_Y(current_location_coordinates::geometry) AS lat,
               ST_X(current_location_coordinates::geometry) AS lng
          FROM ci.objects
         WHERE user_id::uuid = $1
           AND current_location_coordinates IS NOT NULL
           AND last_seen_place_entity_id IS NULL
           AND ($3::uuid IS NULL OR object_id > $3::uuid)
         ORDER BY object_id
         LIMIT $2
        `,
        [userId, pageSize, cursor],
      )) as Array<{ id: string; lat: string | number; lng: string | number }>;

      if (rows.length === 0) {
        break;
      }

      cursor = rows[rows.length - 1].id;
      examined += rows.length;

      for (const row of rows) {
        const lat = Number(row.lat);
        const lng = Number(row.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          skipped += 1;
          continue;
        }

        const outcome = await this.geocodeService.reverseGeocode(lat, lng);
        const name = outcome.placeName?.trim();
        if (outcome.status !== 'OK' || !name) {
          skipped += 1;
          continue;
        }

        try {
          const place = await this.placeService.findOrCreateForGeocode(context, {
            name,
            lat,
            lng,
            placeId: outcome.placeId,
            components: outcome.components,
          });
          await this.dataSource.query(
            `UPDATE ci.objects SET last_seen_place_entity_id = $2 WHERE object_id = $1 AND last_seen_place_entity_id IS NULL`,
            [row.id, place.id],
          );
          placedIds.push(row.id);
        } catch (error) {
          skipped += 1;
          this.logger.warn('Object reverse failed for item', {
            itemId: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (rows.length < pageSize) {
        break;
      }
    }

    if (placedIds.length > 0) {
      try {
        await this.eventService.sendMany(
          'search-index',
          placedIds.map((itemId) => ({
            name: ItemUpdatedEvent,
            data: { itemId },
          })),
        );
      } catch (error) {
        this.logger.warn('Could not enqueue item search after object reverse', {
          count: placedIds.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (examined === 0) {
      return { examined: 0, placed: 0, skipped: 0, status: 'noop' };
    }

    return { examined, placed: placedIds.length, skipped, status: 'ok' };
  }
}
