/** The Verifiable Credentials Data Model 2.0 context. Every credential this module reads starts with it. */
export const W3C_CREDENTIALS_V2 = 'https://www.w3.org/ns/credentials/v2';

/**
 * The frozen DTG Credentials v1 context, published by the DTG VSC Predicate Registry
 * (https://github.com/trustoverip/dtgwg-cred-spec). It must be the SECOND context, as an exact
 * string. The pre-v1 `https://firstperson.network/credentials/dtg/v1` is retired and not an alias.
 */
export const DTG_CONTEXT_V1 = 'https://registry.trustoverip.org/dtg/context/v1';
