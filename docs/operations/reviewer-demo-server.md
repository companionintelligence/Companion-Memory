# The reviewer-facing demo Memory Server

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Companion Memory is a **self-hosted** product. An App Store or Google Play reviewer
has no appliance, no hostname, and no reason to acquire either — and a self-hosted
client with no reviewer-reachable backend is a well-known automatic rejection. This
document covers the instance that exists purely so a reviewer can use the app, and the
store declarations that standing it up forces.

Two facts are easy to conflate, and only the second one ships:

- **The backend software exists.** True of every CI-Server checkout.
- **A reviewer can reach a backend.** A separate, provable claim.

## What already exists, and what does not

| | Status |
|---|---|
| **Identity** — a CI-Portal account, `demo@ci.computer`, on `hub.ci.computer` | ✅ exists. Portal is the OIDC IdP the app's "Sign in with CI Portal" (`companion://` callback) already targets, so the reviewer's *login* path is real. The password goes in App Store Connect review notes and the Play Console — **never in this repo.** |
| **The Memory Server the app talks to** | ⛔ has to be stood up. This document. |

### Two existing hosts, and why neither can play this role

Both were re-verified with `scripts/demo/verify-reviewer-path.sh`:

| Host | What it is | Why not this |
|---|---|---|
| `hub.ci.computer` | Companion Hub / CI-Portal | Valid TLS, `/api/health` → 200, **but `POST /api/graphql` → 404**. The native `CompanionAPI` calls `/api/graphql` and `/api/llm/generate`; neither exists here. It is the identity endpoint, not the memory backend. |
| `app.ci.computer` | A real CI-Server | **Behind Cloudflare Access.** Paths answer from Cloudflare's *edge*, not the app — `/api/health` returns a Cloudflare HTML error page. A reviewer hits a zero-trust wall and never reaches the product. This is the sharpest form of the trap: a healthy box that is nonetheless unreviewable. |

Do not point App Review at either.

## Requirements

Public DNS · valid TLS (**https only**) · seeded with realistic memory data · **not
behind any access gate**.

The TLS requirement is not cosmetic. It is what keeps the store "encrypted in transit"
answer truthful *for the flow reviewers actually exercise*. It does **not** retroactively
make that answer true for a user pointing the app at `http://` on their LAN or tailnet —
that case is disclosed separately.

## Standing it up

On the demo host, from a CI-Server checkout:

```bash
DEMO_PUBLIC_ORIGIN=https://demo.ci.computer \
DEMO_ACCOUNT_EMAIL=demo@ci.computer \
scripts/demo/deploy-demo-server.sh
```

That runs an ordinary production stack through
[`docker-compose.demo.yml`](../../docker-compose.demo.yml), which changes four things:

1. **The gateway binds to loopback only.** Production publishes `8642` on every
   interface. The demo host also runs stacks holding real data, so the Cloudflare
   tunnel is the *only* public path and nothing on the LAN or tailnet reaches the demo
   by accident. The deploy script asserts this before starting anything.
2. **The HBPE sidecar's AMD GPU passthrough is dropped** (`/dev/kfd`, `/dev/dri`).
   On a host without those devices compose refuses to start the service at all.
3. **The API gets the OIDC/Portal environment.** The production overlay passes the API
   a *fixed* env list with no `OIDC_ISSUER_URL` or `APP_BASE_URL` — on a Hub-managed
   install CI-Hub injects them. Nothing injects them here, so without this the
   reviewer's sign-in dead-ends on `OIDC initiate blocked: OIDC_ISSUER_URL is not
   configured`.
4. **`powersync` is not started** — its client half is unwired and it holds a
   replication slot for a reader that does not exist.

### The one setting that silently ruins the demo

The OIDC callback resolves the signed-in Portal identity with
`userService.findByEmail(...)`. So the **seeded user's email must equal the Portal demo
account's email** — that is why `DEMO_ACCOUNT_EMAIL` is passed to the seeder as
`AUTH_DEFAULT_USER_EMAIL`.

Get it wrong and the reviewer signs in *successfully* and lands in a completely empty
app. That reads as a broken product, not a misconfiguration, and it is worse than a
failed login because nothing in the UI explains it.

## Public ingress (manual, and deliberately so)

This step is not scripted. Attaching a public hostname is the action that puts a
personal-data app on the open internet, and the one thing that must not happen is an
Access policy quietly landing in front of it.

1. Install `cloudflared` on the demo host.
2. `cloudflared tunnel login` — authorize the `ci.computer` zone.
3. `cloudflared tunnel create ci-demo`.
4. `cloudflared tunnel route dns ci-demo demo.ci.computer`.
5. Ingress: `demo.ci.computer` → `http://127.0.0.1:8642`.
6. **Zero Trust → Access → Applications: confirm there is NO policy covering
   `demo.ci.computer`.** A wildcard application for `*.ci.computer` will capture it —
   check for one. This is the single step that separates a working demo from
   `app.ci.computer`.

