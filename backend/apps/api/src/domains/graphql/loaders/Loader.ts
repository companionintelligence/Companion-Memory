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
   * must do it itself. Absent keys become `null`.
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
}
