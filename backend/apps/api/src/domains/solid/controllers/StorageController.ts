import { Controller, Get, NotFoundException, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { GraphNodeEntity, GraphQueryService } from '@ci/domains/memory';

import { negotiateRdf, type Quad } from '../rdf';
import { ContainerService } from '../services/ContainerService';
import { EntityProjectionService } from '../services/EntityProjectionService';
import { WebIdService } from '../services/WebIdService';

import { requestOrigin } from './requestOrigin';

/** Page size for member enumeration; matches GraphQueryService's own 200 cap. */
const PAGE_SIZE = 200;
/**
 * Safety cap on how many members a single container response lists. A pod with
 * more entities than this is truncated (and says so via `ci:truncated`); proper
 * paged containers (LDP paging) are a later slice. Bounds memory and query
 * count (≤ MAX_MEMBERS / PAGE_SIZE round-trips) per request.
 */
const MAX_MEMBERS = 1000;

/**
 * Serves the user's pod: RDF resources projected from their private data.
 *  - `GET /solid/storage/:userId/entity/` — the entity container (LDP
 *    BasicContainer) listing the user's entities.
 *  - `GET /solid/storage/:userId/entity/:entityId` — a single entity resource.
 * Both are content-negotiated between Turtle and JSON-LD.
 *
 * Unlike the public WebID profile, pod contents are PRIVATE, so this surface
 * is authenticated (`JwtOrApiKeyAuthGuard`) and **owner-only**: the caller may
 * read only their own pod. That owner check is the facade's WAC-lite stand-in
 * until real per-resource ACLs land — a mismatch (or a missing entity) both
 * return 404 so the endpoint never reveals whether another user's resource
 * exists. Everything is additionally gated behind the `solid.protocol` flag.
 */
@Controller('solid/storage')
@UseGuards(JwtOrApiKeyAuthGuard)
export class StorageController {
  constructor(
    private readonly features: FeatureService,
    private readonly graph: GraphQueryService,
    private readonly webIds: WebIdService,
    private readonly projection: EntityProjectionService,
    private readonly container: ContainerService,
  ) {}

  @Get(':userId/entity')
  async getEntityContainer(
    @Param('userId') userId: string,
    @Context() context: RequestContext,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const authUserId = await this.authorizeOwner(userId, context);

    const { members, truncated } = await this.collectMembers(authUserId);

    const origin = this.webIds.resolveOrigin(requestOrigin(req));
    const quads = this.container.build(members, origin, authUserId, { truncated });
    this.respond(req, res, quads);
  }

  @Get(':userId/entity/:entityId')
  async getEntity(
    @Param('userId') userId: string,
    @Param('entityId') entityId: string,
    @Context() context: RequestContext,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const authUserId = await this.authorizeOwner(userId, context);

    const node = await this.graph.getNode(authUserId, entityId);
    if (!node) {
      throw new NotFoundException();
    }

    // Outbound edges of this entity, already owner-scoped by the query.
    const relationships = await this.graph.getRelationships(authUserId, {
      entityIds: [entityId],
      direction: 'outbound',
    });

    const origin = this.webIds.resolveOrigin(requestOrigin(req));
    const quads = this.projection.build(node, relationships, origin, authUserId);
    this.respond(req, res, quads);
  }

  /**
   * Enforces the flag and owner-only access, returning the authenticated owner
   * id to scope reads by. Flag-off and foreign-pod both 404 (no existence
   * leak); an unauthenticated principal throws via `toServiceContext`.
   */
  private async authorizeOwner(userId: string, context: RequestContext): Promise<string> {
    if (!(await this.features.isFeatureEnabled('solid.protocol'))) {
      throw new NotFoundException();
    }

    const { userId: authUserId } = toServiceContext(context);
    if (authUserId !== userId) {
      throw new NotFoundException();
    }

    return authUserId;
  }

  /**
   * Pages through the owner's entities up to MAX_MEMBERS. `truncated` is set
   * when the cap is hit before the listing is exhausted, so a partial container
   * is never presented as complete.
   */
  private async collectMembers(ownerId: string): Promise<{ members: GraphNodeEntity[]; truncated: boolean }> {
    const members: GraphNodeEntity[] = [];
    let offset = 0;

    for (;;) {
      const page = await this.graph.getNodes(ownerId, { limit: PAGE_SIZE, offset });
      members.push(...page);

      if (page.length < PAGE_SIZE) {
        return { members, truncated: false };
      }

      offset += PAGE_SIZE;
      if (members.length >= MAX_MEMBERS) {
        return { members, truncated: true };
      }
    }
  }

  private respond(req: Request, res: Response, quads: Quad[]): void {
    const serialization = negotiateRdf(req.headers.accept);
    res.type(serialization.mediaType).send(serialization.serialize(quads));
  }
}
