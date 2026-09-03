import DataLoader from 'dataloader';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

export abstract class Loader<V, K = string> {
  protected abstract readonly logger: LoggerService;

  private readonly loaders = new WeakMap<UserServiceContext, DataLoader<K, V>>();

  /**
   * One value per key, IN KEY ORDER — DataLoader hands entry `i` to whoever
   * asked for key `i`, so a result that is merely the set of matching rows
   * pairs each caller with somebody else's. A `WHERE id IN (...)` lookup gives
   * neither guarantee: rows arrive in the planner's order, and an id that is
   * missing or invisible to this caller does not arrive at all. Most services
   * here already re-key before returning; a subclass whose service does not
   * must do it itself, with {@link rekey}. Absent keys become `null` (or the
   * empty collection, for the list-valued loaders).
   *
   * `__tests__/loaderKeyOrder.test.ts` holds every loader in this directory to
   * that contract, driving each one with a collaborator that deliberately
   * reverses its rows and drops an id.
   */
  protected abstract batchLoad(context: UserServiceContext, keys: readonly K[]): Promise<readonly V[]>;

  protected getLoader(context: UserServiceContext): DataLoader<K, V> {
    let loader = this.loaders.get(context);

    if (!loader) {
      this.logger.log('Creating new data loader');

      loader = new DataLoader<K, V>((keys) => this.batchLoad(context, keys));

      this.loaders.set(context, loader);
    }

    return loader;
  }

  load(context: UserServiceContext, key: K): Promise<V> {
    return this.getLoader(context).load(key);
  }

  loadMany(context: UserServiceContext, keys: readonly K[]): Promise<readonly (V | Error)[]> {
    return this.getLoader(context).loadMany(keys);
  }

  clear(context: UserServiceContext, key: K): this {
    this.getLoader(context).clear(key);

    return this;
  }

  clearAll(context: UserServiceContext): this {
    this.getLoader(context).clearAll();

    return this;
  }

  prime(context: UserServiceContext, key: K, value: V): this {
    this.getLoader(context).prime(key, value);

    return this;
  }

  /**
   * Pair a batch of rows back onto the keys that asked for them.
   *
   * The row set a `WHERE id IN (...)` read returns is not a batch result: it
   * arrives in the planner's order and is short by one for every id that is
   * missing or invisible to the caller. Zipping that against the keys by
   * position is what captioned five real answers on this appliance with four
   * other answers' questions.
   *
   * Every loader that reads single rows indexes them here rather than trusting
   * the service it happens to call to have indexed them already, so the
   * invariant is local to the file the test drives — a service changing shape
   * can no longer reach GraphQL as silently mis-attributed data.
   *
   * `keyOf` may return null for a row that carries no key (a nullable
   * `parent_id`); such a row is dropped rather than claiming a key.
   */
  protected rekey<T>(
    keys: readonly K[],
    rows: readonly (T | null | undefined)[],
    keyOf: (row: T) => K | null | undefined,
  ): (T | null)[] {
    const byKey = new Map<K, T>();

    for (const row of rows) {
      if (row == null) {
        continue;
      }

      const key = keyOf(row);

      if (key != null) {
        byKey.set(key, row);
      }
    }

    return keys.map((key) => byKey.get(key) ?? null);
  }
}
