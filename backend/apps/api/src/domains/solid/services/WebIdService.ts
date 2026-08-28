import { Injectable } from '@nestjs/common';

import config from '@ci/configuration';

/**
 * Mints the stable IRIs that make a CI-Server user addressable as a Solid
 * WebID. Every URL here must be absolute and stable across requests: other
 * agents dereference the WebID to discover the user's OIDC issuer and storage,
 * and they compare these IRIs byte-for-byte.
 *
 * The origin comes from `auth.oidc.publicBaseUrl` (the CI-Hub-injected
 * APP_BASE_URL — the same stable origin the OIDC redirect_uri is built from),
 * falling back to the inbound request origin for local/dev where no public
 * origin is configured. A user reached only at `*.localhost` still gets a
 * coherent (if non-federable) WebID that way.
 */
@Injectable()
export class WebIdService {
  /** Path prefix for every resource this facade serves. */
  static readonly BASE_PATH = '/solid';

  /**
   * Resolves the origin to build IRIs against. Configured origin wins so IRIs
   * stay stable regardless of the host the request arrived on; `requestOrigin`
   * (e.g. `https://ci-server.localhost`) is the dev fallback.
   */
  resolveOrigin(requestOrigin?: string): string {
    const configured = config.auth.oidc.publicBaseUrl?.trim();
    const origin = configured || requestOrigin?.trim() || '';

    return origin.replace(/\/+$/, '');
  }

  /** URL of the WebID Profile Document (the resource served by the controller). */
  profileDocumentUrl(origin: string, userId: string): string {
    return `${origin}${WebIdService.BASE_PATH}/profile/${encodeURIComponent(userId)}`;
  }

  /** The WebID itself — the `#me` subject within the profile document. */
  webId(origin: string, userId: string): string {
    return `${this.profileDocumentUrl(origin, userId)}#me`;
  }

  /**
   * Root container of the user's pod. The container itself is a later slice;
   * the WebID advertises it now via `pim:storage` so a Solid client knows where
   * this user's storage will live.
   */
  storageUrl(origin: string, userId: string): string {
    return `${origin}${WebIdService.BASE_PATH}/storage/${encodeURIComponent(userId)}/`;
  }

  /**
   * IRI of the entity container (the LDP `BasicContainer` listing a user's
   * entities). Trailing slash per LDP container convention.
   */
  entityContainerUrl(origin: string, userId: string): string {
    return `${this.storageUrl(origin, userId)}entity/`;
  }

  /**
   * IRI of a single entity resource within the user's pod. This URL *is* the
   * RDF subject the projection describes (the entity is the resource), and it
   * is the address the matching controller route serves.
   */
  entityResourceUrl(origin: string, userId: string, entityId: string): string {
    return `${this.entityContainerUrl(origin, userId)}${encodeURIComponent(entityId)}`;
  }

  /**
   * The Solid-OIDC issuer advertised in the profile (`solid:oidcIssuer`). This
   * is CI-Portal, which is becoming the platform IdP. Empty until configured —
   * callers omit the triple in that case rather than emit a broken IRI.
   */
  oidcIssuer(): string {
    return config.auth.oidc.issuerUrl?.trim() ?? '';
  }
}
