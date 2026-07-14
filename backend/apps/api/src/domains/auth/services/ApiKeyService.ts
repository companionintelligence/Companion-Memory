import { createHash, randomBytes } from 'crypto';

import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { ApiKey, ApiKeyEntity } from '../entities/ApiKeyEntity';
import {
  CONNECT_KEY_NAME_PREFIX,
  CONNECT_PROVENANCE,
  type ApiKeyProvenance,
  type CreateApiKeyDto,
  type CreateApiKeyResponse,
  type UpdateApiKeyDto,
} from '../types';

const API_KEY_BYTE_LENGTH = 32;
const API_KEY_HEX_LENGTH = API_KEY_BYTE_LENGTH * 2;
const API_KEY_HEX_REGEX = /^[0-9a-f]+$/;
const PREFIX_LENGTH = 5;

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectRepository(ApiKeyEntity)
    private readonly apiKeyRepository: Repository<ApiKeyEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ApiKeyService.name);
  }

  async create(
    context: UserServiceContext,
    data: CreateApiKeyDto,
    managedBy: ApiKeyProvenance | null = null,
  ): Promise<CreateApiKeyResponse> {
    const rawKey = randomBytes(API_KEY_BYTE_LENGTH).toString('hex');
    const prefix = rawKey.substring(0, PREFIX_LENGTH);
    const hashedKey = this.hash(rawKey);

    const entity = this.apiKeyRepository.create({
      id: uuidv7(),
      name: data.name,
      prefix,
      hashed_key: hashedKey,
      scopes: data.scopes ?? [],
      expires_at: data.expires_at ? new Date(data.expires_at) : null,
      user_id: context.userId,
      // Defaults to null — a key created through the REST API is the user's own.
      // Only the connect flow passes a provenance, and it is never accepted from
      // request input.
      managed_by: managedBy,
    });

    const saved = await this.apiKeyRepository.save(entity);

    return {
      ...ApiKeyEntity.toEgressType(saved),
      key: rawKey,
    };
  }

  /**
   * Mint an api key idempotently for a `(user, name)` pair, rotating any
   * existing key with the same name.
   *
   * The raw key is only ever revealed at creation time (it is stored hashed),
   * so re-provisioning cannot return a previously-issued secret — instead the
   * old key is deleted and a fresh one minted and returned. This keeps repeated
   * provision calls (e.g. the Hub reconnecting an app, or key rotation) from
   * accumulating dead rows while guaranteeing the caller always receives a
   * usable secret. Callers that only need "a key exists" should check
   * {@link findByName} first.
   *
   * @param context - the owning user
   * @param data - key attributes; `name` doubles as the idempotency key
   */
  async createOrRotate(
    context: UserServiceContext,
    data: CreateApiKeyDto,
    managedBy: ApiKeyProvenance | null = null,
  ): Promise<CreateApiKeyResponse> {
    try {
      await this.deleteForRotate(context.userId, data.name, managedBy);

      return await this.create(context, data, managedBy);
    } catch (err) {
      // Two concurrent createOrRotate calls for the same (user, name) — e.g. a
      // re-consent racing the Hub's rotation sweep — can interleave delete/insert
      // so this insert trips the (user_id, name) unique index (idx_api_keys_user_id_app_name).
      // Retry once: the racing winner's row now exists, so our delete removes it
      // and the re-insert succeeds. Last-writer-wins is fine — both callers only
      // need a valid key to exist — and it turns a 500 into idempotent rotation.
      if (!this.isUniqueViolation(err)) {
        throw err;
      }

      await this.deleteForRotate(context.userId, data.name, managedBy);

      try {
        return await this.create(context, data, managedBy);
      } catch (retryErr) {
        if (!this.isUniqueViolation(retryErr)) {
          throw retryErr;
        }

        // The name is held by a key of a DIFFERENT provenance — a user's own key named
        // like a connect key. deleteForRotate deliberately will not remove it (deleting
        // a credential we did not mint is the clobbering this filter exists to prevent),
        // so the insert can never win and retrying forever would just 500 the consent
        // flow with nothing actionable in it. Name the collision instead.
        throw new ConflictException(
          `An API key named "${data.name}" already exists and is not managed by Companion Hub. Rename or delete it, then connect the app again.`,
        );
      }
    }
  }

  /**
   * The rotate half of {@link createOrRotate}: drop the key this caller is replacing.
   *
   * Matched on provenance as well as `(user, name)`, so the connect flow can only ever
   * rotate a key the connect flow minted. A same-named key of a DIFFERENT provenance is
   * left alone: the unique index on `(user_id, name) WHERE name LIKE 'app:%'` then makes
   * the insert fail loudly (23505) instead of silently deleting the user's own key —
   * which is the same cross-namespace clobbering `removeByName` and `update` refuse.
   */
  private async deleteForRotate(
    userId: string,
    name: string,
    managedBy: ApiKeyProvenance | null,
  ): Promise<void> {
    await this.apiKeyRepository.delete({
      user_id: userId,
      name,
      // TypeORM equality criteria never match NULL — an explicit IsNull() is required.
      managed_by: managedBy ?? IsNull(),
    });
  }

  /** Whether a caught error is a Postgres unique-violation (SQLSTATE 23505). */
  private isUniqueViolation(err: unknown): boolean {
    const code =
      (err as { code?: string; driverError?: { code?: string } } | null)?.code ??
      (err as { driverError?: { code?: string } } | null)?.driverError?.code;

    return code === '23505';
  }

  /**
   * Resolve the owning user id for a key by `name`, regardless of owner, or null
   * if no such key exists. Used by the trusted connect-rotate path: CI-Hub asks
   * to rotate "the key for app X" by its stable name without knowing the owning
   * `ci.users` id; this recovers it so the fresh key is minted under the same
   * user.
   *
   * Scoped to `managed_by = 'connect'`, so a user's own key can never be rotated
   * by this path no matter what they named it.
   *
   * Single-owner-appliance invariant: `(user_id, name)` is unique for `app:%`
   * names (migration 20260708115547), so on the appliance there is at most one
   * such row. On a hypothetical multi-user server several users could each hold
   * `app:<same-urn>`; the by-name rotate can't tell them apart, so we refuse
   * (log + return null) rather than rotate an arbitrary owner's key.
   */
  async findUserIdByName(name: string): Promise<string | null> {
    const keys = await this.apiKeyRepository.find({
      where: { name, managed_by: CONNECT_PROVENANCE },
      select: ['user_id'],
    });

    if (keys.length === 0) {
      return null;
    }

    if (keys.length > 1) {
      this.logger.error(
        `findUserIdByName: ${keys.length} keys named "${name}" across owners — ambiguous rotate refused (single-owner invariant violated)`,
      );

      return null;
    }

    return keys[0].user_id;
  }

  /**
   * Look up a single api key by its `(user, name)` pair, or null if none exists.
   * Used to detect whether an app has already been provisioned before deciding
   * to mint or rotate.
   */
  async findByName(context: UserServiceContext, name: string): Promise<ApiKey | null> {
    const key = await this.apiKeyRepository.findOne({
      where: { user_id: context.userId, name },
    });

    return key ? ApiKeyEntity.toEgressType(key) : null;
  }

  async findAllByUser(context: ServiceContext): Promise<ApiKey[]> {
    const keys = await this.apiKeyRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && { user_id: context.userId }),
      },
      order: { created_at: 'DESC' },
    });

    return keys.map(ApiKeyEntity.toEgressType);
  }

  async findOneByUser(context: ServiceContext, keyId: string): Promise<ApiKey | null> {
    const key = await this.apiKeyRepository.findOne({
      where: {
        id: keyId,
        ...(context.userId !== SYSTEM_USER && { user_id: context.userId }),
      },
    });

    return key ? ApiKeyEntity.toEgressType(key) : null;
  }

  async update(context: ServiceContext, keyId: string, data: UpdateApiKeyDto): Promise<ApiKey | null> {
    const key = await this.apiKeyRepository.findOne({
      where: {
        id: keyId,
        ...(context.userId !== SYSTEM_USER && { user_id: context.userId }),
      },
    });

    if (!key) {
      return null;
    }

    // Hub-managed connection keys are revoked by the Hub via their stable
    // `app:<urn>` name (see removeByName). Renaming or re-scoping one out-of-band
    // would orphan that revoke and strand the key, so refuse those mutations here
    // — not just in the UI, which only hides the control. Deleting is still
    // allowed (a user may deliberately force-revoke). A no-op submit that echoes
    // the current name/scopes is tolerated so idempotent clients don't 403.
    const renaming = data.name !== undefined && data.name !== key.name;

    if (this.isHubManagedKey(key)) {
      const rescoping = data.scopes !== undefined && !this.sameScopes(data.scopes, key.scopes ?? []);

      if (renaming || rescoping) {
        throw new ForbiddenException(
          'This key is managed by Companion Hub and cannot be renamed or re-scoped. Disconnect the app from Hub instead.',
        );
      }
    }

    // The `app:` namespace is reserved (see CONNECT_KEY_NAME_PREFIX), but only for
    // names being newly CHOSEN. Enforcing it on the request body instead would 400 a
    // client that merely echoes a key's own current `app:` name — which is what the
    // settings dialog submits — and would therefore leave the grandfathered
    // `app:`-named user keys this release hands back to their owners uneditable, the
    // opposite of the intent. An unchanged name is not a naming choice, so let it pass.
    if (renaming && data.name?.startsWith(CONNECT_KEY_NAME_PREFIX)) {
      throw new ForbiddenException(
        `Key names starting with "${CONNECT_KEY_NAME_PREFIX}" are reserved for connected apps`,
      );
    }

    if (data.name !== undefined) {
      key.name = data.name;
    }

    if (data.scopes !== undefined) {
      key.scopes = data.scopes;
    }

    const saved = await this.apiKeyRepository.save(key);

    return ApiKeyEntity.toEgressType(saved);
  }

  /**
   * A Hub-managed connection key: minted by the connect flow and lifecycle-owned by
   * CI-Hub, so the user may not rename or re-scope it out from under the app.
   *
   * Read from recorded provenance, NOT the `app:` name prefix: names are free-form,
   * so prefix-matching also caught a user's own `app:home-assistant` key and refused
   * to let them edit it — while the connect flow's revoke/rotate happily operated on
   * it. Scopes are no discriminator either (a connect key may hold an EMPTY set).
   */
  private isHubManagedKey(key: Pick<ApiKeyEntity, 'managed_by'>): boolean {
    return key.managed_by === CONNECT_PROVENANCE;
  }

  /** Order-insensitive scope-set equality (scope lists are small). */
  private sameScopes(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
      return false;
    }

    const other = new Set(b);

    return a.every((scope) => other.has(scope));
  }

  async remove(context: ServiceContext, keyId: string): Promise<boolean> {
    const result = await this.apiKeyRepository.delete({
      id: keyId,
      ...(context.userId !== SYSTEM_USER && { user_id: context.userId }),
    });

    return (result.affected ?? 0) > 0;
  }

  /**
   * Delete every api key with the given `name`, regardless of owner, returning
   * the number removed.
   *
   * This is a system-level revoke used by the trusted connect flow: CI-Hub (via
   * signed forward-auth) revokes "the key for app X" by its stable name
   * (`app:<urn>`) without knowing the owning `ci.users` id. Scoped to
   * `managed_by = 'connect'`, so it can only ever delete keys the connect flow
   * minted — a user's hand-made `app:...` key is untouchable here.
   *
   * Single-owner-appliance invariant: `(user_id, name)` is unique for `app:%`
   * names (migration 20260708115547), so exactly one row matches and this
   * removes precisely the app's key. If more than one owner ever holds the same
   * `app:<urn>` name (only possible on a multi-user server), we log it — a
   * by-name revoke would then delete every owner's key for that app. Deletion is
   * kept (revoke must stay idempotent), but the violation is surfaced.
   */
  async removeByName(name: string): Promise<number> {
    const result = await this.apiKeyRepository.delete({ name, managed_by: CONNECT_PROVENANCE });
    const removed = result.affected ?? 0;

    if (removed > 1) {
      this.logger.error(
        `removeByName: deleted ${removed} keys named "${name}" across owners (single-owner invariant violated)`,
      );
    }

    return removed;
  }

  async validateKey(rawKey: string): Promise<{ keyId: string; userId: string; scopes: string[] } | null> {
    if (rawKey.length !== API_KEY_HEX_LENGTH || !API_KEY_HEX_REGEX.test(rawKey)) {
      return null;
    }

    const hashed = this.hash(rawKey);

    const key = await this.apiKeyRepository.findOne({
      where: { hashed_key: hashed },
      select: ['id', 'user_id', 'expires_at', 'scopes'],
    });

    if (!key) {
      return null;
    }

    if (key.expires_at && key.expires_at < new Date()) {
      return null;
    }

    await this.apiKeyRepository.update(key.id, { last_used_at: new Date() });

    // `scopes` drives least-privilege enforcement downstream (see
    // enforceApiKeyScopes). An empty array is a legacy full-access key,
    // preserved as-is. `keyId` identifies WHICH key authenticated: two keys of the
    // same user can hold identical scopes (both chat agents do), so anything binding
    // state to a caller's authority needs the key itself, not just its powers.
    return { keyId: key.id, userId: key.user_id, scopes: key.scopes ?? [] };
  }

  private hash(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }
}
