import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localHubPlugin } from '@ci/common/src/utils/localHub';
import { speechPlugin } from '@ci/common/src/utils/speech';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalHubWeb } from '../../../../packages/capacitor-local-hub/src/web';
import { LocalLlmWeb } from '../../../../packages/capacitor-local-llm/src/web';
import { SpeechWeb } from '../../../../packages/capacitor-speech/src/web';

/**
 * Guards the three in-repo Capacitor plugins, which nothing else can guard.
 *
 * Two classes of silent breakage live here, both of which typecheck and lint clean:
 *
 * 1. **The plugin's bridge NAME is written out four times** — the `registerPlugin('X')`
 *    string in `src/index.ts`, Android's `@CapacitorPlugin(name = "X")`, iOS's
 *    `jsName = "X"`, and the `Capacitor.Plugins.X` key `@ci/common` actually reads at
 *    runtime. Nothing links them. If one drifts, the JS call finds no implementation and
 *    the returned promise never settles (Android) or rejects at the bridge (iOS) — a hang
 *    or a dead feature on both shells, with every unit test still green because each side
 *    is internally consistent. This is the same failure mode
 *    `nativeAppConfig.node.test.ts` guards for the OIDC deep-link scheme.
 *
 * 2. **Per-method drift.** A method declared in `definitions.ts` but missing from the
 *    Kotlin `@PluginMethod` set, or missing from iOS's `pluginMethods` array (which
 *    `CAPBridgedPlugin` requires — Capacitor 7 dropped the ObjC-runtime scan, so an
 *    `@objc func` that is not listed is unreachable), is invisible to TypeScript: the
 *    interface only describes the JS side.
 *
 * These parse the real files from disk, so they fail the moment the contract drifts.
 *
 * The web-fallback half below exercises `src/web.ts`, which is not dead code: it runs in
 * a plain browser tab, in Storybook, and inside the desktop Tauri window, where there is
 * no Capacitor bridge at all.
 */

// Walk up from this file to the repo root (the directory holding both workspaces).
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'frontend')) && existsSync(join(dir, 'backend'))) {
      return dir;
    }

    dir = resolve(dir, '..');
  }

  throw new Error('repo root not found');
}

const ROOT = repoRoot();
const PACKAGES = join(ROOT, 'frontend/packages');

const read = (absolute: string) => readFileSync(absolute, 'utf8');

/**
 * Methods the plugin class never declares itself:
 * - `addListener` / `removeAllListeners` are implemented by the Capacitor bridge for
 *   every plugin, on both platforms.
 * - `checkPermissions` / `requestPermissions` are concrete `@PluginMethod`s on Android's
 *   `Plugin` base class, so a subclass that declares `@CapacitorPlugin(permissions = …)`
 *   inherits them. iOS has no such base implementation — `CAPBridgedPlugin` still needs
 *   them listed explicitly — so this exclusion is Android-only.
 */
const BRIDGE_PROVIDED = ['addListener', 'removeAllListeners'];
const ANDROID_BASE_PROVIDED = ['checkPermissions', 'requestPermissions'];

interface PluginUnderTest {
  /** Directory under `frontend/packages`. */
  pkg: string;
  /** The interface in `definitions.ts` the native halves must implement. */
  interfaceName: string;
  /** Path (relative to the package) of the Kotlin plugin class. */
  androidPlugin: string;
  /** Path of the Swift plugin class, or null for a deliberately Android-only plugin. */
  iosPlugin: string | null;
  /**
   * A method that must appear in every one of the three parsed surfaces. Without it the
   * "nothing is missing" assertions below would pass vacuously if a parser silently
   * returned an empty list.
   */
  anchorMethod: string;
}

const PLUGINS: PluginUnderTest[] = [
  {
    pkg: 'capacitor-local-hub',
    interfaceName: 'LocalHubPlugin',
    androidPlugin: 'android/src/main/java/com/companionintelligence/localhub/LocalHubPlugin.kt',
    iosPlugin: 'ios/Sources/LocalHubPlugin/LocalHubPlugin.swift',
    anchorMethod: 'secureGet',
  },
  {
    pkg: 'capacitor-local-llm',
    interfaceName: 'LocalLlmPlugin',
    androidPlugin: 'android/src/main/java/com/companionintelligence/localllm/LocalLlmPlugin.kt',
    // Deliberately Android-only — see the package description. If an iOS half is ever
    // added, this null (and the "no ios/ directory" assertion below) must change with it.
    iosPlugin: null,
    anchorMethod: 'generate',
  },
  {
    pkg: 'capacitor-speech',
    interfaceName: 'SpeechPlugin',
    androidPlugin: 'android/src/main/java/com/companionintelligence/speech/SpeechPlugin.kt',
    iosPlugin: 'ios/Sources/SpeechPlugin/SpeechPlugin.swift',
    anchorMethod: 'startListening',
  },
];

