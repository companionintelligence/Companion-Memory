import { Injectable } from '@nestjs/common';

import { SYSTEM_USER } from '@ci/common/context';
import {
  CAPTURE_SCOPE,
  FULL_CAPABILITY,
  INTENTS_SCOPE,
  MCP_SCOPE,
  MEMORY_SCOPE,
  WRITE_CAPABILITY,
  type ApiKeyCapability,
} from '@ci/common/decorators';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { CONNECT_KEY_NAME_PREFIX, CONNECT_PROVENANCE } from '../types';

import { ApiKeyService } from './ApiKeyService';
import { AuthService } from './AuthService';
import { ConnectCodeService } from './ConnectCodeService';

/** Minted keys expire after this many days; CI-Hub rotates well before expiry. */
const CONNECT_KEY_TTL_DAYS = 90;

/**
 * Apps that are minted a FULL-SURFACE key (an empty scope list, which the
 * api-key guards treat as "not scope-limited"): every route, GraphQL, files,
 * bulk ingest, maintenance, the whole-account export. Empty today: the bulk
 * importer that once needed it was folded into CI-Server itself. An app earns a
 * place here by review, never by being unknown — see {@link scopesForApp}.
 */
export const FULL_SURFACE_CONNECT_APPS: ReadonlySet<string> = new Set<string>([]);

/** What an app the server has no specific knowledge of is confined to. */
export const DEFAULT_CONNECT_SCOPES: readonly string[] = [MEMORY_SCOPE, INTENTS_SCOPE, MCP_SCOPE];

/**
 * The least-privilege scope set a connect key is minted with, per app.
 *
 * This is the SINGLE source of truth for both what the key can do (enforced
 * deny-by-default by the api-key guards) and what the consent page tells the
 * user it will do — they read this same function so they can never drift.
 *
 * App URNs are `<appName>:<store>` (e.g. `ci-openclaw:ci-marketplace`); we key
 * on the app name. The default is the chat-agent tier: long-term memory, the
 * intent catalog and the MCP endpoint, and nothing on the raw data plane. It
 * used to be the other way round — an app the switch did not name got an EMPTY
 * scope set, i.e. full access, "so enforcement never breaks an app whose real
 * needs we didn't enumerate" — which handed every unreviewed marketplace app
 * the whole account (export included) the moment its user clicked Approve.
 * Now a broader grant is an explicit, reviewed entry in
 * {@link FULL_SURFACE_CONNECT_APPS}; an app that genuinely needs more than the
 * tier fails visibly at its first out-of-scope call, and the fix is a line of
 * review here rather than a default that quietly trusts everyone.
 *
 * "Fails visibly" is only true for a NEW connect. {@link ConnectService.rotateByApp}
 * re-derives scopes from here, and CI-Hub rotates every connected app's key on a
 * timer, so changing an app's case narrows (or widens) the key it already holds
 * at its next rotation, with no re-consent. So every marketplace app that
 * declares `hub_integration.memory` gets its tier from the routes it actually
 * calls (named below, or left on the default on purpose), and
 * ConnectService.test pins each one. The `ci-mentra` glasses bridge and the
 * `ci-ha-voice` Home Assistant voice facade are confined to memory alone.
 */
export function scopesForApp(appUrn: string): string[] {
  const appName = appUrn.split(':')[0];

  if (FULL_SURFACE_CONNECT_APPS.has(appName)) {
    return [];
  }

  switch (appName) {
    case 'ci-openclaw':
    case 'ci-hermes':
      // Chat-agent tier: the three capabilities these agents use — long-term
      // memory (`/memory/*`, and `/v1/agent/jobs` dispatch), the agent intent
      // catalog (`/intents`, `/agent/intents`, `POST /intents/:name/execute`),
      // and the MCP endpoint (`/mcp`). Deliberately confined OFF the raw data
      // plane (GraphQL, `/files`, `/v1` bulk ingest, `/maintenance`) — that
      // confinement is the whole point of scoping these apps. Kept as a single
      // tier (rather than per-agent) so it can't break whichever of intents/mcp
      // each agent actually exercises.
      return [...DEFAULT_CONNECT_SCOPES];
    case 'ci-web-xr-scan':
    case 'ci-capture':
      // Capture tier: write observations in, read nothing back. Companion Scan
      // (CI-Spatial `server/memory_push.ts`) pushes a finished scan with
      // `POST /files/upload` then `POST /v1/events`, and calls nothing else on
      // this server — the chat-agent tier would 403 both. Companion Capture is
      // the agent `capture` was designed for (see CAPTURE_SCOPE): its ingest is
      // `/files/upload`, `PATCH /files/:id` and `/v1/events`. Its container does
      // not read the brokered token yet (it signs in and mints its own key), so
      // its GraphQL parse-status poll is not covered here and would need a
      // reviewed widening before it moves onto this key.
      return [CAPTURE_SCOPE];
    // Memory-only tier. The labels stay adjacent so `no-fallthrough` reads them
    // as one group (a comment between two cases makes it report each one).
    //  - ci-glasses-bridge (CI-Even-Realities `agent-hub`) augments chat with
    //    `POST /memory/recall` and writes the turn back with `POST /memory/turn`.
    //  - ci-mentra (Mentra smart-glasses bridge) only reads context/recall and
    //    records turns/fragments through `/memory/*`: no intents, no MCP, no
    //    raw data plane.
    //  - ci-ha-voice (CI-Home-Assistant-Voice-PE) grounds each spoken answer in
    //    `/memory/context` + `/memory/recall` and saves the exchange with
    //    `/memory/turn`. It runs no tools and reads no raw data.
    case 'ci-glasses-bridge':
    case 'ci-mentra':
    case 'ci-ha-voice':
      return [MEMORY_SCOPE];
    default:
      // Includes `hermes-agent`: the upstream Hermes image declares the memory
      // integration but nothing in its listing reads the token yet. When it
      // does, it is the same agent as `ci-hermes`, so the chat-agent tier fits.
      return [...DEFAULT_CONNECT_SCOPES];
  }
}

