import path from 'node:path';

import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { ActionEntity } from '@ci/domains/intelligence';
import { PlacementService } from '@ci/domains/personalization';
import { EventCandidateEntity, CandidateService, SuggestionSyncService } from '@ci/domains/schedule';
import { SummaryEntity } from '@ci/domains/summaries';

// =====================================================================
// schedule-suggestions-sync — populate the schedule slate from the CLI
// =====================================================================
// Projects ci.actions + insight key_actions into ci.event_candidates for one
// user, exactly as the syncScheduleSuggestions mutation does. Useful for
// seeding a demo account and for checking the projection without a browser
// session.
//
//   yarn workspace @ci/be-api exec scripts/schedule-suggestions-sync.ts <user-id>
//   yarn workspace @ci/be-api exec scripts/schedule-suggestions-sync.ts <user-id> --dry-run
//
// --dry-run reports what would be written without touching the table.

async function main(): Promise<void> {
  const [, , userId, ...flags] = process.argv;
  const dryRun = flags.includes('--dry-run');

  if (!userId) {
    console.error('usage: schedule-suggestions-sync.ts <user-id> [--dry-run]');
    process.exit(1);
  }

  const db = new DataSource({
    type: config.db.type,
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    username: config.db.username,
    password: config.db.password,
    // The whole graph, not just the three we touch: ActionEntity has relations
    // to Thread and User, and TypeORM needs their metadata to build its own.
    entities: [path.join(__dirname, '../src/domains/**/*Entity.{ts,js}')],
    synchronize: false,
    logging: ['error'],
  });

  await db.initialize();

  try {
    const logger = new LoggerService();
    const candidateRepo = db.getRepository(EventCandidateEntity);

    // The services only need repositories, a DataSource and a logger at runtime;
    // Nest's @InjectRepository decorators are inert outside the container, so we
    // construct them directly (same approach as search-index-cleanup).
    const candidateService = new CandidateService(
      candidateRepo,
      // EventService is only reached on accept(), which sync never calls.
      null as never,
      db,
      logger,
    );

    const sync = new SuggestionSyncService(
      db.getRepository(ActionEntity),
      db.getRepository(SummaryEntity),
      candidateRepo,
      dryRun
        ? ({
            upsert: async (_ctx: unknown, proposals: unknown[]) => {
              console.log(`would write ${proposals.length} candidate(s):`);
              for (const proposal of proposals as { title: string; dedupe_key: string }[]) {
                console.log(`  · [${proposal.dedupe_key}] ${proposal.title}`);
              }

              return [];
            },
          } as unknown as CandidateService)
        : candidateService,
      { getProfile: async () => ({ autoSchedule: false }) } as never,
      new PlacementService(db, null as never),
      logger,
    );

    const written = await sync.sync({ userId });

    if (!dryRun) {
      const open = await candidateRepo.count({ where: { userId, status: 'open' } });
      console.log(`wrote ${written} candidate(s); ${open} now open for this user`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
