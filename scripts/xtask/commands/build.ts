/**
 * build — ports the `build` target, the pre-port Makefile.
 *
 * The addressability the task asks for: an optional `[image]` positional
 * builds just that one image, bypassing the ENV-based inclusion gate (which
 * is "what this environment needs by default", not "unsafe to build
 * elsewhere" — verified against every Dockerfile involved). With no
 * `[image]`, builds the same ENV-appropriate ordered set the Makefile did:
 * api+gateway (if `env != local`) -> setup-database -> database ->
 * object-store -> setup-secrets (if `env == production`) -> summary -> hbpe.
 *
 * `computeBuildPlan` does no Docker/yarn I/O — it only reads local files and
 * runs cheap `git` lookups — so `--dry-run` can print the exact plan without
 * a daemon, and so the "which images, in what order" logic is unit-testable
 * on its own.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';

import { run } from '../lib/exec';
import { readUvVersion } from '../lib/uv';
import { computeHbpeBuildConfig, detectGpu, VALID_GPUS, type Gpu } from '../lib/gpu';
import {
  API_REPO,
  DATABASE_REPO,
  GATEWAY_REPO,
  HBPE_REPO,
  OBJECT_STORE_REPO,
  SETUP_DATABASE_REPO,
  SETUP_SECRETS_REPO,
  SUMMARY_REPO,
  computeTag,
  contextStamp,
  sidecarStamp,
  versionedTagArgs,
} from '../lib/images';
import { note } from '../../dev-stack/log';

export type Env = 'local' | 'staging' | 'production';
export const VALID_ENVS: Env[] = ['local', 'staging', 'production'];

export type ImageKey =
  | 'api'
  | 'gateway'
  | 'setup-database'
  | 'database'
  | 'object-store'
  | 'setup-secrets'
  | 'summary'
  | 'hbpe';

/** Build order — matches the pre-port Makefile exactly. */
export const IMAGE_ORDER: ImageKey[] = [
  'api',
  'gateway',
  'setup-database',
  'database',
  'object-store',
  'setup-secrets',
  'summary',
  'hbpe',
];

export interface BuildStep {
  key: ImageKey;
  label: string; // the text between "Building " and "...", e.g. "API image"
  dockerfile: string; // relative to root
  context: string; // relative to root
  repo: string;
  extraBuildArgs: string[]; // flat --build-arg pairs, before the label/versioned-tag/-t/context
  // The `ci.source-tree` label value, for the images `dev` staleness-checks.
  // Kept on the step (not buried in extraBuildArgs) so `dev` compares a warm
  // image against exactly the stamp a build would give it.
  sourceTree?: string;
  warning?: string;
}

/** An image built from nothing but its own directory — its Dockerfile lives
 * there and it is the whole build context — stamped with that directory's
 * tree hash. */
function contextOnlyStep(root: string, key: ImageKey, label: string, dir: string, repo: string): BuildStep {
  return {
    key,
    label,
    dockerfile: `${dir}/Dockerfile`,
    context: dir,
    repo,
    extraBuildArgs: [],
    sourceTree: contextStamp(root, dir),
  };
}

/** `--label ci.source-tree=<stamp>` for a stamped step, else nothing. */
function sourceTreeLabelArgs(step: BuildStep): string[] {
  return step.sourceTree === undefined ? [] : ['--label', `ci.source-tree=${step.sourceTree}`];
}

export interface BuildPlan {
  steps: BuildStep[];
  needsFrontendBuild: boolean;
}

/** The ENV-appropriate default set, the pre-port Makefile(api/gateway),464-470
 * (always),473(production only). */
function defaultImageKeys(env: Env): ImageKey[] {
  const keys: ImageKey[] = ['setup-database', 'database', 'object-store', 'summary', 'hbpe'];

  if (env !== 'local') {
    keys.push('api', 'gateway');
  }

  if (env === 'production') {
    keys.push('setup-secrets');
  }

  return keys;
}

