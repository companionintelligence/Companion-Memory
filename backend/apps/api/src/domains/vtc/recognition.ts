import { verifyProof } from './dataIntegrity';
import { DtgParseError, parseDtgCredential } from './dtgCredential';
import { isPlainObject } from './json';
import type { KeyResolver } from './keyResolver';
import { evaluateStatus, StatusListError } from './statusList';

/**
 * Cross-community recognition, the verifier's side: "is this person a current member of a
 * community I have chosen to recognise?", answered from the credential alone plus the community's
 * public status list. The community is never asked about the member.
 *
 * A membership credential is accepted only when ALL of these hold, checked in this order, and the
 * first failure is returned:
 *
 *   1. it parses as a DTG v1 `MembershipCredential` (`dtgCredential.ts`) and is the community's
 *      GRANT. One that carries `credentialSubject.digestMultibase` is a member's acknowledgement,
 *      the member speaking about the community, and is refused;
 *   2. its issuer is a community on THIS box's list of recognised communities;
 *   3. the community issued it as itself: `issuerScope` is `public`;
 *   4. the Data Integrity proof verifies under a key the resolver ties to that issuer;
 *   5. it is inside its validity period, which is finite and no longer than the community's cap;
 *   6. it belongs to the party presenting it, when the caller can say who that is;
 *   7. every revocation and suspension entry it carries is clear in a status list that the same
 *      community signed, that has not expired, and that is no older than `statusListMaxAgeMs`
 *      (24 hours by default) counted from the list's `validFrom`.
 *
 * ═══ PROPERTIES THE CALLER CAN RELY ON ═══
 *
 * - FAIL CLOSED. A refusal, a thrown error, a missing status entry (unless `requireStatus` is turned
 *   off), an unreachable list, a stale list (past its `validUntil`, or older than
 *   `statusListMaxAgeMs`) and an unknown status purpose are all `ok: false`, and so is a clock or an
 *   allowance that is not a finite number. Nothing defaults to valid.
 * - NO FETCH FOR AN UNVERIFIED CREDENTIAL. The status list URL comes from the credential, so a
 *   request is made only after step 4 has shown the recognised community signed that URL.
 * - NO THROW. Every outcome, including a bug, comes back as a result.
 *
 * ═══ PROPERTIES THE CALLER MUST SUPPLY ═══
 *
 * - A VMC is a bearer document: anyone holding the bytes can show them. It proves membership of
 *   the DID in `credentialSubject.id`, not that the party presenting it controls that DID. Pass
 *   `expectedSubject` (the DID the presenter has authenticated as, for example by a signed
 *   request) to bind them; without it the result says `subjectBound: false` and the caller must
 *   not treat the credential as proof of who is asking.
 * - `reason` is for the operator's audit log. Showing it to the presenter tells them which check
 *   to work around, and an ask's visible status stays `answered` or `delivered` (Asks ADR-0001).
 * - `fetchStatusList` must be the box's hardened peer egress (no redirects, DNS pinned at connect
 *   time; Asks ADR-0004), with a response size cap. This module makes no network call itself.
 * - A replayed status list can hide a revocation, but only for as long as the list may be believed:
 *   until its `validUntil`, or `statusListMaxAgeMs` after its `validFrom`, whichever is first.
 *   The limit is the only protection when a community's lists carry no `validUntil` (OpenVTC's
 *   do not), so keep it as short as the community's publishing interval allows.
 * - The proof's own `created` is not compared with the clock; only the credential's and the list's
 *   `validFrom` and `validUntil` are. A proof that names `expires`, `previousProof`, `domain`,
 *   `challenge` or `nonce` is refused by `dataIntegrity.ts`, not read partly.
 */

export const DEFAULT_MAX_CREDENTIAL_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_CLOCK_SKEW_MS = 60 * 1000;
export const DEFAULT_STATUS_LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RecognizedCommunity {
  /** The community's DID, the `issuer` of the credentials it issues. */
  did: string;
  label?: string;
  /** Longest `validUntil - validFrom` accepted from this community. */
  maxCredentialLifetimeMs?: number;
  /** If set, the status list must be served from one of these origins (`https://host[:port]`). */
  statusListOrigins?: readonly string[];
}

