# Verifiable Trust Community (VTC) credentials

> **Status (2026-11-05): a tested library, not yet a feature.** `backend/apps/api/src/domains/vtc/`
> issues, reads and checks credentials in the formats an [OpenVTC](https://github.com/OpenVTC/verifiable-trust-infrastructure)
> Verifiable Trust Community documents. It is **not** registered with Nest, has **no HTTP route**, writes
> **no database rows** and is imported by **nothing else** in the API. It has **not been run against
> OpenVTC's software**, and the status list OpenVTC's live test community serves is **refused today**
> ([Interoperability evidence](#interoperability-evidence)). Section
> [What is not built](#what-is-not-built) lists the rest, and
> [How it is meant to be wired](#how-it-is-meant-to-be-wired) says what connecting it takes.

## Why it sits next to the KERI code and not on top of it

Two trust stacks live in this service and are kept apart on purpose.

| | Peer asks (`domains/peers`, `domains/asks`) | VTC credentials (`domains/vtc`) |
|---|---|---|
| Question it answers | "Is this the Companion I paired with?" | "Is this DID a current member of a community I recognise?" |
| Identifier | `did:keri:D<x>`, Companion Memory's **own convention**, not CESR (`peers/sovereignKeyId.ts`) | `did:key` and pinned community DIDs; `did:keri` issuers and keys are **refused**, and a member's DID is compared as a string, never resolved |
| Credential | none yet (grants are database rows; the ACDC/TEL design is [ADR-0013](https://github.com/companionintelligence/CI-Engineering/blob/main/adr/0013-keri-toip-decentralized-identity-and-trust-graphs.md)) | W3C VC 2.0 + DTG Credentials v1 |
| Proof | RFC 9421 HTTP message signature | Data Integrity `eddsa-jcs-2022` |
| Revocation | grant row (`revoked_at`) | Bitstring Status List |
| Interoperable with an outside implementation | No, and says so in its source | Not yet run against one. The canonical JSON, base58, `did:key`, proof and status-list encodings reproduce published test vectors; the rest has unit tests only |

The Hub froze its in-tree KERI module on 2026-10-30 because it produced identifiers that look like
KERI and are not (`packages/common/src/keri/FROZEN.md` in the Hub repository, now `Companion-Hub`), and this service's `auditSaid.ts`
and `sovereignKeyId.ts` carry the same disclaimer. The VTC module takes the opposite approach:
it invents no identifiers, and every encoding that has a published test vector is checked against it. It never imports
from `domains/peers` and `domains/peers` does not import it.

## What is in the module

"Pinned to" names a published source the tests reproduce. "Tests" means unit tests only, with no published vector behind them.

| File | Does | Pinned to |
|---|---|---|
| `jcs.ts` | RFC 8785 canonical JSON; refuses what has no JSON form | RFC 8785 §3.2.2–3.2.3 sample, sorting data, all 24 Appendix B numbers |
| `multibase.ts` | `z` base58btc and `u` base64url, one prefix per decoder | Bitcoin Core base58 vectors (re-derived by an independent encoder) |
| `dateTime.ts` | `xsd:dateTimeStamp` with calendar checks V8 does not make | `2026-02-30` rolls forward in `Date.parse`; here it is refused |
| `ed25519.ts` | Ed25519 over `node:crypto`, `Signer` interface | RFC 8032 test 1; a non-canonical `S` is refused |
| `didKey.ts` | `did:key` for Ed25519 only | W3C published key pair |
| `keyResolver.ts` | Which key may sign for an issuer: own `did:key`, or an operator-pinned community key | tests |
| `dataIntegrity.ts` | `eddsa-jcs-2022` create and verify; refuses proof sets and proofs naming `previousProof`, `domain`, `challenge`, `nonce` or `expires`; requires the proof `@context` to equal the document's (stricter than W3C) | W3C `vc-di-eddsa` Appendix B.3: hashes, **signature** and `proofValue` reproduced from the published secret key |
| `dtgCredential.ts` | Strict reader for the DTG v1 envelope; deliberately stricter than the reference on `@context` (exactly the two contexts, nothing after them) | `dtg-credentials` README parse rules |
| `statusList.ts` | Bitstring Status List: encode, expand, read, write, evaluate | the specification's own `encodedList` example and §3.2 Validate Algorithm |
| `recognition.ts` | `createMembershipRecognizer`: is this a current member of a community on my list | tests |
| `community.ts` | `CommunityIssuer`: issue a membership credential, revoke, publish the list; `StatusSlots` | OpenVTC `docs/03-vtc/credentials.md` |
| `auditChain.ts` | HMAC-SHA-256 chained log of decisions | tests |

`cd backend/apps/api && yarn jest src/domains/vtc` runs the module's suites (534 tests in 12 suites as of
2026-11-05) in about two seconds. No new dependency was added: everything uses `node:crypto` and `node:zlib`.

## Recognising a membership

```ts
const recognize = createMembershipRecognizer({
  communities: [
    {
      did: 'did:webvh:community.example.com:abc',
      label: 'Example Community',
      statusListOrigins: ['https://community.example.com'],
    },
  ],
  resolveKey: createKeyResolver({
    pinned: [
      {
        did: 'did:webvh:community.example.com:abc',
        verificationMethods: [
          { id: 'did:webvh:community.example.com:abc#key-0', publicKeyMultibase: 'z6Mk…' },
        ],
      },
    ],
  }),
  fetchStatusList: hardenedFetchJson, // placeholder: the box's peer egress, see below
});

const result = await recognize(presentedCredential, { expectedSubject: authenticatedDid });
// result.ok ? { community, member, expiresAt, subjectBound, … } : { reason }
```

A credential is accepted only when **all** of these hold, checked in this order, returning the first
failure: it parses as a DTG v1 membership credential and is the community's **grant** (one carrying
`credentialSubject.digestMultibase` is a member's acknowledgement, the member speaking about the
community, and is refused); its issuer is on the box's list; its `issuerScope` is `public`; its proof
verifies under a key pinned for that issuer; it is inside a finite validity period no longer than the
community's cap (90 days by default); it belongs to the presenter when the caller says who that is;
and every revocation and suspension entry it carries is clear in a status list that the same
community signed, that has not expired, and that is no older than `statusListMaxAgeMs` (24 hours by
default) counted from the list's `validFrom`.

Properties the caller can rely on:

- **Fail closed.** An unreachable, unsigned, stale (past its `validUntil`, or older than
  `statusListMaxAgeMs`), short or wrong-purpose status list, a missing status entry, an unknown
  purpose, and a clock or allowance that is not a finite number are all refusals. Nothing defaults
  to valid.
- **No request for an unverified credential.** The status list URL comes from the credential, so it
  is fetched only after the proof has shown a recognised community signed that URL.
- **Never throws.** A bug comes back as `VERIFIER_ERROR`.

Properties the caller must supply:

- **A membership credential is a bearer document.** It proves membership of the DID inside it, not
  that the presenter controls that DID. Pass `expectedSubject` (the DID the presenter authenticated
  as); without it the result says `subjectBound: false` and must not be read as "this is who is asking".
- **`reason` is for the operator's log, never for the presenter.** It names the check to work around.
  An ask's visible status stays `answered` or `delivered` ([Asks ADR-0001](https://github.com/companionintelligence/CI-Engineering/blob/main/adr/Asks/0001-asker-sees-only-answered-or-delivered.md)).
- **`fetchStatusList` must be the box's hardened egress**: no redirects, DNS pinned at connect time
  ([Asks ADR-0004](https://github.com/companionintelligence/CI-Engineering/blob/main/adr/Asks/0004-zero-redirect-hops-on-peer-egress.md)),
  with a response size cap. The module makes no network call itself.
- **A replayed status list can hide a revocation, but only for a bounded time:** until the list's
  `validUntil`, or `statusListMaxAgeMs` after its `validFrom` (24 hours by default), whichever comes
  first. OpenVTC's lists carry no `validUntil`, so for them the age limit is the only bound, and
  `requireStatusListExpiry` (which would refuse every OpenVTC community) should stay off.
  `CommunityIssuer` dates its lists for a day, so republish before they lapse. A community that
  publishes less often than the limit needs a longer `statusListMaxAgeMs`, which lengthens the
  replay window by the same amount.
- **The proof's own `created` is not compared with the clock.** Only the credential's and the list's
  `validFrom` and `validUntil` are. A proof that names `expires`, `previousProof`, `domain`,
  `challenge` or `nonce` is refused, not partly read.

## Issuing a membership

```ts
const issuer = new CommunityIssuer({
  did,
  signer,                              // a Signer: local key, VTA or enclave
  revocationListUrl: `${publicUrl}/v1/status-lists/revocation`,
});
const { credential, statusIndex } = await issuer.issueMembership(memberDid);
issuer.revoke(statusIndex);            // later; store every statusIndex against the member
const list = await issuer.publishRevocationList(); // serve it; republish after every revocation
```

The credential has the shape OpenVTC documents: DTG v1 contexts, `issuerScope: public`, a finite
`validUntil` (30 days by default), one `BitstringStatusListEntry` for `revocation`. It is parsed back
by this module's strict reader before it is returned. Slots are chosen at random (the Bitstring Status
List specification asks issuers to), and slots 0–3 are decoys set from the first publication so a new
community's first member is not visibly "index 0" (OpenVTC VTC spec §6.2). A slot is reserved before
signing and given back if signing fails.

Renewing is another `issueMembership` call and takes a **new** slot, so revoking the newest credential
leaves an older, unexpired one valid: keep every `statusIndex` issued to a member until its credential
expires, and revoke them all. A verifier refuses a lifetime above its cap (90 days by default), so
issuing for longer needs verifiers configured to match.

## What this does not decide

- **Which DID methods resolve.** Only `did:key` (its own key) and communities an operator pins.
  `did:webvh` and `did:web` need a network, a log verifier and a rotation story, and belong in their
  own resolver behind `KeyResolver`. **`did:keri` is refused**: no `did:keri` issuer resolves, a `did:keri` key cannot be pinned and a
  `did:keri` community cannot be configured. A member's DID is compared as an opaque string and is not
  resolved.
- **Who is allowed to join.** Join criteria, admin review, step-up and second-party consent are the
  service's job around `CommunityIssuer`.
- **Persistence.** `StatusSlots.snapshot()` and `restore()` give the state a service must store, and
  it must serialize `allocate` and `revoke`.

## What is not built

The page at <https://first.openvtc.net/> describes a whole community service. This module is its
credential core. Not built, and tracked in
[`CI-Engineering/projects/decentralized-trust-graphs/OPENVTC-VTC.md`](https://github.com/companionintelligence/CI-Engineering/blob/main/projects/decentralized-trust-graphs/OPENVTC-VTC.md):

- the join request, admin review and member sign-in (passkey or wallet) flows, and any HTTP surface;
- capability-based roles (the authority credential, VAC), step-up and second-party consent;
- renewal on the same slot (each renewal takes a new one) and publishing a suspension list (the reader
  checks one; `CommunityIssuer` issues only the revocation list);
- relationship (VRC), delegation (VDC), invitation (VIC), persona (VPC) and statement (VSC) credentials;
- a trust registry (TRQP) and OID4VP presentation;
- verifiable data rooms, git governance, the public website and the admin console;
- a `did:webvh` resolver and a Token Status List (SD-JWT VC) reader;
- a reader for the status list OpenVTC's live community serves (see below).

## Interoperability evidence

Tags: **[V]** reproduced by a test in this repository against a published source; **[docs]** follows a
specification's text and is covered by unit tests only; **[obs]** observed on a live OpenVTC service on
the date given; **manual** done once by hand and not repeatable from the repository; **UNKNOWN** not tested.

| Claim | Evidence | Tag |
|---|---|---|
| JCS output equals RFC 8785's | RFC samples and Appendix B in `jcs.spec.ts` | **[V]** |
| `eddsa-jcs-2022` equals W3C's | Appendix B.3 vector in `dataIntegrity.spec.ts`: canonical forms, both hashes, the combined hash, the signature and `proofValue` reproduced from the published secret key; the published secured credential verifies | **[V]** |
| base58btc and multikey handling is correct | Bitcoin vectors; the published public key equals the one derived from the published secret key | **[V]** |
| Ed25519 matches RFC 8032 and refuses a malleated signature | RFC 8032 test 1 reproduced byte for byte; `S + L` and every single-bit change refused (`ed25519.spec.ts`) | **[V]** |
| Status list reading follows the specification | The specification's `encodedList` example expands to 16,384 zero bytes; bit 0 is the left-most bit; §3.2 steps in `statusList.spec.ts` | **[V]** against the example, **[docs]** for the algorithm |
| The specs notice a defect | 46 planted defects, each turned a suite red; none survived the final run (2026-11-06). The script is not in the repository | **manual** |
| OpenVTC's live community "The First VTC" (`first.openvtc.net`, a test community for the Decentralized Trust Graph working groups) publishes a status list this module can read | Its revocation list has a two-member proof set (`eddsa-jcs-2022` and `mldsa44-jcs-2024`) and an `encodedList` without the multibase `u` prefix. This module refuses both. It has `validFrom` (the request time) and no `validUntil` or `ttl`, and is served `no-store` | **[obs]** 2026-11-05: **refused today** |
| OpenVTC's status lists carry `validUntil` | No (same observation; OpenVTC's `vtc-service/src/status_list/credential.rs` sets `valid_from` only) | **[obs]** |
| A credential issued by OpenVTC's own `vtc` verifies here | not run | **UNKNOWN** |
| A credential issued here verifies in OpenVTC's `dtg-credentials` | not run | **UNKNOWN** |

Reading a credential OpenVTC issued needs one from a running `vtc` (joining the live community takes a
wallet and an administrator's approval); checking one issued here needs OpenVTC's Rust
`dtg-credentials`. The live status list is the first thing to settle, because a plain `GET` returns it:
this module must either learn to read it (accept a proof set whose `eddsa-jcs-2022` member verifies
under a pinned key and ignore the suites it cannot check; accept an `encodedList` with no prefix) or
the difference goes upstream. That is a deliberate decision, not a bug fix, and it is not made here.

## How it is meant to be wired

1. A `VtcModule` that provides a recognizer built from configuration (the list of recognised
   communities and their pinned keys), registered behind a feature flag that defaults off.
2. A `fetchStatusList` built on the existing peer egress, with a size cap and a cache that honours
   the list's `ttl` when it has one (OpenVTC's lists have none and are served `no-store`).
3. `StatusSlots` and issued credentials persisted in `ci.*` tables, behind a service that serializes
   allocation.
4. A route that takes a presented credential together with an authenticated DID, calls the
   recognizer with `expectedSubject`, and writes each decision to the audit chain.
5. Only then: grants that name a community ("anyone in this community may ask for my availability")
   in place of one person at a time.

## References

- OpenVTC: [verifiable-trust-infrastructure](https://github.com/OpenVTC/verifiable-trust-infrastructure), [dtg-credentials](https://github.com/OpenVTC/dtg-credentials), the [VTI specification](https://trustoverip.github.io/dtgwg-vti-spec/)
- DTG Credentials: <https://github.com/trustoverip/dtgwg-cred-spec> (Working Draft 0.6.0)
- W3C: [Verifiable Credentials 2.0](https://www.w3.org/TR/vc-data-model-2.0/), [Data Integrity EdDSA Cryptosuites](https://www.w3.org/TR/vc-di-eddsa/), [Bitstring Status List](https://www.w3.org/TR/vc-bitstring-status-list/)
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS), [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032) (Ed25519)
