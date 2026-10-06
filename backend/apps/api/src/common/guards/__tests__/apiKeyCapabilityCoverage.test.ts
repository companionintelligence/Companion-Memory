import 'reflect-metadata';

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { type ExecutionContext, RequestMethod } from '@nestjs/common';

import {
  type ApiKeyCapability,
  FULL_CAPABILITY,
  READ_CAPABILITY,
  REQUIRE_CAPABILITY_KEY,
  REQUIRE_SCOPES_KEY,
} from '@ci/common/decorators';

import { AgentJobsController } from '../../../domains/agent/controllers/AgentJobsController';
import { IntentsController } from '../../../domains/agent/controllers/IntentsController';
import { MemoryController } from '../../../domains/agent/controllers/MemoryController';
import { AccountDataController } from '../../../domains/auth/controllers/AccountDataController';
import { DeviceController } from '../../../domains/devices/controllers/DeviceController';
import { JobsController } from '../../../domains/events/controllers/JobsController';
import { FilesController } from '../../../domains/files/controllers/FilesController';
import { BulkIngestController } from '../../../domains/ingest/controllers/BulkIngestController';
import { IngestLifecycleController } from '../../../domains/ingest/controllers/IngestLifecycleController';
import { MaintenanceController } from '../../../domains/maintenance/controllers/MaintenanceController';
import { McpController } from '../../../domains/mcp/controllers/McpController';
import { DESTRUCTIVE_MUTATION_PREFIXES } from '../../../domains/mcp/services/GraphQLToolAdapter';
import { PersonaIntelligenceController } from '../../../domains/persona/controllers/PersonaIntelligenceController';
import { PrivacyController } from '../../../domains/privacy/controllers/PrivacyController';
import { PendingActionsController } from '../../../domains/tools/controllers/PendingActionsController';
import { ApiKeyGuard } from '../ApiKeyGuard';
import { type ApiKeyScopedRequest, capabilityImpliedByShape } from '../apiKeyScopeEnforcement';
import { JwtOrApiKeyAuthGuard } from '../JwtOrApiKeyAuthGuard';

/**
 * The invariant that makes read-only mean something.
 *
 * `@RequireScopes` marks a route as reachable by a scope-limited api key, and deny-by-default means
 * such a key can reach NOTHING else. So annotating every scoped route with `@RequireCapability`
 * makes capability enforcement complete for those keys — and missing one leaves a hole exactly where
 * the settings UI has promised there is none ("Read-only — cannot record or change anything").
 *
 * Asserted by reading the metadata off the real controllers rather than by reviewing the source, so
 * a route added later cannot quietly opt out of the second axis while opting into the first.
 */
const SCOPED_CONTROLLERS = [
  MemoryController,
  IntentsController,
  AgentJobsController,
  McpController,
  PersonaIntelligenceController,
  // `/v1/agent/jobs`, dispatch to an agent harness. Class-level `agent-jobs` scope,
  // per-route capability. It arrived with #2558 and was not added here, which is
  // precisely what the tree scan at the bottom of this file is for: the routes
  // were correctly annotated, so nothing was reachable that should not have
  // been, but the suite was not WATCHING them and would not have noticed if the
  // next route on this controller had shipped without a capability.
  AgentJobsController,
  // The `capture` tier. Both grant at the CLASS level, which is why
  // effectiveMetadata() below falls back to the class — a per-method scan alone
  // would see these as unscoped and skip the capability assertion entirely.
  FilesController,
  BulkIngestController,
  // A capture agent's own device record and the bulk-load `finish` step, opened to the capture
  // scope per route so a capture client's Portal token keeps working once it is confined to it.
  DeviceController,
  IngestLifecycleController,
  PendingActionsController,
  // Added by #2558; every route already declared a capability, only this
  // hand-maintained mirror had not caught up.
  AgentJobsController,
];

/** Every own method on a controller prototype (route handlers and helpers alike). */
function methodsOf(controller: new (...args: never[]) => object): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor');
}

