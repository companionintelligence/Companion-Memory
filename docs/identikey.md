# IdentiKey: a second way to prove who you are

> **Status: Phase 1 of 5. A library, wired to nothing.** Everything in
> [`domains/identikey/`](../backend/apps/api/src/domains/identikey/) is pure code and tests: no Nest module,
> no route, no configuration key, no feature flag, no table, no migration. Nothing in the running
> application calls it, and merging it changes no behaviour. What it gives the next phases is a verifier
> that has already been attacked (see [Evidence](#evidence-what-was-checked-and-what-was-not)).
> Phases 2 to 5 are listed under [What is not built](#what-is-not-built) and none of them exists yet.
> Design record: CI-Engineering
> [ADR-0020](https://github.com/companionintelligence/CI-Engineering/blob/main/adr/0020-identikey-protocol-alongside-keri.md).
> Tracking: [CI-Server #1711](https://github.com/companionintelligence/CI-Server/issues/1711).

[IdentiKey](https://github.com/identikey) is an open protocol suite (Apache-2.0 OR BSD-2-Clause-Patent,
Rust reference implementation) for four things a personal-AI appliance needs and the peer-federation work
in [peer-federation.md](peer-federation.md) does not yet have:

| Layer             | IdentiKey piece                                                        | In this repo               |
| ----------------- | ---------------------------------------------------------------------- | -------------------------- |
| Prove who you are | `identikey-auth`: a challenge a verifier issues and a key holder signs | **Phase 1, this document** |
| Say what an agent may do | `identikey-capability`: attenuable Biscuit tokens               | not built (Phase 3)        |
| Share data you hold encrypted | `identikey-share` v1 over Recrypt proxy re-encryption      | not built (Phase 4)        |
| Prove what was done | `identikey-log`: a signed, hash-linked operation log                 | not built (Phase 5)        |

Custody of the keys themselves (the IKEYW v2 wallet file) belongs with Phase 2.

## How this sits next to the KERI-shaped identity

Companion Memory's peer identity today is a **self-certifying identifier**, `did:keri:D<base64url Ed25519 key>`
([`peers/sovereignKeyId.ts`](../backend/apps/api/src/domains/peers/sovereignKeyId.ts)), carried by RFC 9421 HTTP
message signatures. It is KERI-_shaped_, not KERI: there is no key event log, no pre-rotation and no CESR.
The [decentralized-trust design](https://docs.ci.computer/docs/companion-memory/decentralized-trust-keri)
describes where that is meant to go.

IdentiKey does not replace any of that and is not a competing identifier scheme. It is a different
_ceremony_ over the same kind of key:

|                    | The peer identity that exists                      | IdentiKey `identikey-auth` (this library)                                 |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------- |
| What it names      | a box, by its Ed25519 key                          | any key holder: a person, a device, a box                                 |
| How it proves      | signs each HTTP request (RFC 9421)                 | signs a verifier-issued, single-use challenge                             |
| Algorithms         | Ed25519 only                                       | Ed25519 or P-256, plus an optional ML-DSA-44/65/87 co-signature           |
| Replay protection  | `ConsumptionStore.claimOnce` on the signature      | a nonce the verifier issued and spends exactly once                       |
| Identifier         | `D<jwk x>`                                         | `blake3(dCBOR({alg, key}))`, shown as base58                              |
| Rotation / history | not implemented                                    | not implemented (the reference's PQ state chain is also not built here)   |

The two identifiers are different strings for the same Ed25519 key, and either is computable from the
public key alone. [`ed25519KeyFromJwk` / `ed25519JwkOf`](../backend/apps/api/src/domains/identikey/identity/keys.ts)
convert between this library's key type and the JWK that `config.peers.signingKeyJwk` already uses, so a
box can answer both ways with one key. Phase 2 decides whether it should (see the ADR).

## What is here

```
domains/identikey/
  errors.ts                 IdentiKeyError and its codes
  encoding/                 dCBOR codec (the strict subset the protocol signs), base58, "b64:" text form
  crypto/                   Ed25519 (strict verify), P-256, ML-DSA (noble), BLAKE3
  identity/
    algorithms.ts           the algorithm tags
    keys.ts                 keys, signatures, fingerprints, their CBOR wire forms
    challenge.ts            the challenge and response messages, the signing payload
    nonceStore.ts           NonceStore, InMemoryNonceStore, ChallengeIssuer
    verify.ts               verifyResponse(): the one function a server calls
    softwareSigner.ts       Signer (the seam for a wallet or enclave), SoftwareSigner, respond()
  index.ts                  the public surface; import from here
  __tests__/fixtures/       bytes from the Rust reference and from independent implementations (README.md)
```

## A worked example

This is [`identity/example.spec.ts`](../backend/apps/api/src/domains/identikey/identity/example.spec.ts),
which runs it on every test run. `pins` is a `Map` here and a table in a real deployment.

```ts
import { randomBytes } from 'node:crypto';
import {
  ChallengeIssuer,
  InMemoryNonceStore,
  SoftwareSigner,
  respond,
  verifyResponse,
  type PqPin,
} from '../domains/identikey';

const audience = 'papyrus'; // who the verifier is; the claimant signs it too
const now = Math.floor(Date.now() / 1000);
const nonces = new InMemoryNonceStore();
const issuer = new ChallengeIssuer({ audience, ttlSeconds: 120 });
const pins = new Map<string, PqPin>();

const verify = (response: Uint8Array) =>
  verifyResponse(response, {
    audience,
    now,
    skewSeconds: 30,
    policy: 'pq-required',
    nonces,
    resolvePqPin: (fingerprint) => pins.get(Buffer.from(fingerprint).toString('hex')) ?? { kind: 'unpinned' },
  });

// The claimant holds an Ed25519 key and an ML-DSA-65 key.
const claimant = SoftwareSigner.fromEd25519Seed(randomBytes(32)).withMlDsa('ml-dsa-65');

// Verifier issues a challenge; claimant answers it; verifier checks the answer.
const challenge = await issuer.issue(nonces, now);
const response = await respond(claimant, challenge.bytes, { audience });
const result = await verify(response);

if (result.ok) {
  // First contact: remember which post-quantum key belongs to this fingerprint.
  const { fingerprint, pqPublicKey } = result.verified;
  pins.set(Buffer.from(fingerprint).toString('hex'), { kind: 'key', publicKey: pqPublicKey! });
}
```

After that, replaying `response` returns `{ ok: false, code: 'replay' }`, and a response that has the same
Ed25519 key but a different ML-DSA key returns `{ ok: false, code: 'pq-key-changed' }`. Both are asserted in
the test.

## The wire format

Everything is deterministic CBOR (dCBOR, RFC 8949 section 4.2.1) restricted to unsigned integers, byte
strings, text strings, arrays and text-keyed maps. No floats, tags or negative integers.

```
challenge  = { v: 1, aud: text, exp: uint, iat: uint, nonce: bytes(>= 16) }   // keys sorted by encoded bytes
response   = { chal: <the challenge bytes, verbatim>,            // members shown in logical order; the wire sorts them
               pub:  { alg, key },        sig:   { alg, sig },
               pqpub?: { alg, key },      pqsig?: { alg, sig } }               // pqpub and pqsig: both or neither
signed     = dCBOR([ "identikey-auth/v1", "challenge", <challenge bytes> ])
fingerprint = BLAKE3( dCBOR({ alg, key }) )                                    // 32 bytes; base58 for display
```

`alg` is `ed25519`, `p256`, `ml-dsa-44`, `ml-dsa-65` or `ml-dsa-87`. Ed25519 keys are 32 bytes; P-256 keys
are 33-byte SEC1-compressed points; signatures are 64 bytes (Ed25519, and P-256 as `r || s`). ML-DSA is
FIPS 204 in pure mode with an empty context. The claimant signs the challenge **bytes it received**,
never a re-encoding, and the verifier checks those same bytes.

## How `verifyResponse` decides

In this order, and the order is part of the design:

| #   | Check                                                         | Refusal code                                   |
| --- | ------------------------------------------------------------- | ---------------------------------------------- |
| 1   | the response and the challenge inside it decode canonically   | `malformed`, `unknown-algorithm`, `bad-key`, `pq-dangling` |
| 2   | protocol version is 1                                         | `version`                                      |
| 3   | audience is this verifier                                     | `audience`                                     |
| 4   | nonce is at least 16 bytes                                    | `nonce-too-short`                              |
| 5   | `now` is inside the window, with `skewSeconds` of slack at each end | `time-window`                            |
| 6   | the classical signature verifies                              | `bad-signature`                                |
| 7   | the post-quantum **pin** agrees with what the response carries | `pq-key-changed`                              |
| 8   | policy: `pq-required` demands a PQ signature; if one is present it must verify | `pq-required`, `bad-signature`  |
| 9   | the nonce is spent, for exactly these challenge bytes         | `replay`, `unknown-challenge`, `challenge-mismatch` |

Spending the nonce comes last on purpose: a bad proof must not be able to burn somebody else's good
challenge. Anything a peer can send produces a result, never an exception; a failure of our own side (a
store that cannot be reached) rejects the promise, so it cannot be read as either an acceptance or a
failed login.

**The codes are for logs.** An HTTP surface built on this must answer every refusal identically, so a
caller cannot probe which check it failed. The one exception is `store-full`, which `ChallengeIssuer.issue`
throws when too many unexpired challenges are outstanding; answer it with 503 or 429.

## Where this is stricter than the Rust reference

Each of these makes the TypeScript refuse something the Rust crate accepts. None changes what an honest
signer produces, and the reference fixtures still pass byte for byte.

| Difference | Why |
| --- | --- |
| The post-quantum key is **pinned** per fingerprint (`resolvePqPin`) | In the reference, a response carries its own ML-DSA key and nothing ties it to the identity, because the fingerprint hashes the classical key alone. Whoever can forge the classical signature (the exact thing a quantum computer enables, and the reason for the PQ signature) can attach a key pair of their own and satisfy `pq-required`. Only a memory of which PQ key belongs to which fingerprint closes that. |
| The nonce store keeps the **challenge bytes** it issued and refuses a response whose bytes differ | The verifier reads the time window from the response's own timestamps, so something must vouch that they are the ones it issued. |
| The store does not judge time | The verifier does, once, with one skew parameter. (The reference checks again in the store without skew, which cancels half of the tolerance it applied a line earlier.) |
| `respond()` requires the audience the claimant **intends** and refuses any other | The one defence against a relay, where a malicious site hands a user's key a challenge issued for another service. Only the claimant can make this check. |
| Maps are **closed**: unknown members are refused | Two byte strings for one logical message would be two signatures over one meaning. |
| P-256 keys must be **compressed** | One spelling per key means one fingerprint per key. |
| Ed25519: canonical `S`, no small-order key, no small-order `R`, canonical and on-curve `y` | OpenSSL accepts the signature `(R = base point, S = 1)` under the identity key for **every** message, and a small-order-`R` signature under an honest key. Rust's `verify_strict` refuses both; so does this. |
| Hard size limits: challenge 1 KiB, response 16 KiB, dCBOR 64 KiB and depth 16 | The decoder is the first thing an anonymous caller reaches. |
| A signer that advertises a PQ key and then fails to produce a PQ signature **throws** | A silent downgrade to classical-only is the failure to avoid. |

## What the library cannot do for you

- **Persist the pins.** `resolvePqPin` is the whole defence above, and an in-memory `Map` loses it on
  restart. With no pin store every identity is `unpinned` forever, and `pq-required` then only proves that
  _a_ valid ML-DSA signature exists, not whose. Note also what a pin does and does not buy: it protects an
  identity enrolled **before** the attacker can forge classical signatures. A first contact made by a
  quantum attacker is not protected by anything.
- **Share the nonce store between replicas.** `InMemoryNonceStore` is correct for one process. Two API
  replicas need a shared store behind the same `NonceStore` interface (the peer-ask replay cache's
  `claimOnce` is the shape to copy).
- **Know the time.** `now` must come from a clock you trust; keep `skewSeconds` small.
- **Treat P-256 signatures as identifiers.** High-S signatures are accepted, as hardware signers do not
  normalise them, so a P-256 signature is malleable. Identify a response by its challenge nonce.
- **Bind the channel.** `aud` ties a response to a verifier, not to a TLS session.

## Dependencies and runtime

Two direct dependencies, both MIT, both **pinned exactly** in `backend/apps/api/package.json`:

| Package | Version | Used for |
| --- | --- | --- |
| `@noble/post-quantum` | 0.4.1 | ML-DSA (pure JavaScript, so it does not depend on the Node version's OpenSSL) |
| `@noble/hashes` | 1.8.0 | BLAKE3 (the version was already in the lockfile as a transitive dependency) |

Ed25519, P-256 and SHA-256 stay on `node:crypto`. The pins are deliberate. The current majors of both
packages are ESM-only (`"type": "module"`, no CommonJS entry), and this package is CommonJS: its Jest
config transforms only an explicit allow-list of ESM-only packages (`jest.config.mjs`), so moving to the
next major is a change to that list and a runtime check, not a version bump an automated tool should make.
`@noble/post-quantum` 0.4.1 also has a trap: its declared types say
`sign(secretKey, message, random?)` but at run time the third argument is the context, and signing is
**deterministic unless you pass randomness**. [`crypto/mlDsa.ts`](../backend/apps/api/src/domains/identikey/crypto/mlDsa.ts)
wraps it behind a local interface, passes the empty context explicitly and hedges with 32 random bytes
unless a test asks for determinism.

The suite was run on Node 22.23.4, the `.nvmrc` line. The production image's Dockerfile is on Node 26.13.0,
which this change did not exercise.

## Evidence: what was checked, and what was not

Checked:

- The Rust crate's committed fixtures (`challenge.bin`, `response-ed25519.bin`, `response-p256.bin`)
  verify here, and the TypeScript signer rebuilds `response-ed25519.bin` **byte for byte** from its seed.
- ML-DSA-44/65/87 public keys and deterministic signatures are byte-identical to those of a second,
  unrelated implementation (`dilithium-py`, pure-Python FIPS 204), and a hybrid response assembled from the
  Rust Ed25519 signature plus the Python ML-DSA signature passes `pq-required`.
- BLAKE3, base58, the fingerprints and the RFC 8032 vectors are pinned to independent Python outputs.
- A 25-mutant mutation check (a deliberate bug applied one at a time, then the domain's tests run) was
  killed 24 times; the survivor is an equivalent mutant (OpenSSL itself refuses `S >= L`).

**Not** checked:

- ML-DSA against the Rust `fips204` crate. The upstream repository commits no ML-DSA fixture, and building the
  Rust crates to generate one was not done here.
- Anything on a Node other than 22.23.4.
- Any behaviour under load or across more than one process.

[`__tests__/fixtures/README.md`](../backend/apps/api/src/domains/identikey/__tests__/fixtures/README.md) has
the checksums, provenance and the generator script.

## What is not built

| Phase | Scope | Why it is separate |
| --- | --- | --- |
| 2 | Custody and authentication wiring: registering a key with proof of possession, a database nonce store and pin table, a route behind a default-off flag, the IKEYW v2 wallet behind the `Signer` seam | Needs a migration and a decision about who may enrol a key |
| 3 | Capability tokens (Biscuit) for agent and MCP scopes | Needs a Biscuit implementation for Node chosen and tested against Rust-made tokens |
| 4 | Encrypted sharing (`identikey-share` v1) | Needs a proxy re-encryption (Recrypt) implementation or a service boundary |
| 5 | Signed operation log (`identikey-log`) for grants, revocations and audit | Needs tags, negative integers and Gordian Envelope in the codec |

Not planned at all: replacing the existing peer identity or its RFC 9421 profile (which accepts exactly one
signature label, so a second, post-quantum signature cannot simply be added to it).

## Running the tests

```sh
cd backend/apps/api
yarn jest src/domains/identikey
```

No database and no network are needed.
