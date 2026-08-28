import { negotiateRdf } from '../negotiate';

/**
 * Content negotiation must never leave a WebID undereferenceable, so every
 * ambiguous or unsupported Accept resolves to Turtle rather than a 406.
 */
describe('negotiateRdf', () => {
  it('defaults to Turtle when Accept is absent', () => {
    expect(negotiateRdf(undefined).mediaType).toBe('text/turtle');
  });

  it('honours an explicit Turtle request', () => {
    expect(negotiateRdf('text/turtle').mediaType).toBe('text/turtle');
  });

  it('maps application/ld+json and application/json to JSON-LD', () => {
    expect(negotiateRdf('application/ld+json').mediaType).toBe('application/ld+json');
    expect(negotiateRdf('application/json').mediaType).toBe('application/ld+json');
  });

  it('picks the highest q-value among supported types', () => {
    expect(negotiateRdf('text/turtle;q=0.5, application/ld+json;q=0.9').mediaType).toBe(
      'application/ld+json',
    );
    expect(negotiateRdf('application/ld+json;q=0.2, text/turtle;q=0.8').mediaType).toBe('text/turtle');
  });

  it('skips unsupported types and falls through to a supported one', () => {
    expect(negotiateRdf('application/rdf+xml, text/html;q=0.9, application/ld+json;q=0.4').mediaType).toBe(
      'application/ld+json',
    );
  });

  it('falls back to Turtle for a wildcard or unsupported-only Accept', () => {
    expect(negotiateRdf('*/*').mediaType).toBe('text/turtle');
    expect(negotiateRdf('application/rdf+xml, text/html').mediaType).toBe('text/turtle');
  });

  it('ignores q=0 (explicitly not acceptable) entries', () => {
    // ld+json is rejected via q=0, so Turtle (wildcard) wins.
    expect(negotiateRdf('application/ld+json;q=0, */*').mediaType).toBe('text/turtle');
  });
});
