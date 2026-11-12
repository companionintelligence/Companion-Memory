import { NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { PwsController } from './PwsController';

describe('PwsController', () => {
  it('throws NotFoundException when pws.storage flag is disabled', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(false),
    } as never;
    const controller = new PwsController(mockFeatures);

    const fakeReq = {
      method: 'GET',
      originalUrl: '/pws/service',
      url: '/pws/service',
      headers: {},
      get: () => 'example.com',
    } as unknown as Request;
    const fakeRes = {} as unknown as Response;

    await expect(controller.handle(fakeReq, fakeRes)).rejects.toThrow(NotFoundException);
  });

  it('serves PWS service description when pws.storage is enabled', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new PwsController(mockFeatures);

    const headersSent: Record<string, string> = {};
    let statusSent = 0;
    let bodySent: Buffer | undefined;

    const fakeReq = {
      method: 'GET',
      originalUrl: '/pws/service',
      url: '/pws/service',
      headers: {},
      get: (h: string) => (h === 'host' ? 'example.com' : undefined),
      protocol: 'https',
    } as unknown as Request;

    const fakeRes = {
      setHeader: (k: string, v: string) => {
        headersSent[k.toLowerCase()] = v;
      },
      status: (s: number) => {
        statusSent = s;
      },
      end: (b?: Buffer) => {
        bodySent = b;
      },
    } as unknown as Response;

    await controller.handle(fakeReq, fakeRes);

    expect(statusSent).toBe(200);
    expect(headersSent['content-type']).toContain('application/json');
    expect(bodySent).toBeDefined();
    const parsed = JSON.parse(bodySent!.toString('utf8'));
    expect(parsed.specs).toBeDefined();
  });
});
