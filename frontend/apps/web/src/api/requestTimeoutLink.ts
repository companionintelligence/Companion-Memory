/**
 * A deadline for the operations that ask for one. An operation sets `context.timeoutMs`;
 * if no result has arrived by then the request is cancelled and the operation fails with a
 * network error, the same as a dropped connection would. Operations that do not set it are
 * untouched, so a long mutation or upload is never cut short.
 *
 * A Memory that accepts the connection and never replies produces no failure of its own.
 * `useCurrentUser` is the one asker: without this, `me` stays loading forever and the page
 * never gets to say it cannot reach Memory.
 *
 * Unsubscribing here (Apollo does it on a refetch or unmount) unsubscribes the transport,
 * which aborts the request, so a deadline never leaves a stale request behind. Except on
 * native: `apiFetch` goes through CapacitorHttp there, which ignores the abort signal, so
 * the operation still fails at the deadline but the native request runs on to its own end.
 */
import { ApolloLink, Observable, type FetchResult, type ObservableSubscription } from '@apollo/client';

/** What an operation fails with when its `timeoutMs` passes. `name` is the DOM's own name for it. */
export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`No answer within ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

export function createRequestTimeoutLink(): ApolloLink {
  return new ApolloLink((operation, forward) => {
    const { timeoutMs } = operation.getContext() as { timeoutMs?: number };

    if (timeoutMs == null) {
      return forward(operation);
    }

    return new Observable<FetchResult>((observer) => {
      let subscription: ObservableSubscription | null = null;

      const timer = setTimeout(() => {
        subscription?.unsubscribe();
        observer.error(new RequestTimeoutError(timeoutMs));
      }, timeoutMs);

      subscription = forward(operation).subscribe({
        next: (result) => {
          clearTimeout(timer);
          observer.next(result);
        },
        error: (err) => {
          clearTimeout(timer);
          observer.error(err);
        },
        complete: () => {
          clearTimeout(timer);
          observer.complete();
        },
      });

      return () => {
        clearTimeout(timer);
        subscription?.unsubscribe();
      };
    });
  });
}
