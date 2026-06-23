import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import type { GraphQueryService } from '../services/GraphQueryService';
import { UserContextService, type UserContext } from '../services/UserContextService';

// formatContextForSystemPrompt is a pure transform over its UserContext arg,
// so it can be unit tested without the DB-backed dependencies.
function makeService(): UserContextService {
  const logger = { setContext: () => undefined } as unknown as LoggerService;

  return new UserContextService(
    undefined as unknown as GraphQueryService,
    undefined as unknown as DataSource,
    logger,
  );
}

function baseContext(overrides: Partial<UserContext> = {}): UserContext {
  const currentUser = overrides.currentUser ?? {
    entityId: 'u1',
    name: 'Hanzla Mateen',
    username: 'Hanzla Mateen',
  };
  const familyMembers = overrides.familyMembers ?? [];
  const topPreferences = overrides.topPreferences ?? [];

  // Mirror getUserContextForLLM: derive the counts from topPreferences so the
  // fixture stays internally consistent (e.g. totalDislikes matches the number
  // of DISLIKES rows) unless a test overrides quickStats explicitly.
  const quickStats = overrides.quickStats ?? {
    totalEntities: topPreferences.length + familyMembers.length + 1,
    totalPreferences: topPreferences.filter((p) => p.relationship === 'PREFERS').length,
    totalDislikes: topPreferences.filter((p) => p.relationship === 'DISLIKES').length,
    familySize: familyMembers.length,
  };

  return { currentUser, familyMembers, topPreferences, quickStats };
}

describe('UserContextService.formatContextForSystemPrompt', () => {
  const service = makeService();

  it('renders the concept category (not the bare node type) for preferences', () => {
    const block = service.formatContextForSystemPrompt(
      baseContext({
        topPreferences: [
          {
            entityId: 'c1',
            name: 'Burgers',
            type: 'Concept',
            category: 'food',
            strength: 0.85,
            relationship: 'PREFERS',
          },
        ],
      }),
    );

    // The category is what lets the agent answer "what is my favorite food".
    expect(block).toContain('- Burgers (food) - strength: 0.85');
    expect(block).not.toContain('Burgers (Concept)');
  });

  it('falls back to the node type when a preference has no category', () => {
    const block = service.formatContextForSystemPrompt(
      baseContext({
        topPreferences: [
          {
            entityId: 'c2',
            name: 'Mystery',
            type: 'Concept',
            category: null,
            strength: 0.5,
            relationship: 'PREFERS',
          },
        ],
      }),
    );

    expect(block).toContain('- Mystery (Concept) - strength: 0.50');
  });

  it('renders the category for dislikes too', () => {
    const block = service.formatContextForSystemPrompt(
      baseContext({
        topPreferences: [
          {
            entityId: 'c3',
            name: 'Spiders',
            type: 'Concept',
            category: 'animal',
            strength: 0.9,
            relationship: 'DISLIKES',
          },
        ],
      }),
    );

    expect(block).toContain('## Dislikes');
    expect(block).toContain('- Spiders (animal) - strength: 0.90');
  });
});
