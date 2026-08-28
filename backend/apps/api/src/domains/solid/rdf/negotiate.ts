import { serializeJsonLd } from './JsonLdSerializer';
import type { Quad } from './quad';
import { serializeTurtle } from './TurtleSerializer';

/**
 * Content negotiation for RDF responses. Solid resources are RDF and MUST be
 * available as Turtle; JSON-LD is offered for browser/JS clients. This is a
 * pragmatic `Accept` parser — it honours q-values and picks the highest-q
 * supported type — not a full RFC 7231 implementation (no media-range
 * parameters beyond `q`), which is all the WebID endpoint needs.
 */

export type RdfMediaType = 'text/turtle' | 'application/ld+json';

interface RdfSerialization {
  readonly mediaType: RdfMediaType;
  readonly serialize: (quads: Quad[]) => string;
}

const TURTLE: RdfSerialization = { mediaType: 'text/turtle', serialize: serializeTurtle };
const JSON_LD: RdfSerialization = { mediaType: 'application/ld+json', serialize: serializeJsonLd };

/** Turtle is the default for `*` / missing / unrecognized Accept, per Solid. */
const DEFAULT = TURTLE;

/** Maps a concrete media type (or wildcard) to a serialization. */
const forMediaType = (type: string): RdfSerialization | undefined => {
  switch (type) {
    case 'text/turtle':
      return TURTLE;
    case 'application/ld+json':
    case 'application/json':
      return JSON_LD;
    case '*/*':
    case 'text/*':
      return DEFAULT;
    default:
      return undefined;
  }
};

interface AcceptEntry {
  type: string;
  q: number;
  order: number;
}

/** Parses an Accept header into entries sorted by descending q, then by order. */
const parseAccept = (header: string): AcceptEntry[] =>
  header
    .split(',')
    .map((part, order) => {
      const [type, ...params] = part
        .trim()
        .split(';')
        .map((s) => s.trim());
      const qParam = params.find((p) => p.startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;

      return { type: type.toLowerCase(), q: Number.isFinite(q) ? q : 1, order };
    })
    .filter((entry) => entry.type.length > 0 && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.order - b.order);

/**
 * Chooses an RDF serialization for the given `Accept` header. Never rejects —
 * an unsatisfiable or absent Accept falls back to Turtle, since a WebID
 * document must always be dereferenceable.
 */
export const negotiateRdf = (acceptHeader: string | undefined): RdfSerialization => {
  if (!acceptHeader) {
    return DEFAULT;
  }

  for (const entry of parseAccept(acceptHeader)) {
    const match = forMediaType(entry.type);
    if (match) {
      return match;
    }
  }

  return DEFAULT;
};
