# CI gate proposal

> **Nothing here has been applied.** The current posture is deliberate and cost-driven, so this is a proposal for a decision, not a change made quietly. Measured 2026-08-26 against `main` at `15fde65c5`.

## 1. What actually runs today

Thirteen workflows live in `.github/workflows/`. **Eleven are `workflow_dispatch`-only.**

| Workflow | Trigger | Runs on a PR? |
|---|---|---|
| `ci.yml` (lint / typecheck / unit / python) | dispatch | **no** |
| `e2e.yml` | dispatch | **no** |
| `codeql.yml` | dispatch | **no** |
| `consent-path-gate.yml` | dispatch | **no** |
| `migration-integrity-check.yml` | dispatch | **no** |
| `mobile-build.yml` | dispatch | **no** |
| `desktop-build.yml` | dispatch | **no** |
| `style-canon-lint.yml` | dispatch | **no** |
| `publish.yml` | dispatch | **no** |
| `xcode-cloud-manual-only.yml` | dispatch | **no** |
| `benchmark-unit.yml` | `pull_request` + `push` on `main`, path-filtered to `scripts/benchmark/**` | **yes**, for that path |
| `mobile-release.yml` | `push` on `ios-v*` / `android-v*` / `mobile-release-v*` tags | no |
| `desktop-release.yml` | `push` on `desktop-v*` tags | no |

And `main`'s branch protection carries **no `required_status_checks`** and `required_approving_review_count: 0`. So a PR can merge with nothing run and nobody's approval.

Why it is like this: GitHub Actions was costing the org roughly **$563/month**, almost all hosted compute for checks that run on hardware the org already owns (`docs/CI.md`). Gating was a reasonable response to a real bill. The problem is not that it was gated — it is what the gating left behind.

## 2. What the current posture actually cost

From [`baseline-2026-08-26.md`](baseline-2026-08-26.md), measured over 220 commits merged in three days with nothing run:

| Defect | Would a PR gate have caught it? |
|---|---|
| 131 Prettier violations | **Yes** — `ci.yml` `lint/format` |
| 50 ESLint errors, all auto-fixable | **Yes** — `ci.yml` `lint/backend` + `lint/frontend` |
| 153 ruff errors + 34 unformatted Python files | **Yes** — `ci.yml` `python` |
| 6 real backend unit failures | **Yes** — `ci.yml` `test` |
| 1 real frontend unit failure (`useAuth` Android) | **Yes** — `ci.yml` `test-frontend` |
| E2E suite structurally unable to run | **Yes** — `e2e.yml` |
| iOS build lane broken two ways | **Yes** — `mobile-build.yml` |
| Desktop bundling a non-existent image tag | Partly — `desktop-build.yml` builds, but nothing asserts the tag is published |

The single sharpest illustration: **141 of the 153 ruff errors are in `scripts/benchmark`, the one directory covered by an auto-running workflow.** `benchmark-unit.yml` runs `pytest` and nothing else — no ruff. An auto-running check that does not check the thing gives exactly the same false comfort as no check at all, at the cost of looking green.

## 3. Proposal

### 3.1 Turn on a minimum PR gate

Add `pull_request` to `ci.yml` only. Its four lanes need no Docker, no Postgres, no GPU, no secrets — they are `yarn install` plus CPU:

```yaml
on:
  workflow_dispatch:
  pull_request:
    branches: [main]
```

**Cost.** `ci.yml` runs `install`, `test`, `test-frontend`, `typecheck` (×2), `lint` (×4), `python`. Measured locally on this hardware: typechecks 14s + 13s, backend suite 202s, frontend suite 306s, lints seconds, mypy 96s, pytest 56s. On a hosted `ubuntu-latest` with a warm yarn cache, expect roughly **8–14 minutes of runner time per PR** with the jobs in parallel. Use `consent-path-gate.yml`'s own header comment as the estimating methodology — it prices itself at ~4–7 min/PR by the same reasoning.

If that is more than the org wants to spend, the cheap subset is `lint` + `typecheck` alone (~2–3 min): it would still have caught 3 of the 8 defect classes above, including all 334 lint/format violations.

