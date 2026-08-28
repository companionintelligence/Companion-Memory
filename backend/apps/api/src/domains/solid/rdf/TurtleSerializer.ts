import { PREFIXES, RDF_TYPE, type Prefix } from './namespaces';
import { isNamedNode, type Literal, type Quad, type Term } from './quad';

/**
 * Serializes `Quad[]` to Turtle (text/turtle). Scope-matched to the WebID
 * profile: grouped-by-subject output, prefix abbreviation, and `a` for
 * rdf:type. It does not implement Turtle's full pretty-printing (no blank-node
 * `[...]`, no collections) because the profile graph never needs them.
 *
 * Escaping is the load-bearing part — a name containing a quote or newline must
 * not break out of the literal — so it is unit-tested directly.
 */

const XSD_STRING = `${PREFIXES.xsd}string`;

/** A local name safe to print after a prefix without escaping (conservative). */
const SAFE_PN_LOCAL = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Escapes a string for a Turtle double-quoted literal ("..."). */
export const escapeLiteral = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

/**
 * Escapes the content of an IRI reference (`<...>`). Per the Turtle IRIREF
 * grammar these characters must be `\uXXXX`-escaped: control chars and space
 * (U+0000–U+0020) plus the literal set `< > " { } | ^ \` \`. Well-formed
 * http(s) URLs contain none of these, so they pass through untouched; this
 * exists purely so a hostile value can never break out of the angle brackets.
 */
const escapeIri = (value: string): string =>
  // eslint-disable-next-line no-control-regex -- U+0000–U+0020 is exactly the forbidden range
  value.replace(/[\u0000-\u0020<>"{}|^`\\]/g, (char) => {
    const hex = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');

    return `\\u${hex}`;
  });

/** Renders an IRI as `prefix:local` when safely abbreviable, else `<escaped>`. */
const renderIri = (iri: string): string => {
  for (const [prefix, namespace] of Object.entries(PREFIXES) as [Prefix, string][]) {
    if (iri.startsWith(namespace)) {
      const local = iri.slice(namespace.length);
      if (SAFE_PN_LOCAL.test(local)) {
        return `${prefix}:${local}`;
      }
    }
  }

  return `<${escapeIri(iri)}>`;
};

const renderLiteral = (lit: Literal): string => {
  const lexical = `"${escapeLiteral(lit.value)}"`;
  if (lit.language) {
    return `${lexical}@${lit.language}`;
  }

  if (lit.datatype && lit.datatype !== XSD_STRING) {
    return `${lexical}^^${renderIri(lit.datatype)}`;
  }

  return lexical;
};

const renderObject = (object: Term): string =>
  isNamedNode(object) ? renderIri(object.value) : renderLiteral(object);

const renderPredicate = (iri: string): string => (iri === RDF_TYPE ? 'a' : renderIri(iri));

/** Emits the `@prefix` header for the vocabularies actually referenced. */
const prefixHeader = (quads: Quad[]): string => {
  const used = new Set<Prefix>();
  const scan = (iri: string): void => {
    for (const [prefix, namespace] of Object.entries(PREFIXES) as [Prefix, string][]) {
      if (iri.startsWith(namespace) && SAFE_PN_LOCAL.test(iri.slice(namespace.length))) {
        used.add(prefix);
      }
    }
  };

  for (const q of quads) {
    scan(q.subject.value);
    scan(q.predicate.value);
    if (isNamedNode(q.object)) {
      scan(q.object.value);
    } else if (q.object.datatype) {
      scan(q.object.datatype);
    }
  }

  return [...used].map((prefix) => `@prefix ${prefix}: <${PREFIXES[prefix]}> .`).join('\n');
};

export const serializeTurtle = (quads: Quad[]): string => {
  // Preserve subject encounter order for stable, diffable output.
  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) {
    const list = bySubject.get(q.subject.value);
    if (list) {
      list.push(q);
    } else {
      bySubject.set(q.subject.value, [q]);
    }
  }

  const blocks: string[] = [];
  for (const [subject, group] of bySubject) {
    const lines = group.map((q) => `    ${renderPredicate(q.predicate.value)} ${renderObject(q.object)}`);
    blocks.push(`${renderIri(subject)}\n${lines.join(' ;\n')} .`);
  }

  const header = prefixHeader(quads);
  const body = blocks.join('\n\n');

  return `${header ? `${header}\n\n` : ''}${body}${body ? '\n' : ''}`;
};
