import { Injectable, NotFoundException } from '@nestjs/common';
import { v7 as uuid7 } from 'uuid';

import { type UserServiceContext, SYSTEM_USER, toServiceContext } from '@ci/common/context';
import { MessageService, ThreadService } from '@ci/domains/conversations';
import { ActionService, AnswerService, QuestionService } from '@ci/domains/intelligence';
import { ConceptService, PersonService, RelationshipService } from '@ci/domains/memory';
import { type User, UserService } from '@ci/domains/user';

import { OnboardingInput } from '../types';

type PersonInput = NonNullable<OnboardingInput['people']>[number];

interface NormalizedPerson {
  firstName?: string;
  lastName?: string;
  displayName: string;
  relationship: string;
}

type FocusAreaMetadata = {
  id: string;
  name: string;
  description: string;
};

const FOCUS_AREAS: Record<string, FocusAreaMetadata> = {
  personal_fitness: {
    id: 'personal_fitness',
    name: 'Personal fitness and health',
    description:
      'Track workouts, monitor progress, and build habits that support long-term physical wellbeing',
  },
  nutrition: {
    id: 'nutrition',
    name: 'Nutrition and meal planning',
    description: 'Plan meals, organize grocery lists, and align food choices with your health goals',
  },
  communication: {
    id: 'communication',
    name: 'Communication management',
    description: 'Centralize messages, schedule conversations, and keep track of important interactions',
  },
  entertainment: {
    id: 'entertainment',
    name: 'Entertainment and activities',
    description: 'Organize hobbies, events, and downtime to bring balance and enjoyment to your schedule',
  },
  travel: {
    id: 'travel',
    name: 'Travel planning',
    description: 'Manage itineraries, bookings, and logistics to make trips easier from start to finish',
  },
};

const RELATIONSHIP_MAP: Record<string, { type: string; bidirectional?: boolean }> = {
  partner: { type: 'SPOUSE', bidirectional: true },
  parent: { type: 'PARENT_OF' },
  child: { type: 'CHILD_OF' },
  roommate: { type: 'LIVES_WITH', bidirectional: true },
  friend: { type: 'FRIEND', bidirectional: true },
  coworker: { type: 'COLLEAGUE', bidirectional: true },
  complicated: { type: 'RELATIONSHIP_COMPLEX', bidirectional: true },
};

@Injectable()
export class OnboardingService {
  constructor(
    private readonly userService: UserService,
    private readonly threadService: ThreadService,
    private readonly messageService: MessageService,
    private readonly actionService: ActionService,
    private readonly questionService: QuestionService,
    private readonly answerService: AnswerService,
    private readonly personService: PersonService,
    private readonly conceptService: ConceptService,
    private readonly relationshipService: RelationshipService,
  ) {}

  async onboard(context: UserServiceContext, input: OnboardingInput) {
    const user = await this.userService.findById(context, context.userId);

    if (!user) {
      throw new NotFoundException();
    }

    const userEntityId = await this.ensureUserEntity(context, user);

    if (!user.onboarded) {
      await this.bootstrapUserExperience(context);
    }

    await Promise.all([
      this.captureFocusAreas(context.userId, userEntityId, input.focus_areas),
      this.captureConnections(context.userId, userEntityId, input.people),
      this.capturePreferences(context.userId, userEntityId, input),
      this.captureSurveyResponses(context, input),
    ]);

    if (!user.onboarded) {
      await this.userService.onboard(context.userId);
    }

    return {
      onboarded: true,
    };
  }

  private async ensureUserEntity(context: UserServiceContext, user: User) {
    const existing = await this.personService.search(context, {
      linkedId: user.id,
      linkedTable: 'users',
    });

    if (existing.length > 0) {
      const entityId = existing[0].id;

      if (user.entityId !== entityId) {
        await this.userService.update({ userId: SYSTEM_USER }, user.id, { entityId });
      }

      return entityId;
    }

    const fallbackName = user.name?.trim() || user.email;
    const properties: Record<string, unknown> = {
      email: user.email,
    };

    const nameParts = (user.name ?? '').trim().split(/\s+/).filter(Boolean);

    if (nameParts.length > 0) {
      properties.first_name = nameParts[0];
    }

    if (nameParts.length > 1) {
      properties.last_name = nameParts.slice(1).join(' ');
    }

    const person = await this.personService.create(context, {
      name: fallbackName,
      description: fallbackName,
      searchContent: fallbackName,
      linkedTable: 'users',
      linkedId: user.id,
      properties,
    });

    await this.userService.update({ userId: SYSTEM_USER }, user.id, { entityId: person.id });

    return person.id;
  }

