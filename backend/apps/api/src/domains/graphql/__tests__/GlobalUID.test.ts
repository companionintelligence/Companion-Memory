import { BadRequestException } from '@nestjs/common';
import { GraphQLError } from 'graphql';

import { formatError } from '../formatError';
import { GlobalUID } from '../types/GlobalUID';

// The id the iOS QA run (MEM-06) passed to `file(id:)`: the raw `ci.files.id` of an
// ORIGINAL image row, not the base64 `file:<uuid>` global id the API hands out.
const RAW_FILE_ID = '01a0fb20-60d3-76a9-a2f4-f5cec8a645fe';

function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }

  throw new Error('expected the call to throw');
}

describe('GlobalUID', () => {
  it('round-trips an id through encode and parse', () => {
    expect(GlobalUID.parse('file', GlobalUID.encode('file', RAW_FILE_ID))).toBe(RAW_FILE_ID);
  });

  // The contract mutationGlobalIds.test.ts pins for the mutations: a bare uuid is
  // refused rather than silently matching nothing. It is the caller's mistake, so
  // it has to be a 400 — a plain Error is what turned it into "Internal server
  // error" for a client that did nothing but send the wrong kind of id.
  it('refuses a bare uuid as a bad request', () => {
    const error = thrownBy(() => GlobalUID.parse('file', RAW_FILE_ID));

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe('Invalid global id format');
  });

  it('refuses an id minted for another resource type as a bad request', () => {
    const error = thrownBy(() => GlobalUID.parse('file', GlobalUID.encode('person', RAW_FILE_ID)));

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe('Unexpected global id type');
  });

  it('refuses something that is not a string at all as a bad request', () => {
    const error = thrownBy(() => GlobalUID.decode(undefined as unknown as string));

    expect(error).toBeInstanceOf(BadRequestException);
  });

  it('reaches a GraphQL client as BAD_USER_INPUT with its message, not as "Internal server error"', () => {
    const error = thrownBy(() => GlobalUID.parse('file', RAW_FILE_ID)) as Error;

    const result = formatError(
      {
        message: error.message,
        path: ['file'],
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      },
      new GraphQLError(error.message, { originalError: error, path: ['file'] }),
    );

    expect(result.message).toBe('Invalid global id format');
    expect(result.extensions?.code).toBe('BAD_USER_INPUT');
    expect(result.extensions).not.toHaveProperty('correlationId');
  });
});
