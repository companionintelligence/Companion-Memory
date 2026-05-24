import { Injectable, NotFoundException } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { MessageService, ThreadService } from '@ci/domains/conversations';
import { RelationshipService, RelationshipType } from '@ci/domains/graph';
import { ActionService, AnswerService, QuestionService } from '@ci/domains/intelligence';
import { ConceptService, PersonService } from '@ci/domains/memory';
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

const RELATIONSHIP_MAP: Record<
  string,
  {
    type: RelationshipType;
    bidirectional?: boolean;
  }
> = {
  partner: { type: RelationshipType.SPOUSE, bidirectional: true },
  parent: { type: RelationshipType.PARENT_OF },
  child: { type: RelationshipType.CHILD_OF },
  roommate: { type: RelationshipType.LIVES_WITH, bidirectional: true },
  friend: { type: RelationshipType.FRIENDS_WITH, bidirectional: true },
  coworker: { type: RelationshipType.WORKS_WITH, bidirectional: true },
  complicated: { type: RelationshipType.KNOWS, bidirectional: true },
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
    private readonly conceptService: ConceptService,
    private readonly personService: PersonService,
    private readonly relationshipService: RelationshipService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(OnboardingService.name);
  }

  async onboard(context: UserServiceContext, input: OnboardingInput) {
    const user = await this.userService.findById(context, context.userId);

    if (!user) {
      throw new NotFoundException();
    }

    if (!user.onboarded) {
      const person = await this.createPersonForUser(context);

      await Promise.all([
        this.captureFocusAreas(context, person.id, input.focus_areas),
        this.captureConnections(context, person.id, input.people),
        this.capturePreferences(context, person.id, input),
        this.createInitialActions(context),
        this.captureSurveyResponses(context, input),
      ]);

      await this.userService.onboard(context.userId);
    }

    return {
      onboarded: true,
    };
  }

  async createPersonForUser(context: UserServiceContext) {
    const user = await this.userService.findById(context, context.userId);

    if (user == null) {
      throw new Error('User could not be retrieved');
    }

    const id = uuidv7();
    const name = user.name ?? user.email;
    const [firstName, ...restName] = (user.name ?? '').trim().split(/\s+/).filter(Boolean);
    const lastName = restName.join(' ');

    const properties: Record<string, unknown> = {
      email: user.email,
    };

    if (firstName.length > 0) {
      properties.first_name = firstName;
    }

    if (restName.length > 0) {
      properties.last_name = lastName;
    }

    const person = await this.personService.create(context, {
      id,
      name,
      properties,
      description: 'This is you!',
    });

    await this.userService.update(context, user.id, {
      entityId: person.id,
    });

    return person;
  }

  private async captureFocusAreas(
    context: UserServiceContext,
    userEntityId: string,
    focusAreas: string[] | null,
  ) {
    if (!focusAreas || focusAreas.length === 0) {
      return;
    }

    return Promise.all(
      focusAreas
        .map((focusAreaId) => FOCUS_AREAS[focusAreaId])
        .filter(Boolean)
        .map(async (focusArea) => {
          const concept = await this.conceptService.create(context, {
            name: focusArea.name,
            description: focusArea.description,
            properties: {
              source: 'onboarding',
            },
          });

          await this.relationshipService.create(context, {
            fromNodeId: userEntityId,
            fromNodeType: 'person',
            toNodeId: concept.id,
            toNodeType: 'concept',
            type: 'PREFERS',
            strength: 0.9,
            properties: {
              source: 'onboarding',
            },
          });
        }),
    );
  }

  private async captureConnections(
    context: UserServiceContext,
    userEntityId: string,
    people: OnboardingInput['people'],
  ) {
    if (!people || people.length === 0) {
      return;
    }

    const entries = people
      .map((person) => this.normalizePerson(person))
      .filter((value): value is NormalizedPerson => value != null);

    if (entries.length === 0) {
      return;
    }

    return Promise.all([
      entries.map(async (entry) => {
        const person = await this.personService.create(context, {
          name: entry.displayName,
          properties: {
            source: 'onboarding',
            firstName: entry.firstName,
            lastName: entry.lastName,
          },
        });

        await this.relationshipService.create(context, {
          fromNodeId: userEntityId,
          fromNodeType: 'person',
          toNodeId: person.id,
          toNodeType: 'person',
          ...this.mapRelationship(entry.relationship),
          strength: entry.relationship.toLowerCase() === 'friend' ? 0.8 : 0.7,
          properties: {
            source: 'onboarding',
          },
        });
      }),
    ]);
  }

  private async capturePreferences(
    context: UserServiceContext,
    userEntityId: string,
    input: OnboardingInput,
  ) {
    const preferences = [
      { value: input.food_preference, category: 'food' },
      { value: input.movie_preference, category: 'entertainment' },
      { value: input.activity_preference, category: 'activity' },
    ];

    return Promise.all(
      preferences.map(async ({ value, category }) => {
        if (!value) {
          return;
        }

        const concept = await this.conceptService.create(context, {
          name: value,
          properties: {
            category,
            source: 'onboarding',
          },
        });

        await this.relationshipService.create(context, {
          fromNodeId: userEntityId,
          fromNodeType: 'person',
          toNodeId: concept.id,
          toNodeType: 'concept',
          type: 'PREFERS',
          strength: 0.85,
          properties: {
            category,
            source: 'onboarding',
          },
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

    const question = await this.questionService.create(context, {
      text: options.question,
      category: options.subcategory,
      isPrivateTo: context.userId,
    });

    await this.answerService.create(context, {
      text: value,
      question,
    });
  }

  private async createInitialActions(context: UserServiceContext) {
    const createMealAction = async () => {
      const thread = await this.threadService.create(context, {
        name: 'Plan a meal',
      });

      await Promise.all([
        this.messageService.create(context, {
          role: 'assistant',
          model: 'qwen3:8b',
          content: 'Would you like me to help you plan a meal that you will enjoy?',
          threadId: thread.id,
        }),

        this.actionService.create(context, {
          title: 'Make dinner tonight',
          text: "Because you haven't cooked a meal yet this week, I am recommending you plan something.",
          imageUrl: '/actions/dinner.jpg',
          priority: 0,
          threadId: thread.id,
        }),
      ]);
    };

    const createMovieAction = async () => {
      const thread = await this.threadService.create(context, {
        name: 'Plan a movie',
      });

      await Promise.all([
        this.actionService.create(context, {
          title: 'Watch a movie',
          text: "Why don't you watch a movie tonight? It's a simple way for you to relax and unwind.",
          imageUrl: '/actions/movie_night.jpg',
          priority: 1,
          threadId: thread.id,
        }),

        this.messageService.create(context, {
          role: 'assistant',
          model: 'qwen3:8b',
          content: 'Would you like me to help you find a movie that you will enjoy?',
          threadId: thread.id,
        }),
      ]);
    };

    const createActivityAction = async () => {
      const thread = await this.threadService.create(context, {
        name: 'Plan an activity',
      });

      await Promise.all([
        this.actionService.create(context, {
          title: 'Take a break this weekend',
          text: 'The weekend is a perfect opportunity to step away from routine and recharge in a different environment. Taking time outside the usual surroundings can bring a refreshing change of pace and perspective.',
          imageUrl: '/actions/woods.jpg',
          priority: 2,
          threadId: thread.id,
        }),

        this.messageService.create(context, {
          role: 'assistant',
          model: 'qwen3:8b',
          content: 'Would you like me to help you find an activity that you will enjoy?',
          threadId: thread.id,
        }),
      ]);
    };

    return Promise.all([createMealAction(), createMovieAction(), createActivityAction()]);
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

  private mapRelationship(input: string | undefined | null): {
    type: RelationshipType;
    bidirectional?: boolean;
  } {
    const key = (input ?? '').toLowerCase();
    const mapping = RELATIONSHIP_MAP[key];

    if (mapping) {
      return mapping;
    }

    return {
      type: RelationshipType.ASSOCIATED_WITH,
      bidirectional: true,
    };
  }
}
