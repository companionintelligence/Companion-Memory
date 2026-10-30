import { type INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

import { ContextService } from '@ci/common/context';
import { IdFormatGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { PositionController } from '../controllers/PositionController';
import { PositionService } from '../services/PositionService';

const POSITION_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

const positionService = {
  getStats: jest.fn(),
  findById: jest.fn(),
  findByDateRange: jest.fn(),
  findByGeofence: jest.fn(),
  remove: jest.fn(),
};

@Module({
  controllers: [PositionController],
  providers: [
    { provide: PositionService, useValue: positionService },
    // The global guard production registers. It 404s any `:id` that is not a UUID,
    // which is what turned a shadowed `/position/range` into a 404.
    { provide: APP_GUARD, useClass: IdFormatGuard },
  ],
})
class PositionRoutesTestModule {}

/**
 * These assert which handler a path reaches, at the HTTP layer. `range` and
 * `geofence` were declared after `:id`, so Express handed them to `findById` and
 * the id guard answered 404 for every caller.
 */
describe('Position routes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PositionRoutesTestModule] })
      .overrideGuard(JwtOrApiKeyAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      ContextService.run({ traceId: 'test-trace-id', userId: 'test-user-id' }, () => next());
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('serves GET /position/range from the date-range handler, not the :id one', async () => {
    positionService.findByDateRange.mockResolvedValue([]);

    await request(app.getHttpServer())
      .get('/position/range')
      .query({ start: '2026-10-14T00:00:00.000Z', end: '2026-10-15T00:00:00.000Z' })
      .expect(200, []);

    expect(positionService.findByDateRange).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'test-user-id' }),
      new Date('2026-10-14T00:00:00.000Z'),
      new Date('2026-10-15T00:00:00.000Z'),
    );
    expect(positionService.findById).not.toHaveBeenCalled();
  });

  it('serves GET /position/geofence from the geofence handler, not the :id one', async () => {
    positionService.findByGeofence.mockResolvedValue([]);

    await request(app.getHttpServer())
      .get('/position/geofence')
      .query({ type: 'radius', centerLon: '-122.39', centerLat: '37.79', radius: '500' })
      .expect(200, []);

    expect(positionService.findByGeofence).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'test-user-id' }),
      { center: { longitude: -122.39, latitude: 37.79 }, radius_meters: 500 },
      undefined,
      undefined,
    );
    expect(positionService.findById).not.toHaveBeenCalled();
  });

  it('still serves GET /position/stats', async () => {
    positionService.getStats.mockResolvedValue({ total: 2, byProvider: {}, lastFixAt: null });

    await request(app.getHttpServer()).get('/position/stats').expect(200);

    expect(positionService.getStats).toHaveBeenCalledTimes(1);
  });

  it('serves GET /position/:id for a UUID and 404s anything else before the handler', async () => {
    positionService.findById.mockResolvedValue({ id: POSITION_ID });

    await request(app.getHttpServer()).get(`/position/${POSITION_ID}`).expect(200, { id: POSITION_ID });
    await request(app.getHttpServer()).get('/position/not-a-uuid').expect(404);

    expect(positionService.findById).toHaveBeenCalledTimes(1);
  });

  it('answers 400, not 500, for a polygon point JSON.parse reads as Infinity', async () => {
    const coordinates =
      '[{"longitude":1e999,"latitude":0},{"longitude":1,"latitude":0},{"longitude":1,"latitude":1}]';

    await request(app.getHttpServer())
      .get('/position/geofence')
      .query({ type: 'polygon', coordinates })
      .expect(400);

    expect(positionService.findByGeofence).not.toHaveBeenCalled();
  });

  describe('DELETE /position/:id', () => {
    it('answers 204 once the row is removed', async () => {
      positionService.remove.mockResolvedValue(true);

      await request(app.getHttpServer()).delete(`/position/${POSITION_ID}`).expect(204);

      expect(positionService.remove).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'test-user-id' }),
        POSITION_ID,
      );
    });

    it('answers 404 when the service removed nothing', async () => {
      positionService.remove.mockResolvedValue(false);

      await request(app.getHttpServer()).delete(`/position/${POSITION_ID}`).expect(404);
    });

    it('does not answer 204 when the delete fails', async () => {
      positionService.remove.mockRejectedValue(new Error('database unavailable'));

      await request(app.getHttpServer()).delete(`/position/${POSITION_ID}`).expect(500);
    });
  });
});
