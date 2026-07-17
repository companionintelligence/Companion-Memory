import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { HubForwardAuthGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { NodeService } from '@ci/domains/graph';

import { DeltaService } from '../services/DeltaService';

const getDeltasSchema = z.object({
  entityId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
  changeType: z.enum(['created', 'updated', 'archived', 'deleted', 'merged']).optional(),
  unsummarizedOnly: z.coerce.boolean().optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

type GetDeltasDto = z.infer<typeof getDeltasSchema>;

@Controller('audit')
@UseGuards(JwtOrApiKeyAuthGuard)
export class AuditController {
  constructor(
    private readonly deltaService: DeltaService,
    private readonly nodeService: NodeService,
  ) {}

  /**
   * First consumer of the signed CI-Hub forward-auth identity header. Returns the
   * username only when the HMAC signature verifies (HubForwardAuthGuard rejects an
   * unsigned or forged header with 401 before this handler runs). Serves as the
   * reference integration for other endpoints that want to trust Hub-brokered
   * identity. See CI-Engineering/architecture/subsystems/security-trust-and-ops.md.
   *
   * The method-level guard overrides the class-level JwtOrApiKeyAuthGuard: identity
   * here is attested by the Hub signature, not a server-issued token.
   */
  @Get('forward-auth/whoami')
  @UseGuards(HubForwardAuthGuard)
  forwardAuthWhoami(@Req() req: Request & { hubForwardAuthUser?: string }) {
    return {
      success: true,
      data: {
        username: req.hubForwardAuthUser ?? null,
        source: 'ci-hub-forward-auth',
      },
    };
  }

  @Get('deltas')
  async getDeltas(
    @Context() ctx: RequestContext,
    @Query(new ValidationPipe(getDeltasSchema)) query: GetDeltasDto,
  ) {
    const serviceContext = toServiceContext(ctx);
    const limit = query.limit ?? 120;

    const deltas = await this.deltaService.findEvolutionForEntity(serviceContext, query.entityId, {
      limit,
      changeType: query.changeType,
      unsummarizedOnly: query.unsummarizedOnly,
      since: query.since,
      until: query.until,
    });

    const relatedEntityIds = new Set<string>();
    for (const delta of deltas) {
      if (delta.entityId) {
        relatedEntityIds.add(delta.entityId);
      }

      if (delta.fromEntityId) {
        relatedEntityIds.add(delta.fromEntityId);
      }

      if (delta.toEntityId) {
        relatedEntityIds.add(delta.toEntityId);
      }
    }

    const orderedRelatedIds = Array.from(relatedEntityIds);
    const relatedNodes = await this.nodeService.findByIds(serviceContext, orderedRelatedIds);
    const nodeById = new Map(
      orderedRelatedIds.flatMap((id, idx) => {
        const node = relatedNodes[idx];

        if (!node) {
          return [];
        }

        return [[id, node] as const];
      }),
    );

    const mappedDeltas = deltas.map((delta) => {
      const entityNode = delta.entityId ? nodeById.get(delta.entityId) : null;
      const fromEntityNode = delta.fromEntityId ? nodeById.get(delta.fromEntityId) : null;
      const toEntityNode = delta.toEntityId ? nodeById.get(delta.toEntityId) : null;

      const fieldChanges = Object.entries(delta.changedFields ?? {}).map(([field, value]) => ({
        field,
        oldValue: value?.old ?? null,
        newValue: value?.new ?? null,
      }));

      return {
        deltaId: delta.deltaId,
        nodeType: delta.nodeType,
        entityId: delta.entityId,
        relationshipId: delta.relationshipId,
        entityType: delta.entityType,
        relationshipType: delta.relationshipType,
        changeType: delta.changeType,
        changedFields: delta.changedFields,
        fieldChanges,
        changeSource: delta.changeSource,
        changeReason: delta.changeReason,
        summaryId: delta.summaryId,
        changedAt: delta.changedAt,
        entity: delta.entityId
          ? {
              entityId: delta.entityId,
              entityType: entityNode?.entityType ?? delta.entityType ?? null,
              name: entityNode?.name ?? null,
            }
          : null,
        fromEntity: delta.fromEntityId
          ? {
              entityId: delta.fromEntityId,
              entityType: fromEntityNode?.entityType ?? null,
              name: fromEntityNode?.name ?? null,
            }
          : null,
        toEntity: delta.toEntityId
          ? {
              entityId: delta.toEntityId,
              entityType: toEntityNode?.entityType ?? null,
              name: toEntityNode?.name ?? null,
            }
          : null,
      };
    });

    const counts = {
      created: 0,
      updated: 0,
      archived: 0,
      deleted: 0,
      merged: 0,
      entity: 0,
      relationship: 0,
    };

    for (const delta of mappedDeltas) {
      counts[delta.changeType] += 1;
      if (delta.nodeType === 'entity') {
        counts.entity += 1;
      } else if (delta.nodeType === 'relationship') {
        counts.relationship += 1;
      }
    }

    return {
      success: true,
      data: {
        entityId: query.entityId,
        deltas: mappedDeltas,
        stats: {
          total: mappedDeltas.length,
          firstChangedAt: mappedDeltas[mappedDeltas.length - 1]?.changedAt ?? null,
          lastChangedAt: mappedDeltas[0]?.changedAt ?? null,
          ...counts,
        },
      },
    };
  }
}
