/**
 * CompanionMemoryProvider — OpenClaw memory provider backed by the
 * Companion Intelligence API.
 *
 * v1: search and get methods return empty/null stubs.
 *     Only fire-and-forget context posting (companionRemember, onAgentEnd) is live.
 */

import { CompanionClient } from './client.js';

const DEFAULT_BASE_URL = 'https://api.companion.intelligence';

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface Message {
  role: string;
  content: string;
}

export interface MemorySearchResult {
  results: string[];
}

export class CompanionMemoryProvider {
  private readonly client: CompanionClient;

  constructor(config: ProviderConfig) {
    const { apiKey, baseUrl = DEFAULT_BASE_URL } = config;
    this.client = new CompanionClient(baseUrl, apiKey);
  }

  // ---------------------------------------------------------------------------
  // Tool handlers
  // ---------------------------------------------------------------------------

  /**
   * Search personal memory for content matching *query*.
   *
   * v1 stub — always returns an empty results array.
   */
  async memorySearch(query: string): Promise<MemorySearchResult> {
    // v1 stub — v2: call this.client.postContext with a search payload.
    void query; // intentionally unused in v1

    return { results: [] };
  }

  /**
   * Retrieve a specific memory entry by its identifier.
   *
   * v1 stub — always returns null.
   */
  async memoryGet(id: string): Promise<string | null> {
    void id; // intentionally unused in v1; v2: GET /v1/memory/entries/:id

    return null;
  }

  /**
   * Explicitly store *content* in personal memory.
   *
   * Calls postContext fire-and-forget (errors are silently swallowed so the
   * agent loop is never interrupted).
   */
  async companionRemember(content: string, sessionId: string): Promise<void> {
    this.client
      .postContext({
        sessionId,
        messages: [{ role: 'user', content }],
      })
      .catch((err: unknown) => {
        // Fire-and-forget: log but never throw.
        console.warn('[companion-memory] companionRemember failed:', err);
      });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle hooks
  // ---------------------------------------------------------------------------

  /**
   * Called by OpenClaw when the agent session ends.
   * POSTs all session messages so the Companion API can extract insights.
   */
  async onAgentEnd(sessionId: string, messages: Message[]): Promise<void> {
    try {
      await this.client.postContext({ sessionId, messages });
    } catch (err) {
      console.warn('[companion-memory] onAgentEnd failed:', err);
    }
  }

  /**
   * Called by OpenClaw before each inference step.
   *
   * v1: no-op (returns empty string).
   * v2: will return a context injection string from personal memory.
   */
  async beforeInference(sessionId: string, query: string): Promise<string> {
    void sessionId; // intentionally unused in v1
    void query; // intentionally unused in v1

    // v2: return (await this.client.postContext({ sessionId, messages: [{ role: "user", content: query }] })).injection ?? "";
    return '';
  }
}
