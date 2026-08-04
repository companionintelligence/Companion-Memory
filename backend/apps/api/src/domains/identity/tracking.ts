/**
 * Tracking-parameter tables for the generic (non-provider) canonicalisation path
 * (design §4.2, steps 7-9).
 *
 * The split between global and host-scoped is load-bearing. `ref` is pure noise
 * on x.com and reddit.com but is genuine identity on plenty of blogs
 * (`?ref=hn`), so it may only ever be dropped per host.
 */

/** Dropped on every host, in addition to anything matching `/^utm_/i`. */
export const GLOBAL_TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'dclid',
  'msclkid',
  'twclid',
  'ttclid',
  'yclid',
  'igshid',
  'igsh',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  'mkt_tok',
  'vero_id',
  'vero_conv',
  'oly_anon_id',
  'oly_enc_id',
  'hsctatracking',
  '__hstc',
  '__hssc',
  '__hsfp',
  's_kwcid',
  'ef_id',
  'sc_cid',
  'ncid',
  'mibextid',
]);

const UTM_PREFIX = /^utm_/i;

/**
 * Dropped only on the listed host (and its subdomains). Keys are compared
 * case-insensitively.
 */
export const HOST_SCOPED_TRACKING: Readonly<Record<string, readonly string[]>> = {
  'x.com': ['ref', 'ref_src', 'ref_url', 's', 't'],
  'reddit.com': ['ref', 'ref_source', 'share_id', 'correlation_id'],
  'linkedin.com': ['source', 'trk', 'trkinfo', 'originalsubdomain'],
  'aliexpress.com': ['spm', 'scm', 'scm_id', 'scm-url'],
  'amazon.com': ['pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pf_rd_p', 'pf_rd_r', 'psc'],
  'youtube.com': ['si', 'pp', 'feature'],
  'open.spotify.com': ['si', 'nd', 'context'],
};

/**
 * Names that carry no meaning when empty, so `?ref=` is noise while `?ref=hn`
 * is identity. Deliberately short — dropping an empty `q=` would change what a
 * search URL means.
 */
export const DROP_IF_EMPTY: ReadonlySet<string> = new Set(['ref', 'source', 'from', 'via']);

/** True when `host` is `suffix` or a subdomain of it. */
function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function hostScopedTrackingParams(host: string): ReadonlySet<string> {
  const collected = new Set<string>();

  for (const [suffix, params] of Object.entries(HOST_SCOPED_TRACKING)) {
    if (hostMatches(host, suffix)) {
      for (const param of params) {
        collected.add(param.toLowerCase());
      }
    }
  }

  return collected;
}

export function isTrackingParam(name: string, value: string, host: string): boolean {
  const lower = name.toLowerCase();

  if (UTM_PREFIX.test(lower) || GLOBAL_TRACKING_PARAMS.has(lower)) {
    return true;
  }

  if (hostScopedTrackingParams(host).has(lower)) {
    return true;
  }

  return value === '' && DROP_IF_EMPTY.has(lower);
}