/** The name passed to `registerPlugin<T>('<name>', …)` in a plugin's `src/index.ts`. */
function registeredName(pkg: string): string {
  const source = read(join(PACKAGES, pkg, 'src/index.ts'));
  const match = /registerPlugin<\w+>\(\s*'([^']+)'/.exec(source);

  if (!match) {
    throw new Error(`no registerPlugin(...) call found in ${pkg}/src/index.ts`);
  }

  return match[1];
}

/** Method names declared on `interfaceName` in a plugin's `definitions.ts`. */
function declaredMethods(pkg: string, interfaceName: string): string[] {
  const source = read(join(PACKAGES, pkg, 'src/definitions.ts'));
  const start = source.indexOf(`export interface ${interfaceName} {`);

  if (start < 0) {
    throw new Error(`interface ${interfaceName} not found in ${pkg}/src/definitions.ts`);
  }

  // The interface body ends at the first closing brace in column 0; every nested object
  // type inside it closes at an indented `  })` / `  }`, so this cannot end early.
  const body = source.slice(start, source.indexOf('\n}', start));

  // Two-space indent + an identifier immediately followed by `(` or `<` is a method
  // signature; property signatures are `name: T` and JSDoc lines start with `*`.
  const names = [...body.matchAll(/^ {2}(\w+)[<(]/gm)].map((m) => m[1]);

  // `addListener` is overloaded — dedupe so the count reflects distinct methods.
  return [...new Set(names)];
}

/**
 * Method names the Kotlin plugin exposes to the bridge. Parsed line-wise rather than with
 * one big regex on purpose: these files mention `@PluginMethod` inside KDoc prose too, and
 * a span match would happily pair a comment with whatever `fun` came next.
 */
function kotlinPluginMethods(source: string): string[] {
  const lines = source.split('\n');
  const methods: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*@PluginMethod\b/.test(lines[i])) {
      continue;
    }

    // Skip any further annotations stacked between `@PluginMethod` and the declaration.
    for (let j = i + 1; j < lines.length; j++) {
      const declaration = /^\s*fun\s+(\w+)\s*\(/.exec(lines[j]);

      if (declaration) {
        methods.push(declaration[1]);
        break;
      }

      if (!/^\s*@\w/.test(lines[j])) {
        break;
      }
    }
  }

  return methods;
}

