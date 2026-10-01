import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { EntityIdentifierService } from '@ci/domains/graph';
import {
  CommunicationLinkBackfillService,
  EDGE_PROJECTION_REOPENER,
  EventParticipantBackfillService,
  resolveEdgeProjectionReopener,
} from '@ci/domains/maintenance';

import { EdgeProjectionReopenService } from '../services/EdgeProjectionReopenService';
import { PipelineStateService } from '../services/PipelineStateService';
import { StageRegistry } from '../services/StageRegistry';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LINKERS REACH THE RE-OPENER THROUGH NEST, ACROSS A MODULE BOUNDARY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The maintenance linkers take `@Optional() ModuleRef` and resolve
 * `EDGE_PROJECTION_REOPENER` lazily with `moduleRef.get(token, { strict: false })`.
 * They have to: `PipelineModule` imports `MaintenanceModule`, so the reverse
 * import would be a cycle. Every other spec of those writers hands them a
 * hand-built ModuleRef, which agrees with the writer unconditionally and cannot
 * tell whether Nest ever constructs it that way. A linker built without one
 * throws before it writes, so a wiring mistake here is not a silent gap, it is
 * every two-hourly `graph_link` run failing.
 *
 * What only Nest's own injector can show, with the REAL classes:
 *
 *  1. the linkers are constructible by Nest and receive a ModuleRef (decorator
 *     metadata survives the swc build, `@Optional()` does not demote it);
 *  2. a `useExisting` token declared in a SIBLING module, which does not import
 *     the linkers' module and is not imported by it, resolves to the real
 *     `EdgeProjectionReopenService` from that ModuleRef. This is the shape
 *     `PipelineModule` and `MaintenanceModule` have;
 *  3. without the binding the failure names the token. `stageWiring.spec`
 *     checks the real `PipelineModule` declares exactly this binding.
 */

const logger = () => ({
  setContext: jest.fn(),
  log: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

/** The linkers' module: their real classes, stand-ins for what they inject. */
@Module({
  providers: [
    CommunicationLinkBackfillService,
    EventParticipantBackfillService,
    { provide: DataSource, useValue: { query: jest.fn(), transaction: jest.fn() } },
    { provide: EntityIdentifierService, useValue: { findEntityIdsByIdentifiers: jest.fn() } },
    { provide: LoggerService, useValue: logger() },
  ],
})
class LinkersModule {}

/** The pipeline's module, as far as this binding goes: the real service and the real token shape. */
@Module({
  providers: [
    EdgeProjectionReopenService,
    { provide: EDGE_PROJECTION_REOPENER, useExisting: EdgeProjectionReopenService },
    { provide: PipelineStateService, useValue: { reopen: jest.fn() } },
    { provide: StageRegistry, useValue: { get: jest.fn() } },
  ],
})
class ReopenerModule {}

/** What Nest handed the linker. Private by design, so reached the way the writer reaches it. */
const moduleRefOf = (linker: unknown) =>
  (linker as { moduleRef?: Parameters<typeof resolveEdgeProjectionReopener>[0] }).moduleRef;

describe('EDGE_PROJECTION_REOPENER wiring under Nest', () => {
  it('hands both linkers a ModuleRef that resolves the sibling module’s re-opener', async () => {
    const app = await Test.createTestingModule({ imports: [LinkersModule, ReopenerModule] }).compile();

    const reopener = app.get(EdgeProjectionReopenService);

    for (const linker of [
      app.get(CommunicationLinkBackfillService),
      app.get(EventParticipantBackfillService),
    ]) {
      expect(moduleRefOf(linker)).toBeDefined();
      // The instance Nest built in the other module, not a copy.
      expect(resolveEdgeProjectionReopener(moduleRefOf(linker))).toBe(reopener);
    }

    await app.close();
  });

  it('names the token when no module binds it, instead of failing on an undefined', async () => {
    const app = await Test.createTestingModule({ imports: [LinkersModule] }).compile();

    expect(() =>
      resolveEdgeProjectionReopener(moduleRefOf(app.get(CommunicationLinkBackfillService))),
    ).toThrow(/EDGE_PROJECTION_REOPENER/);

    await app.close();
  });
});