/** Metadata as the guards read it: a method's own value, else the class's. */
function effectiveMetadata(
  key: string,
  controller: new (...args: never[]) => object,
  method: string,
): unknown {
  const handler = (controller.prototype as Record<string, unknown>)[method];
  const onHandler = typeof handler === 'function' ? Reflect.getMetadata(key, handler) : undefined;

  return onHandler ?? Reflect.getMetadata(key, controller);
}

describe('every api-key-reachable route declares a capability', () => {
  for (const controller of SCOPED_CONTROLLERS) {
    describe(controller.name, () => {
      for (const method of methodsOf(controller)) {
        const scopes = effectiveMetadata(REQUIRE_SCOPES_KEY, controller, method);

        // Only routes that grant a scope are reachable by a scope-limited key; helpers and
        // un-scoped methods are out of the api-key surface entirely.
        if (!Array.isArray(scopes) || scopes.length === 0) {
          continue;
        }

        it(`${method} states what it may do, not only where it lives`, () => {
          expect(effectiveMetadata(REQUIRE_CAPABILITY_KEY, controller, method)).toBeDefined();
        });
      }
    });
  }

  it('covers the routes it claims to — the controllers really do declare scopes', () => {
    // Guards the guard: if the metadata keys or decorators were ever renamed, every assertion above
    // would vacuously pass on an empty loop, and this suite would report green while checking nothing.
    const scoped = SCOPED_CONTROLLERS.flatMap((controller) =>
      methodsOf(controller).filter((method) => {
        const scopes = effectiveMetadata(REQUIRE_SCOPES_KEY, controller, method);

        return Array.isArray(scopes) && scopes.length > 0;
      }),
    );

    expect(scoped.length).toBeGreaterThanOrEqual(5);
  });

  it('checks every scoped controller in the tree, not just the ones listed here', () => {
    // The assertions above iterate SCOPED_CONTROLLERS, a hand-written list. That catches a new
    // ROUTE on a known controller, but a whole new CONTROLLER applying @RequireScopes would never
    // be looked at — it would grant a scope-limited key a reachable route with no capability
    // declared, which is the exact hole this suite exists to prevent, arriving by the one door the
    // suite does not watch.
    //
    // So the list is checked against the source tree rather than trusted. Scanning text (not the
    // Nest container) keeps this a unit test: importing every module to walk the DI graph would
    // pull in database and queue wiring for an assertion about decorators.
    const listed = new Set(SCOPED_CONTROLLERS.map((controller) => controller.name));
    const found = new Set<string>();

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
          // The decorator's own definition and its usage examples are not applications of it.
          if (entry.name !== '__tests__' && entry.name !== 'decorators') {
            walk(path);
          }

          continue;
        }

        if (entry.name.endsWith('.ts') && readFileSync(path, 'utf8').includes('@RequireScopes(')) {
          found.add(entry.name.replace(/\.ts$/, ''));
        }
      }
    };

    walk(resolve(__dirname, '..', '..', '..'));

    expect([...found].sort()).toEqual([...listed].sort());
  });
});

// ─── Destructive routes ────────────────────────────────────────────────────────
//
// The settings UI promises that a "Read & write" key records and updates but never deletes, and
// MCP has always refused it every tool labelled destructive. The REST and GraphQL planes did not:
// an undeclared DELETE and every GraphQL mutation were priced at `write` by shape, so the same key
// MCP refused `deleteNote` could POST it to /graphql. The suites below pin each door that loses data
// to `full`, by reading what the guard reads (Reflect metadata), across the whole tree.

type ControllerClass = abstract new (...args: never[]) => object;

const SRC_ROOT = resolve(__dirname, '..', '..', '..');
const GUARDS_METADATA = '__guards__';
const METHOD_METADATA = 'method';

/** Every non-test `.ts` file under `src/` whose text contains `needle`. */
function sourceFilesContaining(needle: string): string[] {
  const files: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== '__generated__') {
          walk(path);
        }

        continue;
      }

      if (
        entry.name.endsWith('.ts') &&
        !/\.(spec|test)\.ts$/.test(entry.name) &&
        readFileSync(path, 'utf8').includes(needle)
      ) {
        files.push(path);
      }
    }
  };

  walk(SRC_ROOT);

  return files;
}

