/**
 * Payload scrubbers for every Sentry hook: `beforeSend` (errors),
 * `beforeSendTransaction`, `beforeSendSpan`, `beforeSendLog` and
 * `beforeBreadcrumb`.
 *
 * CI-Server holds the user's entire digital life, so anything on its way to
 * Sentry is treated as hostile until proven otherwise: credentials are
 * redacted, home directories are collapsed to `~` (they leak account names),
 * and oversized strings are truncated so a stray blob can't smuggle memory
 * contents out inside an exception message.
 *
 * Ported from CI-Hub's `sentry-scrubber.ts` (PR #697) so the two appliance
 * halves redact identically.
 */

import type { Breadcrumb, ErrorEvent, Log, NodeOptions } from '@sentry/nestjs';

// @sentry/nestjs does not re-export these two, and @sentry/core is not a
// dependency of this workspace, so take them from the hook signatures.
type TransactionEvent = Parameters<NonNullable<NodeOptions['beforeSendTransaction']>>[0];
type SpanJSON = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];
type RequestData = NonNullable<ErrorEvent['request']>;

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:api[-_ ]?key|token|password|secret|jwt|auth)[\s=:"']+[^\s"',}\]]+/gi,
  /tskey-[A-Za-z0-9-]+/gi,
  // Postgres/Redis/AMQP URLs carry credentials in the authority section.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
];

// Windows first: the macOS pattern also matches the `/Users/<name>` inside
// `C:/Users/<name>`, and replacing that leaves a stranded `C:~/…` with the drive
// letter still attached. The longest-prefix forms have to win.
const HOME_PATH_PATTERNS = [
  /[A-Za-z]:\\Users\\[^\\/\s]+/g, // Windows (backslash)
  /[A-Za-z]:\/Users\/[^/\s]+/g, // Windows (forward-slash)
  /\/Users\/[^/\s]+/g, // macOS
  /\/home\/[^/\s]+/g, // Linux
];

// `api[-_ ]?key` (not the literals `apikey|api_key`) so the hyphenated header
// forms match too — `x-api-key` is CI-Server's primary API-key header, and the
// SDK ships request headers even with sendDefaultPii disabled.
// `assertion` covers `x-ci-hub-user-assertion`, the signed Hub identity a Hub that gave this app
// its own key adds in front of every request.
const SENSITIVE_KEY_PATTERN =
  /password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private[-_]?key|signature|assertion/i;

// Keys that name a PERSON rather than carrying a credential. No value pattern
// can ever match these — a username is just a word — so the key is the only
// signal, the same reason we drop `server_name`. This matters behind CI-Hub's
// Traefik forward-auth: the SDK captures headers that ARRIVED, so a
// proxy-injected `x-ci-hub-user` reaches the event with no reference in our
// code at all.
//
// Anchored on purpose: `user-agent`, `user_id` and `owner_id` are diagnostic
// signal worth keeping, and a naive /user|owner/ would eat all three.
const IDENTITY_KEY_PATTERN = /(?:^|[-_])user$|(?:^|[-_])owner$|username|email|forwarded|^remote-/i;

/** Single predicate so credential and identity coverage cannot diverge. */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || IDENTITY_KEY_PATTERN.test(key);
}

// Headers whose value is a URL the user navigated from — same query-string
// exposure as request.url, and not caught by SENSITIVE_KEY_PATTERN.
const URL_VALUED_HEADERS = ['referer', 'referrer', 'location'];

/**
 * Breadcrumb `data` keys that are a bare query string or fragment.
 *
 * `nativeNodeFetchIntegration` — a @sentry/node default that survives our
 * integrations callback — sanitises `data.url` and then attaches the raw query
 * and fragment beside it as these keys. They match no key pattern, and their
 * values match no secret pattern, so they were copied verbatim.
 *
 * Dropped rather than scrubbed: on this appliance a query string is the user's
 * own search terms or entity ids, and the sanitised `data.url` beside it
 * already identifies the failing call. Note `tracesSampleRate: 0` does NOT
 * prevent this — undici instrumentation runs in `setupOnce` regardless, and
 * sampling gates span creation only.
 */
const DROPPED_BREADCRUMB_DATA_KEYS = ['http.query', 'http.fragment'];

/** Breadcrumb `data` keys whose value is a URL. Matches the browser twin. */
const URL_VALUED_BREADCRUMB_KEYS = ['url', 'from', 'to'];

/**
 * Span and log attributes whose value is a whole URL, or a path with its query
 * (`http.target`). The inbound server span sets `http.url`, `http.target` and
 * `url.full` from `req.url`; the outbound fetch span sets `url.full` from the
 * request it made, which for Google geocoding is the user's address plus the
 * owner's Maps key.
 */
