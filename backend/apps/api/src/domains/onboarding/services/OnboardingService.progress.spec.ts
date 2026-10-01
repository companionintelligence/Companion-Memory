import { ConflictException, NotFoundException } from '@nestjs/common';

import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { MessageService, ThreadService } from '@ci/domains/conversations';
import type { RelationshipService } from '@ci/domains/graph';
import type { ActionService, AnswerService, QuestionService } from '@ci/domains/intelligence';
import type { ConceptService, PersonService } from '@ci/domains/memory';
import type { UserService } from '@ci/domains/user';

import { OnboardingService } from './OnboardingService';

function createService(userService: jest.Mocked<Pick<UserService, 'findById' | 'update' | 'onboard'>>) {
  const logger = { setContext: jest.fn() } as unknown as LoggerService;

  return new OnboardingService(
    userService as unknown as UserService,
    {} as ThreadService,
    {} as MessageService,
    {} as ActionService,
    {} as QuestionService,
    {} as AnswerService,
    {} as ConceptService,
    {} as PersonService,
    {} as RelationshipService,
    { claimForSelf: jest.fn(), repointToEntity: jest.fn() } as never,
    { isFeatureEnabled: jest.fn().mockResolvedValue(false) } as unknown as FeatureService,
    logger,
  );
}

describe('OnboardingService progress', () => {
  const context = { userId: 'user-1' };

  let service: OnboardingService;
  let userService: jest.Mocked<Pick<UserService, 'findById' | 'update' | 'onboard'>>;

  beforeEach(() => {
    userService = {
      findById: jest.fn(),
      update: jest.fn(),
      onboard: jest.fn(),
    };
    service = createService(userService);
  });

  it('returns default progress for a fresh user', async () => {
    userService.findById.mockResolvedValue({
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
      onboarded: false,
      role: 'user',
      timezone: 'UTC',
      timeFormat: 'auto',
      onboardingProgress: null,
      entityId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.getProgress(context)).resolves.toEqual({
      stepKey: 'intro',
      draft: {},
      updatedAt: null,
    });
  });

  it('persists progress while onboarding is incomplete', async () => {
    userService.findById.mockResolvedValue({
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
      onboarded: false,
      role: 'user',
      timezone: 'UTC',
      timeFormat: 'auto',
      onboardingProgress: null,
      entityId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    userService.update.mockResolvedValue(null);

    const result = await service.saveProgress(context, {
      stepKey: 'connect-source',
      draft: { trust_mode: 'balanced' },
    });

    expect(result.stepKey).toBe('connect-source');
    expect(userService.update).toHaveBeenCalledWith(
      context,
      'user-1',
      expect.objectContaining({
        onboardingProgress: expect.objectContaining({
          stepKey: 'connect-source',
          draft: { trust_mode: 'balanced' },
        }),
      }),
    );
  });

  it('rejects progress updates after onboarding completes', async () => {
    userService.findById.mockResolvedValue({
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
      onboarded: true,
      role: 'user',
      timezone: 'UTC',
      timeFormat: 'auto',
      onboardingProgress: null,
      entityId: 'entity-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.saveProgress(context, { stepKey: 'intro', draft: {} })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('throws when user is missing', async () => {
    userService.findById.mockResolvedValue(null);

    await expect(service.getProgress(context)).rejects.toBeInstanceOf(NotFoundException);
  });
});
