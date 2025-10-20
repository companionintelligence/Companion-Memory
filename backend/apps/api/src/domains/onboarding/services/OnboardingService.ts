import { Injectable, NotFoundException } from '@nestjs/common';

import { RequestContext } from '@ci/common/types';
import { MessageService, ThreadService } from '@ci/domains/conversations';
import { GraphQueryService } from '@ci/domains/graph';
import { ActionService, AnswerService, QuestionService } from '@ci/domains/intelligence';
import { GraphEventService } from '@ci/domains/memory';
import { UserService } from '@ci/domains/user';

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
    private readonly graphEvents: GraphEventService,
    private readonly graphQuery: GraphQueryService,
  ) {}

  async onboard(context: RequestContext, input: OnboardingInput) {
    const userId = this.ensureUserId(context);
    const user = await this.userService.findOne(userId);

    if (!user) {
      throw new NotFoundException();
    }

    const userEntityId = await this.ensureUserEntity(userId, user.name, user.email);

    if (!user.onboarded) {
      await this.bootstrapUserExperience(context);
    }

    await Promise.all([
      this.captureFocusAreas(userId, userEntityId, input.focus_areas),
      this.captureConnections(userId, userEntityId, input.people),
      this.capturePreferences(userId, userEntityId, input),
      this.captureSurveyResponses(context, input),
    ]);

    if (!user.onboarded) {
      await this.userService.onboard(userId);
    }

    return {
      onboarded: true,
    };
  }

  private ensureUserId(context: RequestContext): string {
    if (!context.userId) {
      throw new NotFoundException();
    }

    return context.userId;
  }

  private async ensureUserEntity(userId: string, name: string | null, email: string) {
    const existing = await this.graphQuery.getUserEntity(userId);

    if (existing?.entity_id) {
      return existing.entity_id;
    }

    const fallbackName = name?.trim() || email;
    const properties: Record<string, unknown> = {
      email,
    };

    const nameParts = (name ?? '').trim().split(/\s+/).filter(Boolean);

    if (nameParts.length > 0) {
      properties.first_name = nameParts[0];
    }

    if (nameParts.length > 1) {
      properties.last_name = nameParts.slice(1).join(' ');
    }

    const { entityId } = await this.graphEvents.upsertNode(userId, {
      entityId: existing?.entity_id ?? undefined,
      entityType: 'Person',
      name: fallbackName,
      description: fallbackName,
      properties,
      linkedTable: 'users',
      linkedId: userId,
      mergeProperties: true,
    });

    await this.userService.update(userId, { entityId });

    return entityId;
  }

  private async captureFocusAreas(ownerId: string, userEntityId: string, focusAreas: string[] | null) {
    if (!focusAreas || focusAreas.length === 0) {
      return;
    }

    const preferences = focusAreas
      .map((id) => FOCUS_AREAS[id])
      .filter((meta): meta is FocusAreaMetadata => !!meta)
      .map((meta) => ({
        name: meta.name,
        type: 'FocusArea',
        strength: 0.9,
        properties: {
          focusAreaId: meta.id,
          description: meta.description,
          source: 'onboarding',
        },
      }));

    if (preferences.length === 0) {
      return;
    }

    await this.graphEvents.addPreferences(ownerId, {
      personEntityId: userEntityId,
      preferences,
    });
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

    await Promise.all(
      entries.map((person) => {
        const relationship = this.mapRelationship(person.relationship);

        return this.graphEvents.addPerson(ownerId, {
          name: person.displayName,
          firstName: person.firstName,
          lastName: person.lastName,
          properties: {
            source: 'onboarding',
            relationshipInput: person.relationship,
          },
          relationships: [
            {
              toPersonEntityId: userEntityId,
              type: relationship.type,
              strength: relationship.type === 'FRIEND' ? 0.8 : 0.7,
              bidirectional: relationship.bidirectional,
              properties: {
                source: 'onboarding',
                label: person.relationship,
              },
            },
          ],
        });
      }),
    );
  }

  private async capturePreferences(ownerId: string, userEntityId: string, input: OnboardingInput) {
    const tasks: Array<Promise<unknown>> = [];

    if (input.food_preference) {
      tasks.push(
        this.graphEvents.addPreference(ownerId, {
          personEntityId: userEntityId,
          name: input.food_preference,
          type: 'Cuisine',
          strength: 0.85,
          properties: {
            category: 'food',
            source: 'onboarding',
          },
        }),
      );
    }

    if (input.movie_preference) {
      tasks.push(
        this.graphEvents.addPreference(ownerId, {
          personEntityId: userEntityId,
          name: input.movie_preference,
          type: 'MovieGenre',
          strength: 0.85,
          properties: {
            category: 'entertainment',
            source: 'onboarding',
          },
        }),
      );
    }

    if (input.activity_preference) {
      tasks.push(
        this.graphEvents.addPreference(ownerId, {
          personEntityId: userEntityId,
          name: input.activity_preference,
          type: 'Activity',
          strength: 0.85,
          properties: {
            category: 'activity',
            source: 'onboarding',
          },
        }),
      );
    }

    if (tasks.length === 0) {
      return;
    }

    await Promise.all(tasks);
  }

  private async captureSurveyResponses(context: RequestContext, input: OnboardingInput) {
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
    context: RequestContext,
    value: string | null,
    options: { question: string; subcategory: string },
  ) {
    if (!value) {
      return;
    }

    const question = await this.questionService.create(context, {
      text: options.question,
      subcategory: options.subcategory,
      isPrivateTo: context.userId ?? null,
    });

    await this.answerService.create(context, {
      text: value,
      question,
    });
  }

  private async bootstrapUserExperience(context: RequestContext) {
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
}
