import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';
import { DataSource } from 'typeorm';

import { HBPE_L1_CLUSTERS, HBPE_L1_EVENT_ASSIGNMENTS, HBPE_TOKEN_STREAM, HBPE_USER_ID } from './data/hbpe';

export async function seedHbpe(module: TestingModule, multibar: MultiBar) {
  const dataSource = module.get(DataSource);

  const total = HBPE_L1_CLUSTERS.length + HBPE_L1_EVENT_ASSIGNMENTS.length + HBPE_TOKEN_STREAM.length;
  const bar = multibar.create(total, 0, { task: 'HBPE' });

  // ── L1 clusters ────────────────────────────────────────────────────────────
  for (const c of HBPE_L1_CLUSTERS) {
    await dataSource.query(
      `INSERT INTO hbpe.l1_clusters
         (cluster_id, user_id, l0_class, label, member_count, naming_method, is_active)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
       ON CONFLICT (cluster_id) DO NOTHING`,
      [c.clusterId, HBPE_USER_ID, c.l0Class, c.label, c.memberCount, c.namingMethod, c.isActive],
    );
    bar.increment();
  }

  // ── L1 event assignments ───────────────────────────────────────────────────
  for (const a of HBPE_L1_EVENT_ASSIGNMENTS) {
    await dataSource.query(
      `INSERT INTO hbpe.l1_event_cluster (event_id, cluster_id, similarity)
       VALUES ($1::uuid, $2::uuid, $3)
       ON CONFLICT (event_id) DO NOTHING`,
      [a.eventId, a.clusterId, a.similarity],
    );
    bar.increment();
  }

  // ── Token stream ───────────────────────────────────────────────────────────
  for (const t of HBPE_TOKEN_STREAM) {
    await dataSource.query(
      `INSERT INTO hbpe.token_stream
         (id, user_id, date, seq_order, bucket_idx, level, token_id, soft_prob)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7, $8::float4[])
       ON CONFLICT (id) DO NOTHING`,
      [t.id, HBPE_USER_ID, t.date, t.seqOrder, t.bucketIdx, t.level, t.tokenId, t.softProb],
    );
    bar.increment();
  }

  bar.stop();
}
