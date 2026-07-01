import { INTENT_DOMAINS } from '../catalog/domains';
import { CI_ENTITIES } from '../catalog/entities';
import { IntentRegistry } from '../services/IntentRegistry';
import { intentToolName } from '../types';

describe('IntentRegistry', () => {
  const registry = new IntentRegistry();

  it('validates the static catalog at construction without throwing', () => {
    expect(() => new IntentRegistry()).not.toThrow();
    expect(registry.getIntents().length).toBeGreaterThan(0);
  });

  it('names every intent "<domain>.<action>" with a registered domain', () => {
    const domainKeys = new Set(INTENT_DOMAINS.map((d) => d.key));

    for (const intent of registry.getIntents()) {
      expect(intent.name).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
      expect(intent.name.split('.')[0]).toBe(intent.domain);
      expect(domainKeys.has(intent.domain)).toBe(true);
    }
  });

  it('derives unique, MCP/OpenAI-safe tool names (no dots)', () => {
    const toolNames = registry.getIntents().map((i) => intentToolName(i.name));
    const safe = /^[a-zA-Z0-9_]+$/;

    for (const name of toolNames) {
      expect(name).toMatch(safe);
      expect(name).not.toContain('.');
    }

    expect(new Set(toolNames).size).toBe(toolNames.length);
  });

  it('every intent carries a privacy label and binds to a native tool', () => {
    for (const intent of registry.getIntents()) {
      expect(intent.privacy).toBeDefined();
      expect(['read', 'write', 'delete']).toContain(intent.privacy.access);
      expect(intent.binding.kind).toBe('native-tool');
      expect(intent.binding.tool).toBeTruthy();
    }
  });

  it('flags exactly the destructive and external intents', () => {
    const destructive = registry
      .getIntents()
      .filter((i) => i.privacy.destructive)
      .map((i) => i.name);
    const external = registry
      .getIntents()
      .filter((i) => i.privacy.external)
      .map((i) => i.name);

    expect(destructive).toEqual(['memory.forget']);
    expect(external).toEqual(['media.streamingAvailability']);
  });

  it('groups intents by domain', () => {
    const memory = registry.getIntentsByDomain('memory').map((i) => i.name);

    expect(memory).toEqual(expect.arrayContaining(['memory.recall', 'memory.remember', 'memory.forget']));
    expect(registry.getIntentsByDomain('nope')).toEqual([]);
  });

  it('lists the raw tools intents supersede (their binding targets), de-duplicated', () => {
    const superseded = registry.getSupersededToolNames();

    expect(superseded).toEqual(
      expect.arrayContaining(['databaseSearch', 'getFamilyMembers', 'readKnowledge', 'forgetKnowledge']),
    );
    expect(new Set(superseded).size).toBe(superseded.length);
    // databaseSearch backs several intents but appears once.
    expect(superseded.filter((t) => t === 'databaseSearch')).toHaveLength(1);
  });

  it('resolves intents by dotted name and by tool name', () => {
    const intent = registry.getIntent('people.find');

    expect(intent?.domain).toBe('people');
    expect(registry.getIntentByToolName('people_find')?.name).toBe('people.find');
    expect(registry.getIntent('does.notExist')).toBeUndefined();
  });

  it('builds a deterministic manifest with domains, entities, and flattened intents', () => {
    const manifest = registry.buildManifest('2026-06-28T00:00:00.000Z');

    expect(manifest.version).toBe('1.0.0');
    expect(manifest.generatedAt).toBe('2026-06-28T00:00:00.000Z');
    expect(manifest.domains).toHaveLength(INTENT_DOMAINS.length);
    expect(manifest.entities).toHaveLength(CI_ENTITIES.length);
    expect(manifest.intents).toHaveLength(registry.getIntents().length);

    const peopleFind = manifest.intents.find((i) => i.name === 'people.find');
    expect(peopleFind?.tool).toBe('people_find');
    expect(peopleFind?.produces).toEqual(['person']);
    expect(Array.isArray(peopleFind?.phrases)).toBe(true);
  });
});
