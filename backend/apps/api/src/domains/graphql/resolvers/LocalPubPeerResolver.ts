import { Optional, UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';

import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LocalPubDiscoveryService } from '@ci/domains/peers';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { LocalPubPeerLookupPayload } from '../types/LocalPubPeerType';

/**
 * Look a person up on Local.Pub before linking them.
 *
 * ═══ A READ THAT LEAVES THE APPLIANCE ═══
 *
 * The one thing this field does is send a WebFinger request and an actor request to a host the
 * CALLER named. It is labelled `{ access: 'read', external: true }`, which is what it is, and every
 * root Query is also an MCP tool, so an AI app can call it. What the trust gate then does with that
 * label is the repo's existing policy for an external read, and it is NOT a hold in the default
 * configuration: under the Balanced dial (the default) and under Hands-off the call runs at once;
 * it is queued for the owner's confirmation under Cautious, and for a connected (managed) app.
 * `LocalPubPeerResolver.test.ts` pins exactly that against the real gate.
 *
 * So the controls are the others: the lookup is OFF unless `peers.localPubEnabled` is set; it goes
 * out only through the guarded egress (https, no private address, no redirect); and the service
 * allows two lookups at once and twenty a minute.
 *
 * ═══ THE HANDLE IS A MESSAGE ═══
 *
 * The caller chooses the host AND the text in front of it. Up to about 318 characters (a 64-character
 * name and a 253-character host) per lookup are delivered, before any answer, to whoever runs that
 * DNS zone and host: in the query name, the TLS server name, the Host header and the URL. An AI app
 * steered by a prompt injection can therefore carry out what it has read, twenty short messages a
 * minute, unattended under Balanced and Hands-off, and a DNS server alone is enough to receive them.
 * The host does not merely learn that this box asked. A box whose AI apps read content from outside
 * should leave the flag off or run the Cautious dial; there is no allow-list of hosts, because the
 * point of the lookup is a person's own domain.
 *
 * ═══ WHAT IT RETURNS, AND WHAT IT DOES NOT DO ═══
 *
 * What the profile claims: a display name, DIDs, and the Companion address and `did:key` if a
 * profile field names them. It writes nothing. The owner links the person with the existing
 * `createPeerLink`, whose default tier is `stranger`, passing the `did:key` as the
 * `(peerIssuer, peerSubject)` pair after confirming it with the person. The same owner-scoping and
 * one-live-link-per-identity rules apply there; nothing about this lookup bypasses them.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver()
export class LocalPubPeerResolver {
  constructor(
    private readonly discovery: LocalPubDiscoveryService,
    @Optional() private readonly featureService?: FeatureService,
  ) {}

  @Query(() => LocalPubPeerLookupPayload, {
    description:
      'What a Local.Pub profile claims about a person (name@host): display name, DIDs, and the Companion ' +
      'address and did:key if the profile names them. Creates no link; link with createPeerLink.',
  })
  @GraphqlPrivacy({ access: 'read', external: true })
  async localPubPeerLookup(
    @Args('handle', { type: () => String }) handle: string,
  ): Promise<LocalPubPeerLookupPayload> {
    // The same switch as the rest of the peer surface: a box with asks off has no peer features.
    if (this.featureService && !(await this.featureService.isFeatureEnabled('ask'))) {
      return { found: false, reason: 'disabled', candidate: null };
    }

    const result = await this.discovery.lookup(handle);

    return result.ok
      ? { found: true, reason: null, candidate: result.candidate }
      : { found: false, reason: result.reason, candidate: null };
  }
}