  private async captureFocusAreas(ownerId: string, userEntityId: string, focusAreas: string[] | null) {
    if (!focusAreas || focusAreas.length === 0) {
      return;
    }

    const metadata = focusAreas
      .map((id) => FOCUS_AREAS[id])
      .filter((meta): meta is FocusAreaMetadata => !!meta);

    if (metadata.length === 0) {
      return;
    }

    const serviceContext = {
      userId: ownerId,
    };

    await Promise.all(
      metadata.map(async (meta) => {
        const conceptId = await this.ensureConcept(serviceContext, meta.name, 'FocusArea', {
          focusAreaId: meta.id,
          description: meta.description,
          source: 'onboarding',
        });

        await this.relationshipService.create(serviceContext, {
          fromEntityId: userEntityId,
          toEntityId: conceptId,
          relationshipType: 'PREFERS',
          strength: 0.9,
          properties: {
            focusAreaId: meta.id,
            source: 'onboarding',
          },
        });
      }),
    );
  }

  private async captureConnections(ownerId: string, userEntityId: string, people: OnboardingInput['people']) {
    if (!people || people.length === 0) {
      return;
    }

    const entries = people
      .map((person) => this.normalizePerson(person))
      .filter((value): value is NormalizedPerson => value !== null);

    if (entries.length === 0) {
      return;
    }

    const serviceContext = {
      userId: ownerId,
    };

    await Promise.all(
      entries.map(async (person) => {
        const relationship = this.mapRelationship(person.relationship);

        const created = await this.personService.create(serviceContext, {
          name: person.displayName,
          description: person.displayName,
          searchContent: person.displayName,
          linkedTable: 'onboarding_people',
          linkedId: uuid7(),
          properties: {
            source: 'onboarding',
            relationshipInput: person.relationship,
            first_name: person.firstName,
            last_name: person.lastName,
          },
        });

        await this.relationshipService.create(serviceContext, {
          fromEntityId: created.id,
          toEntityId: userEntityId,
          relationshipType: relationship.type,
          strength: relationship.type === 'FRIEND' ? 0.8 : 0.7,
          isBidirectional: relationship.bidirectional ?? false,
          properties: {
            source: 'onboarding',
            label: person.relationship,
          },
        });
      }),
    );
  }

  private async capturePreferences(ownerId: string, userEntityId: string, input: OnboardingInput) {
    const serviceContext = {
      userId: ownerId,
    };

    const preferences: Array<{
      value: string | null;
      type: string;
      strength: number;
      conceptProps: Record<string, unknown>;
      relationshipProps: Record<string, unknown>;
    }> = [
      {
        value: input.food_preference,
        type: 'Cuisine',
        strength: 0.85,
        conceptProps: { category: 'food', source: 'onboarding' },
        relationshipProps: { category: 'food', source: 'onboarding' },
      },
      {
        value: input.movie_preference,
        type: 'MovieGenre',
        strength: 0.85,
        conceptProps: { category: 'entertainment', source: 'onboarding' },
        relationshipProps: { category: 'entertainment', source: 'onboarding' },
      },
      {
        value: input.activity_preference,
        type: 'Activity',
        strength: 0.85,
        conceptProps: { category: 'activity', source: 'onboarding' },
        relationshipProps: { category: 'activity', source: 'onboarding' },
      },
    ];

    await Promise.all(
      preferences
        .filter((pref) => pref.value)
        .map(async (pref) => {
          const conceptId = await this.ensureConcept(
            serviceContext,
            pref.value!,
            pref.type,
            pref.conceptProps,
          );

          await this.relationshipService.create(serviceContext, {
            fromEntityId: userEntityId,
            toEntityId: conceptId,
            relationshipType: 'PREFERS',
            strength: pref.strength,
            properties: pref.relationshipProps,
          });
        }),
    );
  }

