/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
import type { ManifestIntent } from '../types';

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

/**
 * The intents whose full declaration was large enough to matter on a phone (the ten largest of the
 * local tier, 13.5 of its 18 KB on 2026-10-12) and so carry a lean form. Asserted by name so that
 * dropping one is a decision, not a diff that quietly puts the schema bloat back.
 */
const EXPECTED_WITH_LEAN_FORM = [
  'knowledge.preferences',
  'knowledge.search',
  'media.entertainmentPreferences',
  'media.findPhotos',
  'memory.recall',
  'memory.remember',
  'planning.createTask',
  'planning.findTasks',
  'planning.scheduleTask',
  'planning.updateTask',
];

/** Every (path, schema) pair under `properties` / `items`, depth first, for the subset check. */
function walkProperties(schema: any, path: string[] = []): Array<[string[], any]> {
  const out: Array<[string[], any]> = [];
  for (const [key, child] of Object.entries<any>(schema.properties ?? {})) {
    out.push([[...path, key], child]);
    out.push(...walkProperties(child, [...path, key]));
    if (child.items) {
      out.push([[...path, key, '[]'], child.items]);
      out.push(...walkProperties(child.items, [...path, key, '[]']));
    }
  }

  return out;
}

function lookup(schema: any, path: string[]): any {
  let node = schema;
  for (const segment of path) {
    node = segment === '[]' ? node?.items : node?.properties?.[segment];
    if (!node) {
      return undefined;
    }
  }

  return node;
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
   * What a phone can bind. The iOS app hand-writes one struct per intent (`CompanionIntentTools.swift`) and looks each
   * one's ruling up in this manifest by its executable name, so a rename — or a flip to `queue` — here silently leaves
   * the on-device model without that tool; Android binds whatever is `execute` and follows on its own. Asserted by name,
   * like the list above: changing what the on-device tier may run is a decision, not a side effect.
   */
  it('tells the on-device tier it may run the three intents the iOS app binds, and to queue memory.forget', async () => {
    const manifest = (await buildCatalog()).getManifest({ tier: 'local' });
    const decisions = Object.fromEntries(manifest.intents.map((i) => [i.tool, i.dispatch?.decision]));

    expect(manifest.tier).toBe('local');
    expect(decisions).toMatchObject({
      knowledge_search: 'execute',
      memory_recall: 'execute',
      people_find: 'execute',
      memory_forget: 'queue',
    });
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

/**
 * What the phones send. Android binds whatever the manifest publishes, schema and all, so it cannot disagree with it.
 * iOS cannot work that way (LiteRT-LM's Swift `Tool` is a compile-time struct), so `CompanionIntentTools.swift`
 * hand-writes one per intent, and nothing but this test ties its argument names to the schema the appliance validates
 * against. It did not hold: `memory_recall` declared `query` / `startDate` / `endDate` where the schema takes
 * `personName`, `filters` and so on (zod strips what it does not know, so every call quietly returned the user's own
 * graph), and `memory_remember` sent `content` where `operations` is required (so every call failed validation). Both
 * typecheck, build and bind, and neither could be seen from either side.
 *
 * The rule is the simplest that rules those out: each `@ToolParam` is a same-named property of the intent's published
 * schema, `run()` sends exactly the parameters it declares, and everything the schema requires is a required parameter.
 */
describe('the on-device clients send arguments the published schemas accept', () => {
  const root = repoRoot();
  const IOS_TOOLS = join(root, 'frontend/apps/ios/ios/App/App/LocalLLM/CompanionIntentTools.swift');
  const ANDROID_PROVIDER = join(
    root,
    'frontend/packages/capacitor-local-llm/android/src/main/java/com/companionintelligence/localllm/intents/IntentToolProvider.kt',
  );

  /** The two structs this app used to bind (comments aside), so the check can be shown to fail on them. */
  const SHAPES_THE_APP_USED_TO_SEND = `
struct RecallMemoryTool: Tool {
  static let name = "memory_recall"
  static let description =
    "Recall what the user did, saw or discussed, optionally within a date range. Prefer this over guessing."

  @ToolParam(description: "What to recall, in the user's own words")
  var query: String

  @ToolParam(description: "Optional earliest date to consider, ISO-8601 (e.g. 2026-01-31)")
  var startDate: String?

  @ToolParam(description: "Optional latest date to consider, ISO-8601 (e.g. 2026-02-28)")
  var endDate: String?

  func run() async throws -> Any {
    var arguments: [String: Any] = ["query": query]
    if let startDate { arguments["startDate"] = startDate }
    if let endDate { arguments["endDate"] = endDate }

    return await CompanionToolContext.execute(Self.name, arguments: arguments)
  }
}

struct RememberTool: Tool {
  static let name = "memory_remember"
  static let description = "Save something to the user's memory so it can be recalled later."

  @ToolParam(description: "The text to remember, in the user's own words")
  var content: String

  func run() async throws -> Any {
    await CompanionToolContext.execute(Self.name, arguments: ["content": content])
  }
}
`;

  interface SwiftParam {
    name: string;
    type: string;
    optional: boolean;
  }

  interface SwiftTool {
    name: string;
    params: SwiftParam[];
    /** The argument keys `run()` puts on the wire. */
    sent: string[];
  }

  const SWIFT_TO_JSON_TYPE: Record<string, string> = {
    String: 'string',
    Int: 'integer',
    Bool: 'boolean',
    Double: 'number',
    Float: 'number',
  };

  /** Each `struct X: Tool` in the file: its executable name, its `@ToolParam`s, and the keys its `run()` sends. */
  function swiftTools(source: string): SwiftTool[] {
    // Comments quote argument names and types as prose; the code is what is sent.
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    const chunks = code.split(/^(?=struct \w+: Tool \{)/m).filter((chunk) => chunk.startsWith('struct '));

    return chunks.map((chunk) => {
      // `@ToolParam(…)` may wrap onto several lines; the declaration it decorates is the next `var`.
      const params = [
        ...chunk.matchAll(/@ToolParam\([\s\S]*?\)\s*\n\s*var (\w+):\s*(\[\w+\]|\w+)(\?)?/g),
      ].map((match) => ({ name: match[1], type: match[2], optional: match[3] === '?' }));

      const run = chunk.slice(Math.max(chunk.indexOf('func run()'), 0));
      const sent = [
        ...[...run.matchAll(/"(\w+)"\s*:/g)].map((match) => match[1]),
        ...[...run.matchAll(/\["(\w+)"\]/g)].map((match) => match[1]),
      ];

      return { name: /static let name = "([^"]+)"/.exec(chunk)?.[1] ?? '', params, sent: [...new Set(sent)] };
    });
  }

  /** Every way `source`'s tools disagree with what the appliance publishes; empty when they agree. */
  function contractViolations(source: string, intents: ManifestIntent[]): string[] {
    const byTool = new Map(intents.map((intent) => [intent.tool, intent]));
    const tools = swiftTools(source);
    const violations: string[] = [];

    if (tools.length === 0) {
      return ['no `struct X: Tool` was found, so nothing was checked'];
    }

    for (const tool of tools) {
      const intent = byTool.get(tool.name);

      if (!intent) {
        violations.push(`${tool.name}: no published intent has that executable name`);

        continue;
      }

      if (intent.dispatch?.decision !== 'execute') {
        violations.push(
          `${tool.name}: the local tier rules "${intent.dispatch?.decision}", so the phone could never run it`,
        );
      }

      const properties = intent.parameters.properties ?? {};
      const required = intent.parameters.required ?? [];

      for (const param of tool.params) {
        const schema = properties[param.name];

        if (!schema) {
          violations.push(
            `${tool.name}: "${param.name}" is not a property of the published schema (${Object.keys(properties).join(', ')})`,
          );

          continue;
        }

        const expected = param.type.startsWith('[') ? 'array' : SWIFT_TO_JSON_TYPE[param.type];

        if (schema.type && expected && schema.type !== expected) {
          violations.push(
            `${tool.name}: "${param.name}" is ${param.type} in Swift but "${schema.type}" in the schema`,
          );
        }

        if (required.includes(param.name) && param.optional) {
          violations.push(`${tool.name}: "${param.name}" is required by the schema but optional in Swift`);
        }
      }

      for (const key of required) {
        if (!tool.params.some((param) => param.name === key)) {
          violations.push(`${tool.name}: the schema requires "${key}" and the tool has no such parameter`);
        }
      }

      const declared = tool.params.map((param) => param.name).sort();
      const sent = [...tool.sent].sort();

      if (declared.join() !== sent.join()) {
        violations.push(
          `${tool.name}: run() sends [${sent.join(', ')}] but declares [${declared.join(', ')}]`,
        );
      }
    }

    return violations;
  }

  it('every tool the iOS app binds takes exactly the arguments of the intent it names', async () => {
    const { intents } = (await buildCatalog()).getManifest({ tier: 'local' });
    const source = readFileSync(IOS_TOOLS, 'utf8');

    // By name, like EXPECTED_INTENTS: which tools a 0.6B model is shown is a decision. `memory_remember` is not one of
    // them — the appliance has no intent the local tier may run that makes a Note, and a flat `content` can only fail
    // the `operations` schema — so re-adding it with that shape fails below before it reaches a phone.
    expect(
      swiftTools(source)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['knowledge_search', 'memory_recall', 'people_find']);
    expect(contractViolations(source, intents)).toEqual([]);
  });

  it('fails on the shapes the app used to send: memory_recall’s query / startDate / endDate, and memory_remember’s content', async () => {
    const { intents } = (await buildCatalog()).getManifest({ tier: 'local' });
    const violations = contractViolations(SHAPES_THE_APP_USED_TO_SEND, intents);

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('memory_recall: "query" is not a property of the published schema'),
        expect.stringContaining('memory_recall: "startDate" is not a property'),
        expect.stringContaining('memory_recall: "endDate" is not a property'),
        expect.stringContaining('memory_remember: "content" is not a property of the published schema'),
        expect.stringContaining('memory_remember: the schema requires "operations"'),
      ]),
    );
  });

  it('Android binds the published schema untouched, so it has nothing hand-written to drift', () => {
    // `IntentTool` hands LiteRT-LM the manifest's own `parameters`; a Kotlin copy of an argument name could drift the
    // way iOS's did, so the day one appears this should be the place that says so.
    expect(readFileSync(ANDROID_PROVIDER, 'utf8')).toMatch(/\.put\("parameters",\s*intent\.parameters\)/);
  });
  describe('the lean local-tier forms', () => {
    const instances = () => TOOL_CLASSES.map((Cls) => new Cls(...Array(Cls.length).fill(stub)));

    it('are carried by the intents whose full schemas were too large for a phone', () => {
      const registered = instances();
      const withLean = registered
        .filter((tool) => tool.schema.local)
        .map((tool) => tool.schema.name)
        .sort();

      expect(withLean).toEqual(
        EXPECTED_WITH_LEAN_FORM.filter((name) => registered.some((t) => t.schema.name === name)),
      );
    });

    it('are strict subsets of the full schema, so a call the phone makes is one the appliance accepts', () => {
      // Collected rather than asserted one by one: jest's `expect` takes no message, and "which
      // intent, which path" is the whole point of a failure here.
      const violations: string[] = [];

      for (const { schema } of instances()) {
        if (!schema.local) {
          continue;
        }

        const full = schema.parameters;
        const lean = schema.local.parameters;
        const where = `${schema.name}'s lean form`;

        if (lean.type !== 'object') {
          violations.push(`${where} is not an object schema`);
        }

        if (
          schema.local.description.length <= 20 ||
          schema.local.description.length >= schema.description.length
        ) {
          violations.push(`${where} description is not shorter than the full one (or is empty)`);
        }

        // Lean means lean: well under the full declaration.
        if (JSON.stringify(lean).length >= JSON.stringify(full).length) {
          violations.push(`${where} is not smaller than the full schema`);
        }

        for (const [path, leanNode] of walkProperties(lean)) {
          const fullNode = lookup(full, path);
          const at = `${where}: ${path.join('.')}`;

          if (!fullNode) {
            violations.push(`${at} does not exist in the full schema`);
            continue;
          }

          if (leanNode.type !== fullNode.type) {
            violations.push(`${at} changes type ${String(fullNode.type)} → ${String(leanNode.type)}`);
          }

          for (const value of leanNode.enum ?? []) {
            if (!fullNode.enum?.includes(value)) {
              violations.push(`${at} allows ${String(value)}, which the full schema does not`);
            }
          }

          for (const bound of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems'] as const) {
            if (leanNode[bound] !== undefined && leanNode[bound] !== fullNode[bound]) {
              violations.push(
                `${at}.${bound} is ${String(leanNode[bound])}, the full schema says ${String(fullNode[bound])}`,
              );
            }
          }

          // Whatever the appliance insists on at this level, the phone is told to send too.
          if (leanNode.properties) {
            for (const name of fullNode.required ?? []) {
              if (!leanNode.required?.includes(name)) {
                violations.push(`${at} drops required ${name}`);
              }
            }
          }
        }

        for (const name of full.required ?? []) {
          if (!lean.required?.includes(name)) {
            violations.push(`${where} drops required ${name}`);
          }
        }
      }

      expect(violations).toEqual([]);
    });

    it('are what the local tier is served, and nothing else is', async () => {
      const service = await buildCatalog();
      const local = new Map(service.getManifest({ tier: 'local' }).intents.map((i) => [i.name, i]));
      const full = new Map(service.getManifest().intents.map((i) => [i.name, i]));

      const search = local.get('knowledge.search');
      expect(search?.parameters).not.toEqual(full.get('knowledge.search')?.parameters);
      expect(Object.keys(search?.parameters.properties ?? {})).toEqual([
        'query',
        'entityTypes',
        'since',
        'until',
        'sort',
        'countOnly',
      ]);
      // An intent without a lean form is published to the local tier unchanged.
      expect(local.get('people.find')?.parameters).toEqual(full.get('people.find')?.parameters);
    });
  });
});

/** The directory holding both workspaces — the clients this test reads live under `frontend/`. */
function repoRoot(): string {
  let dir = __dirname;

  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'frontend')) && existsSync(join(dir, 'backend'))) {
      return dir;
    }

    dir = resolve(dir, '..');
  }

  throw new Error('repo root not found');
}
