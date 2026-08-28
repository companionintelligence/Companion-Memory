/**
 * A deliberately tiny RDF data model — just enough to describe a WebID profile
 * and serialize it. It is NOT a general RDF library: no blank-node scoping, no
 * graph names, no collections. When the projection grows past hand-built
 * profile graphs (LDP containers, entity projection) this should be swapped for
 * `n3`/`@rdfjs`; the serializers consume `Quad[]`, so that swap stays local.
 *
 * Terms are plain tagged objects rather than classes so they survive structured
 * cloning and are trivial to assert on in tests.
 */

/** An IRI reference (subject, predicate, or object position). */
export interface NamedNode {
  readonly termType: 'NamedNode';
  readonly value: string;
}

/**
 * An RDF literal. `datatype` defaults to xsd:string on read; `language` and
 * `datatype` are mutually exclusive per the RDF spec, but we do not enforce
 * that here because the profile builder never sets both.
 */
export interface Literal {
  readonly termType: 'Literal';
  readonly value: string;
  readonly datatype?: string;
  readonly language?: string;
}

export type Term = NamedNode | Literal;

/** A subject–predicate–object statement. Predicate is always an IRI. */
export interface Quad {
  readonly subject: NamedNode;
  readonly predicate: NamedNode;
  readonly object: Term;
}

export const namedNode = (value: string): NamedNode => ({ termType: 'NamedNode', value });

export const literal = (value: string, opts?: { datatype?: string; language?: string }): Literal => ({
  termType: 'Literal',
  value,
  ...(opts?.language ? { language: opts.language } : {}),
  ...(opts?.datatype && !opts.language ? { datatype: opts.datatype } : {}),
});

export const isNamedNode = (term: Term): term is NamedNode => term.termType === 'NamedNode';

/** Convenience constructor. `predicate` is a bare IRI string (see namespaces). */
export const quad = (subject: NamedNode, predicate: string, object: Term): Quad => ({
  subject,
  predicate: namedNode(predicate),
  object,
});
