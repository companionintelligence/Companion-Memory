import { Controller, Get, NotFoundException, Req } from '@nestjs/common';
import type { Request } from 'express';

import { FeatureService } from '@ci/common/feature';
import config from '@ci/configuration';

/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata for Companion Memory's MCP server (MCP 2026-07-28).
 *
 * Advertises the authorization server (CI-Portal), supported MCP scopes, Client ID Metadata
 * Document (CIMD) support, and explicit deprecation of Dynamic Client Registration (DCR).
 * Gated by the `mcp.prm` feature flag (off by default; returns 404 when disabled).
 */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ['header'];
  resource_name: string;
  client_id_metadata_document_supported: true;
  dcr_supported: false;
}

@Controller('.well-known/oauth-protected-resource')
export class ProtectedResourceMetadataController {
  constructor(private readonly features: FeatureService) {}

  @Get()
  async getRootMetadata(@Req() req: Request): Promise<ProtectedResourceMetadata> {
    if (!(await this.features.isFeatureEnabled('mcp.prm'))) {
      throw new NotFoundException();
    }

    return this.buildMetadata(req);
  }

  @Get('mcp')
  async getMcpMetadata(@Req() req: Request): Promise<ProtectedResourceMetadata> {
    if (!(await this.features.isFeatureEnabled('mcp.prm'))) {
      throw new NotFoundException();
    }

    return this.buildMetadata(req);
  }

  private buildMetadata(req: Request): ProtectedResourceMetadata {
    const proto = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol || 'http';
    const host = req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host') || 'localhost';
    const resource = `${proto}://${host}/mcp`;
    const portalBase =
      (config.ciPortal as { baseUrl?: string } | undefined)?.baseUrl?.replace(/\/+$/, '') ||
      'https://portal.ci.computer';

    return {
      resource,
      authorization_servers: [portalBase],
      scopes_supported: ['mcp', 'memory:read', 'memory:write', 'asks:send'],
      bearer_methods_supported: ['header'],
      resource_name: 'Companion Memory MCP',
      client_id_metadata_document_supported: true,
      dcr_supported: false,
    };
  }
}
