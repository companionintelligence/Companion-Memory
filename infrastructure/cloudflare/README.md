# Public preview via Cloudflare Tunnel

Expose a **local** CI-Server dev stack at `https://dev.companionintelligence.com`
for sharing a preview — no public IP, port-forwarding, or inbound firewall rules.

> ⚠️ **This publishes a personal-data app to the public internet.** Put
> **Cloudflare Access** in front of the hostname (below) and treat the tunnel as
> deliberate and temporary. Do not leave it running unattended.

## How it works

```
Browser ──TLS──▶ Cloudflare edge ──Tunnel──▶ cloudflared (this machine)
        ──HTTPS (loopback)──▶ Caddy :443 ──▶ vite / api / object-store
                 Host rewritten to <stack>.localhost
```

`cloudflared` forwards to the shared Caddy that `make dev` already runs, rewriting
the `Host` header to the stack's local host so Caddy's existing route serves
everything (`/`, `/api`, `/graphql`, `/static`) unchanged. **No changes to the
dev-stack / Caddy scripts are required.**

GraphQL works (same-origin POST to `/api/graphql`). Vite HMR over the tunnel is
disabled by CSP — edit-reload still works with a manual refresh.

## One-time setup

1. `brew install cloudflared`
2. `cloudflared tunnel login` — authorize the `companionintelligence.com` zone
   (writes `~/.cloudflared/cert.pem`).
3. `cloudflared tunnel create ci-dev` — writes `~/.cloudflared/<UUID>.json`.
4. `cloudflared tunnel route dns ci-dev dev.companionintelligence.com` — creates
   the proxied CNAME.
5. `cp infrastructure/cloudflare/config.example.yml infrastructure/cloudflare/config.yml`
   and set `credentials-file` to your `~/.cloudflared/<UUID>.json`.
6. **Cloudflare Access** (strongly recommended): Zero Trust → Access →
   Applications → add `dev.companionintelligence.com`, policy = your email/org.

If running in a git worktree, edit `httpHostHeader` / `originServerName` in
`config.yml` to your stack host — the `make dev` banner prints it (e.g.
`ci-server-myfeature.localhost`).

## Run

```
make dev      # terminal 1 — brings up the stack + Caddy
make tunnel   # terminal 2 — starts cloudflared; Ctrl-C to stop
```

Then open `https://dev.companionintelligence.com`. Stopping `make tunnel`
(Ctrl-C) takes the preview offline immediately; the CNAME remains but resolves to
nothing usable until the tunnel runs again.

## Login / data

A logged-in user's data requires auth. The OAuth provider only redirects back to
the registered `memory.local.companionintelligence.com`, so logging in *through*
the public host won't complete cleanly. For a preview, use the dev default user
(`AUTH_DEFAULT_USER_EMAIL`) / an existing local session, or register
`https://dev.companionintelligence.com/oauth/callback` with the provider and set
`OAUTH_CALLBACK_URL` accordingly for the session.
