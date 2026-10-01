/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE REPOSITORY CALLS AN UPSERT MAKES, OVER A MAP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `findOne({ where })`, `create()` and `save()` — enough for a spec to run a
 * REAL read-modify-write service method (`GraphUtilityService.createOrUpdateNode`,
 * `createOrUpdateRelationship`) and then assert on the row it left behind,
 * instead of on the arguments a mock was called with. A mock that records
 * arguments agrees with whatever the caller sends; this one shows what a write
 * actually did to a row that already held something.
 *
 * Rows are deep-copied in and out, the way a database hands back a fresh object
 * per read: a service cannot "save" by mutating a row it read earlier, and a
 * spec cannot pass by holding a reference the service still mutates.
 *
 * `where` matches by strict equality per column. A TypeORM `FindOperator`
 * (`In(...)`, `IsNull()`) is rejected rather than silently matching nothing —
 * a service that starts using one needs a real database, not a wider fake.
 */

/** The INSERT chain `GraphUtilityService` builds on a repository. */
interface InMemoryInsert<T> {
  insert(): InMemoryInsert<T>;
  into(target: unknown): InMemoryInsert<T>;
  values(row: T): InMemoryInsert<T>;
  onConflict(clause: string): InMemoryInsert<T>;
  returning(columns: string[]): InMemoryInsert<T>;
  execute(): Promise<{ raw: T[] }>;
}

export class InMemoryRepository<T extends object> {
  private readonly rows = new Map<string, T>();

  /** What `Repository.metadata.target` is: the insert chain reads it and ignores it. */
  readonly metadata = { target: {} };

  constructor(private readonly primaryKey: keyof T & string) {}

  /** Insert or overwrite rows directly — fixtures, or "another writer landed here". */
  seed(...rows: T[]): void {
    for (const row of rows) {
      this.rows.set(String(row[this.primaryKey]), structuredClone(row));
    }
  }

  /** A copy of the stored row, or `undefined`. */
  get(id: string): T | undefined {
    const row = this.rows.get(id);

    return row === undefined ? undefined : structuredClone(row);
  }

  all(): T[] {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }

  async findOne(options: { where: Partial<Record<keyof T, unknown>> }): Promise<T | null> {
    const conditions = Object.entries(options.where);

    for (const [column, value] of conditions) {
      if (value !== null && typeof value === 'object') {
        throw new Error(
          `InMemoryRepository.findOne: unsupported condition on ${column} — use a real database`,
        );
      }
    }

    for (const row of this.rows.values()) {
      if (conditions.every(([column, value]) => (row as Record<string, unknown>)[column] === value)) {
        return structuredClone(row);
      }
    }

    return null;
  }

  create(fields: Partial<T>): T {
    return { ...fields } as T;
  }

  async save(row: T): Promise<T> {
    this.seed(row);

    return structuredClone(row);
  }

  /**
   * The INSERT … ON CONFLICT chain `GraphUtilityService` uses for a new node or
   * edge. A yielded insert (a row already on the conflict key) is not modelled:
   * the specs that need that run against Postgres.
   */
  createQueryBuilder(): InMemoryInsert<T> {
    let row: T | undefined;
    const builder = {
      insert: () => builder,
      into: () => builder,
      values: (next: T) => {
        row = next;

        return builder;
      },
      onConflict: () => builder,
      returning: () => builder,
      execute: async () => {
        if (row === undefined) {
          throw new Error('InMemoryRepository.createQueryBuilder: insert without values');
        }

        this.seed(row);

        return { raw: [structuredClone(row)] };
      },
    };

    return builder;
  }
}
