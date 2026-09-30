/**
 * Exercises `computeBuildPlan` against this checkout's own repo root — its
 * Dockerfiles and Makefile pins are the fixture, so these tests also catch a
 * future edit that accidentally drops one of the 4 wheel-publish pins
 * `gpu.ts` still reads by name from the Makefile's text.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contextStamp } from '../lib/images';
import { computeBuildPlan, runBuild } from './build';

const ROOT = process.cwd();

/**
 * Run `fn` with the named env vars set (a string) or removed (undefined), then
 * put every one back exactly as found. `computeHbpeBuildConfig` reads several
 * knobs straight off `process.env` (`AMDGPU_TARGETS`, the wheel-image
 * overrides), so a case that does not pin them passes or fails depending on
 * what the developer's shell happens to export — and, for `AMDGPU_TARGETS`, on
 * whether the host has `rocminfo`.
 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));

  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }

    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

/** The value of `--build-arg <key>=...` in a flat `["--build-arg", "K=V", ...]` list, or undefined. */
function buildArgValue(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--build-arg' && (args[i + 1] ?? '').startsWith(`${key}=`)) {
      return args[i + 1].slice(key.length + 1);
    }
  }

  return undefined;
}

test('ENV=local builds only the 5 always-needed images, in order, no frontend build', () => {
  const plan = computeBuildPlan(ROOT, 'local', 'cpu', '0.9.17');

  assert.deepEqual(
    plan.steps.map((s) => s.key),
    ['setup-database', 'database', 'object-store', 'summary', 'hbpe'],
  );
  assert.equal(plan.needsFrontendBuild, false);
});

test('ENV=staging adds api+gateway and needs the frontend build', () => {
  const plan = computeBuildPlan(ROOT, 'staging', 'cpu', '0.9.17');

  assert.deepEqual(
    plan.steps.map((s) => s.key),
    ['api', 'gateway', 'setup-database', 'database', 'object-store', 'summary', 'hbpe'],
  );
  assert.equal(plan.needsFrontendBuild, true);
});

test('ENV=production additionally adds setup-secrets', () => {
  const plan = computeBuildPlan(ROOT, 'production', 'cpu', '0.9.17');

  assert.deepEqual(
    plan.steps.map((s) => s.key),
    ['api', 'gateway', 'setup-database', 'database', 'object-store', 'setup-secrets', 'summary', 'hbpe'],
  );
  assert.equal(plan.needsFrontendBuild, true);
});

test('an explicit image bypasses the ENV gate: "api" alone under ENV=local, no frontend build needed', () => {
  const plan = computeBuildPlan(ROOT, 'local', 'cpu', '0.9.17', ['api']);

  assert.deepEqual(
    plan.steps.map((s) => s.key),
    ['api'],
  );
  assert.equal(plan.needsFrontendBuild, false);
});

test('an explicit "gateway" alone still needs the frontend build (its Dockerfile copies the dist)', () => {
  const plan = computeBuildPlan(ROOT, 'local', 'cpu', '0.9.17', ['gateway']);

  assert.deepEqual(
    plan.steps.map((s) => s.key),
    ['gateway'],
  );
  assert.equal(plan.needsFrontendBuild, true);
});

test('an explicit "setup-secrets" builds under ENV=local, even though it defaults to production-only', () => {
  const plan = computeBuildPlan(ROOT, 'local', 'cpu', '0.9.17', ['setup-secrets']);

  assert.deepEqual(
    plan.steps.map((s) => s.key),
    ['setup-secrets'],
  );
});

test('GPU=cpu never emits a warning for hbpe', () => {
  const plan = computeBuildPlan(ROOT, 'local', 'cpu', '0.9.17');
  const hbpe = plan.steps.find((s) => s.key === 'hbpe');

  assert.equal(hbpe?.warning, undefined);
  assert.equal(hbpe?.dockerfile, 'backend/apps/hbpe/Dockerfile');
});

// The cases above all pass gpu:'cpu', which returns from computeHbpeBuildConfig
// before either GPU Dockerfile or any Makefile pin is read — so on their own
// they would not notice a pin that stopped resolving. These two exercise the
// real Dockerfiles and the real Makefile pins end to end.
for (const gpu of ['cuda', 'rocm'] as const) {
  test(`GPU=${gpu} composes a complete wheel-image build arg from the real Dockerfiles and pins`, () => {
    // AMDGPU_TARGETS is unset, not inherited: whether `rocminfo` exists on the
    // machine running the tests must not decide the outcome.
    const plan = withEnv({ AMDGPU_TARGETS: undefined }, () => computeBuildPlan(ROOT, 'local', gpu, '0.9.17'));
    const hbpe = plan.steps.find((s) => s.key === 'hbpe');

    assert.ok(hbpe, 'hbpe step is present');
    assert.equal(hbpe.dockerfile, `backend/apps/hbpe/Dockerfile.${gpu}`);

    const args = hbpe.extraBuildArgs;

    // Every --build-arg must carry a non-empty value. An unresolvable pin used
    // to yield `KEY=` here and compose an image tag with a hole in it.
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--build-arg') {
        const [key, value] = (args[i + 1] ?? '').split(/=(.*)/s);

        assert.ok(value, `--build-arg ${key} has an empty value`);
      }
    }

    const wheelArg = args.find((a) => a.includes('WHEEL_IMAGE='));

    assert.ok(wheelArg, `${gpu} passes a wheel image`);
    // A tag with an empty component looks like `...wheel:-cu12...` or `--cu12`.
    assert.doesNotMatch(wheelArg, /:-|--|-$/, `${gpu} wheel tag has an empty component: ${wheelArg}`);
  });
}