function exportedClasses(file: string): ControllerClass[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require(file) as Record<string, unknown>;

  return Object.values(loaded).filter(
    (value): value is ControllerClass => typeof value === 'function' && /^class\s/.test(String(value)),
  );
}

function handlerOf(controller: ControllerClass, method: string): object | undefined {
  const handler = (controller.prototype as Record<string, unknown>)[method];

  return typeof handler === 'function' ? handler : undefined;
}

/** What `enforceApiKeyCapability` would demand of a key on this route: the declaration, else the shape. */
function requiredForApiKey(controller: ControllerClass, method: string, shape: ApiKeyCapability): unknown {
  return effectiveMetadata(REQUIRE_CAPABILITY_KEY, controller as never, method) ?? shape;
}

/** Whether an api key can authenticate on this route at all. Session-only routes are out of scope. */
function apiKeyReachable(controller: ControllerClass, method: string): boolean {
  const handler = handlerOf(controller, method);
  const guards = [
    ...((handler && (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined)) ?? []),
    ...((Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined) ?? []),
  ];

  return guards.includes(JwtOrApiKeyAuthGuard) || guards.includes(ApiKeyGuard);
}

/**
 * DELETE routes an api key may run below `full`, each with the reason. Anything else that answers
 * DELETE to a key must cost `full`; adding to this list is a decision, not a fix for a red test.
 */
const DELETE_BELOW_FULL: Record<string, string> = {
  // The MCP streamable-HTTP transport sends DELETE to end its session. It removes nothing, and every
  // MCP client a `read` key drives sends it on close, so it stays at the class-level `read`.
  'McpController.handleDelete': READ_CAPABILITY,
};

/** What the guard demands of an undeclared DELETE, asked of the real shape rule rather than restated. */
const DELETE_SHAPE = capabilityImpliedByShape(
  { getType: () => 'http' } as unknown as ExecutionContext,
  { method: 'DELETE' } as ApiKeyScopedRequest,
);

describe('every DELETE an api key can reach requires full', () => {
  const routes: Array<{ name: string; controller: ControllerClass; method: string }> = [];

  for (const file of sourceFilesContaining('@Delete(')) {
    for (const controller of exportedClasses(file)) {
      for (const method of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = handlerOf(controller, method);

        if (
          method !== 'constructor' &&
          handler &&
          Reflect.getMetadata(METHOD_METADATA, handler) === RequestMethod.DELETE &&
          apiKeyReachable(controller, method)
        ) {
          routes.push({ name: `${controller.name}.${method}`, controller, method });
        }
      }
    }
  }

  for (const { name, controller, method } of routes) {
    it(`${name} costs ${DELETE_BELOW_FULL[name] ?? FULL_CAPABILITY}`, () => {
      expect(requiredForApiKey(controller, method, DELETE_SHAPE)).toBe(
        DELETE_BELOW_FULL[name] ?? FULL_CAPABILITY,
      );
    });
  }

  it('finds the DELETE routes it claims to (the scan is not vacuous)', () => {
    const names = routes.map((route) => route.name);

    // Connection disconnect, chat threads and import discard are the three a "Read & write" key
    // could run before; the allowlisted MCP teardown proves the exception is still being looked at.
    expect(names).toEqual(
      expect.arrayContaining([
        'ConnectionPrivacyController.delete',
        'ThreadsController.delete',
        'ImportRunsController.discard',
        'AccountController.remove',
        ...Object.keys(DELETE_BELOW_FULL),
      ]),
    );
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });
});

describe('POST routes that destroy data declare full', () => {
  const DESTRUCTIVE_POSTS: Array<[ControllerClass, string, string]> = [
    [PrivacyController, 'deleteMyAccount', 'deletes the account and revokes every OAuth grant at once'],
    [AccountDataController, 'importLegacy', "replaces the account's data, deleting what is there first"],
    [AccountDataController, 'importStream', "replaces the account's data, deleting what is there first"],
    [MaintenanceController, 'truncateSearchIndex', "empties every account's search index"],
    [MaintenanceController, 'cleanupSearchOrphans', 'deletes index rows'],
    [MaintenanceController, 'resetIngest', 'truncates the ingest tables'],
    [JobsController, 'clearTerminal', 'deletes job history'],
  ];

  for (const [controller, method, why] of DESTRUCTIVE_POSTS) {
    it(`${controller.name}.${method} (${why})`, () => {
      expect(handlerOf(controller, method)).toBeDefined();
      expect(Reflect.getMetadata(METHOD_METADATA, handlerOf(controller, method) as object)).toBe(
        RequestMethod.POST,
      );
      expect(effectiveMetadata(REQUIRE_CAPABILITY_KEY, controller as never, method)).toBe(FULL_CAPABILITY);
    });
  }
});

