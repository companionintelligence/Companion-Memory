/**
 * Plain, DI-free client over one BlueBubbles server's REST API
 * (https://github.com/BlueBubblesApp/bluebubbles-app — a macOS app exposing
 * iMessage/SMS over HTTP + webhooks).
 *
 * The actual BlueBubbles HTTP protocol logic — auth, pagination, the
 * `{status, message, data}` envelope — lives here ONCE, shared by:
 *   - `./bluebubbles.ts`, the ETL importer in this same domain, which
 *     constructs this class directly (datasources are framework-free), and
 *   - `domains/bluebubbles`'s `BlueBubblesClientService` (the NestJS-DI
 *     wrapper the AI messaging tools and the settings controller use),
 *     reached through this domain's `@ci/domains/import` barrel.
 *
 * Lives in `domains/import`, not `domains/bluebubbles`, specifically so that
 * dependency stays one-directional (`bluebubbles` → `import`): the datasource
 * needs this client, and `bluebubbles` needs the datasource's importer +
 * mapping functions, so putting the client in `bluebubbles` instead would
 * create a real barrel-to-barrel import cycle between the two domains.
 *
 * No framework imports (no NestJS decorators) — this file must stay importable
 * from the plain-TypeScript `datasources/*.ts` module, which never imports
 * `@nestjs/*`.
 */

export interface BlueBubblesClientConfig {
  host: string;
  port: number;
  useHttps: boolean;
  /** BlueBubbles' own server password — a full-control credential. */
  password: string;
}

export interface BlueBubblesHandle {
  address: string;
  service?: string | null;
  uncanonicalizedId?: string | null;
}

/** `style`: 43 = group chat, 45 = direct message. */
export interface BlueBubblesChat {
  guid: string;
  chatIdentifier?: string | null;
  displayName?: string | null;
  style?: number | null;
  participants?: BlueBubblesHandle[];
}

export interface BlueBubblesAttachment {
  guid: string;
  mimeType?: string | null;
  uti?: string | null;
  transferName?: string | null;
  totalBytes?: number | null;
  height?: number | null;
  width?: number | null;
  blurhash?: string | null;
  isSticker?: boolean | null;
  hasLivePhoto?: boolean | null;
}

/**
 * One iMessage/SMS row. Every date* field is a standard Unix millisecond
 * epoch — unlike the Cocoa-epoch seconds/nanoseconds a raw chat.db stores,
 * BlueBubbles' API always normalizes to Unix ms.
 */
export interface BlueBubblesMessage {
  guid: string;
  text?: string | null;
  attributedBody?: unknown;
  handle?: BlueBubblesHandle | null;
  handleId?: number | null;
  /** Top-level convenience field some BlueBubbles versions include alongside `handle.service`. */
  service?: string | null;
  chats?: BlueBubblesChat[];
  attachments?: BlueBubblesAttachment[];
  dateCreated?: number | null;
  dateRead?: number | null;
  dateDelivered?: number | null;
  dateEdited?: number | null;
  dateRetracted?: number | null;
  isFromMe?: boolean | null;
  itemType?: number | null;
  groupActionType?: number | null;
  /** Tapback / edit reference: the message this one reacts to or replaces. */
  associatedMessageGuid?: string | null;
  /** e.g. 'love', 'like', 'dislike', 'laugh', 'emphasize', 'question', or a '-remove' suffixed retraction. */
  associatedMessageType?: string | null;
  replyToGuid?: string | null;
  threadOriginatorGuid?: string | null;
}

interface BlueBubblesEnvelope<T> {
  status: number;
  message: string;
  data: T;
}

/** BlueBubbles paginates `/message/query` and `/chat/query` at up to this many rows. */
export const BLUEBUBBLES_PAGE_LIMIT = 1000;

/**
 * Strip the `password` query param out of a URL before it is ever logged.
 * BlueBubbles has no header-auth story — the password rides in the query
 * string of every request — so every logged URL MUST go through this first.
 */
export function redactUrl(url: string): string {
  return url.replace(/([?&]password=)[^&]*/gi, '$1REDACTED');
}

export class BlueBubblesApiClient {
  private readonly baseUrl: string;

