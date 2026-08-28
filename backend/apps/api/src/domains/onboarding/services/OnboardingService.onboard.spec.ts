import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { MessageService, ThreadService } from '@ci/domains/conversations';
import type { RelationshipService } from '@ci/domains/graph';
import type { ActionService, AnswerService, QuestionService } from '@ci/domains/intelligence';
import type { ConceptService, PersonService } from '@ci/domains/memory';
import type { UserService } from '@ci/domains/user';

import { OnboardingService } from './OnboardingService';

describe('OnboardingService onboard', () => {
  const context = { userId: 'user-1' };

  let service: OnboardingService;
  let userService: jest.Mocked<Pick<UserService, 'findById' | 'update' | 'onboard'>>;
  let personService: jest.Mocked<Pick<PersonService, 'create' | 'findById' | 'update'>>;
  let actionService: jest.Mocked<Pick<ActionService, 'create' | 'findAll'>>;
  let featureService: jest.Mocked<Pick<FeatureService, 'isFeatureEnabled'>>;

  beforeEach(() => {
    userService = {
      findById: jest.fn(),
      update: jest.fn(),
      onboard: jest.fn(),
    };

    personService = {
      create: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
    };

    actionService = {
      create: jest.fn(),
      findAll: jest.fn().mockResolvedValue([]),
    };

    featureService = {
      isFeatureEnabled: jest.fn().mockResolvedValue(false),
    };

    const logger = { setContext: jest.fn() } as unknown as LoggerService;

    service = new OnboardingService(
      userService as unknown as UserService,
      { create: jest.fn().mockResolvedValue({ id: 'thread-1' }) } as unknown as ThreadService,
      { create: jest.fn() } as unknown as MessageService,
      actionService as unknown as ActionService,
      {
        findAll: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'q-1' }),
      } as unknown as QuestionService,
      { create: jest.fn().mockResolvedValue({ id: 'a-1' }) } as unknown as AnswerService,
      { create: jest.fn() } as unknown as ConceptService,
      personService as unknown as PersonService,
      { create: jest.fn() } as unknown as RelationshipService,
      { claimForSelf: jest.fn(), repointToEntity: jest.fn() } as never,
      featureService as unknown as FeatureService,
      logger,
    );
  });

  it('persists name, timezone, schedule, and trust_mode on the self entity', async () => {
    userService.findById.mockResolvedValue({
      id: 'user-1',
      name: 'user@example.com',
      email: 'user@example.com',
      onboarded: false,
      role: 'user',
      timezone: 'UTC',
      onboardingProgress: { stepKey: 'run-first-sync', draft: {}, updatedAt: new Date().toISOString() },
      entityId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    userService.update.mockResolvedValue(null);
    userService.onboard.mockResolvedValue(undefined);
    personService.create.mockResolvedValue({ id: 'person-1', name: 'Ada Lovelace', properties: {} } as never);

    await service.onboard(context, {
      name: 'Ada Lovelace',
      timezone: 'America/New_York',
      schedule: {
        wake_time: '07:00',
        sleep_time: '21:00',
        work_start: '09:00',
        work_end: '18:00',
      },
      trust_mode: 'balanced',
      focus_areas: [],
      people: [],
      food_preference: null,
      movie_preference: null,
      activity_preference: null,
    });

    expect(userService.update).toHaveBeenCalledWith(context, 'user-1', { name: 'Ada Lovelace' });
    expect(userService.update).toHaveBeenCalledWith(context, 'user-1', {
      timezone: 'America/New_York',
    });
    expect(personService.create).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        name: 'Ada Lovelace',
        properties: expect.objectContaining({
          is_self: true,
          schedule: expect.objectContaining({
            wake_time: '07:00',
            source: 'onboarding',
          }),
          planner: {
            trust_mode: 'balanced',
            source: 'onboarding',
          },
        }),
      }),
    );
    expect(userService.update).toHaveBeenCalledWith(context, 'user-1', { onboardingProgress: null });
    expect(userService.onboard).toHaveBeenCalledWith('user-1');
    // Seed actions are deferred ~24h after setup (InitialActionsCron), not created here.
    expect(actionService.create).not.toHaveBeenCalled();
  });

  describe('initializeActionsForUser', () => {
    it('no-ops when the actions feature flag is off', async () => {
      featureService.isFeatureEnabled.mockResolvedValue(false);

      await expect(service.initializeActionsForUser(context)).resolves.toBe(false);
      expect(actionService.create).not.toHaveBeenCalled();
    });

    it('no-ops when the user already has actions', async () => {
      featureService.isFeatureEnabled.mockResolvedValue(true);
      actionService.findAll.mockResolvedValue([{ id: 'existing' } as never]);

      await expect(service.initializeActionsForUser(context)).resolves.toBe(false);
      expect(actionService.create).not.toHaveBeenCalled();
    });

    it('creates seed actions when enabled and the user has none', async () => {
      featureService.isFeatureEnabled.mockResolvedValue(true);
      actionService.findAll.mockResolvedValue([]);
      actionService.create.mockResolvedValue({ id: 'action-1' } as never);

      await expect(service.initializeActionsForUser(context)).resolves.toBe(true);
      expect(actionService.create).toHaveBeenCalled();
    });
  });
});
