import { Test } from '@nestjs/testing';

import { PORTAL_TOKEN_VERIFIER } from '@ci/common/guards/PortalTokenVerifier';
import config from '@ci/configuration';

import { MapsConfigController } from '../MapsConfigController';

describe('MapsConfigController', () => {
  let controller: MapsConfigController;
  const originalKey = config.geocoding.apiKey;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MapsConfigController],
      providers: [{ provide: PORTAL_TOKEN_VERIFIER, useValue: { verify: jest.fn() } }],
    }).compile();

    controller = moduleRef.get(MapsConfigController);
  });

  afterEach(() => {
    config.geocoding.apiKey = originalKey;
  });

  it('returns configured:false when no geocoding key is set', () => {
    config.geocoding.apiKey = undefined;

    expect(controller.maps()).toEqual({ configured: false });
  });

  it('returns the geocoding api key when configured', () => {
    config.geocoding.apiKey = 'AIzaSyTestRuntimeMapsKey';

    expect(controller.maps()).toEqual({
      configured: true,
      apiKey: 'AIzaSyTestRuntimeMapsKey',
    });
  });
});
