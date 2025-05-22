import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { app } from '../src/app';
import { LoggingService } from '../src/logging';
import { v4 as uuidv4 } from 'uuid';

declare const __dirname: string;
declare const process: any;

const logger = LoggingService.create('database-seeder');
const db = app.get('postgresqlClient');

type AnyRecord = Record<string, any>;

function readCsv(filePath: string) {
  const fileContent = fs.readFileSync(filePath, 'utf8');
  return parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    cast: (value: any) => (value === '' ? null : value),
  });
}

function validateCsvRecords(records: AnyRecord[], requiredFields: string[], fileName: string) {
  const errors: string[] = [];
  records.forEach((record, idx) => {
    requiredFields.forEach((field) => {
      if (record[field] === undefined || record[field] === null || record[field] === '') {
        errors.push(`Row ${idx + 2} in ${fileName} is missing required field: ${field}`);
      }
    });
  });
  if (errors.length > 0) {
    logger.warn(`Validation errors in ${fileName}:\n` + errors.join('\n'));
  } else {
    logger.info(`No missing required fields in ${fileName}`);
  }
}

function isValidUUID(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function seedEvents(filePath: string) {
  logger.info(`Seeding events from ${filePath}`);
  const records: AnyRecord[] = readCsv(filePath);
  validateCsvRecords(records, ['id', 'type', 'user_id', 'created'], 'js1-events.csv');
  const batchSize = 100;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const transformedBatch = batch.map((record: AnyRecord) => {
      let related_objects = null;
      if (record.related_objects) {
        try {
          const arr = JSON.parse(record.related_objects.replace(/'/g, '"'));
          if (Array.isArray(arr)) {
            const filtered = arr.filter(isValidUUID);
            if (filtered.length > 0) {
              related_objects = filtered;
            }
          }
        } catch {
          // skip if not valid JSON array
        }
      }
      // Only insert valid enum values for type, else set to null
      let eventType = null;
      const validEventTypes = [
        'View',
        'Play',
        'Message',
        'Comment',
        'Create',
        'Edit',
        'Call',
        'Visit',
        'Travel',
        'Eat',
        'Transactions',
        'Sleep',
        'Exercise',
      ];
      if (typeof record.type === 'string' && validEventTypes.includes(record.type)) {
        eventType = record.type;
      }
      return {
        id: uuidv4(),
        type: eventType,
        user_id: isValidUUID(record.user_id) ? record.user_id : null,
        related_objects,
        created: record.created && !isNaN(Date.parse(record.created)) ? new Date(record.created) : new Date(),
        updated: record.updated ? new Date(record.updated) : null,
        connection: isValidUUID(record.connection) ? record.connection : null,
        provider: isValidUUID(record.provider) ? record.provider : null,
        data_source: record.data_source || null,
      };
    });
    await db('event').insert(transformedBatch).onConflict('id').ignore();
    logger.info(`Inserted ${batch.length} events (batch ${i / batchSize + 1})`);
  }
}

async function seedPeople(filePath: string) {
  logger.info(`Seeding people from ${filePath}`);
  const records: AnyRecord[] = readCsv(filePath);
  validateCsvRecords(
    records,
    [
      'id',
      'first_name',
      'last_name',
      'address',
      'street_address',
      'street_address_2',
      'city',
      'region',
      'country',
      'postal_code',
      'avatar_url',
      'external_avatar_url',
      'type',
      'created',
      'hidden',
      'tags',
      'contact_ids',
      'middle_name',
      'gender',
    ],
    'js1-people.csv',
  );
  const batchSize = 100;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    // No need to check for existing IDs since we always generate new UUIDs
    const transformedBatch = batch.map((record: AnyRecord) => {
      // tags: if string, skip; if array, use; if null/empty, skip; else insert test value
      let tags = null;
      if (Array.isArray(record.tags)) {
        tags = record.tags;
      } else if (typeof record.tags === 'string') {
        // skip
      } else if (record.tags) {
        tags = ['test-tag'];
      }
      // contact_ids: if string, skip; if array, use; if null/empty, skip; else insert test value
      let contact_ids = null;
      if (Array.isArray(record.contact_ids)) {
        contact_ids = record.contact_ids;
      } else if (typeof record.contact_ids === 'string') {
        // skip
      } else if (record.contact_ids) {
        contact_ids = ['test-contact-id'];
      }
      return {
        id: uuidv4(), // always generate a new UUID for id
        first_name: record.first_name || null,
        last_name: record.last_name || null,
        address: record.address || null,
        street_address: record.street_address || null,
        street_address_2: record.street_address_2 || null,
        city: record.city || null,
        region: record.region || null,
        country: record.country || null,
        postal_code: record.postal_code || null,
        avatar_url: record.avatar_url || null,
        external_avatar_url: record.external_avatar_url || null,
        type: record.type || null,
        created: record.created && !isNaN(Date.parse(record.created)) ? new Date(record.created) : new Date(),
        hidden: record.hidden === 'TRUE' || record.hidden === 'true',
        tags,
        contact_ids,
        middle_name: record.middle_name || null,
        gender: record.gender || null,
      };
    });
    try {
      await db('person').insert(transformedBatch).onConflict('id').merge(); // upsert: update on conflict
      logger.info(`Upserted ${transformedBatch.length} people (batch ${i / batchSize + 1})`);
    } catch (err) {
      logger.error('Error upserting people batch:', err);
      logger.error('Batch data:', JSON.stringify(transformedBatch, null, 2));
      throw err;
    }
  }
}

async function seedPlaces(filePath: string) {
  logger.info(`Seeding places from ${filePath}`);
  const records: AnyRecord[] = readCsv(filePath);
  const batchSize = 100;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const transformedBatch = batch.map((record: AnyRecord) => ({
      id: isValidUUID(record.id) ? record.id : uuidv4(),
      // Add more fields and validation as needed
    }));
    try {
      await db('place').insert(transformedBatch).onConflict('id').merge();
      logger.info(`Upserted ${transformedBatch.length} places (batch ${i / batchSize + 1})`);
    } catch (err) {
      logger.error('Error upserting places batch:', err);
      logger.error('Batch data:', JSON.stringify(transformedBatch, null, 2));
      // Continue on error
    }
  }
}

