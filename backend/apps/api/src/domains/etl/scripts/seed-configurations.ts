#!/usr/bin/env ts-node
/**
 * ETL Configuration Seeder
 * 
 * This script loads provider configurations, API specifications, and transform maps
 * from JSON files into the database.
 * 
 * Usage:
 *   yarn seed:etl-config
 *   yarn seed:etl-config --provider=google
 *   yarn seed:etl-config --dry-run
 */

import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { ProviderConfigEntity } from '../entities/ProviderConfigEntity';
import { ApiSpecEntity } from '../entities/ApiSpecEntity';
import { TransformMapEntity } from '../entities/TransformMapEntity';

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const specificProvider = args.find(arg => arg.startsWith('--provider='))?.split('=')[1];

const CONFIG_BASE_PATH = path.join(__dirname, '../../../../config');
const PROVIDERS_PATH = path.join(CONFIG_BASE_PATH, 'providers');
const API_SPECS_PATH = path.join(CONFIG_BASE_PATH, 'api-specs');
const TRANSFORM_MAPS_PATH = path.join(CONFIG_BASE_PATH, 'transform-maps');

interface SeedStats {
  providers: { inserted: number; updated: number; skipped: number };
  apiSpecs: { inserted: number; updated: number; skipped: number };
  transformMaps: { inserted: number; updated: number; skipped: number };
  errors: string[];
}

async function loadJsonFile(filePath: string): Promise<any> {
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content);
}

async function seedProviders(dataSource: DataSource, stats: SeedStats): Promise<void> {
  const providerRepo = dataSource.getRepository(ProviderConfigEntity);
  const files = fs.readdirSync(PROVIDERS_PATH).filter(f => f.endsWith('.provider.json'));

  console.log(`\n📦 Seeding ${files.length} provider configurations...`);

  for (const file of files) {
    const providerId = file.replace('.provider.json', '');
    
    // Skip if specific provider requested and this isn't it
    if (specificProvider && providerId !== specificProvider) {
      continue;
    }

    try {
      const config = await loadJsonFile(path.join(PROVIDERS_PATH, file));
      
      if (dryRun) {
        console.log(`  [DRY RUN] Would seed provider: ${config.name} (${providerId})`);
        stats.providers.skipped++;
        continue;
      }

      // Check if provider already exists
      const existing = await providerRepo.findOne({ where: { id: providerId } });

      if (existing) {
        // Update existing
        await providerRepo.update(providerId, {
          name: config.name,
          displayName: config.displayName,
          description: config.description,
          category: config.category,
          authType: config.authType,
          oauth: config.oauth,
          sources: config.sources,
          theme: config.theme,
          enabled: config.enabled ?? true,
          apiSpecId: config.apiSpecId,
        });
        console.log(`  ✅ Updated provider: ${config.name} (${providerId})`);
        stats.providers.updated++;
      } else {
        // Insert new
        await providerRepo.insert({
          id: providerId,
          name: config.name,
          displayName: config.displayName,
          description: config.description,
          category: config.category,
          authType: config.authType,
          oauth: config.oauth,
          sources: config.sources,
          theme: config.theme,
          enabled: config.enabled ?? true,
          apiSpecId: config.apiSpecId,
        });
        console.log(`  ✅ Inserted provider: ${config.name} (${providerId})`);
        stats.providers.inserted++;
      }
    } catch (error) {
      const errMsg = `Failed to seed provider ${providerId}: ${error.message}`;
      console.error(`  ❌ ${errMsg}`);
      stats.errors.push(errMsg);
    }
  }
}

async function seedApiSpecs(dataSource: DataSource, stats: SeedStats): Promise<void> {
  const apiSpecRepo = dataSource.getRepository(ApiSpecEntity);
  const files = fs.readdirSync(API_SPECS_PATH).filter(f => f.endsWith('.spec.json'));

  console.log(`\n🔌 Seeding ${files.length} API specifications...`);

  for (const file of files) {
    const specId = file.replace('.spec.json', '');
    
    try {
      const spec = await loadJsonFile(path.join(API_SPECS_PATH, file));
      
      if (dryRun) {
        console.log(`  [DRY RUN] Would seed API spec: ${spec.name} (${specId})`);
        stats.apiSpecs.skipped++;
        continue;
      }

      // Check if spec already exists
      const existing = await apiSpecRepo.findOne({ where: { id: specId } });

      if (existing) {
        // Update existing
        await apiSpecRepo.update(specId, {
          name: spec.name,
          version: spec.version,
          baseUrl: spec.baseUrl,
          authType: spec.authType,
          endpoints: spec.endpoints,
          globalPagination: spec.globalPagination,
          globalRateLimit: spec.globalRateLimit,
          metadata: spec.metadata,
        });
        console.log(`  ✅ Updated API spec: ${spec.name} (${specId})`);
        stats.apiSpecs.updated++;
      } else {
        // Insert new
        await apiSpecRepo.insert({
          id: specId,
          name: spec.name,
          version: spec.version,
          baseUrl: spec.baseUrl,
          authType: spec.authType,
          endpoints: spec.endpoints,
          globalPagination: spec.globalPagination,
          globalRateLimit: spec.globalRateLimit,
          metadata: spec.metadata,
        });
        console.log(`  ✅ Inserted API spec: ${spec.name} (${specId})`);
        stats.apiSpecs.inserted++;
      }
    } catch (error) {
      const errMsg = `Failed to seed API spec ${specId}: ${error.message}`;
      console.error(`  ❌ ${errMsg}`);
      stats.errors.push(errMsg);
    }
  }
}

