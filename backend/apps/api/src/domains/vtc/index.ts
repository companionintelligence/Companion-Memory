/**
 * Verifiable Trust Community (VTC) credentials, alongside — not on top of — the KERI code in
 * `domains/peers`.
 *
 * Two trust stacks live in this service and are kept apart on purpose:
 *
 *   - `domains/peers` + `domains/asks`: Companion-to-Companion asks, signed with a key id in
 *     Companion Memory's own `did:keri:D<x>` convention. KERI-shaped, not interoperable.
 *   - this domain: W3C Verifiable Credentials 2.0 with DTG Credentials v1, Data Integrity
 *     `eddsa-jcs-2022` proofs and Bitstring Status Lists, the formats OpenVTC's Verifiable Trust
 *     Infrastructure documents. The canonical JSON, base58, `did:key` and proof code reproduce
 *     published test vectors and the status-list reader expands the specification's own example; the
 *     rest has unit tests only. Nothing has been
 *     run against OpenVTC's software, and the status list its live community serves is refused
 *     today (it carries a proof set and an `encodedList` without the multibase prefix).
 *
 * Nothing here is registered with Nest, exposed over HTTP or written to the database yet. See
 * `docs/vtc.md` for what exists, what does not, and how it is meant to be wired.
 */
export { VtcController } from './VtcController';
export { VtcModule } from './VtcModule';
export * from './auditChain';
export * from './community';
export * from './contexts';
export * from './dataIntegrity';
export * from './dateTime';
export * from './didKey';
export * from './dtgCredential';
export * from './ed25519';
export * from './jcs';
export * from './keyResolver';
export * from './multibase';
export * from './recognition';
export * from './statusList';
