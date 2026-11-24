import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ServiceUnavailableException } from '@nestjs/common';

import config from '@ci/configuration';

import {
  DESKTOP_APP_CLOSED_CODE,
  DESKTOP_APP_CLOSED_MESSAGE,
  DesktopAppService,
  PRESENCE_STALE_AFTER_MS,
  readDesktopAppPresence,
} from '../DesktopAppService';

const NOW_MS = Date.UTC(2026, 10, 15, 12, 0, 0);
const nowSeconds = (offsetMs = 0) => Math.floor((NOW_MS + offsetMs) / 1000);

describe('DesktopAppService', () => {
  let dir: string;
  let file: string;
  const originalFile = config.desktopApp.presenceFile;

  /** What the desktop app writes (frontend/apps/desktop/src-tauri/src/presence.rs). */
  function writePresence(running: boolean, updatedAt: number) {
    writeFileSync(file, `${JSON.stringify({ running, updatedAt })}\n`);
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'desktop-app-'));
    file = path.join(dir, 'presence.json');
  });

  afterEach(() => {
    config.desktopApp.presenceFile = originalFile;
    rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  describe('readDesktopAppPresence', () => {
    it('reads a fresh beat as running', async () => {
      writePresence(true, nowSeconds(-5_000));

      await expect(readDesktopAppPresence(file, NOW_MS)).resolves.toBe('running');
    });

    it('reads Quit as closed at once', async () => {
      writePresence(false, nowSeconds());

      await expect(readDesktopAppPresence(file, NOW_MS)).resolves.toBe('closed');
    });

    // A crash, a kill, logging out and macOS's Cmd+Q never reach the tray's Quit, and a reboot brings the
    // containers back without the app. All of them leave "running" with a timestamp that stopped moving.
    it('reads a beat older than three missed beats as closed', async () => {
      writePresence(true, nowSeconds(-PRESENCE_STALE_AFTER_MS - 1_000));

      await expect(readDesktopAppPresence(file, NOW_MS)).resolves.toBe('closed');
    });

    it('claims nothing without a file it can read', async () => {
      await expect(readDesktopAppPresence(file, NOW_MS)).resolves.toBe('unknown');

      writeFileSync(file, '{"running":tr');
      await expect(readDesktopAppPresence(file, NOW_MS)).resolves.toBe('unknown');

      writeFileSync(file, '{"running":"yes"}');
      await expect(readDesktopAppPresence(file, NOW_MS)).resolves.toBe('unknown');
    });
  });

  describe('isClosed', () => {
    function build(reachable: boolean) {
      const ollama = { checkChatModel: jest.fn(async () => ({ reachable })) };

      return { service: new DesktopAppService(ollama as never), ollama };
    }

    it('is off where no presence file is configured, without asking the model', async () => {
      config.desktopApp.presenceFile = '';
      const { service, ollama } = build(false);

      await expect(service.isClosed()).resolves.toBe(false);
      expect(ollama.checkChatModel).not.toHaveBeenCalled();
    });

    it('is true when the app is closed and the model does not answer', async () => {
      config.desktopApp.presenceFile = file;
      writePresence(false, nowSeconds());
      const { service } = build(false);

      await expect(service.isClosed()).resolves.toBe(true);
    });

    // The app closed but the person's own Ollama still serves the stack: chat works, nothing to say.
    it('is false when the app is closed but the model still answers', async () => {
      config.desktopApp.presenceFile = file;
      writePresence(false, nowSeconds());
      const { service } = build(true);

      await expect(service.isClosed()).resolves.toBe(false);
    });

    // A model that is down while the app runs is a different problem, and "open Memory Desktop" would not fix it.
    it('is false while the app runs, without asking the model', async () => {
      config.desktopApp.presenceFile = file;
      writePresence(true, Math.floor(Date.now() / 1000));
      const { service, ollama } = build(false);

      await expect(service.isClosed()).resolves.toBe(false);
      expect(ollama.checkChatModel).not.toHaveBeenCalled();
    });

    it('reuses one answer for a few seconds, then reads the file again', async () => {
      const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
      config.desktopApp.presenceFile = file;
      writePresence(false, nowSeconds());
      const { service } = build(false);

      await expect(service.isClosed()).resolves.toBe(true);

      // Opened again.
      writePresence(true, nowSeconds());
      await expect(service.isClosed()).resolves.toBe(true);

      clock.mockReturnValue(NOW_MS + 6_000);
      await expect(service.isClosed()).resolves.toBe(false);
    });
  });

  describe('rethrow', () => {
    it('answers a failed model call with the plain 503 while the app is closed', async () => {
      config.desktopApp.presenceFile = file;
      writePresence(false, nowSeconds());
      const service = new DesktopAppService({ checkChatModel: async () => ({ reachable: false }) } as never);

      const thrown = await service.rethrow(new TypeError('fetch failed')).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(ServiceUnavailableException);
      expect((thrown as ServiceUnavailableException).getResponse()).toEqual({
        statusCode: 503,
        error: 'Service Unavailable',
        message: DESKTOP_APP_CLOSED_MESSAGE,
        code: DESKTOP_APP_CLOSED_CODE,
      });
    });

    it('passes the error on unchanged otherwise', async () => {
      config.desktopApp.presenceFile = '';
      const service = new DesktopAppService({ checkChatModel: async () => ({ reachable: false }) } as never);
      const error = new TypeError('fetch failed');

      await expect(service.rethrow(error)).rejects.toBe(error);
    });
  });
});
