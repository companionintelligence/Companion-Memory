import { Injectable } from '@nestjs/common';

import type { GraphNodeEntity } from '@ci/domains/memory';

import {
  CI,
  DCTERMS,
  LDP,
  RDFS,
  RDF_TYPE,
  XSD,
  literal,
  namedNode,
  quad,
  safeLocalName,
  type Quad,
} from '../rdf';

import { WebIdService } from './WebIdService';

/** What the container builder needs about the request beyond the member rows. */
export interface ContainerBuildOptions {
  /**
   * True when the member list was capped by the safety limit and there are
   * more entities than are listed. Surfaced as an honest `ci:truncated` flag
   * rather than silently presenting a partial container as complete.
   */
  truncated: boolean;
}

/**
 * Builds the RDF for the entity container — an LDP `BasicContainer` that lists
 * a user's entities so a Solid client can *browse* the pod, not just fetch
 * known IRIs. Each member is listed via `ldp:contains` and carries a little
 * inline metadata (type + label) so a client can render the listing without a
 * round-trip per member.
 *
 * Pure: the caller supplies the already-fetched, already owner-scoped member
 * rows. Authorization and paging live in the controller.
 */
@Injectable()
export class ContainerService {
  constructor(private readonly webIds: WebIdService) {}

  build(members: GraphNodeEntity[], origin: string, userId: string, options: ContainerBuildOptions): Quad[] {
    const container = namedNode(this.webIds.entityContainerUrl(origin, userId));
    const quads: Quad[] = [
      // An LDP BasicContainer is also an LDP Container and an RDFSource.
      quad(container, RDF_TYPE, namedNode(LDP('BasicContainer'))),
      quad(container, RDF_TYPE, namedNode(LDP('Container'))),
      quad(container, DCTERMS('title'), literal('Entities')),
    ];

    if (options.truncated) {
      quads.push(quad(container, CI('truncated'), literal('true', { datatype: XSD('boolean') })));
    }

    for (const member of members) {
      const memberIri = namedNode(this.webIds.entityResourceUrl(origin, userId, member.entity_id));
      quads.push(quad(container, LDP('contains'), memberIri));

      // Minimal inline member metadata for list rendering.
      if (member.entity_type) {
        quads.push(quad(memberIri, RDF_TYPE, namedNode(CI(safeLocalName(member.entity_type)))));
      }

      if (member.name) {
        quads.push(quad(memberIri, RDFS('label'), literal(member.name)));
      }
    }

    return quads;
  }
}