export interface RecognizerConfig {
  communities: readonly RecognizedCommunity[];
  resolveKey: KeyResolver;
  /** Returns the parsed status list credential at `url`, or throws. */
  fetchStatusList: (url: string) => Promise<unknown>;
  /** Clock drift tolerated on a `validFrom`; expiry gets none. Finite, zero or more. */
  clockSkewMs?: number;
  /** Refuse a credential that carries no `credentialStatus`. Default true. */
  requireStatus?: boolean;
  /**
   * Refuse a status list that has no `validUntil`. Default false: OpenVTC's lists have none, so
   * turning this on refuses every OpenVTC community. `statusListMaxAgeMs` bounds those instead.
   */
  requireStatusListExpiry?: boolean;
  /**
   * The oldest a status list may be, counted from its `validFrom` and applied whether or not the
   * list has a `validUntil`. A list with no `validFrom` is refused. Finite and above zero;
   * default 24 hours. A community that publishes less often than this must be given a longer
   * limit, which also lengthens the time a replayed list could hide a revocation.
   */
  statusListMaxAgeMs?: number;
}

export interface PresentationContext {
  now?: Date;
  /** The DID the presenter has authenticated as. */
  expectedSubject?: string;
}

export type RecognitionFailure =
  | 'MALFORMED'
  | 'NOT_A_MEMBERSHIP_CREDENTIAL'
  | 'ACKNOWLEDGEMENT_NOT_A_GRANT'
  | 'UNRECOGNIZED_COMMUNITY'
  | 'ISSUER_SCOPE_NOT_PUBLIC'
  | 'BAD_SIGNATURE'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'UNBOUNDED_VALIDITY'
  | 'LIFETIME_TOO_LONG'
  | 'SUBJECT_MISMATCH'
  | 'STATUS_REQUIRED'
  | 'STATUS_UNSUPPORTED'
  | 'STATUS_UNAVAILABLE'
  | 'STATUS_LIST_INVALID'
  | 'REVOKED'
  | 'SUSPENDED'
  | 'VERIFIER_ERROR';

export type RecognitionResult =
  | {
      ok: true;
      community: string;
      label: string | null;
      member: string;
      credentialId: string | null;
      expiresAt: Date;
      /** True only when the caller supplied `expectedSubject` and it matched. */
      subjectBound: boolean;
      /** False only when the config allows a credential with no `credentialStatus`. */
      statusChecked: boolean;
      /** The community's own hint that the member is a person. Not authority; see the DTG spec. */
      personhoodHint: boolean;
    }
  | { ok: false; reason: RecognitionFailure; detail?: string };

export type MembershipRecognizer = (
  presented: unknown,
  context?: PresentationContext,
) => Promise<RecognitionResult>;

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._%:-]+$/;

function refuse(reason: RecognitionFailure, detail?: string): RecognitionResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

function issuerOf(document: unknown): string | null {
  if (!isPlainObject(document)) {
    return null;
  }

  return typeof document.issuer === 'string' ? document.issuer : null;
}

/** The text of a failure. Reading `message` can itself throw (a getter on a hostile error), so it is guarded. */
function describeFailure(error: unknown): string {
  try {
    return error instanceof Error && typeof error.message === 'string' ? error.message : 'unexpected failure';
  } catch {
    return 'unexpected failure';
  }
}

