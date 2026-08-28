import { PREFIXES, RDF_TYPE } from './namespaces';
import { isNamedNode, type Quad } from './quad';

/**
 * Serializes `Quad[]` to JSON-LD (application/ld+json) as a flattened
 * `@graph` of node objects. Predicates are emitted as full IRIs (no term
 * compaction beyond the `@context` prefixes), which keeps the mapping a
 * mechanical, lossless grouping — a JSON-LD processor expands it back to the
 * exact same triples. Full framing/compaction is intentionally out of scope
 * until a real JSON-LD library is pulled in.
 */

interface JsonLdNode {
  '@id': string;
  '@type'?: string[];
  [predicate: string]: unknown;
}

/** A JSON-LD value object for an IRI or literal object term. */
const valueObject = (object: Quad['object']): unknown => {
  if (isNamedNode(object)) {
    return { '@id': object.value };
  }

  if (object.language) {
    return { '@value': object.value, '@language': object.language };
  }

  if (object.datatype) {
    return { '@value': object.value, '@type': object.datatype };
  }

  return { '@value': object.value };
};

/** Appends `value` to `node[key]`, promoting a single value to an array. */
const append = (node: JsonLdNode, key: string, value: unknown): void => {
  const existing = node[key];
  if (existing === undefined) {
    node[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    node[key] = [existing, value];
  }
};

export const serializeJsonLd = (quads: Quad[]): string => {
  const nodes = new Map<string, JsonLdNode>();
  const nodeFor = (id: string): JsonLdNode => {
    let node = nodes.get(id);
    if (!node) {
      node = { '@id': id };
      nodes.set(id, node);
    }

    return node;
  };

  for (const q of quads) {
    const node = nodeFor(q.subject.value);
    // rdf:type folds into the JSON-LD keyword `@type` as an array of IRIs.
    if (q.predicate.value === RDF_TYPE && isNamedNode(q.object)) {
      (node['@type'] ??= []).push(q.object.value);
    } else {
      append(node, q.predicate.value, valueObject(q.object));
    }
  }

  const document = {
    '@context': PREFIXES as Record<string, string>,
    '@graph': [...nodes.values()],
  };

  return JSON.stringify(document, null, 2);
};