  constructor(private readonly config: BlueBubblesClientConfig) {
    const scheme = config.useHttps ? 'https' : 'http';
    // Trailing slash matters: it is what makes relative `new URL(path, base)`
    // resolution below append rather than replace the last path segment.
    this.baseUrl = `${scheme}://${config.host}:${config.port}/api/v1/`;
  }

  private urlFor(path: string, params: Record<string, string | number | undefined> = {}): URL {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('password', this.config.password);

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { params?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = this.urlFor(path, options.params);
    // Built up rather than a single literal: a GET request must carry no
    // `body` key at all (not merely an undefined one) — `fetch` options being
    // a variable `method` union ('GET' | 'POST') is exactly what a static
    // "body is not allowed when method is GET" lint rule cannot see through
    // from a fixed literal shape.
    const init: RequestInit = { method };

    if (options.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(options.body);
    }

    let response: Response;

    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new Error(`BlueBubbles request failed (${redactUrl(url.toString())}): ${(err as Error).message}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');

      throw new Error(
        `BlueBubbles request failed: ${response.status} ${redactUrl(url.toString())} ${text.slice(0, 300)}`,
      );
    }

    const envelope = (await response.json()) as BlueBubblesEnvelope<T>;

    return envelope.data;
  }

  /** GET /server/info — a cheap authenticated ping, used by test-connection. */
  async ping(): Promise<Record<string, unknown>> {
    return this.request('GET', 'server/info');
  }

  /**
   * One page of messages, ascending by `dateCreated`, strictly after `after`
   * (ms epoch) when given. The caller advances by re-calling with the highest
   * `dateCreated` it has seen once a page comes back shorter than `limit`.
   */
  async queryMessages(options: {
    after?: number;
    limit?: number;
    offset?: number;
  }): Promise<BlueBubblesMessage[]> {
    return this.request('POST', 'message/query', {
      body: {
        after: options.after,
        sort: 'ASC',
        limit: options.limit ?? BLUEBUBBLES_PAGE_LIMIT,
        offset: options.offset ?? 0,
        with: ['chats', 'chats.participants', 'handle', 'attachments'],
      },
    });
  }

  /**
   * One page of chats, with participants. `limit` here is a RESULT cap, not a
   * page-size hint — use this directly whenever a caller wants a bounded list
   * (e.g. the AI listChats tool); use {@link queryChats} for the full directory.
   */
  async queryChatsPage(options: { limit?: number; offset?: number } = {}): Promise<BlueBubblesChat[]> {
    return this.request('POST', 'chat/query', {
      body: {
        with: ['participants'],
        limit: options.limit ?? BLUEBUBBLES_PAGE_LIMIT,
        offset: options.offset ?? 0,
      },
    });
  }

  /** Every chat this server knows about, with participants — pages internally until drained. */
  async queryChats(): Promise<BlueBubblesChat[]> {
    const limit = BLUEBUBBLES_PAGE_LIMIT;
    const out: BlueBubblesChat[] = [];
    let offset = 0;

    for (;;) {
      const page = await this.queryChatsPage({ limit, offset });

      out.push(...page);

      if (page.length < limit) {
        break;
      }

      offset += page.length;
    }

    return out;
  }

  /** Recent messages in one chat, newest first — backs the AI listMessages tool. */
  async messagesForChat(chatGuid: string, maxResults = 25): Promise<BlueBubblesMessage[]> {
    return this.request('GET', `chat/${encodeURIComponent(chatGuid)}/message`, {
      params: { limit: maxResults, sort: 'DESC', with: 'attachments,handle' },
    });
  }

  /** Send a text into an existing chat. Requires the BlueBubbles Private API to be enabled. */
  async sendText(chatGuid: string, message: string): Promise<BlueBubblesMessage> {
    return this.request('POST', 'message/text', {
      body: { chatGuid, message, method: 'apple-script' },
    });
  }

  /** Download one attachment's bytes, or null when it is unreachable / purged. */
  async downloadAttachment(guid: string): Promise<Buffer | null> {
    const url = this.urlFor(`attachment/${encodeURIComponent(guid)}/download`);

    try {
      const response = await fetch(url);

      if (!response.ok) {
        return null;
      }

      return Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
    }
  }
}
