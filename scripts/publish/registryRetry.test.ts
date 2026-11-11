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
import { test } from 'node:test';

// The root `yarn test` runs from the repository root, like the other script tests.
const PUBLISH_DIR = path.join(process.cwd(), 'scripts/publish');
const RETRY_LIB = path.join(PUBLISH_DIR, 'registry-retry.sh');
const MERGE_SCRIPT = path.join(PUBLISH_DIR, 'merge-manifests.sh');

const haveTools =
  spawnSync('bash', ['--version']).status === 0 && spawnSync('jq', ['--version']).status === 0;

/**
 * A `docker` that fails its first `failures` calls of each kind (push, create,
 * inspect) with GHCR's error, then succeeds. Every call is appended to calls.log.
 */
function fakeDocker(dir: string, failures: number): string {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const script = `#!/usr/bin/env bash
set -u
state='${dir}'
echo "$*" >> "$state/calls.log"
case "$*" in
  login*) cat >/dev/null; echo "Login Succeeded"; exit 0 ;;
  "image push"*) kind=push ;;
  "buildx imagetools create"*) kind=create ;;
  "buildx imagetools inspect"*) kind=inspect ;;
  *) echo "unexpected docker call: $*" >&2; exit 2 ;;
esac
n=$(( $(cat "$state/$kind.count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$state/$kind.count"
if [ "$n" -le ${failures} ]; then
  echo "unknown blob" >&2
  exit 1
fi
case "$kind" in
  push) echo "2026.11.10-arm64: digest: sha256:$(printf 'a%.0s' $(seq 64)) size: 1234" ;;
  create) echo "pushed manifest list" ;;
  inspect)
    echo '{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}' ;;
esac
`;
  fs.writeFileSync(path.join(bin, 'docker'), script, { mode: 0o755 });

  return bin;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'registry-retry-'));
}

function callRetry(dir: string, bin: string, attempts: string) {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
source "${RETRY_LIB}"
if registry_retry "push x" docker image push x; then echo "status=0"; else echo "status=$?"; fi
echo "output=\${REGISTRY_OUTPUT}"`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REGISTRY_ATTEMPTS: attempts,
        REGISTRY_RETRY_DELAY: '0',
      },
      cwd: dir,
    },
  );
}

test('a push that fails once is tried again and its output is kept', { skip: !haveTools }, () => {
  const dir = tempDir();
  const res = callRetry(dir, fakeDocker(dir, 1), '3');

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^status=0$/m);
  assert.match(res.stdout, /^output=2026\.11\.10-arm64: digest: sha256:a{64} size: 1234$/m);
  assert.match(res.stderr, /push x: attempt 1 of 3 failed \(exit 1\), trying again in 0s/);
  assert.match(res.stderr, /unknown blob/);
  assert.equal(fs.readFileSync(path.join(dir, 'push.count'), 'utf8').trim(), '2');
});

test(
  'a push that keeps failing stops after REGISTRY_ATTEMPTS and returns the failure',
  { skip: !haveTools },
  () => {
    const dir = tempDir();
    const res = callRetry(dir, fakeDocker(dir, 99), '2');

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^status=1$/m);
    assert.equal(fs.readFileSync(path.join(dir, 'push.count'), 'utf8').trim(), '2');
    // One "trying again" line: the last attempt's failure is the caller's to report.
    assert.equal(res.stderr.match(/trying again/g)?.length, 1);
  },
);

test('a push that works first time is made once, with nothing extra in the log', { skip: !haveTools }, () => {
  const dir = tempDir();
  const res = callRetry(dir, fakeDocker(dir, 0), '3');

  assert.match(res.stdout, /^status=0$/m);
  assert.equal(res.stderr, '');
  assert.equal(fs.readFileSync(path.join(dir, 'push.count'), 'utf8').trim(), '1');
});

test(
  'merge-manifests.sh gets through a failed create and a failed inspect for every image',
  { skip: !haveTools },
  () => {
    const dir = tempDir();
    const res = spawnSync('bash', [MERGE_SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeDocker(dir, 1)}:${process.env.PATH}`,
        REGISTRY: 'ghcr.io/companionintelligence',
        VERSION: '2026.11.10',
        ARCHES: 'amd64 arm64',
        REGISTRY_USERNAME: 'test',
        REGISTRY_PASSWORD: 'test',
        REGISTRY_RETRY_DELAY: '0',
        DIGESTS_DIR: '',
      },
      cwd: dir,
    });

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
  },
);
