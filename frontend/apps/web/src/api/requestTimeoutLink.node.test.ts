import { ApolloLink, Observable, execute, type FetchResult } from '@apollo/client';
import { parse } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestTimeoutError, createRequestTimeoutLink } from './requestTimeoutLink';

// parse(), not gql: web codegen reads every gql document under src/.
const QUERY = parse(`
  query RequestTimeoutProbe {
    probe {
      id
    }
  }
`);

/** A transport that takes the request and, until `answer` is called, never replies. */
function hangingTransport() {
  let answer: (result: FetchResult) => void = () => undefined;
  const unsubscribed = vi.fn();
  const transport = new ApolloLink(
    () =>
      new Observable<FetchResult>((observer) => {
        answer = (result) => {
          observer.next(result);
          observer.complete();
        };

        return unsubscribed;
      }),
  );

  return { transport, answer: (result: FetchResult) => answer(result), unsubscribed };
}

function run(link: ApolloLink, context?: Record<string, unknown>) {
  const settled = { result: undefined as FetchResult | undefined, error: undefined as unknown };
  const subscription = execute(link, { query: QUERY, context }).subscribe({
    next: (result) => {
      settled.result = result;
    },
    error: (err) => {
      settled.error = err;
    },
  });

  return { settled, subscription };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRequestTimeoutLink', () => {
  it('fails an operation that asks for a deadline once it passes, and cancels the transport', () => {
    const { transport, unsubscribed } = hangingTransport();
    const { settled } = run(createRequestTimeoutLink().concat(transport), { timeoutMs: 25_000 });

    vi.advanceTimersByTime(24_999);
    expect(settled.error).toBeUndefined();

    vi.advanceTimersByTime(1);
    expect(settled.error).toBeInstanceOf(RequestTimeoutError);
    expect((settled.error as Error).name).toBe('TimeoutError');
    expect(unsubscribed).toHaveBeenCalledTimes(1);
  });

  it('passes an answer that arrives within the deadline, and then stops the clock', () => {
    const { transport, answer } = hangingTransport();
    const { settled } = run(createRequestTimeoutLink().concat(transport), { timeoutMs: 25_000 });

    vi.advanceTimersByTime(18_000);
    answer({ data: { probe: { id: '1' } } });
    vi.advanceTimersByTime(60_000);

    expect(settled.result).toEqual({ data: { probe: { id: '1' } } });
    expect(settled.error).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves an operation that sets no deadline waiting', () => {
    const { transport } = hangingTransport();
    const { settled } = run(createRequestTimeoutLink().concat(transport));

    vi.advanceTimersByTime(10 * 60_000);

    expect(settled.error).toBeUndefined();
    expect(settled.result).toBeUndefined();
  });

  it('cancels the transport and the clock when the caller unsubscribes', () => {
    const { transport, unsubscribed } = hangingTransport();
    const { subscription } = run(createRequestTimeoutLink().concat(transport), { timeoutMs: 25_000 });

    subscription.unsubscribe();

    expect(unsubscribed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
