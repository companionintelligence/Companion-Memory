import { Injectable } from '@nestjs/common';

import type { User } from '@ci/domains/user';

import { FOAF, PIM, RDF_TYPE, SCHEMA, SOLID, literal, namedNode, quad, type Quad } from '../rdf';

import { WebIdService } from './WebIdService';

/**
 * Builds the RDF graph of a user's WebID Profile Document — the public identity
 * card a Solid client fetches to learn who the user is, which OIDC issuer
 * vouches for them, and where their storage lives.
 *
 * The document (`<...>`) is the container resource; the WebID (`<...#me>`) is
 * the agent it describes. This split is the WebID convention: the fragment IRI
 * denotes the person, the document IRI denotes the file about them.
 *
 * Only public identity facts belong here (name, mailbox, issuer, storage
 * pointer) — never secrets. The graph is derived purely from `User`, so it
 * carries exactly what the user's profile row already exposes.
 */
@Injectable()
export class ProfileDocumentService {
  constructor(private readonly webIds: WebIdService) {}

  /** Assembles the profile graph for `user`, addressed under `origin`. */
  build(user: User, origin: string): Quad[] {
    const documentUrl = this.webIds.profileDocumentUrl(origin, user.id);
    const document = namedNode(documentUrl);
    const me = namedNode(this.webIds.webId(origin, user.id));

    const quads: Quad[] = [
      // The document describes the person.
      quad(document, RDF_TYPE, namedNode(FOAF('PersonalProfileDocument'))),
      quad(document, FOAF('primaryTopic'), me),

      // The person.
      quad(me, RDF_TYPE, namedNode(FOAF('Agent'))),
      quad(me, RDF_TYPE, namedNode(SCHEMA('Person'))),
      quad(me, FOAF('name'), literal(user.name)),
      quad(me, FOAF('mbox'), namedNode(`mailto:${user.email}`)),

      // Where this user's pod lives (container served by a later slice).
      quad(me, PIM('storage'), namedNode(this.webIds.storageUrl(origin, user.id))),
    ];

    // solid:oidcIssuer is what turns this into a *Solid* WebID: it tells a
    // relying party which issuer's tokens to trust for this WebID. Omit it
    // rather than emit an empty IRI when no issuer is configured yet.
    const issuer = this.webIds.oidcIssuer();
    if (issuer) {
      quads.push(quad(me, SOLID('oidcIssuer'), namedNode(issuer)));
    }

    return quads;
  }
}
