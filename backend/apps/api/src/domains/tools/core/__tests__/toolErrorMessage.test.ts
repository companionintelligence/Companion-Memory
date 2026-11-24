import { QueryFailedError } from 'typeorm';

import { DATABASE_ERROR_MESSAGE, UNAVAILABLE_ERROR_MESSAGE, toolErrorMessage } from '../toolErrorMessage';

describe('toolErrorMessage', () => {
  it('replaces a refused query with a sentence that names nothing in the schema', () => {
    const err = new QueryFailedError(
      'INSERT …',
      [],
      Object.assign(new Error('duplicate key value violates unique constraint "people_pkey"'), {
        code: '23505',
      }),
    );

    expect(toolErrorMessage(err)).toBe(DATABASE_ERROR_MESSAGE);
  });

  it('replaces a connection failure, which names an internal address', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:5432'), { code: 'ECONNREFUSED' });

    expect(toolErrorMessage(err)).toBe(UNAVAILABLE_ERROR_MESSAGE);
  });

  it("passes a tool's own sentence through, even one that mentions a connection", () => {
    expect(toolErrorMessage(new Error('No note with id 42'))).toBe('No note with id 42');
    expect(
      toolErrorMessage(
        new Error('The stored objects could not be deleted, so nothing was deleted: connect ECONNREFUSED'),
      ),
    ).toContain('nothing was deleted');
    expect(toolErrorMessage('plain')).toBe('plain');
  });
});