function buildStepFor(root: string, key: ImageKey, gpu: Gpu, uvVersion: string): BuildStep {
  switch (key) {
    case 'api':
      return {
        key,
        label: 'API image',
        dockerfile: 'backend/apps/api/Dockerfile',
        context: '.',
        repo: API_REPO(),
        extraBuildArgs: [],
      };
    case 'gateway':
      return {
        key,
        label: 'gateway image',
        dockerfile: 'infrastructure/gateway/Dockerfile',
        context: '.',
        repo: GATEWAY_REPO(),
        extraBuildArgs: [],
      };
    case 'setup-database':
      return contextOnlyStep(
        root,
        key,
        'database setup image',
        'infrastructure/setup-database',
        SETUP_DATABASE_REPO(),
      );
    case 'database':
      return contextOnlyStep(root, key, 'database image', 'infrastructure/database', DATABASE_REPO());
    case 'object-store':
      return contextOnlyStep(
        root,
        key,
        'object store image',
        'infrastructure/object-store',
        OBJECT_STORE_REPO(),
      );
    case 'setup-secrets':
      return contextOnlyStep(
        root,
        key,
        'setup secrets image',
        'infrastructure/setup-secrets',
        SETUP_SECRETS_REPO(),
      );
    case 'summary':
      return {
        key,
        label: 'summary service image',
        dockerfile: 'backend/apps/summary/Dockerfile',
        context: '.',
        repo: SUMMARY_REPO(),
        extraBuildArgs: ['--build-arg', `UV_VERSION=${uvVersion}`],
        sourceTree: sidecarStamp(root, 'summary'),
      };
    case 'hbpe': {
      const hbpe = computeHbpeBuildConfig(root, gpu, uvVersion);
      const gpuLabel = gpu === 'rocm' ? `rocm ${hbpe.amdgpuTargets || 'no-gfx-target'}` : gpu;

      return {
        key,
        label: `HBPE service image (${gpuLabel})`,
        dockerfile: `backend/apps/hbpe/${hbpe.dockerfile}`,
        context: '.',
        repo: HBPE_REPO(),
        extraBuildArgs: hbpe.buildArgs,
        sourceTree: sidecarStamp(root, 'hbpe'),
        warning: hbpe.warning ?? undefined,
      };
    }
  }
}

export function computeBuildPlan(
  root: string,
  env: Env,
  gpu: Gpu,
  uvVersion: string,
  images?: readonly ImageKey[],
): BuildPlan {
  const requested = new Set<ImageKey>(images && images.length > 0 ? images : defaultImageKeys(env));
  const steps = IMAGE_ORDER.filter((k) => requested.has(k)).map((k) => buildStepFor(root, k, gpu, uvVersion));

  return { steps, needsFrontendBuild: requested.has('gateway') };
}

function printPlan(plan: BuildPlan, env: Env, tag: string): void {
  console.log(`Build plan for ENV=${env}:\n`);

  if (plan.needsFrontendBuild) {
    console.log('  (cd frontend/apps/web && yarn clean && yarn build)');
  }

  for (const step of plan.steps) {
    const tagArgs = versionedTagArgs(step.repo, tag);
    const cmd = [
      'docker build',
      '-f',
      step.dockerfile,
      ...step.extraBuildArgs,
      ...sourceTreeLabelArgs(step),
      ...tagArgs,
      '-t',
      `${step.repo}:latest`,
      step.context,
    ].join(' ');

    console.log(`  ${cmd}`);

    if (step.warning) {
      console.log(`    ⚠ ${step.warning.replace(/\n\s*/g, ' ')}`);
    }
  }
}

export interface BuildOptions {
  env: Env;
  gpu: Gpu;
  // Just these images, in build order, regardless of ENV; empty or absent
  // builds the ENV-appropriate set.
  images?: readonly ImageKey[];
  dryRun?: boolean;
}

