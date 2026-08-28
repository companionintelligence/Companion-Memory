/*
 * ############################################################################
 * ##                                                                        ##
 * ##   T H I S   P R I V A T E   K E Y   I S   P U B L I C .                ##
 * ##                                                                        ##
 * ##   It is checked into a public-to-the-org git repository. Every person   ##
 * ##   and every CI job that can read this file holds the signing key. It    ##
 * ##   can therefore mint a token for ANY subject and ANY audience.          ##
 * ##                                                                        ##
 * ##   It exists for exactly one reason: the two-box federation harness      ##
 * ##   (scripts/federation-harness) needs a REPRODUCIBLE OIDC issuer, so     ##
 * ##   that a token minted on Tuesday still verifies against a JWKS served   ##
 * ##   on Wednesday and a demo run is byte-comparable to the last one.       ##
 * ##                                                                        ##
 * ##   NEVER:                                                               ##
 * ##     - add this issuer to a real box's PORTAL_OIDC_ISSUER                ##
 * ##     - serve this JWKS on anything but loopback                          ##
 * ##     - copy this key anywhere that is not this harness                   ##
 * ##                                                                        ##
 * ##   The loadFixtureKey() guard below refuses to hand it out when          ##
 * ##   NODE_ENV=production, which is a tripwire, not a security control.     ##
 * ##   The security control is that this key protects nothing.               ##
 * ##                                                                        ##
 * ############################################################################
 */

/** RS256, 2048-bit. Generated once, 2026-08-20, for this harness alone. */
const FIXTURE_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC9lRfEfqmVP6NQ
eHiCXEvYYnKiTF3il+0x+P5nMA3YGoGT1ac+dInpl0iyB7LjRQLuUbEuI7PPDZfS
pbFKDT5v5dBcH4o032SU3kSzn3AD5W5KeKpMWMZFOaptgjnmB6ybDEyZ853saYEI
cZqHRBdAcFKbX4ywpYK5C6a1UEXVewFcd+Ag+Tup63eJ41tDUWu62QQmF7iOL9Nj
EtL8KGd2Ih2uyPDX4NSTpsgr/QEacA8TVbTl0pF0TY/K47192fk+R4kTenVo6BJB
+H3ZAJNZZWXmU4FGLPg3H9pOSYm69I1mTj/ZmhNCbGlPXkB4o9gLt2TFvheG7qz9
GAiGrd2NAgMBAAECggEAAjPc/elbJt2BftIY06o8Wa7SdkxtASYIOV7TSoIeVbmA
chCsUSyxRyo84Tqh1gOg1CwqouatybT2o68ioexeTRZZBx+jr1e9bKsEwScpT0Dy
DiycN+exIq/tPmP3WxLm6w89Gu3KaCsqoV0728tLT4eZN25oV/YNpdY65oY1+tQI
9x/hebI9wCo41fJdRhh15gqv/MVVyEvyQbP/72ETpW661CX/lUBADX5N6eDpXQOa
s+FXLiywVKCUuXEtJl79a3DQUe9GQ9IyZsmogYQIxJAHF/FfBv5vo+qKFXjLbhLi
tNRYcHmBY+XzDRuc2TorpiJt45Va5J+sJcZmCnozOQKBgQDyZUmwuruPu639OiNu
/MCj0iZLKqMSa7zl7JZLtnJ62S+/A+K6gSdKNRaUbMKp4X2Q13cTtd63HvYu50I4
S2lVxQLhwUaRQC3D3nNxJud/jbjw0vNyiRpaFEmUGbB1Umw34TzdTRxLnJqo2u37
koUA+zR83YI7JS1OwrKdOiYvRQKBgQDIOP2DLNfmdrJeUiXj4j0QsucbOinZ5Tyj
jqntU4wrQhH4YxA3p+SO2rsZ0y3udddTrgc8O8rG3d/gMese3Aqq5M5/kG1CzLOe
f0sfL2F24/pZy80dC4kIUVepPsDXmPtIFTsY7A0UwetSNoUSt2+oT+PBi9xT24b/
4Z6qaLgVqQKBgDaUkhxGX9eEli/v+GyUYzhAKLlCN4f9VIKdXFZeFbcN0o97a4E9
dcBi5du0Bb1E9gY4TirVB/pJ8XssPZ/5cxWKEBUPdTldrzBslagD75qsKdmoVoMS
1ik0akD769zvG0kV4aOfKmDoOXcOHQpJusM2zWHUau+wdlxGwPtgTZrVAoGAcbbU
XHzKfeyp7yHOvTdPoT1KPk9xV3x3TRkIb26E7EiQ9jYlDsb+6xdVLhyfOJCa476y
A0aeKwX2UVlohNVKBbb/hLmdJFQoK3t2SdbaDvD5zagO7VEQ2bWBCPFICuqqxEyy
jLv7ze843C90sqWV98yvuMvbLZE/gfI87+Gbs0kCgYARswC6RU6ZPMoI8naxAJZD
HRQObHN8CxFQLl4tmqtq6zEB0p/9JfnrhRnocemMdl4MSiaVoxZdO84SUTcDQoMi
1kRobmqC5K6jZCHT1SuMR18G+dkS1FpI3OnctPqCGoTXinQD/8V5CEGp4CZdLXff
ywzHqsGF6N3H052kHfm+Pw==
-----END PRIVATE KEY-----`;

const FIXTURE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvZUXxH6plT+jUHh4glxL
2GJyokxd4pftMfj+ZzAN2BqBk9WnPnSJ6ZdIsgey40UC7lGxLiOzzw2X0qWxSg0+
b+XQXB+KNN9klN5Es59wA+VuSniqTFjGRTmqbYI55gesmwxMmfOd7GmBCHGah0QX
QHBSm1+MsKWCuQumtVBF1XsBXHfgIPk7qet3ieNbQ1FrutkEJhe4ji/TYxLS/Chn
diIdrsjw1+DUk6bIK/0BGnAPE1W05dKRdE2PyuO9fdn5PkeJE3p1aOgSQfh92QCT
WWVl5lOBRiz4Nx/aTkmJuvSNZk4/2ZoTQmxpT15AeKPYC7dkxb4Xhu6s/RgIhq3d
jQIDAQAB
-----END PUBLIC KEY-----`;

/**
 * Stable key id. It is baked in rather than derived so the JWKS this harness
 * serves is byte-identical between runs — a changing `kid` invalidates jose's
 * remote-JWKS cache inside a live box and produces an ERR_JWKS_NO_MATCHING_KEY
 * that looks exactly like a misconfigured issuer.
 */
export const FIXTURE_KEY_ID = 'ci-federation-harness-fixture-1';

export interface FixtureKey {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
}

/**
 * Hand out the fixture key.
 *
 * The NODE_ENV guard is a tripwire for the one mistake that would actually
 * matter — a harness module imported into a running appliance — not a claim
 * that the key is protected. It is printed above in full; it protects nothing.
 */
export function loadFixtureKey(): FixtureKey {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'federation-harness: the fixture signing key is test-only and must never load under NODE_ENV=production',
    );
  }

  return {
    privateKeyPem: FIXTURE_PRIVATE_KEY_PEM,
    publicKeyPem: FIXTURE_PUBLIC_KEY_PEM,
    keyId: FIXTURE_KEY_ID,
  };
}