async function seedLocations(filePath: string) {
  logger.info(`Seeding locations from ${filePath}`);
  const records: AnyRecord[] = readCsv(filePath);
  const batchSize = 100;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const transformedBatch = batch.map((record: AnyRecord) => ({
      id: isValidUUID(record.id) ? record.id : uuidv4(),
      // Add more fields and validation as needed
    }));
    try {
      await db('location').insert(transformedBatch).onConflict('id').merge();
      logger.info(`Upserted ${transformedBatch.length} locations (batch ${i / batchSize + 1})`);
    } catch (err) {
      logger.error('Error upserting locations batch:', err);
      logger.error('Batch data:', JSON.stringify(transformedBatch, null, 2));
      // Continue on error
    }
  }
}

async function seedContacts(filePath: string) {
  logger.info(`Seeding contacts from ${filePath}`);
  const records: AnyRecord[] = readCsv(filePath);
  const batchSize = 100;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const transformedBatch = batch.map((record: AnyRecord) => ({
      id: isValidUUID(record.id) ? record.id : uuidv4(),
      // Add more fields and validation as needed
    }));
    try {
      await db('contact').insert(transformedBatch).onConflict('id').merge();
      logger.info(`Upserted ${transformedBatch.length} contacts (batch ${i / batchSize + 1})`);
    } catch (err) {
      logger.error('Error upserting contacts batch:', err);
      logger.error('Batch data:', JSON.stringify(transformedBatch, null, 2));
      // Continue on error
    }
  }
}

async function seedContent(filePath: string) {
  logger.info(`Seeding content from ${filePath}`);
  const records: AnyRecord[] = readCsv(filePath);
  validateCsvRecords(records, ['type', 'title'], 'jsi-content.csv');
  const batchSize = 100;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const transformedBatch = batch.map((record: AnyRecord) => ({
      id: isValidUUID(record.id) ? record.id : uuidv4(),
      // Add more fields and validation as needed
    }));
    try {
      await db('content').insert(transformedBatch).onConflict('id').merge();
      logger.info(`Upserted ${transformedBatch.length} content (batch ${i / batchSize + 1})`);
    } catch (err) {
      logger.error('Error upserting content batch:', err);
      logger.error('Batch data:', JSON.stringify(transformedBatch, null, 2));
      // Continue on error
    }
  }
}

async function seedThings(filePath: string) {
  logger.info(`Seeding things from ${filePath}`);
  const records: AnyRecord[] = readCsv(filePath);
  validateCsvRecords(records, ['type', 'name'], 'js1-things.csv');
  const batchSize = 100;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const transformedBatch = batch.map((record: AnyRecord) => ({
      id: isValidUUID(record.id) ? record.id : uuidv4(),
      // Add more fields and validation as needed
    }));
    try {
      await db('thing').insert(transformedBatch).onConflict('id').merge();
      logger.info(`Upserted ${transformedBatch.length} things (batch ${i / batchSize + 1})`);
    } catch (err) {
      logger.error('Error upserting things batch:', err);
      logger.error('Batch data:', JSON.stringify(transformedBatch, null, 2));
      // Continue on error
    }
  }
}

async function seedUsers(filePath: string) {
  logger.info(`Seeding users from ${filePath}`);
  const records: AnyRecord[] = readCsv(filePath);
  validateCsvRecords(records, ['id', 'first_name', 'last_name', 'email', 'created'], 'js1-user.csv');
  const batchSize = 100;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const transformedBatch = batch.map((record: AnyRecord) => ({
      id: record.id || null,
      first_name: record.first_name || null,
      last_name: record.last_name || null,
      created: record.created && !isNaN(Date.parse(record.created)) ? new Date(record.created) : new Date(),
    }));
    await db('person').insert(transformedBatch).onConflict('id').ignore();
    logger.info(`Inserted ${batch.length} users (batch ${i / batchSize + 1})`);
  }
}

async function seedDatabase() {
  try {
    logger.info('Starting database seeding process');
    const dataDir = path.resolve(__dirname, '../../../../coverage/ci-js1-data');
    await seedUsers(path.join(dataDir, 'js1-user.csv'));
    await seedContacts(path.join(dataDir, 'js1-contact.csv'));
    await seedPeople(path.join(dataDir, 'js1-people.csv'));
    await seedLocations(path.join(dataDir, 'js1-location.csv'));
    await seedPlaces(path.join(dataDir, 'js1-place.csv'));
    await seedThings(path.join(dataDir, 'js1-things.csv'));
    await seedContent(path.join(dataDir, 'jsi-content.csv'));
    await seedEvents(path.join(dataDir, 'js1-events.csv'));
    logger.info('Database seeding completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error('Error seeding database:', error instanceof Error ? error.stack || error.message : error);
    console.error('Raw error:', error);
    process.exit(1);
  }
}

seedDatabase();
