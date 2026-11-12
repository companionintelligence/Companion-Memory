import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';

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
        if (header.toLowerCase() === 'host') {
          return 'memory.example.ts.net';
        }

        return undefined;
      },
    } as unknown as Request;

    const meta = await controller.getMcpMetadata(fakeReq);
    expect(meta.resource).toBe('https://memory.example.ts.net/mcp');
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.dcr_supported).toBe(false);
    expect(meta.scopes_supported).toContain('mcp');
    expect(meta.bearer_methods_supported).toEqual(['header']);

    const rootMeta = await controller.getRootMetadata(fakeReq);
    expect(rootMeta.resource).toBe('https://memory.example.ts.net/mcp');
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
