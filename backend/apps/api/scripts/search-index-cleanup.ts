import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { OrphanCleanupService } from '@ci/domains/search-ingress';
import { INDEXABLE_ENTITIES, type IndexableEntity } from '@ci/domains/search-next';

// =====================================================================
// search-index-cleanup — search/embedding hygiene CLI (#2)
// =====================================================================
// Keeps ci_search.embeddings / ci_search.vectors consistent with the ci.*
// rows they index. Two subcommands:
//
//   # delete index rows whose source row no longer exists (re-runnable,
//   # batched, safe online). --dry-run counts without deleting.
//   yarn workspace @ci/be-api exec scripts/search-index-cleanup.ts orphans
//   yarn workspace @ci/be-api exec scripts/search-index-cleanup.ts orphans --dry-run
//   yarn workspace @ci/be-api exec scripts/search-index-cleanup.ts orphans --types=event,communication --batch=2000
//
//   # RESET HYGIENE: a data reset that clears ci.* must ALSO wipe the search
//   # index or the whole index becomes orphaned. Run after / alongside a reset:
//   yarn workspace @ci/be-api exec scripts/search-index-cleanup.ts truncate --confirm
//
//   # convenience: `orphans --include-search` is the same as `truncate`, for
//   # operators who think of it as "reset, including search".
//   yarn workspace @ci/be-api exec scripts/search-index-cleanup.ts orphans --include-search --confirm
//
// This is a MAINTENANCE routine, never a migration, and never runs
// automatically. truncate is destructive and requires --confirm.

const DEFAULT_BATCH_SIZE = 5000;

interface ParsedArgs {
  command: string;
  dryRun: boolean;
  includeSearch: boolean;
  confirm: boolean;
  batchSize: number;
  entityTypes?: IndexableEntity[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? '';
  let dryRun = false;
  let includeSearch = false;
  let confirm = false;
  let batchSize = DEFAULT_BATCH_SIZE;
  let entityTypes: IndexableEntity[] | undefined;

  for (const arg of argv.slice(1)) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--include-search') {
      includeSearch = true;
    } else if (arg === '--confirm') {
      confirm = true;
    } else if (arg.startsWith('--batch=')) {
      batchSize = Number.parseInt(arg.slice('--batch='.length), 10);
      if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw new Error(`--batch must be a positive integer, got "${arg}"`);
      }
    } else if (arg.startsWith('--types=')) {
      const types = arg
        .slice('--types='.length)
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const invalid = types.filter((t) => !INDEXABLE_ENTITIES.includes(t as IndexableEntity));
      if (invalid.length > 0) {
        throw new Error(
          `Unknown entity type(s): ${invalid.join(', ')}. Valid: ${INDEXABLE_ENTITIES.join(', ')}`,
        );
      }

      entityTypes = types as IndexableEntity[];
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }

  return { command, dryRun, includeSearch, confirm, batchSize, entityTypes };
}

async function withDataSource<T>(fn: (db: DataSource) => Promise<T>): Promise<T> {
  const db = new DataSource({
    type: config.db.type,
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    username: config.db.username,
    password: config.db.password,
    entities: [],
    synchronize: false,
    logging: ['error'],
  });

  await db.initialize();
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

function makeService(db: DataSource): OrphanCleanupService {
  // OrphanCleanupService only needs the DataSource + a logger at runtime; the
  // @InjectDataSource decorator is a no-op outside Nest's DI container, so we
  // construct it directly here (same approach the bulk-load CLI takes).
  return new OrphanCleanupService(db, new LoggerService());
}

async function runOrphans(db: DataSource, args: ParsedArgs): Promise<void> {
  const service = makeService(db);

  const result = await service.cleanOrphans({
    batchSize: args.batchSize,
    entityTypes: args.entityTypes,
    dryRun: args.dryRun,
  });

  const verb = args.dryRun ? 'would delete' : 'deleted';
  for (const r of result.results) {
    if (r.deleted > 0) {
      console.log(`${verb}  ${r.deleted}\t${r.searchTable}\t${r.entityType}`);
    }
  }

  console.log(`\nTotal ${verb}: ${result.totalDeleted}${args.dryRun ? ' (dry run)' : ''}`);
}

async function runTruncate(db: DataSource, args: ParsedArgs): Promise<void> {
  if (!args.confirm) {
    throw new Error(
      'truncate is destructive (wipes the entire search index). Re-run with --confirm.',
    );
  }

  const service = makeService(db);
  const result = await service.truncateSearchIndex();
  console.log(`Truncated: ${result.truncated.join(', ')}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'orphans':
      // `orphans --include-search` is an operator-friendly alias for a full
      // reset-hygiene wipe of the index.
      if (args.includeSearch) {
        await withDataSource((db) => runTruncate(db, args));
      } else {
        await withDataSource((db) => runOrphans(db, args));
      }

      return;

    case 'truncate':
      await withDataSource((db) => runTruncate(db, args));

      return;

    default:
      console.error(
        'Usage: search-index-cleanup.ts <orphans|truncate> [--dry-run] [--types=a,b] [--batch=N] [--include-search] [--confirm]',
      );
      process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(`\nFailed: ${(err as Error).message}`);
    process.exit(1);
  });
