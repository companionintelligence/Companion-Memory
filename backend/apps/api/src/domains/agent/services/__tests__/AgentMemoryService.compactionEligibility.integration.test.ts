import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { AgentMemoryEntity } from '../../entities/AgentMemoryEntity';
import { AgentMemoryService } from '../AgentMemoryService';

const availability = databaseAvailability({ urlEnvVar: 'AGENT_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;
if (!availability.available) {
  console.warn(`[agent/compactionEligibility] SKIPPED — ${availability.reason}`);
}

describeWithDb('governed memory compaction eligibility in PostgreSQL', () => {
  const ownerId = uuidv7();
  let dataSource: DataSource;
  let service: AgentMemoryService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection({ urlEnvVar: 'AGENT_TEST_DATABASE_URL' }),
      entities: [AgentMemoryEntity],
      synchronize: false,
    });
    await dataSource.initialize();
    await createSyntheticTestUser(
      (sql, params) => dataSource.query(sql, params),
      'MemoryEligibility',
      ownerId,
    );
    service = new AgentMemoryService(
      dataSource.getRepository(AgentMemoryEntity),
      { send: jest.fn() } as never,
      { setContext: jest.fn() } as never,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.agent_memories WHERE user_id = $1', [ownerId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ownerId]);
      await dataSource.destroy();
    }
  });

  it('promotes only active, currently valid fragments and preserves the other lifecycle states', async () => {
    const now = Date.now();
    const activeId = uuidv7();
    await dataSource.getRepository(AgentMemoryEntity).save([
      {
        id: activeId,
        userId: ownerId,
        content: 'active',
        status: 'active' as const,
        createdAt: new Date(now - 60_000),
      },
      {
        id: uuidv7(),
        userId: ownerId,
        content: 'superseded',
        status: 'superseded' as const,
        createdAt: new Date(now - 60_000),
      },
      {
        id: uuidv7(),
        userId: ownerId,
        content: 'conflicted',
        status: 'conflicted' as const,
        createdAt: new Date(now - 60_000),
      },
      {
        id: uuidv7(),
        userId: ownerId,
        content: 'future',
        status: 'active' as const,
        validFrom: new Date(now + 60_000),
        createdAt: new Date(now - 60_000),
      },
      {
        id: uuidv7(),
        userId: ownerId,
        content: 'expired',
        status: 'active' as const,
        validUntil: new Date(now - 30_000),
        createdAt: new Date(now - 60_000),
      },
    ]);
    const eligible = await service.findUnprocessed({ userId: ownerId }, { minAgeMinutes: 0 });
    expect(eligible.map((memory) => memory.id)).toEqual([activeId]);
    await service.markProcessed({ userId: ownerId }, [activeId]);
    expect(await service.findUnprocessed({ userId: ownerId }, { minAgeMinutes: 0 })).toEqual([]);
    expect(await dataSource.getRepository(AgentMemoryEntity).countBy({ userId: ownerId })).toBe(5);
  });
});
