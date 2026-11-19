import { BadRequestException, HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { AskEntity, AskGrantEntity, GrantService } from '@ci/domains/asks';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { PeerIdentityKeyEntity } from '../entities/PeerIdentityKeyEntity';
import { PeerInviteEntity } from '../entities/PeerInviteEntity';
import { PeerLinkEntity } from '../entities/PeerLinkEntity';
import { parseInviteCode } from '../inviteCode';
import type { ExchangeResult } from '../services/PeerExchangeClient';
import { PeerIdentityService, type PeerSigner } from '../services/PeerIdentityService';
import { INVITE_ACCEPT_PATH, PeerInviteService } from '../services/PeerInviteService';
import { PeerLinkService } from '../services/PeerLinkService';

/**
 * Two people linking by invite, end to end against real Postgres.
 *
 * Both "boxes" are this database: Alice and Bob are two users on it, which is
 * also a real case (two people on one Companion may link). The network between
 * the boxes is replaced by a fake `PeerExchangeClient` that answers an identity
 * check from the keys table and delivers a signed POST straight to
 * `PeerInviteService.receive`, as the controller would once it had verified the
 * signature. The HTTP and signature layers have their own suites.
 */
const availability = databaseAvailability({ urlEnvVar: 'PEERS_TEST_DATABASE_URL' });
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[peers/PeerInvites.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const ENDPOINT = 'https://box.example.com/api/agent/v1';

describeWithDatabase(`linking by invite — against real Postgres (${availability.target})`, () => {
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as LoggerService;

  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let identities: PeerIdentityService;
  let links: PeerLinkService;
  let invites: PeerInviteService;
  /** Did:keys whose identity check the fake should fail, as a box that cannot prove its key would. */
  const unprovable = new Set<string>();
  const users: string[] = [];
  const previousEndpoint = config.peers.memoryEndpoint;

  async function user(name: string): Promise<string> {
    const id = uuidv7();
    users.push(id);
    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, password, onboarded) VALUES ($1, $2, $3, 'x', true)`,
      [id, name, `peer.invites.${id}@example.test`],
    );

    return id;
  }

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'PEERS_TEST_DATABASE_URL' });

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

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
      entities: [
        UserEntity,
        PeerLinkEntity,
        PeerIdentityKeyEntity,
        PeerInviteEntity,
        AskGrantEntity,
        AskEntity,
      ],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'peer invites');

    (config.peers as { memoryEndpoint?: string }).memoryEndpoint = ENDPOINT;

    identities = new PeerIdentityService(dataSource.getRepository(PeerIdentityKeyEntity), noopLogger);
    const grants = new GrantService(
      dataSource.getRepository(AskGrantEntity),
      dataSource.getRepository(AskEntity),
      noopLogger,
    );
    links = new PeerLinkService(dataSource.getRepository(PeerLinkEntity), noopLogger, grants);

    const exchange = {
      verifyIdentity: async (_endpoint: string, didKey: string): Promise<ExchangeResult<void>> =>
        !unprovable.has(didKey) && (await identities.findActiveByDidKey(didKey)) != null
          ? { ok: true, value: undefined }
          : { ok: false, reason: 'bad-proof' },
      postSigned: async (
        _endpoint: string,
        path: string,
        body: unknown,
        signer: PeerSigner,
      ): Promise<ExchangeResult<unknown>> => {
        expect(path).toBe(INVITE_ACCEPT_PATH);
        try {
          return { ok: true, value: await invites.receive(signer.keyid, body) };
        } catch (error) {
          if (error instanceof HttpException) {
            return { ok: false, reason: 'refused', status: error.getStatus() };
          }

          throw error;
        }
      },
    };

    const userService = {
      findById: async (_ctx: unknown, id: string) =>
        (await dataSource.query('SELECT id, name FROM ci.users WHERE id = $1', [id]))[0] ?? null,
    };

    invites = new PeerInviteService(
      dataSource.getRepository(PeerInviteEntity),
      identities,
      links,
      exchange as never,
      userService as never,
      noopLogger,
    );
  });

  afterAll(async () => {
    (config.peers as { memoryEndpoint?: string }).memoryEndpoint = previousEndpoint;

    if (dataSource?.isInitialized) {
      // ON DELETE CASCADE takes keys, invites and links.
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('links both people by key, at stranger, and uses the invite up', async () => {
    const alice = await user('Alice Example');
    const bob = await user('Bob Example');

    const { code, invite } = await invites.create({ userId: alice }, { label: 'for Bob' });
    expect(invite.status).toBe('pending');
    expect(invite.inviterName).toBe('Alice Example');

    const bobsLink = await invites.accept({ userId: bob }, code);

    const aliceKey = await identities.existingDidKeyFor(alice);
    const bobKey = await identities.existingDidKeyFor(bob);
    expect(bobsLink).toMatchObject({
      peerIssuer: 'did:key',
      peerSubject: aliceKey,
      memoryEndpoint: ENDPOINT,
      displayName: 'Alice Example',
      trustTier: 'stranger',
      status: 'active',
    });

    const alicesLink = await links.findActiveByIssuerSubject(alice, 'did:key', bobKey as string);
    expect(alicesLink).toMatchObject({
      displayName: 'Bob Example',
      trustTier: 'stranger',
      peerHandle: 'bob-example',
    });

    const [stored] = await invites.list({ userId: alice });
    expect(stored.status).toBe('used');
    const [row] = await dataSource.query(
      'SELECT used_link_id, secret_hash FROM ci.peer_invites WHERE id = $1',
      [invite.id],
    );
    expect(row.used_link_id).toBe(alicesLink?.id);
    // Only the hash is kept: the code's secret is not in the table.
    expect(row.secret_hash).not.toBe(parseInviteCode(code)?.secret);
  });

  it('accepts a code only once', async () => {
    const alice = await user('Alice Once');
    const bob = await user('Bob Once');
    const carol = await user('Carol Once');
    const { code } = await invites.create({ userId: alice });

    await invites.accept({ userId: bob }, code);

    await expect(invites.accept({ userId: carol }, code)).rejects.toThrow(
      /expired, was already used, or was withdrawn/,
    );
    expect(await links.findAll({ userId: carol })).toEqual([]);
  });

  it('refuses a withdrawn invite and an expired one', async () => {
    const alice = await user('Alice Withdrawn');
    const bob = await user('Bob Withdrawn');

    const withdrawn = await invites.create({ userId: alice });
    await invites.revoke({ userId: alice }, withdrawn.invite.id);
    await expect(invites.accept({ userId: bob }, withdrawn.code)).rejects.toThrow(/withdrawn/);

    const expired = await invites.create({ userId: alice });
    await dataSource.query(
      `UPDATE ci.peer_invites SET created_at = NOW() - interval '3 days', expires_at = NOW() - interval '1 day' WHERE id = $1`,
      [expired.invite.id],
    );
    await expect(invites.accept({ userId: bob }, expired.code)).rejects.toThrow(/expired/);
    expect(await links.findAll({ userId: bob })).toEqual([]);
  });

  it('refuses your own invite', async () => {
    const alice = await user('Alice Self');
    const { code } = await invites.create({ userId: alice });

    await expect(invites.accept({ userId: alice }, code)).rejects.toThrow(/your own invite/);
  });

  it('sends nothing when the inviting box cannot prove the key in the code', async () => {
    const alice = await user('Alice Unproven');
    const bob = await user('Bob Unproven');
    const { code, invite } = await invites.create({ userId: alice });
    unprovable.add(parseInviteCode(code)?.didKey as string);

    await expect(invites.accept({ userId: bob }, code)).rejects.toBeInstanceOf(BadRequestException);

    const [row] = await dataSource.query('SELECT used_at FROM ci.peer_invites WHERE id = $1', [invite.id]);
    expect(row.used_at).toBeNull();
  });

  it('does not use the invite up when the accepting box cannot prove its own key', async () => {
    const alice = await user('Alice Callback');
    const bob = await user('Bob Callback');
    const { code, invite } = await invites.create({ userId: alice });
    unprovable.add((await identities.identityFor(bob)).didKey);

    await expect(invites.accept({ userId: bob }, code)).rejects.toBeInstanceOf(BadRequestException);

    const [row] = await dataSource.query('SELECT used_at FROM ci.peer_invites WHERE id = $1', [invite.id]);
    expect(row.used_at).toBeNull();
    expect(await links.findAll({ userId: alice })).toEqual([]);
  });

  it('never reuses a handle the owner once used, ended links included', async () => {
    const alice = await user('Alice Handles');
    const bob = await user('Dana');
    await links.upsert(
      { userId: alice },
      { peerHandle: 'dana', memoryEndpoint: 'https://old.example/agent/v1' },
    );
    await links.revoke({ userId: alice }, 'dana');

    const { code } = await invites.create({ userId: alice });
    await invites.accept({ userId: bob }, code);

    const bobKey = await identities.existingDidKeyFor(bob);
    expect((await links.findActiveByIssuerSubject(alice, 'did:key', bobKey as string))?.peerHandle).toBe(
      'dana-2',
    );
  });

  it('refuses a second link to someone already linked', async () => {
    const alice = await user('Alice Twice');
    const bob = await user('Bob Twice');
    await invites.accept({ userId: bob }, (await invites.create({ userId: alice })).code);

    await expect(
      invites.accept({ userId: bob }, (await invites.create({ userId: alice })).code),
    ).rejects.toThrow(/already linked/);
  });

  it('refuses a code that is not one', async () => {
    const bob = await user('Bob Garbage');

    await expect(invites.accept({ userId: bob }, 'cmi1.not-json')).rejects.toThrow(/not an invite code/);
  });
});
