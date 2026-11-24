import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AccountRecoveryController } from '../AccountRecoveryController';

describe('AccountRecoveryController', () => {
  const req = { ip: '192.0.2.1' } as Request;
  const input = { email: 'Owner@Example.test', code: 'unused-code', newPassword: 'long-new-password' };
  const recovery = { recover: jest.fn() };
  const throttle = { check: jest.fn(), recordSuccess: jest.fn(), recordFailure: jest.fn() };
  const res = { setHeader: jest.fn() };
  const controller = new AccountRecoveryController(recovery as never, throttle as never);

  beforeEach(() => {
    jest.resetAllMocks();
    throttle.check.mockReturnValue({ locked: false });
  });

  it('checks throttling before password hashing and returns Retry-After while locked', async () => {
    throttle.check.mockReturnValue({ locked: true, retryAfterSeconds: 42 });
    await expect(controller.recover(req, res as unknown as Response, input)).rejects.toMatchObject({
      status: 429,
    });
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '42');
    expect(recovery.recover).not.toHaveBeenCalled();
  });

  it('records a failed redemption without revealing whether the address exists', async () => {
    const failure = new UnauthorizedException('Email or recovery code is incorrect or has already been used');
    recovery.recover.mockRejectedValue(failure);
    await expect(controller.recover(req, res as unknown as Response, input)).rejects.toBe(failure);
    expect(throttle.check).toHaveBeenCalledWith(req.ip, 'recovery:owner@example.test');
    expect(throttle.recordFailure).toHaveBeenCalledWith(req.ip, 'recovery:owner@example.test');
    expect(throttle.recordSuccess).not.toHaveBeenCalled();
  });

  it('clears the recovery throttle after successful redemption', async () => {
    recovery.recover.mockResolvedValue(undefined);
    await controller.recover(req, res as unknown as Response, input);
    expect(recovery.recover).toHaveBeenCalledWith(input.email, input.code, input.newPassword);
    expect(throttle.recordSuccess).toHaveBeenCalledWith(req.ip, 'recovery:owner@example.test');
    expect(throttle.recordFailure).not.toHaveBeenCalled();
  });
});
