# Security Policy

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

This file previously carried GitHub's unedited template — including a version
table (`5.1.x`, `4.0.x`) for versions CI-Server has never had. Replaced with what
is actually true, verified against the repository on 2026-08-19.

## Supported Versions

CI-Server has no semantic version line. Releases are **date tags** of the form
`v<YYYY>.<M>.<D>` (with `v<YYYY>.<M>.<D>.<N>` for a second release the same day),
and the images published to the CI-Portal store are tagged with the same string
minus the leading `v` — so `v2026.7.27` publishes `companion/*:2026.7.27`.

| Version | Supported |
| ------- | --------- |
| The newest release tag — the one `:latest` points at | ✅ |
| Any older release tag | ❌ — upgrade to the newest release |
| `dev-<short-sha>` images (an untagged local `make publish`) | ❌ — never a release |

`:latest` is repointed by `.github/workflows/publish.yml` only when the tag being
built is release-shaped *and* sorts newest; a back-tagged or re-cut older release
leaves it alone. See **Releasing & image tags** in the [README](README.md).

## Reporting a Vulnerability

**Do not open a public GitHub issue, pull request or discussion for a security
problem.** This repository and everything in it are private and confidential.

- Report privately to the CI-Server maintainers through an internal Lifescope
  channel. GitHub's private vulnerability reporting is **not** enabled on this
  repository (checked 2026-08-19), so a GitHub security advisory is not currently
  an available route.
- Include the affected release tag or commit, the reproduction, and the impact.
- Handling follows the org-wide policy in
  `CI-Engineering/resources/security-policies.md`; a confirmed incident runs
  through the same PIR process as a reliability incident (`CI-Engineering/operations/pirs/`),
  with containment, notification of the security lead, and evidence preservation
  as additional first steps.

## Automated scanning

Dependency-vulnerability scanning runs through Dependabot
([`.github/dependabot.yml`](.github/dependabot.yml)), covering the single root
`yarn.lock` (npm ecosystem), the single root `uv.lock` (uv ecosystem) and the
GitHub Actions workflows. It opens PRs; bumps are reviewed and merged
deliberately rather than auto-merged.

Note that **check workflows in `.github/workflows/` are `workflow_dispatch`-only**
as of 2026-08-17 — no check runs on push, pull request, tag or schedule, so an
absent check is not evidence that anything passed. `mobile-release.yml` is the
store-upload exception (`ios-v*` / `android-v*` / `mobile-release-v*` tags).
See [`docs/CI.md`](docs/CI.md).
