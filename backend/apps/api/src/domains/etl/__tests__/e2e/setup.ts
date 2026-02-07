/**
 * E2E Test Setup and Teardown
 * 
 * Handles test environment initialization, database setup, and cleanup
 */

import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { createMockLogger } from '@ci/test/mocks';

import { SyncEngine } from '../../services/SyncEngine';
import { ProviderRegistry } from '../../services/ProviderRegistry';
import { ApiClient } from '../../services/ApiClient';
import { TransformEngine } from '../../services/TransformEngine';
import { RateLimiter } from '../../services/RateLimiter';
import { ProviderConfigEntity } from '../../entities/ProviderConfigEntity';
import { ApiSpecEntity } from '../../entities/ApiSpecEntity';
import { TransformMapEntity } from '../../entities/TransformMapEntity';
import { ApiLogEntity } from '../../entities/ApiLogEntity';
import { MockApiModule } from '../../mock/mock-api.module';
import { TEST_CONFIG } from './test-config';

export interface TestContext {
  module: TestingModule;
  syncEngine: SyncEngine;
  providerRegistry: ProviderRegistry;
  apiClient: ApiClient;
  transformEngine: TransformEngine;
  rateLimiter: RateLimiter;
  dataSource: DataSource;
}

/**
 * Setup test module with all required dependencies
 */
export async function setupTestModule(): Promise<TestContext> {
  const module: TestingModule = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        ...TEST_CONFIG.database,
        type: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        username: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        entities: [
          ProviderConfigEntity,
          ApiSpecEntity,
          TransformMapEntity,
          ApiLogEntity,
        ],
        logging: false,
      }),
      TypeOrmModule.forFeature([
        ProviderConfigEntity,
        ApiSpecEntity,
        TransformMapEntity,
        ApiLogEntity,
      ]),
      MockApiModule,
    ],
    providers: [
      SyncEngine,
      ProviderRegistry,
      ApiClient,
      TransformEngine,
      RateLimiter,
      {
        provide: LoggerService,
        useValue: createMockLogger(),
      },
    ],
  }).compile();

  const syncEngine = module.get<SyncEngine>(SyncEngine);
  const providerRegistry = module.get<ProviderRegistry>(ProviderRegistry);
  const apiClient = module.get<ApiClient>(ApiClient);
  const transformEngine = module.get<TransformEngine>(TransformEngine);
  const rateLimiter = module.get<RateLimiter>(RateLimiter);
  const dataSource = module.get<DataSource>(DataSource);

  return {
    module,
    syncEngine,
    providerRegistry,
    apiClient,
    transformEngine,
    rateLimiter,
    dataSource,
  };
}

/**
 * Cleanup test module and close connections
 */
export async function teardownTestModule(context: TestContext): Promise<void> {
  if (context.dataSource?.isInitialized) {
    await context.dataSource.destroy();
  }
  
  if (context.module) {
    await context.module.close();
  }
}

/**
 * Seed test database with provider configs, API specs, and transform maps
 */
export async function seedTestData(context: TestContext): Promise<void> {
  // This would load configs from JSON files and insert into DB
  // For now, we'll rely on seeded data from migrations
  await context.providerRegistry.reloadConfigs();
}

/**
 * Clear test data from database
 */
export async function clearTestData(context: TestContext): Promise<void> {
  const apiLogRepo = context.dataSource.getRepository(ApiLogEntity);
  await apiLogRepo.clear();
}
