# IdentiKey: a second way to prove who you are

> **Status: Phase 1 of 5. A library, wired to nothing.** Everything in
> [`domains/identikey/`](../backend/apps/api/src/domains/identikey/) is pure code and tests: no Nest module,
> no route, no configuration key, no feature flag, no table, no migration. Nothing in the running
> application calls it, and merging it changes no behavior. What it gives the next phases is a verifier
> that has been through an independent attack-and-fix review by a second AI agent (see
> [Evidence](#evidence-what-was-checked-and-what-was-not)). No person has reviewed it.
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
which runs it on every test run. `enrolled` is a `Map` here and a table in a real deployment. **Enrollment
is a stand-in**: Phase 2 builds the real step. What matters is where the post-quantum key comes from. It
is recorded at enrollment and never taken from a login (see
[Where a post-quantum pin comes from](#where-a-post-quantum-pin-comes-from)).

```ts
import { randomBytes } from 'node:crypto';
import {
  ChallengeIssuer,
  InMemoryNonceStore,
  SoftwareSigner,
  fingerprintOf,
  respond,
  verifyResponse,
  type PqPin,
} from '../domains/identikey';

const audience = 'papyrus'; // who the verifier is; the claimant signs it too
const now = Math.floor(Date.now() / 1000);
const nonces = new InMemoryNonceStore();
const issuer = new ChallengeIssuer({ audience, ttlSeconds: 120 });
const enrolled = new Map<string, PqPin>();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

const verify = (response: Uint8Array) =>
  verifyResponse(response, {
    audience,
    now,
    skewSeconds: 30,
    policy: 'pq-required',
    nonces,
    // Only an identity enrolled here gets as far as the post-quantum check.
    resolvePqPin: (fingerprint) => enrolled.get(hex(fingerprint)) ?? { kind: 'unknown-identity' },
  });

// The claimant holds an Ed25519 key and an ML-DSA-65 key.
const claimant = SoftwareSigner.fromEd25519Seed(randomBytes(32)).withMlDsa('ml-dsa-65');

// Enrollment (a stand-in for Phase 2): both public keys are recorded together, in one step.
enrolled.set(hex(fingerprintOf(claimant.classicalPublicKey())), {
  kind: 'key',
  publicKey: claimant.pqPublicKey()!,
});

// Verifier issues a challenge; claimant answers it; verifier checks the answer.
const challenge = await issuer.issue(nonces, now);
const response = await respond(claimant, challenge.bytes, { audience });
const result = await verify(response);
// result.ok is true, and result.verified.pqPinned is true.
```

After that, replaying `response` returns `{ ok: false, code: 'replay' }`. A response with the same Ed25519
key and a different ML-DSA key returns `{ ok: false, code: 'pq-key-changed' }`. A stranger who was never
enrolled returns `{ ok: false, code: 'unknown-identity' }`, before any post-quantum work is done for them.
All three are asserted in the test.

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

In this order, and the order is part of the design. It is a **cost** order: each check is dearer than the
ones before it, and a caller reaches a dear check only by having passed the cheap ones. A caller with no
account has a throwaway key pair and signs anything with it, so a valid signature says nothing about
_them_. What does is that this verifier issued the challenge, and the order is built around that.

| #   | Check                                                                                                                                         | Refusal code                                                | Cost                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------ |
| 1   | the response and the challenge inside it decode canonically, within an item budget                                                            | `malformed`, `unknown-algorithm`, `bad-key`, `pq-dangling`  | about 0.1 to 0.2 ms (the key's test) |
| 2   | protocol version is 1                                                                                                                         | `version`                                                   | arithmetic                           |
| 3   | audience is this verifier                                                                                                                     | `audience`                                                  | arithmetic                           |
| 4   | nonce is at least 16 bytes                                                                                                                    | `nonce-too-short`                                           | arithmetic                           |
| 5   | `now` is inside the window, with `skewSeconds` of slack at each end                                                                           | `time-window`                                               | arithmetic                           |
| 6   | **claim an attempt**: this verifier issued exactly these challenge bytes, the nonce is unspent, and the challenge has an attempt left (three) | `unknown-challenge`, `challenge-mismatch`, `replay`, `attempts-exceeded` | one lookup               |
| 7   | the classical signature verifies                                                                                                              | `bad-signature`                                             | a fraction of a millisecond          |
| 8   | the pin lookup knows this identity                                                                                                            | `unknown-identity`                                          | the caller's database read           |
| 9   | the post-quantum **pin** agrees with what the response carries                                                                                | `pq-key-changed`                                            | comparison                           |
| 10  | policy: `pq-required` demands a PQ signature; if one is present it must verify                                                                | `pq-required`, `bad-signature`                              | milliseconds (ML-DSA)                |
| 11  | the nonce is spent, for exactly these challenge bytes                                                                                         | `replay`, `unknown-challenge`, `challenge-mismatch`         | one lookup                           |

Two different things happen to the nonce. At step 6 the verifier **claims an attempt**: an atomic count,
made before any signature is checked and whatever the response turns out to say. A challenge allows three
(`maxAttempts`, 1 to 10), so one live challenge, which any anonymous caller can obtain, buys three tries
and no more, and a burst of simultaneous responses cannot exceed that either. At step 11 the verifier
**spends** the nonce, only after every check has passed, so a bad proof cannot burn somebody else's good
challenge. Challenge bytes that differ from the ones issued are not an attempt at this challenge and are
not counted, so someone who has seen a nonce cannot use changed bytes to use up the genuine claimant's
attempts. Someone who can see the challenge itself can send three wrong answers; they could equally have
dropped the traffic. The claimant asks for a new challenge.

Anything a peer can send produces a result, never an exception. A failure of our own side rejects the
promise instead: a store that cannot be reached, and also a store or callback that answers outside its type
(an untyped database row that resolves `undefined`, a pin of an unknown `kind`, a policy that is neither
known string). A surprise is never read as a yes. The call rejects and the challenge is not spent.

**The codes are for logs.** An HTTP surface built on this must answer every refusal identically, so a
caller cannot probe which check it failed. The one exception is `store-full`, which `ChallengeIssuer.issue`
throws when too many unexpired challenges are outstanding; answer it with 503 or 429.

## Where a post-quantum pin comes from

**Not from a login.** The classical signature covers the challenge and nothing else, so it does not cover
the response's post-quantum key. Anyone who can _alter_ one response, with no cryptanalysis at all, keeps
the owner's classical key and signature and attaches a key pair of their own, and `pq-required` passes
with _their_ key. A verifier that recorded "the post-quantum key from the first good login" would record
theirs, lock the real owner out with `pq-key-changed` on every later login, and leave the attacker's key
as the one a later forger of classical signatures needs. A test in
[`verify.spec.ts`](../backend/apps/api/src/domains/identikey/identity/verify.spec.ts) runs exactly that to
its end.

A pin is recorded at **enrollment**: one step, over a channel the verifier already trusts, in which both
keys sign one message that names both public keys. That binds the two keys to each other, which a login
cannot. Phase 2 builds the step and has to decide who may enroll (see the ADR). Until then:

- treat `Verified.pqPinned === false` as "the post-quantum signature proves possession of _a_ key, not
  that it is this identity's";
- never turn an `unpinned` login's `pqPublicKey` into a pin.

What enrollment does **not** do: if the first contact is made by someone who can already forge the
classical signature, they enroll their own post-quantum key under the victim's classical key, and both
signatures on the enrollment message verify. A pin protects an identity enrolled **before** an attacker
could forge classical signatures. Against a first contact by one, no signature helps, and only how the
verifier authorizes new enrollments can. (Binding both public keys into the _login_ signature would close
the in-flight splice too, but it changes the signed payload, so it would no longer interoperate with the
Rust reference.)

## Where this is stricter than the Rust reference

Each of these makes the TypeScript refuse something the Rust crate accepts, or do its work in a cheaper
order. None changes what an honest signer produces, and the reference fixtures still pass byte for byte.

| Difference | Why |
| --- | --- |
| The nonce is checked **before any signature**, and a challenge allows **three attempts** | The spec (section 7, step 3) puts "issued and unused" before signature verification. The Rust crate verifies both signatures first, spends the nonce last, and counts no attempts. Built that way, a response carrying a throwaway key and a challenge the verifier never issued costs up to milliseconds of ML-DSA and a pin-store read, and one live challenge, which any anonymous caller can obtain, buys unlimited rounds of the same. |
| The post-quantum key is **pinned** per fingerprint (`resolvePqPin`), and the pin must come from **enrollment** | In the reference, a response carries its own ML-DSA key and nothing ties it to the identity, because the fingerprint hashes the classical key alone and the classical signature does not cover the post-quantum members. Whoever can alter one response, or forge the classical signature (what a quantum computer enables, and the reason for the PQ signature), can attach a key pair of their own and satisfy `pq-required`. Only a memory of which PQ key belongs to which fingerprint closes that, and only if the memory was not itself taken from a response ([details](#where-a-post-quantum-pin-comes-from)). |
| A pin lookup can answer `unknown-identity`, which ends the check before any post-quantum work | Only an enrolled identity is put through the dearest check. |
| The nonce store keeps the **challenge bytes** it issued and refuses a response whose bytes differ | The verifier reads the time window from the response's own timestamps, so something must vouch that they are the ones it issued. |
| The store does not judge time | The verifier does, once, with one skew parameter. (The reference checks again in the store without skew, which cancels half of the tolerance it applied a line earlier.) |
| `respond()` requires the audience the claimant **intends** and refuses any other | The one defense against a relay, where a malicious site hands a user's key a challenge issued for another service. Only the claimant can make this check. |
| Maps are **closed**: unknown members are refused | Two byte strings for one logical message would be two signatures over one meaning. |
| P-256 keys must be **compressed** | One spelling per key means one fingerprint per key. |
| Ed25519: canonical `S`, no small-order key, no small-order `R`, canonical and on-curve `y` | OpenSSL accepts the signature `(R = base point, S = 1)` under the identity key for **every** message, and a small-order-`R` signature under an honest key. Rust's `verify_strict` refuses both; so does this. |
| Hard size limits (challenge 1 KiB, response 16 KiB, dCBOR 64 KiB, depth 16) **and an item budget** (challenge 16 values and keys, response 40, anything else 4096) | The decoder is the first thing an anonymous caller reaches, and bytes alone do not bound its work: every element is a byte and an allocation. A legitimate challenge is 11 items and the largest legitimate response 27. |
| Anything outside a store's or callback's contract **rejects the call** | A `switch` with no default reads a surprise as success. Every one here ends in a rejection. |
| A signer that advertises a PQ key and then fails to produce a PQ signature **throws** | A silent downgrade to classical-only is the failure to avoid. |

## What the library cannot do for you

- **Persist the pins, and record them at enrollment.** `resolvePqPin` is the defense against a swapped
  post-quantum key, and an in-memory `Map` loses it on restart. With no pin store every identity is
  `unpinned` forever, and `pq-required` then only proves that _a_ valid ML-DSA signature exists, not whose
  (`Verified.pqPinned` says so). A pin comes from [enrollment, never from a login](#where-a-post-quantum-pin-comes-from).
  It protects an identity enrolled **before** an attacker could forge classical signatures. It does not
  protect a first contact made by one.
- **Rate-limit issuing.** `issue` is unauthenticated by necessity, because the claimant has no credential
  yet, and each challenge holds a slot for its lifetime plus 60 seconds whether or not anyone answers it.
  One client that issues about 56 challenges a second at the 120-second default (about 3 a second at the
  3600-second maximum) holds all 10 000 slots, and `issue` then throws `store-full` for everyone. A refused
  `issue` is cheap (about 0.2 ms), so a full store is a lockout and not an amplifier, but it is a lockout.
  Rate-limit per client in front of `issue`, keep `ttlSeconds` short, and size `maxEntries` for it. A
  shared store needs the same limit.
- **Share the nonce store between replicas.** `InMemoryNonceStore` is correct for one process. Two API
  replicas need a shared store behind the same `NonceStore` interface (the peer-ask replay cache's
  `claimOnce` is the shape to copy), and its `beginAttempt` must be a single atomic test-and-increment.
- **Know the time.** `now` must come from a clock you trust; keep `skewSeconds` small.
- **Treat P-256 signatures as identifiers.** High-S signatures are accepted, as hardware signers do not
  normalize them, so a P-256 signature is malleable. Identify a response by its challenge nonce.
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

The suite was run on Node 22.23.4. The repository's `.nvmrc` says 22.15.1 and the production image's
Dockerfile is on Node 26.13.0; this change was run on neither. ML-DSA and BLAKE3 are pure JavaScript, so
they do not depend on the Node version's OpenSSL, but Ed25519, P-256 and SHA-256 do use `node:crypto`, and
a different Node is where a difference would show. Run the suite on the Dockerfile's version before
relying on this.

## What a caller with no valid challenge costs

Measured in the sandbox this was built in (Node 22.23.4, one core of a shared cloud container, so noisy):
read it as a ratio, not as capacity. A response to a challenge this verifier never issued now costs the
decode and one lookup, **about 0.2 to 0.3 ms for Ed25519 and 0.1 ms for P-256, whether or not there is an
ML-DSA half**. That is about what a response for the wrong audience costs (0.2 ms). Before the checks were
reordered, the independent reviewer measured 0.66 ms for the same response with only an Ed25519 signature,
and 2.7, 4.0 and 6.0 ms with ML-DSA-44, -65 and -87, each plus one pin-store read. A hostile 16 KiB body
that is nothing but values is now refused in 30 to 40 microseconds (it was 4.3 to 5.4 ms). What remains is
mostly the Ed25519 key's on-curve test (about 0.16 ms), which stays in decoding on purpose: it keeps every
key value in the library one that is already known to be usable. Rate-limit the endpoint anyway.

## Evidence: what was checked, and what was not

Checked:

- The Rust crate's committed fixtures (`challenge.bin`, `response-ed25519.bin`, `response-p256.bin`)
  verify here, and the TypeScript signer rebuilds `response-ed25519.bin` **byte for byte** from its seed.
- ML-DSA-44/65/87 public keys and deterministic signatures are byte-identical to those of a second,
  unrelated implementation (`dilithium-py`, pure-Python FIPS 204), and a hybrid response assembled from the
  Rust Ed25519 signature plus the Python ML-DSA signature passes `pq-required`.
- BLAKE3, base58, the fingerprints and the RFC 8032 vectors are pinned to independent Python outputs.
- A 25-mutant mutation check (a deliberate bug applied one at a time, then the domain's tests run) was
  killed 24 times; the survivor is an equivalent mutant (OpenSSL itself refuses `S >= L`). **It ran before
  the review changes below and has not been re-run on the changed verifier.**
- **An independent review, by a second AI agent** that was given the code and told to attack it. It was not
  a person. It reported four findings, and each was reproduced here as a failing test before anything was
  changed:

  | Finding (the reviewer's rating) | What changed |
  | --- | --- |
  | Anonymous CPU and database amplification: signatures and the pin read ran before the nonce check, one live challenge allowed unlimited failing attempts, and the decoder had no work budget (medium) | The nonce is claimed before any signature; three attempts per challenge; `unknown-identity` ends the check before post-quantum work; an item budget in the decoder. The key's on-curve test still runs in decoding. |
  | `verifyResponse` failed open outside its contract: a store resolving an unlisted value, an unknown pin kind, or a misspelled policy was read as success or as a weaker policy (medium, latent) | Every `switch` ends in a rejection; the policy and audience are validated; a pin lookup must return an object. |
  | A post-quantum key can be spliced into a first-contact response by anyone who can alter it, and the guide's example would have pinned it. This guide had framed the gap as quantum-only (low, design) | The guide and example changed: a pin comes from enrollment, never a login. `Verified.pqPinned` reports whether the key matched one. The splice itself is still accepted when nothing is enrolled, because a login cannot prevent it ([details](#where-a-post-quantum-pin-comes-from)). |
  | One anonymous client can deny issuance to everyone by filling the store (low, availability) | Documented under [what the library cannot do](#what-the-library-cannot-do-for-you): a rate limit in front of `issue` is required. No code change. |

  The review also corrected this guide's statement of the `.nvmrc` Node version (above). It reported
  differential runs against independent implementations with no disagreements: the dCBOR decoder against a
  Python oracle on 250 000 inputs, Ed25519 verification against an independent RFC 8032 verifier on 1 432
  vectors (raw OpenSSL accepted 47 that this library refuses), P-256 key validity on 922 keys, and base58
  and base64. Those harnesses are the reviewer's and are not committed, and I did not re-run them.

**Not** checked:

- ML-DSA against the Rust `fips204` crate. The upstream repository commits no ML-DSA fixture, and building the
  Rust crates to generate one was not done here.
- Anything on a Node other than 22.23.4, including the Dockerfile's 26.13.0.
- Any behavior under load or across more than one process.
- Any review by a person.

[`__tests__/fixtures/README.md`](../backend/apps/api/src/domains/identikey/__tests__/fixtures/README.md) has
the checksums, provenance and the generator script.

## What is not built

| Phase | Scope | Why it is separate |
| --- | --- | --- |
| 2 | Custody and authentication wiring: **enrollment** (registering a key and its post-quantum key in one step, both signing a message that names both, the only place a pin may come from), a database nonce store and pin table, a route behind a default-off flag, rate limiting of `issue`, the IKEYW v2 wallet behind the `Signer` seam | Needs a migration and a decision about who may enroll a key |
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
