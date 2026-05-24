import DataLoader from 'dataloader';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

export abstract class Loader<V, K = string> {
  protected abstract readonly logger: LoggerService;

  private readonly loaders = new WeakMap<UserServiceContext, DataLoader<K, V>>();

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
