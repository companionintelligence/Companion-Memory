import { describe, expect, it } from 'vitest';

import { graphQLFailure, httpFailure, requestFailure, transportFailure } from '@/test/apolloErrors';

import { httpStatusOf } from './apolloErrors';

describe('httpStatusOf', () => {
  it('reads the status of an answer that was not a GraphQL response', () => {
    expect(httpStatusOf(httpFailure(400))).toBe(400);
    expect(httpStatusOf(httpFailure(502))).toBe(502);
  });

  it('reads a request the server turned down before running it as a 400', () => {
    expect(httpStatusOf(requestFailure([{ message: 'Cannot query field "x" on type "Query".' }]))).toBe(400);
  });

  it('has no status for a GraphQL answer that ran, or for a request that never got one', () => {
    expect(httpStatusOf(graphQLFailure([{ message: 'resolver failed' }]))).toBeUndefined();
    expect(httpStatusOf(transportFailure())).toBeUndefined();
    expect(httpStatusOf(undefined)).toBeUndefined();
  });
});