/**
 * Every `@GraphqlPrivacy` label in the tree, read from source: the label lands on the schema
 * extension (which only a built schema exposes), but the decorator also stamps the capability on the
 * resolver method, and that is what the guard reads. So the source says which fields lose data and
 * the metadata says what a key must hold to run them; the two must agree.
 */
function graphqlLabels(): Array<{ file: string; method: string; removesData: boolean; partial: boolean }> {
  const labels: Array<{ file: string; method: string; removesData: boolean; partial: boolean }> = [];
  // Anchored to the start of a line, so the decorator's own doc examples (` * @GraphqlPrivacy`) and
  // error strings that quote it are not mistaken for applications of it.
  const pattern = /^[ \t]*@GraphqlPrivacy\(\{([^}]*)\}\)[\s\S]*?(?:async\s+)?(\w+)\s*\(/gm;

  for (const file of sourceFilesContaining('@GraphqlPrivacy(')) {
    if (file.endsWith('GraphqlPrivacy.ts')) {
      continue;
    }

    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      const body = match[1] ?? '';

      labels.push({
        file,
        method: match[2] ?? '',
        removesData: /access:\s*'delete'/.test(body) || /destructive:\s*true/.test(body),
        // A label without both axes leaves the missing one to GraphQLToolAdapter's name rule.
        partial: !/\baccess:/.test(body) || !/\bdestructive:/.test(body),
      });
    }
  }

  return labels;
}

describe('every GraphQL field labelled as losing data requires full on /graphql', () => {
  const labels = graphqlLabels();
  const classesByFile = new Map<string, ControllerClass[]>();

  const resolverFor = (file: string, method: string): ControllerClass | undefined => {
    if (!classesByFile.has(file)) {
      classesByFile.set(file, exportedClasses(file));
    }

    return classesByFile.get(file)?.find((candidate) => handlerOf(candidate, method));
  };

  for (const { file, method, removesData } of labels) {
    const label = `${file.slice(SRC_ROOT.length + 1)}: ${method}`;

    it(`${label} ${removesData ? 'requires full' : 'is left to the shape rule'}`, () => {
      const resolver = resolverFor(file, method);

      expect(resolver).toBeDefined();

      const declared = Reflect.getMetadata(
        REQUIRE_CAPABILITY_KEY,
        handlerOf(resolver as ControllerClass, method) as object,
      );

      expect(declared).toBe(removesData ? FULL_CAPABILITY : undefined);
    });
  }

  it('leaves no data-losing field to the MCP name rule, which /graphql does not apply', () => {
    // GraphQLToolAdapter merges a partial label over what it infers from the field name, so
    // `@GraphqlPrivacy({ external: true })` on `deleteX` costs `full` over MCP. The decorator reads
    // only the label, so the same field would cost `write` on /graphql, and the suite above would
    // agree with the decorator. A partial label on such a name has to say what it does.
    const inferredDestructive = labels.filter(
      ({ method, removesData, partial }) =>
        partial &&
        !removesData &&
        DESTRUCTIVE_MUTATION_PREFIXES.some((prefix) => method.toLowerCase().startsWith(prefix)),
    );

    expect(
      inferredDestructive.map(({ file, method }) => `${file.slice(SRC_ROOT.length + 1)}: ${method}`),
    ).toEqual([]);
  });

  it('reads the labels it claims to (the scan is not vacuous)', () => {
    // 38 root fields lose data at the time of writing (deleteNote, mergePeople, untagEntities, ...).
    expect(labels.filter((label) => label.removesData).length).toBeGreaterThanOrEqual(38);
    expect(labels.filter((label) => !label.removesData).length).toBeGreaterThanOrEqual(90);
  });
});
