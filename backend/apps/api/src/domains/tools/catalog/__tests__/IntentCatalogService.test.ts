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
    localCapable: true,
    ...extra,
  };
}

function fakeRegistry(schemas: unknown[]): ToolRegistry {
  return { getAvailableTools: () => schemas, getOutboundCatalogTools: () => schemas } as unknown as ToolRegistry;
}

describe('IntentCatalogService', () => {
  const schemas = [
    schema('people.find', 'people', { produces: ['person'], phrases: ['Find $name'] }),
    schema('memory.recall', 'memory', { produces: ['concept'] }),
    schema('media.streamingAvailability', 'media', { localCapable: false }),
  ];
  const service = new IntentCatalogService(fakeRegistry(schemas));

  it('builds a manifest (domains + entities + flattened, sorted intents) from the registry', () => {
    const manifest = service.getManifest();

    expect(manifest.version).toBe('1.2.0');
    expect(typeof manifest.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(false);
    expect(manifest.domains).toHaveLength(INTENT_DOMAINS.length);
    expect(manifest.entities).toHaveLength(CI_ENTITIES.length);
    expect(manifest.intents.map((i) => i.name)).toEqual([
      'media.streamingAvailability',
      'memory.recall',
      'people.find',
    ]);

    const peopleFind = manifest.intents.find((i) => i.name === 'people.find');
    expect(peopleFind?.tool).toBe('people_find');
    expect(peopleFind?.produces).toEqual(['person']);
    expect(peopleFind?.phrases).toEqual(['Find $name']);
  });

  it('publishes each tool’s own localCapable rather than a default', () => {
    const byName = new Map(service.getManifest().intents.map((i) => [i.name, i]));

    expect(byName.get('people.find')?.localCapable).toBe(true);
    expect(byName.get('media.streamingAvailability')?.localCapable).toBe(false);
  });

  it('exposes the domain and entity vocabularies directly', () => {
    expect(service.getDomains().map((d) => d.key)).toEqual(INTENT_DOMAINS.map((d) => d.key));
    expect(service.getEntities()).toHaveLength(CI_ENTITIES.length);
  });

  describe('per-tier dispatch rulings', () => {
    it('omits `dispatch` and `tier` entirely when no tier is asked for', () => {
      const manifest = service.getManifest();

      expect(manifest.tier).toBeUndefined();
      // Absent, not merely falsy: an on-device client distinguishes "this appliance does not
      // compute rulings" from "it ruled deny", and `dispatch: undefined` vs a present-but-empty
      // object is exactly that signal.
      expect(manifest.intents.every((i) => i.dispatch === undefined)).toBe(true);
    });

    it('attaches the server’s own ruling for the local tier', () => {
      const byName = new Map(service.getManifest({ tier: 'local' }).intents.map((i) => [i.name, i]));

      // localCapable + read + non-destructive + non-external ⇒ runnable on-device.
      expect(byName.get('people.find')?.dispatch?.decision).toBe('execute');
      // Not localCapable ⇒ queued for the appliance, with the reason a prompt can show.
      expect(byName.get('media.streamingAvailability')?.dispatch).toMatchObject({
        decision: 'queue',
        reason: 'not-local-capable',
      });
    });

    it('echoes the tier it computed for', () => {
      expect(service.getManifest({ tier: 'local' }).tier).toBe('local');
      expect(service.getManifest({ tier: 'appliance' }).tier).toBe('appliance');
    });

    it('rules the same intent differently per tier — which is why one is never published unasked', () => {
      const local = service
        .getManifest({ tier: 'local' })
        .intents.find((i) => i.name === 'media.streamingAvailability');
      const appliance = service
        .getManifest({ tier: 'appliance' })
        .intents.find((i) => i.name === 'media.streamingAvailability');

      expect(local?.dispatch?.decision).toBe('queue');
      expect(appliance?.dispatch?.decision).toBe('execute');
    });

    it('denies rather than queues when the caller’s capability is insufficient', () => {
      // Capability is checked before tier on purpose: queueing an unauthorized call would turn a
      // refusal into a pending action that succeeds after one extra tap.
      const writes = new IntentCatalogService(
        fakeRegistry([
          schema('memory.forget', 'memory', {
            privacy: { access: 'delete', sensitivity: 'personal', destructive: true, external: false },
          }),
        ]),
      );

      const ruling = writes.getManifest({ tier: 'local', capability: 'read' }).intents[0]?.dispatch;

      expect(ruling?.decision).toBe('deny');
      expect(ruling?.reason).toBe('capability-insufficient');
    });

    it('queues a destructive intent on-device even with full authority', () => {
      const destructive = new IntentCatalogService(
        fakeRegistry([
          schema('memory.forget', 'memory', {
            privacy: { access: 'delete', sensitivity: 'personal', destructive: true, external: false },
          }),
        ]),
      );

      expect(destructive.getManifest({ tier: 'local' }).intents[0]?.dispatch).toMatchObject({
        decision: 'queue',
        reason: 'destructive-requires-confirmation',
      });
    });
  });
});
