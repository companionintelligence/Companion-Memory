import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { MessageService, ThreadService } from '@ci/domains/conversations';
import { RelationshipService, RelationshipType } from '@ci/domains/graph';
import { ActionService, AnswerService, QuestionService } from '@ci/domains/intelligence';
import { ConceptService, PersonService } from '@ci/domains/memory';
import { UserService } from '@ci/domains/user';

import {
  type OnboardingInput,
  type OnboardingProgressInput,
  type OnboardingProgressResponse,
  type OnboardingStepKey,
} from '../types';

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

/*
 * TODO(settings): Settings follow-up backlog (UI not built in this PR)
 *
 * | Field              | Stored at                              | Settings follow-up                                      |
 * |--------------------|----------------------------------------|---------------------------------------------------------|
 * | timezone           | ci.users.timezone                      | Already in PreferencesSection — no work                 |
 * | schedule.*         | self Person properties.schedule        | New Schedule subsection under Preferences               |
 * | trust_mode         | self Person properties.planner.trust_mode | New Autonomy subsection (reuse TrustDialStep options) |
 * | name               | ci.users.name                          | Profile subsection for name edit                      |
 * | focus/people/prefs | Graph (Concept + PREFERS)              | Optional future "About me" — lower priority             |
 * | connections        | connections domain                     | Already at /connect — link from Settings                |
 *
 * Prefer extending updateCurrentUser or adding updateSelfProfile GraphQL; reads from me.entity.properties.
 */

