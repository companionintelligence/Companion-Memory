/**
 * What each deployment shape exposes beyond the machine it runs on.
 *
 * - The desktop app's gateway answers on loopback only. The app talks to
 *   127.0.0.1:8642 and nothing else, and docker-compose.production.yml's
 *   all-interfaces `8642:8642` put the appliance's sign-in and sign-up pages on
 *   the Wi-Fi of whoever ran it. The overlay replaces that mapping with
 *   `ports: !override`, and only a render proves the replacement: a plain list
 *   would be concatenated onto production's.
 * - Postgres, the object store and the tooling `dbproxy` never bind beyond
 *   loopback in any compose file. Their credentials come from a `.env` that
 *   starts as a copy of the committed `.env.default`, and Docker's own iptables
 *   rules skip ufw.
 * - The Hub store bundle keeps the server's default for signup codes.
 *
 * The render tests need the Docker Compose CLI (no daemon, no images: `config`
 * only resolves the model) and skip without it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { isSeq, parseDocument } from 'yaml';

const ROOT = process.cwd();
const DESKTOP_OVERLAY = 'frontend/apps/desktop/src-tauri/resources/docker-compose.desktop.yml';

interface RenderedPort {
  host_ip?: string;
  target: number;
  published?: string;
}

interface Rendered {
  services: Record<string, { ports?: RenderedPort[] }>;
}

const composeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

/**
 * `docker compose config` over `files`, as JSON. The project directory is a
 * scratch one holding an empty `.env`, because the staging overlay names
 * `env_file: .env` and a checkout has none; relative paths then resolve there,
 * which `config` does not check.
 */
function render(t: TestContext, files: string[], profiles: string[], env: NodeJS.ProcessEnv = {}): Rendered {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-exposure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), '');

  const res = spawnSync(
    'docker',
    [
      'compose',
      '--project-name',
      'compose-exposure-test',
      '--project-directory',
      dir,
      '--env-file',
      path.join(dir, '.env'),
      ...files.flatMap((file) => ['-f', path.join(ROOT, file)]),
      ...profiles.flatMap((profile) => ['--profile', profile]),
      'config',
      '--format',
      'json',
    ],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );

  assert.equal(res.status, 0, `docker compose config failed: ${res.stderr}`);

  return JSON.parse(res.stdout) as Rendered;
}

test('the desktop overlay replaces the gateway mapping with a loopback one', () => {
  const doc = parseDocument(fs.readFileSync(path.join(ROOT, DESKTOP_OVERLAY), 'utf8'));
  const ports = doc.getIn(['services', 'gateway', 'ports'], true);

  assert.ok(isSeq(ports), 'the overlay sets services.gateway.ports');
  assert.equal(
    ports.tag,
    '!override',
    'a plain `ports:` list is concatenated onto production.yml’s 8642:8642 instead of replacing it',
  );
  assert.deepEqual(doc.toJS().services.gateway.ports, ['127.0.0.1:8642:8642']);
});

test('rendered as the desktop app runs it, the gateway listens on 127.0.0.1:8642 only', (t) => {
  if (!composeAvailable) {
    t.skip('docker compose is not installed');

    return;
  }

  // The three files and the profile stack_manager.rs's compose_command passes.
  const config = render(
    t,
    ['docker-compose.yml', 'docker-compose.production.yml', DESKTOP_OVERLAY],
    ['production'],
    { CI_SERVER_IMAGE_TAG: '2026.10.2' },
  );

  assert.deepEqual(
    config.services.gateway.ports?.map(({ host_ip, target, published }) => ({ host_ip, target, published })),
    [{ host_ip: '127.0.0.1', target: 8642, published: '8642' }],
  );
});

/** Every `ports:` entry of the data services, in every compose file in the repo root. */
function dataServicePorts(): { file: string; service: string; mapping: string }[] {
  const files = fs.readdirSync(ROOT).filter((f) => /^docker-compose(\.[a-z]+)?\.yml$/.test(f));

  assert.ok(files.includes('docker-compose.staging.yml'), 'found the compose files');

  return files.flatMap((file) => {
    const services = parseDocument(fs.readFileSync(path.join(ROOT, file), 'utf8')).toJS()?.services ?? {};

    return ['database', 'object-store', 'dbproxy'].flatMap((service) =>
      ((services[service]?.ports ?? []) as unknown[]).map((mapping) => ({
        file,
        service,
        mapping: String(mapping),
      })),
    );
  });
}

