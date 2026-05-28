import { fetch, type RequestInit } from 'undici';

import type { CompanionMemoryConfig } from './config.js';

// ---------------------------------------------------------------------------
// Response shapes — match the backend's current surface.
//
//   POST /api/memory/recall   → { block, resultCount }
//   POST /api/memory/turn     → {} (no-op stub today; reserves the path)
//   GET  /api/graph/context   → { success, context }
//   GET  /api/graph/search    → { success, nodes, links? }
//   GET  /api/graph/node      → { success, node, relationships, subgraph }
//
// The richer CRUD surface that the original draft of this client targeted
// (POST /memory/remember, DELETE /memory/forget/:id, ...) was deliberately
// removed from the backend in `c4acbdd1 Remove tool calling from agent
// domain; rely on MCP`. This client only calls endpoints that exist.
// ---------------------------------------------------------------------------

export interface RecallBlock {
  block: string;
  resultCount: number;
}

export interface GraphNodeSummary {
  id: string;
  entity_id: string;
  entity_type: string;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
  score?: number | null;
}

export interface GraphLinkSummary {
  id: string;
  relationship_id: string;
  source: string;
  target: string;
  relationship_type: string;
  strength: number;
  properties: Record<string, unknown>;
}

export interface UserContextSnapshot {
  currentUser: {
    entityId: string;
    name: string;
    username: string | null;
    properties?: Record<string, unknown>;
    dossier?: Record<string, unknown> | null;
  };
  familyMembers: Array<Record<string, unknown>>;
  topPreferences: Array<Record<string, unknown>>;
  quickStats: Record<string, number>;
}

export interface TurnMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface RecallInput {
  query: string;
  maxResults?: number;
}

export interface SearchInput {
  query: string;
  limit?: number;
}

export interface NodeInput {
  entityId: string;
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
}

export interface TurnInput {
  messages: TurnMessage[];
  sessionId?: string;
}

export class CompanionMemoryClient {
  constructor(private readonly config: CompanionMemoryConfig) {}

  // ---- agent-shaped surface (`/api/memory/*`) -----------------------------

  async recall(input: RecallInput): Promise<RecallBlock> {
    return this.request<RecallBlock>('POST', '/memory/recall', { body: input });
  }

  async turn(input: TurnInput): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('POST', '/memory/turn', { body: input });
  }

  // ---- graph surface (`/api/graph/*`) -------------------------------------

  async context(): Promise<UserContextSnapshot | null> {
    const response = await this.request<{ success: boolean; context: UserContextSnapshot | null }>(
      'GET',
      '/graph/context',
    );

    return response.context;
  }

  async search(input: SearchInput): Promise<{ nodes: GraphNodeSummary[]; links: GraphLinkSummary[] }> {
    const params = new URLSearchParams({ query: input.query });
    if (input.limit !== undefined) {
      params.set('limit', String(input.limit));
    }

    const response = await this.request<{
      success: boolean;
      nodes: GraphNodeSummary[];
      links?: GraphLinkSummary[];
    }>('GET', `/graph/search?${params.toString()}`);

    return { nodes: response.nodes ?? [], links: response.links ?? [] };
  }

  async node(input: NodeInput): Promise<unknown> {
    const params = new URLSearchParams({ entityId: input.entityId });
    if (input.maxDepth !== undefined) {
      params.set('maxDepth', String(input.maxDepth));
    }

    if (input.maxNodes !== undefined) {
      params.set('maxNodes', String(input.maxNodes));
    }

    if (input.maxEdges !== undefined) {
      params.set('maxEdges', String(input.maxEdges));
    }

    return this.request<unknown>('GET', `/graph/node?${params.toString()}`);
  }

  // ---- internals ----------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: { body?: unknown } = {},
  ): Promise<T> {
    const url = `${this.config.COMPANION_MEMORY_URL.replace(/\/$/, '')}/api${path.startsWith('/') ? path : `/${path}`}`;
    const init: RequestInit = {
      method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.COMPANION_MEMORY_API_KEY,
        accept: 'application/json',
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.COMPANION_MEMORY_TIMEOUT_MS);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      let payload: unknown = null;
      if (text.length > 0) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }

      if (!response.ok) {
        throw new CompanionMemoryHttpError(response.status, response.statusText, payload, url);
      }

      return payload as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class CompanionMemoryHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: unknown,
    public readonly url: string,
  ) {
    super(`Companion memory request failed: ${status} ${statusText} (${url})`);
    this.name = 'CompanionMemoryHttpError';
  }
}
