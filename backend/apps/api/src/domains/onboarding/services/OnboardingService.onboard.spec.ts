import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { MessageService, ThreadService } from '@ci/domains/conversations';
import { GraphIngestService, type RelationshipService } from '@ci/domains/graph';
import type { ActionService, AnswerService, QuestionService } from '@ci/domains/intelligence';
import type { ConceptService, PersonService } from '@ci/domains/memory';
import type { UserService } from '@ci/domains/user';

import { OnboardingService } from './OnboardingService';

describe('OnboardingService onboard', () => {
  const context = { userId: 'user-1' };

  let service: OnboardingService;
  let userService: jest.Mocked<
    Pick<UserService, 'findById' | 'update' | 'onboard' | 'setEntityIdIfUnchanged'>
  >;
  let personService: jest.Mocked<Pick<PersonService, 'create' | 'findById' | 'update' | 'patch' | 'remove'>>;
  let entityIdentifierService: { claimForSelf: jest.Mock; repointToEntity: jest.Mock };
  let actionService: jest.Mocked<Pick<ActionService, 'create' | 'findAll'>>;
  let featureService: jest.Mocked<Pick<FeatureService, 'isFeatureEnabled'>>;
  let logger: { setContext: jest.Mock; warn: jest.Mock };
  let relationshipService: { create: jest.Mock };

  beforeEach(() => {
    userService = {
      findById: jest.fn(),
      update: jest.fn(),
      onboard: jest.fn(),
      setEntityIdIfUnchanged: jest.fn(),
    };

    personService = {
      create: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      patch: jest.fn(),
      remove: jest.fn(),
    };
    // What PersonService.create does on an unused key: insert under the id it
    // was given and return that row.
    personService.create.mockImplementation(
      async (_context, data) => ({ id: data.id, name: data.name, properties: data.properties }) as never,
    );

    entityIdentifierService = { claimForSelf: jest.fn(), repointToEntity: jest.fn() };

    actionService = {
      create: jest.fn(),
      findAll: jest.fn().mockResolvedValue([]),
    };

    featureService = {
      isFeatureEnabled: jest.fn().mockResolvedValue(false),
    };

    logger = { setContext: jest.fn(), warn: jest.fn() };
    relationshipService = { create: jest.fn() };

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
      relationshipService as unknown as RelationshipService,
      entityIdentifierService as never,
      featureService as unknown as FeatureService,
      logger as unknown as LoggerService,
    );
  });

  it('writes a parent and a child the right way round: PARENT_OF points from parent to child', async () => {
    userService.findById.mockResolvedValue({
      id: 'user-1',
      name: 'user@example.com',
      email: 'user@example.com',
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
    userService.onboard.mockResolvedValue(undefined);
    userService.setEntityIdIfUnchanged.mockImplementation(async (_context, _id, entityId) => entityId);
    // The people from the step are created with no id of their own; give each one.
    personService.create.mockImplementation(
      async (_context, data) =>
        ({ id: data.id ?? `person:${data.name}`, name: data.name, properties: data.properties }) as never,
    );

    await service.onboard(context, {
      name: 'Ada Lovelace',
      timezone: 'UTC',
      schedule: null,
      trust_mode: 'balanced',
      focus_areas: [],
      people: [
        { first: 'Morgan', last: 'Lee', relationship: 'parent' },
        { first: 'Riley', last: 'Lee', relationship: 'child' },
      ],
      food_preference: null,
      movie_preference: null,
      activity_preference: null,
    } as never);

    const self = (await personService.create.mock.results[0].value) as { id: string };
    const byName = new Map(
      await Promise.all(
        personService.create.mock.results.map(async (result) => {
          const person = (await result.value) as { id: string; name: string };

          return [person.id, person.name] as const;
        }),
      ),
    );
    const edges = relationshipService.create.mock.calls.map(([, edge]) => [
      edge.fromNodeId === self.id ? 'me' : byName.get(edge.fromNodeId),
      edge.type,
      byName.get(edge.toNodeId),
    ]);

    // "Parent" in the step means "this person is my parent". RelationshipService
    // stores `me CHILD_OF Morgan` swapped, as `Morgan PARENT_OF me`.
    expect(edges).toEqual(
      expect.arrayContaining([
        ['me', 'CHILD_OF', 'Morgan Lee'],
        ['me', 'PARENT_OF', 'Riley Lee'],
      ]),
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
      timeFormat: 'auto',
      onboardingProgress: { stepKey: 'run-first-sync', draft: {}, updatedAt: new Date().toISOString() },
      entityId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    userService.update.mockResolvedValue(null);
    userService.onboard.mockResolvedValue(undefined);
    // Nobody else points the account anywhere: the compare-and-set lands.
    userService.setEntityIdIfUnchanged.mockImplementation(async (_context, _id, entityId) => entityId);

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
        description: 'This is you!',
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
    const created = (await personService.create.mock.results[0].value) as { id: string };
    expect(userService.setEntityIdIfUnchanged).toHaveBeenCalledTimes(1);
    expect(userService.setEntityIdIfUnchanged).toHaveBeenCalledWith(context, 'user-1', created.id, null);
    // The Person it made is the owner's as it stands: claimed, not patched.
    expect(personService.patch).not.toHaveBeenCalled();
    expect(entityIdentifierService.claimForSelf).toHaveBeenCalledWith('user-1', created.id, {
      emails: ['user@example.com'],
      names: ['Ada Lovelace'],
    });
    expect(entityIdentifierService.repointToEntity).toHaveBeenCalledWith(
      'user-1',
      created.id,
      'email',
      'user@example.com',
      'self',
    );
    expect(userService.update).toHaveBeenCalledWith(context, 'user-1', { onboardingProgress: null });
    expect(userService.onboard).toHaveBeenCalledWith('user-1');
    // Seed actions are deferred ~24h after setup (InitialActionsCron), not created here.
    expect(actionService.create).not.toHaveBeenCalled();
  });

  describe('createPersonForUser racing an import that provisions the self Person', () => {
    const user = {
      id: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      onboarded: false,
      entityId: null,
    };

    /** The self Person PushStage's ensureSelfEntityForOwner made under the shared key. */
    const importsPerson = { id: 'imports', name: 'ada@example.com', properties: { is_self: true } };

    beforeEach(() => {
      userService.findById.mockResolvedValue(user as never);
      userService.setEntityIdIfUnchanged.mockImplementation(async (_context, _id, entityId) => entityId);
    });

    it('creates its self Person under the key the import provisions one on', async () => {
      await service.createPersonForUser(context);

      expect(personService.create).toHaveBeenCalledWith(
        context,
        expect.objectContaining({
          linkedTable: 'import:self',
          linkedId: GraphIngestService.selfEntityLink('user-1').linkedId,
        }),
      );
    });

    it('keeps its own Person when it wins the pointer', async () => {
      const person = await service.createPersonForUser(context);

      const created = (await personService.create.mock.results[0].value) as { id: string };
      expect(person.id).toBe(created.id);
      expect(personService.remove).not.toHaveBeenCalled();
      expect(personService.patch).not.toHaveBeenCalled();
      expect(entityIdentifierService.claimForSelf).toHaveBeenCalledWith(
        'user-1',
        created.id,
        expect.anything(),
      );
    });

    it('makes the calls a plain signup always made, plus one read of the row it created', async () => {
      // Nothing else touches the account: the row reads back as created.
      personService.findById.mockImplementation(
        async (_context, id) => ({ id, name: 'Ada Lovelace', properties: {} }) as never,
      );
      const calls: string[] = [];
      const record = (name: string, mock: jest.Mock) => {
        const inner = mock.getMockImplementation();
        mock.mockImplementation(async (...args: unknown[]) => {
          calls.push(name);

          return inner?.(...args);
        });
      };

      record('userService.findById', userService.findById as jest.Mock);
      record('personService.create', personService.create as jest.Mock);
      record('userService.setEntityIdIfUnchanged', userService.setEntityIdIfUnchanged as jest.Mock);
      record('personService.findById', personService.findById as jest.Mock);
      record('personService.patch', personService.patch as jest.Mock);
      record('entityIdentifierService.claimForSelf', entityIdentifierService.claimForSelf);
      record('entityIdentifierService.repointToEntity', entityIdentifierService.repointToEntity);

      await service.createPersonForUser(context);

      expect(calls).toEqual([
        'userService.findById',
        'personService.create',
        'userService.setEntityIdIfUnchanged',
        'personService.findById',
        'entityIdentifierService.claimForSelf',
        'entityIdentifierService.repointToEntity',
      ]);
    });

    it('puts the typed name back when an import rewrote it before the pointer write', async () => {
      // The import's provisioner upserted on this key between onboarding's
      // create and its pointer write, replacing the name with the account's.
      personService.findById.mockImplementation(
        async (_context, id) =>
          ({
            id,
            name: 'ada@example.com',
            description: 'This is you!',
            properties: { is_self: true, names: ['ada@example.com'] },
          }) as never,
      );

      const person = await service.createPersonForUser(context, { name: 'Ada Typed' } as never);

      const created = (await personService.create.mock.results[0].value) as { id: string };
      expect(person.id).toBe(created.id);
      expect(personService.findById).toHaveBeenCalledWith(context, created.id);
      expect(personService.patch).toHaveBeenCalledTimes(1);
      expect(personService.patch).toHaveBeenCalledWith(context, created.id, {
        name: 'Ada Typed',
        propertiesPatch: expect.objectContaining({ is_self: true, first_name: 'Ada', last_name: 'Typed' }),
      });
      expect(entityIdentifierService.claimForSelf).toHaveBeenCalledWith('user-1', created.id, {
        emails: ['ada@example.com'],
        names: ['Ada Typed'],
      });
    });

    it('adopts the Person the import already made and pointed the account at, making no second one', async () => {
      // The import finished first: the key resolves to its row, and the pointer
      // already names it when onboarding tries to write it.
      personService.create.mockResolvedValue(importsPerson as never);
      userService.setEntityIdIfUnchanged.mockResolvedValue('imports');
      personService.findById.mockResolvedValue(importsPerson as never);

      const person = await service.createPersonForUser(context);

      expect(person.id).toBe('imports');
      expect(userService.setEntityIdIfUnchanged).toHaveBeenCalledWith(context, 'user-1', 'imports', null);
      expect(personService.patch).toHaveBeenCalledWith(
        context,
        'imports',
        expect.objectContaining({
          name: 'Ada Lovelace',
          propertiesPatch: expect.objectContaining({
            is_self: true,
            first_name: 'Ada',
            last_name: 'Lovelace',
          }),
        }),
      );
      expect(entityIdentifierService.claimForSelf).toHaveBeenCalledTimes(1);
      expect(entityIdentifierService.claimForSelf).toHaveBeenCalledWith(
        'user-1',
        'imports',
        expect.anything(),
      );
      expect(entityIdentifierService.repointToEntity).toHaveBeenCalledWith(
        'user-1',
        'imports',
        'email',
        'ada@example.com',
        'self',
      );
      expect(personService.remove).not.toHaveBeenCalled();
      expect(userService.update).not.toHaveBeenCalled();
    });

    it('points the account at the Person the import made when the import has not pointed it yet', async () => {
      // The import's row exists, but its own pointer write is still to come.
      personService.create.mockResolvedValue(importsPerson as never);
      personService.findById.mockResolvedValue(importsPerson as never);

      const person = await service.createPersonForUser(context);

      expect(person.id).toBe('imports');
      expect(userService.setEntityIdIfUnchanged).toHaveBeenCalledWith(context, 'user-1', 'imports', null);
      expect(personService.patch).toHaveBeenCalledWith(
        context,
        'imports',
        expect.objectContaining({ name: 'Ada Lovelace' }),
      );
      expect(entityIdentifierService.claimForSelf).toHaveBeenCalledTimes(1);
      expect(entityIdentifierService.claimForSelf).toHaveBeenCalledWith(
        'user-1',
        'imports',
        expect.anything(),
      );
      expect(personService.remove).not.toHaveBeenCalled();
    });

    it('adopts a Person the account was pointed at some other way, and deletes nothing', async () => {
      userService.setEntityIdIfUnchanged.mockResolvedValue('elsewhere');
      personService.findById.mockResolvedValue({ id: 'elsewhere', name: 'Ada', properties: {} } as never);

      const person = await service.createPersonForUser(context);

      const created = (await personService.create.mock.results[0].value) as { id: string };
      expect(person.id).toBe('elsewhere');
      expect(personService.patch).toHaveBeenCalledWith(
        context,
        'elsewhere',
        expect.objectContaining({ name: 'Ada Lovelace' }),
      );
      // The Person this call made stops claiming to be the owner: one is_self
      // row is left, not two.
      expect(personService.patch).toHaveBeenCalledWith(context, created.id, {
        propertiesPatch: { is_self: false },
      });
      expect(personService.patch).toHaveBeenCalledTimes(2);
      expect(entityIdentifierService.claimForSelf).toHaveBeenCalledTimes(1);
      expect(entityIdentifierService.claimForSelf).toHaveBeenCalledWith(
        'user-1',
        'elsewhere',
        expect.anything(),
      );
      expect(personService.remove).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("leaves the import's row alone when the key handed it back and the pointer went elsewhere", async () => {
      // Not this call's row to un-mark: the import made it, and the import
      // un-marks what it made when it sees the pointer elsewhere.
      personService.create.mockResolvedValue(importsPerson as never);
      userService.setEntityIdIfUnchanged.mockResolvedValue('elsewhere');
      personService.findById.mockResolvedValue({ id: 'elsewhere', name: 'Ada', properties: {} } as never);

      const person = await service.createPersonForUser(context);

      expect(person.id).toBe('elsewhere');
      expect(personService.patch).toHaveBeenCalledTimes(1);
      expect(personService.patch).not.toHaveBeenCalledWith(context, 'imports', expect.anything());
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('gives an adopted Person with no description the one onboarding creates its own with', async () => {
      personService.create.mockResolvedValue(importsPerson as never);
      personService.findById.mockResolvedValue({ ...importsPerson, description: null } as never);

      await service.createPersonForUser(context);

      expect(personService.patch).toHaveBeenCalledWith(
        context,
        'imports',
        expect.objectContaining({ name: 'Ada Lovelace', description: 'This is you!' }),
      );
    });

    it('keeps the description an adopted Person already has', async () => {
      personService.create.mockResolvedValue(importsPerson as never);
      personService.findById.mockResolvedValue({ ...importsPerson, description: 'Written by hand' } as never);

      await service.createPersonForUser(context);

      expect(personService.patch).toHaveBeenCalledWith(
        context,
        'imports',
        expect.not.objectContaining({ description: expect.anything() }),
      );
    });

    it('tries the pointer again when it was cleared after being read, instead of taking the null as a win', async () => {
      // The account's pointer named no Person when onboarding read it, and was
      // cleared before onboarding's write: a compare-and-set against the old
      // value lands on nothing and reports the null now there.
      userService.findById.mockResolvedValue({ ...user, entityId: 'dangling' } as never);
      personService.findById.mockResolvedValue(null);
      userService.setEntityIdIfUnchanged
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(async (_context, _id, entityId) => entityId);

      const person = await service.createPersonForUser(context);

      const created = (await personService.create.mock.results[0].value) as { id: string };
      expect(person.id).toBe(created.id);
      expect(userService.setEntityIdIfUnchanged).toHaveBeenNthCalledWith(
        1,
        context,
        'user-1',
        created.id,
        'dangling',
      );
      expect(userService.setEntityIdIfUnchanged).toHaveBeenNthCalledWith(
        2,
        context,
        'user-1',
        created.id,
        null,
      );
      expect(entityIdentifierService.claimForSelf).toHaveBeenCalledWith(
        'user-1',
        created.id,
        expect.anything(),
      );
      expect(userService.update).not.toHaveBeenCalled();
    });

    it('takes over a pointer that names no Person with the compare-and-set, never an unconditional write', async () => {
      userService.setEntityIdIfUnchanged
        .mockResolvedValueOnce('gone')
        .mockImplementationOnce(async (_context, _id, entityId) => entityId);
      personService.findById.mockResolvedValue(null);

      const person = await service.createPersonForUser(context);

      const created = (await personService.create.mock.results[0].value) as { id: string };
      expect(person.id).toBe(created.id);
      expect(userService.setEntityIdIfUnchanged).toHaveBeenNthCalledWith(
        2,
        context,
        'user-1',
        created.id,
        'gone',
      );
      expect(personService.remove).not.toHaveBeenCalled();
      expect(userService.update).not.toHaveBeenCalled();
    });

    it('fails rather than report a Person the account never pointed at', async () => {
      // The account row is gone: every compare-and-set lands on nothing.
      userService.setEntityIdIfUnchanged.mockResolvedValue(null);

      // Which account, and what its pointer held last, so the failure can be followed up.
      await expect(service.createPersonForUser(context)).rejects.toThrow(
        'Could not point the account at its self Person (user user-1, pointer last read null)',
      );
      expect(entityIdentifierService.claimForSelf).not.toHaveBeenCalled();
      expect(userService.update).not.toHaveBeenCalled();
    });

    it('names the last pointer it saw when the pointer keeps moving to no Person', async () => {
      userService.setEntityIdIfUnchanged
        .mockResolvedValueOnce('gone-1')
        .mockResolvedValueOnce('gone-2')
        .mockResolvedValueOnce('gone-3');
      personService.findById.mockResolvedValue(null);

      await expect(service.createPersonForUser(context)).rejects.toThrow(
        'Could not point the account at its self Person (user user-1, pointer last read gone-3)',
      );
    });
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
