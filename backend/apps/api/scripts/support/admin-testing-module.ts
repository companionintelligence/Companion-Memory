import { Module } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';

import { LoggerService } from '@ci/common/logging';
import { AgentModule, ForecastContextService, RecallService } from '@ci/domains/agent';
import { EtlModule } from '@ci/domains/etl';
import { EventService, LocalEventService } from '@ci/domains/events';
import { GraphQLModule } from '@ci/domains/graphql';
import { LLMModule, OllamaService } from '@ci/domains/llm';
import { McpModule } from '@ci/domains/mcp';
import { IntentCatalogService, ToolRegistry, ToolsModule } from '@ci/domains/tools';

import { App } from '../../src/application';

/**
 * The one definition of how the admin scripts (`make seed`, `make signup`) boot
 * the application.
 *
 * They run the real `App` through a Nest TestingModule so they can call the same
 * services the API does, but a handful of domains are swapped for stubs: those
 * reach for Ollama, the MCP servers or the GraphQL schema, none of which a
 * one-shot CLI script has any use for.
 *
 * ## Why a stub is not `class {}`
 *
 * `.useModule(class {})` reads like "skip this module", but what it does is delete
 * every token that module *exports* from the injector — including from the modules
 * that were not stubbed and still expect them. Nothing fails at the swap; it fails
 * later, in an unrelated domain, the first time a service injects a token whose
 * provider was quietly removed. That is how `make seed` and `make signup` broke
 * when the schedule domain started injecting `RecallService`, an `AgentModule`
 * export: the schedule domain's wiring was correct, the stub standing in for
 * `AgentModule` was not.
 *
 * So a stub re-provides the tokens the rest of the app injects from the module it
 * replaces. `__tests__/admin-testing-module.test.ts` compiles the whole graph
 * through this builder and is what proves the set is still complete — add a
 * cross-domain dependency on a stubbed module and that test fails, instead of the
 * next person to run `make seed`.
 */
@Module({
  providers: [
    { provide: RecallService, useValue: {} },
    { provide: ForecastContextService, useValue: {} },
  ],
  exports: [RecallService, ForecastContextService],
})
export class StubAgentModule {}

@Module({})
export class StubEtlModule {}

@Module({})
export class StubGraphQLModule {}

@Module({
  providers: [{ provide: OllamaService, useValue: {} }],
  exports: [OllamaService],
})
export class StubLLMModule {}

@Module({})
export class StubMcpModule {}

@Module({
  providers: [
    // Not `{}`: PersonaToolsRegistrationService registers its provider from
    // onModuleInit, which the scripts run.
    { provide: ToolRegistry, useValue: { registerProvider: async () => {} } },
    { provide: IntentCatalogService, useValue: {} },
  ],
  exports: [ToolRegistry, IntentCatalogService],
})
export class StubToolsModule {}

/**
 * Modules the admin scripts do not boot, each paired with the stub that stands in
 * for it. One list, so the scripts cannot drift apart from each other or from the
 * test that checks them.
 */
export const STUBBED_MODULES = [
  { real: AgentModule, stub: StubAgentModule },
  { real: EtlModule, stub: StubEtlModule },
  { real: GraphQLModule, stub: StubGraphQLModule },
  { real: LLMModule, stub: StubLLMModule },
  { real: McpModule, stub: StubMcpModule },
  { real: ToolsModule, stub: StubToolsModule },
] as const;

/**
 * A LoggerService quiet enough that a script's own output is the only output —
 * but errors still come through.
 *
 * `error` used to be silenced along with the rest, and that turns a fatal into
 * nothing at all: `App.onApplicationBootstrap` installs an `unhandledRejection`
 * handler that logs through this very service and then exits(1), so a rejection
 * anywhere in the app ended a script with a bare `make: *** [seed] Error 1` and
 * not one line saying why.
 */
export function createQuietLogger(): LoggerService {
  const logger = new LoggerService();

  logger.warn = () => {};

  logger.log = () => {};

  logger.debug = () => {};

  return logger;
}

/**
 * Build the TestingModule the admin scripts boot from. Callers add whatever
 * overrides they alone need on top, then `.compile()`.
 */
export function createAdminTestingModule(): TestingModuleBuilder {
  let builder = Test.createTestingModule({
    imports: [App],
  })
    .overrideProvider(LoggerService)
    .useFactory({ factory: createQuietLogger })
    // pg-boss is a queue with no worker here: a script exits long before anything
    // it enqueued would run, so events are dispatched in-process instead.
    .overrideProvider(EventService)
    .useClass(LocalEventService);

  for (const { real, stub } of STUBBED_MODULES) {
    builder = builder.overrideModule(real).useModule(stub);
  }

  return builder;
}
