/**
 * The write guard's HTTP half: what `fetchJson` / `apiFetch` refuse while the connection
 * probe says the appliance is unreachable, and what they must still let through.
 */
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import {
  recordResolvedConnectionMode,
  resetRecordedConnectionMode,
} from '@ci/common/src/utils/connectionMode';
import { apiFetch, fetchJson } from '@ci/common/src/utils/fetchJson';
import {
  OfflineWriteError,
  appliancePathOf,
  applianceWritesBlocked,
  assertApplianceWritable,
  isOfflineWriteError,
  subscribeOfflineWriteBlocked,
} from '@ci/common/src/utils/offlineWrites';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { okResponse } from './fetchFakes';

const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse({ ok: true }));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetRecordedConnectionMode();
  setApiBaseUrl('');
});

describe('applianceWritesBlocked', () => {
  it('is false before the first probe answers, whatever the default mode says', () => {
    expect(applianceWritesBlocked()).toBe(false);
  });

  it('is false while connected and true for every other resolved mode', () => {
    recordResolvedConnectionMode('connected');
    expect(applianceWritesBlocked()).toBe(false);

    for (const mode of ['local', 'cached', 'fresh'] as const) {
      recordResolvedConnectionMode(mode);
      expect(applianceWritesBlocked()).toBe(true);
    }
  });
});

describe('appliancePathOf', () => {
  it('treats a relative path as the appliance', () => {
    expect(appliancePathOf('/api/people/1')).toBe('/api/people/1');
  });

  it('matches an absolute URL against the configured Memory origin', () => {
    setApiBaseUrl('https://memory.example');
    expect(appliancePathOf('https://memory.example/api/people/1?x=1')).toBe('/api/people/1');
    expect(appliancePathOf('https://hub.ci.computer/api/auth/sign-in')).toBeNull();
  });

  it('falls back to the page origin when no Memory origin is configured', () => {
    expect(appliancePathOf(`${window.location.origin}/api/people/1`)).toBe('/api/people/1');
    expect(appliancePathOf('https://elsewhere.example/api/people/1')).toBeNull();
  });
});

describe('fetchJson / apiFetch while the appliance is unreachable', () => {
  beforeEach(() => {
    recordResolvedConnectionMode('local');
  });

  it('refuses a write before anything leaves, with the shared error', async () => {
    await expect(fetchJson('/api/people/1', { method: 'PATCH', body: '{}' })).rejects.toBeInstanceOf(
      OfflineWriteError,
    );
    await expect(apiFetch('/api/people/1', { method: 'DELETE' })).rejects.toSatisfy(isOfflineWriteError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets reads through', async () => {
    await fetchJson('/api/people/1');
    await apiFetch('/api/people/1', { method: 'GET' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets a writer that queues on its own opt out', async () => {
    await fetchJson('/api/files/upload', { method: 'POST', allowOffline: true, body: '{}' });
    await apiFetch('/api/files/upload', { method: 'POST', allowOffline: true, body: '{}' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The opt-out is the helper's, not the network's.
    expect(fetchMock.mock.calls.every(([, init]) => !('allowOffline' in ((init ?? {}) as object)))).toBe(
      true,
    );
  });

  it('lets the session and pairing paths through, since they are how one gets connected', async () => {
    await fetchJson('/api/authenticate/refresh', { method: 'POST' });
    await fetchJson('/api/keys', { method: 'POST' });
    await fetchJson('/api/signup', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('leaves GraphQL to the Apollo link', async () => {
    await apiFetch('/api/graphql', { method: 'POST', body: '{}' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not judge a request aimed at another server', async () => {
    setApiBaseUrl('https://memory.example');
    await fetchJson('https://hub.ci.computer/api/auth/sign-in/email', { method: 'POST', skipApiKey: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does guard an absolute URL on the Memory origin', async () => {
    setApiBaseUrl('https://memory.example');
    await expect(
      apiFetch('https://memory.example/api/import/uploads', { method: 'POST' }),
    ).rejects.toBeInstanceOf(OfflineWriteError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('judges a Request object by its own method and URL', async () => {
    // A Request carries an absolute URL by construction; the page origin is the appliance here.
    const url = `${window.location.origin}/api/people/1`;

    await expect(apiFetch(new Request(url, { method: 'DELETE' }))).rejects.toBeInstanceOf(OfflineWriteError);
    await apiFetch(new Request(url));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchJson / apiFetch while connected or unresolved', () => {
  it('writes normally when connected', async () => {
    recordResolvedConnectionMode('connected');
    await fetchJson('/api/people/1', { method: 'PATCH', body: '{}' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('writes normally before the first probe has answered', async () => {
    await fetchJson('/api/people/1', { method: 'PATCH', body: '{}' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('assertApplianceWritable', () => {
  it('tells every subscriber what was refused, then throws', () => {
    recordResolvedConnectionMode('cached');
    const heard: unknown[] = [];
    const unsubscribe = subscribeOfflineWriteBlocked((event) => heard.push(event));

    expect(() => assertApplianceWritable({ url: '/api/import/uploads' })).toThrow(OfflineWriteError);
    expect(heard).toEqual([expect.objectContaining({ url: '/api/import/uploads' })]);

    unsubscribe();
    expect(() => assertApplianceWritable({ operation: 'DeletePerson' })).toThrow(OfflineWriteError);
    expect(heard).toHaveLength(1);
  });

  it('is a no-op while connected', () => {
    recordResolvedConnectionMode('connected');
    expect(() => assertApplianceWritable({ url: '/api/import/uploads' })).not.toThrow();
  });
});