/**
 * The authority level a connect key is minted with, per app — the second axis to
 * {@link scopesForApp}'s first. Scopes say *which* surfaces the key opens;
 * capability says what it may DO there (`read` < `write` < `full`).
 *
 * Stated here, next to the scopes, so the two halves of one grant are chosen
 * together and read in one place. Before this existed the mint passed no
 * capability at all and every connect key silently inherited
 * `DEFAULT_API_KEY_CAPABILITY` — an authority level nobody had picked for these
 * apps, and one that would move under them if that default ever changed.
 *
 * The chat agents (`ci-openclaw`, `ci-hermes`) are on `full`; everything else
 * (including the memory-scoped `ci-mentra` glasses bridge) on `write`. Both chosen, not inherited:
 *
 * - the chat agents record as well as recall, so `read` would break them
 *   (`POST /memory/write` and `/memory/turn` are `@RequireCapability(write)`).
 *
 *   They were on `write` for the reason this comment used to give: `full` would
 *   hand a chat agent the ability to DELETE memories, "the one thing worth
 *   asking a user about separately". That reasoning was right and its conclusion
 *   is now wrong, because the missing half arrived. At `write` the harness did
 *   not get asked about — it got a flat `TOOL_FORBIDDEN` from `capabilityAllows`
 *   BEFORE the gate, and a deny is deliberately never laundered into a queue
 *   (see toolGate). So there was no card, no audit trail, and no way for the
 *   owner to say yes; "ask the user separately" had nowhere to happen.
 *
 *   `resolveToolGate` now queues any `needsConfirmation` intent from a
 *   `managed-app` principal regardless of the owner's trust dial and regardless
 *   of the pending-actions feature flag. So `full` here does not mean the
 *   harness may delete a memory; it means the harness may ASK to, and the owner
 *   answers. That is the separate asking this comment wanted.
 *
 *   The two are a pair. Reverting one without the other is unsafe in both
 *   directions: `full` without the gate rule is unattended deletion, and the gate
 *   rule without `full` is the flat refusal that made cards unreachable.
 * - the default branch (the capture apps, the glasses bridge, and any app whose
 *   needs we have not enumerated) is confined by `scopesForApp` to a tier and
 *   does not need destructive authority inside it. `write` is what the capture
 *   tier's routes require (`/files/upload` and `/v1` bulk ingest are
 *   `@RequireCapability(write)`) and what `POST /memory/turn` requires.
 *
 * Pinned to the literal rather than tracking `DEFAULT_API_KEY_CAPABILITY`: these
 * are agent credentials minted on a user's consent, so raising the default for
 * hand-made keys must not silently promote every connected app.
 */
export function capabilityForApp(appUrn: string): ApiKeyCapability {
  const appName = appUrn.split(':')[0];

  switch (appName) {
    case 'ci-openclaw':
    case 'ci-hermes':
      // Chat-agent tier: recall, remember, and ASK to delete — the gate turns a
      // destructive attempt into an approval card rather than running it. Paired
      // with the `managed-app` rule in resolveToolGate; see the docblock above.
      return FULL_CAPABILITY;
    case 'ci-mentra':
      // Glasses bridge: reads context/recall and writes turns/fragments
      // (`POST /memory/turn` and `/memory/write` need `write`). Not paired with
      // the confirmation gate, so never `full`. Stated explicitly rather than
      // riding the default so a change there cannot move it.
      return WRITE_CAPABILITY;
    case 'ci-ha-voice':
      // Home Assistant voice: `/memory/turn` needs `write`, and a speaker in the
      // kitchen has no business deleting memories. Explicit for the same reason.
      return WRITE_CAPABILITY;
    default:
      // Capture apps, glasses bridge, un-enumerated apps: write, destroy nothing.
      return WRITE_CAPABILITY;
  }
}

