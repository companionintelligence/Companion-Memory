/**
 * HTTP client for the Companion Intelligence memory API.
 * Uses the built-in `fetch` (Node 18+) with AbortController for timeouts.
 */

const DEFAULT_TIMEOUT_MS = 10_000; // 10 seconds

export interface PostContextRequest {
  sessionId: string;
  messages: Array<{ role: string; content: string }>;
  agentId?: string;
  turnIndex?: number;
}

export interface PostContextResponse {
  injection?: string;
  memoryId?: string;
  entitiesUsed?: string[];
}

export class CompanionClient {
  private readonly baseUrl: string;

  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  /**
   * POST /v1/memory/context
   *
   * @throws {Error} on network errors or non-2xx HTTP responses.
   */
  async postContext(req: PostContextRequest): Promise<PostContextResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    const payload: Record<string, unknown> = {
      session_id: req.sessionId,
      messages: req.messages,
    };
    if (req.agentId !== undefined) {
      payload['agent_id'] = req.agentId;
    }

    if (req.turnIndex !== undefined) {
      payload['turn_index'] = req.turnIndex;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/memory/context`, {
        method: 'POST',
        headers: {
          'X-CI-API-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Companion API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`,
      );
    }

    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return {};
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return {};
    }

    return (await response.json()) as PostContextResponse;
  }
}
