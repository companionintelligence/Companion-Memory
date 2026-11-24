import { z } from 'zod/v3';

import type { AcceptanceWindow } from './consumer';
import type { TaskSpecification } from './specs';
import { registryTypeUri } from './typeUri';

/**
 * `trust-task-discovery` — SPEC §10 and the registry entry at `/spec/trust-task-discovery/<version>`.
 *
 * A discoverer asks which Trust Tasks this box acts on and under what window; the answer is a list of
 * BARE Type URIs (each implies both directions of its exchange) and, optionally, the acceptance window.
 * The answer is advisory (§10.4): every later exchange runs the full pipeline again.
 *
 * Four versions are served, each answered in the version it was asked (SPEC 5.2: an implementation at
 * version M.N accepts every M.K with K <= N, and the 0.4 text tells a discoverer it may fall back through
 * 0.3, 0.2 and 0.1). 0.4 adds `expiryHorizonSeconds` to the window; this box states no horizon, because
 * it applies its maximum age whatever `expiresAt` a document carries, so its 0.3 and 0.4 windows are the
 * same value. 0.2 and 0.1 have no window at all, and 0.1 states the framework release as MAJOR.MINOR.
 *
 * ═══ WHO MAY ASK ═══
 *
 * §10.6: a responder that considers its supported-task set sensitive SHOULD authenticate the
 * discoverer first. This box's HTTPS binding admits only linked peers, and the pipeline runs before the
 * handler, so a stranger never reaches this file.
 */

export const DISCOVERY_SLUG = 'trust-task-discovery';

/** The framework release this box implements: the Working Draft whose text this code was written from. */
export const FRAMEWORK_VERSION = '0.7.0';

/** SPEC / the 0.4 entry: "The array is bounded at 16 entries" — parser hardening, not a capability limit. */
export const MAX_DISCOVERY_PATTERNS = 16;

const patternSchema = z.string().min(1).max(128);
export const discoveryRequestSchema = z
  .object({ patterns: z.array(patternSchema).max(MAX_DISCOVERY_PATTERNS).optional() })
  .strict();

const windowSchema = z
  .object({
    maxAgeSeconds: z.number().int().min(1),
    clockSkewSeconds: z.number().int().min(0),
    expiryHorizonSeconds: z.number().int().min(1).optional(),
  })
  .strict();

const supportedTypeSchema = z.union([
  z.string(),
  z
    .object({
      type: z.string(),
      requiredExt: z.array(z.string()).optional(),
      acceptanceWindow: windowSchema.optional(),
    })
    .strict(),
]);

export const discoveryResponseSchema = z
  .object({
    frameworkVersion: z.string().optional(),
    acceptanceWindow: windowSchema.optional(),
    supportedTypes: z.array(supportedTypeSchema),
  })
  .strict();

/** Slug-glob matching (§10.2): `*`, `<prefix>/*`, or an exact slug. Nothing else is interpreted. */
export function matchesPattern(slug: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }

  if (pattern.endsWith('/*')) {
    return slug.startsWith(pattern.slice(0, -1));
  }

  return slug === pattern;
}

/** The bare Type URIs of `specs` whose slug matches any pattern, sorted for deterministic output (0.4 §Conformance). */
export function supportedTypesFor(
  specs: readonly TaskSpecification[],
  patterns: readonly string[] | undefined,
): string[] {
  const effective = patterns === undefined || patterns.length === 0 ? ['*'] : patterns;

  return specs
    .filter((spec) => effective.some((pattern) => matchesPattern(spec.slug, pattern)))
    .map((spec) => spec.typeUri)
    .sort();
}

export type DiscoveryVersion = '0.1' | '0.2' | '0.3' | '0.4';

/** The framework release each served version targets (registry front matter). */
const TARGET_FRAMEWORK: Readonly<Record<DiscoveryVersion, string>> = {
  '0.1': '0.5.0',
  '0.2': '0.6.0',
  '0.3': '0.6.0',
  '0.4': '0.6.0',
};

/**
 * The response `payload` for the version asked. The closed schemas of 0.1 and 0.2 reject an
 * `acceptanceWindow`, so it is simply not sent there.
 */
export function discoveryResponsePayload(params: {
  version: DiscoveryVersion;
  specs: readonly TaskSpecification[];
  patterns: readonly string[] | undefined;
  window: AcceptanceWindow;
}): Record<string, unknown> {
  const { version, specs, patterns, window } = params;

  return {
    // 0.1 can only name a release as MAJOR.MINOR; 0.2 and later carry the full MAJOR.MINOR.PATCH.
    frameworkVersion:
      version === '0.1' ? FRAMEWORK_VERSION.split('.').slice(0, 2).join('.') : FRAMEWORK_VERSION,
    ...(version === '0.3' || version === '0.4'
      ? {
          acceptanceWindow: {
            maxAgeSeconds: window.maxAgeSeconds,
            clockSkewSeconds: window.clockSkewSeconds,
          },
        }
      : {}),
    supportedTypes: supportedTypesFor(specs, patterns),
  };
}

function discoverySpec(version: DiscoveryVersion): TaskSpecification {
  return {
    typeUri: registryTypeUri(DISCOVERY_SLUG, version),
    slug: DISCOVERY_SLUG,
    version,
    title: 'Trust Task Discovery',
    targetFrameworkVersion: TARGET_FRAMEWORK[version],
    status: 'draft',
    parties: { issuer: 'REQUIRED', recipient: 'REQUIRED' },
    bearer: false,
    proof: { request: 'RECOMMENDED', response: 'RECOMMENDED' },
    issuedAt: 'RECOMMENDED',
    sideEffects: {
      level: 'none',
      rationale: 'A read of the list of supported specifications; changes no state.',
    },
    exposure: {
      discloses: 'metadata',
      ingests: 'none',
      actsAsSubject: false,
      rationale:
        'Reveals which Trust Task specifications this box implements, and the acceptance window it applies.',
    },
    retention: { class: 'transient', rationale: 'Needed only to produce the reply.' },
    repeatSafe: true,
    outcome:
      'The discoverer learns which Trust Task specifications this box acts on, and the acceptance window it applies.',
    // The patterns follow the slug-glob grammar of SPEC 10.2 and the list is bounded, so none is free text.
    freeText: [],
    maxDocumentBytes: 16384,
    request: discoveryRequestSchema,
    response: discoveryResponseSchema,
  };
}

/** The discovery specifications this box serves, one record per version. */
export const DISCOVERY_SPECS: readonly TaskSpecification[] = (['0.1', '0.2', '0.3', '0.4'] as const).map(
  discoverySpec,
);
