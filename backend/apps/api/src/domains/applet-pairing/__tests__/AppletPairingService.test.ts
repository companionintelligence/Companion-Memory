import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { UserEntity } from '@ci/domains/user';

import { AppletPairingEntity } from '../entities/AppletPairingEntity';
import { UserSnapshotEntity } from '../entities/UserSnapshotEntity';
import { AppletPairingService } from '../services/AppletPairingService';

describe('AppletPairingService', () => {
  let service: AppletPairingService;
  let pairingRepo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock; update: jest.Mock };
  let snapshotRepo: { create: jest.Mock; save: jest.Mock };
  let userRepo: { findOne: jest.Mock };
  let jwt: { sign: jest.Mock };

  beforeEach(async () => {
    pairingRepo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => x),
      findOne: jest.fn(),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    snapshotRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    userRepo = {
      findOne: jest.fn(async () => ({ id: 'user-1', name: 'Liam', email: 'liam@ci.computer' })),
    };
    jwt = { sign: jest.fn(() => 'signed.jwt.token') };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AppletPairingService,
        { provide: getRepositoryToken(AppletPairingEntity), useValue: pairingRepo },
        { provide: getRepositoryToken(UserSnapshotEntity), useValue: snapshotRepo },
        { provide: getRepositoryToken(UserEntity), useValue: userRepo },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();

    service = moduleRef.get(AppletPairingService);
  });

  it('start() creates a PENDING pairing with a token, secret poll key, and future expiry', async () => {
    const pairing = await service.start();

    expect(pairing.status).toBe('PENDING');
    expect(pairing.pairing_token).toHaveLength(64); // 32 random bytes, hex
    expect(pairing.poll_key).toHaveLength(64);
    expect(pairing.pairing_token).not.toEqual(pairing.poll_key);
    expect(pairing.expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(pairingRepo.save).toHaveBeenCalledTimes(1);
  });

  it('status() returns the pairing only when the poll key matches', async () => {
    pairingRepo.findOne.mockResolvedValueOnce({ pairing_token: 't', poll_key: 'k', status: 'PENDING' });
    expect(await service.status('t', 'k')).not.toBeNull();

    pairingRepo.findOne.mockResolvedValueOnce(null);
    expect(await service.status('unknown', 'k')).toBeNull();

    pairingRepo.findOne.mockResolvedValueOnce({ pairing_token: 't', poll_key: 'k' });
    expect(await service.status('t', 'WRONG-KEY')).toBeNull();
  });

  it('approve() mints a long-lived token, binds a device, and completes the pairing', async () => {
    const pending = {
      id: 'p1',
      pairing_token: 't',
      poll_key: 'k',
      status: 'PENDING',
      expires_at: new Date(Date.now() + 60_000),
    };
    pairingRepo.findOne
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ ...pending, status: 'COMPLETED', user_id: 'user-1', device_id: 'dev' });

    const result = await service.approve('t', 'user-1');

    expect(jwt.sign).toHaveBeenCalledWith({ sub: 'user-1' }, { expiresIn: '365d' });
    expect(pairingRepo.update).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        status: 'COMPLETED',
        user_id: 'user-1',
        user_email: 'liam@ci.computer',
        applet_access_token: 'signed.jwt.token',
      }),
    );
    expect(result?.status).toBe('COMPLETED');
  });

  it('approve() refuses an expired or already-completed pairing', async () => {
    pairingRepo.findOne.mockResolvedValueOnce({
      id: 'p1',
      status: 'PENDING',
      expires_at: new Date(Date.now() - 1_000),
    });
    expect(await service.approve('t', 'user-1')).toBeNull();

    pairingRepo.findOne.mockResolvedValueOnce({
      id: 'p1',
      status: 'COMPLETED',
      expires_at: new Date(Date.now() + 60_000),
    });
    expect(await service.approve('t', 'user-1')).toBeNull();

    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('recordSnapshot() persists a snapshot owned by the user', async () => {
    await service.recordSnapshot('user-1', {
      deviceId: 'dev-1',
      sessionId: 'sess-1',
      snapshotKind: 'snapshot',
      observedAt: '2026-06-21T00:00:00Z',
      monotonicMs: 123456,
      payload: { focus: { app: 'Claude' } },
      focusApp: 'Claude',
      focusTitle: 'Claude',
      cwd: '/tmp',
      fsEventCount: 2,
    });

    expect(snapshotRepo.save).toHaveBeenCalledTimes(1);
    expect(snapshotRepo.create.mock.calls[0][0]).toMatchObject({
      user_id: 'user-1',
      device_id: 'dev-1',
      monotonic_ms: '123456',
      fs_event_count: 2,
    });
  });
});