/**
 * The result of an approved connect: a one-time code for CI-Hub to exchange.
 */
export interface ApprovedConnect {
  /** One-time code to hand back to CI-Hub (in the redirect). */
  code: string;
}

/**
 * The result of exchanging a connect code: the raw scoped api key.
 */
export interface ExchangedConnect {
  /** The app URN the key was minted for. */
  appUrn: string;
  /** The raw memory-scoped api key (revealed exactly once). */
  key: string;
  /** ISO-8601 instant the key expires; CI-Hub rotates well before this. */
  expiresAt: string;
}

/**
 * Orchestrates the app-connect flow: turning a consenting, signed-in user into
 * a durable, memory-scoped api key that CI-Hub injects into an agent app.
 *
 * This is the identity anchor for the whole feature — the key is minted under
 * the user who actually signed in and consented, so it unlocks exactly their
 * memory (no forward-auth identity guessing). The raw key is handed to CI-Hub
 * out-of-band via a one-time code ({@link ConnectCodeService}); it never
 * transits the browser.
 */
@Injectable()
export class ConnectService {
  /** Parsed, normalized `CI_HUB_ORIGINS` — cached on first use (static config). */
  private cachedHubOrigins: string[] | null = null;

  constructor(
    private readonly authService: AuthService,
    private readonly userService: UserService,
    private readonly apiKeyService: ApiKeyService,
    private readonly connectCodeService: ConnectCodeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ConnectService.name);
  }

  /**
   * Resolve the signed-in user from a CI-Server session cookie, or `null` when
   * the cookie is missing or invalid, its session has ended, or the user no
   * longer exists.
   *
   * Goes through the session's row ({@link AuthService.resolveLiveSession}),
   * not just the cookie's signature. Consent here leads to a key minted for
   * this account, so a session that was signed out must not grant it, and only
   * a token that names a user and a live session can say whose account it is.
   */
  async resolveSessionUser(
    sessionToken: string | undefined,
  ): Promise<{ userId: string; email: string } | null> {
    if (!sessionToken) {
      return null;
    }

    const session = await this.authService.resolveLiveSession(sessionToken);

    if (!session) {
      return null;
    }

    const user = await this.userService.findById({ userId: SYSTEM_USER }, session.userId);

    if (!user) {
      return null;
    }

    return { userId: user.id, email: user.email };
  }

  /**
   * Whether `returnUrl`'s origin is an allowlisted CI-Hub origin. This is the
   * open-redirect guard for the single cross-origin hop back to CI-Hub; the
   * allowlist is provisioned by CI-Hub at install (`CI_HUB_ORIGINS`).
   */
  isReturnUrlAllowed(returnUrl: string): boolean {
    const allowed = this.allowedHubOrigins();

    if (allowed.length === 0) {
      return false;
    }

    let origin: string;

    try {
      origin = new URL(returnUrl).origin;
    } catch {
      return false;
    }

    return allowed.includes(origin);
  }

  /**
   * Issue a one-time code authorizing CI-Hub to mint the memory-scoped key for
   * `(userId, appUrn)`. The key itself is NOT minted here — deferring the mint
   * to {@link exchange} means an abandoned or failed flow never rotates (and so
   * never destroys) an app's existing, still-injected key.
   */
  async approve(userId: string, appUrn: string): Promise<ApprovedConnect> {
    const code = await this.connectCodeService.issue(userId, appUrn);

    this.logger.log(`Approved memory connect for app ${appUrn} (user ${userId})`);

    return { code };
  }

  /**
   * Redeem a one-time code and mint the memory-scoped key for the bound
   * `(user, app)`, rotating any existing key for that app. Returns the raw key
   * (revealed once), or `null` if the code is unknown/expired/already used.
   * Minting here — only on a successful, single-use redemption — is what makes
   * an interrupted re-consent safe for a currently-connected app.
   */
  async exchange(code: string): Promise<ExchangedConnect | null> {
    const consumed = await this.connectCodeService.consume(code);

    if (!consumed) {
      return null;
    }

    const expiresAt = new Date(Date.now() + CONNECT_KEY_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const minted = await this.apiKeyService.createOrRotate(
      { userId: consumed.userId },
      {
        name: this.keyName(consumed.appUrn),
        scopes: scopesForApp(consumed.appUrn),
        capability: capabilityForApp(consumed.appUrn),
        expires_at: expiresAt,
      },
      // Records that CI-Hub owns this key's lifecycle, so revoke/rotate can find it
      // and the user cannot re-scope it. Never inferred from the name, which a user
      // could otherwise collide with.
      CONNECT_PROVENANCE,
    );

    this.logger.log(`Minted connect key on exchange for app ${consumed.appUrn} (user ${consumed.userId})`);

    return { appUrn: consumed.appUrn, key: minted.key, expiresAt };
  }

  /**
   * Rotate the connect key for `appUrn`: mint a fresh key (new TTL) for the same
   * owning user, replacing the old one. Returns the new raw key, or null when no
   * key is currently connected for the app. Called by the trusted Hub path (key
   * rotation before expiry); no re-consent is needed because the user already
   * consented to the connection — this only refreshes the same grant. The fresh
   * key's scopes and capability are re-derived from {@link scopesForApp} and
   * {@link capabilityForApp}, so a rotate also heals a key minted under a
   * previous policy — and equally narrows one, without re-consent, which is why
   * every memory-consuming marketplace app's tier is pinned by test.
   * Assumes the single-owner appliance;
   * {@link ApiKeyService.findUserIdByName} returns null (no rotate) if multiple
   * owners hold the same `app:<urn>` name.
   */
  async rotateByApp(appUrn: string): Promise<ExchangedConnect | null> {
    const name = this.keyName(appUrn);
    const userId = await this.apiKeyService.findUserIdByName(name);

    if (!userId) {
      return null;
    }

    const expiresAt = new Date(Date.now() + CONNECT_KEY_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const minted = await this.apiKeyService.createOrRotate(
      { userId },
      {
        name,
        scopes: scopesForApp(appUrn),
        capability: capabilityForApp(appUrn),
        expires_at: expiresAt,
      },
      CONNECT_PROVENANCE,
    );

    this.logger.log(`Rotated connect key for app ${appUrn} (user ${userId})`);

    return { appUrn, key: minted.key, expiresAt };
  }

  /**
   * Revoke the connect key minted for `appUrn`, by its stable name. Called by the
   * trusted Hub path (agent uninstall, user "Disconnect", ci-memory reset) which
   * identifies the app but not the owning user. Idempotent: returns the number
   * of keys removed (0 when nothing was connected). Assumes the single-owner
   * appliance (one `app:<urn>` key); {@link ApiKeyService.removeByName} logs if
   * that invariant is ever violated.
   */
  async revokeByApp(appUrn: string): Promise<number> {
    const removed = await this.apiKeyService.removeByName(this.keyName(appUrn));

    if (removed > 0) {
      this.logger.log(`Revoked memory connect for app ${appUrn} (${removed} key(s))`);
    }

    return removed;
  }

  /**
   * Build the redirect URL back to CI-Hub, carrying the one-time `code` and the
   * caller's opaque `state`. Caller must have validated `returnUrl` via
   * {@link isReturnUrlAllowed} first.
   */
  buildReturnUrl(returnUrl: string, code: string, state: string): string {
    const url = new URL(returnUrl);

    url.searchParams.set('code', code);
    url.searchParams.set('state', state);

    return url.toString();
  }

  /**
   * Build the redirect URL back to CI-Hub for a declined/failed consent: no code
   * is minted, an `error` is carried instead, and CI-Hub's callback returns the
   * user to the app they started from (its interstitial). Caller must have
   * validated `returnUrl` via {@link isReturnUrlAllowed} first.
   */
  buildDenyUrl(returnUrl: string, state: string, error = 'access_denied'): string {
    const url = new URL(returnUrl);

    url.searchParams.set('error', error);
    url.searchParams.set('state', state);

    return url.toString();
  }

  /** The idempotent api-key name for an app URN. */
  private keyName(appUrn: string): string {
    return `${CONNECT_KEY_NAME_PREFIX}${appUrn}`;
  }

  /** Parse + normalise the configured CI-Hub origin allowlist. */
  private allowedHubOrigins(): string[] {
    // CI_HUB_ORIGINS is static process config, so parse it once and cache the
    // normalized origins instead of re-splitting + re-parsing on every connect
    // request (any malformed entry is warned about once, on first access).
    if (this.cachedHubOrigins === null) {
      this.cachedHubOrigins = config.auth.connect.hubOrigins
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          try {
            return new URL(entry).origin;
          } catch {
            this.logger.warn(`Ignoring malformed CI_HUB_ORIGINS entry: ${entry}`);

            return '';
          }
        })
        .filter((origin) => origin.length > 0);
    }

    return this.cachedHubOrigins;
  }
}
