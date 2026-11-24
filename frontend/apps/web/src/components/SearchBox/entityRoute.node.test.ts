import { describe, expect, it } from 'vitest';

import { routeForEntity, savedRecordRoute } from './entityRoute';

describe('routeForEntity', () => {
  it('opens each type at its detail route', () => {
    expect(routeForEntity('person', '42')).toBe('/people/42');
    expect(routeForEntity('communication', 'c1')).toBe('/communications/c1');
    expect(routeForEntity('event', 'e1')).toBe('/events/e1');
    expect(routeForEntity('receipt', 'r1')).toBe('/receipts/r1');
    expect(routeForEntity('thread', 't1')).toMatch(/t1/);
  });

  it('a file opens the gallery searched for its name, since files have no page of their own', () => {
    expect(routeForEntity('file', 'f1', { title: 'scan 2026.pdf' })).toBe(
      '/memory?view=gallery&search=scan%202026.pdf',
    );
    expect(routeForEntity('file', 'f1')).toBe('/memory?view=gallery');
  });

  it('is null for a type with nowhere to go, so a tap stays inert rather than guessing', () => {
    expect(routeForEntity('product', 'p1')).toBeNull();
    expect(routeForEntity('task', 'k1')).toBeNull();
  });
});

describe('savedRecordRoute', () => {
  it('opens the offline record page by type and raw id', () => {
    expect(savedRecordRoute('communication', 'c1')).toBe('/memory/saved/communication/c1');
    expect(savedRecordRoute('file', 'a/b')).toBe('/memory/saved/file/a%2Fb');
  });
});
