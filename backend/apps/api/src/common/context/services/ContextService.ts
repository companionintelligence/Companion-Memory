import { AsyncLocalStorage } from 'async_hooks';

import { Injectable, Scope } from '@nestjs/common';

import type { RequestContext } from '../types';

type RequestContextRequiredTrace = RequestContext & {
  traceId: string;
};

@Injectable({ scope: Scope.DEFAULT })
export class ContextService {
  private static storage = new AsyncLocalStorage<RequestContext>();

  static getContext(): RequestContext | undefined {
    return this.storage.getStore();
  }

  static getTraceId(): string | null {
    const context = this.getContext();

    return context?.traceId ?? null;
  }

  static getUserId(): string | null {
    const context = this.getContext();

    return context?.userId ?? null;
  }

  static run<T>(context: RequestContextRequiredTrace, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  static set(data: Partial<RequestContext>): void {
    const store = this.storage.getStore();

    if (store) {
      Object.assign(store, data);
    }
  }
}
