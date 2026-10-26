import { Injectable } from '@nestjs/common';

import { type ServiceContext } from '@ci/common/context';
import { doorbellBlocker } from '@ci/common/hubDoorbell';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { ApiKeyService } from '@ci/domains/auth';
import { CloudOAuthProxyService, type PortalDeviceApplication } from '@ci/domains/connections';

export type AgentHarnessId = 'hermes' | 'openclaw';

export type DispatchBlocker =
  | 'not_installed'
  | 'not_connected'
  | 'not_running'
  /**
   * This appliance cannot ring Hub at all — no `CI_HUB_INTERNAL_URL`, or no
   * `CI_HUB_FORWARD_AUTH_SECRET`. Nothing to do with OpenClaw, which may be
   * installed, connected and running perfectly.
   *
   * Its absence is why a dev stack offered a Dispatch button that created a job
   * and woke nothing.
   */
  | 'doorbell_unconfigured'
  | 'not_wakeable'
  | 'chat_only'
  | null;

export interface AgentHarnessStatus {
  id: AgentHarnessId;
  name: string;
  /** Hub connect flow minted a memory key for this agent app. */
  connectedToMemory: boolean;
  /** Portal listed the app, or Hub already minted a connect key for it. */
  installed: boolean;
  /** HTTP probe against {@link openUrl} succeeded (when probed). */
  running: boolean;
  openUrl: string | null;
  /** Ready to open from Memory — installed with a resolvable open URL. */
  accessible: boolean;
  /** Hub can ring this app's /hooks/wake. Hermes never is. */
  wakeable: boolean;
  /** Installed, talking to Memory, running, and wakeable. OpenClaw only. */
  dispatchReady: boolean;
  dispatchBlocker: DispatchBlocker;
  /** Hub memory-connect launcher, when a Hub origin is configured. */
  connectUrl: string | null;
}

export const OPENCLAW_APP_URN = 'ci-openclaw:ci-marketplace';
export const HERMES_APP_URN = 'ci-hermes:ci-marketplace';

interface AgentHarnessDefinition {
  id: AgentHarnessId;
  name: string;
  appNames: string[];
  connectKeyPrefix: string;
}

const AGENT_HARNESSES: AgentHarnessDefinition[] = [
  {
    id: 'hermes',
    name: 'Hermes',
    appNames: ['ci-hermes'],
    connectKeyPrefix: 'app:ci-hermes:',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    appNames: ['ci-openclaw'],
    connectKeyPrefix: 'app:ci-openclaw:',
  },
];

const PROBE_TIMEOUT_MS = 3_000;

@Injectable()
export class AgentHarnessService {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly cloudOAuthProxyService: CloudOAuthProxyService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AgentHarnessService.name);
  }

  async getHarnesses(context: ServiceContext): Promise<AgentHarnessStatus[]> {
    const [keys, portalApps] = await Promise.all([
      this.apiKeyService.findAllByUser(context),
      this.cloudOAuthProxyService.getDeviceApplications(),
    ]);

    const statuses = AGENT_HARNESSES.map((definition) =>
      this.buildHarnessStatus(definition, keys, portalApps),
    );

    await Promise.all(
      statuses.map(async (status) => {
        if (status.openUrl) {
          status.running = await this.probeOpenUrl(status.openUrl);
          status.accessible = status.running;
        }

        Object.assign(
          status,
          resolveReadiness(status.id, {
            installed: status.installed,
            connectedToMemory: status.connectedToMemory,
            running: status.running,
          }),
        );
      }),
    );

    return statuses;
  }

  private buildHarnessStatus(
    definition: AgentHarnessDefinition,
    keys: Awaited<ReturnType<ApiKeyService['findAllByUser']>>,
    portalApps: PortalDeviceApplication[],
  ): AgentHarnessStatus {
    const connectedToMemory = keys.some(
      (key) => key.managed_by === 'connect' && key.name.startsWith(definition.connectKeyPrefix),
    );

    const portalApp = portalApps.find((app) => definition.appNames.includes(app.name));
    const openUrl =
      (portalApp ? resolvePortalOpenUrl(portalApp) : null) ?? fallbackHubAppUrl(definition.appNames[0]);

    // Portal lists the apps this Hub publishes. When it cannot be read, a connect
    // key still says Hub wired the app, so Dispatch does not vanish.
    const installed = portalApp != null || connectedToMemory;
    const readiness = resolveReadiness(definition.id, {
      installed,
      connectedToMemory,
      running: false,
    });

    return {
      id: definition.id,
      name: definition.name,
      connectedToMemory,
      installed,
      running: false,
      openUrl,
      accessible: false,
      ...readiness,
    };
  }

  private async probeOpenUrl(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      });

      return response.ok || (response.status >= 300 && response.status < 400);
    } catch (error) {
      this.logger.debug('Agent harness probe failed', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });

      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function firstHubOrigin(): string | null {
  const origins = config.auth.connect.hubOrigins
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of origins) {
    try {
      return new URL(entry).origin;
    } catch {
      // Ignore malformed allowlist entries the same way ConnectService does.
    }
  }

  return null;
}

