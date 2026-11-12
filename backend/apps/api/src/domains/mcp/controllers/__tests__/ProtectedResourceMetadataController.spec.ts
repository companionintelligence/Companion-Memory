import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';

import { FeatureService } from '@ci/common/feature';
import config from '@ci/configuration';

import { isValidCimdClientId, validateCimdDocument } from '../../services/CimdValidator';
import { ProtectedResourceMetadataController } from '../ProtectedResourceMetadataController';

describe('ProtectedResourceMetadataController (RFC 9728)', () => {
  it('throws NotFoundException when mcp.prm feature flag is disabled', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(false),
    } as never;
    const controller = new ProtectedResourceMetadataController(mockFeatures);
    const fakeReq = {
      protocol: 'https',
      get: () => 'memory.example.ts.net',
    } as unknown as Request;

    await expect(controller.getRootMetadata(fakeReq)).rejects.toThrow(NotFoundException);
    await expect(controller.getMcpMetadata(fakeReq)).rejects.toThrow(NotFoundException);
  });

  it('returns RFC 9728 metadata with CIMD enabled and DCR disabled when feature flag is enabled', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new ProtectedResourceMetadataController(mockFeatures);
    const fakeReq = {
      protocol: 'https',
      get: (header: string) => {
        const lower = header.toLowerCase();
        if (lower === 'host') {
          return 'memory.example.ts.net';
        }

        if (lower === 'x-forwarded-host') {
          return 'evil.attacker.example';
        }

        return undefined;
      },
    } as unknown as Request;

    const prevPublicBaseUrl = config.auth.oidc.publicBaseUrl;
    const prevCiPortalUrl = config.ciPortal.url;
    const prevIssuerUrl = config.auth.oidc.issuerUrl;
    try {
      config.auth.oidc.publicBaseUrl = '';
      config.ciPortal.url = 'https://portal.custom.example/';

      const meta = await controller.getMcpMetadata(fakeReq);
      // Must ignore x-forwarded-host spoofing when deriving resource URI from Host
      expect(meta.resource).toBe('https://memory.example.ts.net/mcp');
      expect(meta.authorization_servers).toEqual(['https://portal.custom.example']);
      expect(meta.client_id_metadata_document_supported).toBe(true);
      expect(meta.dcr_supported).toBe(false);
      expect(meta.scopes_supported).toContain('mcp');
      expect(meta.bearer_methods_supported).toEqual(['header']);

      const rootMeta = await controller.getRootMetadata(fakeReq);
      expect(rootMeta.resource).toBe('https://memory.example.ts.net/mcp');
    } finally {
      config.auth.oidc.publicBaseUrl = prevPublicBaseUrl;
      config.ciPortal.url = prevCiPortalUrl;
      config.auth.oidc.issuerUrl = prevIssuerUrl;
    }
  });

  it('prefers configured publicBaseUrl and falls back through issuerUrl to default portal', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new ProtectedResourceMetadataController(mockFeatures);
    const fakeReq = {
      protocol: 'http',
      get: () => 'internal-pod:3000',
    } as unknown as Request;

    const prevPublicBaseUrl = config.auth.oidc.publicBaseUrl;
    const prevCiPortalUrl = config.ciPortal.url;
    const prevIssuerUrl = config.auth.oidc.issuerUrl;
    try {
      config.auth.oidc.publicBaseUrl = 'https://box.tailnet.ts.net/';
      config.ciPortal.url = '';
      config.auth.oidc.issuerUrl = 'https://auth.tailnet.ts.net/';

      const metaWithIssuer = await controller.getMcpMetadata(fakeReq);
      expect(metaWithIssuer.resource).toBe('https://box.tailnet.ts.net/mcp');
      expect(metaWithIssuer.authorization_servers).toEqual(['https://auth.tailnet.ts.net']);

      config.auth.oidc.issuerUrl = '';
      const metaDefault = await controller.getRootMetadata(fakeReq);
      expect(metaDefault.authorization_servers).toEqual(['https://portal.ci.computer']);
    } finally {
      config.auth.oidc.publicBaseUrl = prevPublicBaseUrl;
      config.ciPortal.url = prevCiPortalUrl;
      config.auth.oidc.issuerUrl = prevIssuerUrl;
    }
  });

  it('serves HTTP 404 when disabled and 200 JSON over Nest HTTP pipeline when enabled', async () => {
    let enabled = false;
    const moduleRef = await Test.createTestingModule({
      controllers: [ProtectedResourceMetadataController],
      providers: [
        {
          provide: FeatureService,
          useValue: { isFeatureEnabled: jest.fn(async () => enabled) },
        },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const server = app.getHttpServer();

      await request(server).get('/.well-known/oauth-protected-resource').expect(404);
      await request(server).get('/.well-known/oauth-protected-resource/mcp').expect(404);

      enabled = true;
      const rootRes = await request(server).get('/.well-known/oauth-protected-resource').expect(200);
      expect(rootRes.body).toMatchObject({
        resource: expect.stringMatching(/\/mcp$/),
        client_id_metadata_document_supported: true,
        dcr_supported: false,
      });

      const mcpRes = await request(server).get('/.well-known/oauth-protected-resource/mcp').expect(200);
      expect(mcpRes.body.bearer_methods_supported).toEqual(['header']);
    } finally {
      await app.close();
    }
  });
});

describe('CimdValidator', () => {
  it('accepts valid HTTPS public domain CIMD URLs and documents', () => {
    const clientId = 'https://app.example.com/.well-known/oauth-client.json';
    expect(isValidCimdClientId(clientId)).toBe(true);

    const result = validateCimdDocument(clientId, {
      client_id: clientId,
      client_name: 'Example Agent',
      redirect_uris: ['https://app.example.com/callback'],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects HTTP, IP literals, localhost, and mismatched client_id documents', () => {
    expect(isValidCimdClientId('http://app.example.com/client.json')).toBe(false);
    expect(isValidCimdClientId('https://127.0.0.1/client.json')).toBe(false);
    expect(isValidCimdClientId('https://[::1]/client.json')).toBe(false);
    expect(isValidCimdClientId('https://localhost/client.json')).toBe(false);
    expect(isValidCimdClientId('https://app.example.com/')).toBe(false);

    const mismatched = validateCimdDocument('https://app.example.com/client.json', {
      client_id: 'https://evil.example.com/client.json',
      client_name: 'Evil',
      redirect_uris: ['https://evil.example.com/cb'],
    });
    expect(mismatched.valid).toBe(false);
  });
});
