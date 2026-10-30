import type { UserScopedTable } from '../types';
import {
  findAccountLinks,
  findLinkTables,
  groupUserTables,
  linkOutOfAccountMessage,
  orderParentsFirst,
} from '../userDataTables';

function table(name: string): UserScopedTable {
  const [schema, tableName] = name.split('.');

  return { schema, table: tableName, userColumn: 'user_id', userColumns: ['user_id'], columns: ['user_id'] };
}

const names = (tables: UserScopedTable[]) => tables.map((t) => `${t.schema}.${t.table}`);

describe('orderParentsFirst', () => {
  it('puts each table after the tables it references, and leaves the rest in discovery order', () => {
    const discovered = [
      'ci.events',
      'ci.messages',
      'ci.notes',
      'ci.threads',
      'ci_search.mobile_search_documents',
      'ci_search.vectors',
    ].map(table);
    const parents = new Map([
      ['ci.messages', ['ci.threads']],
      ['ci_search.mobile_search_documents', ['ci_search.vectors']],
    ]);

    expect(names(orderParentsFirst(discovered, parents))).toEqual([
      'ci.events',
      'ci.notes',
      'ci.threads',
      'ci.messages',
      'ci_search.vectors',
      'ci_search.mobile_search_documents',
    ]);
  });

  it('follows a chain of references', () => {
    const discovered = ['ci.object_observations', 'ci.objects', 'ci.receipt_line_items', 'ci.receipts'].map(
      table,
    );
    const parents = new Map([
      ['ci.object_observations', ['ci.objects']],
      ['ci.objects', ['ci.receipt_line_items', 'ci.receipts']],
      ['ci.receipt_line_items', ['ci.receipts']],
    ]);

    expect(names(orderParentsFirst(discovered, parents))).toEqual([
      'ci.receipts',
      'ci.receipt_line_items',
      'ci.objects',
      'ci.object_observations',
    ]);
  });

  it('keeps a table that only depends on a cycle after the tables in it', () => {
    // The schema's own shape: objects and receipt line items point at each other.
    const discovered = ['ci.object_observations', 'ci.objects', 'ci.receipt_line_items', 'ci.receipts'].map(
      table,
    );
    const parents = new Map([
      ['ci.object_observations', ['ci.objects']],
      ['ci.objects', ['ci.receipt_line_items', 'ci.receipts']],
      ['ci.receipt_line_items', ['ci.objects', 'ci.receipts']],
    ]);

    expect(names(orderParentsFirst(discovered, parents))).toEqual([
      'ci.receipts',
      'ci.objects',
      'ci.object_observations',
      'ci.receipt_line_items',
    ]);
  });

  it('ignores references to tables an export does not carry, and survives a cycle', () => {
    const discovered = ['ci.a', 'ci.b', 'ci.c'].map(table);
    const parents = new Map([
      ['ci.a', ['ci.users', 'ci.b']],
      ['ci.b', ['ci.a']],
    ]);

    expect(names(orderParentsFirst(discovered, parents)).sort()).toEqual(['ci.a', 'ci.b', 'ci.c']);
    expect(names(orderParentsFirst(discovered, parents))[0]).toBe('ci.c');
  });
});

