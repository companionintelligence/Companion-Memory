import type { IntentCatalogService, IntentManifest } from '@ci/domains/tools';

import { IntentsController } from '../IntentsController';

/**
 * The controller is a thin publisher over the tools-domain IntentCatalogService, so it's tested
 * against a stub catalog (public API only — no reach into tools internals). The end-to-end
 * "real tools broadcast their full schema" check lives with the catalog in the tools domain.
 */
const MANIFEST: IntentManifest = {
  version: '1.0.0',
  generatedAt: '2026-06-30T00:00:00.000Z',
  domains: [{ key: 'people', title: 'People', description: 'People and relationships.' }],
  entities: [{ type: 'person', title: 'Person', description: 'A person.', idKind: 'global-uid' }],
  intents: [
    {
      name: 'people.find',
      tool: 'people_find',
      domain: 'people',
      title: 'Find people',
      description: 'Find people in the social graph.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
      consumes: [],
      produces: ['person'],
      phrases: ['Find $name'],
    },
  ],
};

function controllerWith(manifest: IntentManifest = MANIFEST): IntentsController {
  const catalog = {
    getManifest: () => manifest,
    getDomains: () => manifest.domains,
    getEntities: () => manifest.entities,
  } as unknown as IntentCatalogService;

  return new IntentsController(catalog);
}

describe('IntentsController', () => {
  it('publishes the full manifest', () => {
    expect(controllerWith().getManifest()).toEqual(MANIFEST);
  });

  it('exposes the domain and entity vocabularies', () => {
    expect(controllerWith().getDomains()).toEqual({ domains: MANIFEST.domains });
    expect(controllerWith().getEntities()).toEqual({ entities: MANIFEST.entities });
  });

  it('serves a single intent by its dotted name', () => {
    expect(controllerWith().getIntent('people.find').tool).toBe('people_find');
  });

  it('404s an unknown intent', () => {
    expect(() => controllerWith().getIntent('nope.notReal')).toThrow('Unknown intent: nope.notReal');
  });
});
