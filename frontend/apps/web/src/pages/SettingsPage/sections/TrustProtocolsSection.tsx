import { useMemo, useState } from 'react';

import { Badge, Button, Card, Input } from '@ci/shadcn';
import { RefreshCw, ShieldCheck, ShieldOff } from '@ci/shadcn/icons';

import { useFeatures } from '@/common/feature';

type FilterMode = 'all' | 'enabled' | 'disabled';

export interface TrustProtocolSpec {
  id: string;
  name: string;
  standard: string;
  flagKey: string | null;
  envVar: string;
  surface: string;
  identifier: string;
  cryptoOrProof: string;
  maturity: 'Core' | 'Provisional (Flag-gated)' | 'Experimental';
  securityBoundary: string;
}

/**
 * Canonical inventory of identity, decentralized trust, verifiable credential,
 * and provisional AI interoperability standards implemented in CI-Memory.
 *
 * Provisional protocols stay strictly behind server feature flags and fail closed
 * with HTTP 404 when disabled; this panel reads `/api/_internal/features` via
 * `useFeatures()` and never probes disabled routes.
 */
export const TRUST_PROTOCOL_SPECS: readonly TrustProtocolSpec[] = [
  {
    id: 'asks',
    name: 'Companion Asks & Delegated Consent',
    standard: 'RFC 9421 + ISO/IEC TS 27560 + DPV v2 + CESR SAID',
    flagKey: 'ask',
    envVar: 'ENABLE_ASK=true',
    surface: 'POST /agent/v1/ask, GraphQL ask* / askDisclosureHistory / askAuditReceipt',
    identifier: 'Account ID / did:keri:D… key id',
    cryptoOrProof: 'RFC 9421 Ed25519 signatures + CESR I-SAID',
    maturity: 'Provisional (Flag-gated)',
    securityBoundary: 'Fail-closed responder scoping + standing grant ceilings',
  },
  {
    id: 'solid',
    name: 'Solid Protocol & WebID Pod Facade',
    standard: 'W3C Solid Protocol / LDP 1.0 (Turtle, JSON-LD, OPTIONS)',
    flagKey: 'solid.protocol',
    envVar: 'ENABLE_SOLID_PROTOCOL=true',
    surface: 'GET/OPTIONS /solid/profile/:userId, /solid/storage/:userId/entity*',
    identifier: 'WebID URI (#me)',
    cryptoOrProof: 'OIDC + WAC-lite owner isolation (Vary/Allow/Link/WAC-Allow)',
    maturity: 'Provisional (Flag-gated)',
    securityBoundary: 'Unauthenticated public WebID; owner-only storage (404 on mismatch)',
  },
  {
    id: 'vtc',
    name: 'Verifiable Trust Community (OpenVTC)',
    standard: 'W3C VC DM 2.0 + ToIP DTG v1 + Bitstring Status List 1.0',
    flagKey: 'vtc.credentials',
    envVar: 'ENABLE_VTC_CREDENTIALS=true',
    surface: 'POST /vtc/verify, POST /vtc/status-list/evaluate',
    identifier: 'did:key (offline) / pinned community DID',
    cryptoOrProof: 'eddsa-jcs-2022 Data Integrity Proof',
    maturity: 'Provisional (Flag-gated)',
    securityBoundary: 'Strictly offline verification; refuses did:keri & remote fetches',
  },
  {
    id: 'didcomm',
    name: 'DIDComm Messaging v2.1',
    standard: 'DIF DIDComm v2.1 + OOB 2.0 + Trust Ping + Discover Features',
    flagKey: 'didcomm.messaging',
    envVar: 'ENABLE_DIDCOMM_MESSAGING=true',
    surface: 'GET /didcomm/did, POST /didcomm/oob, POST /didcomm/oob/parse, POST /didcomm/message',
    identifier: 'did:peer:2 / did:key / did:web',
    cryptoOrProof: 'ECDH-1PU Authcrypt / ECDH-ES Anoncrypt + JWS',
    maturity: 'Provisional (Flag-gated)',
    securityBoundary: 'Replay guard + refuses _oobid remote URLs & did:keri',
  },
  {
    id: 'trust-tasks',
    name: 'Trust Tasks HTTPS 0.3',
    standard: 'Trust Tasks Draft HTTPS 0.3 + eddsa-jcs-2022 envelopes',
    flagKey: 'trust.tasks',
    envVar: 'ENABLE_TRUST_TASKS=true',
    surface: 'POST /agent/v1/trust-tasks',
    identifier: 'Linked Peer DID / Task signer key',
    cryptoOrProof: 'eddsa-jcs-2022 signed task envelopes & state transitions',
    maturity: 'Provisional (Flag-gated)',
    securityBoundary: 'Fail-closed 404 when flag disabled; bounded task payloads',
  },
  {
    id: 'pws',
    name: 'Portable Web Spaces (PWS)',
    standard: 'W3C CCG Portable Web Spaces v0.5 (Space / Collection / Resource)',
    flagKey: 'pws.storage',
    envVar: 'ENABLE_PWS_STORAGE=true',
    surface: 'ALL /pws/*, GET /pws/service',
    identifier: 'Controller DID (did:key)',
    cryptoOrProof: 'Ed25519 zCap delegations + HTTP Signatures + Digest',
    maturity: 'Provisional (Flag-gated)',
    securityBoundary: 'Fail-closed 404 on unauthorized or disabled routes; controller-scoped ACL',
  },
  {
    id: 'identikey',
    name: 'IdentiKey Post-Quantum Challenge Auth',
    standard: 'IdentiKey identikey-auth Phase 1 (dCBOR + BLAKE3)',
    flagKey: 'auth.identikey',
    envVar: 'ENABLE_AUTH_IDENTIKEY=true',
    surface: 'POST /auth/identikey/challenge, POST /auth/identikey/verify',
    identifier: 'BLAKE3 Base58 fingerprint',
    cryptoOrProof: 'Ed25519 / P-256 + ML-DSA hybrid signatures (single-use nonce)',
    maturity: 'Experimental',
    securityBoundary: 'Disabled by default (404); Host-validated audience + in-memory nonce store',
  },
  {
    id: 'mcp-prm',
    name: 'MCP Protected Resource Metadata (PRM)',
    standard: 'RFC 9728 OAuth Protected Resource Metadata + CIMD',
    flagKey: 'mcp.prm',
    envVar: 'ENABLE_MCP_PRM=true',
    surface: 'GET /.well-known/oauth-protected-resource(/mcp)',
    identifier: 'OAuth Resource Server URL (/mcp)',
    cryptoOrProof: 'OAuth 2.1 Bearer + Client ID Metadata Document (DCR disabled)',
    maturity: 'Provisional (Flag-gated)',
    securityBoundary: 'Advertises auth server metadata only when mcp.prm is enabled',
  },
  {
    id: 'capability-keys',
    name: 'Capability Attenuated API Keys & Field Crypto',
    standard: 'Biscuit-style Ed25519 caveats + AES-256-GCM at rest',
    flagKey: null,
    envVar: 'Always enabled (core)',
    surface: 'POST /keys, GET /keys, GET /keys/check',
    identifier: 'Scoped API key prefix + monotonic caveat capabilities',
    cryptoOrProof: 'Argon2/HMAC key hash + AES-256-GCM field cipher',
    maturity: 'Core',
    securityBoundary: 'Deny-by-default scope checks; non-escalatable capabilities',
  },
];

