/**
 * The planner must be constructible by Nest's injector with only the two
 * providers `LlmCoreModule` actually has for it.
 *
 * Its third constructor parameter, the calibration store, is a plain class
 * that tests pass by hand and the app leaves to a default. Without
 * `@Optional()` on it Nest treats it as a dependency and boot dies with
 * "Nest can't resolve dependencies of the ResidencyPlannerService
 * (LlmEndpointService, LoggerService, ?)" — which is exactly how this test
 * was first written: red.
 */
import { Test } from '@nestjs/testing';

import { LoggerService } from '@ci/common/logging';

import { LlmEndpointService } from '../LlmEndpointService';
import { ResidencyPlannerService } from '../ResidencyPlannerService';

describe('ResidencyPlannerService dependency injection', () => {
  it('resolves with LlmEndpointService and LoggerService alone', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ResidencyPlannerService,
        {
          provide: LlmEndpointService,
          useValue: { getOllamaHost: () => 'http://localhost:11434', usesOpenAiDriver: () => false },
        },
        {
          provide: LoggerService,
          useValue: {
            setContext: jest.fn(),
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
          },
        },
      ],
    }).compile();

    const planner = moduleRef.get(ResidencyPlannerService);

    expect(planner).toBeInstanceOf(ResidencyPlannerService);
    // The default store was built, not injected: no calibration file exists
    // in this checkout, so it loaded nothing and the plan is still unknown.
    expect(planner.residencyReport).toBeNull();
  });
});
