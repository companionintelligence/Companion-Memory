import { Injectable } from '@nestjs/common';

import type { IntentManifest } from '../types';

import { IntentRegistry } from './IntentRegistry';

/**
 * Public read API over the intent catalog. Thin today (stamps the manifest time),
 * but the single seam through which REST, the MCP resource, and CI-Hub app
 * registration will read the catalog.
 */
@Injectable()
export class IntentCatalogService {
  constructor(private readonly registry: IntentRegistry) {}

  /** The full discoverable capability declaration. */
  getManifest(): IntentManifest {
    return this.registry.buildManifest(new Date().toISOString());
  }
}