export function TrustProtocolsSection() {
  const { isFeatureEnabled, loading, refresh } = useFeatures();
  const [filter, setFilter] = useState<FilterMode>('all');
  const [query, setQuery] = useState('');

  const rows = useMemo(
    () =>
      TRUST_PROTOCOL_SPECS.map((spec) => ({
        spec,
        enabled: spec.flagKey === null ? true : isFeatureEnabled(spec.flagKey),
      })),
    [isFeatureEnabled],
  );

  const enabledCount = rows.filter((r) => r.enabled).length;
  const disabledCount = rows.length - enabledCount;

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();

    return rows.filter(({ spec, enabled }) => {
      if (filter === 'enabled' && !enabled) {
        return false;
      }

      if (filter === 'disabled' && enabled) {
        return false;
      }

      if (!q) {
        return true;
      }

      return [spec.name, spec.standard, spec.flagKey ?? 'core', spec.surface, spec.cryptoOrProof]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [filter, query, rows]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Trust, Identity &amp; Protocol Standards</h2>
          <p className="text-muted-foreground text-sm">
            Runtime feature-flag status and cryptographic comparison across CI-Memory protocol facades.
            Disabled provisional routes fail closed with HTTP 404.
          </p>
        </div>

        <Button size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />
          Refresh flags
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter protocol status">
          <Button
            size="sm"
            variant={filter === 'all' ? 'default' : 'outline'}
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All ({rows.length})
          </Button>
          <Button
            size="sm"
            variant={filter === 'enabled' ? 'default' : 'outline'}
            aria-pressed={filter === 'enabled'}
            onClick={() => setFilter('enabled')}
          >
            Active ({enabledCount})
          </Button>
          <Button
            size="sm"
            variant={filter === 'disabled' ? 'default' : 'outline'}
            aria-pressed={filter === 'disabled'}
            onClick={() => setFilter('disabled')}
          >
            Fail-closed 404 ({disabledCount})
          </Button>
        </div>

        <Input
          aria-label="Filter protocols"
          className="w-full sm:w-64"
          placeholder="Search standard, flag, or endpoint…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-3">
        {visibleRows.length === 0 ? (
          <Card className="p-4 text-sm text-muted-foreground">No standards match the current filter.</Card>
        ) : (
          visibleRows.map(({ spec, enabled }) => (
            <Card key={spec.id} className="flex flex-col gap-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {enabled ? (
                    <ShieldCheck
                      className="size-4 text-emerald-600 dark:text-emerald-400"
                      aria-hidden="true"
                    />
                  ) : (
                    <ShieldOff className="size-4 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className="font-medium">{spec.name}</span>
                  <Badge variant="outline">{spec.maturity}</Badge>
                </div>

                {/* WCAG 1.4.1: text states the state explicitly rather than relying on color alone */}
                <Badge variant={enabled ? 'default' : 'secondary'}>
                  {enabled ? 'Active' : 'Disabled (404 fail-closed)'}
                </Badge>
              </div>

              <p className="text-muted-foreground text-xs">{spec.standard}</p>

              <dl className="grid gap-2 pt-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground font-medium">Surface / Endpoint</dt>
                  <dd className="font-mono break-all">{spec.surface}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground font-medium">Identifier &amp; Proof</dt>
                  <dd>
                    {spec.identifier} · {spec.cryptoOrProof}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground font-medium">Flag / Activation</dt>
                  <dd className="font-mono break-all">
                    {spec.flagKey ? `${spec.flagKey} (${spec.envVar})` : spec.envVar}
                  </dd>
                </div>
              </dl>

              <p className="text-muted-foreground border-t pt-2 text-xs">
                <span className="font-medium">Boundary:</span> {spec.securityBoundary}
              </p>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