const URL_VALUED_ATTRIBUTE_KEYS = [
  'url.full',
  'http.url',
  'http.target',
  'url',
  // The server span also copies request headers into `http.request.header.<name>`
  // attributes, and the SDK's own deny-list lets `Referer` through. The SPA's
  // same-origin API calls send the page URL there, `?search=` and all.
  ...URL_VALUED_HEADERS.flatMap((header) => [
    `http.request.header.${header}`,
    `http.response.header.${header}`,
  ]),
];

/**
 * Attributes dropped outright. The first four are a bare query string or
 * fragment (the outbound fetch span's `url.query` is the whole `?address=…&key=…`).
 * The last four are the caller's IP address, which `sendDefaultPii: false`
 * keeps off error events but the server span records anyway.
 */
const DROPPED_ATTRIBUTE_KEYS = [
  'url.query',
  'url.fragment',
  'http.query',
  'http.fragment',
  'http.client_ip',
  'client.address',
  'net.peer.ip',
  'network.peer.address',
];

const MAX_STRING_LENGTH = 8000;

/**
 * Strip query and hash from a URL. On this appliance those carry the user's own
 * search terms and entity names (`/api/graph/search?query=…&people=…`).
 */
export function scrubUrl(url: string): string {
  return url.split(/[?#]/)[0] ?? url;
}

export function scrubString(value: string): string {
  let scrubbed = value;

  for (const pattern of HOME_PATH_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '~');
  }

  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '[Filtered]');
  }

  if (scrubbed.length > MAX_STRING_LENGTH) {
    return `${scrubbed.slice(0, MAX_STRING_LENGTH)}… [truncated]`;
  }

  return scrubbed;
}

function scrubValue(value: unknown, depth = 0): unknown {
  // Guard against cyclic/deep structures — a runaway walk in beforeSend would
  // stall the reporting path on every captured error.
  if (depth > 8) {
    return '[Truncated]';
  }

  if (typeof value === 'string') {
    return scrubString(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, depth + 1));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, nested] of Object.entries(value)) {
      result[key] = isSensitiveKey(key) ? '[Filtered]' : scrubValue(nested, depth + 1);
    }

    return result;
  }

  return value;
}

/** The request block the SDK attaches to error and transaction events alike. */
function scrubRequest(request: RequestData): RequestData {
  // Query strings and bodies routinely carry search terms over the user's own
  // memories; headers carry the session cookie.
  delete request.cookies;
  delete request.data;

  if (request.query_string) {
    request.query_string = '[Filtered]';
  }

  // `request.url` is built from `req.url`, which on a Node server is
  // path+query — so it carries byte-identical content to the query_string we
  // just filtered. Filtering one without the other redacts nothing.
  if (typeof request.url === 'string') {
    request.url = scrubUrl(request.url);
  }

  if (request.headers) {
    const headers = scrubValue(request.headers) as Record<string, string>;

    for (const [key, value] of Object.entries(headers)) {
      if (URL_VALUED_HEADERS.includes(key.toLowerCase()) && typeof value === 'string') {
        headers[key] = scrubUrl(value);
      }
    }

    request.headers = headers;
  }

  return request;
}

/**
 * `beforeBreadcrumb`, and the per-crumb pass inside {@link scrubEvent}.
 * Running it when the crumb is recorded means nothing unscrubbed sits in the
 * scope waiting for whichever event picks it up next.
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = scrubString(breadcrumb.message);
  }

  if (breadcrumb.data) {
    const data = scrubValue(breadcrumb.data) as Record<string, unknown>;

    for (const key of DROPPED_BREADCRUMB_DATA_KEYS) {
      delete data[key];
    }

    // The SDK's own fetch crumbs arrive with `data.url` already sanitised —
    // it splits the query into `http.query`, which we drop above. Manually
    // added crumbs get no such treatment, so strip the query here too rather
    // than rely on every future caller remembering. Mirrors the browser twin.
    for (const key of URL_VALUED_BREADCRUMB_KEYS) {
      const value = data[key];

      if (typeof value === 'string') {
        data[key] = scrubUrl(value);
      }
    }

    breadcrumb.data = data;
  }

  return breadcrumb;
}

/**
 * The fields error and transaction events share. One pass for both, so a rule
 * added for one kind of event cannot quietly skip the other.
 */
