import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

import type { RequestContext } from '@ci/common/context';
import type { FeatureService } from '@ci/common/feature';
import type { GraphNodeEntity, GraphQueryService, RelationshipEntity } from '@ci/domains/memory';

import { ContainerService } from '../../services/ContainerService';
import { EntityProjectionService } from '../../services/EntityProjectionService';
import { WebIdService } from '../../services/WebIdService';
import { StorageController } from '../StorageController';

/**
 * The storage controller is where the facade enforces privacy. These tests pin
 * the security boundary: the flag gates the surface, an unauthenticated call is
 * rejected, and — critically — a caller can never read another user's pod (that
 * must 404, never 200 and never a distinguishable 403).
 */
const OWNER = 'owner-1';
const ENTITY = '0190bd3e-0000-7000-8000-0000000000aa';

const node: GraphNodeEntity = {
  entity_id: ENTITY,
  entity_type: 'Person',
  name: 'Ada',
  description: null,
  properties: {},
  created_at: new Date('2020-01-01T00:00:00.000Z'),
  updated_at: new Date('2020-01-01T00:00:00.000Z'),
  owner_user_id: OWNER,
} as GraphNodeEntity;

const makeReq = (accept?: string): Request =>
  ({
    headers: accept ? { accept } : {},
    get: (name: string) => (name.toLowerCase() === 'host' ? 'ci.example' : undefined),
    protocol: 'https',
  }) as unknown as Request;

const makeRes = (): Response & { type: jest.Mock; send: jest.Mock } => {
  const res = { type: jest.fn(), send: jest.fn() };
  res.type.mockReturnValue(res);

  return res as unknown as Response & { type: jest.Mock; send: jest.Mock };
};

const build = (opts: {
  enabled?: boolean;
  node?: GraphNodeEntity | null;
  rels?: RelationshipEntity[];
  getNodes?: jest.Mock;
}) => {
  const features = {
    isFeatureEnabled: jest.fn().mockResolvedValue(opts.enabled ?? true),
  } as unknown as FeatureService;
  const graph = {
    getNode: jest.fn().mockResolvedValue(opts.node === undefined ? node : opts.node),
    getRelationships: jest.fn().mockResolvedValue(opts.rels ?? []),
    getNodes: opts.getNodes ?? jest.fn().mockResolvedValue([]),
  } as unknown as GraphQueryService;
  const webIds = new WebIdService();
  const projection = new EntityProjectionService(webIds);
  const container = new ContainerService(webIds);

  return {
    controller: new StorageController(features, graph, webIds, projection, container),
    features,
    graph,
  };
};

const ctx = (userId?: string): RequestContext => ({ userId }) as RequestContext;