> Do **not** reuse the tunnel token already running on `beta-1`. Tunnel ingress is
> keyed by hostname, so a second replica of that tunnel would start receiving traffic
> for *every* hostname on it — including `app.ci.computer` — and try to serve them
> locally. Create a separate tunnel.

The gateway is already correct behind Cloudflare: `infrastructure/gateway/nginx.conf`
prefers `CF-Visitor` over `X-Forwarded-Proto` when deriving the client scheme, so
session cookies get their `Secure` attribute on a genuine HTTPS request.

## Proving it — from outside

```bash
scripts/demo/verify-reviewer-path.sh https://demo.ci.computer
```

Run it from a network that is **not** the demo host's tailnet or LAN. Passing from
inside the perimeter proves nothing about what Apple and Google will see.

It checks public DNS, TLS validity, that `/api/health` is answered *by the app rather
than an edge page*, that `POST /api/graphql` and `POST /api/llm/generate` exist, that
the SPA loads, and that no access gate sits in front. It exits non-zero on both known
failure shapes — the Access wall and the wrong-host 404 — so it can gate a release.

## In-app: "Try the demo"

A reviewer should never type a hostname; typing it wrong is its own rejection path.
The [`TryDemoButton`](../../frontend/apps/web/src/components/TryDemoButton.tsx) appears
on both `/device-connect` (the first screen on a fresh install) and the Advanced
`/server` screen. It health-checks before persisting, so a dead demo surfaces as a
readable error instead of an app silently wired to a broken origin.

It is driven by the build-time `VITE_DEMO_SERVER_URL`, which is **https-only**: an
unset, plaintext, or malformed value renders no button at all, because a "Try the demo"
button that fails is worse than none. The iOS and Android `build:web` scripts set it,
so store builds always carry it and a self-hoster's own web build does not.

> Those scripts also pin `VITE_CI_HUB_ENVIRONMENT=production`. Without it
> `DEFAULT_PORTAL_URL` falls back to the **development** Portal at
> `hub.companionintelligence.com`, and the reviewer's "Sign in with CI Portal" goes to
> a Portal that does not hold the demo account. Both hosts are live and answer
> `/api/auth/oauth2/authorize`, so the failure is a confusing login rejection rather
> than an obvious outage.

## What this forces onto the store declarations

**Data sent to this instance is developer-accessible.** That is not a caveat, it is the
declaration. "The user hosts it themselves" is true of the *product* and **not** true of
the demo path both stores will actually test — answering as though only the self-hosted
case exists would be a false declaration on the very flow being reviewed.

So, in the Apple App Privacy nutrition label and the Google Data Safety form:

- Data is **collected** (it is transmitted off-device), **linked to identity**, **not
  used for tracking**, **not shared** with third parties.
- Declare the categories the app can carry: User Content, Photos, Audio, Messages,
  Location — as applicable to what the build actually captures.
- **Encrypted in transit:** the reviewer path is HTTPS-only, so that is true for it.
  The app still permits cleartext to a user's own LAN/tailnet appliance, which must be
  disclosed rather than papered over.
- **Data deletion:** in-app account deletion exists (`DELETE /account`), but the
  background purge job that consumes `purge_after` does **not** yet. Until it does,
  deletion revokes access without deleting data — the privacy policy and Data Safety
  answers must not overstate this.

Suggested review-notes text (keep the password out of the repo — paste it into App
Store Connect / Play Console only):

> Companion Memory is a self-hosted personal-memory appliance; each user runs their own
> server. So that you can review the app without operating one, we host a seeded demo
> instance at **https://demo.ci.computer** with sample data.
>
> On first launch tap **"Try the demo"** — no hostname to type. Then sign in with
> **CI Portal** using **demo@ci.computer** / *(password in the credentials field)*.
> CI Portal is our own first-party identity provider, not a third-party login, which is
> why there is no Sign in with Apple button (guideline 4.8 does not apply).
>
> The demo instance is operated by us and its data is accessible to us; this is
> reflected in our privacy declarations. A real user's data goes only to their own
> server.

## Opsec

The demo is public, seeded, and disposable — treat it that way. Loopback-bound behind
the tunnel; no real personal data; isolated compose project so its volumes cannot
collide with another stack's; rebuild rather than repair; rotate the Portal demo
password after each review cycle. Anything a reviewer types into it is visible to us,
which is exactly what the in-app copy tells them.
