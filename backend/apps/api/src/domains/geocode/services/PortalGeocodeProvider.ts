import { Injectable } from '@nestjs/common';
import plimit from 'p-limit';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import type { GeocodePoint, GeocodeProvider, GeocodeProviderResult } from './GeocodeProvider';

/** Portal's batch endpoints, relative to `config.geocoding.portalBaseUrl`. */
const FORWARD_PATH = '/api/geocode';
const REVERSE_PATH = '/api/geocode/reverse';

/**
 * Items per request. MUST stay <= CI-Portal's `MAX_GEOCODE_BATCH_ITEMS`
 * (apps/hono-app/src/domains/geocode/types.ts), which is enforced by a zod
 * schema: one item over and Portal rejects the WHOLE request with a 400, taking
 * every innocent item in the batch with it. Duplicated rather than imported
 * because the appliance cannot depend on the edge repo — if Portal ever raises
 * its ceiling, this is the line to follow it with.
 */
const MAX_BATCH_ITEMS = 100;

/**
 * Per-address length ceiling, mirroring Portal's `MAX_QUERY_LENGTH`. Enforced
 * here as well so one absurd string (a pasted email body landing in a calendar
 * location field, which the import corpus does contain) is rejected as a fact
 * about that one item instead of 400-ing the 99 addresses it shares a batch
 * with.
 */
const MAX_QUERY_LENGTH = 512;

/**
 * Concurrent in-flight batch POSTs. Deliberately small: each request can fan out
 * to MAX_BATCH_ITEMS upstream calls inside a single Cloudflare Worker
 * invocation, so piling requests on Portal buys nothing and risks tripping its
 * own limits. The caller (GeocodeBatchListener) already applies a QPS throttle
 * on top of this; this cap bounds sockets even if that throttle is misconfigured.
 */
const MAX_CONCURRENT_BATCHES = 4;

/**
 * Wall-clock ceiling per request. Generous compared to a single-address call:
 * in the worst case (every item a distinct cache miss) Portal makes up to
 * MAX_BATCH_ITEMS provider calls before it can answer.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** Backoff before each retry of a *transient* failure. Length = retry budget. */
const RETRY_BACKOFF_MS = [500, 2000];

/** Ceiling applied to a server-supplied `Retry-After`, so a bad header can't wedge a worker. */
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * HTTP statuses worth retrying. Everything else in the 4xx range describes OUR
 * request or OUR credentials, and repeating it verbatim would only burn the
 * retry budget.
 */
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);

function isTransientHttpStatus(status: number): boolean {
  return status >= 500 || TRANSIENT_HTTP_STATUSES.has(status);
}

/**
 * The single failure shape this provider is allowed to invent.
 *
 * UNKNOWN_ERROR is in GeocodeService's RETRYABLE_STATUSES, which is what makes
 * it safe: a retryable status is NOT written to ci.geocode_cache. Every "we
 * could not reach an answer" path below must land here rather than on OK (which
 * would persist a null island) or on a negative status like ZERO_RESULTS (which
 * would be cached, turning a five-minute outage into a permanently wrong address
 * that only a manual retryNull cache-bust can undo).
 */
function transient(errorMessage: string): GeocodeProviderResult {
  return { status: 'UNKNOWN_ERROR', errorMessage };
}

