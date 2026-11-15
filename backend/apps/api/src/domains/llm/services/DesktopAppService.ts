import { readFile } from 'node:fs/promises';

import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import config from '@ci/configuration';

import { OllamaService } from './OllamaService';

export const DESKTOP_APP_CLOSED_CODE = 'DESKTOP_APP_CLOSED';

/**
 * What a person or an agent is told when Memory Desktop is closed and its model with it. Said the same way
 * by `GET /api/llm/desktop-app`, a refused model route and a failed MCP tool call, and written for someone
 * who may be on another computer than the app.
 */
export const DESKTOP_APP_CLOSED_MESSAGE =
  'Memory Desktop is closed, so chat, search and summaries are off. Open Memory Desktop on the computer it is installed on to bring them back.';

/** The body of the 503 a model route answers with while the app is closed. */
export const DESKTOP_APP_CLOSED_BODY = {
  statusCode: 503,
  error: 'Service Unavailable',
  message: DESKTOP_APP_CLOSED_MESSAGE,
  code: DESKTOP_APP_CLOSED_CODE,
} as const;

/**
 * How old the app's last beat may be before the app counts as gone. It beats every 10s
 * (frontend/apps/desktop/src-tauri/src/presence.rs), so this is three missed beats.
 */
export const PRESENCE_STALE_AFTER_MS = 30_000;

/** How long one answer is reused. Every signed-in page polls it. */
const STATUS_TTL_MS = 5_000;

/** Short on purpose: a closed app leaves nothing listening, which refuses at once. */
const MODEL_PROBE_TIMEOUT_MS = 1_500;

export type DesktopAppPresence = 'running' | 'closed' | 'unknown';

/**
 * What the desktop app's presence file says. `unknown` when there is no file to read or it does not parse:
 * nothing is claimed about an app that never wrote one. A beat older than {@link PRESENCE_STALE_AFTER_MS}
 * reads as closed, which covers every way out that skips the tray's Quit (a crash, a kill, logging out,
 * macOS's Cmd+Q) and a reboot that brings the containers back without the app.
 */
export async function readDesktopAppPresence(file: string, nowMs: number): Promise<DesktopAppPresence> {
  let body: unknown;

  try {
    body = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return 'unknown';
  }

  const { running, updatedAt } = (body ?? {}) as { running?: unknown; updatedAt?: unknown };

  if (typeof running !== 'boolean' || typeof updatedAt !== 'number') {
    return 'unknown';
  }

  if (!running) {
    return 'closed';
  }

  return nowMs - updatedAt * 1000 > PRESENCE_STALE_AFTER_MS ? 'closed' : 'running';
}

/**
 * Whether Memory Desktop being closed is why the model features do not work.
 *
 * The containers of a desktop install outlive the app, and when the app was what served their model (its
 * own Ollama, the relay in front of one, the Apple bridge), chat, search and summaries stop with it while
 * the rest of Memory goes on answering in a browser and to agents. Until this, all anyone was told was
 * that the model could not be reached.
 */
@Injectable()
export class DesktopAppService {
  private cached?: { at: number; closed: boolean };

  private inFlight?: Promise<boolean>;

  constructor(private readonly ollama: OllamaService) {}

  /** This is a Memory Desktop install: its compose overlay configures the presence file. */
  isDesktop(): boolean {
    return config.desktopApp.presenceFile !== '';
  }

  /**
   * True when this is a Memory Desktop install, the app is not running AND the model does not answer.
   *
   * Both halves, because each alone says the wrong thing. With the app closed and the person's own Ollama
   * still serving, chat works and there is nothing to say. With the model down while the app runs, the app
   * is not the reason. Always false off Desktop, where no presence file is configured.
   */
  async isClosed(): Promise<boolean> {
    const file = config.desktopApp.presenceFile;

    if (!this.isDesktop()) {
      return false;
    }

    if (this.cached && Date.now() - this.cached.at < STATUS_TTL_MS) {
      return this.cached.closed;
    }

    this.inFlight ??= this.check(file).finally(() => {
      this.inFlight = undefined;
    });

    return this.inFlight;
  }

  /**
   * For a model route that just failed: rethrows `error`, or, when the app being closed is the reason, the
   * 503 that says so in plain words.
   */
  async rethrow(error: unknown): Promise<never> {
    if (await this.isClosed().catch(() => false)) {
      throw new ServiceUnavailableException(DESKTOP_APP_CLOSED_BODY);
    }

    throw error;
  }

  private async check(file: string): Promise<boolean> {
    const presence = await readDesktopAppPresence(file, Date.now());
    const closed =
      presence === 'closed' && !(await this.ollama.checkChatModel(MODEL_PROBE_TIMEOUT_MS)).reachable;

    this.cached = { at: Date.now(), closed };

    return closed;
  }
}