/**
 * Fleet Hub hostnames are `hub-<box>.…`. The app's public host is the same
 * suffix with the app name, e.g. `hub-core3-bc` → `ci-openclaw-core3-bc`.
 * Used when Portal's device-app list is down (401) but the app is connected.
 */
function fallbackHubAppUrl(appName: string | undefined): string | null {
  if (!appName) {
    return null;
  }

  const origin = firstHubOrigin();

  if (!origin) {
    return null;
  }

  try {
    const url = new URL(origin);

    if (!url.hostname.startsWith('hub-')) {
      return null;
    }

    url.hostname = `${appName}-${url.hostname.slice('hub-'.length)}`;

    return url.origin;
  } catch {
    return null;
  }
}

function buildConnectUrl(appUrn: string): string | null {
  const origin = firstHubOrigin();

  if (!origin) {
    return null;
  }

  return `${origin}/api/memory-connect/start?app=${encodeURIComponent(appUrn)}`;
}

function resolveReadiness(
  id: AgentHarnessId,
  flags: { installed: boolean; connectedToMemory: boolean; running: boolean },
): Pick<AgentHarnessStatus, 'wakeable' | 'dispatchReady' | 'dispatchBlocker' | 'connectUrl'> {
  if (id === 'hermes') {
    return {
      wakeable: false,
      dispatchReady: false,
      dispatchBlocker: 'chat_only',
      connectUrl: buildConnectUrl(HERMES_APP_URN),
    };
  }

  let dispatchBlocker: DispatchBlocker = null;

  if (!flags.installed) {
    dispatchBlocker = 'not_installed';
  } else if (!flags.connectedToMemory) {
    dispatchBlocker = 'not_connected';
  } else if (!flags.running) {
    dispatchBlocker = 'not_running';
  } else if (doorbellBlocker() != null) {
    // Last of the specific reasons, deliberately. If OpenClaw is not even
    // installed, "this appliance cannot ring Hub" is a true statement and a
    // red herring — the actionable answer is the one about the app. Only once
    // the harness itself is ready does the appliance's own configuration
    // become the thing standing in the way.
    dispatchBlocker = 'doorbell_unconfigured';
  }

  const wakeable = flags.installed && flags.running;

  if (dispatchBlocker == null && !wakeable) {
    dispatchBlocker = 'not_wakeable';
  }

  return {
    wakeable,
    dispatchReady: dispatchBlocker == null,
    dispatchBlocker,
    connectUrl: buildConnectUrl(OPENCLAW_APP_URN),
  };
}

function resolvePortalOpenUrl(app: PortalDeviceApplication): string | null {
  const fromPortal = app.openUrl?.trim();

  if (fromPortal) {
    return fromPortal.replace(/\/$/, '');
  }

  return buildLegacyPortalOpenUrl(app);
}

/** Fallback for Portals predating the `openUrl` field on device applications. */
function buildLegacyPortalOpenUrl(app: PortalDeviceApplication): string | null {
  const domain = app.publicDomain?.trim();

  if (!domain) {
    return null;
  }

  if (domain.startsWith('http://') || domain.startsWith('https://')) {
    return domain.replace(/\/$/, '');
  }

  return `https://${domain.replace(/\/$/, '')}`;
}
