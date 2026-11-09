import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { ServiceContext, UserServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { ContentBaseEntity } from '../../entities/ContentBaseEntity';
import { ContentEntity } from '../../entities/ContentEntity';
import { EventEntity } from '../../entities/EventEntity';
import { ContentService } from '../ContentService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * `toDetailFields` is the one choke point every content write funnels through
 * (`create` and `createManyDetailed` both build entities from it), so it is
 * where `external_id_kind` gets stamped. These tests pin that contract: an
 * explicit kind from a caller that KNOWS always wins, and everything else is
 * classified by shape rather than left for the next backfill migration to
 * guess at from source_system — which is how defect F22 happened.
 */
describe('ContentService external_id_kind stamping', () => {
  let service: ContentService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { transaction: jest.Mock; query: jest.Mock };
  };
  let baseRepo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    metadata: { columns: unknown[] };
  };

  const ctx = { userId: 'user-1' } as UserServiceContext;

  /** The detail row `create` handed to the repository. */
  const savedDetail = (): Partial<ContentEntity> => repo.save.mock.calls[0][0] as Partial<ContentEntity>;

  beforeEach(async () => {
    baseRepo = {
      create: jest.fn((x: Partial<ContentBaseEntity>) => x),
      save: jest.fn(async (x: Partial<ContentBaseEntity>) => x),
      find: jest.fn(async () => []),
      findOne: jest.fn(async () => ({ id: 'c1', name: null })),
      update: jest.fn(async () => ({ affected: 1 })),
      delete: jest.fn(async () => ({ affected: 1 })),
      metadata: { columns: Array.from({ length: 10 }) },
    };
    repo = {
      findOne: jest.fn(),
      find: jest.fn(async () => []),
      create: jest.fn((x: Partial<ContentEntity>) => x),
      save: jest.fn(async (x: Partial<ContentEntity>) => ({ ...x, id: x.id ?? 'c1' })),
      update: jest.fn(async () => ({ affected: 1 })),
      createQueryBuilder: jest.fn(),
      manager: {
        // refuseForeignLinks: no named event or file is another account's.
        query: jest.fn(async () => []),
        transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
          cb({
            getRepository: (cls: unknown): unknown => (cls === ContentBaseEntity ? baseRepo : repo),
          }),
        ),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ContentService,
        { provide: getRepositoryToken(ContentEntity), useValue: repo },
        { provide: getRepositoryToken(ContentBaseEntity), useValue: baseRepo },
        { provide: getRepositoryToken(EventEntity), useValue: { find: jest.fn(async () => []) } },
        { provide: SignallingEventService, useValue: { send: jest.fn() } },
        {
          provide: GraphDeltaWriter,
          useValue: {
            entityCreated: jest.fn(async () => undefined),
            entityUpdated: jest.fn(async () => undefined),
            entityDeleted: jest.fn(async () => undefined),
            recordMany: jest.fn(async () => undefined),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(ContentService);
  });

  it('classifies a uuid external_id as a file id when the caller says nothing', async () => {
    await service.create(ctx, {
      id: 'c1',
      type: 'media',
      external_id: '0198f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f',
    });

    expect(savedDetail().externalIdKind).toBe('file');
  });

  it('classifies a scheme-prefixed external_id as external_uri when the caller says nothing', async () => {
    // The GraphQL createContent mutation has no externalIdKind field, so this
    // is the only thing standing between it and an unclassified row.
    await service.create(ctx, {
      id: 'c1',
      type: 'media',
      external_id: 'amazonmusic:album:B08XYZ1234',
    });

    expect(savedDetail().externalIdKind).toBe('external_uri');
  });

  it('leaves a bare platform id unclassified rather than guessing file', async () => {
    await service.create(ctx, { id: 'c1', type: 'Music', external_id: 'dQw4w9WgXcQ' });

    expect(savedDetail().externalIdKind).toBeUndefined();
  });

  it('leaves the kind unset when there is no external_id at all', async () => {
    await service.create(ctx, { id: 'c1', type: 'web-page', url: 'https://example.com' });

    expect(savedDetail().externalIdKind).toBeUndefined();
  });

  it('lets an explicit kind override the shape test — the writer knows more', async () => {
    // The ETL transforms stamp 'external_uri' for bare platform ids the shape
    // test cannot recognise; that must survive the fallback.
    await service.create(ctx, {
      id: 'c1',
      type: 'Music',
      external_id: '3n3Ppam7vgaVa1iaRUc9Lp',
      external_id_kind: 'external_uri',
    });

    expect(savedDetail().externalIdKind).toBe('external_uri');
  });

  it('routes createMany through the same stamping', async () => {
    repo.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(async () => []),
    });

    // createManyDetailed builds its entities with the same toDetailFields, so
    // assert on what the repository's `create` factory was handed rather than
    // driving the whole bulk-insert path.
    repo.create.mockClear();
    await service
      .createMany(ctx, [
        { id: 'c1', type: 'media', external_id: '0198f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f' },
        { id: 'c2', type: 'Music', external_id: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' },
      ])
      .catch(() => undefined);

    const kinds = repo.create.mock.calls.map((call) => (call[0] as Partial<ContentEntity>).externalIdKind);
    expect(kinds).toEqual(['file', 'external_uri']);
  });

  describe('update', () => {
    it('re-derives the kind when external_id changes and the caller did not say', async () => {
      repo.findOne.mockResolvedValue(
        Object.assign(new ContentEntity(), { id: 'c1', userId: 'user-1', type: 'media' }),
      );

      await service.update({ userId: 'user-1' } as ServiceContext, 'c1', {
        external_id: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
      });

      expect(repo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ externalIdKind: 'external_uri' }),
      );
    });

    it('clears a now-stale kind when the new external_id fits neither shape', async () => {
      // Carrying the old 'file' forward would leave the row asserting that a
      // YouTube videoId resolves against ci.files.
      repo.findOne.mockResolvedValue(
        Object.assign(new ContentEntity(), { id: 'c1', userId: 'user-1', type: 'media' }),
      );

      await service.update({ userId: 'user-1' } as ServiceContext, 'c1', {
        external_id: 'dQw4w9WgXcQ',
      });

      expect(repo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ externalIdKind: null }),
      );
    });

    it('does not touch the kind when external_id is not being updated', async () => {
      repo.findOne.mockResolvedValue(
        Object.assign(new ContentEntity(), { id: 'c1', userId: 'user-1', type: 'media' }),
      );

      await service.update({ userId: 'user-1' } as ServiceContext, 'c1', { text: 'new text' });

      expect(repo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.objectContaining({ externalIdKind: expect.anything() }),
      );
    });
  });
});