const FOCUS_AREAS: Record<string, FocusAreaMetadata> = {
  personal_fitness: {
    id: 'personal_fitness',
    name: 'Personal fitness and health',
    // Kept literal, and kept in sync with the same list in the web onboarding
    // (FocusAreas.tsx). A focus area becomes a concept node plus a PREFERS edge
    // (captureFocusAreas below) — a stated interest, nothing measured. Copy
    // implying the app tracks workouts or monitors progress would overstate the
    // product and jeopardise the Play "no health features" certification; see
    // frontend/apps/mobile/GOOGLE_HEALTH_DECLARATION.md.
    description: 'Organize workout notes, routines, and goals so your training context stays in one place',
  },
  nutrition: {
    id: 'nutrition',
    name: 'Nutrition and meal planning',
    description: 'Plan meals, organize grocery lists, and keep recipes and preferences together',
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

const DEFAULT_PROGRESS: OnboardingProgressResponse = {
  stepKey: 'intro',
  draft: {},
  updatedAt: null,
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
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(OnboardingService.name);
  }

  async getProgress(context: UserServiceContext): Promise<OnboardingProgressResponse> {
    const user = await this.userService.findById(context, context.userId);

    if (!user) {
      throw new NotFoundException();
    }

    if (user.onboarded) {
      return DEFAULT_PROGRESS;
    }

    const progress = user.onboardingProgress;

    if (!progress) {
      return DEFAULT_PROGRESS;
    }

    return {
      stepKey: progress.stepKey as OnboardingStepKey,
      draft: progress.draft ?? {},
      updatedAt: progress.updatedAt ?? null,
    };
  }

  async saveProgress(
    context: UserServiceContext,
    input: OnboardingProgressInput,
  ): Promise<OnboardingProgressResponse> {
    const user = await this.userService.findById(context, context.userId);

    if (!user) {
      throw new NotFoundException();
    }

    if (user.onboarded) {
      throw new ConflictException('Onboarding is already complete');
    }

    const updatedAt = new Date().toISOString();

    await this.userService.update(context, user.id, {
      onboardingProgress: {
        stepKey: input.stepKey,
        draft: input.draft,
        updatedAt,
      },
    });

    return {
      stepKey: input.stepKey,
      draft: input.draft,
      updatedAt,
    };
  }

  async onboard(context: UserServiceContext, input: OnboardingInput) {
    const user = await this.userService.findById(context, context.userId);

    if (!user) {
      throw new NotFoundException();
    }

    if (!user.onboarded) {
      // TODO(settings): expose name edit in Settings → Profile once that section exists.
      if (input.name?.trim()) {
        await this.userService.update(context, user.id, { name: input.name.trim() });
      }

      // TODO(settings): timezone already editable in PreferencesSection.
      if (input.timezone?.trim()) {
        await this.userService.update(context, user.id, { timezone: input.timezone.trim() });
      }

      const person = await this.createPersonForUser(context, input);

      await Promise.all([
        this.captureFocusAreas(context, person.id, input.focus_areas),
        this.captureConnections(context, person.id, input.people),
        this.capturePreferences(context, person.id, input),
        this.applySelfEntityPreferences(context, person.id, input),
        this.captureSurveyResponses(context, input),
      ]);

      // Actions-system seed cards are deferred ~24h after onboard (see InitialActionsCron)
      // so the first sync has time to land data before we surface recommendations.

      await this.userService.update(context, user.id, {
        onboardingProgress: null,
      });

      await this.userService.onboard(context.userId);
    }

    return {
      onboarded: true,
    };
  }

  async createPersonForUser(context: UserServiceContext, input?: OnboardingInput) {
    const user = await this.userService.findById(context, context.userId);

    if (user == null) {
      throw new Error('User could not be retrieved');
    }

    const id = uuidv7();
    const displayName = input?.name?.trim() || user.name || user.email;
    const [firstName, ...restName] = displayName.trim().split(/\s+/).filter(Boolean);
    const lastName = restName.join(' ');

    const properties: Record<string, unknown> = {
      email: user.email,
      is_self: true,
    };

    if (firstName.length > 0) {
      properties.first_name = firstName;
    }

    if (restName.length > 0) {
      properties.last_name = lastName;
    }

    if (input?.schedule) {
      // TODO(settings): Schedule subsection under Preferences — wake/sleep/work hours.
      properties.schedule = {
        ...input.schedule,
        source: 'onboarding',
      };
    }

    if (input?.trust_mode) {
      // TODO(settings): Autonomy subsection — same dial, reads/writes properties.planner.trust_mode.
      properties.planner = {
        trust_mode: input.trust_mode,
        source: 'onboarding',
      };
    }

    const person = await this.personService.create(context, {
      id,
      name: displayName,
      properties,
      description: 'This is you!',
    });

    await this.userService.update(context, user.id, {
      entityId: person.id,
    });

    return person;
  }

  private async applySelfEntityPreferences(
    context: UserServiceContext,
    personId: string,
    input: OnboardingInput,
  ) {
    if (!input.schedule && !input.trust_mode) {
      return;
    }

    const person = await this.personService.findById(context, personId);

    if (!person) {
      return;
    }

    const properties: Record<string, unknown> = { ...(person.properties ?? {}) };

    if (input.schedule) {
      properties.schedule = {
        ...input.schedule,
        source: 'onboarding',
      };
    }

    if (input.trust_mode) {
      properties.planner = {
        ...((properties.planner as Record<string, unknown> | undefined) ?? {}),
        trust_mode: input.trust_mode,
        source: 'onboarding',
      };
    }

    await this.personService.update(context, personId, { properties });
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

    return Promise.all(
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
    );
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

      this.createScheduleAnswers(context, input),
      this.createTrustModeAnswer(context, input.trust_mode),
    ]);
  }

  private async createScheduleAnswers(context: UserServiceContext, input: OnboardingInput) {
    const schedule = input.schedule;

    if (!schedule) {
      return;
    }

    const entries: Array<{ question: string; value: string; subcategory: string }> = [
      {
        question: 'What time do you usually wake up?',
        value: schedule.wake_time,
        subcategory: 'Schedule',
      },
      {
        question: 'What time do you usually go to bed?',
        value: schedule.sleep_time,
        subcategory: 'Schedule',
      },
      {
        question: 'When does your workday usually start?',
        value: schedule.work_start,
        subcategory: 'Schedule',
      },
      {
        question: 'When does your workday usually end?',
        value: schedule.work_end,
        subcategory: 'Schedule',
      },
    ];

    await Promise.all(
      entries.map(({ question, value, subcategory }) =>
        this.createPreferenceAnswer(context, value, { question, subcategory }),
      ),
    );
  }

  private async createTrustModeAnswer(context: UserServiceContext, trustMode: OnboardingInput['trust_mode']) {
    if (!trustMode) {
      return;
    }

    const labels: Record<string, string> = {
      cautious: 'Cautious — review everything yourself',
      balanced: 'Balanced — high-confidence items auto-promote',
      hands_off: 'Hands-off — auto-promote and auto-schedule estimate-bearing work',
    };

    await this.createPreferenceAnswer(context, labels[trustMode] ?? trustMode, {
      question: 'How much should your companion do on its own?',
      subcategory: 'Autonomy',
    });
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

  /**
   * Seed starter action cards for a user. Idempotent: no-ops when the actions
   * feature is off or the user already has any actions. Called by
   * {@link InitialActionsCron} ~24h after onboard.
   *
   * @returns true when seed cards were created
   */
  async initializeActionsForUser(context: UserServiceContext): Promise<boolean> {
    if (!(await this.featureService.isFeatureEnabled('actions'))) {
      return false;
    }

    const existing = await this.actionService.findAll(context);

    if (existing.length > 0) {
      return false;
    }

    await this.createInitialActions(context);

    return true;
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
