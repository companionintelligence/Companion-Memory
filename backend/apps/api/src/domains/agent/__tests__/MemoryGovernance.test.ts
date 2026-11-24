import { type Repository } from 'typeorm';

import { type EventService } from '@ci/domains/events';
import { type PersonService, type UserContextService } from '@ci/domains/memory';
import { reciprocalRankFusion } from '@ci/domains/search-next';

import { type AgentMemoryEntity } from '../entities/AgentMemoryEntity';
import {
  AgentMemoryService,
  detectSupersessionOrConflict,
  extractReferencedPaths,
  inferMemoryCategory,
} from '../services/AgentMemoryService';
import { MemoryCompactionService } from '../services/MemoryCompactionService';
import { applyRecencyDecay } from '../services/RecallService';

describe('Memory Governance (knowl pattern) & Reciprocal Rank Fusion', () => {
  describe('inferMemoryCategory', () => {
    it('classifies fragments into governed atom categories', () => {
      expect(inferMemoryCategory('User must not share production credentials')).toBe('constraint');
      expect(inferMemoryCategory('We decided to adopt PostgreSQL 18 with pgvector')).toBe('decision');
      expect(inferMemoryCategory('Goal: ship the federated ask protocol by Friday')).toBe('goal');
      expect(inferMemoryCategory('User prefers dark mode and Neovim keybindings')).toBe('preference');
      expect(inferMemoryCategory('Architecture: NestJS microservice with TimescaleDB')).toBe('architecture');
      expect(inferMemoryCategory('User is currently debugging the OAuth flow')).toBe('state');
      expect(inferMemoryCategory('Observed that latency spikes during batch imports')).toBe('observation');
      expect(inferMemoryCategory('Sister Anita is an architect in London')).toBe('fact');
    });

    it('honors an explicit valid category', () => {
      expect(inferMemoryCategory('Some text', 'goal')).toBe('goal');
    });
  });

  describe('detectSupersessionOrConflict', () => {
    it('detects slot-based supersession when location or employer changes', () => {
      const relation = detectSupersessionOrConflict(
        { content: 'User lives in Austin', category: 'fact' },
        { content: 'User now lives in Seattle', category: 'fact' },
      );
      expect(relation).toBe('supersede');
    });

    it('detects temporal progression supersession on overlapping topic', () => {
      const relation = detectSupersessionOrConflict(
        { content: 'Primary database cluster uses Postgres 15', category: 'architecture' },
        { content: 'Primary database cluster switched to Postgres 18', category: 'architecture' },
      );
      expect(relation).toBe('supersede');
    });

    it('detects direct conflict when one atom negates another without temporal progression', () => {
      const relation = detectSupersessionOrConflict(
        { content: 'Always format TypeScript files with semicolons', category: 'constraint' },
        { content: 'Never format TypeScript files with semicolons', category: 'constraint' },
      );
      expect(relation).toBe('conflict');
    });

    it('returns none for unrelated facts', () => {
      const relation = detectSupersessionOrConflict(
        { content: 'User lives in Austin', category: 'fact' },
        { content: 'User enjoys playing classical guitar', category: 'preference' },
      );
      expect(relation).toBe('none');
    });
  });

  describe('AgentMemoryService governed write, supersession, conflicts, and time-travel', () => {
    function makeService(governanceEnabled = true) {
      const rows: AgentMemoryEntity[] = [];
      const repo = {
        create: jest.fn((data: Partial<AgentMemoryEntity>) => ({
          ...data,
          createdAt: data.validFrom ?? new Date(),
          updatedAt: new Date(),
          processedAt: null,
        })),
        save: jest.fn(async (entity: AgentMemoryEntity) => {
          rows.push(entity);

          return entity;
        }),
        find: jest.fn(async (opts?: { where?: Record<string, unknown> }) => {
          const where = opts?.where ?? {};

          return rows.filter((r) => {
            if (where.userId && r.userId !== where.userId) {
              return false;
            }

            if (where.status && r.status !== where.status) {
              return false;
            }

            if (where.category && r.category !== where.category) {
              return false;
            }

            return true;
          });
        }),
        update: jest.fn(
          async (
            criteria: { id?: { _value?: string[] }; userId?: string },
            partial: Partial<AgentMemoryEntity>,
          ) => {
            const ids: string[] = criteria.id?._value ?? [];
            for (const r of rows) {
              if (ids.includes(r.id) && (!criteria.userId || r.userId === criteria.userId)) {
                Object.assign(r, partial);
              }
            }
          },
        ),
      } as unknown as Repository<AgentMemoryEntity>;

      const eventService = {
        send: jest.fn(async () => undefined),
      } as unknown as EventService;

      const logger = {
        setContext: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      } as never;

      const userContextService = {
        getSelfIdentity: jest.fn(async () => ({ entityId: 'self-1' })),
      } as unknown as UserContextService;

      const personService = {
        findById: jest.fn(async () => ({
          properties: {
            planner: { memory_governance_enabled: governanceEnabled },
          },
        })),
      } as unknown as PersonService;

      const service = new AgentMemoryService(repo, eventService, logger, personService, userContextService);

      return { service, rows, repo, eventService };
    }

    it('supersedes outdated slot facts automatically and reaps their stale search embeddings', async () => {
      const { service, rows, eventService } = makeService(true);
      const ctx = { userId: 'user-1' };

      const t1 = new Date('2026-01-10T00:00:00Z');
      const t2 = new Date('2026-06-15T00:00:00Z');

      const first = await service.create(ctx, {
        id: 'mem-1',
        content: 'User lives in Austin',
        validFrom: t1,
      });
      expect(first.status).toBe('active');

      const second = await service.create(ctx, {
        id: 'mem-2',
        content: 'User now lives in Seattle',
        validFrom: t2,
      });
      expect(second.status).toBe('active');

      // mem-1 was automatically marked superseded by mem-2
      const mem1Row = rows.find((r) => r.id === 'mem-1')!;
      expect(mem1Row.status).toBe('superseded');
      expect(mem1Row.supersededById).toBe('mem-2');
      expect(mem1Row.validUntil).toBeInstanceOf(Date);

      // Active memories now return only mem-2
      const activeNow = await service.findActive(ctx);
      expect(activeNow.map((m) => m.id)).toEqual(['mem-2']);

      // Point-in-time query asOf Feb 2026 returns mem-1!
      const activeInFeb = await service.findActive(ctx, {
        asOf: new Date('2026-02-01T00:00:00Z'),
      });
      expect(activeInFeb.map((m) => m.id)).toEqual(['mem-1']);

      // Stale embedding removal event was emitted for mem-1
      expect(eventService.send).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ memoryId: 'mem-1', userId: 'user-1' }),
        { queue: 'search-index' },
      );
    });

    it('flags conflicting memories with status = conflicted', async () => {
      const { service } = makeService(true);
      const ctx = { userId: 'user-1' };

      await service.create(ctx, {
        id: 'mem-a',
        content: 'Always format TypeScript files with semicolons',
      });
      await service.create(ctx, {
        id: 'mem-b',
        content: 'Never format TypeScript files with semicolons',
      });

      const conflicts = await service.findConflicts(ctx);
      expect(conflicts.map((c) => c.id)).toEqual(['mem-a']);
    });

    it('skips automatic supersession when memoryGovernanceEnabled is toggled off in Settings', async () => {
      const { service, rows } = makeService(false);
      const ctx = { userId: 'user-1' };

      await service.create(ctx, { id: 'mem-1', content: 'User lives in Austin' });
      await service.create(ctx, { id: 'mem-2', content: 'User now lives in Seattle' });

      expect(rows.find((r) => r.id === 'mem-1')?.status).toBe('active');
    });
  });

  describe('applyRecencyDecay & reciprocalRankFusion', () => {
    it('applyRecencyDecay halves score at halfLifeDays and respects minMultiplier floor', () => {
      const now = new Date('2026-10-20T00:00:00Z');
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      const tenYearsAgo = new Date(now.getTime() - 3650 * 24 * 60 * 60 * 1000);

      expect(applyRecencyDecay(1.0, now, { now, halfLifeDays: 90 })).toBeCloseTo(1.0, 5);
      expect(applyRecencyDecay(1.0, ninetyDaysAgo, { now, halfLifeDays: 90 })).toBeCloseTo(0.5, 2);
      expect(applyRecencyDecay(1.0, tenYearsAgo, { now, halfLifeDays: 90, minMultiplier: 0.25 })).toBe(0.25);
    });

    it('reciprocalRankFusion combines ranked lists without sensitivity to raw score scale', () => {
      const semantic = [
        { id: 'doc-1', type: 'note' as const },
        { id: 'doc-2', type: 'note' as const },
      ];
      const keyword = [
        { id: 'doc-2', type: 'note' as const },
        { id: 'doc-3', type: 'note' as const },
      ];

      const fused = reciprocalRankFusion([semantic, keyword], 60);
      // doc-2 appears in both lists (rank 2 in semantic, rank 1 in keyword) -> highest RRF score
      expect(fused[0].id).toBe('doc-2');
      expect(fused.map((d) => d.id)).toEqual(['doc-2', 'doc-1', 'doc-3']);
    });
  });

  describe('Evidence binding & staleness drift detection (knowl pattern)', () => {
    it('extractReferencedPaths extracts inline file paths, backticked filenames, and path-like sources', () => {
      const refs = extractReferencedPaths(
        'Architecture rule: `src/domains/asks/policy.ts` and backend/apps/api/src/domains/agent/RecallService.ts must remain pure; see package.json.',
        'docs/asks-system-guide.md',
      );
      expect(refs).toEqual(
        expect.arrayContaining([
          'docs/asks-system-guide.md',
          'src/domains/asks/policy.ts',
          'backend/apps/api/src/domains/agent/RecallService.ts',
          'package.json',
        ]),
      );
    });

    it('detectDrift identifies active governed memories referencing modified files and optionally marks them conflicted', async () => {
      const rows: AgentMemoryEntity[] = [];
      const repo = {
        create: jest.fn((data: Partial<AgentMemoryEntity>) => ({
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          processedAt: null,
        })),
        save: jest.fn(async (entity: AgentMemoryEntity) => {
          rows.push(entity);

          return entity;
        }),
        find: jest.fn(async () => rows),
        update: jest.fn(
          async (
            criteria: { id?: { _value?: string[] }; userId?: string },
            partial: Partial<AgentMemoryEntity>,
          ) => {
            const ids: string[] = criteria.id?._value ?? [];
            for (const r of rows) {
              if (ids.includes(r.id)) {
                Object.assign(r, partial);
              }
            }
          },
        ),
      } as unknown as Repository<AgentMemoryEntity>;

      const eventService = { send: jest.fn(async () => undefined) } as unknown as EventService;
      const logger = {
        setContext: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      } as never;

      const service = new AgentMemoryService(repo, eventService, logger);
      const ctx = { userId: 'user-1' };

      await service.create(ctx, {
        id: 'mem-arch',
        content:
          'Architecture invariant: backend/apps/api/src/domains/asks/policy.ts enforces disclosure rungs',
        category: 'architecture',
      });
      await service.create(ctx, {
        id: 'mem-pref',
        content: 'User prefers dark mode in the web app',
        category: 'preference',
      });

      const report = await service.detectDrift(
        ctx,
        ['backend/apps/api/src/domains/asks/policy.ts', 'README.md'],
        { markConflicted: true },
      );

      expect(report.checkedCount).toBe(2);
      expect(report.driftedCount).toBe(1);
      expect(report.matches[0].memory.id).toBe('mem-arch');
      expect(report.matches[0].memory.status).toBe('conflicted');
      expect(report.matches[0].matchedPaths).toEqual(['backend/apps/api/src/domains/asks/policy.ts']);
      expect(rows.find((r) => r.id === 'mem-arch')?.status).toBe('conflicted');
    });
  });

  describe('MemoryCompactionService non-person deduplication (Place & Item)', () => {
    it('reuses existing Place and Item entities by case-insensitive name and deduplicates within a compaction run', async () => {
      const ollamaService = {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: JSON.stringify({
              entities: [
                { type: 'place', name: 'Blue Bottle Coffee', description: 'cafe' },
                { type: 'place', name: 'blue bottle coffee', description: 'duplicate mention in batch' },
                { type: 'item', name: 'MacBook Pro M4', description: 'laptop' },
                { type: 'item', name: 'macbook pro m4', description: 'duplicate item in batch' },
              ],
              relationships: [],
            }),
          },
        }),
      } as never;

      const placeService = {
        findAll: jest.fn(async () => [{ id: 'place-existing-1', name: 'Blue Bottle Coffee' }]),
        create: jest.fn(async () => [{ id: 'place-new' }]),
      } as never;

      const itemService = {
        findAll: jest.fn(async () => []),
        create: jest.fn(async () => ({ id: 'item-created-1', name: 'MacBook Pro M4' })),
      } as never;

      const compaction = new MemoryCompactionService(
        ollamaService,
        { markProcessed: jest.fn() } as never,
        { search: jest.fn(async () => []), findAll: jest.fn(async () => []), create: jest.fn() } as never,
        { search: jest.fn(async () => []), create: jest.fn() } as never,
        { getSelfIdentity: jest.fn(async () => null) } as never,
        placeService,
        itemService,
        { resolveType: jest.fn(() => null), upsert: jest.fn() } as never,
        {
          setContext: jest.fn(),
          log: jest.fn(),
          warn: jest.fn(),
          debug: jest.fn(),
          error: jest.fn(),
        } as never,
      );

      await compaction.compactForUser({ userId: 'user-1' }, [
        {
          id: 'frag-1',
          userId: 'user-1',
          sessionId: null,
          source: 'memory',
          title: null,
          content: 'Worked on MacBook Pro M4 at Blue Bottle Coffee',
          category: 'fact',
          status: 'active',
          supersededById: null,
          validFrom: new Date(),
          validUntil: null,
          processedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      // Place matched existing row -> create was never called
      expect((placeService as { create: jest.Mock }).create).not.toHaveBeenCalled();
      // Item was created once and deduplicated on second mention in batch
      expect((itemService as { create: jest.Mock }).create).toHaveBeenCalledTimes(1);
    });
  });
});