/** Builds a recognizer. Throws if the configuration is malformed, so a typo surfaces at start-up. */
export function createMembershipRecognizer(config: RecognizerConfig): MembershipRecognizer {
  const communities = new Map<string, RecognizedCommunity>();
  for (const community of config.communities) {
    if (!DID.test(community.did)) {
      throw new Error(`recognised community ${JSON.stringify(community.did)} is not a DID`);
    }

    if (communities.has(community.did)) {
      throw new Error(`${community.did} is listed twice`);
    }

    if (community.did.startsWith('did:keri:')) {
      throw new Error(`${community.did} cannot be recognised: did:keri is not resolved by this module`);
    }

    const lifetime = community.maxCredentialLifetimeMs;
    if (lifetime !== undefined && !(Number.isFinite(lifetime) && lifetime > 0)) {
      throw new Error(`${community.did}: maxCredentialLifetimeMs must be a finite number above zero`);
    }

    for (const origin of community.statusListOrigins ?? []) {
      if (new URL(origin).origin !== origin || !origin.startsWith('https://')) {
        throw new Error(`${origin} is not an https origin`);
      }
    }

    communities.set(community.did, community);
  }

  const skewMs = config.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (!Number.isFinite(skewMs) || skewMs < 0) {
    throw new Error('clockSkewMs must be a finite number of milliseconds, zero or more');
  }

  const listMaxAgeMs = config.statusListMaxAgeMs ?? DEFAULT_STATUS_LIST_MAX_AGE_MS;
  if (!Number.isFinite(listMaxAgeMs) || listMaxAgeMs <= 0) {
    throw new Error('statusListMaxAgeMs must be a finite number of milliseconds above zero');
  }

  const requireStatus = config.requireStatus ?? true;

  async function recognize(presented: unknown, context: PresentationContext): Promise<RecognitionResult> {
    const now = context.now ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      return refuse('VERIFIER_ERROR', 'context.now is not a valid time');
    }

    const nowMs = now.getTime();

    let credential;
    try {
      credential = parseDtgCredential(presented);
    } catch (error) {
      if (error instanceof DtgParseError) {
        return refuse('MALFORMED', error.message);
      }

      throw error;
    }

    if (credential.subtype !== 'MembershipCredential') {
      return refuse('NOT_A_MEMBERSHIP_CREDENTIAL', credential.subtype);
    }

    // A member signing "I belong to community C" has the same type as C signing "M belongs to C",
    // with the parties swapped. Only the acknowledgement carries a digest of the grant.
    if (credential.subjectDigest !== null) {
      return refuse('ACKNOWLEDGEMENT_NOT_A_GRANT');
    }

    const community = communities.get(credential.issuer);
    if (!community) {
      return refuse('UNRECOGNIZED_COMMUNITY');
    }

    if (credential.issuerScope !== 'public') {
      return refuse('ISSUER_SCOPE_NOT_PUBLIC', credential.issuerScope);
    }

    const proof = await verifyProof(presented, { resolveKey: config.resolveKey });
    if (!proof.ok) {
      return refuse('BAD_SIGNATURE', proof.code);
    }

    // Each comparison is "accept only if", so nothing that is not a number can pass it.
    if (!(nowMs + skewMs >= credential.validFrom.getTime())) {
      return refuse('NOT_YET_VALID');
    }

    if (!credential.validUntil) {
      return refuse('UNBOUNDED_VALIDITY');
    }

    if (!(nowMs < credential.validUntil.getTime())) {
      return refuse('EXPIRED');
    }

    const maxLifetime = community.maxCredentialLifetimeMs ?? DEFAULT_MAX_CREDENTIAL_LIFETIME_MS;
    if (!(credential.validUntil.getTime() - credential.validFrom.getTime() <= maxLifetime)) {
      return refuse('LIFETIME_TOO_LONG');
    }

    if (context.expectedSubject !== undefined && context.expectedSubject !== credential.subject) {
      return refuse('SUBJECT_MISMATCH');
    }

    if (credential.status.length === 0 && requireStatus) {
      return refuse('STATUS_REQUIRED');
    }

    for (const entry of credential.status) {
      if (entry.statusPurpose !== 'revocation' && entry.statusPurpose !== 'suspension') {
        return refuse('STATUS_UNSUPPORTED', entry.statusPurpose);
      }

      if (
        community.statusListOrigins &&
        !community.statusListOrigins.includes(new URL(entry.statusListCredential).origin)
      ) {
        return refuse('STATUS_LIST_INVALID', 'the list is not served from an allowed origin');
      }

      let list: unknown;
      try {
        list = await config.fetchStatusList(entry.statusListCredential);
      } catch {
        return refuse('STATUS_UNAVAILABLE');
      }

      if (issuerOf(list) !== credential.issuer) {
        return refuse('STATUS_LIST_INVALID', 'the list was not issued by the credential’s issuer');
      }

      const listProof = await verifyProof(list, { resolveKey: config.resolveKey });
      if (!listProof.ok) {
        return refuse('STATUS_LIST_INVALID', listProof.code);
      }

      try {
        const status = evaluateStatus(entry, list, {
          now,
          skewMs,
          requireExpiry: config.requireStatusListExpiry ?? false,
          maxAgeMs: listMaxAgeMs,
        });
        if (!status.valid) {
          return refuse(entry.statusPurpose === 'revocation' ? 'REVOKED' : 'SUSPENDED');
        }
      } catch (error) {
        if (error instanceof StatusListError) {
          return refuse('STATUS_LIST_INVALID', error.code);
        }

        throw error;
      }
    }

    return {
      ok: true,
      community: community.did,
      label: community.label ?? null,
      member: credential.subject,
      credentialId: credential.id,
      expiresAt: credential.validUntil,
      subjectBound: context.expectedSubject !== undefined,
      statusChecked: credential.status.length > 0,
      personhoodHint: credential.personhoodHint,
    };
  }

  return async (presented, context = {}) => {
    try {
      return await recognize(presented, context);
    } catch (error) {
      return refuse('VERIFIER_ERROR', describeFailure(error));
    }
  };
}
