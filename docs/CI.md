# Running CI for this repo

Automatic workflow triggers in this repository are **gated**: pushing does not
start a GitHub-hosted run any more. Checks run on local hardware, and the
workflows that remain are started deliberately.

Why: GitHub Actions was costing the org $563/month, almost all of it hosted
compute for checks that run just as well on hardware we already own.

Starting a gated workflow needs the [`gh` CLI](https://cli.github.com) and push
access. `--ref` matters - the workflow file is read from that branch, so a
workflow that only exists on your feature branch must be dispatched against it.

Full cross-repo runbook: `CI-Local-CICD/RUNBOOK.md` (regenerate with
`ci-local docs`). Everything above and below the two rules is generated - do not
hand-edit it; the block between them is maintained by hand and a regeneration
will drop it.

`ci-local` is not on `PATH` by default. It is the script at
`CI-Local-CICD/ci-local` in the sibling clone - invoke it by full path, or add
that directory to `PATH`.

---

## Not covered by the generated list below (hand-maintained)

The generated section lists five of this repo's **twelve** workflows. The
other six:

| Workflow | Trigger | Note |
|---|---|---|
| `codeql.yml` | `workflow_dispatch` | Gated. Added in [#2261](https://github.com/companionintelligence/CI-Server/pull/2261) as push/PR/cron; that failed every run because this private repo has no GitHub Code Security (`SARIF` upload 403). Dispatch with `gh workflow run codeql.yml --ref <branch>`. Restore PR/push only after Code Security is enabled. |
| `mobile-release.yml` | **`push` on `ios-v*` / `android-v*` / `mobile-release-v*` tags**, plus dispatch | NOT gated for tags. Never runs on a PR. Signed TestFlight / Play internal lane. |
| `desktop-release.yml` | **`push` on `desktop-v*` tags**, plus dispatch | NOT gated for tags. Signed macOS/Windows lanes skip (not fail) until their signing secrets are provisioned — see that workflow's header comment. |
| `consent-path-gate.yml` | `workflow_dispatch` | The merge gate for the federated-ask consent path. `gh workflow run "Consent path gate" --ref <branch>`. Ships dispatch-only on purpose - see [`asks-system-guide.md` §7.3](asks-system-guide.md). |
| `mobile-build.yml` | `workflow_dispatch` | Debug APK + iOS Simulator `.app`. |
| `desktop-build.yml` | `workflow_dispatch` | Unsigned dmg/deb/rpm/AppImage/msi — the desktop local-orchestrator app (`frontend/apps/desktop`). |

---

Default branch: `main`

### Test locally

```bash
ci-local run --repo CI-Server
```

Equivalent to:

```bash
yarn install --immutable
yarn run lint
```

### Run a check workflow on GitHub

**CI** — `ci.yml`

```bash
gh workflow run ci.yml --repo companionintelligence/CI-Server --ref main
```

**E2E** — `e2e.yml`

```bash
gh workflow run e2e.yml --repo companionintelligence/CI-Server --ref main
```

**Migrations** — `migration-integrity-check.yml`

```bash
gh workflow run migration-integrity-check.yml --repo companionintelligence/CI-Server --ref main
```

**Style canon lint** — `style-canon-lint.yml`

```bash
gh workflow run style-canon-lint.yml --repo companionintelligence/CI-Server --ref main
```

### Cut a release

**Publish** — `publish.yml`

```bash
gh workflow run publish.yml --repo companionintelligence/CI-Server --ref main
```