// Dockerfile.rocm declares `ARG AMDGPU_TARGETS` with no default and reads it as
// `${AMDGPU_TARGETS:+...}`, so "no target" is a legitimate build — llama.cpp
// falls back to its default gfx list. What is NOT legitimate is spelling that as
// an empty `--build-arg AMDGPU_TARGETS=`, which is what a host without
// `rocminfo` (every Mac) used to send, and what turned plain `make test` red.
test('GPU=rocm with no detected gfx target emits NO AMDGPU_TARGETS build arg, and still warns', () => {
  // An explicit empty string is the "operator/host has none" value: `??` in
  // computeHbpeBuildConfig honors it without consulting `rocminfo`.
  const plan = withEnv({ AMDGPU_TARGETS: '' }, () => computeBuildPlan(ROOT, 'local', 'rocm', '0.9.17'));
  const hbpe = plan.steps.find((s) => s.key === 'hbpe');

  assert.ok(hbpe, 'hbpe step is present');
  assert.equal(buildArgValue(hbpe.extraBuildArgs, 'AMDGPU_TARGETS'), undefined);
  assert.ok(
    !hbpe.extraBuildArgs.some((a) => a === 'AMDGPU_TARGETS=' || a.startsWith('AMDGPU_TARGETS=')),
    'no AMDGPU_TARGETS argument of any shape',
  );
  assert.match(hbpe.warning ?? '', /No AMD gfx architecture detected/);
  assert.match(hbpe.warning ?? '', /AMDGPU_TARGETS=gfx####/);
});

test('GPU=rocm with an explicit gfx target passes it through and does not warn', () => {
  const plan = withEnv({ AMDGPU_TARGETS: 'gfx1100' }, () =>
    computeBuildPlan(ROOT, 'local', 'rocm', '0.9.17'),
  );
  const hbpe = plan.steps.find((s) => s.key === 'hbpe');

  assert.ok(hbpe, 'hbpe step is present');
  assert.equal(buildArgValue(hbpe.extraBuildArgs, 'AMDGPU_TARGETS'), 'gfx1100');
  assert.equal(hbpe.warning, undefined);
});

test('withEnv puts AMDGPU_TARGETS back exactly as it found it, set or unset', () => {
  const before = process.env.AMDGPU_TARGETS;

  try {
    delete process.env.AMDGPU_TARGETS;
    withEnv({ AMDGPU_TARGETS: 'x' }, () => assert.equal(process.env.AMDGPU_TARGETS, 'x'));
    assert.equal('AMDGPU_TARGETS' in process.env, false);

    process.env.AMDGPU_TARGETS = 'gfx900';
    withEnv({ AMDGPU_TARGETS: undefined }, () => assert.equal('AMDGPU_TARGETS' in process.env, false));
    assert.equal(process.env.AMDGPU_TARGETS, 'gfx900');
  } finally {
    if (before === undefined) {
      delete process.env.AMDGPU_TARGETS;
    } else {
      process.env.AMDGPU_TARGETS = before;
    }
  }
});

test('an explicit list builds just those images, in build order whatever order they were given', () => {
  const plan = computeBuildPlan(ROOT, 'local', 'cpu', '0.9.17', ['hbpe', 'object-store']);

  assert.deepEqual(
    plan.steps.map((s) => s.key),
    ['object-store', 'hbpe'],
  );
});

test('an empty list builds the ENV-appropriate set, as no list does', () => {
  const plan = computeBuildPlan(ROOT, 'local', 'cpu', '0.9.17', []);

  assert.deepEqual(
    plan.steps.map((s) => s.key),
    ['setup-database', 'database', 'object-store', 'summary', 'hbpe'],
  );
});

// `dev` rebuilds a warm image when its label differs from this stamp, so an
// image in the local set without one would never be noticed as stale — the
// reason object-store kept serving MinIO after the switch to RustFS.
test('every image dev builds carries a source-tree stamp, and the infrastructure ones stamp their own directory', () => {
  const plan = computeBuildPlan(ROOT, 'local', 'cpu', '0.9.17');

  for (const step of plan.steps) {
    assert.ok(step.sourceTree, `${step.key} has no source-tree stamp`);
  }

  for (const key of ['setup-database', 'database', 'object-store'] as const) {
    const step = plan.steps.find((s) => s.key === key);

    assert.ok(step);
    assert.equal(step.sourceTree, contextStamp(ROOT, step.context));
  }
});

test('the dry-run command line labels the image with its stamp', async () => {
  const lines: string[] = [];
  const log = console.log;

  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };

  try {
    await runBuild(ROOT, { env: 'local', gpu: 'cpu', images: ['object-store'], dryRun: true });
  } finally {
    console.log = log;
  }

  const stamp = contextStamp(ROOT, 'infrastructure/object-store');
  const cmd = lines.find((l) => l.includes('docker build'));

  assert.ok(cmd, 'a docker build line was printed');
  assert.ok(cmd.includes(`--label ci.source-tree=${stamp}`), cmd);
});
