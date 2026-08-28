/**
 * Minimal, dependency-free RDF layer for the Solid facade: a tiny quad model
 * plus Turtle and JSON-LD serializers behind an `Accept`-driven negotiator.
 * Consumers build a `Quad[]` and hand it to `negotiateRdf(...).serialize(...)`.
 *
 * Deliberately not a general RDF toolkit — see the note in `quad.ts` for when
 * to graduate to `n3`/`@rdfjs`.
 *
 * @module solid/rdf
 */

export {
  PREFIXES,
  RDF,
  RDFS,
  XSD,
  FOAF,
  SOLID,
  PIM,
  SCHEMA,
  DCTERMS,
  LDP,
  CI,
  RDF_TYPE,
  term,
} from './namespaces';
export type { Prefix } from './namespaces';
export { namedNode, literal, quad, isNamedNode } from './quad';
export type { NamedNode, Literal, Term, Quad } from './quad';
export { serializeTurtle, escapeLiteral } from './TurtleSerializer';
export { serializeJsonLd } from './JsonLdSerializer';
export { negotiateRdf } from './negotiate';
export type { RdfMediaType } from './negotiate';
export { safeLocalName } from './localName';
