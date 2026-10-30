import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  CAPACITOR_CONFIGS,
  capacitorZoomProblems,
  collectViewportZoomProblems,
  effectiveCapacitorZoom,
  parseViewport,
  viewportMetas,
  viewportProblems,
} from './check-viewport-zoom.mjs';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const WEB_ENTRY = 'frontend/apps/web/index.html';

const meta = (content: string) => `<meta name="viewport" content="${content}" />`;

test('the committed tree does not block pinch-zoom anywhere', () => {
  assert.deepEqual(collectViewportZoomProblems(ROOT), []);
});

test('the scan is not vacuous: it finds the web app viewport meta and it allows zoom', () => {
  const metas = viewportMetas(readFileSync(join(ROOT, WEB_ENTRY), 'utf8'));

  assert.equal(metas.length, 1);
  assert.equal(parseViewport(metas[0].content).get('width'), 'device-width');
  assert.equal(parseViewport(metas[0].content).has('maximum-scale'), false);
});

test('the viewport meta that shipped, maximum-scale=1.0 on its own line, is flagged with its line', () => {
  const shipped = [
    '<head>',
    '    <meta',
    '      name="viewport"',
    '      content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content"',
    '    />',
    '</head>',
  ].join('\n');
  const problems = viewportProblems(shipped, WEB_ENTRY);

  assert.equal(problems.length, 1);
  assert.match(problems[0], /index\.html:2: .*maximum-scale=1\.0/);
});

test('a viewport meta that blocks or caps zoom is flagged, however it is spelled', () => {
  for (const content of [
    'width=device-width, initial-scale=1, user-scalable=no',
    'width=device-width, initial-scale=1, user-scalable=0',
    'width=device-width, initial-scale=1, USER-SCALABLE = NO',
    'width=device-width; initial-scale=1; maximum-scale=1',
    'width=device-width initial-scale=1 maximum-scale=1.0',
    'width=device-width, maximum-scale=2',
    'width=device-width, maximum-scale=4.9',
    'width=device-width, user-scalable=yes, maximum-scale=1',
    'width=device-width, maximum-scale=',
  ]) {
    assert.ok(viewportProblems(meta(content), 'x.html').length > 0, `expected a problem for: ${content}`);
  }

  // Both settings at once are two problems; attribute order and quote style do not matter.
  assert.equal(viewportProblems(meta('user-scalable=no, maximum-scale=1'), 'x.html').length, 2);
  assert.equal(
    viewportProblems(`<meta content='width=device-width, user-scalable=no' name='viewport'>`, 'x.html')
      .length,
    1,
  );
});

test('a viewport meta that leaves zoom alone passes', () => {
  for (const content of [
    'width=device-width, initial-scale=1',
    'width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content',
    'width=device-width, initial-scale=1, user-scalable=yes',
    'width=device-width, initial-scale=1, user-scalable=1',
    'width=device-width, initial-scale=1, maximum-scale=5',
    'width=device-width, initial-scale=1, maximum-scale=10',
  ]) {
    assert.deepEqual(viewportProblems(meta(content), 'x.html'), [], `expected no problem for: ${content}`);
  }

  // Other <meta> tags, and a viewport that is only mentioned, are not viewport metas.
  assert.deepEqual(
    viewportProblems(
      '<meta name="theme-color" content="user-scalable=no" />\n<!-- the viewport: maximum-scale=1 -->',
      'x.html',
    ),
    [],
  );
});

test('a viewport meta inside a template string is read too', () => {
  const page =
    'export const page = `<head>\n  <meta name="viewport" content="width=device-width, maximum-scale=1" />\n</head>`;';

  assert.match(viewportProblems(page, 'page.ts')[0], /^page\.ts:2: /);
});

const config = (body: string) =>
  `import type { CapacitorConfig } from '@capacitor/cli';\nconst config: CapacitorConfig = {\n${body}\n};\nexport default config;\n`;

test('Capacitor zoom: the shell is flagged unless zoomEnabled is literally true where Capacitor reads it', () => {
  const flagged: Record<string, string> = {
    'no zoomEnabled at all (the state that shipped)': `appId: 'x',\n  server: { androidScheme: 'https' },\n  android: { allowMixedContent: true },`,
    'platform false': `ios: { zoomEnabled: false },\n  android: { zoomEnabled: false },`,
    'platform false beats a top-level true': `zoomEnabled: true,\n  ios: { zoomEnabled: false },\n  android: { zoomEnabled: false },`,
    'only in a comment': `// ios: { zoomEnabled: true },\n  /* android: { zoomEnabled: true }, */\n  ios: {},\n  android: {},`,
    'only in a string': `appId: 'zoomEnabled: true',\n  ios: {},\n  android: {},`,
    'in a plugin, not the shell': `plugins: { SplashScreen: { zoomEnabled: true } },\n  ios: {},\n  android: {},`,
    'in a conditional spread': `...(process.env.ZOOM ? { zoomEnabled: true } : {}),\n  ios: {},\n  android: {},`,
    'in the wrong platform block': `ios: {},\n  android: { zoomEnabled: true },`,
    'not a literal': `ios: { zoomEnabled: ZOOM },\n  android: { zoomEnabled: !!process.env.ZOOM },`,
  };

  for (const [why, body] of Object.entries(flagged)) {
    const wrongPlatformBlock = why === 'in the wrong platform block';
    for (const platform of ['ios', 'android'] as const) {
      if (wrongPlatformBlock && platform === 'android') {
        continue;
      }

      assert.equal(
        capacitorZoomProblems(config(body), platform, 'c.ts').length,
        1,
        `${platform}: expected a problem — ${why}`,
      );
    }
  }
});

test('Capacitor zoom: it passes when the platform block, or the top level, turns zoom on', () => {
  const both = config(
    `appId: 'x',\n  ios: { zoomEnabled: true },\n  android: {\n    allowMixedContent: true,\n    // on purpose\n    zoomEnabled: true,\n  },`,
  );
  const shared = config(`zoomEnabled: true,\n  ios: {},\n  android: { allowMixedContent: true },`);
  const quoted = config(`'ios': { 'zoomEnabled': true },\n  "android": { "zoomEnabled": true },`);
  const platformTrueOverTopFalse = config(
    `zoomEnabled: false,\n  ios: { zoomEnabled: true },\n  android: { zoomEnabled: true },`,
  );

  for (const source of [both, shared, quoted, platformTrueOverTopFalse]) {
    for (const platform of ['ios', 'android'] as const) {
      assert.deepEqual(capacitorZoomProblems(source, platform, 'c.ts'), []);
    }
  }

  assert.equal(effectiveCapacitorZoom(config('ios: { zoomEnabled: true },'), 'android'), false);
});

test('Capacitor zoom: the text reading of each shell config agrees with the config it evaluates to', async () => {
  for (const [platform, path] of Object.entries(CAPACITOR_CONFIGS)) {
    const loaded = (await import(pathToFileURL(join(ROOT, path)).href)).default;
    const evaluated = loaded?.default ?? loaded; // tsx hands a TS config back either way
    // Capacitor's own resolution (CAPInstanceDescriptor.swift, CapConfig.java): the platform's
    // boolean, then the top-level boolean, then false.
    const native =
      [evaluated[platform]?.zoomEnabled, evaluated.zoomEnabled].find((v) => typeof v === 'boolean') ?? false;

    assert.equal(native, true, `${path} evaluates to zoom off`);
    assert.equal(effectiveCapacitorZoom(readFileSync(join(ROOT, path), 'utf8'), platform), native);
  }
});