/** Method names listed in a Swift plugin's `pluginMethods` array. */
function swiftPluginMethods(source: string): string[] {
  return [...source.matchAll(/CAPPluginMethod\(name:\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe.each(PLUGINS)('$pkg — JS registration name matches the native halves', (plugin) => {
  const name = registeredName(plugin.pkg);

  it('Android @CapacitorPlugin(name = …) matches registerPlugin(…)', () => {
    const kotlin = read(join(PACKAGES, plugin.pkg, plugin.androidPlugin));
    const annotated = /@CapacitorPlugin\s*\(\s*name\s*=\s*"([^"]+)"/.exec(kotlin);

    expect(annotated?.[1]).toBe(name);
  });

  it('iOS jsName matches registerPlugin(…), and only exists when the package ships iOS', () => {
    const iosDir = join(PACKAGES, plugin.pkg, 'ios');
    const manifest = JSON.parse(read(join(PACKAGES, plugin.pkg, 'package.json'))) as {
      capacitor?: { ios?: { src?: string }; android?: { src?: string } };
    };

    if (!plugin.iosPlugin) {
      // An `ios/` tree that `package.json` does not declare is worse than no iOS support:
      // `cap sync` never copies it, so the app builds and every call hangs on iOS.
      expect(existsSync(iosDir)).toBe(false);
      expect(manifest.capacitor?.ios).toBeUndefined();

      return;
    }

    expect(manifest.capacitor?.ios?.src).toBe('ios');

    const swift = read(join(PACKAGES, plugin.pkg, plugin.iosPlugin));
    const jsName = /\bjsName\s*=\s*"([^"]+)"/.exec(swift);

    expect(jsName?.[1]).toBe(name);
  });

  it('package.json declares the Android source Capacitor must sync', () => {
    const manifest = JSON.parse(read(join(PACKAGES, plugin.pkg, 'package.json'))) as {
      capacitor?: { android?: { src?: string } };
    };

    expect(manifest.capacitor?.android?.src).toBe('android');
  });
});

describe.each(PLUGINS)('$pkg — every declared method exists natively', (plugin) => {
  const declared = declaredMethods(plugin.pkg, plugin.interfaceName);

  it('declares a non-trivial method surface (guards the parser itself)', () => {
    // If the `definitions.ts` parser ever silently returned nothing, the two
    // "nothing is missing" assertions below would both pass vacuously. Anchor it.
    expect(declared.length).toBeGreaterThan(5);
    expect(declared).toContain(plugin.anchorMethod);
  });

  it('Android exposes every method as an @PluginMethod', () => {
    const exposed = kotlinPluginMethods(read(join(PACKAGES, plugin.pkg, plugin.androidPlugin)));
    const required = declared.filter(
      (m) => !BRIDGE_PROVIDED.includes(m) && !ANDROID_BASE_PROVIDED.includes(m),
    );

    // Same anchor, for the Kotlin parser this time.
    expect(exposed).toContain(plugin.anchorMethod);
    expect(required.filter((m) => !exposed.includes(m))).toEqual([]);
  });

  it('iOS lists every method in pluginMethods', () => {
    if (!plugin.iosPlugin) {
      // Not a bare `return`: a test that runs zero assertions still reports
      // green, and this one's name promises iOS parity was checked. Assert the
      // premise instead — @ci/capacitor-local-llm is documented Android-only,
      // so the honest statement is "there is no iOS source to check". Add an
      // `ios/` tree without adding `iosPlugin` to the PLUGINS table above and
      // this fails here rather than silently skipping the parity check that
      // exists to catch a method missing from `pluginMethods`.
      expect(existsSync(join(PACKAGES, plugin.pkg, 'ios'))).toBe(false);

      return;
    }

    // Capacitor 7 dropped the Objective-C runtime scan: `CAPBridgedPlugin.pluginMethods`
    // is the ONLY thing the bridge consults, so an `@objc func` missing from that array
    // is unreachable from JS even though it compiles.
    const listed = swiftPluginMethods(read(join(PACKAGES, plugin.pkg, plugin.iosPlugin)));
    const required = declared.filter((m) => !BRIDGE_PROVIDED.includes(m));

    expect(listed).toContain(plugin.anchorMethod);
    expect(required.filter((m) => !listed.includes(m))).toEqual([]);
  });
});

describe('the bridge key @ci/common reads matches the registered name', () => {
  const originalCapacitor = (window as unknown as { Capacitor?: unknown }).Capacitor;

  afterEach(() => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = originalCapacitor;
  });

  function installPlugins(plugins: Record<string, unknown>): void {
    (window as unknown as { Capacitor?: unknown }).Capacitor = { Plugins: plugins };
  }

  it('localHubPlugin() finds the plugin under the name src/index.ts registers', () => {
    const fake = {};
    installPlugins({ [registeredName('capacitor-local-hub')]: fake });

    // Fails if either side is renamed alone: the real app's only path to the sidecar is
    // this exact key off `Capacitor.Plugins`.
    expect(localHubPlugin()).toBe(fake);
  });

  it('speechPlugin() finds the plugin under the name src/index.ts registers', () => {
    const fake = {};
    installPlugins({ [registeredName('capacitor-speech')]: fake });

    expect(speechPlugin()).toBe(fake);
  });

  it('nativeBridge reads LocalLLM under the name src/index.ts registers', () => {
    // Checked against the source rather than behaviourally: the only consumer,
    // `generateOffline`, falls through to an HTTP call when the plugin is missing, so a
    // behavioural test here would assert on the network fallback, not on the lookup key.
    const nativeBridge = read(join(PACKAGES, 'common/src/utils/nativeBridge.ts'));

    expect(nativeBridge).toContain(`plugins()?.${registeredName('capacitor-local-llm')}`);
  });
});

