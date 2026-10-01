import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { EventService } from '@ci/domains/events';
import { FileService as FileStorageService } from '@ci/domains/files';

import { BaseEntity } from '../../entities/BaseEntity';
import { ContentBaseEntity } from '../../entities/ContentBaseEntity';
import { ContentEntity } from '../../entities/ContentEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { MemoryModule } from '../../index';
import { CalendarEventService } from '../CalendarEventService';
import { ContentService } from '../ContentService';
import { STORED_OBJECTS } from '../filePurge';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OBJECT STORE REACHES THE SERVICES THAT DELETE A PHOTO'S BYTES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ContentService.purge` and `CalendarEventService.purge` delete the stored file a photo's content wraps, which
 * takes an object store. They take it through an optional injection token, so that a service built without one
 * still does everything else, and every other suite builds them by hand and passes the store in.
 *
 * That is exactly what cannot catch the wiring going wrong. Were the token dropped from a constructor, or the
 * provider from `MemoryModule`, Nest would build both services without a store and say nothing, and every purge
 * of a photo would then be refused, in production, with a message about a store that is not configured. So this
 * is the one place that asks Nest.
 */
describe('the object store reaches the services that delete a photo’s bytes', () => {
  const store = { deleteObjects: jest.fn(async () => undefined) };

  /** Everything else the two services take, which is not what this is about. */
  const others = [
    { provide: getRepositoryToken(ContentEntity), useValue: {} },
    { provide: getRepositoryToken(ContentBaseEntity), useValue: {} },
    { provide: getRepositoryToken(EventEntity), useValue: {} },
    { provide: getRepositoryToken(EventBaseEntity), useValue: {} },
    { provide: getRepositoryToken(BaseEntity), useValue: {} },
    { provide: EventService, useValue: {} },
    { provide: GraphDeltaWriter, useValue: {} },
    { provide: DataSource, useValue: {} },
  ];

  const storeOf = (service: unknown): unknown => (service as { storedObjects?: unknown }).storedObjects;

  it('hands it to ContentService and CalendarEventService, under the token they ask for it by', async () => {
    const module = await Test.createTestingModule({
      providers: [
        ContentService,
        CalendarEventService,
        ...others,
        { provide: STORED_OBJECTS, useValue: store },
      ],
    }).compile();

    expect(storeOf(module.get(ContentService))).toBe(store);
    expect(storeOf(module.get(CalendarEventService))).toBe(store);
  });

  it('builds both without one, which is what lets everything that has no stored bytes still be purged', async () => {
    const module = await Test.createTestingModule({
      providers: [ContentService, CalendarEventService, ...others],
    }).compile();

    expect(storeOf(module.get(ContentService))).toBeUndefined();
    expect(storeOf(module.get(CalendarEventService))).toBeUndefined();
  });

  it('is provided by MemoryModule, from the files domain’s own service, which is the one that deletes objects', () => {
    const providers: unknown[] = Reflect.getMetadata('providers', MemoryModule);
    const provider = providers.find(
      (entry): entry is { provide: unknown; useExisting: unknown } =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { provide?: unknown }).provide === STORED_OBJECTS,
    );

    expect(provider).toBeDefined();
    expect(provider?.useExisting).toBe(FileStorageService);
    // What the token resolves to must be able to delete objects, or the services would fail at the first purge.
    expect(typeof FileStorageService.prototype.deleteObjects).toBe('function');
  });
});
