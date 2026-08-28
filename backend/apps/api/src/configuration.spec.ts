import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import config, { isGeocodingConfigured, resolveGeocodingPortalBaseUrl } from './configuration';

/**
 * Covers the geocoding portalBaseUrl fallback (previously an inline `if` at
 * module-parse time with zero coverage): an explicit GEOCODING_PORTAL_BASE_URL
 * wins, otherwise the box's existing Portal URL (ciPortal.url / CI_CLOUD_URL)
 * is reused so a box that already talks to Portal needs no extra env var.
 */
describe('resolveGeocodingPortalBaseUrl', () => {
  it('keeps an explicitly configured portalBaseUrl as-is', () => {
    expect(resolveGeocodingPortalBaseUrl('https://geocode.example.com', 'https://cloud.example.com')).toBe(
      'https://geocode.example.com',
    );
  });

  it('falls back to ciPortal.url when portalBaseUrl is unset (empty string)', () => {
    expect(resolveGeocodingPortalBaseUrl('', 'https://cloud.example.com')).toBe('https://cloud.example.com');
  });

  it('resolves to an empty string when neither is configured', () => {
    expect(resolveGeocodingPortalBaseUrl('', undefined)).toBe('');
  });

  it('does not fall back when ciPortal.url is undefined but portalBaseUrl is set', () => {
    expect(resolveGeocodingPortalBaseUrl('https://geocode.example.com', undefined)).toBe(
      'https://geocode.example.com',
    );
  });
});

/**
 * A base URL with no device key used to produce zero warnings anywhere except
 * a private, latched, log-only line inside PortalGeocodeProvider — this is
 * the ONE function a boot-time warning, PortalGeocodeProvider's own gate, and
 * a per-place "pending enrichment" signal all share, so they cannot disagree
 * about what "configured" means.
 */
describe('isGeocodingConfigured', () => {
  it('is false for the default (portal) provider with neither a base URL nor a device key', () => {
    expect(
      isGeocodingConfigured({
        geocoding: { provider: 'portal', portalBaseUrl: '' },
        ciPortal: { apiKey: '' },
      }),
    ).toBe(false);
  });

  it('is false for portal with a base URL but no device key — the exact gap that produced zero warnings', () => {
    expect(
      isGeocodingConfigured({
        geocoding: { provider: 'portal', portalBaseUrl: 'https://hub.ci.computer' },
        ciPortal: { apiKey: '' },
      }),
    ).toBe(false);
  });

  it('is false for portal with a device key but no base URL', () => {
    expect(
      isGeocodingConfigured({
        geocoding: { provider: 'portal', portalBaseUrl: '' },
        ciPortal: { apiKey: 'device-key' },
      }),
    ).toBe(false);
  });

  it('is true for portal once both are set', () => {
    expect(
      isGeocodingConfigured({
        geocoding: { provider: 'portal', portalBaseUrl: 'https://hub.ci.computer' },
        ciPortal: { apiKey: 'device-key' },
      }),
    ).toBe(true);
  });

  it('checks apiKey, not the portal fields, when the provider is google', () => {
    expect(
      isGeocodingConfigured({
        geocoding: { provider: 'google', apiKey: '', portalBaseUrl: 'https://hub.ci.computer' },
        ciPortal: { apiKey: 'device-key' },
      }),
    ).toBe(false);
    expect(
      isGeocodingConfigured({
        geocoding: { provider: 'google', apiKey: 'google-key', portalBaseUrl: '' },
        ciPortal: { apiKey: '' },
      }),
    ).toBe(true);
  });
});

/**
 * `scheduled.entity.promotion` gated one cron, `EntityPromotionCron`, whose
 * backing table `ci.promotion_candidates` was dropped by
 * `20260816010000_context_prompts_and_drop_promotion_candidates`. Both are gone.
 *
 * A feature flag lives in three files that have to agree — the default, the
 * env-var mapping and the schema — and only one of the three fails loudly on
 * its own: `booleanStringSchema` carries no default, so a schema entry with
 * nothing behind it is a boot crash. A leftover default or env mapping is
 * silently stripped by zod instead, and survives as a knob that does nothing.
 */
describe('retired feature flags', () => {
  function featureKeysIn(file: string): string[] {
    const contents = JSON.parse(readFileSync(join(__dirname, '..', 'config', file), 'utf8')) as {
      features: Record<string, unknown>;
    };

    return Object.keys(contents.features).sort();
  }

  const resolvedKeys = Object.keys(config.features).sort();

  it('leaves no trace of scheduled.entity.promotion in the resolved config', () => {
    expect(resolvedKeys).not.toContain('scheduled.entity.promotion');
  });

  it('leaves none in the default or the env-var mapping either', () => {
    expect(featureKeysIn('default.json')).not.toContain('scheduled.entity.promotion');
    expect(featureKeysIn('custom-environment-variables.json')).not.toContain('scheduled.entity.promotion');
  });

  it('keeps the three files describing the same set of flags', () => {
    // The stripping is what makes drift invisible, so this holds for every
    // flag rather than only the retired one.
    expect(featureKeysIn('default.json')).toEqual(resolvedKeys);
    expect(featureKeysIn('custom-environment-variables.json')).toEqual(resolvedKeys);
  });
});