describe('StorageController.getEntity', () => {
  it('404s and never queries the graph when the flag is off', async () => {
    const { controller, graph } = build({ enabled: false });
    await expect(
      controller.getEntity(OWNER, ENTITY, ctx(OWNER), makeReq(), makeRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(graph.getNode).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request', async () => {
    const { controller } = build({});
    await expect(
      controller.getEntity(OWNER, ENTITY, ctx(undefined), makeReq(), makeRes()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("404s when a caller requests another user's pod, without touching the graph", async () => {
    const { controller, graph } = build({});
    await expect(
      controller.getEntity(OWNER, ENTITY, ctx('someone-else'), makeReq(), makeRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(graph.getNode).not.toHaveBeenCalled();
  });

  it('404s when the entity does not exist', async () => {
    const { controller } = build({ node: null });
    await expect(
      controller.getEntity(OWNER, ENTITY, ctx(OWNER), makeReq(), makeRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reads the graph strictly under the authenticated owner id', async () => {
    const { controller, graph } = build({});
    await controller.getEntity(OWNER, ENTITY, ctx(OWNER), makeReq(), makeRes());
    expect(graph.getNode).toHaveBeenCalledWith(OWNER, ENTITY);
    expect(graph.getRelationships).toHaveBeenCalledWith(OWNER, {
      entityIds: [ENTITY],
      direction: 'outbound',
    });
  });

  it('serves Turtle by default with the entity resource as subject', async () => {
    const { controller } = build({});
    const res = makeRes();
    await controller.getEntity(OWNER, ENTITY, ctx(OWNER), makeReq(), res);

    expect(res.type).toHaveBeenCalledWith('text/turtle');
    const body = res.send.mock.calls[0][0] as string;
    expect(body).toContain(`<https://ci.example/solid/storage/${OWNER}/entity/${ENTITY}>`);
    expect(body).toContain('rdfs:label "Ada"');
  });

  it('serves JSON-LD when requested', async () => {
    const { controller } = build({});
    const res = makeRes();
    await controller.getEntity(OWNER, ENTITY, ctx(OWNER), makeReq('application/ld+json'), res);

    expect(res.type).toHaveBeenCalledWith('application/ld+json');
    const doc = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(doc['@graph'][0]['@id']).toBe(`https://ci.example/solid/storage/${OWNER}/entity/${ENTITY}`);
  });
});

describe('StorageController.getEntityContainer', () => {
  const member = (id: string): GraphNodeEntity =>
    ({ ...node, entity_id: id, name: `E${id}` }) as GraphNodeEntity;

  it('404s for a foreign pod without listing anything', async () => {
    const getNodes = jest.fn().mockResolvedValue([]);
    const { controller } = build({ getNodes });
    await expect(
      controller.getEntityContainer(OWNER, ctx('someone-else'), makeReq(), makeRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(getNodes).not.toHaveBeenCalled();
  });

  it("lists the owner's entities as an LDP container", async () => {
    const getNodes = jest.fn().mockResolvedValue([member('a'), member('b')]);
    const { controller } = build({ getNodes });
    const res = makeRes();
    await controller.getEntityContainer(OWNER, ctx(OWNER), makeReq(), res);

    expect(getNodes).toHaveBeenCalledWith(OWNER, { limit: 200, offset: 0 });
    const body = res.send.mock.calls[0][0] as string;
    expect(body).toContain('ldp:BasicContainer');
    expect(body).toContain(`<https://ci.example/solid/storage/${OWNER}/entity/a>`);
    expect(body).toContain(`<https://ci.example/solid/storage/${OWNER}/entity/b>`);
    // A non-truncated listing carries no truncation flag.
    expect(body).not.toContain('truncated');
  });

  it('stops at a short page without a second query and does not truncate', async () => {
    // One short page (< 200) => listing is exhausted in a single query.
    const getNodes = jest.fn().mockResolvedValue([member('a')]);
    const { controller } = build({ getNodes });
    await controller.getEntityContainer(OWNER, ctx(OWNER), makeReq(), makeRes());
    expect(getNodes).toHaveBeenCalledTimes(1);
  });

  it('pages until a short page and flags nothing when the total is a page multiple', async () => {
    // Exactly 200 then 0: two queries, exhausted, not truncated.
    const full = Array.from({ length: 200 }, (_, i) => member(`f${i}`));
    const getNodes = jest.fn().mockResolvedValueOnce(full).mockResolvedValueOnce([]);
    const { controller } = build({ getNodes });
    const res = makeRes();
    await controller.getEntityContainer(OWNER, ctx(OWNER), makeReq(), res);

    expect(getNodes).toHaveBeenCalledTimes(2);
    expect(getNodes).toHaveBeenNthCalledWith(2, OWNER, { limit: 200, offset: 200 });
    expect(res.send.mock.calls[0][0]).not.toContain('truncated');
  });

  it('truncates and flags when the member cap is reached', async () => {
    // Five full pages (5 * 200 = 1000 = MAX_MEMBERS) => cap hit, truncated.
    const fullPage = () => Array.from({ length: 200 }, (_, i) => member(`x${i}`));
    const getNodes = jest.fn().mockResolvedValue(fullPage());
    const { controller } = build({ getNodes });
    const res = makeRes();
    await controller.getEntityContainer(OWNER, ctx(OWNER), makeReq('text/turtle'), res);

    expect(getNodes).toHaveBeenCalledTimes(5);
    expect(res.send.mock.calls[0][0]).toContain('ci:truncated');
  });
});
