import type { ToolRegistry } from '../../registry/ToolRegistry';
import { INTENT_DOMAINS } from '../domains';
import { CI_ENTITIES } from '../entities';
import { IntentCatalogService } from '../IntentCatalogService';

const READ = { access: 'read', sensitivity: 'personal', destructive: false, external: false } as const;

function schema(name: string, domain: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    domain,
    title: name,
    description: name,
    parameters: { type: 'object' },
    privacy: READ,
    ...extra,
  };
}

function fakeRegistry(schemas: unknown[]): ToolRegistry {
  return { getAvailableTools: () => schemas } as unknown as ToolRegistry;
}

describe('IntentCatalogService', () => {
  const schemas = [
    schema('people.find', 'people', { produces: ['person'], phrases: ['Find $name'] }),
    schema('memory.recall', 'memory', { produces: ['concept'] }),
  ];
  const service = new IntentCatalogService(fakeRegistry(schemas));

  it('builds a manifest (domains + entities + flattened, sorted intents) from the registry', () => {
    const manifest = service.getManifest();

    expect(manifest.version).toBe('1.0.0');
    expect(typeof manifest.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(false);
    expect(manifest.domains).toHaveLength(INTENT_DOMAINS.length);
    expect(manifest.entities).toHaveLength(CI_ENTITIES.length);
    expect(manifest.intents.map((i) => i.name)).toEqual(['memory.recall', 'people.find']);

    const peopleFind = manifest.intents.find((i) => i.name === 'people.find');
    expect(peopleFind?.tool).toBe('people_find');
    expect(peopleFind?.produces).toEqual(['person']);
    expect(peopleFind?.phrases).toEqual(['Find $name']);
  });

  it('exposes the domain and entity vocabularies directly', () => {
    expect(service.getDomains().map((d) => d.key)).toEqual(INTENT_DOMAINS.map((d) => d.key));
    expect(service.getEntities()).toHaveLength(CI_ENTITIES.length);
  });
});
