import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PHONE_EXTENSION_PATTERN, phoneHref } from './phoneHref';

describe('phoneHref', () => {
  it('dials a number written with a + by that country code, not as its last ten digits', () => {
    // The key `2079460958` is a North American number — 207 is Maine.
    expect(phoneHref({ value: '2079460958', rawValue: '+44 20 7946 0958' })).toBe('tel:+442079460958');
    expect(phoneHref({ value: '4155550100', rawValue: '+1 (415) 555-0100' })).toBe('tel:+14155550100');
    // A vCard 4 `TEL;VALUE=uri` keeps its scheme in the typed form.
    expect(phoneHref({ value: '2079460958', rawValue: 'tel:+44-20-7946-0958' })).toBe('tel:+442079460958');
  });

  it.each([
    ['00 44 20 7946 0958', 'tel:00442079460958'],
    ['011 44 20 7946 0958', 'tel:011442079460958'],
  ])('keeps the written international prefix of %s as typed', (rawValue, href) => {
    expect(phoneHref({ value: '2079460958', rawValue })).toBe(href);
  });

  it('adds no country code to a number written without one', () => {
    expect(phoneHref({ value: '4155550100', rawValue: '(415) 555-0100' })).toBe('tel:4155550100');
    // Dialled at home as typed: the key would have lost the trunk zero.
    expect(phoneHref({ value: '2079460958', rawValue: '020 7946 0958' })).toBe('tel:02079460958');
  });

  it('leaves out the (0) that follows a country code', () => {
    expect(phoneHref({ value: '2079460958', rawValue: '+44 (0)20 7946 0958' })).toBe('tel:+442079460958');
    expect(phoneHref({ value: '2079460958', rawValue: '0044 (0) 20 7946 0958' })).toBe('tel:00442079460958');
    // With no country code in front of it, it is the zero dialled at home.
    expect(phoneHref({ value: '2079460958', rawValue: '(0)20 7946 0958' })).toBe('tel:02079460958');
  });

  it.each([
    ['no typed form', undefined],
    ['a null typed form', null],
    ['a blank typed form', '   '],
    ['a typed form with no digits', 'unknown'],
  ])('falls back to the value with %s', (_, rawValue) => {
    expect(phoneHref({ value: '4155550100', rawValue })).toBe('tel:4155550100');
  });

  it('falls back to the value when the typed form holds two numbers', () => {
    // Their digits run together dial neither; the key is the last of them.
    expect(phoneHref({ value: '4155550101', rawValue: '+1 415-555-0100 / +1 415-555-0101' })).toBe(
      'tel:4155550101',
    );
  });

  it('dials an indexed number by its key when that is all the card has', () => {
    expect(phoneHref({ value: '4155550100' })).toBe('tel:4155550100');
  });

  it.each([
    ['212-555-0148 x31', 'tel:2125550148;ext=31'],
    ['212-555-0148x31', 'tel:2125550148;ext=31'],
    ['(212) 555-0148 ext. 31', 'tel:2125550148;ext=31'],
    ['212.555.0148 Extension: 31', 'tel:2125550148;ext=31'],
    ['(212) 555-0147;229', 'tel:2125550147;ext=229'],
    ['212-555-0147,,229', 'tel:2125550147;ext=229'],
    ['212-555-0147 #229', 'tel:2125550147;ext=229'],
    ['2125550147p229', 'tel:2125550147;ext=229'],
    ['2125550147 w 229', 'tel:2125550147;ext=229'],
  ])('keeps the line and the extension apart for %s', (value, href) => {
    expect(phoneHref({ value })).toBe(href);
  });

  it('splits an extension on the typed form, not on the join key', () => {
    expect(phoneHref({ value: '5550147229', rawValue: '(212) 555-0147;229' })).toBe('tel:2125550147;ext=229');
  });

  it('keeps a stated country on an extension line, and adds none', () => {
    expect(phoneHref({ value: '+1 (212) 555-0147;229' })).toBe('tel:+12125550147;ext=229');
    expect(phoneHref({ value: 'tel:+44 20 7946 0123;ext=12' })).toBe('tel:+442079460123;ext=12');
    expect(phoneHref({ value: '+44 (0)20 7946 0958 x12' })).toBe('tel:+442079460958;ext=12');
    expect(phoneHref({ value: '212-555-0148 x31' })).not.toContain('+');
  });

  it('never runs the extension into the number', () => {
    expect(phoneHref({ value: '(212) 555-0147;229' })).not.toContain('2125550147229');
  });

  it('does not take the x in a word for an extension', () => {
    expect(phoneHref({ value: 'fax 2125550147' })).toBe('tel:2125550147');
  });
});

describe('PHONE_EXTENSION_PATTERN', () => {
  it('is the pattern the server refuses extension numbers by, verbatim', () => {
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../../../../backend/apps/api/src/domains/graph/utils/normalizeIdentifier.ts',
      ),
      'utf8',
    );

    expect(source).toContain(
      `export const PHONE_EXTENSION_PATTERN = String.raw\`${PHONE_EXTENSION_PATTERN}\`;`,
    );
  });
});
