/**
 * Exercises `computeBuildPlan` against this checkout's own repo root — its
 * Dockerfiles and Makefile pins are the fixture, so these tests also catch a
 * future edit that accidentally drops one of the 4 wheel-publish pins
 * `gpu.ts` still reads by name from the Makefile's text.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeBuildPlan } from './build';

const ROOT = process.cwd();

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
  const plan = computeBuildPlan(ROOT, 'local', 'cpu', '0.9.17', 'api');

  assert.deepEqual(
    plan.steps.map((s) => s.key),
    ['api'],
  );
  assert.equal(plan.needsFrontendBuild, false);
});

test('an explicit "gateway" alone still needs the frontend build (its Dockerfile copies the dist)', () => {
  const plan = computeBuildPlan(ROOT, 'local', 'cpu', '0.9.17', 'gateway');

  assert.deepEqual(
    plan.steps.map((s) => s.key),
    ['gateway'],
  );
  assert.equal(plan.needsFrontendBuild, true);
});

test('an explicit "setup-secrets" builds under ENV=local, even though it defaults to production-only', () => {
  const plan = computeBuildPlan(ROOT, 'local', 'cpu', '0.9.17', 'setup-secrets');

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
    const plan = computeBuildPlan(ROOT, 'local', gpu, '0.9.17');
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
