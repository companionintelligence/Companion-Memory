/* eslint-disable @typescript-eslint/no-explicit-any */
import { ToolRegistry } from '@ci/domains/tools';
import { NativeToolProvider } from '@ci/domains/tools/providers/NativeToolProvider';
import { CalendarFindEventsTool } from '@ci/domains/tools/tools/CalendarFindEventsTool';
import { DatabaseSearchTool } from '@ci/domains/tools/tools/DatabaseSearchTool';
import { ForgetKnowledgeTool } from '@ci/domains/tools/tools/ForgetKnowledgeTool';
import { GetEntertainmentPreferencesTool } from '@ci/domains/tools/tools/GetEntertainmentPreferencesTool';
import { GetFamilyMembersTool } from '@ci/domains/tools/tools/GetFamilyMembersTool';
import { GetStreamingAvailabilityTool } from '@ci/domains/tools/tools/GetStreamingAvailabilityTool';
import { GetUserPreferencesTool } from '@ci/domains/tools/tools/GetUserPreferencesTool';
import { MediaFindPhotosTool } from '@ci/domains/tools/tools/MediaFindPhotosTool';
import { PeopleFindTool } from '@ci/domains/tools/tools/PeopleFindTool';
import { PlacesFindTool } from '@ci/domains/tools/tools/PlacesFindTool';
import { ReadKnowledgeTool } from '@ci/domains/tools/tools/ReadKnowledgeTool';
import { WriteKnowledgeTool } from '@ci/domains/tools/tools/WriteKnowledgeTool';

import { IntentCatalogService } from '../../services/IntentCatalogService';
import { IntentsController } from '../IntentsController';

/**
 * End-to-end broadcast check: build the REAL controller → catalog → ToolRegistry chain with the
 * REAL tool classes and assert the controller publishes every tool's schema. The tools only touch
 * `logger.setContext` in their constructors, so we can instantiate them with a universal stub for
 * their (unused-here) service dependencies and read their real `schema`.
 */

// A callable proxy that returns itself for any property access — satisfies logger.setContext(...)
// and stands in for every injected service without being exercised.
const stub: any = new Proxy(function () {}, { get: () => stub, apply: () => stub });

const TOOL_CLASSES = [
  ReadKnowledgeTool,
  WriteKnowledgeTool,
  ForgetKnowledgeTool,
  DatabaseSearchTool,
  GetUserPreferencesTool,
  GetFamilyMembersTool,
  GetEntertainmentPreferencesTool,
  GetStreamingAvailabilityTool,
  PeopleFindTool,
  PlacesFindTool,
  CalendarFindEventsTool,
  MediaFindPhotosTool,
] as unknown as Array<new (...args: any[]) => any>;

const EXPECTED_INTENTS = [
  'calendar.findEvents',
  'knowledge.preferences',
  'knowledge.search',
  'media.entertainmentPreferences',
  'media.findPhotos',
  'media.streamingAvailability',
  'memory.forget',
  'memory.recall',
  'memory.remember',
  'people.find',
  'people.relationships',
  'places.find',
];

async function buildController(): Promise<IntentsController> {
  const tools = TOOL_CLASSES.map((Cls) => new Cls(...Array(Cls.length).fill(stub)));
  const provider = new NativeToolProvider(tools, stub);
  const registry = new ToolRegistry(stub, stub);
  await registry.registerProvider(provider);

  const catalog = new IntentCatalogService(registry);
  catalog.onModuleInit(); // boot-time domain validation over the real tools

  return new IntentsController(catalog);
}

describe('IntentsController broadcast (real tools)', () => {
  it('publishes the schema of every registered tool via GET /api/intents', async () => {
    const controller = await buildController();
    const manifest = controller.getManifest();

    // Every registered tool appears in the manifest, once.
    expect(manifest.intents.map((i) => i.name).sort()).toEqual(EXPECTED_INTENTS);

    // Each published entry carries a complete, executable schema.
    for (const intent of manifest.intents) {
      expect(intent.tool).toBe(intent.name.replace(/\./g, '_'));
      expect(intent.parameters.type).toBe('object');
      expect(['memory', 'knowledge', 'people', 'places', 'calendar', 'media']).toContain(intent.domain);
      expect(['read', 'write', 'delete']).toContain(intent.privacy.access);
      expect(intent.title).toBeTruthy();
      expect(intent.description).toBeTruthy();
    }

    // Domains + entities vocabulary is broadcast alongside the intents.
    expect(manifest.domains.length).toBeGreaterThan(0);
    expect(manifest.entities.length).toBeGreaterThan(0);
    expect(manifest.version).toBe('1.0.0');
  });

  it('broadcasts each tool’s real parameter schema (not a placeholder)', async () => {
    const controller = await buildController();
    const manifest = controller.getManifest();
    const byName = new Map(manifest.intents.map((i) => [i.name, i]));

    // memory.recall exposes ReadKnowledgeTool's own parameters.
    expect(byName.get('memory.recall')?.parameters.properties).toHaveProperty('personName');
    // knowledge.search exposes the full-text query parameter.
    expect(byName.get('knowledge.search')?.parameters.properties).toHaveProperty('query');
    // people.find is a curated specialization with its own narrow parameter set.
    expect(byName.get('people.find')?.parameters.properties).toHaveProperty('query');
    // media.streamingAvailability is flagged external.
    expect(byName.get('media.streamingAvailability')?.privacy.external).toBe(true);
    // memory.forget is flagged destructive.
    expect(byName.get('memory.forget')?.privacy.destructive).toBe(true);
  });

  it('serves a single intent by dotted name and 404s an unknown one', async () => {
    const controller = await buildController();

    expect(controller.getIntent('people.find').tool).toBe('people_find');
    expect(() => controller.getIntent('nope.notReal')).toThrow('Unknown intent: nope.notReal');
  });
});