test('no compose file publishes Postgres, the object store or dbproxy beyond loopback', () => {
  const mappings = dataServicePorts();

  // The staging pair and the tooling proxy were the all-interfaces ones; the
  // local overlay was already loopback. If none are found the check is empty.
  assert.ok(mappings.some((m) => m.file === 'docker-compose.staging.yml' && m.service === 'database'));
  assert.ok(mappings.some((m) => m.file === 'docker-compose.yml' && m.service === 'dbproxy'));

  for (const { file, service, mapping } of mappings) {
    assert.match(mapping, /^127\.0\.0\.1:/, `${file}: ${service} publishes ${mapping} beyond loopback`);
  }
});

test('rendered as `make staging` runs it, with tooling, the data ports bind 127.0.0.1', (t) => {
  if (!composeAvailable) {
    t.skip('docker compose is not installed');

    return;
  }

  const config = render(t, ['docker-compose.yml', 'docker-compose.staging.yml'], ['staging', 'tooling']);

  for (const service of ['database', 'object-store', 'dbproxy']) {
    const ports = config.services[service]?.ports ?? [];

    assert.ok(ports.length > 0, `${service} publishes a port under staging + tooling`);

    for (const port of ports) {
      assert.equal(
        port.host_ip,
        '127.0.0.1',
        `${service} publishes ${port.published} on ${port.host_ip ?? 'every interface'}`,
      );
    }
  }
});

/** Run named functions lifted out of scripts/publish/publish.sh (which runs `main` when sourced). */
function publishSh(script: string): { status: number | null; stdout: string; stderr: string } {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/publish/publish.sh'), 'utf8');
  const lift = (re: RegExp, name: string) => {
    const m = source.match(re);

    assert.ok(m, `found ${name} in scripts/publish/publish.sh`);

    return m[0];
  };

  const functions = [
    lift(/^fail\(\) \{[\s\S]*?^\}/m, 'fail()'),
    lift(/^generate_compose\(\) \{[\s\S]*?^COMPOSE_EOF\n\}/m, 'generate_compose()'),
    lift(/^check_bundle\(\) \{[\s\S]*?^\}/m, 'check_bundle()'),
  ].join('\n');

  const res = spawnSync('bash', ['-c', `set -euo pipefail\n${functions}\n${script}`], { encoding: 'utf8' });

  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test('publish.sh: the store bundle leaves signup codes at the server default', () => {
  const res = publishSh('generate_compose registry.example version-1');

  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /ENABLE_REQUIRE_SIGNUP_CODES/);
});

test('publish.sh: check_bundle passes the generated bundle and refuses one that sets ENABLE_REQUIRE_SIGNUP_CODES', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-bundle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const bundle = path.join(dir, 'docker-compose.json');
  const generated = publishSh('generate_compose registry.example version-1');

  fs.writeFileSync(bundle, generated.stdout);
  assert.equal(publishSh(`check_bundle '${bundle}'`).status, 0, 'the generated bundle passes');

  // The shape the bundle uses, and the two other ways an env entry can be spelled.
  const spellings = [
    (api: Record<string, unknown>) => (
      (api.environment as unknown[]).push({ key: 'ENABLE_REQUIRE_SIGNUP_CODES', value: 'false' }),
      api
    ),
    (api: Record<string, unknown>) => (
      (api.environment as unknown[]).push('ENABLE_REQUIRE_SIGNUP_CODES=true'),
      api
    ),
    (api: Record<string, unknown>) => ({ ...api, environment: { ENABLE_REQUIRE_SIGNUP_CODES: 'false' } }),
  ];

  for (const spell of spellings) {
    const doc = JSON.parse(generated.stdout) as { services: Record<string, unknown>[] };
    const api = doc.services.findIndex((service) => service.name === 'api');

    doc.services[api] = spell(doc.services[api]);
    fs.writeFileSync(bundle, JSON.stringify(doc));

    const res = publishSh(`check_bundle '${bundle}'`);

    assert.notEqual(
      res.status,
      0,
      `a bundle with ${JSON.stringify(doc.services[api].environment)} must be refused`,
    );
    assert.match(res.stderr, /ENABLE_REQUIRE_SIGNUP_CODES/);
  }
});