describe('groupUserTables', () => {
  it('orders by the parents discovery reports', () => {
    const tables = groupUserTables([
      {
        schema: 'ci',
        table: 'messages',
        user_column: 'user_id',
        columns: ['user_id'],
        parents: ['ci.threads', 'ci.users'],
      },
      { schema: 'ci', table: 'threads', user_column: 'user_id', columns: ['user_id'], parents: ['ci.users'] },
    ]);

    expect(names(tables)).toEqual(['ci.threads', 'ci.messages']);
  });

  it('keeps the links a table has to its own rows, once per table', () => {
    const selfReferences = [{ column: 'merged_into_object_id', key: 'id' }];
    const [objects] = groupUserTables([
      {
        schema: 'ci',
        table: 'objects',
        user_column: 'owner_user_id',
        columns: ['id'],
        self_references: selfReferences,
      },
      {
        schema: 'ci',
        table: 'objects',
        user_column: 'user_id',
        columns: ['id'],
        self_references: selfReferences,
      },
    ]);

    expect(objects.selfReferences).toEqual(selfReferences);
  });

  it('reads a table without such links as having none', () => {
    const [notes] = groupUserTables([
      { schema: 'ci', table: 'notes', user_column: 'user_id', columns: ['id'] },
    ]);

    expect(notes.selfReferences).toEqual([]);
    expect(notes.laterReferences).toEqual([]);
    expect(notes.primaryKey).toBeNull();
  });

  it('marks the reference a cycle leaves pointing at a table filled later, and only that one', () => {
    const tables = groupUserTables([
      {
        schema: 'ci',
        table: 'objects',
        user_column: 'user_id',
        columns: ['object_id'],
        parents: ['ci.receipt_line_items'],
        nullable_references: [
          { column: 'acquisition_line_item_id', parent: 'ci.receipt_line_items', key: 'line_item_id' },
        ],
        primary_key: 'object_id',
      },
      {
        schema: 'ci',
        table: 'receipt_line_items',
        user_column: 'user_id',
        columns: ['line_item_id'],
        parents: ['ci.objects'],
        nullable_references: [{ column: 'minted_object_id', parent: 'ci.objects', key: 'object_id' }],
        primary_key: 'line_item_id',
      },
    ]);

    expect(names(tables)).toEqual(['ci.objects', 'ci.receipt_line_items']);
    expect(tables[0].primaryKey).toBe('object_id');
    expect(tables[0].laterReferences).toEqual([
      {
        column: 'acquisition_line_item_id',
        parent: { schema: 'ci', table: 'receipt_line_items', key: 'line_item_id', userColumn: 'user_id' },
      },
    ]);
    expect(tables[1].laterReferences).toEqual([]);
  });
});

describe('findLinkTables', () => {
  const reference = (child: string, column: string, parent: string, deleteAction: string) => {
    const [schema, table] = child.split('.');
    const [parentSchema, parentTable] = parent.split('.');

    return {
      schema,
      table,
      column,
      parent_schema: parentSchema,
      parent_table: parentTable,
      parent_column: 'id',
      delete_action: deleteAction,
    };
  };

  const userTables = groupUserTables([
    { schema: 'ci', table: 'events', user_column: 'user_id', columns: ['id'] },
    { schema: 'hbpe', table: 'l1_clusters', user_column: 'user_id', columns: ['id'] },
    { schema: 'ci_search', table: 'tags', user_column: 'user_id', columns: ['id'] },
  ]);

  it('finds a table without a user column that holds a blocking key into the account tables', () => {
    const [cluster] = findLinkTables(
      [
        reference('hbpe.l1_event_cluster', 'event_id', 'ci.events', 'a'),
        reference('hbpe.l1_event_cluster', 'cluster_id', 'hbpe.l1_clusters', 'a'),
      ],
      userTables,
    );

    expect(cluster.table).toBe('l1_event_cluster');
    expect(cluster.references.map(({ column, parent }) => [column, parent.userColumn])).toEqual([
      ['event_id', 'user_id'],
      ['cluster_id', 'user_id'],
    ]);
  });

  it('leaves out account tables, ci.users and a table that only mentions an account row', () => {
    expect(
      findLinkTables(
        [
          reference('ci.events', 'thread_id', 'ci_search.tags', 'a'),
          reference('ci.users', 'entity_id', 'ci.events', 'a'),
          reference('ci.ask_audit', 'event_id', 'ci.events', 'n'),
        ],
        userTables,
      ),
    ).toEqual([]);
  });

  it('finds a table whose rows go with an account row by cascade', () => {
    // ci.message_files: the import's delete would take a message's attachments
    // with it, and an archive does not carry them.
    expect(
      findLinkTables(
        [reference('ci_search.tag_categories', 'category_tag_id', 'ci_search.tags', 'c')],
        userTables,
      ).map(({ table }) => table),
    ).toEqual(['tag_categories']);
  });
});

