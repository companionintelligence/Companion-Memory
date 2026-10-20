import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localHubPlugin } from '@ci/common/src/utils/localHub';
import { SECURE_STORE_KEYS } from '@ci/common/src/utils/nativeBridge';
import { speechPlugin } from '@ci/common/src/utils/speech';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalHubWeb } from '../../../../packages/capacitor-local-hub/src/web';
import { LOCAL_LLM_MODELS } from '../../../../packages/capacitor-local-llm/src/definitions';
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
  /**
   * Declared methods with no Android half on purpose. Each needs a JS wrapper that never
   * calls it off iOS, or the call rejects on Android as unimplemented.
   */
  iosOnly?: readonly string[];
}

const PLUGINS: PluginUnderTest[] = [
  {
    pkg: 'capacitor-local-hub',
    interfaceName: 'LocalHubPlugin',
    androidPlugin: 'android/src/main/java/com/companionintelligence/localhub/LocalHubPlugin.kt',
    iosPlugin: 'ios/Sources/LocalHubPlugin/LocalHubPlugin.swift',
    anchorMethod: 'secureGet',
    // `startSignificantLocationUpdates` / `stopSignificantLocationUpdates` are on both
    // halves: significant-change monitoring on iOS, the plugin's own location foreground
    // service on Android (location/).
  },
  {
    pkg: 'capacitor-local-llm',
    interfaceName: 'LocalLlmPlugin',
    androidPlugin: 'android/src/main/java/com/companionintelligence/localllm/LocalLlmPlugin.kt',
    // The PACKAGE is Android-only (no `ios/`, not in the Podfile). iOS ships the same JS contract as
    // an in-app Swift plugin instead, which the dedicated `LocalLLM — the iOS half` block below checks
    // against the same `definitions.ts`. If the Swift half ever moves into this package, this null
    // (and the "no ios/ directory" assertion above) must change with it.
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
  {
    pkg: 'capacitor-app-lock',
    interfaceName: 'AppLockPlugin',
    androidPlugin: 'android/src/main/java/com/companionintelligence/applock/AppLockPlugin.kt',
    iosPlugin: 'ios/Sources/AppLockPlugin/AppLockPlugin.swift',
    anchorMethod: 'unlock',
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
    const iosOnly = plugin.iosOnly ?? [];
    const required = declared.filter(
      (m) => !BRIDGE_PROVIDED.includes(m) && !ANDROID_BASE_PROVIDED.includes(m) && !iosOnly.includes(m),
    );

    // Same anchor, for the Kotlin parser this time.
    expect(exposed).toContain(plugin.anchorMethod);
    expect(required.filter((m) => !exposed.includes(m))).toEqual([]);

    // A stale iOS-only entry (renamed, or given an Android half since) must not hide a method.
    for (const method of iosOnly) {
      expect(declared).toContain(method);
      expect(exposed).not.toContain(method);
    }
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

describe('LocalLLM — the in-app iOS half and the native catalogs', () => {
  const IOS_LLM_DIR = join(ROOT, 'frontend/apps/ios/ios/App/App/LocalLLM');
  const KOTLIN_MODELS = join(
    PACKAGES,
    'capacitor-local-llm/android/src/main/java/com/companionintelligence/localllm/LocalLlmModels.kt',
  );

  const declared = declaredMethods('capacitor-local-llm', 'LocalLlmPlugin');

  it('iOS registers under the same bridge name as registerPlugin(…)', () => {
    const swift = read(join(IOS_LLM_DIR, 'LocalLLMPlugin.swift'));

    expect(/\bjsName\s*=\s*"([^"]+)"/.exec(swift)?.[1]).toBe(registeredName('capacitor-local-llm'));
  });

  it('iOS lists every declared method in pluginMethods — an unlisted @objc func is unreachable from JS', () => {
    const listed = swiftPluginMethods(read(join(IOS_LLM_DIR, 'LocalLLMPlugin.swift')));
    const required = declared.filter((m) => !BRIDGE_PROVIDED.includes(m));

    // The methods this change added must be in both halves — name them so a regression reads clearly.
    for (const method of ['cancelDownload', 'getLoadedModel', 'resetConversation']) {
      expect(declared).toContain(method);
      expect(listed).toContain(method);
    }

    expect(required.filter((m) => !listed.includes(m))).toEqual([]);
  });

  /** `field: "value"` / `field = "value"` → the value, within one model block. */
  const stringField = (block: string, field: string) =>
    new RegExp(`\\b${field}\\s*[:=]\\s*"([^"]*)"`).exec(block)?.[1];

  /** `field: 4_294_967_296` / `field = 4_294_967_296L` → the number. */
  const numberField = (block: string, field: string) => {
    const match = new RegExp(`\\b${field}\\s*[:=]\\s*([\\d_]+)L?`).exec(block)?.[1];

    return match === undefined ? undefined : Number(match.replace(/_/g, ''));
  };

  /** Split a native catalog into one text block per `modelId`, so each field is read from its own model. */
  const modelBlocks = (source: string) => {
    const starts = [...source.matchAll(/\bmodelId\s*[:=]\s*"([^"]+)"/g)];

    return starts.map((match, i) => ({
      modelId: match[1],
      block: source.slice(match.index, starts[i + 1]?.index ?? source.length),
    }));
  };

  const expectedFor = (platform: 'android' | 'ios') =>
    Object.values(LOCAL_LLM_MODELS)
      .filter((model) => (model.platforms as readonly string[]).includes(platform))
      .map((model) => model.modelId);

  it.each([
    ['Kotlin', KOTLIN_MODELS, 'android' as const],
    ['Swift', join(IOS_LLM_DIR, 'LocalLLMModels.swift'), 'ios' as const],
  ])(
    'the %s catalog carries exactly the models its platform ships, with matching id, size, commit and RAM floor',
    (_label, file, platform) => {
      const blocks = modelBlocks(read(file));

      // Vacuity guard: a regex that matched nothing would make every comparison below pass on empty sets.
      // (iOS legitimately ships nothing since 2026-10-13, so the guard applies where something is expected.)
      if (expectedFor(platform).length > 0) {
        expect(blocks.length).toBeGreaterThan(0);
      }

      expect(blocks.map((b) => b.modelId).sort()).toEqual(expectedFor(platform).sort());

      for (const { modelId, block } of blocks) {
        const spec = LOCAL_LLM_MODELS[modelId as keyof typeof LOCAL_LLM_MODELS];

        expect(numberField(block, 'sizeBytes'), `${modelId} sizeBytes`).toBe(spec.sizeBytes);
        expect(stringField(block, 'commitHash'), `${modelId} commitHash`).toBe(spec.commitHash);
        expect(numberField(block, 'minDeviceMemoryBytes'), `${modelId} minDeviceMemoryBytes`).toBe(
          spec.minDeviceMemoryBytes,
        );
        expect(numberField(block, 'gpuMinDeviceMemoryBytes'), `${modelId} gpuMinDeviceMemoryBytes`).toBe(
          spec.gpuMinDeviceMemoryBytes,
        );

        // The file name is the last path segment of the pinned URL — the one the download is written to.
        const fileName = spec.url.split('/').pop()?.split('?')[0];

        expect(stringField(block, 'fileName'), `${modelId} fileName`).toBe(fileName);
      }
    },
  );

  it('iOS pins each download to the same URL the JS catalog offers', () => {
    const swift = read(join(IOS_LLM_DIR, 'LocalLLMModels.swift'));

    for (const { modelId, block } of modelBlocks(swift)) {
      const url = /string:\s*"([^"]+)"/.exec(block)?.[1];

      expect(url, `${modelId} url`).toBe(LOCAL_LLM_MODELS[modelId as keyof typeof LOCAL_LLM_MODELS].url);
    }
  });
});

