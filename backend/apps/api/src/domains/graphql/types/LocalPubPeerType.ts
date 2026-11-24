import { Field, ObjectType } from '@nestjs/graphql';

/**
 * What a Local.Pub profile CLAIMS about its owner. Never a link, never a trust tier: the owner
 * links the person with `createPeerLink`, at `stranger`, if and when they choose to, after confirming
 * the Companion's key with the person.
 *
 * Every field is the profile host's claim. None is verified, and none is the actor's own key: that is
 * deliberately not returned (see `peers/localPubProfile.ts`).
 */
@ObjectType()
export class LocalPubPeerCandidateType {
  /** `name@host`, the form to put in `createPeerLink(peerHandle:)`. */
  @Field(() => String)
  handle!: string;

  /** The ActivityPub actor id the profile was read from. */
  @Field(() => String)
  actorId!: string;

  @Field(() => String, { nullable: true })
  profileUrl?: string | null;

  @Field(() => String, { nullable: true })
  displayName?: string | null;

  /**
   * DIDs the profile lists as its owner's, of any method (`did:web`, `did:webvh`, `did:scid:vh`...).
   * For display only: none of them is read as a key, and this box does not resolve them.
   */
  @Field(() => [String])
  claimedDids!: string[];

  /**
   * An `https` address from a profile field whose name contains "companion": the person's Companion
   * `/agent/v1` base, for `createPeerLink(memoryEndpoint:)`. Null when the profile has no such field.
   */
  @Field(() => String, { nullable: true })
  companionEndpoint?: string | null;

  /**
   * A canonical Ed25519 `did:key` from the same kind of field: the key the person says their
   * Companion signs with (the `kid` of its `peers.signingKeyJwk`), for
   * `createPeerLink(peerIssuer: "did:key", peerSubject:)`. Confirm it with the person first: nothing
   * attests it. Null when the profile has no such field, or what it holds is not a usable key.
   */
  @Field(() => String, { nullable: true })
  companionDidKey?: string | null;
}

@ObjectType()
export class LocalPubPeerLookupPayload {
  @Field(() => Boolean)
  found!: boolean;

  /**
   * Why nothing was found: `disabled`, `bad-handle`, `blocked`, `redirected`, `not-found`,
   * `bad-response`, `unreachable` or `busy`. Null when `found`.
   */
  @Field(() => String, { nullable: true })
  reason?: string | null;

  @Field(() => LocalPubPeerCandidateType, { nullable: true })
  candidate?: LocalPubPeerCandidateType | null;
}
