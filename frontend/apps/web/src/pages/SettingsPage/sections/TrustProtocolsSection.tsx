import { useId, useMemo, useState } from 'react';

import { Badge, Button, cn } from '@ci/shadcn';
import { ChevronDown, RefreshCw } from '@ci/shadcn/icons';

import { useFeatures } from '@/common/feature';

import { SettingsGroup, SettingsRow, SettingsSection } from '../kit';

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
  /** Shown as text beside the activation line when the flag must stay off for now. */
  caveat?: string;
}

const UNTIL_SECURITY_REVIEW = 'Leave off until its security review is done';

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
    caveat: UNTIL_SECURITY_REVIEW,
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
    caveat: UNTIL_SECURITY_REVIEW,
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
    caveat: UNTIL_SECURITY_REVIEW,
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
    caveat: UNTIL_SECURITY_REVIEW,
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
    caveat: UNTIL_SECURITY_REVIEW,
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
    caveat: UNTIL_SECURITY_REVIEW,
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

  const rows = useMemo(
    () =>
      TRUST_PROTOCOL_SPECS.map((spec) => ({
        spec,
        enabled: spec.flagKey === null ? true : isFeatureEnabled(spec.flagKey),
      })),
    [isFeatureEnabled],
  );

  const on = rows.filter((row) => row.enabled);
  const off = rows.filter((row) => !row.enabled);

  return (
    <SettingsSection
      title="Trust & protocols"
      description="Identity and protocol standards this Memory server supports."
      help={
        <>
          <p>
            Most of these are provisional and sit behind a server setting. While one is off, its routes answer
            404, so nothing can reach it by accident.
          </p>
          <p>To turn one on, set the variable shown under its Details on the Memory server, then refresh.</p>
        </>
      }
      actions={
        <Button variant="outline" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw aria-hidden="true" />
          Refresh flags
        </Button>
      }
    >
      <SettingsGroup title={`On (${on.length})`}>
        {on.map(({ spec }) => (
          <ProtocolRow key={spec.id} spec={spec} />
        ))}
      </SettingsGroup>

      {off.length > 0 ? (
        <SettingsGroup
          title={`Off (${off.length})`}
          description="Each one answers 404 until its server setting turns it on."
        >
          {off.map(({ spec }) => (
            <ProtocolRow key={spec.id} spec={spec} />
          ))}
        </SettingsGroup>
      ) : null}
    </SettingsSection>
  );
}

/**
 * One standard: its name and the standard it implements, with the technical detail
 * (endpoints, identifier, proof, boundary, how to turn it on) folded under Details.
 * Only the exceptions get a badge: provisional and flag-gated is the usual case.
 */
function ProtocolRow({ spec }: { spec: TrustProtocolSpec }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();

  return (
    <SettingsRow
      label={spec.name}
      hint={spec.standard}
      align="start"
      meta={
        <>
          {spec.maturity === 'Core' ? (
            <Badge variant="outline" className="border-foreground/15 text-xs">
              Always on
            </Badge>
          ) : null}
          {spec.maturity === 'Experimental' ? (
            <Badge variant="outline" className="border-foreground/15 text-xs">
              Experimental
            </Badge>
          ) : null}
          {spec.caveat ? (
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/10 text-xs text-amber-800 dark:text-amber-200"
            >
              Security review pending
            </Badge>
          ) : null}
        </>
      }
      control={
        <Button
          variant="ghost"
          // Chevron only on a phone, so the toggle stays on the row instead of dropping under it.
          className="max-device:size-9 max-device:px-0"
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={`Details for ${spec.name}`}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="max-device:hidden">Details</span>
          <ChevronDown
            aria-hidden="true"
            className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-180')}
          />
        </Button>
      }
    >
      {open ? (
        <dl
          id={detailsId}
          className="grid gap-x-4 gap-y-2 rounded-lg bg-foreground/[0.03] p-3 text-xs sm:grid-cols-[7rem_1fr]"
        >
          <dt className="text-muted-foreground">Endpoints</dt>
          <dd className="font-mono break-all">{spec.surface}</dd>
          <dt className="text-muted-foreground">Identifier</dt>
          <dd>{spec.identifier}</dd>
          <dt className="text-muted-foreground">Proof</dt>
          <dd>{spec.cryptoOrProof}</dd>
          <dt className="text-muted-foreground">Boundary</dt>
          <dd>{spec.securityBoundary}</dd>
          <dt className="text-muted-foreground">{spec.flagKey ? 'Turn on with' : 'Setting'}</dt>
          <dd>
            <span className={spec.flagKey ? 'font-mono break-all' : undefined}>{spec.envVar}</span>
            {spec.caveat ? (
              <span className="mt-1 block font-medium text-amber-700 dark:text-amber-300">{spec.caveat}</span>
            ) : null}
          </dd>
        </dl>
      ) : null}
    </SettingsRow>
  );
}