/**
 * The iOS half of `LocalLLM` lives in the app target, not in an npm package, so the `packageClassList` that `cap sync`
 * regenerates into `capacitor.config.json` never names it (`@capacitor/cli` `util/iosplugin.js` only reads the `ios/`
 * sources of installed packages), and Capacitor 7 dropped the runtime scan that used to find such classes. The one thing
 * that puts it on the bridge is `MainViewController`'s `registerPluginInstance(_:)`, and that needs three separate
 * pieces to stay joined — the class, the storyboard that instantiates it, and the Xcode project that compiles it. Drop
 * any one and the app still builds and launches; Settings → On-device model just reads "On-device models run in the iOS
 * and Android apps." on a phone (what the 2026-10-02 iOS Simulator QA found). None of them is generated, so `cap sync`
 * cannot undo them.
 */
describe('LocalLLM — the iOS app registers its in-app plugin with the Capacitor bridge', () => {
  const IOS_APP = join(ROOT, 'frontend/apps/ios/ios/App');
  const APP_SOURCES = join(IOS_APP, 'App');
  const pbxproj = () => read(join(IOS_APP, 'App.xcodeproj/project.pbxproj'));

  /** The `customClass` / `customModule` the storyboard gives its initial view controller. */
  function storyboardRoot(): { customClass?: string; customModule?: string } {
    const storyboard = read(join(APP_SOURCES, 'Base.lproj/Main.storyboard'));
    const initialId = /\binitialViewController="([^"]+)"/.exec(storyboard)?.[1];

    expect(initialId, 'Main.storyboard names an initialViewController').toBeTruthy();

    const tag = new RegExp(`<viewController\\b[^>]*\\bid="${initialId}"[^>]*>`).exec(storyboard)?.[0] ?? '';

    return {
      customClass: /\bcustomClass="([^"]+)"/.exec(tag)?.[1],
      customModule: /\bcustomModule="([^"]+)"/.exec(tag)?.[1],
    };
  }

  /** The Swift file, directly under `App/App`, declaring `class <name>: CAPBridgeViewController`. */
  function rootControllerSource(name: string): { file: string; source: string } {
    const declaration = new RegExp(`\\bclass\\s+${name}\\s*:\\s*CAPBridgeViewController\\b`);

    for (const file of readdirSync(APP_SOURCES).filter((entry) => entry.endsWith('.swift'))) {
      const source = read(join(APP_SOURCES, file));

      if (declaration.test(source)) {
        return { file, source };
      }
    }

    throw new Error(
      `no Swift file under frontend/apps/ios/ios/App/App declares ${name}: CAPBridgeViewController`,
    );
  }

  it('the storyboard root is an in-app CAPBridgeViewController subclass — the stock class has no registration hook', () => {
    const { customClass, customModule } = storyboardRoot();

    expect(customClass).toBeTruthy();
    // The stock class cannot register an in-app plugin; only a subclass's `capacitorDidLoad()` can.
    expect(customClass).not.toBe('CAPBridgeViewController');
    // The app module, resolved from the target — not Capacitor's, where no such subclass exists.
    expect(customModule).toBe('App');
  });

  it('that class registers LocalLLMPlugin by instance from capacitorDidLoad() — registerPluginType is a no-op here', () => {
    const { customClass } = storyboardRoot();
    const { source } = rootControllerSource(customClass ?? '');
    const hook = /override\s+func\s+capacitorDidLoad\(\)\s*\{([\s\S]*?)\n\s*\}/.exec(source)?.[1] ?? '';

    expect(hook).toContain('registerPluginInstance(LocalLLMPlugin())');
    // With the default `autoRegisterPlugins` Capacitor 7's `registerPluginType` returns at once, so it would compile,
    // run and register nothing.
    expect(hook).not.toContain('registerPluginType');
  });

  it('SceneDelegate still takes its window from that storyboard, so the subclass is what actually runs', () => {
    const scene = read(join(APP_SOURCES, 'SceneDelegate.swift'));

    expect(scene).toContain('UIStoryboard(name: "Main", bundle: nil)');
    expect(scene).toContain('instantiateInitialViewController()');
  });

  it('the Xcode project compiles that file into the same target as the plugin it registers', () => {
    const { customClass } = storyboardRoot();
    const { file } = rootControllerSource(customClass ?? '');
    const project = pbxproj();

    /** `<buildFileId>` of `<name> in Sources` and the `PBXFileReference` it points at. */
    const buildFile = (name: string) => {
      const match = new RegExp(
        `([0-9A-F]{24}) /\\* ${name.replace('.', '\\.')} in Sources \\*/ = \\{isa = PBXBuildFile; fileRef = ([0-9A-F]{24})`,
      ).exec(project);

      expect(match, `${name} has a "in Sources" PBXBuildFile entry in project.pbxproj`).toBeTruthy();

      return { id: match![1], fileRef: match![2] };
    };

    /** The `files = ( … )` list of the PBXSourcesBuildPhase that compiles `buildFileId`. */
    const sourcesPhaseOf = (buildFileId: string) =>
      [...project.matchAll(/isa = PBXSourcesBuildPhase;[\s\S]*?files = \(([\s\S]*?)\);/g)]
        .map((match) => match[1])
        .find((files) => files.includes(buildFileId));

    const controller = buildFile(file);
    const plugin = buildFile('LocalLLMPlugin.swift');

    expect(project).toMatch(
      new RegExp(`${controller.fileRef} /\\* ${file.replace('.', '\\.')} \\*/ = \\{isa = PBXFileReference;`),
    );
    // A file reference with no build phase entry compiles nowhere: the storyboard would then name a class that does not
    // exist in the binary, and UIKit falls back to a blank plain view controller.
    expect(sourcesPhaseOf(controller.id), `${file} is in a Sources build phase`).toBeDefined();
    expect(sourcesPhaseOf(controller.id)).toBe(sourcesPhaseOf(plugin.id));
  });
});

