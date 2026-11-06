# Portable Web Spaces (PWS)

> **Status (2026-11-05): a tested library, not yet a feature.** `backend/apps/api/src/domains/pws/`
> implements the W3C Credentials Community Group's
> [Portable Web Spaces](https://w3c-ccg.github.io/portable-web-spaces-spec/) storage API (draft v0.5,
> formerly Wallet Attached Storage) and its
> [Authorization Profile](https://w3c-ccg.github.io/portable-web-spaces-spec/authz-profile/) (v0.1). It is
> **not** registered with Nest, has **no route** in the API, writes **no database rows** and is imported
> by **nothing else** in `src`. Against the Interop Alliance's conformance suite it passes 203 of 305
> checks (55 fail, 47 are skipped). Every failure traces to a feature that is not built (Encrypted
> Collections, pluggable backends and quotas, export/import, `Ed25519Signature2020`); for 17 of them the
> suite's setup creates an Encrypted Collection first, so the checks never ran. The suite calls that
> `conformant: false`, and so does this document. The reverse direction (this code's client against
> `web-spaces-server`) was **not run**. See [Interoperability evidence](#interoperability-evidence).

## What PWS is, in one paragraph

A permissioned storage API. Data lives in a hierarchy, **Space > Collection > Resource**, each with a URL.
Every Space has a DID **controller** that is the root of trust. Access is private by default, and a
request that lacks privilege for something that exists is answered exactly like a request for something
that does not (`404`), so existence is not leaked (creating a Space at a chosen id is the one accepted
exception, see *Security properties*). Everything else is **capabilities** (zCaps): the controller signs
requests directly, or delegates an attenuated, expiring capability for a URL prefix to someone else, who
proves possession with an HTTP Signature. Data portability is a stated goal of the specification, and a
Space's root of trust is its controller's DID and not a provider's domain. v0.5 does not say how a share
survives a change of provider, though: a capability's target is a full URL including the host.

## Why it sits next to the KERI code and not on top of it

Same reasoning as [`vtc.md`](vtc.md): this service already has a KERI-shaped peer stack that is not
interoperable, and this module must not pretend otherwise.

| | Peer asks (`domains/peers`, `domains/asks`) | PWS (`domains/pws`) |
|---|---|---|
| Question it answers | "Is this the Companion I paired with?" | "May this key act on this Space, and who gave it that right?" |
| Identifier | `did:keri:D<x>`, Companion Memory's **own convention**, not CESR (`peers/sovereignKeyId.ts`) | `did:key` (Ed25519 Multikey); `did:keri` is **refused** |
| Authority | grant rows in the database (consent ladder, ceilings, `revoked_at`) | zCaps: signed, delegatable, attenuated by target, action and `expires` |
| Proof | RFC 9421 HTTP message signature | Cavage draft-12 HTTP Signature + `Digest`, `eddsa-jcs-2022` delegation proofs |
| Revocation | `revoked_at` on the grant | expiry, a key leaving the signer's DID document, and a hook (`isRevoked`); no endpoint yet |
| Interoperable with an outside implementation | No, and says so in its source | Primitives pinned to published vectors; headers, signatures and delegation proofs reproduce the reference stack's byte for byte; 203 of 305 conformance checks pass (see below) |

The Hub froze its in-tree KERI module on 2026-10-30 (`packages/common/src/keri/FROZEN.md` in
Companion-Hub). PWS does not need it, and refusing `did:keri` is not a house rule bolted on: the
specification's Space Controller DID Method Registry makes `did:key` the mandatory floor and says a
server refuses a controller of any method it does not support with `invalid-request-body` (`400`), at
creation and on update. That registry is also the seam where a conformant KERI resolver would plug in
later (`keys.ts`, `DidRegistry`); none exists, and this document does not claim one.

## What is in the module

| File | Does |
|---|---|
| `handler.ts` | `createPwsHandler()`: route, `405`, authenticate, one store transaction per request, headers on every response (`Link: <service>; rel="service"`, CORS, `nosniff`) |
| `authn.ts` | The signature layer: `Authorization: Signature`, covered headers, window, `Digest`, the key's DID document |
| `access.ts` | Capability first, policy second; the container rule |
| `zcap.ts` | Root capability ids, delegation (`delegateCapability`), chain verification, the `Capability-Invocation` header |
| `keys.ts`, `controller.ts` | The DID method registry; which controllers are acceptable |
| `context.ts` | What every operation shares: `HandlerEnv` (the resolved configuration) and `OpContext` (the open transaction, the request, the route, who is asking), with the helpers for JSON bodies, `If-Match` / `If-None-Match` and authorization |
| `opsSpace.ts`, `opsCollection.ts`, `opsResource.ts`, `opsAux.ts` | The operations; policies, linksets, the `501` groups, the service description |
| `routes.ts`, `ids.ts` | URL layout, canonical form (`308`), ids and reserved segments |
| `store.ts`, `models.ts`, `views.ts` | The transactional `PwsStore` seam, an in-memory store, stored records, wire documents |
| `validate.ts`, `indexes.ts`, `conditional.ts`, `pagination.ts`, `problems.ts`, `serviceDescription.ts`, `http.ts` | Body validation, `plaintext.indexes`, `ETag` preconditions, cursors, RFC 9457 errors, the service description |
| `nodeAdapter.ts` | A `node:http` binding (for the conformance run and for tests over a real socket); its own `413` and `500` carry the same headers as every other response |
| `index.ts` | The public barrel: what a wiring step may import |
| `jcs.ts`, `multibase.ts`, `ed25519.ts`, `didKey.ts`, `dataIntegrity.ts`, `digest.ts`, `httpSignature.ts` | The primitives. Each encoding is pinned to a published vector, except `httpSignature.ts`, which is pinned to the layout of the printed example and to the reference libraries' output (below). No new dependency: `node:crypto` and `node:zlib` only |
| `stamp.ts` | The write stamp (a hybrid logical clock; an extension, see decision 9) |
| `scripts/pws-dev-server.ts` | Runs the handler on a port over the in-memory store, on `127.0.0.1` only (`PWS_HOST` overrides). Not imported by `src` |

`yarn jest src/domains/pws` runs 22 suites and 503 tests in a few seconds.

## Using it

```ts
import { MemoryPwsStore, createPwsHandler, nodeListener } from '../domains/pws';

const handler = createPwsHandler({
  baseUrl: 'https://memory.example.com/pws/',   // byte-identical to what clients use
  store: new MemoryPwsStore(),                  // a database-backed PwsStore is the wiring step
});
const response = await handler.handle({ method: 'GET', url: 'https://memory.example.com/pws/service', headers: {} });
// or: http.createServer(nodeListener(handler, { maxBodyBytes: 26 * 1024 * 1024 }))
```

A client, with the same primitives:

```ts
import {
  LocalEd25519Signer, delegateCapability, didKeyFromPublicKey, formatCapabilityInvocation,
  keyIdFromDidKey, publicKeyFromSeed, rootZcapId, signRequest,
} from '../domains/pws';

const seed = crypto.getRandomValues(new Uint8Array(32));
const did = didKeyFromPublicKey(publicKeyFromSeed(seed));
const signer = new LocalEd25519Signer(keyIdFromDidKey(did), seed);

// create a Space this key controls
const url = 'https://memory.example.com/pws/spaces/';
const body = new TextEncoder().encode(JSON.stringify({ id: 'photos', controller: did }));
const headers = await signRequest({
  method: 'POST', url, body, signer,
  headers: { 'content-type': 'application/json' },
  created: Math.floor(Date.now() / 1000),
  capabilityInvocation: formatCapabilityInvocation({ rootId: rootZcapId(url), action: 'POST' }),
});

// let another DID read one Collection until a date: a capability, not a password
const grant = await delegateCapability({
  parent: rootZcapId('https://memory.example.com/pws/space/photos/'),
  signer, controller: appDid,
  invocationTarget: 'https://memory.example.com/pws/space/photos/trip/',
  allowedAction: ['GET'],
  expires: '2026-12-01T00:00:00Z',
  created: new Date().toISOString(),
});
// the app invokes it: formatCapabilityInvocation({ capability: grant, action: 'GET' }), signed with its own key
```

On the wire a request carries, besides the usual headers:

```http
Digest: mh=uEiC...                                          (only with a body; sha2-256 multihash, base64url)
Capability-Invocation: zcap id="urn:zcap:root:https%3A%2F%2Fmemory.example.com%2F...",action="POST"
Authorization: Signature keyId="did:key:z6Mk...#z6Mk...",
  headers="(key-id) (created) (expires) (request-target) host capability-invocation content-type digest",
  signature="<base64>",created="1793880000",expires="1793880600"
```

A delegated capability travels in the same header as `zcap capability="<base64url(gzip(json))>",action="GET"`.

## What it does for each endpoint

| PWS 0.5 | Status |
|---|---|
| Service description at the `service` link on every response | built |
| Resource CRUD, `HEAD`, content types, conditional writes | built |
| List Resources / Collections / Spaces, cursor pagination | built |
| Create and manage Collections (`POST /space/{s}/`, `.../meta`, delete) | built |
| Create and manage Spaces (`POST /spaces/`, `PUT .../meta`, delete) | built |
| Resource Metadata (`.../{r}/meta`) | built |
| Linksets | built |
| `/policy` at Space, Collection and Resource level, `PublicCanRead` | built (the only policy type); a policy has no `ETag`, so `PUT` and `DELETE` ignore preconditions (decision 13) |
| `plaintext.indexes` with `unique` | built for `source: content`; a unique claim over `custom` is refused (`501`) |
| `created-by`, `Writer-Id`, `Key-Epoch` | built |
| Write stamps (`updatedAt`, `updatedAtCounter`, `originId`) on every Metadata object | built; v0.5 has only an optional `updatedAt` on Collection and Resource Metadata, the rest is an extension (decision 9) |
| Backends, quotas, the `changes` feed | not built; `501` for an authorized caller, `404` for a signed stranger or an anonymous read, `401` for a write with no credential (decision 3) |
| `POST .../{c}/query` | no profile is served: `400` if the body has no `profile` string, `501` for any profile, after authorization |
| Export / import (reserved; specified by spec PR #92, not yet merged) | not built; same |
| Chunked Resources, Encrypted Collections (PWS-EC), governing history log, blinded index | not built; an `encryption` member is refused (`400 unsupported-encryption-scheme`) |
| `did:webvh` controllers | not built |
| `Ed25519Signature2020` delegation proofs | not built (only `eddsa-jcs-2022`; the suite tests it anyway and two checks fail) |
| Revocation endpoint | not built (the specification has not defined one); the `isRevoked` hook exists |
| RFC 9421 signatures, `Content-Digest` | not built (the profile still specifies Cavage draft-12 and `Digest`) |
| Multipart form uploads | not built; a `multipart/form-data` write is refused (`501`); other multipart types are stored verbatim like any content type |
| Persistence | not built; an in-memory store behind a transactional interface |

## Decisions the specification leaves open or contradicts

1. **The container rule.** Update of a Space, delete of a Space, and update (including create-by-id `PUT`)
   or delete of a Collection need the root capability the controller invokes directly: a capability for a
   container's URL covers everything beneath it, so its target cannot tell "delete the container" from
   "delete a Resource in it". Creating a Collection with `POST /space/{s}/` stays delegable. Two exceptions
   are honoured. *Delete Space* also accepts a delegated capability whose target is exactly the Space URL
   and whose `allowedAction` is exactly `["DELETE"]`. *Update or create Collection* (`PUT .../meta`) also
   accepts a delegated capability targeting exactly the Space URL, **or exactly the Collection URL**. The
   specification's text allows the Space URL "rather than the Collection container URL, the Collection
   Metadata URL, or a Resource URL", so it excludes the Collection URL by name. The conformance suite and the
   reference server accept it, and this implementation follows them. That widens the controller-only rule:
   the holder of a Collection-scoped write grant can rewrite that Collection's settings. It belongs in the
   Hub security review. The specification links to a section `#the-container-rule` five times, and that
   section does not exist in `spec.md` at 2026-10-30 (it went when the authorization profile was extracted).
2. **Deleting a Space that is absent is `404`, not the specification's idempotent `204`.** There is no
   controller to authorize against. Deleting an absent Collection or Resource, as an authorized caller, is `204`.
3. **A write with no credential at all is `401`, whatever the target.** It is answered before any state is
   read, so it says nothing about what exists, and it carries a `WWW-Authenticate: Signature ...` challenge
   (RFC 9110 requires one). An earlier version answered `404` unless a policy made the target public, which
   made the answer depend on stored state; the conformance suite (`collection.create-unauthorized-401`)
   expects the uniform `401`. A signed caller who lacks privilege still gets the masked `404`, and so does an
   anonymous read. **The text says the opposite:** its Error Handling section says a request that lacks
   privilege "including one that carries no authorization at all" MUST be reported as `404`, and it lists
   `401 missing-authorization` only for Create Space. This code follows the suite and so deviates from a
   normative MUST; a `401` tells an anonymous caller to sign in and nothing about the target. It belongs in
   the Hub security review and in the report to the specification's authors.
4. **What is `400` and what is `404`.** A failure that describes the request (bad or uncovered signature,
   `Digest`, `Host`, time window, unresolvable key) is `400 invalid-authorization-header`. A failure of the
   *capability* (wrong root, target, action, forged, not the controller) is the masked `404`, because it
   depends on server state; so is an expired one, except that its holder is told (decision 12). In Create
   Space, where there is no target to protect, it is `400 controller-mismatch` with a distinct `detail` text
   per cause (five, plus a generic one: rooted elsewhere, expired, proof failed, invoker is not the controller,
   root not this request's).
5. **A policy never makes the policy readable.** Only registered policy types are accepted.
6. **`(key-id)`.** PWS-AUTHZ calls it a draft-cavage-12 pseudo-header; draft 12 does not define it. The
   reference libraries do (`(key-id): <keyId>`), and that is what interoperates, so it is what is built.
7. **Dates.** V8's `Date.parse` rolls `2027-02-30` forward to March 2, so `expires` is read by a strict
   RFC 3339 parser. A test pins it.
8. **Service description URLs** point at the live specification pages, because the frozen `/v0.5/` URL the
   specification's own example uses answers `404`.
9. **Write stamps are an extension.** The reference server puts `updatedAt` (millisecond RFC 3339),
   `updatedAtCounter` and `originId` on every Space, Collection and Resource Metadata object, and the
   conformance suite asserts them on ordinary reads. Spec v0.5 defines only an optional `updatedAt`
   date-time on Collection and Resource Metadata; the counter, `originId`, a Space-level `updatedAt` and the
   millisecond precision are the extension (replication is the open spec PR #93). They are built as a hybrid
   logical clock in `stamp.ts`: strictly increasing even inside one millisecond or across a clock that steps
   back. `originId` names the store (`[A-Za-z0-9_-]{1,64}`, configurable, also advertised in the service
   description). A Resource's content and its user-writable metadata have separate stamps (`meta` in the
   Metadata object, with a `generation`). Clients cannot set them. The clock is in memory, but every write
   first observes the stamp of the version it replaces (`OpContext.stamp(prior)`), so a later write of a
   record sorts after an earlier one even after a restart or from a second handler over the same store. A
   record's *first* stamp is not ordered against other records' stamps across a restart: no high-water mark
   is persisted.
10. **`405` comes before everything that depends on state.** Every endpoint has a method table; a method it
    does not define is `405` with `Allow`, the same for an anonymous caller, a stranger, the controller and a
    Space that does not exist. The retired v0.4 `/space/{s}/collections` redirects `GET`, `HEAD` and `POST` to
    the Space URL (`308`) and refuses every other method, so a `DELETE` there can never delete the Space.
11. **Creating by `PUT` answers with the object.** `PUT .../meta` that creates a Space or Collection is `201`
    with `Location`, `ETag` and the Metadata object, as `POST` does. The specification's example shows only
    the headers, the reference client and the suite read the body. `POST` to a Collection answers
    `{ id, url, "content-type" }`.
12. **An expired capability is named, to the one who holds it.** The spec's registry has no such kind. The
    suite's optional `denial.expired` expects `404` with type `capability-expired`. It is raised last: only
    after the signature, every delegation proof, the target, the action and the invoker's control of the
    capability have checked out, and before any Collection or Resource is looked up. So it tells the grant's
    holder about their own grant and nothing about what is stored beneath the Space: the answer is the same
    whether or not the Collection or the Resource exists. (The Space must exist and still be controlled by
    the DID the chain is rooted in, because the chain is verified against it.) Anyone else, and any other
    defect in the chain, still gets the plain `404`. Revocation stays masked (there is no endpoint to revoke
    through). A capability's `expires` is honoured for the clock-skew allowance after it (300 s by default),
    so the typed answer appears only after that.
13. **Validators and preconditions.** `ETag`, `If-Match` and `If-None-Match` are evaluated on Resource content
    and metadata (a content write moves the Metadata object's `ETag` too; a `/meta` write moves only its own),
    on `PUT .../meta` of a Space or Collection, and on `DELETE` of a Resource, a Collection and a Space. A
    Space's and a Collection's validator is the `ETag` of its `.../meta` object; it moves only when that
    object is written, not when Resources or Collections are added or removed, and the container URLs carry
    no `ETag`. Policy documents have no validator: `PUT` and `DELETE .../policy` ignore both headers (the
    reference server versions policies and answers `412`).
14. **A create-by-id `PUT` at a reserved id is `404`.** The specification lists `reserved-id` (`409`) for it.
    A path beneath a reserved segment is not routed (open spec PR #89 says `404`), and the suite's
    reserved-method checks pass this way.
15. **A request path the URL parser would rewrite is not routed.** `.`, `..`, `%2e`, `\`, tab and newline are
    refused with `404` before routing, and a capability's target is compared with the canonical URL, so
    `.../c1/../c2/x` is never served under a grant for `c1`. (A review found that bypass, and both halves
    have tests.)

## Security properties, and what is not covered

- **Authorize before anything else.** A stranger gets the same `404` where an authorized caller would get
  `409`, `400`, `413` or `501`; for an existing target, conflicts, validation and preconditions are reported
  only after authorization. Creating a Space is the one exception, by `POST /spaces/` or by `PUT /space/{id}/meta`
  at an unused id: nothing is stored yet, so the body's `controller` is what is authorized. Any signed caller
  can learn whether an id is taken (`409 id-conflict` on `POST`; on `PUT`, `404` where it is taken against
  `201` or `400 controller-mismatch` where it is free, and an invalid body is `400` where it is free and `404`
  where it exists), and a probe that succeeds creates the Space. The id is checked before writing, so a
  valid invocation for one's own controller cannot overwrite someone else's Space.
- **Roots are bounded.** A root capability must name a target at or below the Space URL and covering the
  request. A root for the whole origin, another Space, or a deeper URL is refused.
- **Target prefix is a path boundary, on the canonical URL.** A grant for `.../ev` does not reach
  `.../evil`, and a request path the URL parser would rewrite (`.`, `..`, `%2e`, `\`, tab, newline) is not
  routed, so `.../ev/../evil/x` is a `404` and not a read through the grant.
- **A malformed capability is the masked `404`.** Whatever its shape, it is refused the same way for an
  existing and an absent target (a structural fuzz of an embedded capability checks it never reaches a `5xx`).
- **Bounded inputs.** Chain length 10, embedded capability 256 KiB inflated, JSON body 1 MiB, Resource
  25 MiB, signature lifetime 3600 s, clock skew 300 s, page limit 1000. All but the embedded-capability cap
  are `createPwsHandler` options; that cap is the constant `MAX_EMBEDDED_CAPABILITY_BYTES` in `zcap.ts`.
  Header values are bounded only by the transport (Node's default is 16 KiB): cap them at the proxy too.
  Annotation (`custom.tags`) nesting is capped at 8 levels.
- **User content cannot run on the API origin.** Resource responses carry `Content-Security-Policy: sandbox`
  and `X-Content-Type-Options: nosniff` (this costs hosting a web page from a Collection; set
  `resourceContentSecurityPolicy: null` to opt out).
- **Not covered.** Replay inside the signature window: the profile has no nonce, so a captured request can be
  replayed until `expires` plus the clock-skew allowance (300 s by default), and a replayed `POST` creates
  another object. `If-Match` and `If-None-Match` do not prevent it: the signature does not cover them, so a
  replayer can drop them, and `POST` ignores them. Keep `expires` short. `did:key` never rotates, so a stolen
  key cannot be withdrawn, only outlived (short `expires`, then `did:webvh`). One DID reused across Spaces
  links them. Nothing is encrypted: whoever runs the server can read every Resource and all metadata, and
  `createdBy` and `writerId` are plaintext metadata. `generator` is an unverified assertion by the
  controller. The timing of the authorization path was not measured. The whole authorization path runs
  inside the store's single transaction queue, so a DID resolver or an `isRevoked` hook that never settles
  stalls every later request, and the in-memory queue has no timeout: those hooks must not block. The
  in-memory store and its stamp clock are not durable.

## Interoperability evidence

| Claim | Evidence | Tag |
|---|---|---|
| JCS output equals RFC 8785's | §3.2.2 sample, §3.2.3 sorting, all 24 Appendix B numbers in `jcs.spec.ts` | **[V]** |
| Base58btc and base64 are exact | Bitcoin Core `base58_encode_decode.json` (21 rows), RFC 4648 §10 | **[V]** |
| Ed25519 equals RFC 8032's | §7.1 tests 1–3, byte-exact signatures; a malleated `S+L` signature is refused | **[V]** |
| `eddsa-jcs-2022` equals W3C's | vc-di-eddsa Appendix B.3: both hashes and `proofValue` reproduced from the published secret key | **[V]** |
| `did:key` encoding is right | the published key pair and example DID round-trip | **[V]** |
| `Digest: mh=` shape | SHA-256 values from FIPS 180-2; the `uEiC...` prefix in PWS-AUTHZ | **[V]** |
| HTTP-signature layout and the `Capability-Invocation` header | the layout of the worked example printed in PWS-AUTHZ and the reference libraries' output (below). **Not** a published test vector | **[V]** against the reference output |
| The printed worked example in PWS-AUTHZ is a valid signed request | its signature does **not** verify under its own `did:key` (1,727 candidate signing strings tried; a one-off search, the script is not kept), so it pins the grammar and the line layout only | one-off check |
| Planted defects in the tests are detected | 80 planted defects in the authorization, handler, stamp, header-parsing and hardening logic, 78 turned a suite red. A one-off harness kept outside the repository (it rewrites source files in place); each result is an assertion about that behaviour. The two survivors cannot be observed: an update dropping the stored backend (`default` is the only backend) and a prototype-property read in a unique index (equivalent while an index named `__proto__` is refused). 14 of 14 in the primitives, from an earlier run of the same harness | one-off check |
| A request survives a real socket | `nodeAdapter.spec.ts`: create, write, read, head, delete over `node:http`; Host header ignored for routing; oversize body refused | **[V]** |
| The reference stack (`@interop/ezcap`, `http-signature-zcap-invoke`, `zcap`) and this code agree on the wire | `__tests__/referenceVectors.ts`: headers, signing strings, signatures and delegation `proofValue`s the reference libraries produced, reproduced byte for byte here; their signatures and delegation proofs verify under this code's primitives (end-to-end acceptance is what the suite below shows). Generated once from a scratch install outside the repository (Node 24), with the operator's go-ahead | **[V]** |
| The Interop Alliance conformance suite (`@interop/pws-conformance-suite` 0.36.0 with `@interop/pws-client` 0.104.0, 28 suites) against this server | **203 pass, 55 fail, 47 skip of 305; `conformant: false`.** Whole groups pass: conditional requests 18/18, container rule 11/11, policy 9/9, service description 9/9, digest, invocation target, client delegation, write validation, write stamps 6/6 (one skipped), reserved methods 22/22, spaces 33/33, collections 23/23 (one skipped). Every failure traces to a feature this code does not build (table below), and 17 of them never ran (the suite's setup creates an encrypted Collection); every skip is a feature the service description does not advertise, a non-default backend, multipart uploads or a revocation endpoint. The first run found 80 failures. 55 are the unbuilt-feature failures below, and 25 were this code's to fix and are fixed, each with a test: write stamps, the anonymous-write `401`, `405` before authorization, the retired `/collections`, two response bodies, the Space list `name`, the query body check, the typed `capability-expired` | **[V]** for what passes |
| Requests made by this code's own client helpers verify in `web-spaces-server` | not run (it is AGPL-3.0: read for behaviour, never executed or copied here) | **UNKNOWN** |
| Lint and types | `oxlint` 1.90.0 (the repo's pin), `tsc` over the domain, Prettier 3.9.10 (the repo's pin) and `dependency-cruiser` are clean. ESLint was not run (the root install needs a private registry token) | n/a |

## Running the conformance suite (needs a go-ahead: it executes third-party code)

```bash
# 1. the target, from backend/apps/api
yarn node -r @swc/register scripts/pws-dev-server.ts 3002        # http://localhost:3002/

# 2. the suite, from a scratch directory OUTSIDE the repository, pinned and with install scripts off
npm_config_ignore_scripts=true npx @interop/pws-conformance-suite@0.36.0 http://localhost:3002
```

The URL given to the suite must be byte-identical to the one the server serves (`localhost` and
`127.0.0.1` are different servers: capabilities embed their target and it is compared as a string).
The suite needs Node 24 (the reference libraries use it); the dev server runs on the repository's Node.
Run it as `node .../pws-conformance-suite/dist/cli/index.js http://localhost:3002 --reporter json --timeout 20000`.

The known failures, 55 of 305 on the last run (2026-11-06, UTC):

| Group | Fails | Why |
|---|---|---|
| `encryption-descriptor-api` | 21 | Encrypted Collections (PWS-EC) are not built |
| `chunks-api` | 10 | PWS-EC chunks; the suite's setup creates an `encryption: { scheme: "edv" }` Collection |
| `client-backends` | 8 | registering backends is a client API beyond v0.5 (the specification defines only `GET .../backends`) |
| `authz-ordering-api` | 7 | the suite's setup creates an encrypted Collection, so all seven fail before they run. They test authorization ordering, which is built, and did not execute: this repository's own ordering tests (`handler.authz.spec.ts`) cover it instead |
| `client-spaces` | 5 | backends and quotas |
| `delegation-cryptosuites` | 2 | `Ed25519Signature2020` proofs need JSON-LD canonicalization (URDNA2015); the suite runs them although the service description lists only `eddsa-jcs-2022` |
| `client-export-import` | 1 | export/import is not built |
| `plaintext-declaration-api` | 1 | needs an encrypted Collection (`plaintext` and `encryption` together) |

Anything else that fails is a finding, not a known gap. 39 of the 55 (21 + 10 + 7 + 1) need an encrypted
Collection to run at all.

## What this does not decide

- **Where a Companion's controller key comes from.** A Companion's Ed25519 key spells a `did:key`;
  Local.Pub's session wrote `peers/didKeyId.ts` for that mapping (unmerged, not imported here). Key custody
  and how the Hub's signed forward-auth identity (`X-CI-Hub-User-Issuer` with `X-CI-Hub-User-Id`) maps to a
  controller are open. The reserved `X-CI-Hub-User-AID` is never set by the Hub and is only a hint to Memory;
  it must never select a controller.
- **Persistence.** `PwsStore` is the seam; `transaction()` must serialize the read-authorize-write sequence
  (row locks or a serializable transaction).
- **Revocation.** The specification says it is not yet defined. `isRevoked(capabilityId)` is where Memory's
  grant `revoked_at` would plug in.
- **Resolving a DID that needs the network.** `authn.ts` resolves the signer's key before it verifies the
  signature. For `did:key` that costs nothing; for `did:webvh` or anything that fetches it must go through
  the box's hardened egress (no redirects, DNS pinned at connect time, a size cap; Asks ADR-0004) and be
  cached, or an unauthenticated request could make the server fetch.
- **Duplication.** This is another copy of JCS and `eddsa-jcs-2022` (after `domains/vtc` and
  `domains/trust-tasks`), of `did:key` (after `domains/vtc` and `domains/didcomm`) and of base58btc (after all
  three), all on `main` already. Deduplicate them, keeping each copy pinned to the same W3C vector; that is
  deliberately not done here.

## How it is meant to be wired

1. The reverse cross-implementation check (this code's client against `web-spaces-server`), if anyone wants
   it; the forward one is done (the table above). Each specification-versus-suite choice is recorded in
   *Decisions*.
2. A TypeORM `PwsStore` with serializable transactions, Resource bytes in the existing object store, a
   migration, and quotas.
3. A `PwsModule` and controller on the handler (`nodeListener` is the model), registered behind a feature
   flag that defaults off, like `solid.protocol`; Hub security review before any route.
4. Consent grants issued as zCaps and revoked through `isRevoked`.
5. Export and import of a user's data to and from a Space, once the Space Archive Format
   ([spec PR #92](https://github.com/w3c-ccg/portable-web-spaces-spec/pull/92)) settles; `domains/portability`
   is the existing archive code.
6. `did:webvh` controllers (pre-rotation), and a KERI bridge only if ADR-0013 ever ships a conformant resolver.

## References

- [Portable Web Spaces](https://w3c-ccg.github.io/portable-web-spaces-spec/) (draft v0.5), its
  [Authorization Profile](https://w3c-ccg.github.io/portable-web-spaces-spec/authz-profile/) (v0.1) and
  [Encrypted Collections](https://w3c-ccg.github.io/portable-web-spaces-spec/ec/) profile (v0.1); the
  [source repository](https://github.com/w3c-ccg/portable-web-spaces-spec)
- Interop Alliance reference implementation and tests: [pws-conformance-suite](https://github.com/interop-alliance/pws-conformance-suite),
  [web-spaces-server](https://github.com/interop-alliance/web-spaces-server) (AGPL-3.0: read for behaviour, nothing copied)
- ZCAP: [zcap-spec](https://github.com/w3c-ccg/zcap-spec); [HTTP Signatures draft-cavage-12](https://datatracker.ietf.org/doc/html/draft-cavage-http-signatures-12)
- W3C [Data Integrity EdDSA Cryptosuites](https://www.w3.org/TR/vc-di-eddsa/), [did:key](https://w3c-ccg.github.io/did-key-spec/)
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS), [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032) (Ed25519), [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) (problem details)
- ADR-0013, KERI and ToIP, and [ADR-0019](https://github.com/companionintelligence/CI-Engineering/blob/main/adr/0019-portable-web-spaces-alongside-keri.md)
- [`vtc.md`](vtc.md): the sibling module that takes the same stance towards the KERI code
