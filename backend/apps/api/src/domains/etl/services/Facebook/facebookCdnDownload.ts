import { Agent, fetch as undiciFetch } from 'undici';

import { BlockedAddressError, guardedLookup, isBlockedHostname, readCapped } from '@ci/domains/embed';

/**
 * Downloading a Facebook photo or video file, with the same rules the link-preview fetcher
 * (`UnfurlFetcher`) applies to any URL that came out of user data.
 *
 * The URL comes from a sync payload: `images[].source` on a photo, `source` on a video, an
 * attachment's `media.image.src`. Facebook puts its CDN there, but nothing about the payload
 * guarantees it, and a plain `fetch` of it would follow redirects anywhere and dial any address,
 * the LAN, the Docker network and cloud metadata included. So:
 *
 *  - https only, no credentials in the URL, default port;
 *  - the host must be on Facebook's CDN, `*.fbcdn.net`;
 *  - blocked address ranges are refused AT CONNECT TIME by `guardedLookup`, so the address that
 *    passed the check is the one dialled (no rebind window);
 *  - redirects are followed by hand, at most {@link MAX_REDIRECTS}, and every hop passes the same
 *    checks before it is requested.
 */

const MAX_REDIRECTS = 3;
const CONNECT_TIMEOUT_MS = 10_000;
/** A 256 MB video on a slow link; the cap on bytes is the caller's. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** Hosts Facebook serves photo and video files from. */
const FACEBOOK_CDN_SUFFIX = '.fbcdn.net';

/** A download this module would not make, or that did not complete; the message says which. */
export class FacebookCdnDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FacebookCdnDownloadError';
  }
}

/** The subset of a fetch Response this module reads. */
interface CdnResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

/** One hop. Must not follow redirects itself. */
export type CdnFetch = (url: URL, init: { signal: AbortSignal }) => Promise<CdnResponse>;

const agent = new Agent({
  connect: { lookup: guardedLookup, timeout: CONNECT_TIMEOUT_MS },
  keepAliveTimeout: 4_000,
});

/** The production hop: no redirect following underneath, and every connection through `guardedLookup`. */
const guardedFetch: CdnFetch = async (url, init) =>
  (await undiciFetch(url, {
    method: 'GET',
    redirect: 'manual',
    dispatcher: agent,
    signal: init.signal,
  })) as unknown as CdnResponse;

/** Whether this URL may be requested at all. Applied to the first URL and to every redirect target. */
export function isAllowedFacebookCdnUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');

  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    (url.port === '' || url.port === '443') &&
    host.endsWith(FACEBOOK_CDN_SUFFIX) &&
    !isBlockedHostname(host)
  );
}

/**
 * GET a Facebook CDN file into memory, at most `maxBytes`.
 *
 * Throws {@link FacebookCdnDownloadError} for every refusal and failure; the caller keeps the
 * link instead of a stored copy, as it always has when a download fails.
 */
export async function downloadFacebookCdnFile(
  rawUrl: string,
  options: { maxBytes: number; fetchImpl?: CdnFetch; timeoutMs?: number },
): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? guardedFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);

  try {
    let url = parse(rawUrl);

    for (let hop = 0; ; hop++) {
      if (!isAllowedFacebookCdnUrl(url)) {
        throw new FacebookCdnDownloadError(`refusing to download from ${url.protocol}//${url.host}`);
      }

      let response: CdnResponse;

      try {
        response = await fetchImpl(url, { signal: controller.signal });
      } catch (error) {
        throw new FacebookCdnDownloadError(describeTransportFailure(url, error));
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');

        if (!location) {
          throw new FacebookCdnDownloadError(`CDN answered ${response.status} with no Location`);
        }

        if (hop >= MAX_REDIRECTS) {
          throw new FacebookCdnDownloadError(`more than ${MAX_REDIRECTS} redirects`);
        }

        url = parse(location, url);

        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});

        throw new FacebookCdnDownloadError(`CDN responded ${response.status}`);
      }

      const declared = Number(response.headers.get('content-length') ?? 0);

      if (declared > options.maxBytes) {
        await response.body?.cancel().catch(() => {});

        throw new FacebookCdnDownloadError(
          `file is ${declared} bytes, over the ${options.maxBytes}-byte limit`,
        );
      }

      let body: Buffer | null;

      try {
        body = await readCapped(response, options.maxBytes);
      } catch (error) {
        // A timeout or a dropped connection mid-body is a failed download like any other.
        throw new FacebookCdnDownloadError(describeTransportFailure(url, error));
      }

      if (body == null) {
        throw new FacebookCdnDownloadError(`file is over the ${options.maxBytes}-byte limit`);
      }

      return body;
    }
  } finally {
    clearTimeout(timer);
  }
}

function parse(value: string, base?: URL): URL {
  try {
    return new URL(value, base);
  } catch {
    throw new FacebookCdnDownloadError('not a valid URL');
  }
}

function describeTransportFailure(url: URL, error: unknown): string {
  const err = error as (Error & { cause?: Error }) | undefined;
  const cause = err?.cause ?? err;

  if (err?.name === 'AbortError') {
    return 'download timed out';
  }

  if (cause instanceof BlockedAddressError || cause?.name === 'BlockedAddressError') {
    return `refusing to connect to a blocked address for ${url.hostname}`;
  }

  return cause?.message ?? String(error);
}
