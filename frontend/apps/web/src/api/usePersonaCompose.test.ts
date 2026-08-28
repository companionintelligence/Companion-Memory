/**
 * `fetchAboutYou` is the only guard between the About You endpoint and
 * `AboutYouSection`, which reads `preferences`/`family`/`recentAnswers` as
 * plain arrays. `fetchJson` casts the parsed body to its type parameter without
 * validating it, so a 200 carrying anything other than the agreed shape used to
 * reach the section as-is and take the whole `/self` page down with
 * `Cannot read properties of undefined (reading 'filter')`.
 */
import { fetchJson } from '@ci/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAboutYou } from './usePersonaCompose';

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: vi.fn(),
}));

const mockedFetchJson = vi.mocked(fetchJson);

beforeEach(() => {
  mockedFetchJson.mockReset();
});

describe('fetchAboutYou', () => {
  it('passes a well-formed view through unchanged', async () => {
    const view = {
      name: 'Ada',
      dossier: { summary: 'Prefers mornings.' },
      preferences: [
        {
          entityId: 'e1',
          name: 'Espresso',
          type: 'drink',
          category: null,
          strength: 1,
          relationship: 'PREFERS',
        },
      ],
      family: [{ entityId: 'e2', name: 'Sam', relationship: 'sibling' }],
      recentAnswers: [{ id: 'a1', question: null, answer: 'Yes', answeredAt: '2026-01-01T00:00:00.000Z' }],
      schedule: { wake_time: '07:00' },
      trustMode: 'balanced',
      hasSignal: true,
    };

    mockedFetchJson.mockResolvedValue(view);

    await expect(fetchAboutYou('token')).resolves.toEqual(view);
  });

  it('fills in the array fields when the body omits them', async () => {
    // The section maps over all three without guarding — they have to be arrays
    // even when the server (or a proxy in front of it) leaves them out.
    mockedFetchJson.mockResolvedValue({ name: 'Ada' });

    await expect(fetchAboutYou('token')).resolves.toEqual({
      name: 'Ada',
      dossier: null,
      preferences: [],
      family: [],
      recentAnswers: [],
      schedule: null,
      trustMode: null,
      hasSignal: false,
    });
  });

  it.each([
    ['an array', []],
    ['a bare string', 'nope'],
    ['no body at all', undefined],
  ])('rejects when the response is %s', async (_label, body) => {
    // Not an empty profile — a broken response. The section turns a rejection
    // into "Could not load…" with a retry, which beats rendering "Still thin"
    // and implying Companion knows nothing about you.
    mockedFetchJson.mockResolvedValue(body);

    await expect(fetchAboutYou('token')).rejects.toThrow('About-you request returned no data');
  });
});
