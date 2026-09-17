import { type CreateSummaryDto } from '@ci/domains/summaries';

type SeedSummary = RequiredFields<CreateSummaryDto, 'summaryId'>;

import { JOHN_SMITH } from './users';

export const SUMMARIES: SeedSummary[] = [
  {
    summaryId: '01936cb0-0000-7000-8000-000000000001',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-13T09:00:00Z'),
    periodEnd: new Date('2026-01-13T10:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['browser_activity', 'files'],
    title: 'Hourly Summary',
    content: {
      tokens_used: 420,
      key_insights: [
        'Focused coding session working on GraphQL implementation.',
        'Multiple file edits in the backend API codebase.',
        'Consistent browser activity related to TypeScript documentation.',
        'High productivity hour with minimal context switching.',
      ],
      summary_text:
        'The user engaged in a focused coding session from 09:00 to 10:00, working primarily on backend GraphQL implementation. Browser activity showed consistent reference to TypeScript and NestJS documentation, indicating active learning and development work.',
      activity_counts: {
        files: 8,
        total: 23,
        events: 0,
        api_logs: 0,
        messages: 0,
        positions: 0,
        activities: 0,
        measurements: 0,
        communications: 0,
        screen_captures: 0,
        browser_activity: 15,
      },
      structured_data: {
        tags: ['coding', 'backend_development', 'graphql', 'typescript', 'focused_work'],
        anomalies: [],
        key_insights: [
          'Focused coding session working on GraphQL implementation.',
          'Multiple file edits in the backend API codebase.',
          'Consistent browser activity related to TypeScript documentation.',
          'High productivity hour with minimal context switching.',
        ],
        summary_text:
          'The user engaged in a focused coding session from 09:00 to 10:00, working primarily on backend GraphQL implementation. Browser activity showed consistent reference to TypeScript and NestJS documentation, indicating active learning and development work.',
        notable_events: [
          'Created new SummaryEntity and SummaryService files.',
          'Multiple documentation lookups for TypeORM decorators.',
        ],
      },
    },
    confidenceScore: 1.0,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000004',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-13T12:00:00Z'),
    periodEnd: new Date('2026-01-13T13:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['memory', 'relationships', 'browsing', 'places'],
    title: 'Anniversary Planning',
    content: {
      tokens_used: 156,
      key_insights: [
        "Carmine's Italian is your most-visited dinner spot, and 7:30 PM is the table time on every past booking",
        'Mexican food comes up more than any other cuisine in your messages with Sarah',
        'Your last three anniversary dinners were arranged about ten days ahead — that window opens this weekend',
      ],
      summary_text:
        "Your anniversary is coming up. Across your calendar, receipts and messages, you and Sarah Smith most often dine at Carmine's Italian, The Willow Bistro, and El Camino Taqueria. Open any of them to see the visits this is drawn from.",
      activity_counts: {
        total: 10,
      },
      structured_data: {
        tags: ['Anniversary', 'Reservations', 'Planner'],
      },
    },
    confidenceScore: 0.95,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000002',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-13T14:00:00Z'),
    periodEnd: new Date('2026-01-13T15:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['browser_activity', 'communications'],
    title: 'Hourly Summary',
    content: {
      tokens_used: 380,
      key_insights: [
        'Participated in team video meeting about feature planning.',
        'Reviewed pull requests and left feedback on GitHub.',
        'Responded to several Slack messages regarding project timelines.',
        'Brief context switch to check email and calendar.',
      ],
      summary_text:
        'The user had a collaboration-heavy hour from 14:00 to 15:00, participating in a team meeting and engaging in asynchronous communication. Activity included code reviews on GitHub and team coordination via Slack.',
      activity_counts: {
        files: 0,
        total: 18,
        events: 0,
        api_logs: 0,
        messages: 0,
        positions: 0,
        activities: 0,
        measurements: 0,
        communications: 7,
        screen_captures: 0,
        browser_activity: 11,
      },
      structured_data: {
        tags: ['meetings', 'collaboration', 'code_review', 'communication', 'team_coordination'],
        anomalies: [],
        key_insights: [
          'Participated in team video meeting about feature planning.',
          'Reviewed pull requests and left feedback on GitHub.',
          'Responded to several Slack messages regarding project timelines.',
          'Brief context switch to check email and calendar.',
        ],
        summary_text:
          'The user had a collaboration-heavy hour from 14:00 to 15:00, participating in a team meeting and engaging in asynchronous communication. Activity included code reviews on GitHub and team coordination via Slack.',
        notable_events: [
          'Video meeting: Feature planning discussion with engineering team.',
          'Reviewed 3 pull requests and provided detailed feedback.',
          'Coordinated sprint priorities with project manager.',
        ],
      },
    },
    confidenceScore: 0.95,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000005',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-13T16:00:00Z'),
    periodEnd: new Date('2026-01-13T17:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['memory', 'events', 'people', 'locations'],
    title: 'Travel Coordination',
    content: {
      tokens_used: 142,
      key_insights: [
        'Ana, Marco, and Dev are the Miami contacts you have seen on every previous trip',
        'Your hotel confirmation and two open afternoons are already linked to this trip',
        'Past Miami trips kept about two hours of travel buffer either side; none is blocked this time',
      ],
      summary_text:
        'I noticed a flight to Miami in two weeks on your calendar. Your Miami people are Ana, Marco, and Dev. Here is what your own records already say about the trip — the confirmations, who you usually see, and the gaps in the schedule.',
      activity_counts: {
        total: 8,
      },
      structured_data: {
        tags: ['Travel', 'Friends', 'Planner'],
      },
    },
    confidenceScore: 0.92,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000003',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-13T00:00:00Z'),
    periodEnd: new Date('2026-01-14T00:00:00Z'),
    periodType: 'daily',
    timezone: 'UTC',
    sourceTypes: ['browser_activity', 'files', 'communications'],
    title: 'Daily Summary',
    content: {
      tokens_used: 650,
      summary_text:
        'Productive day focused on backend development with balanced collaboration. Morning hours were highly productive with deep focus on implementing new GraphQL features. Afternoon included team meetings and code reviews. Evening showed lighter activity with documentation reading and planning for upcoming work.',
      activity_counts: {
        files: 24,
        total: 127,
        events: 0,
        api_logs: 3,
        messages: 0,
        positions: 0,
        activities: 0,
        measurements: 0,
        communications: 18,
        screen_captures: 0,
        browser_activity: 82,
      },
      structured_data: {
        tags: ['backend_development', 'graphql', 'team_collaboration', 'code_review', 'productive_day'],
        daily_rhythm: [
          'Morning: Peak productivity hours (08:00-12:00) focused on coding.',
          'Afternoon: Collaboration and meetings (13:00-17:00).',
          'Evening: Light activity with planning and documentation (18:00-20:00).',
        ],
        productivity_patterns: [
          'Highest focus during morning hours with minimal interruptions.',
          'Afternoon productivity balanced between meetings and code reviews.',
          'Clear separation between deep work and collaborative activities.',
          'Effective context switching between coding and communication tasks.',
        ],
        social_interactions: [
          'Team standup meeting at 09:30.',
          'Feature planning discussion with engineering team at 14:00.',
          'Multiple Slack conversations about project timelines and priorities.',
          'Code review collaboration with 3 team members on GitHub.',
        ],
        key_accomplishments: [
          'Implemented new Summary domain for backend API.',
          'Created SummaryEntity, SummaryService, and GraphQL types.',
          'Reviewed and approved 5 pull requests.',
          'Coordinated sprint planning with project manager.',
          'Updated technical documentation for new features.',
        ],
        notable_events: [
          'Completed major milestone: Summary feature backend implementation.',
          'Team decision to prioritize frontend integration for upcoming sprint.',
          'Identified and documented technical debt items for future cleanup.',
        ],
        mood_indicators: [
          'High engagement during coding sessions.',
          'Positive collaboration tone in team communications.',
          'Proactive in identifying improvement opportunities.',
        ],
      },
    },
    confidenceScore: 0.98,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000006',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-14T09:00:00Z'),
    periodEnd: new Date('2026-01-14T10:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['memory', 'conversations', 'browsing', 'documents'],
    title: 'Dive Deeper on Interests',
    content: {
      tokens_used: 168,
      key_insights: [
        'Your saved articles and YouTube history this month cluster on product ML, experimentation, and growth analytics',
        'Your Drive activity for the last two weeks keeps returning to the same three work documents',
      ],
      summary_text:
        'Here is what your recent browsing and reading records show. Your YouTube history and saved articles lean toward machine learning for product analytics — open any of them to see what this is drawn from.',
      activity_counts: {
        total: 15,
      },
      structured_data: {
        tags: ['Productivity', 'Assistant', 'Summaries'],
      },
    },
    confidenceScore: 0.96,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000007',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-14T12:00:00Z'),
    periodEnd: new Date('2026-01-14T13:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['memory', 'interests', 'chats', 'local_events'],
    title: "Kids' Hobbies",
    content: {
      tokens_used: 155,
      key_insights: [
        'Cooking is the activity your family chats mention most this month — nine mentions across three weeks',
        'Your saved recipes and recent photos lean heavily toward dishes the kids helped make',
        'Last summer, camp confirmations for cooking, art, and soccer landed in your files in February — that is next month',
      ],
      summary_text:
        'From recent chats, your kids have been enjoying cooking activities. Here is what your own records show about that interest, and what happened around this time last year:',
      activity_counts: {
        total: 6,
      },
      structured_data: {
        tags: ['Family', 'Activities', 'Planner'],
      },
    },
    confidenceScore: 0.94,
  },
  {
    summaryId: '01936cb0-0000-7000-8000-000000000008',
    userId: JOHN_SMITH.id,
    periodStart: new Date('2026-01-14T15:00:00Z'),
    periodEnd: new Date('2026-01-14T16:00:00Z'),
    periodType: 'hourly',
    timezone: 'UTC',
    sourceTypes: ['vehicles', 'home', 'schedules'],
    title: 'Home & Car Upkeep',
    content: {
      tokens_used: 148,
      key_insights: [
        'Oil change due soon for your Honda Accord — about 4,900 miles since the service receipt in your files',
        'Gutter cleaning is past due: the last invoice is 14 months old, and your note on it says to do it before the rain',
        'HVAC filter is 3 months past the change date on its receipt — the size you bought last time is on that receipt',
      ],
      summary_text:
        'Quick maintenance wins to keep things running smoothly at home and on the road, each traced back to the record it came from:',
      activity_counts: {
        total: 5,
      },
      structured_data: {
        tags: ['Maintenance', 'Home', 'Vehicle'],
      },
    },
    confidenceScore: 0.93,
  },
];
