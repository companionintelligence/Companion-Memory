import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import type { PeerDescriptor } from '../protocol';
import { EgressBlockedError, peerEgressFetch } from '../urlPolicy';

interface PortalPeerRow {
  handle?: unknown;
  displayName?: unknown;
  memoryEndpoint?: unknown;
  issuer?: unknown;
  subject?: unknown;
}

/**
 * Client for CI-Portal's peer directory — the DISCOVERY plane.
 *
 * Portal answers exactly two questions: "who is `@handle`?" and "who is
 * discoverable matching this search?", returning a peer's Companion endpoint
 * and OIDC issuer/subject. It is deliberately *not* told about relationships,
 * grants, asks, or answers — those live only on the two boxes involved, so the
 * cloud plane never accumulates the social graph.
 */
@Injectable()
export class PeerDirectoryService {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(PeerDirectoryService.name);
  }

  get enabled(): boolean {
    return Boolean(config.peers?.directoryUrl);
  }

  /** Resolve a Portal handle to a peer descriptor, or null if unknown. */
  async resolve(handle: string, accessToken: string): Promise<PeerDescriptor | null> {
    if (!this.enabled) {
      return null;
    }

    const url = `${this.base()}/peers/resolve/${encodeURIComponent(handle)}`;
    const response = await this.fetchJson(url, accessToken);

    if (response == null) {
      return null;
    }

    return toDescriptor(response as PortalPeerRow);
  }

  /** Search the directory for discoverable peers (opt-in only, Portal-side). */
  async search(query: string, accessToken: string): Promise<PeerDescriptor[]> {
    if (!this.enabled || query.trim().length === 0) {
      return [];
    }

    const url = `${this.base()}/peers/search?q=${encodeURIComponent(query)}`;
    const response = await this.fetchJson(url, accessToken);
    const rows = Array.isArray((response as { peers?: unknown })?.peers)
      ? (response as { peers: PortalPeerRow[] }).peers
      : [];

    return rows.map(toDescriptor).filter((peer): peer is PeerDescriptor => peer != null);
  }

  private base(): string {
    return String(config.peers.directoryUrl).replace(/\/+$/, '');
  }

  private async fetchJson(url: string, accessToken: string): Promise<unknown | null> {
    // SSRF guard. `directoryUrl` is operator-supplied config rather than peer
    // data, but it is still a server-side fetch target — going through the same
    // guarded dialer means a mis-set env var cannot turn discovery into an
    // internal port scanner, and keeps ONE policy for every outbound call this
    // domain makes. Crucially that includes redirects: a directory that answers
    // 302 must not be able to steer this box at its own network either, and a
    // plain `fetch` would have followed.
    try {
      const response = await peerEgressFetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(config.peers.timeoutMs ?? 10_000),
      });

      if (!response.ok) {
        this.logger.warn(`directory ${url} → ${response.status}`);

        return null;
      }

      return (await response.json()) as unknown;
    } catch (error: unknown) {
      if (error instanceof EgressBlockedError) {
        this.logger.warn(`refusing directory URL ${url}: ${error.reason}`);

        return null;
      }

      // Discovery is best-effort: a directory outage must not break local asks.
      this.logger.warn(`directory ${url} failed: ${String(error)}`);

      return null;
    }
  }
}

function toDescriptor(row: PortalPeerRow): PeerDescriptor | null {
  const handle = typeof row?.handle === 'string' ? row.handle : null;
  const memoryEndpoint = typeof row?.memoryEndpoint === 'string' ? row.memoryEndpoint : null;

  if (!handle || !memoryEndpoint) {
    return null;
  }

  return {
    handle,
    displayName: typeof row.displayName === 'string' ? row.displayName : undefined,
    memoryEndpoint,
    issuer: typeof row.issuer === 'string' ? row.issuer : undefined,
    subject: typeof row.subject === 'string' ? row.subject : undefined,
  };
}
