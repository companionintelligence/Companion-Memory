import { fetch, type RequestInit } from 'undici';

import type { CompanionMemoryConfig } from './config.js';

export interface MemoryRecord {
  id: string;
  entityType: string;
  name: string | null;
  content: string | null;
  score?: number | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface RememberInput {
  content: string;
  name?: string;
  entityType?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  source?: string;
}

export interface RecallInput {
  query: string;
  limit?: number;
  entityType?: string;
}

export interface ListInput {
  entityType?: string;
  nameContains?: string;
  limit?: number;
}

export interface ForgetInput {
  id: string;
  reason?: string;
  hardDelete?: boolean;
}

export interface UserContextSnapshot {
  currentUser: {
    entityId: string;
    name: string;
    username: string | null;
    properties?: Record<string, unknown>;
  };
  familyMembers: Array<Record<string, unknown>>;
  topPreferences: Array<Record<string, unknown>>;
  quickStats: Record<string, number>;
}

export class CompanionMemoryClient {
  constructor(private readonly config: CompanionMemoryConfig) {}

  async remember(input: RememberInput): Promise<MemoryRecord> {
    const body = {
      content: input.content,
      name: input.name,
      entityType: input.entityType ?? 'Concept',
      tags: input.tags,
      metadata: this.augmentMetadata(input.metadata),
      source: input.source,
    };

    const response = await this.request<{ success: boolean; memory: MemoryRecord }>(
      'POST',
      '/memory/remember',
      { body },
    );

    return response.memory;
  }

  async recall(input: RecallInput): Promise<MemoryRecord[]> {
    const params = new URLSearchParams({ query: input.query });
    if (input.limit !== undefined) {
      params.set('limit', String(input.limit));
    }

    if (input.entityType) {
      params.set('entityType', input.entityType);
    }

    const response = await this.request<{ success: boolean; results: MemoryRecord[] }>(
      'GET',
      `/memory/recall?${params.toString()}`,
    );

    return response.results;
  }

  async list(input: ListInput = {}): Promise<MemoryRecord[]> {
    const params = new URLSearchParams();
    if (input.entityType) {
      params.set('entityType', input.entityType);
    }

    if (input.nameContains) {
      params.set('nameContains', input.nameContains);
    }

    if (input.limit !== undefined) {
      params.set('limit', String(input.limit));
    }

    const path = params.toString() ? `/memory/list?${params.toString()}` : '/memory/list';
    const response = await this.request<{ success: boolean; results: MemoryRecord[] }>('GET', path);

    return response.results;
  }

  async forget(input: ForgetInput): Promise<{ forgotten: boolean; id: string; mode: string }> {
    const response = await this.request<{ success: boolean; forgotten: boolean; id: string; mode: string }>(
      'DELETE',
      `/memory/forget/${encodeURIComponent(input.id)}`,
      {
        body: {
          reason: input.reason,
          hardDelete: input.hardDelete ?? false,
        },
      },
    );

    return { forgotten: response.forgotten, id: response.id, mode: response.mode };
  }

  async context(): Promise<UserContextSnapshot | null> {
    const response = await this.request<{ success: boolean; context: UserContextSnapshot | null }>(
      'GET',
      '/memory/context',
    );

    return response.context;
  }

  async health(): Promise<{ success: boolean; service: string; time: string }> {
    return this.request('GET', '/memory/health');
  }

  private augmentMetadata(
    metadata: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!this.config.COMPANION_MEMORY_NAMESPACE) {
      return metadata;
    }

    return { namespace: this.config.COMPANION_MEMORY_NAMESPACE, ...(metadata ?? {}) };
  }

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
