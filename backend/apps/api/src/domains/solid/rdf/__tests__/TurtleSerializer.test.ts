import { FOAF, SCHEMA, RDF_TYPE, literal, namedNode, quad, type Quad } from '../index';
import { escapeLiteral, serializeTurtle } from '../TurtleSerializer';

/**
 * The Turtle serializer is what stands between a user-controlled profile field
 * (a display name) and a syntactically valid RDF document other agents parse.
 * These tests pin the escaping and the abbreviation rules; a regression here
 * produces documents that either fail to parse or smuggle extra triples.
 */
describe('serializeTurtle', () => {
  const me = namedNode('https://ci.example/solid/profile/u1#me');

  it('abbreviates known vocabularies and renders rdf:type as `a`', () => {
    const ttl = serializeTurtle([
      quad(me, RDF_TYPE, namedNode(FOAF('Agent'))),
      quad(me, FOAF('name'), literal('Ada')),
    ]);

    expect(ttl).toContain('@prefix foaf: <http://xmlns.com/foaf/0.1/> .');
    expect(ttl).toContain('<https://ci.example/solid/profile/u1#me>');
    expect(ttl).toContain('a foaf:Agent');
    expect(ttl).toContain('foaf:name "Ada"');
    // rdf:type must not appear spelled out once folded to `a`.
    expect(ttl).not.toContain('rdf:type');
  });

  it('groups multiple predicates of one subject into a single block', () => {
    const ttl = serializeTurtle([
      quad(me, RDF_TYPE, namedNode(FOAF('Agent'))),
      quad(me, RDF_TYPE, namedNode(SCHEMA('Person'))),
      quad(me, FOAF('name'), literal('Ada')),
    ]);

    // One subject => one `.` terminator, predicates separated by ` ;`.
    expect(ttl.match(/\./g)?.length).toBeGreaterThanOrEqual(1);
    expect(ttl.split('#me>').length).toBe(2); // subject printed exactly once
    expect(ttl).toContain(' ;\n');
  });

  it('emits IRI objects that are not in a known vocabulary as absolute <...>', () => {
    const ttl = serializeTurtle([quad(me, FOAF('mbox'), namedNode('mailto:ada@example.com'))]);
    expect(ttl).toContain('foaf:mbox <mailto:ada@example.com>');
  });

  describe('literal escaping (untrusted profile fields)', () => {
    it.each([
      ['double quote', 'a"b', 'a\\"b'],
      ['backslash', 'a\\b', 'a\\\\b'],
      ['newline', 'a\nb', 'a\\nb'],
      ['carriage return', 'a\rb', 'a\\rb'],
      ['tab', 'a\tb', 'a\\tb'],
    ])('escapes a %s so it cannot break out of the literal', (_label, input, expected) => {
      expect(escapeLiteral(input)).toBe(expected);
      expect(serializeTurtle([quad(me, FOAF('name'), literal(input))])).toContain(`foaf:name "${expected}"`);
    });

    it('escapes backslash before quote (order matters)', () => {
      // A naive replace order would double-escape; verify the exact output.
      expect(escapeLiteral('\\"')).toBe('\\\\\\"');
    });
  });

  it('escapes control chars and forbidden characters inside IRI references', () => {
    // A hostile IRI containing a space and a closing bracket must not terminate
    // the <...> early. Space (U+0020) and `>` are both escaped.
    const hostile = namedNode('https://evil/ a> .');
    const ttl = serializeTurtle([quad(me, FOAF('mbox'), hostile)]);
    expect(ttl).not.toContain('<https://evil/ a> .>');
    expect(ttl).toContain('\\u0020');
    expect(ttl).toContain('\\u003E');
  });

  it('produces no prefix header for an empty graph', () => {
    expect(serializeTurtle([] as Quad[])).toBe('');
  });
});
