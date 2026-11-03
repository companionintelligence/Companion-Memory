import { BadRequestException } from '@nestjs/common';

import { OWNED_TABLES, refuseForeignLinks } from './refuseForeignLinks';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
const PLACE = '00000000-0000-0000-0000-0000000000b1';
const SCAN = '00000000-0000-0000-0000-0000000000c1';

function managerReturning(rows: unknown) {
  const query = jest.fn(async (_sql: string, _params: unknown[]) => rows);

  return { manager: { query } as never, query };
}

describe('refuseForeignLinks', () => {
  it('asks nothing when no link names a row', async () => {
    const { manager, query } = managerReturning([]);

    await refuseForeignLinks(
      manager,
      OWNER,
      [{ field: 'place_entity_id', ...OWNED_TABLES.entities, ids: [null, undefined] }],
      'receipt',
    );

    expect(query).not.toHaveBeenCalled();
  });

  it('checks every link that names a row in one statement, each id once', async () => {
    const { manager, query } = managerReturning([]);

    await refuseForeignLinks(
      manager,
      OWNER,
      [
        { field: 'place_entity_id', ...OWNED_TABLES.entities, ids: [PLACE, null, PLACE] },
        { field: 'event_id', ...OWNED_TABLES.events, ids: [null] },
        { field: 'document_content_id', ...OWNED_TABLES.content, ids: [SCAN] },
      ],
      'receipt',
    );

    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];

    expect(params).toEqual([OWNER, [PLACE], [SCAN]]);
    expect(sql).toContain('FROM ci.entities');
    expect(sql).toContain('FROM ci.content');
    expect(sql).not.toContain('FROM ci.events');
    expect(sql).toContain('owner_user_id IS DISTINCT FROM $1::uuid');
    expect(sql).toContain('id = ANY($3::uuid[])');
  });

  it('names the link whose id is a row of another account', async () => {
    const { manager } = managerReturning([{ link: 1, id: SCAN }]);

    const refused = refuseForeignLinks(
      manager,
      OWNER,
      [
        { field: 'place_entity_id', ...OWNED_TABLES.entities, ids: [PLACE] },
        { field: 'document_content_id', ...OWNED_TABLES.content, ids: [SCAN] },
      ],
      'receipt',
    );

    await expect(refused).rejects.toBeInstanceOf(BadRequestException);
    await expect(refused).rejects.toThrow(
      `document_content_id ${SCAN} is a row of ci.content that belongs to another account or to none, so the receipt was refused.`,
    );
  });
});
