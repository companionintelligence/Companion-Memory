import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, IsNull } from 'typeorm';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { ContentBaseEntity } from '../../entities/ContentBaseEntity';
import { ContentEntity } from '../../entities/ContentEntity';
import { EventEntity } from '../../entities/EventEntity';
import { ContentService } from '../ContentService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * A photo's generated label lands on the FILE; the content library searches
 * the CONTENT row. `applyFileLabel` is the bridge: it finds the content rows
 * wrapping a file and writes the label through the ordinary `update` path so
 * the graph delta and the search re-index fire like any other edit.
 */
describe('ContentService.applyFileLabel', () => {
  const FILE_ID = '0198f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f';
  const ctx = { userId: 'user-1' } as UserServiceContext;
  const label = { title: 'Squirrel Facing Camera on Pavement', description: 'A squirrel on a path.' };

  let service: ContentService;
  let repo: { find: jest.Mock };
  let update: jest.SpyInstance;

  beforeEach(async () => {
    repo = { find: jest.fn(async () => []) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ContentService,
        { provide: getRepositoryToken(ContentEntity), useValue: repo },
        { provide: getRepositoryToken(ContentBaseEntity), useValue: {} },
        { provide: getRepositoryToken(EventEntity), useValue: {} },
        { provide: SignallingEventService, useValue: { send: jest.fn() } },
        { provide: GraphDeltaWriter, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(ContentService);
    update = jest.spyOn(service, 'update').mockImplementation(async (_ctx, id) => ({ id }) as never);
  });

  it('writes the title as the name and the description as the text of every wrapping row', async () => {
    repo.find.mockResolvedValueOnce([
      { id: 'c1', externalId: FILE_ID },
      { id: 'c2', externalId: FILE_ID },
    ]);

    await expect(service.applyFileLabel(ctx, FILE_ID, label)).resolves.toEqual(['c1', 'c2']);

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith(ctx, 'c1', { title: label.title, text: label.description });
    expect(update).toHaveBeenCalledWith(ctx, 'c2', { title: label.title, text: label.description });
  });

  it("looks up rows by external_id, kind 'file' or unclassified, scoped to the user", async () => {
    await service.applyFileLabel(ctx, FILE_ID, label);

    expect(repo.find).toHaveBeenCalledWith({
      select: ['id', 'externalId'],
      where: [
        { userId: 'user-1', externalId: In([FILE_ID]), externalIdKind: 'file' },
        { userId: 'user-1', externalId: In([FILE_ID]), externalIdKind: IsNull() },
      ],
      order: { createdAt: 'ASC' },
    });
  });

  it('drops the user scope for the system user', async () => {
    await service.applyFileLabel({ userId: SYSTEM_USER } as ServiceContext, FILE_ID, label);

    const [{ where }] = repo.find.mock.calls[0] as [{ where: Record<string, unknown>[] }];

    expect(where.every((clause) => !('userId' in clause))).toBe(true);
  });

  it('is a no-op for a file with no content row', async () => {
    await expect(service.applyFileLabel(ctx, FILE_ID, label)).resolves.toEqual([]);

    expect(update).not.toHaveBeenCalled();
  });

  it('groups rows per file and skips a file with none', async () => {
    const OTHER = '0198f0a1-2b3c-7d4e-8f90-000000000000';
    repo.find.mockResolvedValueOnce([
      { id: 'c1', externalId: FILE_ID },
      { id: 'c2', externalId: FILE_ID },
    ]);

    const byFile = await service.findIdsByFileIds(ctx, [FILE_ID, OTHER]);

    expect([...byFile.entries()]).toEqual([[FILE_ID, ['c1', 'c2']]]);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: [
          expect.objectContaining({ externalId: In([FILE_ID, OTHER]) }),
          expect.objectContaining({ externalId: In([FILE_ID, OTHER]) }),
        ],
      }),
    );
  });

  it('does not query for an empty id list', async () => {
    await expect(service.findIdsByFileIds(ctx, [])).resolves.toEqual(new Map());

    expect(repo.find).not.toHaveBeenCalled();
  });

  it('omits a row whose update found nothing', async () => {
    repo.find.mockResolvedValueOnce([
      { id: 'c1', externalId: FILE_ID },
      { id: 'gone', externalId: FILE_ID },
    ]);
    update.mockImplementation(async (_ctx, id) => (id === 'gone' ? null : ({ id } as never)));

    await expect(service.applyFileLabel(ctx, FILE_ID, label)).resolves.toEqual(['c1']);
  });
});
