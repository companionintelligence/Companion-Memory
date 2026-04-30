export class UpstreamApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`CI API request failed with status ${status}`);
  }
}

export interface CiApiClientOptions {
  baseUrl: string;
  serviceKey: string;
}

export class CiApiClient {
  constructor(private readonly options: CiApiClientOptions) {}

  async getCapabilities() {
    return this.request('/agent/v1/capabilities');
  }

  async getUserContext() {
    return this.request('/agent/v1/context');
  }

  async searchMemory(body: Record<string, unknown>) {
    return this.request('/agent/v1/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async readEntityGraph(body: Record<string, unknown>) {
    return this.request('/agent/v1/graph/read', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getRecentActivity(body: Record<string, unknown>) {
    return this.request('/agent/v1/activity/recent', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getThread(threadId: string, maxMessages?: number) {
    const query = new URLSearchParams();

    if (maxMessages != null) {
      query.set('maxMessages', String(maxMessages));
    }

    return this.request(`/agent/v1/threads/${threadId}${query.size > 0 ? `?${query}` : ''}`);
  }

  async getDocument(documentId: string, includeText?: boolean, maxChars?: number) {
    const query = new URLSearchParams();

    if (includeText != null) {
      query.set('includeText', String(includeText));
    }

    if (maxChars != null) {
      query.set('maxChars', String(maxChars));
    }

    return this.request(`/agent/v1/documents/${documentId}${query.size > 0 ? `?${query}` : ''}`);
  }

  private async request(pathname: string, init?: RequestInit) {
    const url = new URL(pathname, this.options.baseUrl);
    const response = await fetch(url, {
      ...init,
      headers: {
        'X-CI-Service-Key': this.options.serviceKey,
        Accept: 'application/json',
        ...(init?.body && {
          'Content-Type': 'application/json',
        }),
        ...init?.headers,
      },
    });

    if (!response.ok) {
      throw new UpstreamApiError(response.status, await response.text());
    }

    return response.json();
  }
}
