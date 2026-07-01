/**
 * The curated CI Intent catalog.
 *
 * Each entry is a typed semantic action bound to a capability that ALREADY exists
 * as a native tool — proving the core thesis: the catalog is a thin, curated,
 * privacy-labelled facade, not a re-implementation. Several search intents
 * specialise one `databaseSearch` tool via `fixedArgs`, so one search capability
 * backs many distinct, discoverable intents.
 *
 * To add an intent: give it a dotted `name` in an existing {@link IntentDomainKey},
 * a curated parameter subset, a privacy label, the entity types it touches, NL
 * `phrases`, and a `binding` to an existing tool. It then flows automatically to
 * the LLM tool list, the MCP server, and the published manifest.
 */

import type { IntentDefinition } from '../types';

/** A read over a personal corpus that never leaves the appliance. */
const PERSONAL_READ = {
  access: 'read' as const,
  sensitivity: 'personal' as const,
  destructive: false,
  external: false,
};

export const INTENTS: readonly IntentDefinition[] = [
  // ─── memory ────────────────────────────────────────────────────────────────
  {
    name: 'memory.recall',
    domain: 'memory',
    title: 'Recall knowledge',
    description: 'Recall stored facts about the user (or a named person) from the personal knowledge graph.',
    privacy: PERSONAL_READ,
    produces: ['concept', 'person'],
    phrases: ['What do you know about $person', 'Recall my $topic'],
    parameters: {
      type: 'object',
      properties: {
        personName: {
          type: 'string',
          description: 'Recall knowledge about this named person (defaults to the current user).',
        },
        useCurrentUser: {
          type: 'boolean',
          description: 'Recall about the current user when no person is named (default true).',
        },
      },
      required: [],
    },
    binding: { kind: 'native-tool', tool: 'readKnowledge' },
  },
  {
    name: 'memory.remember',
    domain: 'memory',
    title: 'Remember a fact',
    description:
      'Durably record entities and relationships in the personal knowledge graph. Use dryRun to validate first.',
    privacy: { access: 'write', sensitivity: 'personal', destructive: false, external: false },
    produces: ['concept', 'person'],
    phrases: ['Remember that $fact', 'Note that $fact'],
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description: 'Knowledge-graph mutations (entity/relationship create or update).',
          items: { type: 'object' },
        },
        dryRun: {
          type: 'boolean',
          description: 'Validate and report the operations without writing.',
        },
      },
      required: ['operations'],
    },
    binding: { kind: 'native-tool', tool: 'writeKnowledge' },
  },
  {
    name: 'memory.forget',
    domain: 'memory',
    title: 'Forget knowledge',
    description: 'Archive (default) or delete entities/relationships from the knowledge graph.',
    privacy: { access: 'delete', sensitivity: 'personal', destructive: true, external: false },
    consumes: ['concept', 'person'],
    phrases: ['Forget $fact', 'Delete what you know about $topic'],
    parameters: {
      type: 'object',
      properties: {
        entityIds: { type: 'array', items: { type: 'string' }, description: 'Entity ids to forget.' },
        relationshipIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relationship ids to forget.',
        },
        mode: {
          type: 'string',
          enum: ['archive', 'archive_and_delete'],
          description: 'archive (reversible, default) or archive_and_delete (irreversible).',
        },
        reason: { type: 'string', description: 'Why this knowledge is being forgotten.' },
      },
      required: [],
    },
    binding: { kind: 'native-tool', tool: 'forgetKnowledge' },
  },

  // ─── knowledge ───────────────────────────────────────────────────────────────
  {
    name: 'knowledge.search',
    domain: 'knowledge',
    title: 'Search everything',
    description:
      'Search the entire personal corpus (events, content, people, places, files, notes, …) by meaning or keyword.',
    privacy: PERSONAL_READ,
    produces: ['event', 'content', 'person', 'place', 'note', 'file'],
    phrases: ['Search for $query', 'Find anything about $query'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query or keywords.' },
        searchMode: {
          type: 'string',
          enum: ['semantic', 'keyword', 'hybrid', 'auto'],
          description: 'Retrieval strategy (default auto).',
        },
        maxResults: { type: 'integer', description: 'Max results (default 25).', minimum: 1, maximum: 100 },
      },
      required: ['query'],
    },
    binding: { kind: 'native-tool', tool: 'databaseSearch' },
  },
  {
    name: 'knowledge.preferences',
    domain: 'knowledge',
    title: 'Get preferences',
    description: 'Get the user’s (or a named person’s) stored preferences — food, activity, music, and more.',
    privacy: PERSONAL_READ,
    produces: ['concept'],
    phrases: ['What are my preferences', 'What does $person like'],
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['food', 'entertainment', 'activity', 'beverage', 'music', 'all'],
          description: 'Preference category (default all).',
        },
        personName: { type: 'string', description: 'Whose preferences (defaults to current user).' },
      },
      required: [],
    },
    binding: { kind: 'native-tool', tool: 'getUserPreferences' },
  },

  // ─── people ──────────────────────────────────────────────────────────────────
  {
    name: 'people.find',
    domain: 'people',
    title: 'Find people',
    description: 'Find people in the social graph matching a name or description.',
    privacy: PERSONAL_READ,
    produces: ['person'],
    phrases: ['Find $name', 'Who is $name'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or description to match.' },
        maxResults: { type: 'integer', description: 'Max results (default 25).', minimum: 1, maximum: 100 },
      },
      required: ['query'],
    },
    binding: { kind: 'native-tool', tool: 'databaseSearch', fixedArgs: { entityTypes: ['person'] } },
  },
  {
    name: 'people.relationships',
    domain: 'people',
    title: 'List relationships',
    description:
      'List family, partners, and close social connections, optionally with each person’s preferences.',
    privacy: PERSONAL_READ,
    produces: ['person'],
    phrases: ['Who is my family', 'List my relationships'],
    parameters: {
      type: 'object',
      properties: {
        relationshipType: {
          type: 'string',
          enum: ['family', 'romantic_partner', 'all'],
          description: 'Relationship filter (default all).',
        },
        includePreferences: {
          type: 'boolean',
          description: 'Include each person’s likes/dislikes.',
        },
      },
      required: [],
    },
    binding: { kind: 'native-tool', tool: 'getFamilyMembers' },
  },

  // ─── places ──────────────────────────────────────────────────────────────────
  {
    name: 'places.find',
    domain: 'places',
    title: 'Find places',
    description: 'Find locations and places the user has visited, saved, or referenced.',
    privacy: PERSONAL_READ,
    produces: ['place'],
    phrases: ['Where is $place', 'Find places near $area'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Place name or description to match.' },
        maxResults: { type: 'integer', description: 'Max results (default 25).', minimum: 1, maximum: 100 },
      },
      required: ['query'],
    },
    binding: { kind: 'native-tool', tool: 'databaseSearch', fixedArgs: { entityTypes: ['place'] } },
  },

  // ─── calendar ────────────────────────────────────────────────────────────────
  {
    name: 'calendar.findEvents',
    domain: 'calendar',
    title: 'Find events',
    description: 'Find events on the personal timeline — meetings, trips, captures, purchases.',
    privacy: PERSONAL_READ,
    produces: ['event'],
    phrases: ['What happened on $date', 'Find my $event'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for on the timeline.' },
        maxResults: { type: 'integer', description: 'Max results (default 25).', minimum: 1, maximum: 100 },
      },
      required: ['query'],
    },
    binding: { kind: 'native-tool', tool: 'databaseSearch', fixedArgs: { entityTypes: ['event'] } },
  },

  // ─── media ───────────────────────────────────────────────────────────────────
  {
    name: 'media.findPhotos',
    domain: 'media',
    title: 'Find photos & videos',
    description: 'Find photos and videos by description, place, or time.',
    privacy: PERSONAL_READ,
    produces: ['file'],
    phrases: ['Show me photos of $subject', 'Find my videos from $place'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the photo/video is of, or where/when.' },
        maxResults: { type: 'integer', description: 'Max results (default 25).', minimum: 1, maximum: 100 },
      },
      required: ['query'],
    },
    binding: { kind: 'native-tool', tool: 'databaseSearch', fixedArgs: { entityTypes: ['file'] } },
  },
  {
    name: 'media.entertainmentPreferences',
    domain: 'media',
    title: 'Get entertainment taste',
    description: 'Get the user’s movie, TV, music, and book preferences.',
    privacy: PERSONAL_READ,
    produces: ['concept'],
    phrases: ['What movies do I like', 'My taste in $media'],
    parameters: {
      type: 'object',
      properties: {
        mediaType: {
          type: 'string',
          enum: ['movies', 'tv', 'music', 'books', 'all'],
          description: 'Media type (default all).',
        },
        personName: { type: 'string', description: 'Whose taste (defaults to current user).' },
      },
      required: [],
    },
    binding: { kind: 'native-tool', tool: 'getEntertainmentPreferences' },
  },
  {
    name: 'media.streamingAvailability',
    domain: 'media',
    title: 'Find where to stream',
    description: 'Resolve where titles are available to stream. Calls an external service.',
    privacy: { access: 'read', sensitivity: 'low', destructive: false, external: true },
    parameters: {
      type: 'object',
      properties: {
        genre: { type: 'string', description: 'Genre or title hint to resolve availability for.' },
      },
      required: [],
    },
    binding: { kind: 'native-tool', tool: 'getStreamingAvailability' },
  },
] as const;