async function seedTransformMaps(dataSource: DataSource, stats: SeedStats): Promise<void> {
  const transformMapRepo = dataSource.getRepository(TransformMapEntity);
  const files = fs.readdirSync(TRANSFORM_MAPS_PATH).filter(f => f.endsWith('.transform.json'));

  console.log(`\n🔄 Seeding ${files.length} transform maps...`);

  for (const file of files) {
    const mapId = file.replace('.transform.json', '');
    
    try {
      const map = await loadJsonFile(path.join(TRANSFORM_MAPS_PATH, file));
      
      if (dryRun) {
        console.log(`  [DRY RUN] Would seed transform map: ${map.name} (${mapId})`);
        stats.transformMaps.skipped++;
        continue;
      }

      // Check if map already exists
      const existing = await transformMapRepo.findOne({ where: { id: mapId } });

      if (existing) {
        // Update existing
        await transformMapRepo.update(mapId, {
          name: map.name,
          sourceType: map.sourceType,
          targetType: map.targetType,
          version: map.version,
          fieldMappings: map.fieldMappings,
          metadata: map.metadata,
        });
        console.log(`  ✅ Updated transform map: ${map.name} (${mapId})`);
        stats.transformMaps.updated++;
      } else {
        // Insert new
        await transformMapRepo.insert({
          id: mapId,
          name: map.name,
          sourceType: map.sourceType,
          targetType: map.targetType,
          version: map.version,
          fieldMappings: map.fieldMappings,
          metadata: map.metadata,
        });
        console.log(`  ✅ Inserted transform map: ${map.name} (${mapId})`);
        stats.transformMaps.inserted++;
      }
    } catch (error) {
      const errMsg = `Failed to seed transform map ${mapId}: ${error.message}`;
      console.error(`  ❌ ${errMsg}`);
      stats.errors.push(errMsg);
    }
  }
}

async function main() {
  console.log('🌱 ETL Configuration Seeder');
  console.log('========================\n');

  if (dryRun) {
    console.log('⚠️  DRY RUN MODE - No changes will be made\n');
  }

  if (specificProvider) {
    console.log(`📌 Seeding only provider: ${specificProvider}\n`);
  }

  const stats: SeedStats = {
    providers: { inserted: 0, updated: 0, skipped: 0 },
    apiSpecs: { inserted: 0, updated: 0, skipped: 0 },
    transformMaps: { inserted: 0, updated: 0, skipped: 0 },
    errors: [],
  };

  let dataSource: DataSource | null = null;

  try {
    // Create database connection
    console.log('🔌 Connecting to database...');
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432'),
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DB || 'ci_server',
      schema: 'ci',
      entities: [ProviderConfigEntity, ApiSpecEntity, TransformMapEntity],
      synchronize: false,
    });
    
    await dataSource.initialize();
    console.log('✅ Connected to database\n');

    // Seed configurations
    await seedProviders(dataSource, stats);
    await seedApiSpecs(dataSource, stats);
    await seedTransformMaps(dataSource, stats);

    // Print summary
    console.log('\n📊 Summary');
    console.log('=========\n');
    console.log(`Providers:`);
    console.log(`  - Inserted: ${stats.providers.inserted}`);
    console.log(`  - Updated: ${stats.providers.updated}`);
    console.log(`  - Skipped: ${stats.providers.skipped}`);
    console.log(`\nAPI Specs:`);
    console.log(`  - Inserted: ${stats.apiSpecs.inserted}`);
    console.log(`  - Updated: ${stats.apiSpecs.updated}`);
    console.log(`  - Skipped: ${stats.apiSpecs.skipped}`);
    console.log(`\nTransform Maps:`);
    console.log(`  - Inserted: ${stats.transformMaps.inserted}`);
    console.log(`  - Updated: ${stats.transformMaps.updated}`);
    console.log(`  - Skipped: ${stats.transformMaps.skipped}`);

    if (stats.errors.length > 0) {
      console.log(`\n⚠️  Errors: ${stats.errors.length}`);
      stats.errors.forEach(err => console.log(`  - ${err}`));
    }

    console.log('\n✅ Seeding complete!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  } finally {
    if (dataSource && dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { main as seedConfigurations };
