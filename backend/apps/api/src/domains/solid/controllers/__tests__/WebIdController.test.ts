import { NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { SYSTEM_USER } from '@ci/common/context';
import type { FeatureService } from '@ci/common/feature';
import type { User, UserService } from '@ci/domains/user';

import { ProfileDocumentService } from '../../services/ProfileDocumentService';
import { WebIdService } from '../../services/WebIdService';
import { WebIdController } from '../WebIdController';

/**
 * The controller is the security boundary of the facade: the feature flag must
 * gate the whole surface, the read must run as SYSTEM (a public document, not
 * the caller's own row), and the response must be content-negotiated. These
 * tests wire real WebID/profile services so the negotiated body is real Turtle.
 */
const user: User = {
  id: '0190bd3e-0000-7000-8000-000000000001',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  entityId: null,
  onboarded: true,
  timezone: 'UTC',
  createdAt: new Date('2020-01-01T00:00:00Z'),
  updatedAt: new Date('2020-01-01T00:00:00Z'),
} as User;

const makeReq = (accept?: string): Request =>
  ({
    headers: accept ? { accept } : {},
    get: (name: string) => (name.toLowerCase() === 'host' ? 'ci.example' : undefined),
    protocol: 'https',
  }) as unknown as Request;

const makeRes = (): Response & { type: jest.Mock; send: jest.Mock } => {
  const res = {
    type: jest.fn(),
    send: jest.fn(),
  };
  res.type.mockReturnValue(res);

  return res as unknown as Response & { type: jest.Mock; send: jest.Mock };
};

const build = (opts: { enabled: boolean; found: boolean }) => {
  const features = {
    isFeatureEnabled: jest.fn().mockResolvedValue(opts.enabled),
  } as unknown as FeatureService;
  const users = {
    findById: jest.fn().mockResolvedValue(opts.found ? user : null),
  } as unknown as UserService;
  const webIds = new WebIdService();
  const profiles = new ProfileDocumentService(webIds);

  return {
    controller: new WebIdController(features, users, webIds, profiles),
    features,
    users,
  };
};

describe('WebIdController.getProfile', () => {
  it('404s and never touches the user store when the flag is off', async () => {
    const { controller, users } = build({ enabled: false, found: true });
    await expect(controller.getProfile(user.id, makeReq(), makeRes())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('404s when the user does not exist', async () => {
    const { controller } = build({ enabled: true, found: false });
    await expect(controller.getProfile('missing', makeReq(), makeRes())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('reads the profile under a SYSTEM context, not the caller', async () => {
    const { controller, users } = build({ enabled: true, found: true });
    await controller.getProfile(user.id, makeReq(), makeRes());
    expect(users.findById).toHaveBeenCalledWith({ userId: SYSTEM_USER }, user.id);
  });

  it('serves Turtle by default with the WebID and name', async () => {
    const { controller } = build({ enabled: true, found: true });
    const res = makeRes();
    await controller.getProfile(user.id, makeReq(), res);

    expect(res.type).toHaveBeenCalledWith('text/turtle');
    const body = res.send.mock.calls[0][0] as string;
    expect(body).toContain(`<https://ci.example/solid/profile/${user.id}#me>`);
    expect(body).toContain('foaf:name "Ada Lovelace"');
  });

  it('serves JSON-LD when the client asks for it', async () => {
    const { controller } = build({ enabled: true, found: true });
    const res = makeRes();
    await controller.getProfile(user.id, makeReq('application/ld+json'), res);

    expect(res.type).toHaveBeenCalledWith('application/ld+json');
    const doc = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(doc['@graph']).toBeDefined();
  });
});