describe('findAccountLinks', () => {
  const reference = (child: string, column: string, parent: string, parentColumn: string) => {
    const [schema, tableName] = child.split('.');
    const [parentSchema, parentTable] = parent.split('.');

    return {
      schema,
      table: tableName,
      column,
      parent_schema: parentSchema,
      parent_table: parentTable,
      parent_column: parentColumn,
      delete_action: 'a',
    };
  };

  const withColumns = (
    name: string,
    columns: string[],
    userColumn: 'user_id' | 'owner_user_id' = 'user_id',
  ) => ({
    ...table(name),
    userColumn,
    columns,
  });
  const entities = withColumns('ci.entities', ['entity_id', 'owner_user_id'], 'owner_user_id');
  const describeLinks = (links: ReturnType<typeof findAccountLinks>) =>
    links.map(({ child, column, parent, array }) => [
      `${child.schema}.${child.table}.${column}`,
      `${parent.schema}.${parent.table}.${parent.column}`,
      parent.userColumn,
      array,
    ]);

  it("checks each key between the account's tables, each entity column without one and the listed unkeyed links", () => {
    const links = findAccountLinks(
      [
        reference('ci.messages', 'thread_id', 'ci.threads', 'thread_id'),
        reference('ci.messages', 'parent_message_id', 'ci.messages', 'message_id'),
        // Into ci.users or from a table with no user column: neither is an account's row.
        reference('ci.graph_deltas', 'changed_by_user_id', 'ci.users', 'id'),
        reference('ci_search.entity_tag', 'tag_id', 'ci_search.tags', 'tag_id'),
      ],
      [
        { schema: 'ci', table: 'relationships', column: 'to_entity_id', array: false },
        { schema: 'ci', table: 'communications', column: 'to_entity_ids', array: true },
        // Excluded tables are not imported, so nothing is checked on them.
        { schema: 'ci', table: 'peer_links', column: 'person_entity_id', array: false },
      ],
      [
        withColumns('ci.messages', ['message_id', 'thread_id', 'parent_message_id', 'user_id']),
        withColumns('ci.threads', ['thread_id', 'user_id']),
        withColumns('ci.graph_deltas', ['changed_by_user_id', 'user_id']),
        withColumns('ci.relationships', ['to_entity_id', 'owner_user_id'], 'owner_user_id'),
        withColumns('ci.communications', ['id', 'to_entity_ids', 'user_id']),
        withColumns('ci.agent_jobs', ['id', 'thread_id', 'user_id']),
        entities,
      ],
    );

    expect(describeLinks(links)).toEqual([
      ['ci.messages.thread_id', 'ci.threads.thread_id', 'user_id', false],
      ['ci.messages.parent_message_id', 'ci.messages.message_id', 'user_id', false],
      ['ci.relationships.to_entity_id', 'ci.entities.entity_id', 'owner_user_id', false],
      ['ci.communications.to_entity_ids', 'ci.entities.entity_id', 'owner_user_id', true],
      ['ci.agent_jobs.thread_id', 'ci.threads.thread_id', 'user_id', false],
    ]);
  });

  it('skips a listed link whose column or key the schema does not have', () => {
    const links = findAccountLinks(
      [],
      [],
      [withColumns('ci.agent_jobs', ['id', 'user_id']), withColumns('ci.threads', ['thread_id', 'user_id'])],
    );

    expect(links).toEqual([]);
  });

  it('checks no entity column when the account has no entities table to check it against', () => {
    expect(
      findAccountLinks(
        [],
        [{ schema: 'ci', table: 'relationships', column: 'to_entity_id' }],
        [withColumns('ci.relationships', ['to_entity_id', 'owner_user_id'], 'owner_user_id')],
      ),
    ).toEqual([]);
  });

  it('names the link and the id it points at', () => {
    expect(
      linkOutOfAccountMessage(
        { child: table('ci.relationships'), column: 'to_entity_id', parent: entities },
        '01a1769a-0000-7000-8000-000000000000',
      ),
    ).toBe(
      'The archive links ci.relationships.to_entity_id to 01a1769a-0000-7000-8000-000000000000, a row of ' +
        'ci.entities that belongs to another account, so it was refused.',
    );
  });
});