### 3.2 Fix `benchmark-unit.yml` so it checks what it claims

It already runs on every PR touching `scripts/benchmark/**`. Add the lint it is missing — near-zero marginal cost, since the job is already paid for:

```yaml
      - name: Lint
        run: |
          pip install ruff
          ruff check .
          ruff format --check .
```

### 3.3 Keep the expensive lanes on dispatch, but make them a release gate

`e2e.yml`, `mobile-build.yml`, `desktop-build.yml` and `migration-integrity-check.yml` stay dispatch-only. Instead, make them mandatory before a `v*` tag, recorded in the programme's sign-off table:

```bash
gh workflow run ci.yml                       --repo companionintelligence/CI-Server --ref <sha>
gh workflow run e2e.yml                      --repo companionintelligence/CI-Server --ref <sha>
gh workflow run mobile-build.yml             --repo companionintelligence/CI-Server --ref <sha>
gh workflow run desktop-build.yml            --repo companionintelligence/CI-Server --ref <sha>
gh workflow run migration-integrity-check.yml --repo companionintelligence/CI-Server --ref <sha>
```

**`e2e.yml` cannot pass until it is fixed** — it starts only `database` and `setup-database`, and both the seed and the API need more. Minimum change:

```yaml
      - name: Start Postgres, Minio and HBPE
        run: |
          docker compose -f docker-compose.yml -f docker-compose.local.yml --profile local \
            up -d database setup-database object-store hbpe-service
```

`hbpe-service` also needs a host port (`8002:8002`) for the seed, which runs on the host.

### 3.4 Branch protection

Repository settings, not a file change — someone with admin has to do this in the GitHub UI or via the API:

```jsonc
// PATCH /repos/companionintelligence/CI-Server/branches/main/protection
{
  "required_status_checks": {
    "strict": false,
    "contexts": [
      "Lint root", "Lint backend", "Lint frontend", "Lint format",
      "Type check backend", "Type check frontend",
      "Run backend tests", "Run frontend tests", "Check Python"
    ]
  },
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "enforce_admins": false,
  "restrictions": null
}
```

Context names must match the rendered job names exactly (`ci.yml` builds several from a matrix `name`), so confirm them against one dispatched run before adding them — a context that never reports blocks every PR forever.

Do **not** add these until §3.1 is merged and one green run exists on `main`; and do not add them while the lanes are red (§2), or nothing will merge.

### 3.5 If the gate stays manual, make `ci-local` mandatory

The org already runs checks on owned hardware via the sibling `CI-Local-CICD` clone:

```bash
ci-local run --repo CI-Server
```

`ci-local` is not on `PATH` by default — it is the script at `CI-Local-CICD/ci-local`. If §3.1 is rejected on cost, then the programme should require a `ci-local` run per PR, with the result pasted into the PR, and this document should say so in place of §3.4.

## 4. Two red checks that are not about your code

Both are pre-existing baselines. Neither should be treated as a signal, and neither should be added to branch protection until fixed:

- **`App | BuildTestFlight`** — Xcode Cloud, reported from App Store Connect, not GitHub Actions, so none of the gating above touches it. Delete that workflow in App Store Connect → Xcode Cloud → Manage Workflows, or dispatch `xcode-cloud-manual-only.yml` once the `APPSTORE_*` secrets exist.
- **CodeQL** — historically failed every run because SARIF upload is rejected with `Code Security must be enabled for this repository`. It is now dispatch-only, so it no longer reports on PRs. Restore `push`/`pull_request` only after GitHub Code Security is enabled for the repo.

> `docs/architecture/test-strategy.md` and the root `CLAUDE.md` both still describe CodeQL as running on push/PR plus a weekly cron. That is stale — it is `workflow_dispatch:` only. Corrected in this pass.

## 5. Recommendation

1. **Do §3.2 now.** It is nearly free and closes the gap that let 141 lint errors into the one path with an auto-running check.
2. **Do §3.1 next**, at minimum the `lint` + `typecheck` subset.
3. **Fix `e2e.yml`'s services (§3.3)** so the dispatchable release gate can actually go green.
4. **Defer §3.4** until §3.1 has a green run on `main` and the baseline's red lanes are cleared.
