import { getProviderCatalogByKey, listProviderCatalog, type SyncResponse } from '@ci/domains/connections';

import { createConnectionSyncResponseAdapter } from '../adapters/ConnectionSyncResponseAdapters';
import { ConnectionPipelineOrchestrator } from '../ConnectionPipelineOrchestrator';

describe('ConnectionSyncResponseAdapters', () => {
  const orchestrator = new ConnectionPipelineOrchestrator();

  const context = {
    request: { userId: 'test-user-id' },
    connection: {
      id: 'conn-1',
      providerId: 'provider-1',
      userId: 'test-user-id',
      activeEndpoints: [],
      syncState: {},
    },
  };

  function providerOrThrow(key: string) {
    const provider = getProviderCatalogByKey(key);
    if (!provider) {
      throw new Error(`Missing provider catalog entry for ${key}`);
    }

    return provider;
  }

  it('maps active provider API scope aliases to ETL kinds', async () => {
    const cases: Array<{
      providerKey: string;
      scopeSamples: string[];
      expectedKinds: string[];
      checkpoint?: Record<string, unknown>;
    }> = [
      {
        providerKey: 'google',
        scopeSamples: ['Gmail', 'Google Calendar', 'Google Drive', 'Google Contacts', 'YouTube'],
        expectedKinds: ['communication', 'event', 'file', 'person', 'media'],
        checkpoint: { googleToken: 'token-1' },
      },
      {
        providerKey: 'microsoft',
        scopeSamples: [
          'Microsoft Graph - Mail',
          'Microsoft Graph - Calendar',
          'Microsoft Graph - OneDrive Files',
        ],
        expectedKinds: ['communication', 'event', 'file'],
      },
      {
        providerKey: 'facebook',
        scopeSamples: ['facebook profile', 'facebook posts', 'facebook photos', 'facebook likes'],
        expectedKinds: ['person', 'social', 'media', 'social'],
      },
    ];

    for (const testCase of cases) {
      const adapter = createConnectionSyncResponseAdapter(providerOrThrow(testCase.providerKey), [
        {
          success: true,
          message: 'ok',
          data: {
            results: testCase.scopeSamples.map((scope, index) => ({
              api: scope,
              data: { id: `${testCase.providerKey}-${index}` },
            })),
            errors: [],
          },
          cursor: testCase.checkpoint ?? {},
        },
      ]);

      const result = await orchestrator.run(adapter, context);
      expect(result.transform.records.map((record) => record.kind)).toEqual(testCase.expectedKinds);

      if (testCase.checkpoint) {
        expect(result.extract.checkpoint).toEqual(testCase.checkpoint);
      }
    }
  });

  it('classifies stream keys for every provider in catalog', async () => {
    for (const provider of listProviderCatalog()) {
      const responses: SyncResponse[] = [
        {
          success: true,
          message: 'ok',
          data: {
            results: provider.streams.map((stream, index) => ({
              api: stream.key,
              data: { id: `${provider.key}-${index}` },
            })),
            errors: [],
          },
          cursor: { streamCursor: provider.key },
        },
      ];

      const adapter = createConnectionSyncResponseAdapter(provider, responses);
      const result = await orchestrator.run(adapter, context);

      expect(result.load.writtenCount).toBe(provider.streams.length);
      expect(result.transform.records.every((record) => record.kind !== 'raw')).toBe(true);
    }
  });

  it('classifies map key aliases and propagates response errors', async () => {
    const reddit = providerOrThrow('reddit');
    const responses: SyncResponse[] = [
      {
        success: true,
        message: 'ok',
        data: {
          results: [{ api: 'ThreadsSubmitted', data: { id: 'thread-1' } }],
          errors: [],
        },
      },
      {
        success: false,
        message: 'reddit endpoint failed',
        data: {
          results: [],
          errors: ['reddit endpoint failed'],
        },
      },
    ];

    const adapter = createConnectionSyncResponseAdapter(reddit, responses);
    const result = await orchestrator.run(adapter, context);

    expect(result.transform.records.map((record) => record.kind)).toEqual(['social']);
    expect(result.extract.errors).toContain('reddit endpoint failed');
    expect(result.load.errors).toContain('reddit endpoint failed');
  });
});
