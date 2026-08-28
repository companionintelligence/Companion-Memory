import { describe, expect, it } from 'vitest';

import { HOME_TOWN_CITY_QUESTION_KEYS, homeTownCatalogueUrl } from '@/pages/SelfPage/sections/lifeDetails';

import { pickHomeCity, pickHomePlace } from './useHomeMapCenter';

const CHILDHOOD_KEY = HOME_TOWN_CITY_QUESTION_KEYS[0];
const BIRTH_KEY = HOME_TOWN_CITY_QUESTION_KEYS[1];

describe('homeTownCatalogueUrl', () => {
  it('asks only for the two factual home-town city keys', () => {
    const url = new URL(homeTownCatalogueUrl(), 'https://example.test');

    expect(url.searchParams.get('keys')?.split(',')).toEqual([...HOME_TOWN_CITY_QUESTION_KEYS]);
    expect(url.searchParams.get('limit')).toBe('2');
    // No uuid may ride in this request: ids are minted per appliance, so one
    // hardcoded here would find no home city on anybody else's machine.
    expect(url.search).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});

describe('pickHomeCity', () => {
  it('prefers childhood city over birth city', () => {
    expect(
      pickHomeCity({
        data: [
          { key: BIRTH_KEY, answer: { text: 'Detroit' } },
          { key: CHILDHOOD_KEY, answer: { text: ' Oakland ' } },
        ],
      }),
    ).toBe('Oakland');
  });

  it('falls back to birth city when childhood is unanswered', () => {
    expect(
      pickHomeCity({
        data: [
          { key: CHILDHOOD_KEY, answer: null },
          { key: BIRTH_KEY, answer: { text: 'Detroit' } },
        ],
      }),
    ).toBe('Detroit');
  });

  it('returns null when neither city is answered', () => {
    expect(pickHomeCity({ data: [{ key: BIRTH_KEY, answer: { text: '  ' } }] })).toBeNull();
    expect(pickHomeCity(null)).toBeNull();
  });

  it('ignores a row the catalogue reported with no key at all', () => {
    // A keyless row is one of the ~1.3k questions nobody names; it must not be
    // mistaken for a home-town answer.
    expect(pickHomeCity({ data: [{ key: null, answer: { text: 'Detroit' } }] })).toBeNull();
  });
});

describe('pickHomePlace', () => {
  it('picks the located place whose name matches the city', () => {
    expect(
      pickHomePlace(
        [
          { node: { name: 'Oakland Airport', latitude: 37.71, longitude: -122.21 } },
          { node: { name: 'Oakland', latitude: 37.8, longitude: -122.27 } },
        ],
        'oakland',
      ),
    ).toEqual({ latitude: 37.8, longitude: -122.27 });
  });

  it('matches a city that includes the place name (San Francisco, CA)', () => {
    expect(
      pickHomePlace(
        [{ node: { name: 'San Francisco', latitude: 37.77, longitude: -122.42 } }],
        'San Francisco, CA',
      ),
    ).toEqual({ latitude: 37.77, longitude: -122.42 });
  });

  it('skips places without coordinates and unmatched names', () => {
    expect(
      pickHomePlace(
        [
          { node: { name: 'Oakland', latitude: null, longitude: null } },
          { node: { name: 'Berkeley', latitude: 37.87, longitude: -122.27 } },
        ],
        'Oakland',
      ),
    ).toBeNull();
  });
});