describe('LocalHubWeb — the fallback that runs in a browser tab and the Tauri window', () => {
  const hub = new LocalHubWeb();

  it('start() rejects as unavailable rather than resolving a fake session', () => {
    // A resolved-but-empty session would send outbox writes at `undefined/api/outbox`.
    return expect(hub.start()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('getStatus() reports not running, and stop() is a safe no-op', async () => {
    await expect(hub.getStatus()).resolves.toEqual({ running: false });
    await expect(hub.stop()).resolves.toBeUndefined();
  });

  it('the secure store refuses rather than silently answering from localStorage', async () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem');
    const getItem = vi.spyOn(window.localStorage, 'getItem');

    await expect(hub.secureGet()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(hub.secureSet()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(hub.secureRemove()).rejects.toMatchObject({ code: 'UNAVAILABLE' });

    // The whole point of the keystore-backed store is that a caller can trust the value
    // was protected. A `localStorage` fallback here would be readable by any script on
    // the origin while still looking like a success to the caller.
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });

  it('location authorization answers "unsupported" instead of throwing', async () => {
    // Callers branch on `status` to decide whether to show the permission prompt; a throw
    // here would surface as an error toast on every web load.
    await expect(hub.getLocationAuthorization()).resolves.toEqual({ status: 'unsupported' });
    await expect(hub.requestLocationAuthorization()).resolves.toEqual({ status: 'unsupported' });
  });

  it('getCurrentLocation() and openUrl() reject as unavailable', async () => {
    await expect(hub.getCurrentLocation()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(hub.openUrl()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(hub.openAppSettings()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('LocalLlmWeb — the fallback generateOffline() checks before going remote', () => {
  const llm = new LocalLlmWeb();

  it('isAvailable() says no, with a reason, so generateOffline() takes the remote path', async () => {
    const availability = await llm.isAvailable();

    expect(availability.available).toBe(false);
    expect(availability.reason).toBeTruthy();
  });

  it('getModelStatus() reports not_downloaded rather than throwing', async () => {
    await expect(llm.getModelStatus()).resolves.toEqual({ status: 'not_downloaded' });
  });

  it('the idempotent teardown/config methods are no-ops, not errors', async () => {
    // Startup calls `configureIntentTools()` unconditionally and teardown calls
    // `unloadModel()` / `cancel()` unconditionally; throwing here would mean every web
    // load had to branch on platform first.
    await expect(llm.configureIntentTools()).resolves.toBeUndefined();
    await expect(llm.unloadModel()).resolves.toBeUndefined();
    await expect(llm.cancel()).resolves.toBeUndefined();
    await expect(llm.deleteModel()).resolves.toBeUndefined();
  });

  it('the methods that need a real engine reject as unavailable', async () => {
    await expect(llm.generate()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(llm.generateStream()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(llm.loadModel()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(llm.downloadModel()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('SpeechWeb — the fallback must never reach the browser speech APIs', () => {
  const speech = new SpeechWeb();

  it('never claims on-device recognition on web', async () => {
    const capability = await speech.getRecognitionCapability();

    // `guaranteedOnDevice` is the flag the UI shows the user; it must not be true on a
    // surface where nothing local is running.
    expect(capability.available).toBe(false);
    expect(capability.guaranteedOnDevice).toBe(false);
    expect(capability.mode).toBe('unavailable');
    expect(capability.tier).toBe('none');
    expect(capability.reason).toBeTruthy();
  });

  it('startListening() rejects without touching the cloud-backed Web Speech API', async () => {
    // Chrome's SpeechRecognition streams microphone audio to Google. Adding it here as a
    // "graceful fallback" is exactly the regression this asserts against: the spy fires
    // the moment anyone constructs one.
    const RecognitionSpy = vi.fn();
    vi.stubGlobal('SpeechRecognition', RecognitionSpy);
    vi.stubGlobal('webkitSpeechRecognition', RecognitionSpy);

    try {
      await expect(speech.startListening()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect(RecognitionSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('speak() rejects without touching window.speechSynthesis', async () => {
    const speakSpy = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak: speakSpy, getVoices: () => [] });

    try {
      await expect(speech.speak()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect(speakSpy).not.toHaveBeenCalled();

      // Same reason: a browser voice list would be reported without any way to say
      // whether those voices are local.
      await expect(speech.getVoices()).resolves.toEqual({ voices: [] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('permissions read denied, so no caller believes it holds the microphone', async () => {
    await expect(speech.checkPermissions()).resolves.toEqual({
      microphone: 'denied',
      speechRecognition: 'denied',
    });
    await expect(speech.requestPermissions()).resolves.toEqual({
      microphone: 'denied',
      speechRecognition: 'denied',
    });
  });

  it('the query/teardown methods answer instead of throwing', async () => {
    await expect(speech.isListening()).resolves.toEqual({ listening: false });
    await expect(speech.isSpeaking()).resolves.toEqual({ speaking: false });
    await expect(speech.stopListening()).resolves.toBeUndefined();
    await expect(speech.cancelListening()).resolves.toBeUndefined();
    await expect(speech.stopSpeaking()).resolves.toBeUndefined();
  });

  it('the language-pack calls report "not started" rather than rejecting', async () => {
    // The settings screen calls these to decide what to offer; a rejection would render
    // as a failed download the user never asked for.
    const download = await speech.downloadRecognitionLanguage();
    expect(download.started).toBe(false);
    expect(download.reason).toBeTruthy();

    const install = await speech.installSynthesisLanguage();
    expect(install.started).toBe(false);
    expect(install.reason).toBeTruthy();

    await expect(speech.getRecognitionLanguages()).resolves.toEqual({
      languages: [],
      enumerable: false,
    });
    await expect(speech.getSynthesisLanguages()).resolves.toEqual({ languages: [] });
  });

  it('getSynthesisCapability() reports no offline voice', async () => {
    const capability = await speech.getSynthesisCapability();

    expect(capability.available).toBe(false);
    expect(capability.offlineVoiceAvailable).toBe(false);
    expect(capability.reason).toBeTruthy();
  });
});