  private async captureSurveyResponses(context: UserServiceContext, input: OnboardingInput) {
    await Promise.all([
      this.createPreferenceAnswer(context, input.food_preference, {
        question: 'Choosing a food between pasta, burgers, salads, or tacos, which would be your favorite?',
        subcategory: 'Food',
      }),
      this.createPreferenceAnswer(context, input.movie_preference, {
        question:
          'Choosing a movie genre between comedies, dramas, documentaries, or horror, which would be your favorite?',
        subcategory: 'Entertainment',
      }),
      this.createPreferenceAnswer(context, input.activity_preference, {
        question:
          'Choosing an activity between hiking, bowling, ice skating, or going arcading, which would be your favorite?',
        subcategory: 'Entertainment',
      }),
    ]);
  }

  private async createPreferenceAnswer(
    context: UserServiceContext,
    value: string | null,
    options: { question: string; subcategory: string },
  ) {
    if (!value) {
      return;
    }

    const serviceContext = toServiceContext(context);

    const question = await this.questionService.create(serviceContext, {
      text: options.question,
      subcategory: options.subcategory,
      isPrivateTo: context.userId ?? null,
    });

    await this.answerService.create(serviceContext, {
      text: value,
      question,
    });
  }

  private async bootstrapUserExperience(context: UserServiceContext) {
    const [mealThread, movieThread, activityThread] = await Promise.all([
      this.threadService.create(context, { name: 'Plan a meal' }),
      this.threadService.create(context, { name: 'Plan a movie' }),
      this.threadService.create(context, { name: 'Plan an activity' }),
    ]);

    await Promise.all([
      this.messageService.create(context, {
        role: 'assistant',
        model: 'qwen3:8b',
        content: 'Would you like me to help you plan a meal that you will enjoy?',
        threadId: mealThread.id,
      }),
      this.messageService.create(context, {
        role: 'assistant',
        model: 'qwen3:8b',
        content: 'Would you like me to help you find a movie that you will enjoy?',
        threadId: movieThread.id,
      }),
      this.messageService.create(context, {
        role: 'assistant',
        model: 'qwen3:8b',
        content: 'Would you like me to help you find an activity that you will enjoy?',
        threadId: activityThread.id,
      }),
      this.actionService.create(context, {
        title: 'Make dinner tonight',
        text: "Because you haven't cooked a meal yet this week, I am recommending you plan something.",
        imageUrl: '/actions/dinner.jpg',
        priority: 0,
        threadId: mealThread.id,
      }),
      this.actionService.create(context, {
        title: 'Watch a movie',
        text: "Why don't you watch a movie tonight? It's a simple way for you to relax and unwind.",
        imageUrl: '/actions/movie_night.jpg',
        priority: 1,
        threadId: movieThread.id,
      }),
      this.actionService.create(context, {
        title: 'Take a break this weekend',
        text: 'The weekend is a perfect opportunity to step away from routine and recharge in a different environment. Taking time outside the usual surroundings can bring a refreshing change of pace and perspective.',
        imageUrl: '/actions/woods.jpg',
        priority: 2,
        threadId: activityThread.id,
      }),
    ]);
  }

  private normalizePerson(person: PersonInput): NormalizedPerson | null {
    if (!person) {
      return null;
    }

    const firstName = person.first?.trim();
    const lastName = person.last?.trim();
    const relationship = person.relationship?.trim();

    if (!firstName && !lastName) {
      return null;
    }

    const displayName = [firstName, lastName].filter(Boolean).join(' ').trim();

    return {
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      displayName: displayName || firstName || lastName || 'Someone',
      relationship: relationship || 'friend',
    };
  }

  private mapRelationship(input: string | undefined | null) {
    const key = (input ?? '').toLowerCase();
    const mapping = RELATIONSHIP_MAP[key];

    if (mapping) {
      return mapping;
    }

    return {
      type: 'ASSOCIATED_WITH',
      bidirectional: true,
    };
  }

  private async ensureConcept(
    context: UserServiceContext,
    name: string,
    type: string,
    extraProps: Record<string, unknown> = {},
  ): Promise<string> {
    const existing = await this.conceptService.search(context, { name });

    if (existing.length > 0) {
      return existing[0].id;
    }

    const concept = await this.conceptService.create(context, {
      name,
      description: `${type}: ${name}`,
      searchContent: name,
      linkedTable: 'onboarding_concepts',
      linkedId: uuid7(),
      properties: {
        type,
        ...extraProps,
      },
    });

    return concept.id;
  }
}
