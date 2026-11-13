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

  it('serves PWS service description when pws.storage is enabled and resists host poisoning', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new PwsController(mockFeatures);

    async function dispatchService(host: string, forwardedHost?: string) {
      const headersSent: Record<string, string> = {};
      let statusSent = 0;
      let bodySent: Buffer | undefined;

      const fakeReq = {
        method: 'GET',
        originalUrl: '/pws/service',
        url: '/pws/service',
        headers: {},
        get: (h: string) => {
          const lower = h.toLowerCase();
          if (lower === 'host') {
            return host;
          }

          if (lower === 'x-forwarded-host') {
            return forwardedHost;
          }

          return undefined;
        },
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

      return {
        statusSent,
        headersSent,
        parsed: JSON.parse(bodySent!.toString('utf8')) as Record<string, unknown>,
      };
    }

    const alpha = await dispatchService('alpha.example', 'evil-poison.attacker');
    expect(alpha.statusSent).toBe(200);
    expect(alpha.headersSent['content-type']).toContain('application/json');
    expect(alpha.parsed.specs).toBeDefined();
    expect(JSON.stringify(alpha.parsed)).toContain('https://alpha.example/pws/');
    expect(JSON.stringify(alpha.parsed)).not.toContain('evil-poison.attacker');

    const beta = await dispatchService('beta.example');
    expect(beta.statusSent).toBe(200);
    expect(JSON.stringify(beta.parsed)).toContain('https://beta.example/pws/');
    expect(JSON.stringify(beta.parsed)).not.toContain('alpha.example');
  });
});
