/* eslint-disable @typescript-eslint/no-explicit-any */
import { NativeToolProvider } from '../../providers/NativeToolProvider';
import { openGate } from '../../registry/__tests__/gateDouble';
import { ToolRegistry } from '../../registry/ToolRegistry';
import { AnomaliesRecentTool } from '../../tools/AnomaliesRecentTool';
import { BriefListTool } from '../../tools/BriefListTool';
import { CalendarFindEventsTool } from '../../tools/CalendarFindEventsTool';
import { DatabaseSearchTool } from '../../tools/DatabaseSearchTool';
import { ForecastCalibrationTool } from '../../tools/ForecastCalibrationTool';
import { ForecastReadTool } from '../../tools/ForecastReadTool';
import { ForgetKnowledgeTool } from '../../tools/ForgetKnowledgeTool';
import { GetEntertainmentPreferencesTool } from '../../tools/GetEntertainmentPreferencesTool';
import { GetFamilyMembersTool } from '../../tools/GetFamilyMembersTool';
import { GetStreamingAvailabilityTool } from '../../tools/GetStreamingAvailabilityTool';
import { GetUserPreferencesTool } from '../../tools/GetUserPreferencesTool';
import { InsightsExplainTool } from '../../tools/InsightsExplainTool';
import { MediaFindPhotosTool } from '../../tools/MediaFindPhotosTool';
import { PeopleFindTool } from '../../tools/PeopleFindTool';
import { PlacesFindTool } from '../../tools/PlacesFindTool';
import { PlacesNextTool } from '../../tools/PlacesNextTool';
import { ReadKnowledgeTool } from '../../tools/ReadKnowledgeTool';
import { SuggestionsFeedbackTool } from '../../tools/SuggestionsFeedbackTool';
import { SuggestionsListTool } from '../../tools/SuggestionsListTool';
import { WriteKnowledgeTool } from '../../tools/WriteKnowledgeTool';
import { IntentCatalogService } from '../IntentCatalogService';

/**
 * End-to-end broadcast check with the REAL tool classes: build the ToolRegistry from the real
 * tools and assert the catalog publishes every tool's schema. The tools only touch
 * `logger.setContext` in their constructors, so a universal stub stands in for their (unused-here)
 * service dependencies while we read their real `schema`.
 */
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
  PlacesNextTool,
  CalendarFindEventsTool,
  MediaFindPhotosTool,
  ForecastCalibrationTool,
  ForecastReadTool,
  BriefListTool,
  InsightsExplainTool,
  AnomaliesRecentTool,
  SuggestionsListTool,
  SuggestionsFeedbackTool,
] as unknown as Array<new (...args: any[]) => any>;

const EXPECTED_INTENTS = [
  'anomalies.recent',
  'brief.list',
  'calendar.findEvents',
  'forecast.calibration',
  'forecast.read',
  'insights.explain',
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
  'places.next',
  'suggestions.feedback',
  'suggestions.list',
];

/**
 * The intents the on-device tier may NOT stand in for, and why — asserted by name rather than
 * derived, so flipping a label is a decision someone makes in this list rather than a diff that
 * quietly widens (or narrows) the offline surface.
 */
const EXPECTED_NOT_LOCAL_CAPABLE = [
  // HBPE is a server-only inference / scoring pipeline.
  'forecast.calibration',
  'forecast.read',
  // Live TMDB availability: exists nowhere on the device.
  'media.streamingAvailability',
  // A delete is authoritative on the appliance; a partial mirror cannot show what it would remove.
  'memory.forget',
];

async function buildCatalog(): Promise<IntentCatalogService> {
  const tools = TOOL_CLASSES.map((Cls) => new Cls(...Array(Cls.length).fill(stub)));
  const registry = new ToolRegistry(stub, stub, openGate().double);
  await registry.registerProvider(new NativeToolProvider(tools, stub));

  return new IntentCatalogService(registry);
}

describe('IntentCatalogService broadcast (real tools)', () => {
  it('publishes the schema of every registered tool', async () => {
    const manifest = (await buildCatalog()).getManifest();

    expect(manifest.intents.map((i) => i.name).sort()).toEqual(EXPECTED_INTENTS);

    for (const intent of manifest.intents) {
      expect(intent.tool).toBe(intent.name.replace(/\./g, '_'));
      expect(intent.parameters.type).toBe('object');
      expect([
        'memory',
        'knowledge',
        'people',
        'places',
        'calendar',
        'media',
        'forecast',
        'brief',
        'insights',
        'anomalies',
        'suggestions',
      ]).toContain(intent.domain);
      expect(['read', 'write', 'delete']).toContain(intent.privacy.access);
      expect(intent.title).toBeTruthy();
      expect(intent.description).toBeTruthy();
      // Published, never inferred: a client deciding offline behaviour reads this field and has
      // nothing to fall back on if it is missing.
      expect(typeof intent.localCapable).toBe('boolean');
    }

    expect(manifest.domains.length).toBeGreaterThan(0);
    expect(manifest.entities.length).toBeGreaterThan(0);
  });

  it('broadcasts each tool’s real input schema and flags (not placeholders)', async () => {
    const manifest = (await buildCatalog()).getManifest();
    const byName = new Map(manifest.intents.map((i) => [i.name, i]));

    expect(byName.get('memory.recall')?.parameters.properties).toHaveProperty('personName');
    expect(byName.get('knowledge.search')?.parameters.properties).toHaveProperty('query');
    expect(byName.get('people.find')?.parameters.properties).toHaveProperty('query');
    expect(byName.get('media.streamingAvailability')?.privacy.external).toBe(true);
    expect(byName.get('memory.forget')?.privacy.destructive).toBe(true);
  });

  it('publishes localCapable per intent, and only these are not local-capable', async () => {
    const manifest = (await buildCatalog()).getManifest();

    expect(manifest.intents.filter((i) => !i.localCapable).map((i) => i.name)).toEqual(
      EXPECTED_NOT_LOCAL_CAPABLE,
    );
  });

  /**
   * The invariant ToolsRegistrationService fails the boot on. Asserted against the real catalog
   * too, because the boot check only protects a running appliance — this protects the manifest a
   * device may have cached from a build that never booted here.
   */
  it('never claims an external intent is servable from on-device data', async () => {
    const manifest = (await buildCatalog()).getManifest();

    for (const intent of manifest.intents) {
      if (intent.privacy.external) {
        expect(intent.localCapable).toBe(false);
      }
    }
  });

  it('carries enough per intent for a client to run resolveDispatch without asking the server', async () => {
    const manifest = (await buildCatalog()).getManifest();

    for (const intent of manifest.intents) {
      expect(intent).toEqual(
        expect.objectContaining({
          name: expect.any(String),
          localCapable: expect.any(Boolean),
          privacy: expect.objectContaining({
            access: expect.any(String),
            destructive: expect.any(Boolean),
            external: expect.any(Boolean),
          }),
        }),
      );
    }
  });
});