export async function runBuild(root: string, opts: BuildOptions): Promise<void> {
  if (!VALID_ENVS.includes(opts.env)) {
    throw new Error(`Invalid ENV '${opts.env}'. Choose one of: ${VALID_ENVS.join(' ')}`);
  }

  if (!VALID_GPUS.includes(opts.gpu)) {
    throw new Error(`Invalid GPU '${opts.gpu}'. Choose one of: ${VALID_GPUS.join(' ')}`);
  }

  const uvVersion = readUvVersion(root);

  if (!uvVersion) {
    throw new Error('Could not read the uv pin from required-version in pyproject.toml.');
  }

  const plan = computeBuildPlan(root, opts.env, opts.gpu, uvVersion, opts.images);
  const tag = computeTag(root);

  if (opts.dryRun) {
    // Dry-run answers "what would be built", which doesn't depend on the
    // environment being ready to actually build it — so it deliberately
    // skips the freshness gate below and never touches uv, Docker, or the
    // filesystem beyond reading local files.
    printPlan(plan, opts.env, tag);

    return;
  }

  // The Python images sync with --frozen, which trusts uv.lock as-is so each
  // Dockerfile only has to copy the manifests it actually uses. The
  // freshness check they gave up lives here instead, where the whole
  // workspace is present: fail before building anything rather than bake a
  // stale resolution into an image.
  try {
    run('uv', ['lock', '--check'], { cwd: root });
  } catch {
    throw new Error("uv.lock is out of date with the manifests. Run 'uv lock' and retry.");
  }

  console.log(`🧱 Building ${opts.env} images...`);

  // Delegated back to the Makefile rather than reimplemented here: the two
  // targets are PUBLIC (e2e.yml, video/stage.sh, video/stage.real-corpus.sh and
  // video/README.md all invoke `make distribute-license` directly), so they have
  // to keep existing anyway — and one implementation beats two that can drift.
  run('make', ['distribute-license'], { cwd: root });

  try {
    if (plan.needsFrontendBuild) {
      console.log('\n➤ Compiling web frontend...\n');
      run('yarn', ['clean'], { cwd: path.join(root, 'frontend/apps/web') });
      run('yarn', ['build'], { cwd: path.join(root, 'frontend/apps/web') });
    }

    for (const step of plan.steps) {
      console.log(`\n➤ Building ${step.label}...\n`);

      if (step.warning) {
        note(step.warning);
        console.log('');
      }

      run(
        'docker',
        [
          'build',
          '-f',
          step.dockerfile,
          ...step.extraBuildArgs,
          ...sourceTreeLabelArgs(step),
          ...versionedTagArgs(step.repo, tag),
          '-t',
          `${step.repo}:latest`,
          step.context,
        ],
        { cwd: root },
      );
    }
  } finally {
    // Always runs, success or failure — a deliberate improvement over the
    // Makefile, where `clean-license` was only reached if every earlier
    // recipe line succeeded (Make aborts a recipe at its first failing
    // line), so a build failure partway through could leave LICENSE.md
    // copies sitting in the infra dirs. index.ts's signal handler is what
    // extends that guarantee to Ctrl-C.
    run('make', ['clean-license'], { cwd: root });
  }

  console.log('');
}

const HELP = `Usage: xtask build [image] [--env local|staging|production] [--gpu cpu|cuda|rocm] [--dry-run]

Build images. With no [image], builds the ENV-appropriate set:
  local:       setup-database database object-store summary hbpe
  staging:     + api gateway
  production:  + setup-secrets

[image] builds just one image (${IMAGE_ORDER.join(', ')}), regardless of ENV.
--dry-run prints the computed plan without touching Docker.`;

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      env: { type: 'string' },
      gpu: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);

    return;
  }

  const root = process.cwd();
  const env = (values.env as Env | undefined) ?? 'local';
  const gpu = (values.gpu as Gpu | undefined) ?? detectGpu(root);
  const image = positionals[0] as ImageKey | undefined;

  if (image && !IMAGE_ORDER.includes(image)) {
    throw new Error(`Unknown image '${image}'. Choose one of: ${IMAGE_ORDER.join(' ')}`);
  }

  await runBuild(root, {
    env,
    gpu,
    images: image ? [image] : undefined,
    dryRun: values['dry-run'] as boolean | undefined,
  });
}
