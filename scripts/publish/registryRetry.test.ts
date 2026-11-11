/**
 * The registry calls in publish.sh and merge-manifests.sh get a few attempts.
 *
 * v2026.11.10's first publish (run 42886475612) lost one arm64 push to GHCR's
 * "unknown blob" while the other eight images pushed, and the whole release
 * stopped until someone reran the job. `registry_retry` (registry-retry.sh)
 * tries such a call again, and these tests drive it with a fake `docker` that
 * fails a set number of times before it answers.
 *
 * Needs bash and jq, which merge-manifests.sh needs too. Skips without them.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

// The root `yarn test` runs from the repository root, like the other script tests.
const PUBLISH_DIR = path.join(process.cwd(), 'scripts/publish');
const RETRY_LIB = path.join(PUBLISH_DIR, 'registry-retry.sh');
const MERGE_SCRIPT = path.join(PUBLISH_DIR, 'merge-manifests.sh');
const PUBLISH_SCRIPT = path.join(PUBLISH_DIR, 'publish.sh');

const haveTools =
  spawnSync('bash', ['--version']).status === 0 && spawnSync('jq', ['--version']).status === 0;

const DIGEST = `sha256:${'a'.repeat(64)}`;

/**
 * A `docker` that fails its first `failures` calls of each kind (push, create,
 * inspect) with `error` (GHCR's "unknown blob" by default), then succeeds. Local
 * `image inspect` and `image tag` always succeed, so publish.sh finds every image.
 */
function fakeDocker(dir: string, failures: number, error = 'unknown blob'): string {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const script = `#!/usr/bin/env bash
set -u
state='${dir}'
case "$*" in
  login*) cat >/dev/null; echo "Login Succeeded"; exit 0 ;;
  "image inspect"*|"image tag"*) exit 0 ;;
  "image push"*) kind=push ;;
  "buildx imagetools create"*) kind=create ;;
  "buildx imagetools inspect"*) kind=inspect ;;
  *) echo "unexpected docker call: $*" >&2; exit 2 ;;
esac
n=$(( $(cat "$state/$kind.count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$state/$kind.count"
if [ "$n" -le ${failures} ]; then
  echo '${error}' >&2
  exit 1
fi
case "$kind" in
  push) echo "2026.11.10-arm64: digest: ${DIGEST} size: 1234" ;;
  create) echo "pushed manifest list" ;;
  inspect)
    echo '{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}' ;;
esac
`;
  fs.writeFileSync(path.join(bin, 'docker'), script, { mode: 0o755 });

  return bin;
}

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return dir;
}

function callCount(dir: string, kind: string): string {
  const file = path.join(dir, `${kind}.count`);

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '0';
}

