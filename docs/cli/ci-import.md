# `ci-import` → `ci`

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

**This page moved to [`ci.md`](ci.md).**

The binary was renamed from `ci-import` to `ci` when it stopped being only about
importing: `stats`, `doctor` and `backfill` are appliance-wide, and
`peers`/`grants`/`asks` are the interpersonal-ask feature. It also moved out of
the server — it is now its own workspace, `backend/apps/cli` (`@ci/cli`), whose
one dependency is `commander`.

Nothing you already type has to change. `ci-import` remains as an alias bin: it
prints a deprecation notice **to stderr** and runs the identical program, with
the same subcommands, flags, output and exit codes. A pipeline like
`ci-import runs --json | jq` keeps working.

This stub exists because links to `docs/cli/ci-import.md` are in commit
messages, runbooks and shell history, and a 404 is a worse answer than a
redirect. Delete it when the alias bin goes.
