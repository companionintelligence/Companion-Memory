import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';

/**
 * 20261026105606_repair_mail_filed_as_sent_by_owner: mail somebody else sent
 * the owner, filed with the owner as its sender (K-303), comes off the owner's
 * person. Seeded on real Postgres and rolled back. Opt-in: set
 * `MEMORY_TEST_DATABASE_URL` to a migrated database of your own.
 */

const MIGRATION = '20261026105606_repair_mail_filed_as_sent_by_owner.sql';
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../db/postgres/migrations');

function migrationUpSql(): string {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');

  return down === -1 ? sql : sql.slice(0, down);
}

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(
    `[memory/repairMailFiledAsSentByOwner.migration.integration] SKIPPED — ${availability.reason}`,
  );
}

jest.setTimeout(60_000);

interface Mail {
  direction: string;
  from_entity_id: string | null;
  sent_from: string[];
}

describeWithDb(`repair_mail_filed_as_sent_by_owner (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let userId: string;
  let self: string;
  const mails: Record<string, string> = {};

  const q = <T>(text: string, params?: unknown[]): Promise<T> => runner.query(text, params) as Promise<T>;

  async function mail(
    label: string,
    from: string,
    options: { to?: string[]; direction?: string; toSelf?: boolean } = {},
  ): Promise<string> {
    const [{ entity_id }] = await q<Array<{ entity_id: string }>>(
      `INSERT INTO ci.entities (entity_type, owner_user_id, name) VALUES ('Communication', $1, $2) RETURNING entity_id`,
      [userId, label],
    );
    await q(
      `INSERT INTO ci.communications (id, time, user_id, communication_type, direction, content, from_entity_id,
                                      to_entity_ids, participants_metadata)
       VALUES ($1, now(), $2, 'email', $3, 'hello', $4, $5::uuid[], $6::jsonb)`,
      [
        entity_id,
        userId,
        options.direction ?? 'outbound',
        self,
        options.toSelf ? [self] : [],
        JSON.stringify({ from, to: options.to ?? [] }),
      ],
    );
    await q(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id, properties)
       VALUES ($1, $2, 'SENT', $3, '{"rule": "communication.sent", "derived_from": "communications.from_entity_id"}')`,
      [self, entity_id, userId],
    );
    mails[label] = entity_id;

    return entity_id;
  }

  async function read(label: string): Promise<Mail> {
    const [row] = await q<Mail[]>(
      `SELECT c.direction::text AS direction, c.from_entity_id,
              ARRAY(SELECT r.from_entity_id::text FROM ci.relationships r
                     WHERE r.to_entity_id = c.id AND r.relationship_type = 'SENT') AS sent_from
         FROM ci.communications c WHERE c.id = $1`,
      [mails[label]],
    );

    return row;
  }

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' })!;
    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
      synchronize: false,
      logging: false,
      extra: { max: 1 },
    });
    await dataSource.initialize();
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    userId = await createSyntheticTestUser((sql, params) => q(sql, params), 'RepairOwnerSentMail');
    const [{ email }] = await q<Array<{ email: string }>>(`SELECT email FROM ci.users WHERE id = $1`, [
      userId,
    ]);
    [{ entity_id: self }] = await q<Array<{ entity_id: string }>>(
      `INSERT INTO ci.entities (entity_type, owner_user_id, name, is_self, properties)
       VALUES ('Person', $1, 'Liam Broza', TRUE, jsonb_build_object('emails', jsonb_build_array($2::text)))
       RETURNING entity_id`,
      [userId, email],
    );
    await q(`UPDATE ci.users SET entity_id = $1 WHERE id = $2`, [self, userId]);
    // A second address, added in Edit Person: an identifier row only.
    await q(
      `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, source)
       VALUES ($1, $2, 'email', 'liam@work.example', 'user')`,
      [self, userId],
    );

    await mail('lookalike to me', '"Liam Broza" <stranger@example.net>', { toSelf: true });
    await mail('lookalike to someone else', '"Liam Broza" <stranger@example.net>', {
      to: ['bo@example.org'],
    });
    await mail('my second address', '"Liam Broza" <Liam@Work.example>', { to: ['bo@example.org'] });
    await mail('my account address', `"Liam" <${email}>`, { to: ['bo@example.org'] });
    await mail('no address at all', 'Liam Broza', { toSelf: true });
    // The sender's claim, confirmed by hand as the owner.
    const confirmed = await mail('confirmed by hand', '"Liam Broza" <stranger@example.net>', {
      toSelf: true,
    });
    await q(
      `INSERT INTO ci.identifier_claims (owner_user_id, subject_type, subject_id, role, kind, value_normalized,
                                         entity_id, confidence, disposition, disposed_at)
       VALUES ($1, 'communication', $2, 'from', 'email', 'stranger@example.net', $3, 1, 'confirmed', now())`,
      [userId, confirmed, self],
    );

    await q(migrationUpSql());
  });

  afterAll(async () => {
    if (runner != null) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('takes a lookalike’s mail to the owner off the owner, and reads it as inbound', async () => {
    expect(await read('lookalike to me')).toEqual({
      direction: 'inbound',
      from_entity_id: null,
      sent_from: [],
    });
  });

  it('takes the sender off a lookalike’s mail to somebody else, without turning it around', async () => {
    expect(await read('lookalike to someone else')).toEqual({
      direction: 'outbound',
      from_entity_id: null,
      sent_from: [],
    });
  });

  it('leaves mail from any of the owner’s own addresses alone', async () => {
    for (const label of ['my second address', 'my account address']) {
      expect(await read(label)).toEqual({ direction: 'outbound', from_entity_id: self, sent_from: [self] });
    }
  });

  it('leaves a sender with no address, and one a person confirmed, alone', async () => {
    expect(await read('no address at all')).toMatchObject({ from_entity_id: self, sent_from: [self] });
    expect(await read('confirmed by hand')).toMatchObject({ from_entity_id: self, sent_from: [self] });
  });
});
