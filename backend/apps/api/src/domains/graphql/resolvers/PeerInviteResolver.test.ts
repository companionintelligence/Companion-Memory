import { PeerInviteResolver } from './PeerInviteResolver';

const CTX = { req: { user: { id: 'user-1' } } } as never;

jest.mock('@ci/common/context', () => {
  const actual = jest.requireActual('@ci/common/context');

  return { ...actual, toServiceContext: () => ({ userId: 'user-1' }) };
});

const VIEW = {
  id: '0193f0c1-aaaa-7bbb-8ccc-123456789abc',
  label: null,
  inviterName: 'Alice',
  createdAt: new Date('2026-11-19T10:00:00Z'),
  expiresAt: new Date('2026-11-20T10:00:00Z'),
  usedAt: null,
  revokedAt: null,
  status: 'pending',
};

function make(
  enabled = true,
  noticeService: Record<string, jest.Mock> = {
    rotateKey: jest.fn().mockResolvedValue({ notified: ['bob'], unreachable: ['carol'] }),
    resendRotation: jest.fn().mockResolvedValue({ notified: ['carol'], unreachable: [] }),
  },
) {
  const inviteService = {
    create: jest.fn().mockResolvedValue({ invite: VIEW, code: 'cmi1.abc' }),
    list: jest.fn().mockResolvedValue([VIEW]),
    revoke: jest.fn().mockResolvedValue({ ...VIEW, status: 'revoked' }),
    accept: jest.fn().mockResolvedValue({
      id: 'link-1',
      peerHandle: 'alice',
      displayName: 'Alice',
      memoryEndpoint: 'https://a.example/api/agent/v1',
      personEntityId: null,
      trustTier: 'stranger',
      status: 'active',
      peerIssuer: 'did:key',
      peerSubject: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      createdAt: new Date(),
      updatedAt: new Date(),
      revokedAt: null,
    }),
  };
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(enabled) };

  return {
    resolver: new PeerInviteResolver(
      inviteService as never,
      featureService as never,
      undefined,
      noticeService as never,
    ),
    inviteService,
    noticeService,
  };
}

describe('PeerInviteResolver', () => {
  it('hands the code back once, with the invite', async () => {
    const { resolver, inviteService } = make();

    const payload = await resolver.createPeerInvite(CTX, { name: 'Al', label: 'for Sam' });

    expect(payload).toMatchObject({
      success: true,
      code: 'cmi1.abc',
      invite: { inviterName: 'Alice', status: 'pending' },
    });
    expect(inviteService.create).toHaveBeenCalledWith({ userId: 'user-1' }, { name: 'Al', label: 'for Sam' });
  });

  it('never lists the code', async () => {
    const { resolver } = make();

    const [listed] = await resolver.myPeerInvites(CTX);

    expect(JSON.stringify(listed)).not.toContain('cmi1');
  });

  it('returns the new link as linked by key, without its identifier', async () => {
    const { resolver } = make();

    const payload = await resolver.acceptPeerInvite(CTX, { code: 'cmi1.abc' });

    expect(payload.peerLink).toMatchObject({ peerHandle: 'alice', linkedByKey: true });
    expect(JSON.stringify(payload)).not.toContain('did:key');
  });

  it('does nothing while the ask feature is off', async () => {
    const { resolver, inviteService } = make(false);

    await expect(resolver.createPeerInvite(CTX)).resolves.toEqual({ success: false });
    await expect(resolver.acceptPeerInvite(CTX, { code: 'x' })).resolves.toEqual({ success: false });
    await expect(resolver.myPeerInvites(CTX)).resolves.toEqual([]);
    expect(inviteService.create).not.toHaveBeenCalled();
  });

  it('rotates the key and reports who was and was not told', async () => {
    const { resolver, noticeService } = make();

    await expect(resolver.rotatePeerKey(CTX)).resolves.toEqual({
      success: true,
      notified: ['bob'],
      unreachable: ['carol'],
    });
    expect(noticeService.rotateKey).toHaveBeenCalledWith({ userId: 'user-1' });
  });

  it('re-sends the last rotation on request', async () => {
    const { resolver } = make();

    await expect(resolver.resendPeerKeyRotation(CTX)).resolves.toEqual({
      success: true,
      notified: ['carol'],
      unreachable: [],
    });
  });
});