function scrubSharedEventFields(event: ErrorEvent | TransactionEvent): void {
  if (event.extra) {
    event.extra = scrubValue(event.extra) as Record<string, unknown>;
  }

  // The hostname is the same account-identifying data we collapse `/Users/<name>`
  // to `~` to avoid. `includeServerName: false` in instrument.ts stops the SDK
  // setting it; this is the belt-and-braces half.
  delete event.server_name;

  if (event.request) {
    event.request = scrubRequest(event.request);
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  }
}

/**
 * Span and log attributes. Unlike {@link scrubValue}, a sensitive key only
 * loses a STRING value: numbers and booleans carry no free text, and filtering
 * them would turn counters such as `gen_ai.usage.input_tokens` into strings.
 */
function scrubAttributes<T extends Record<string, unknown>>(attributes: T): T {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (DROPPED_ATTRIBUTE_KEYS.includes(key)) {
      continue;
    }

    if (typeof value === 'string') {
      if (isSensitiveKey(key)) {
        result[key] = '[Filtered]';
      } else {
        result[key] = scrubString(URL_VALUED_ATTRIBUTE_KEYS.includes(key) ? scrubUrl(value) : value);
      }
    } else if (value !== null && typeof value === 'object') {
      result[key] = isSensitiveKey(key) ? '[Filtered]' : scrubValue(value);
    } else {
      result[key] = value;
    }
  }

  // Every value is still a string, number, boolean or an array of them, so the
  // caller's attribute type holds.
  return result as T;
}

/** HTTP spans name themselves `<METHOD> <url>`; anything else is left whole. */
function scrubSpanName(name: string, op: unknown): string {
  return scrubString(typeof op === 'string' && op.startsWith('http') ? scrubUrl(name) : name);
}

/**
 * `beforeSendSpan`. Runs for the root span of a transaction and for every
 * child span in it.
 */
export function scrubSpan(span: SpanJSON): SpanJSON {
  span.data = scrubAttributes(span.data ?? {});

  if (typeof span.description === 'string') {
    span.description = scrubSpanName(span.description, span.op);
  }

  return span;
}

/**
 * `beforeSendTransaction`. `beforeSendSpan` has already run over the spans by
 * the time this is called, but the request block, the transaction name and the
 * breadcrumbs are only reachable here. The spans are scrubbed again so this
 * hook stands on its own; every rule is idempotent.
 */
export function scrubTransaction(event: TransactionEvent): TransactionEvent {
  const trace = event.contexts?.trace;

  if (typeof event.transaction === 'string') {
    event.transaction = scrubSpanName(event.transaction, trace?.op);
  }

  if (trace?.data) {
    trace.data = scrubAttributes(trace.data);
  }

  if (event.spans) {
    event.spans = event.spans.map(scrubSpan);
  }

  scrubSharedEventFields(event);

  return event;
}

/**
 * `beforeSendLog`. The SDK has already copied a parameterised message's values
 * into `sentry.message.parameter.<n>` attributes by the time this runs, so the
 * attributes need the same treatment as the body.
 */
export function scrubLog(log: Log): Log {
  log.message = scrubString(String(log.message));

  if (log.attributes) {
    log.attributes = scrubAttributes(log.attributes);
  }

  return log;
}

// Matches Sentry's `beforeSend` signature; the `hint` argument is unused, so it
// is omitted rather than named — a narrower function is still assignable.
export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
  if (event.message) {
    event.message = scrubString(event.message);
  }

  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      if (exception.value) {
        exception.value = scrubString(exception.value);
      }

      // Node's stack parser keeps the absolute path in `filename`/`abs_path`,
      // which leaks the account name outside Docker, and `vars` holds captured
      // locals — on this appliance those are memory rows, note bodies, emails.
      for (const frame of exception.stacktrace?.frames ?? []) {
        if (typeof frame.filename === 'string') {
          frame.filename = scrubString(frame.filename);
        }

        if (typeof frame.abs_path === 'string') {
          frame.abs_path = scrubString(frame.abs_path);
        }

        // The ContextLines integration attaches the source around the throw
        // site. That is real source text — hardcoded keys, connection strings
        // and paths live there — and it sat unscrubbed right beside the
        // filename we were already careful about.
        if (typeof frame.context_line === 'string') {
          frame.context_line = scrubString(frame.context_line);
        }

        for (const key of ['pre_context', 'post_context'] as const) {
          const lines = frame[key];

          if (Array.isArray(lines)) {
            frame[key] = lines.map((line) => (typeof line === 'string' ? scrubString(line) : line));
          }
        }

        if (frame.vars) {
          frame.vars = scrubValue(frame.vars) as Record<string, unknown>;
        }
      }
    }
  }

  scrubSharedEventFields(event);

  return event;
}
