import path from 'path';

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { EventEntity } from '@ci/domains/memory';

import { readCsv } from './utils';

const logger = new Logger(path.basename(__filename));

export async function seedEvents(db: DataSource, filePath: string) {
  type CsvRecord = {
    id: string;
    type: string;
    name: string;
    description: string;
    start_time: string;
    end_time: string;
    related_objects: string;
    data_source: string;
    user_id: string;
    connection_id: string;
    provider_id: string;
    created_at: string;
    updated_at: string;
  };

  const records = readCsv<CsvRecord>(filePath);

  await db.transaction(async (manager) => {
    for (const record of records) {
      // Parse dates, handling empty strings
      const startTime = record.start_time ? new Date(record.start_time) : null;
      const endTime = record.end_time ? new Date(record.end_time) : null;
      const createdAt = record.created_at ? new Date(record.created_at) : new Date();
      const updatedAt = record.updated_at ? new Date(record.updated_at) : new Date();

      // Parse related_objects if it's a JSON array string
      let sourceData = null;
      if (record.related_objects) {
        try {
          // Handle different formats of related_objects
          let parsed;
          if (record.related_objects.startsWith('[') && record.related_objects.endsWith(']')) {
            // Remove brackets and split by comma, handling quoted strings
            const items = record.related_objects
              .slice(1, -1)
              .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/) // Split by comma not inside quotes
              .map((item) => item.trim().replace(/^["']|["']$/g, '')); // Remove quotes
            parsed = items;
          } else {
            // Try parsing as JSON
            parsed = JSON.parse(record.related_objects.replace(/'/g, '"'));
          }

          sourceData = { related_objects: parsed };
        } catch {
          // If parsing fails, store as-is
          sourceData = { related_objects: record.related_objects };
        }
      }

      // Add data_source to source_data if present
      if (record.data_source) {
        sourceData = sourceData || {};
        (sourceData as Record<string, unknown>).data_source = record.data_source;
      }

      await manager.save(EventEntity, {
        id: record.id,
        type: record.type || null,
        name: record.name || null,
        description: record.description || null,
        start_time: startTime,
        end_time: endTime,
        source_data: sourceData,
        external_id: record.provider_id || null,
        source_url: record.data_source || null,
        user: {
          id: record.user_id,
        },
        created_at: createdAt,
        updated_at: updatedAt,
      });
    }
  });

  logger.log(`Seeded ${records.length} event records`);
}