function fill(count: number, result: GeocodeProviderResult): GeocodeProviderResult[] {
  return Array.from({ length: count }, () => ({ ...result }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wire shape of one entry in a Portal batch response — CI-Portal's
 * `GeocodeResultItem` field for field. Portal normalizes to the same shape
 * {@link GeocodeProviderResult} uses precisely so this hop is a copy with
 * guards, not a translation. Everything is optional because it arrives off the
 * network: the guards below, not the type, are what make it safe.
 */
interface PortalGeocodeResultItem {
  /** Provider status, verbatim (OK | ZERO_RESULTS | REQUEST_DENIED | …). */
  status?: string;
  lat?: number;
  lng?: number;
  normalizedAddress?: string;
  placeId?: string;
  locationType?: string;
  partialMatch?: boolean;
  components?: Record<string, unknown>;
  errorMessage?: string;
  /** Normalized/coarsened form Portal actually resolved. Not a correlation key. */
  query?: string;
  /** Whether Portal's shared cache served this item (no provider call billed). */
  cached?: boolean;
}

interface PortalGeocodeBatchResponse {
  results?: PortalGeocodeResultItem[];
  stats?: { total?: number; unique?: number; cached?: number; fetched?: number };
}

type GeocodeDirection = 'forward' | 'reverse';

/** An input that either survived local validation, or already has its answer. */
type PreparedItem<TPayload> = { ok: true; payload: TPayload } | { ok: false; result: GeocodeProviderResult };

/** Outcome of one HTTP attempt: parsed items, or a classified failure. */
type AttemptOutcome =
  | { ok: true; items: PortalGeocodeResultItem[] }
  | { ok: false; retryable: boolean; message: string; retryAfterMs?: number };

/**
 * Geocode provider that routes all egress through CI-Portal.
 *
 * The appliance does not hold a provider key and does not call Google. Portal
 * holds the key and fronts a cache shared by every appliance, so an address one
 * box has already resolved is free for the next — which is the point: the
 * appliance's own ci.geocode_cache only kills repeats within one user's data,
 * while the second tier kills them across all users, and a decade of calendar
 * history is mostly the same few hundred places.
 *
 * ### Two properties are load-bearing
 *
 * 1. **`status` crosses verbatim.** Portal passes the provider's own status
 *    vocabulary through untouched, and so does this class. The orchestration in
 *    GeocodeService branches on that string and never on an HTTP code — it has
 *    to, because Google answers HTTP 200 for REQUEST_DENIED and ZERO_RESULTS
 *    alike. Adding a proxy hop must not break that.
 *
 * 2. **A failure to *reach* an answer is never a negative answer.** Network
 *    drop, timeout, 5xx, unparseable body, missing configuration, a short
 *    results array — all of them resolve to UNKNOWN_ERROR, which GeocodeService
 *    treats as retryable and refuses to cache. The failure mode this guards
 *    against is silent and permanent: cache ZERO_RESULTS for an address during
 *    a Portal outage and that address stays wrong forever, since the backfill's
 *    candidate query deliberately never revisits a cached row.
 *
 * NOTE on REQUEST_DENIED: it crosses verbatim like every other provider status,
 * and GeocodeService will negative-cache it. From Portal that status means
 * *Portal's* key is unbilled or restricted — a fact about the platform, not
 * about the address — so a spell of REQUEST_DENIED does poison the local cache
 * for the addresses seen during it. Recovery is the existing `retryNull`
 * backfill, which busts the cache. Distinguishing it here would mean
 * second-guessing a status the whole design exists to pass through untouched.
 */
@Injectable()
export class PortalGeocodeProvider implements GeocodeProvider {
  /**
   * Base origin of the geocoding proxy: CI-Portal directly, or the hub host
   * that fronts it. Which of the two a deployment uses is not yet decided, so it
   * is ONE config value (`config.geocoding.portalBaseUrl`, resolved in
   * configuration.ts) and no URL is built anywhere else.
   */
  private readonly baseUrl = (config.geocoding.portalBaseUrl ?? '').replace(/\/+$/, '');

  /**
   * Appliance device credential. Portal's `deviceAuthMiddleware` looks the
   * device up by this key in the `x-device-key` header — the same HUB_API_KEY
   * that CheckIn / SyncState already present.
   */
  private readonly deviceKey = config.ciPortal.apiKey ?? '';

  /** Bounded in-flight batch POSTs (see MAX_CONCURRENT_BATCHES). */
  private readonly limiter = plimit(MAX_CONCURRENT_BATCHES);

  /** Latches the "not configured" warning so a backfill can't spam the log. */
  private hasWarnedUnconfigured = false;

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(PortalGeocodeProvider.name);
  }

  async geocode(address: string): Promise<GeocodeProviderResult> {
    const [result] = await this.geocodeBatch([address]);

    return result;
  }

  async reverseGeocode(lat: number, lng: number): Promise<GeocodeProviderResult> {
    const [result] = await this.reverseGeocodeBatch([{ lat, lng }]);

    return result;
  }

  /**
   * Forward-geocode a page of addresses in one (or few) round trips. Results are
   * index-aligned with `addresses` — Portal's response is index-aligned with the
   * request array, and the echoed `query` is the NORMALIZED form, so it must
   * never be used to correlate.
   */
  async geocodeBatch(addresses: string[]): Promise<GeocodeProviderResult[]> {
    return this.runBatched(addresses, {
      direction: 'forward',
      path: FORWARD_PATH,
      prepare: (address) => PortalGeocodeProvider.prepareAddress(address),
      buildBody: (queries) => ({ queries }),
    });
  }

  /** Reverse-geocode a page of points. Same index-alignment contract. */
  async reverseGeocodeBatch(points: GeocodePoint[]): Promise<GeocodeProviderResult[]> {
    return this.runBatched(points, {
      direction: 'reverse',
      path: REVERSE_PATH,
      prepare: (point) => PortalGeocodeProvider.preparePoint(point),
      buildBody: (prepared) => ({ points: prepared }),
    });
  }

  /**
   * Shared batching pipeline for both directions: validate locally, chunk the
   * survivors to MAX_BATCH_ITEMS, POST the chunks under the concurrency cap, and
   * scatter the answers back to their original positions.
   *
   * Locally-rejected items never reach the network AND never consume a batch
   * slot, so a page containing junk still resolves the good addresses in it.
   */
  private async runBatched<TRaw, TPayload>(
    items: TRaw[],
    spec: {
      direction: GeocodeDirection;
      path: string;
      prepare: (item: TRaw) => PreparedItem<TPayload>;
      buildBody: (payloads: TPayload[]) => Record<string, unknown>;
    },
  ): Promise<GeocodeProviderResult[]> {
    const results = Array.from<GeocodeProviderResult | undefined>({ length: items.length });
    const sendable: Array<{ index: number; payload: TPayload }> = [];

    items.forEach((item, index) => {
      const prepared = spec.prepare(item);

      if (prepared.ok) {
        sendable.push({ index, payload: prepared.payload });
      } else {
        results[index] = prepared.result;
      }
    });

    const chunks: Array<Array<{ index: number; payload: TPayload }>> = [];
    for (let start = 0; start < sendable.length; start += MAX_BATCH_ITEMS) {
      chunks.push(sendable.slice(start, start + MAX_BATCH_ITEMS));
    }

    await Promise.all(
      chunks.map((chunk) =>
        this.limiter(async () => {
          const body = spec.buildBody(chunk.map((entry) => entry.payload));
          const chunkResults = await this.postBatch(spec.path, body, chunk.length, spec.direction);

          chunk.forEach((entry, offset) => {
            results[entry.index] = chunkResults[offset];
          });
        }),
      ),
    );

    // Defensive: every slot is filled above. A hole would still have to be a
    // transient, never a negative — see {@link transient}.
    return results.map((result) => result ?? transient('No result was produced for this item'));
  }

  /**
   * POST one chunk, retrying only transient failures, and always return exactly
   * `count` results. Never throws and never rejects: the caller is mid-batch and
   * a rejection here would discard every other item's answer.
   */
  private async postBatch(
    path: string,
    body: Record<string, unknown>,
    count: number,
    direction: GeocodeDirection,
  ): Promise<GeocodeProviderResult[]> {
    if (!this.baseUrl || !this.deviceKey) {
      this.warnUnconfiguredOnce();

      // Transient, NOT REQUEST_DENIED: missing configuration is a deployment
      // state that gets fixed, so it must not negative-cache every address the
      // appliance happens to touch before someone sets the env var.
      return fill(count, transient('Portal geocoding is not configured'));
    }

    const url = `${this.baseUrl}${path}`;
    let failure: { message: string; retryable: boolean; retryAfterMs?: number } = {
      message: 'Portal geocode request was never attempted',
      retryable: false,
    };

    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      const outcome = await this.attemptBatch(url, body);

      if (outcome.ok) {
        return this.alignResults(outcome.items, count, direction);
      }

      failure = outcome;

      if (!outcome.retryable || attempt === RETRY_BACKOFF_MS.length) {
        break;
      }

      // A server-supplied Retry-After (429) beats our own guess, clamped so a
      // hostile or broken header cannot park the worker for an hour.
      await sleep(outcome.retryAfterMs ?? RETRY_BACKOFF_MS[attempt]);
    }

    this.logger.warn('Portal geocode batch failed', {
      url,
      count,
      retryable: failure.retryable,
      error: failure.message,
    });

    return fill(count, transient(failure.message));
  }

  /** One HTTP attempt. Classifies every failure as retryable or not; never throws. */
  private async attemptBatch(url: string, body: Record<string, unknown>): Promise<AttemptOutcome> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-device-key': this.deviceKey,
          'User-Agent': 'CI-Server/1.0',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // Dropped connection, DNS failure, timeout abort. Never a fact about the
      // query, so always retryable.
      return {
        ok: false,
        retryable: true,
        message: error instanceof Error ? error.message : 'Transport error',
      };
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      // Portal answers HTTP 200 for a well-formed request even when every item
      // failed — per-item outcomes live in `status`. So a non-2xx is always
      // about the request itself: 5xx/429 are the outage-shaped ones worth
      // retrying, and a 401/403/400 is our key or our payload, which retrying
      // cannot fix but which is still not an answer about any address.
      const retryable = isTransientHttpStatus(response.status);

      return {
        ok: false,
        retryable,
        message: `HTTP ${response.status}`,
        retryAfterMs: retryable ? readRetryAfterMs(response) : undefined,
      };
    }

    let payload: PortalGeocodeBatchResponse;
    try {
      payload = (await response.json()) as PortalGeocodeBatchResponse;
    } catch {
      // A 200 carrying a non-JSON body is a proxy/captive-portal artifact, not
      // Portal — treat it like an outage.
      return { ok: false, retryable: true, message: 'Portal returned an unparseable body' };
    }

    if (!Array.isArray(payload.results)) {
      return { ok: false, retryable: true, message: 'Portal response had no results array' };
    }

    return { ok: true, items: payload.results };
  }

  /**
   * Map Portal's items onto provider results positionally, producing exactly
   * `count` entries. A short array is a Portal bug; the missing slots become
   * transients so the affected addresses are simply retried later rather than
   * silently recorded as unresolvable.
   */
  private alignResults(
    items: PortalGeocodeResultItem[],
    count: number,
    direction: GeocodeDirection,
  ): GeocodeProviderResult[] {
    if (items.length !== count) {
      this.logger.warn('Portal returned a result count that does not match the batch', {
        expected: count,
        received: items.length,
      });
    }

    return Array.from({ length: count }, (_unused, index) =>
      PortalGeocodeProvider.toProviderResult(items[index], direction),
    );
  }

  /**
   * Copy one wire item onto a {@link GeocodeProviderResult}, preserving `status`
   * verbatim — with one class of exception: an `OK` that carries nothing usable.
   *
   * GeocodeService writes its cache row BEFORE it checks that an OK actually has
   * coordinates (forward) or a name (reverse), so an empty OK would persist as a
   * cached success that resolves to nothing — the worst of both failure modes.
   * Downgrading it to a transient keeps the row out of the cache. Note this
   * differs from GoogleGeocodeProvider, which maps the same case to ZERO_RESULTS:
   * there the empty result came from the provider itself and is a real answer,
   * whereas here it can only be a defect in the proxy hop.
   */
  private static toProviderResult(
    item: PortalGeocodeResultItem | undefined,
    direction: GeocodeDirection,
  ): GeocodeProviderResult {
    if (!item || typeof item.status !== 'string' || item.status.length === 0) {
      return transient('Portal returned fewer results than the batch requested');
    }

    if (item.status === 'OK') {
      if (direction === 'forward' && (typeof item.lat !== 'number' || typeof item.lng !== 'number')) {
        return transient('Portal reported OK without coordinates');
      }

      if (direction === 'reverse' && !item.normalizedAddress) {
        return transient('Portal reported OK without a resolved address');
      }
    }

    return {
      status: item.status,
      lat: typeof item.lat === 'number' ? item.lat : undefined,
      lng: typeof item.lng === 'number' ? item.lng : undefined,
      normalizedAddress: item.normalizedAddress,
      placeId: item.placeId,
      locationType: item.locationType,
      partialMatch: item.partialMatch,
      components: item.components,
      errorMessage: item.errorMessage,
    };
  }

  /**
   * Local validation of a forward query. INVALID_REQUEST here is a permanent,
   * cacheable negative on purpose — unlike a transport failure, an empty or
   * absurd string is a fact about the input that will not change.
   */
  private static prepareAddress(address: string): PreparedItem<string> {
    const query = typeof address === 'string' ? address.trim() : '';

    if (query.length === 0) {
      return { ok: false, result: { status: 'INVALID_REQUEST', errorMessage: 'Empty query' } };
    }

    if (query.length > MAX_QUERY_LENGTH) {
      return {
        ok: false,
        result: {
          status: 'INVALID_REQUEST',
          errorMessage: `Query exceeds ${MAX_QUERY_LENGTH} characters`,
        },
      };
    }

    return { ok: true, payload: query };
  }

  /**
   * Local validation of a reverse point. Portal's zod schema rejects the ENTIRE
   * batch on an out-of-range pair, so catching it here is what stops one
   * transposed lat/lng from costing 99 other points their answers. Bounds are
   * checked rather than trusted because a transposition is the common defect and
   * the swapped point would otherwise geocode to a confident, wrong place.
   */
  private static preparePoint(point: GeocodePoint): PreparedItem<GeocodePoint> {
    const { lat, lng } = point;

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return {
        ok: false,
        result: {
          status: 'INVALID_REQUEST',
          errorMessage: `Coordinates out of range: (${lat}, ${lng}) — lat/lng likely transposed`,
        },
      };
    }

    return { ok: true, payload: { lat, lng } };
  }

  private warnUnconfiguredOnce(): void {
    if (this.hasWarnedUnconfigured) {
      return;
    }

    this.hasWarnedUnconfigured = true;
    this.logger.warn(
      'Portal geocoding is not configured — set GEOCODING_PORTAL_BASE_URL (or CI_CLOUD_URL) and ' +
        'HUB_API_KEY. Geocode requests will report a transient failure until then.',
    );
  }
}

/** Parse a numeric `Retry-After` (seconds) into milliseconds, clamped. */
function readRetryAfterMs(response: Response): number | undefined {
  const header = response.headers?.get('retry-after');
  if (!header) {
    return undefined;
  }

  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }

  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}
