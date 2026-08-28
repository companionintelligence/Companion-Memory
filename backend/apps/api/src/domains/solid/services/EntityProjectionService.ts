import { Injectable } from '@nestjs/common';

import type { GraphNodeEntity, RelationshipEntity } from '@ci/domains/memory';

import {
  CI,
  DCTERMS,
  RDFS,
  RDF_TYPE,
  SCHEMA,
  XSD,
  literal,
  namedNode,
  quad,
  safeLocalName,
  type NamedNode,
  type Quad,
  type Term,
} from '../rdf';

import { WebIdService } from './WebIdService';

/**
 * Projects a `ci.entities` row (a `GraphNodeEntity`) and its outbound
 * relationships into RDF — the core of the Solid facade's data surface. The
 * entity's pod URL *is* the RDF subject (the entity is the resource).
 *
 * Two design rules keep this honest:
 *  - **Lossless via `ci:`** — every entity type, custom property key, and
 *    relationship type gets a stable `ci:`-namespaced IRI, so nothing in the
 *    row is silently dropped just because it lacks a standard-vocabulary term.
 *    Well-known types additionally get a schema.org type for interop.
 *  - **Only scalars are projected as literals** — nested objects/arrays in the
 *    `properties` jsonb are skipped (not stringified into misleading literals);
 *    a later slice can model them as blank nodes. Skipping is documented rather
 *    than magic.
 *
 * The builder is pure: the caller supplies the already-fetched, already
 * owner-scoped node and edges. It never reads the database or makes trust
 * decisions — authorization lives in the controller.
 */
@Injectable()
export class EntityProjectionService {
  /**
   * Well-known CI entity types → their closest schema.org class. Types absent
   * here still get their `ci:<type>` rdf:type; they just carry no schema.org
   * synonym. `entity_type` is free-text at the DB layer, so this is a
   * best-effort lookup, never an assertion that the column is one of these.
   */
  private static readonly SCHEMA_TYPE: Readonly<Record<string, string>> = {
    Person: SCHEMA('Person'),
    Place: SCHEMA('Place'),
    Event: SCHEMA('Event'),
    Thing: SCHEMA('Thing'),
    Item: SCHEMA('Thing'),
    Communication: SCHEMA('Message'),
    Content: SCHEMA('CreativeWork'),
    File: SCHEMA('MediaObject'),
  };

  constructor(private readonly webIds: WebIdService) {}

  /**
   * Builds the RDF graph for `node`, addressed under `origin`/`userId`, with
   * `relationships` being that node's outbound edges (already owner-scoped).
   */
  build(node: GraphNodeEntity, relationships: RelationshipEntity[], origin: string, userId: string): Quad[] {
    const subject = namedNode(this.webIds.entityResourceUrl(origin, userId, node.entity_id));
    const quads: Quad[] = [];

    // Types: always the lossless CI type, plus a schema.org synonym when known.
    if (node.entity_type) {
      quads.push(quad(subject, RDF_TYPE, namedNode(CI(safeLocalName(node.entity_type)))));
      const schemaType = EntityProjectionService.SCHEMA_TYPE[node.entity_type];
      if (schemaType) {
        quads.push(quad(subject, RDF_TYPE, namedNode(schemaType)));
      }
    }

    if (node.name) {
      quads.push(quad(subject, RDFS('label'), literal(node.name)));
    }

    if (node.description) {
      quads.push(quad(subject, RDFS('comment'), literal(node.description)));
    }

    quads.push(quad(subject, DCTERMS('created'), this.dateLiteral(node.created_at)));
    quads.push(quad(subject, DCTERMS('modified'), this.dateLiteral(node.updated_at)));

    // Custom scalar properties from the jsonb column.
    for (const [key, value] of Object.entries(node.properties ?? {})) {
      const object = this.scalarLiteral(value);
      if (object) {
        quads.push(quad(subject, CI(safeLocalName(key)), object));
      }
    }

    // Outbound relationships become predicates from this entity to the other
    // entity's pod URL. Inbound edges are deferred to a later slice (they would
    // introduce triples whose subject is a different resource).
    for (const rel of relationships) {
      if (rel.from_entity_id !== node.entity_id) {
        continue;
      }

      const object = namedNode(this.webIds.entityResourceUrl(origin, userId, rel.to_entity_id));
      quads.push(quad(subject, this.relationshipPredicate(rel.relationship_type), object));
    }

    return quads;
  }

  /** IRI for a relationship type. Encoded (not abbreviated) so any free-text
   * relationship label yields a valid, stable predicate IRI. */
  private relationshipPredicate(relationshipType: string): string {
    return CI(`rel/${encodeURIComponent(relationshipType)}`);
  }

  /**
   * Coerces a jsonb scalar to a typed literal, or `undefined` for values that
   * do not map cleanly to a single literal (null, objects, arrays). Numbers and
   * booleans get their xsd datatype so the projection round-trips.
   */
  private scalarLiteral(value: unknown): Term | undefined {
    switch (typeof value) {
      case 'string':
        return literal(value);
      case 'number':
        return Number.isFinite(value)
          ? literal(String(value), { datatype: Number.isInteger(value) ? XSD('integer') : XSD('double') })
          : undefined;
      case 'boolean':
        return literal(String(value), { datatype: XSD('boolean') });
      default:
        return undefined;
    }
  }

  private dateLiteral(date: Date): Term {
    return literal(date.toISOString(), { datatype: XSD('dateTime') });
  }

  /** Narrowing helper for tests/consumers that need the subject IRI. */
  subjectFor(origin: string, userId: string, entityId: string): NamedNode {
    return namedNode(this.webIds.entityResourceUrl(origin, userId, entityId));
  }
}
