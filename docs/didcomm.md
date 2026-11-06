# DIDComm Messaging v2.1

> **Status (2026-11-05): a tested library, not yet a feature.** `backend/apps/api/src/domains/didcomm/`
> packs and unpacks [DIDComm Messaging v2.1](https://identity.foundation/didcomm-messaging/spec/)
> envelopes (authcrypt, anoncrypt, signed, and the combinations), routes them through mediators, and
> speaks the small protocols DIDComm itself defines. It is **not** registered with Nest, has **no
> HTTP route or socket**, writes **no database rows**, makes **no network request** and is imported
> by **nothing else** in the API. [What is not built](#what-is-not-built) lists the rest and
> [How it is meant to be wired](#how-it-is-meant-to-be-wired) says what connecting it takes.
> The decision and its history are in
> [ADR-0018](https://github.com/companionintelligence/CI-Engineering/blob/main/adr/0018-didcomm-messaging-alongside-keri.md).

## Why it sits next to the KERI design and not on top of it

DIDComm and KERI answer different questions, and the code keeps them apart.

| | Identifiers and keys | Messages |
|---|---|---|
| Question | Who is this, and which keys are theirs? | How do I send them something only they can read, and how do they know it came from me? |
| KERI / ToIP ([ADR-0013](https://github.com/companionintelligence/CI-Engineering/blob/main/adr/0013-keri-toip-decentralized-identity-and-trust-graphs.md)) | Autonomic identifiers, key event logs, pre-rotation. **Design only**: the Hub froze its KERI module on 2026-10-30, and `did:keri:D<x>` here (`peers/sovereignKeyId.ts`) is this service's own spelling of an Ed25519 key, not CESR | Not its job. Peer asks are HTTPS with RFC 9421 signatures |
| This domain | `did:key`, `did:peer:2`, `did:web` resolved from the DID alone or through an injected fetch; **`did:keri` is refused** | Authcrypt and anoncrypt envelopes, signed messages, mediator routing, threads, trust-ping, discover-features, problem reports, out-of-band invitations |

DIDComm never looks at a key event log. It asks a `DidResolver` for the DID document and uses the keys
that document lists. That is the seam: a conformant KERI-backed resolver (`did:webs`) registered with
`createDidResolver({ methods: { webs } })` would make a KERI identity a DIDComm identity without
touching the message layer. `createDidResolver({ methods: { keri } })` throws, on purpose: nothing in
this service produces a real KERI identifier, and a resolver that pretended to would encrypt to a
string that proves nothing a `did:key` does not.

One Ed25519 key, three spellings, three different claims:

| Spelling | Where it exists | What it proves |
|---|---|---|
| `did:keri:D<jwk-x>` | `peers/sovereignKeyId.ts` | Nothing beyond the key. Not CESR, no key event log |
| `did:key:z6Mk…` | `didKeyIdentityFromEd25519Seed` | The key. It cannot rotate: a new key is a new identity |
| X25519 key derived from it (`z6LS…`) | the same function | The key agreement key, by the RFC 7748 §4.1 birational map |

`didKeyIdentityFromEd25519Seed(seed)` gives an existing Ed25519 device key a DIDComm identity with no
new key material. It is a statement about the key and not about KERI.

## What is in the module

| File | Does | Pinned to |
|---|---|---|
| `encoding.ts` | Strict unpadded base64url, base58btc, multibase, multicodec varints | Bitcoin Core base58 vectors; keys from the DIF reference tests |
| `jwk.ts` | JWK validation for Ed25519, X25519, P-256, P-384, P-521, secp256k1; on-curve and `d`↔`x` checks | every key in the specification's Appendix A |
| `edwards.ts` | Ed25519 → X25519 public and secret conversion (`BigInt`, no dependency) | a published `did:key` pair; two property tests |
| `contentEncryption.ts` | `A256CBC-HS512`, `A256GCM`, `XC20P` (HChaCha20 written here) | RFC 7518 §B.3; draft-irtf-cfrg-xchacha-03 §2.2.1 and A.3.1 |
| `keyAgreement.ts` | ECDH, Concat KDF, AES Key Wrap; ES and 1PU derivation | RFC 7518 Appendix C; RFC 3394 §4.6; the 1PU layout by Appendix C.3 |
| `jwe.ts` | General JSON JWE: anoncrypt (`ECDH-ES+A256KW`) and authcrypt (`ECDH-1PU+A256KW`) | all six Appendix C.3 messages; four Rust-reference messages |
| `jws.ts` | `EdDSA`, `ES256`, `ES256K` (written low-S); compact JWS for `from_prior` | Appendix C.2: the Ed25519 vector is reproduced byte for byte |
| `multikey.ts`, `didKey.ts`, `didPeer.ts`, `didWeb.ts` | `did:key`, `did:peer:2`, `did:web` URL rules | the `did:peer:2` specification example is reproduced character for character |
| `didDocument.ts`, `resolver.ts` | Keys by relationship, `DIDCommMessaging` endpoints, method routing | the specification's Alice and Bob documents |
| `message.ts` | Plaintext message validation and builder | the Rust reference's valid and invalid plaintext vectors |
| `pack.ts` | `packPlaintext`, `packSigned`, `packEncrypted`, `unpack` with all the layer checks | Appendix C: all of it, through `unpack` |
| `routing.ts` | `forward` messages, `prepareDelivery` (endpoint choice, mediator DIDs, routing keys) | a three-hop route unwrapped hop by hop in the tests |
| `fromPrior.ts` | DID rotation JWT | the Rust reference's JWT is reproduced byte for byte |
| `outOfBand.ts`, `trustPing.ts`, `discoverFeatures.ts`, `problemReport.ts`, `piuri.ts` | The protocols and type URIs | the specification's printed examples, including its `_oob` URL |
| `agent.ts`, `replayGuard.ts` | One DID, a handler table, replay protection | tests |
| `identity.ts`, `secrets.ts` | `did:key` and `did:peer` identities with their keys; the `SecretsResolver` seam | tests |

`yarn jest src/domains/didcomm` runs 609 tests in 22 suites in about two seconds. **No new dependency
was added**: everything uses `node:crypto`. Statement coverage is 98% and branch coverage 96% (the
barrel, which only re-exports, excluded). A mutation check planted twenty defects in the security
checks, one at a time (apv, the 1PU tag, the small-order secret, the on-curve check, the authentication
relationship, `from`/`to`/signer consistency, expiry, nesting, the replay guard, cross-DID references,
`did:keri`, the CBC MAC, and so on). The first run caught sixteen, and the four it missed were weak
tests, now fixed; all twenty are caught.

## Using it

```ts
import {
  createDidResolver, DidcommAgent, generateDidKeyIdentity, generateDidPeerIdentity,
  InMemoryReplayGuard, buildPing, secretsOf,
} from '@ci/domains/didcomm'; // through the barrel: dependency-cruiser forbids deep imports

const resolver = createDidResolver();           // did:key and did:peer, no network
const alice = generateDidKeyIdentity();         // or didKeyIdentityFromEd25519Seed(deviceKeySeed)
const bob = generateDidPeerIdentity({ uri: 'https://bob.example/didcomm' });

const aliceAgent = new DidcommAgent({ did: alice.did, resolver, secrets: secretsOf(alice) });
const bobAgent = new DidcommAgent({
  did: bob.did, resolver, secrets: secretsOf(bob), replayGuard: new InMemoryReplayGuard(),
});

// Alice: authcrypt to Bob, and learn where to POST it.
const delivery = await aliceAgent.send(buildPing({ from: alice.did, to: [bob.did] }), { to: bob.did });
//   delivery.uri === 'https://bob.example/didcomm'
//   delivery.contentType === 'application/didcomm-encrypted+json'

// Bob: unpack, run the handler, get the replies packed for Alice.
const { metadata, replies } = await bobAgent.receive(delivery.packed);
//   metadata.senderDid === alice.did   (proven, not claimed)
//   replies[0].packed is the ping-response; replies[0].delivery is undefined because a bare
//   did:key publishes no endpoint, so that reply can only travel on a channel Alice holds open.
```

Lower level, with no agent:

```ts
const { packed } = await packEncrypted(message, { resolver, secrets, to: bob.did, from: alice.did });
const { message, metadata } = await unpack(packed, { resolver, secrets, require: { authenticated: true } });
```

`unpack` returns what the envelope **proved**, not what the message says:

| `metadata` | Meaning |
|---|---|
| `layers` | `['anoncrypt']`, `['authcrypt']`, `['anoncrypt','sign']`, `['anoncrypt','authcrypt']`… outermost first |
| `authenticated` | The sender is proven to this recipient (authcrypt, or a verified signature) |
| `nonRepudiation` | A signature by the sender verified: provable to a third party. Authcrypt alone is repudiable |
| `anonymousSender` | Encrypted, nothing proves who sent it. `message.from` is then just text |
| `senderDid`, `senderKid`, `signerKid`, `recipientDid`, `recipientKid` | Present only when proven |
| `fromPrior` | A verified DID rotation, as evidence |

## What it decides

- **Unpacking fails closed.** Default policy is `require: { encrypted: true }`; plaintext and
  signature-only messages are refused unless the caller says that is acceptable (an out-of-band
  invitation, for instance).
- **Keys come from the sender's own DID document, under the right relationship.** An authcrypt `skid`
  must be in the sender's `keyAgreement`; a signing `kid` must be in `authentication`. A valid
  signature from a key the DID does not list for authentication is refused before it is verified.
- **Layers must agree.** `from` must equal the DID of the authcrypt `skid` and of the signer; the DID
  the message was decrypted for must be in `to`; only the specification's envelope combinations are
  accepted (no `anoncrypt` inside `anoncrypt`, no `sign` inside `sign`).
- **Narrow JOSE.** Two key-wrap algorithms, three `enc` values, authcrypt only over `A256CBC-HS512`
  (ECDH-1PU needs a key-committing AEAD). No `zip`, `crit`, `unprotected`, `aad` or flattened JWE; one
  signature per JWS; base64url must be canonical; the ephemeral key must be on its curve; a small-order
  Diffie-Hellman result is refused; `apv` binds the recipient list into the key derivation.
- **Every decryption failure is the same error**, and problem codes are coarse (`e.m.trust.crypto`), so
  neither is an oracle.
- **`body` is never rewritten.** Key order, numbers and strings come out as they went in, so a
  signature over the received object (a Trust Task's Data Integrity proof) still verifies.
- **No network.** `did:web` goes through a caller-supplied `fetchJson`; the module builds the `https:`
  URL (no IP literals, no `localhost`, no traversal) and checks the document is for that DID. Delivery
  returns the endpoint and bytes; the caller sends them through its own egress policy.
  `prepareDelivery` refuses anything but `https:` and `wss:` by default, and URLs with credentials.
- **Bounded.** 1 MiB per envelope, 100 recipients, 64 attachments, length caps on DIDs and base58.
- **Replays.** `InMemoryReplayGuard` remembers (sender, message id) pairs. It is process-local; see the
  wiring gate.

### Where it differs from the specification's text

| Choice | Why |
|---|---|
| A message whose `to` omits the DID it was decrypted for is **refused** (`allowMisaddressed` restores the permissive reading) | The specification says both "MUST NOT fail" (Message Headers) and "MUST be an error" (Layer Addressing Consistency). Signatures need `to` precisely so a recipient cannot be handed someone else's message |
| `anoncrypt(authcrypt(sign(…)))` is **accepted** and never produced | It is what the specification's own Appendix C.3 protected-sender vector contains, although the text says it "makes no sense" to emit |
| `"apu": null` on an anoncrypt JWE is read as absent | Some producers write it; the key derivation is identical |
| Message `id` is printable ASCII up to 256 characters | The specification asks for URI-unreserved characters up to 32 bytes and also recommends UUIDs, which are 36 |
| `body` may be absent on receipt, always present on send | v2.1 allows the first; v2.0 receivers require the second |
| `from_prior` temporal claims are returned, not enforced | The specification defines none, and the reference's own vector carries an `exp` long past |
| A body that is not a JSON object, an `id` outside printable ASCII, a message already past its `expires_time` and a `from_prior` without `iat` are **refused**, although the reference implementation will pack all four | DIDComm defines the body as an object; the rest are this domain's bounds. Five rows of the interop run pin this strictness |
| ES256K signatures are written in low-S form (`s` ≤ n/2); either form is accepted | OpenSSL writes `s` or `n - s` at random, and the Rust reference implementation refuses the high form, as libsecp256k1 does. Found by running this domain against it |

## What is not built

| Not built | Note |
|---|---|
| An HTTP endpoint, WebSocket listener or any transport | `receive` takes bytes, `send` returns bytes and an endpoint |
| A mediator, and Message Pickup 3.0 | Needed for a Companion behind NAT; who runs the mediator is undecided. Only the sending side of routing exists |
| Persistent keys, a replay store, an outbound queue | `SecretsResolver` has only an in-memory implementation; the replay guard is per process |
| `did:peer` numalgo 0, 1, 3, 4; `did:webvh`; a KERI-backed `did:webs` | Refused with `unsupported-did-method`. `did:keri` is refused with the same code, on purpose |
| `please_ack`/acks, `return_route`, route tracing, advanced sequencing | |
| Issue Credential, Present Proof, Basic Message | Not needed by anything here yet |
| TSP (Trust Spanning Protocol) | OpenVTC prefers TSP, then DIDComm, then REST |

## Interoperability evidence

**Verified, reference to here:** every message in the specification's Appendix C (six encrypted, three
signed) and the Rust reference implementation's test vectors (four encrypted, three signed, a
`from_prior` JWT, and the plaintext set, valid and invalid) decrypt, verify and parse. Together they
cover ECDH-ES over X25519, P-256, P-384 and P-521; ECDH-1PU over X25519 and P-256 (and P-521 nested);
XC20P, A256GCM and A256CBC-HS512; EdDSA, ES256 and ES256K; sign-then-encrypt; and the protected-sender
nesting.

**Verified, both directions, against the reference implementation itself.** On 2026-11-06 this domain
was run against the `didcomm` npm package (0.4.1, the Rust crate compiled to WebAssembly): 109 rows, each a
message packed by one side and unpacked by the other, compared field by field and against what the
reference reports it opened (cipher, curve, signer, flags). They cover authcrypt and anoncrypt
(A256CBC-HS512, A256GCM, XC20P) over X25519 and P-256, signed messages and sign-then-encrypt (EdDSA,
ES256, ES256K), a protected sender, `from_prior`, one and two mediator hops, a `did:key` identity and a
range of message shapes; 32 of the rows are negative controls that must be refused for the right
reason. Sixteen defects planted in the compiled library were all caught by it. That settles what the
ECDH-1PU key derivation raised (it was found by testing candidate encodings against the specification's
vector): the reference accepts what this domain writes. The harness and the steps to repeat the run are
in CI-Engineering, `projects/decentralized-trust-graphs/didcomm-interop/`.

It found one bug, fixed here: the reference refused about half of the ES256K signatures (OpenSSL writes
`s` or `n - s` at random, and Rust's `k256` accepts only the low form), so the domain now writes low-S.
It also found what the reference cannot do: P-384 and P-521 key agreement (those two curves rest on the
published vectors alone), `from_prior` without `sub`, and exact 17-digit floats (`123456789.123456789`
comes back one unit in the last place off). Its default anoncrypt cipher is XC20P, so `XC20P` stays.

**Not verified:** an OpenVTC mediator or VTA (`vti-didcomm-js`), and any live exchange: the rest of gate 1
below. The live OpenVTC test community advertises DIDComm and a mediator (its public profile, read
2026-11-05 and recorded in CI-Engineering's `OPENVTC-VTC.md`, open as CI-Engineering#452 and unmerged on
2026-11-05), but its DID is a `did:webvh`, which this domain refuses: a live check needs that method
built, or the fetched DID document supplied by hand.

## How it is meant to be wired

The HTTP binding is small: `POST` the envelope with `Content-Type: application/didcomm-encrypted+json`,
answer `202 Accepted` with no body, and never put a reply in the response (DIDComm HTTP is one-way).
Authentication is the message's, not the connection's, so the route needs no session, but it does need
a rate limit, a body cap and a feature flag.

Gate, in this order, before anything is connected:

1. **Cross-implementation checks in both directions**: done against the reference implementation
   (above); still to do against an OpenVTC mediator or `vti-didcomm-js`.
2. **Egress.** `fetchJson` for `did:web` and the delivery POST built on the existing no-redirect,
   connect-time-pinned peer egress with a size cap. The DIDComm HTTP binding allows following `307`;
   peer egress does not follow redirects, and that difference is a decision, not an oversight.
3. **Keys.** A `SecretsResolver` backed by wherever the device key lives, and a decision on which DID a
   Companion presents (`didKeyIdentityFromEd25519Seed` of the device key is the no-new-key answer).
4. **A shared replay store** if more than one process receives.
5. **A flag that defaults off**, and Hub security review.

### Carrying Trust Tasks

The Trust Tasks registry's [`didcomm/0.2` binding](https://trusttasks.org/bindings/didcomm/0.2/spec.md)
defines how a Trust Task document travels: an **authcrypt** DIDComm message of type
`https://trusttasks.org/binding/didcomm/0.1/envelope`, the document as `body`. Companion Memory's own
Trust Tasks domain (`domains/trust-tasks`, Companion-Memory#3385) serves the HTTPS binding only, and its
`docs/trust-tasks.md` lists the DIDComm binding as not implemented, so what follows is how the wiring
would look, not something that runs. With this domain:

```ts
const { message, metadata } = await unpack(packed, { resolver, secrets, require: { authenticated: true } });
// anoncrypt and plaintext never reach here: require.authenticated refuses them
if (message.type !== 'https://trusttasks.org/binding/didcomm/0.1/envelope') return reject();
const reply = await engine.handle(message.body, { sender: metadata.senderDid, recipient: metadata.recipientDid });
// reply.kind is 'refused', 'absorbed' or 'document'. sender and recipient must equal the document's
// issuer and recipient exactly. `engine` is the TrustTasksEngine in domains/trust-tasks/engine.ts: the
// domain's barrel does not export it (TrustTasksService.handle wraps it for the HTTPS controller).
```

`message.body` is the object as received. `thid` and `pthid` map to the document's `threadId` and
`parentThreadId`, compared only when both are present (the Trust Tasks engine has no input for them
today, so the caller would make the comparison). The binding says `from` is "the DID URL of the
sender's signing key", but DIDComm Messaging requires `from` to be a DID without a fragment; this
domain writes the bare DID and reports the verified key in `metadata.senderKid`. The binding also
leaves duplicate execution to the consumer, keyed on the document `id`, because a mediator
redelivery arrives under a fresh DIDComm id: the replay guard here is not a substitute.

## References

- [DIDComm Messaging v2.1](https://identity.foundation/didcomm-messaging/spec/) and [didcomm.org](https://didcomm.org/); test vectors from [`decentralized-identity/didcomm-messaging`](https://github.com/decentralized-identity/didcomm-messaging) (Appendix A–C, commit `c78bcc4`) and [`sicpa-dlab/didcomm-rust`](https://github.com/sicpa-dlab/didcomm-rust) (commit `4388350`)
- [ECDH-1PU](https://datatracker.ietf.org/doc/html/draft-madden-jose-ecdh-1pu-04), RFC 7516 / 7518 / 3394, [XChaCha20-Poly1305](https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha-03)
- [did:key](https://w3c-ccg.github.io/did-method-key/), [did:peer](https://identity.foundation/peer-did-method-spec/), [did:web](https://w3c-ccg.github.io/did-method-web/)
- ADR-0018 (this decision), ADR-0013 (KERI/ToIP), ADR-0015 (Trust Tasks), ADR-0017 (OpenVTC) in CI-Engineering
- OpenVTC: [`verifiable-trust-infrastructure`](https://github.com/OpenVTC/verifiable-trust-infrastructure) design notes on DIDComm and TSP
