/**
 * Trust Task Type URIs — SPEC §6.1 (Type URI) and §4.4.1 (request / response variants).
 *
 * A Type URI is a NAME. A consumer identifies the specification a document conforms to by comparing
 * `type` with the URIs it supports by exact string equality, fragment included, and nothing in this
 * file dereferences one. Two shapes are accepted, and nothing else:
 *
 *   path form   `<prefix>/spec/<slug>/<MAJOR.MINOR>`
 *   URN form    `urn:<NID>:<prefix>:spec:<slug-segments>:<MAJOR.MINOR>`
 *
 * The public registry form is the path form with the prefix `https://trusttasks.org`.
 *
 * ═══ WHAT IS REFUSED, AND WHY ═══
 *
 * - `http`: every representation at an `http` URI lacks transport integrity, so the spec makes the
 *   scheme non-conformant in every form.
 * - A fragment other than `#request` / `#response`: the two are reserved and no others are defined.
 * - Any URI at the `trusttasks.org` host that is not exactly the registry form. A private
 *   specification may not claim to identify a resource at that domain, which is what keeps a private
 *   URI from ever equalling a registry one. This also catches `/binding/...` and `/ceremony/...`
 *   roots, which have no `/spec/` segment and are therefore not Type URIs at all.
 * - A reserved slug (`trust-task`, `trust-task-*`, `trust-ceremony*`) under any authority but the
 *   registry's: a private specification may not impersonate a framework-defined response type.
 */

/** The public registry origin; the only authority allowed to carry registry slugs. */
export const REGISTRY_ORIGIN = 'https://trusttasks.org';

/** The exact slug that names the framework itself. It alone carries a three-part version. */
export const FRAMEWORK_SLUG = 'trust-task';

const SEGMENT = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
const SLUG_PATTERN = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`);
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const FRAMEWORK_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const RESERVED_SLUG_PATTERN = /^trust-(?:task|ceremony)(?:$|-|\/)/;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

/** A Type URI longer than this is not one worth parsing. */
const MAX_LENGTH = 2048;

export type TypeUriVariant = 'request' | 'response';

export type TypeUriRejection =
  'malformed' | 'scheme' | 'fragment' | 'shape' | 'slug' | 'version' | 'registry-authority' | 'reserved-slug';

export interface ParsedTypeUri {
  /** The URI exactly as given, fragment included: the value compared by exact string equality. */
  readonly raw: string;
  /** The URI without its fragment: the name of one version of one specification. */
  readonly bare: string;
  /** `request` for no fragment or `#request`; `response` for `#response`. */
  readonly variant: TypeUriVariant;
  readonly form: 'path' | 'urn';
  readonly slug: string;
  readonly version: string;
  /** True for `https://trusttasks.org/spec/<slug>/<version>`. */
  readonly registry: boolean;
  /** True when the slug is one the framework reserves for itself. */
  readonly reserved: boolean;
}

export type TypeUriParse =
  | { readonly ok: true; readonly value: ParsedTypeUri }
  | { readonly ok: false; readonly reason: TypeUriRejection };

function fail(reason: TypeUriRejection): TypeUriParse {
  return { ok: false, reason };
}

/** The lower-cased host of a `scheme://authority/...` URI, without userinfo or port. */
function hostOf(bare: string): string | null {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(bare);
  if (match == null) {
    return null;
  }

  const authority = match[1] ?? '';
  const withoutUserinfo = authority.slice(authority.lastIndexOf('@') + 1);

  return withoutUserinfo.replace(/:\d*$/, '').toLowerCase();
}

/** Parse a `type` value. Never throws; a failure names the first rule the value broke. */
export function parseTypeUri(input: unknown): TypeUriParse {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_LENGTH) {
    return fail('malformed');
  }

  // URIs are visible ASCII. Refusing everything else up front means no later step has to reason about
  // whitespace, control characters or look-alike code points.
  if (!VISIBLE_ASCII.test(input)) {
    return fail('malformed');
  }

  const hash = input.indexOf('#');
  const bare = hash === -1 ? input : input.slice(0, hash);
  const fragment = hash === -1 ? '' : input.slice(hash + 1);

  if (hash !== -1 && fragment !== 'request' && fragment !== 'response') {
    return fail('fragment');
  }

  if (bare.includes('?')) {
    return fail('shape');
  }

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(bare);
  if (scheme == null) {
    return fail('scheme');
  }

  const schemeName = (scheme[1] ?? '').toLowerCase();
  if (schemeName === 'http') {
    return fail('scheme');
  }

  let form: 'path' | 'urn';
  let prefix: string;
  let slug: string;
  let version: string;

  if (schemeName === 'urn') {
    form = 'urn';
    const parts = bare.split(':');
    // `urn:<NID>:<prefix...>:spec:<slug-segments...>:<version>` — the slug is everything between the
    // FIRST `:spec:` and the version, and needs at least one segment.
    const specIndex = parts.indexOf('spec', 2);
    if (specIndex === -1 || specIndex > parts.length - 3) {
      return fail('shape');
    }

    prefix = parts.slice(0, specIndex).join(':');
    version = parts[parts.length - 1] ?? '';
    slug = parts.slice(specIndex + 1, -1).join('/');
  } else {
    form = 'path';
    const specIndex = bare.indexOf('/spec/');
    if (specIndex === -1) {
      return fail('shape');
    }

    prefix = bare.slice(0, specIndex);
    const rest = bare.slice(specIndex + '/spec/'.length);
    const lastSlash = rest.lastIndexOf('/');
    if (lastSlash === -1) {
      return fail('shape');
    }

    slug = rest.slice(0, lastSlash);
    version = rest.slice(lastSlash + 1);
  }

  if (!SLUG_PATTERN.test(slug)) {
    return fail('slug');
  }

  const versionPattern = slug === FRAMEWORK_SLUG ? FRAMEWORK_VERSION_PATTERN : VERSION_PATTERN;
  if (!versionPattern.test(version)) {
    return fail('version');
  }

  const registry = form === 'path' && prefix === REGISTRY_ORIGIN;

  // Anything at the registry's host must be exactly the registry form.
  if (!registry && hostOf(bare) === 'trusttasks.org') {
    return fail('registry-authority');
  }

  const reserved = RESERVED_SLUG_PATTERN.test(slug);
  if (reserved && !registry) {
    return fail('reserved-slug');
  }

  return {
    ok: true,
    value: {
      raw: input,
      bare,
      variant: fragment === 'response' ? 'response' : 'request',
      form,
      slug,
      version,
      registry,
      reserved,
    },
  };
}

/** The bare Type URI of a registry specification. */
export function registryTypeUri(slug: string, version: string): string {
  return `${REGISTRY_ORIGIN}/spec/${slug}/${version}`;
}

/** A bare Type URI with the `#response` fragment: the success-response variant of the same task. */
export function responseTypeUri(bare: string): string {
  return `${bare}#response`;
}