/**
 * The intent catalog is the one URL the phone and the appliance must agree on, and nothing links them: the proxy strips
 * a leading `/api`, Nest mounts controllers at literal paths, and the Swift and Kotlin clients each hard-code a string.
 * Both clients asked for `/api/api/intents` — right while `IntentsController` baked its own `api/` into its mount, a 404
 * from the day #2653 unbaked it — so every on-device model quietly ran with no tools (the 2026-10-02 iOS QA). The server's
 * own `controllerGatewayPrefix.test.ts` cannot see the clients; this reads both sides.
 */
describe('LocalLLM — the native clients reach the appliance at paths its controllers actually mount', () => {
  const BACKEND_CONTROLLERS = join(ROOT, 'backend/apps/api/src/domains');
  const IOS_CLIENT = join(ROOT, 'frontend/apps/ios/ios/App/App/LocalLLM/CompanionIntentClient.swift');
  const ANDROID_CLIENT = join(
    PACKAGES,
    'capacitor-local-llm/android/src/main/java/com/companionintelligence/localllm/intents/CompanionIntentClient.kt',
  );

  /** What a controller's `@Controller(…)` mounts, reached through the proxy: it strips `/api`, Nest sets no prefix. */
  function publicPaths(controllerFile: string): string[] {
    const decorator = /^@Controller\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")\s*\)/m.exec(
      read(join(BACKEND_CONTROLLERS, controllerFile)),
    );

    expect(decorator, `${controllerFile} has an @Controller(…) decorator`).toBeTruthy();

    return (decorator![1].match(/['"]([^'"]*)['"]/g) ?? []).map((quoted) => `/api/${quoted.slice(1, -1)}`);
  }

  const catalogPaths = publicPaths('agent/controllers/IntentsController.ts');
  const mcpPaths = publicPaths('mcp/controllers/McpController.ts');

  it('the server really does mount the catalog at the bare `intents` and MCP at `mcp` (a baked-in api/ would break both)', () => {
    expect(catalogPaths).toContain('/api/intents');
    expect(mcpPaths).toEqual(['/api/mcp']);
  });

  it.each([
    [
      'Swift',
      () => {
        const source = read(IOS_CLIENT);
        const catalog = /authorized\(path:\s*"([^"]+)",\s*query:\s*"tier=local"\)/.exec(source)?.[1];
        const calls = [...source.matchAll(/authorized\(path:\s*"([^"?]+)"\s*\)/g)].map((m) => m[1]);

        return { catalog, calls };
      },
    ],
    [
      'Kotlin',
      () => {
        const source = read(ANDROID_CLIENT);
        const catalog = /\bget\("([^"?]+)\?tier=local"\)/.exec(source)?.[1];
        const calls = [...source.matchAll(/\bopenConnection\("([^"?]+)"\)/g)].map((m) => m[1]);

        return { catalog, calls };
      },
    ],
  ])(
    'the %s client asks for the catalog and MCP at the proxy URLs of the controllers that serve them',
    (_label, parse) => {
      const { catalog, calls } = parse();

      expect(catalog, 'the client fetches the catalog with ?tier=local').toBeTruthy();
      expect(catalogPaths).toContain(catalog);
      // Vacuity guard: the handshake and `tools/call` are both POSTs to the one MCP path.
      expect(calls.length).toBeGreaterThanOrEqual(2);

      for (const call of calls) {
        expect(mcpPaths).toContain(call);
      }
    },
  );
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

/**
 * The LocalHub credential store takes writes from anything that reaches the bridge. On
 * Android that is every frame in the WebView (the app runs Capacitor's legacy bridge for
 * background location), so `secureSet` accepts only the app's own keys, on both platforms.
 */
describe('LocalHub secureSet — only the keys the app itself writes', () => {
  const hubDir = join(PACKAGES, 'capacitor-local-hub');
  const kotlin = read(
    join(hubDir, 'android/src/main/java/com/companionintelligence/localhub/LocalHubPlugin.kt'),
  );
  const swift = read(join(hubDir, 'ios/Sources/LocalHubPlugin/LocalHubPlugin.swift'));
  const quoted = (block: string | undefined) =>
    [...(block ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const between = (source: string, from: string, to: string) =>
    source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

  it('Android, iOS and @ci/common list the same keys', () => {
    const android = quoted(/WRITABLE_SECURE_KEYS = setOf\(([^)]*)\)/.exec(kotlin)?.[1]);
    const ios = quoted(/writableSecureKeys: Set<String> = \[([^\]]*)\]/.exec(swift)?.[1]);

    expect(android).toEqual([...SECURE_STORE_KEYS].sort());
    expect(ios).toEqual([...SECURE_STORE_KEYS].sort());
  });

  it('every credential useAuth stores is on the list, and so is the mirrored origin', () => {
    const useAuth = read(join(ROOT, 'frontend/apps/web/src/hooks/useAuth.ts'));
    const stored = [...useAuth.matchAll(/const API_KEY\w*_STORAGE = '([^']+)'/g)].map((m) => m[1]);

    expect(stored.length).toBeGreaterThanOrEqual(3);
    expect(SECURE_STORE_KEYS).toEqual(expect.arrayContaining([...stored, 'ci.apiBaseUrl']));
  });

  it('both plugins refuse a key off the list before anything is written', () => {
    const android = between(kotlin, 'fun secureSet(', 'fun secureRemove(');
    const ios = between(swift, 'func secureSet(', 'func secureRemove(');

    expect(android.indexOf('!in WRITABLE_SECURE_KEYS')).toBeGreaterThan(-1);
    expect(android.indexOf('!in WRITABLE_SECURE_KEYS')).toBeLessThan(android.indexOf('credentialStore.set('));
    expect(ios.indexOf('writableSecureKeys.contains(key)')).toBeGreaterThan(-1);
    expect(ios.indexOf('writableSecureKeys.contains(key)')).toBeLessThan(ios.indexOf('secureStore.set('));
  });
});

/**
 * The outbox `owner` stamp and the sign-out clear exist on both platforms: the web flusher
 * depends on the sidecar storing and returning `owner`, and sign-out on `DELETE /api/outbox`.
 * Neither native half can be built or run here, so the source is what is checked.
 */
describe('LocalHub outbox — owner stamp and sign-out clear on both platforms', () => {
  const hubDir = join(PACKAGES, 'capacitor-local-hub');
  const androidDir = join(hubDir, 'android/src/main/java/com/companionintelligence/localhub');
  const iosDir = join(hubDir, 'ios/Sources/LocalHubPlugin');

  it('Android adds the column for new and upgraded databases, and keeps the plaintext import on v1 columns', () => {
    const store = read(join(androidDir, 'OutboxStore.kt'));

    expect(store).toMatch(/\$COLUMN_LAST_ERROR TEXT,\s*\$COLUMN_OWNER TEXT/);
    expect(store).toContain('ALTER TABLE $TABLE_NAME ADD COLUMN $COLUMN_OWNER TEXT');
    expect(store).toContain('DATABASE_VERSION = 2');
    expect(between(store, 'MIGRATION_COLUMNS = arrayOf(', ')')).not.toContain('COLUMN_OWNER');
  });

  it('iOS adds the column for new tables and for ones created before it', () => {
    const store = read(join(iosDir, 'OutboxStore.swift'));

    expect(store).toMatch(/last_error TEXT,\s*owner TEXT/);
    expect(store).toContain('ALTER TABLE outbox ADD COLUMN owner TEXT;');
  });

  it('both servers take owner on enqueue, return it on items, and clear the collection on DELETE', () => {
    const android = read(join(androidDir, 'LocalHubServer.kt'));
    const ios = read(join(iosDir, 'LocalHubServer.swift'));

    expect(android).toContain('outbox.enqueue(kind, payload.toString(), capturedAt, idempotencyKey, owner)');
    expect(android).toContain('.put("owner", item.owner ?: JSONObject.NULL)');
    expect(android).toContain('segments.isEmpty() && method == Method.DELETE -> handleClear()');
    expect(ios).toMatch(/idempotencyKey: idempotencyKey,\s*owner: owner/);
    expect(ios).toContain('"owner": item.owner ?? NSNull()');
    expect(ios).toMatch(/case \("DELETE", 0\):[\s\S]{0,120}store\.deleteAll\(\)/);
  });

  it('Android opens a link marked external without the sign-in Auth Tab', () => {
    // Provider pages from the gallery are not a sign-in. In the Auth Tab, any `companion://`
    // they navigated to would come back to the app as a sign-in result.
    const plugin = between(
      read(join(androidDir, 'LocalHubPlugin.kt')),
      'fun openUrl(',
      'fun startAuthSession(',
    );

    expect(plugin).toContain('val external = call.getBoolean("external", false) == true');
    expect(plugin).toContain('if (external || !AuthTabSession.launch(uri)) {');
  });

  function between(source: string, from: string, to: string): string {
    const start = source.indexOf(from);

    return source.slice(start, source.indexOf(to, start + from.length));
  }
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
    await expect(hub.startAuthSession()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(hub.openAppSettings()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('discoverLanAppliances() resolves unsupported on web rather than throwing', async () => {
    await expect(hub.discoverLanAppliances()).resolves.toEqual({
      appliances: [],
      supported: false,
    });
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
    await expect(llm.cancelDownload()).resolves.toBeUndefined();
    // "New chat" calls this unconditionally, whether or not a model is loaded.
    await expect(llm.resetConversation()).resolves.toBeUndefined();
  });

  it('getLoadedModel() reports nothing loaded rather than throwing', async () => {
    await expect(llm.getLoadedModel()).resolves.toEqual({ loaded: false });
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