function callRetry(dir: string, bin: string, attempts: string, delay = '0') {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
source "${RETRY_LIB}"
if registry_retry "push x" docker image push x; then echo "status=0"; else echo "status=$?"; fi
echo "output=\${REGISTRY_OUTPUT}"
echo "errors=\${REGISTRY_ERRORS}"`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REGISTRY_ATTEMPTS: attempts,
        REGISTRY_RETRY_DELAY: delay,
      },
      cwd: dir,
    },
  );
}

/** merge-manifests.sh against the fake, merging by tag, with the retry settings pinned. */
function runMerge(dir: string, bin: string, delay = '0') {
  return spawnSync('bash', [MERGE_SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      REGISTRY: 'ghcr.io/companionintelligence',
      VERSION: '2026.11.10',
      ARCHES: 'amd64 arm64',
      PUSH_LATEST: 'false',
      REGISTRY_USERNAME: 'test',
      REGISTRY_PASSWORD: 'test',
      REGISTRY_ATTEMPTS: '3',
      REGISTRY_RETRY_DELAY: delay,
      DIGESTS_DIR: '',
    },
    cwd: dir,
  });
}

test('a refused push is not tried again', { skip: !haveTools }, (t) => {
  const dir = tempDir(t);
  // What GHCR answers a token without packages:write. Waiting would not change it.
  const res = callRetry(dir, fakeDocker(dir, 99, 'denied: permission_denied: write_package'), '3');

  assert.match(res.stdout, /^status=1$/m);
  assert.equal(callCount(dir, 'push'), '1');
  assert.match(res.stderr, /push x: the registry refused it \(exit 1\), not trying again/);
  assert.doesNotMatch(res.stderr, /trying again in/);
});

test('a push that fails once is tried again and its output is kept', { skip: !haveTools }, (t) => {
  const dir = tempDir(t);
  const res = callRetry(dir, fakeDocker(dir, 1), '3');

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^status=0$/m);
  assert.match(res.stdout, /^output=2026\.11\.10-arm64: digest: sha256:a{64} size: 1234$/m);
  assert.match(res.stderr, /push x: attempt 1 of 3 failed \(exit 1\), trying again in 0s/);
  assert.match(res.stderr, /unknown blob/);
  assert.equal(callCount(dir, 'push'), '2');
});

test(
  'a push that keeps failing stops after REGISTRY_ATTEMPTS and returns the failure',
  { skip: !haveTools },
  (t) => {
    const dir = tempDir(t);
    const res = callRetry(dir, fakeDocker(dir, 99), '2');

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^status=1$/m);
    assert.equal(callCount(dir, 'push'), '2');
    // One "trying again" line: the last attempt's failure is the caller's to report.
    assert.equal(res.stderr.match(/trying again/g)?.length, 1);
  },
);

test(
  'a push that works first time is made once, with nothing extra in the log',
  { skip: !haveTools },
  (t) => {
    const dir = tempDir(t);
    const res = callRetry(dir, fakeDocker(dir, 0), '3');

    assert.match(res.stdout, /^status=0$/m);
    assert.equal(res.stderr, '');
    assert.equal(callCount(dir, 'push'), '1');
  },
);

for (const [name, attempts, delay] of [
  ['a delay with a unit', '3', '30s'],
  ['a fractional delay', '3', '1.5'],
  ['an attempt count with a unit', '3x', '0'],
  ['zero attempts', '0', '0'],
] as const) {
  test(`${name} fails the call before docker runs`, { skip: !haveTools }, (t) => {
    const dir = tempDir(t);
    const res = callRetry(dir, fakeDocker(dir, 1), attempts, delay);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^status=2$/m);
    assert.match(res.stdout, /^errors=REGISTRY_(ATTEMPTS|RETRY_DELAY) must be a whole number/m);
    assert.equal(callCount(dir, 'push'), '0');
  });
}

test('merge-manifests.sh gets past a failed create and a failed inspect', { skip: !haveTools }, (t) => {
  const dir = tempDir(t);
  const res = runMerge(dir, fakeDocker(dir, 1));

  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /✓ All \d+ images publish a manifest list covering: amd64 arm64/);
  // The fake fails only the first create and the first inspect of the run.
  assert.match(
    res.stderr,
    /manifest ghcr\.io\/companionintelligence\/[^:]+:2026\.11\.10: attempt 1 of 3 failed/,
  );
  assert.match(
    res.stderr,
    /inspect ghcr\.io\/companionintelligence\/[^:]+:2026\.11\.10: attempt 1 of 3 failed/,
  );
  assert.doesNotMatch(res.stderr, /✗/);
});

test(
  'merge-manifests.sh fails, not passes, when REGISTRY_RETRY_DELAY is malformed',
  { skip: !haveTools },
  (t) => {
    const dir = tempDir(t);
    const res = runMerge(dir, fakeDocker(dir, 1), '30s');

    assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
    assert.doesNotMatch(res.stdout, /✓ All/);
    assert.match(res.stderr, /REGISTRY_RETRY_DELAY must be a whole number of seconds, not '30s'/);
    assert.match(res.stderr, /manifest problem\(s\)/);
    assert.equal(callCount(dir, 'create'), '0');
  },
);

test(
  'publish.sh records the digest of a push that only worked the second time',
  { skip: !haveTools },
  (t) => {
    const dir = tempDir(t);
    const digestFile = path.join(dir, 'digests', 'arm64.txt');
    fs.mkdirSync(path.dirname(digestFile));
    const res = spawnSync('bash', [PUBLISH_SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeDocker(dir, 1)}:${process.env.PATH}`,
        REGISTRY: 'ghcr.io/companionintelligence',
        VERSION: '2026.11.10',
        TAG_SUFFIX: '-arm64',
        DIGEST_FILE: digestFile,
        // Set so publish.sh does not read the checkout's .env; SKIP_PORTAL keeps it unused.
        STORE_ADMIN_API_KEY: 'unused',
        SKIP_PORTAL: 'true',
        REGISTRY_USERNAME: 'test',
        REGISTRY_PASSWORD: 'test',
        REGISTRY_ATTEMPTS: '3',
        REGISTRY_RETRY_DELAY: '0',
      },
      cwd: dir,
    });

    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(
      res.stderr,
      /push ghcr\.io\/companionintelligence\/[^:]+:2026\.11\.10-arm64: attempt 1 of 3 failed/,
    );
    const lines = fs.readFileSync(digestFile, 'utf8').trim().split('\n');
    assert.ok(lines.length > 1, fs.readFileSync(digestFile, 'utf8'));
    for (const line of lines) {
      assert.match(line, new RegExp(`^companion/\\S+ ${DIGEST}$`));
    }
  },
);
