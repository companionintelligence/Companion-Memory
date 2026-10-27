import type { UserScopedTable } from '../types';
import { groupUserTables, orderParentsFirst } from '../userDataTables';

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
});
