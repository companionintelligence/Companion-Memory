
<p align="center">
    <img width="512" height="512" alt="companion-memory-logo" src="https://github.com/user-attachments/assets/e8f0d40b-3e84-44ad-85ee-55f677b08cb3" />
</p>


# Companion Memory
### Personal Database for Companion Intelligence

### [INSTALL FROM STORE](https://hub.ci.computer/store?category=companion-intelligence)


#### COPYRIGHT COMPANION INTELLIGENCE - LIFESCOPE INC

#### DO NOT DISTRIBUTE

## PRIVATE AND CONFIDENTIAL

Front + Back End API + Web Monorepo

This repository serves as the web interface to the Companion Intelligence server.

This is a Yarn workspace monorepo with the following structure:

```
├── backend/apps/
│   └── api/                    # Main backend API service (NestJS)
├── frontend/apps/
│   ├── web/                    # Main web application (React + Vite)
│   └── native/                 # Future native app
└── frontend/packages/
    ├── capture/                # Camera capture components
    ├── common/                 # Shared utilities and components
    ├── shadcn/                 # ShadCN components (these typically shouldn't be modified directly, they're just local copies of our component library)
    └── template/               # A starter package to copy and paste when you need to create a new package in frontend/packages/
```

## TL;DR - Hermes

### STANDALONE SETUP

```
hermes memory setup
```
### Point to running Companion Memory Server URL

<img height="150" alt="434image" src="https://github.com/user-attachments/assets/ba285919-36cd-435f-946c-912dfbbad034" />

Automatic Setup

<img height="350" alt="2image" src="https://github.com/user-attachments/assets/e85091a4-3169-40c4-933a-5deabff679ca" />

Select Memory provider

<img height="300" alt="5image" src="https://github.com/user-attachments/assets/aba17970-b2d2-4842-b268-495bffdde2c8" />


## Getting started

### Install pre-requisites

#### Homebrew

If you're on MacOS, install Homebrew with the instructions found [here](https://brew.sh/).

#### Docker

Install Docker on your machine to run containerized versions of our dependencies during development.
The easiest method here is downloading and installing the Docker Desktop app from [here](https://www.docker.com/products/docker-desktop/).
The CLI tools should be automatically installed alongside the app.

After it's installed, boot Docker Desktop and verify that it's running and accessible from the command line.

```bash
docker --version
```

#### NodeJS

##### Option 1 - asdf

[asdf](https://asdf-vm.com) can be used to manage multiple runtimes, including the NodeJS version. See:

* [getting started](https://asdf-vm.com/guide/getting-started.html)
* [asdf-nodejs](https://github.com/asdf-vm/asdf-nodejs))

Install with:

```sh
brew install asdf
asdf plugin add nodejs https://github.com/asdf-vm/asdf-nodejs.git
asdf install
node --version
```

Note that `asdf` uses the `.tool-versions` file to define the versions of the various runtimes it manages.

To keep compatibility with `nvm`, also add the following to `$HOME/.asdfrc`:

```txt
legacy_version_file = yes
```

##### Option 2 - nvm

We also maintain parallel compatibility with [nvm](https://github.com/nvm-sh/nvm)

```sh
brew install nvm
nvm install
node --version
```

Note that `nvm` uses the `.nvmrc` file to define the version of NodeJS to use.

#### tmux

```bash
brew install tmux
```

#### Overmind

[Overmind](https://github.com/DarthSim/overmind) is a process manager that reads the repo's `Procfile` and runs each declared process (the `api` and `web` dev servers) inside a single `tmux` session. `make dev` requires it on your `PATH` and will fail fast if it's missing.

## MacOS
```bash
brew install overmind
```

## Linux

Install with Go:
```bash
go install github.com/DarthSim/overmind/v2@latest
```

Make sure to add the Go bin directory to your `PATH` if it's not already and start a new terminal:

```bash
export PATH="$PATH:$(go env GOPATH)/bin"
```

Because Overmind multiplexes through `tmux`, the `tmux` prerequisite above must be installed first.

#### Caddy

[Caddy](https://caddyserver.com) is the local reverse proxy. `make dev` configures it dynamically per worktree via its admin API — it terminates TLS for `*.localhost` and routes `/api`, `/graphql`, `/static`, and `/` to the right process.

## MacOS
```bash
brew install caddy
```

## Linux
Follow the instructions [here](https://caddyserver.com/docs/install#linux) to install Caddy on Linux. The recommended method is via the official APT repository:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

You may need to disable the caddy service and enable caddy-api:

```bash
sudo systemctl disable caddy
sudo systemctl enable caddy-api
```

Run it as a background service so its admin API is always on `:2019` and it owns `:443`:

```bash
brew services start caddy
```

Caddy's global config at `/opt/homebrew/etc/Caddyfile` only needs to pin the admin port — per-worktree routes are added at runtime by `make dev`, never written to this file:

```caddyfile
{
	admin localhost:2019
}
```

**Trust the local CA.** Caddy serves `*.localhost` over HTTPS with its own CA, which depends on the `HOME` Caddy runs under. The brew service runs with `HOME=/opt/homebrew/var/lib`, so trust that CA explicitly (prompts for your password):

```bash
HOME=/opt/homebrew/var/lib XDG_DATA_HOME=/opt/homebrew/var/lib caddy trust
```

#### Ollama

Ollama is an open-source tool that enables users to run large language models (LLMs) like Llama, Mistral, and Gemma directly on their local machines.
The easiest method to install Ollama is by following the download instructions [here](https://ollama.com/download).

Note that if you're on MacOS and you've already installed Homebrew you can instead run:

```bash
brew install ollama
```

The `ollama` binary can serve LLM responses from a variety of models that can be each be downloaded from [here](https://ollama.com/search).

The `ollama` binary can be daemonized if using Homebrew with:

```bash
brew services start ollama
```

Test that Ollama is running using:

```bash
ollama pull gemma3:1b
ollama run gemma3:1b "say hello"

ollama pull nomic-embed-text
ollama run nomic-embed-text "embed this"
```

## Initialize development environment

Everything below is orchestrated by a single command:

```bash
make dev
```

`make dev` brings up a complete, **per-worktree isolated** dev stack and is the entry point for local development. It:

1. checks prerequisites (Node version, overmind, Caddy + its admin API on `:2019`, Ollama + required models);
2. installs dependencies and builds the local service images;
3. brings up this worktree's Docker stack — **PostgreSQL** (primary DB + PGBoss job queue), **Minio** (S3 object storage), **Temporal** (durable workflow orchestration), and the **summary** / **hbpe** services — preferring the conventional host ports when free and falling back to ephemeral ports otherwise, so multiple worktrees never collide;
4. runs database migrations;
5. registers a **Caddy** route at `https://<project>.localhost` and runs the `api` + `web` dev servers via overmind, in the foreground.

`<project>` is the git-derived name — `ci-server` in the main checkout, `ci-server-<worktree>` in a linked worktree — the same identity used for the Docker Compose project and the overmind session. Caddy terminates TLS and routes by path (`/api` → api, `/graphql` → api, `/static` → object store, everything else → vite), so the app is same-origin with no CORS.

`Ctrl-C` tears the Caddy route down and stops the stack. If a crashed run leaves a stale route behind, clear it with:

```bash
make dev-down
```

To run the api/web individually instead, see their READMEs ([api](backend/apps/api/README.md), [web](frontend/apps/web/README.md)).

### OAuth in a worktree

Most local development needs no OAuth. The provider always redirects back to one fixed, registered host (the host of `OAUTH_CALLBACK_URL` in `.env`, `memory.local.companionintelligence.com`), never the per-worktree `<project>.localhost`. Only one stack can answer that host at a time. With your stack running, claim it for the current worktree:

```bash
make oauth
```

This makes the static OAuth host 307-redirect to this worktree's stack (`https://<project>.localhost`), preserving the path and query, so the callback lands on your stack. It also pins Caddy's internal (locally-trusted) CA for that host, so the non-public domain gets a working cert with no public ACME, trusted through the same `caddy trust` you already ran. The claim is released automatically when the stack tears down, or explicitly with `make oauth-down`.

The OAuth host must resolve to loopback on your machine so the browser reaches Caddy, so add it to `/etc/hosts`:

```
127.0.0.1 memory.local.companionintelligence.com
```

### Seed and log in

With the stack up, seed development data in another shell:

```bash
make seed
```

Then open `https://<project>.localhost` (e.g. **https://ci-server.localhost**) and log in:

```
Username: jsmith@example.com
Password: ]60.a6{CJ}lB*rHAp;w;
```

If something is wedged, reset the environment (stops the stack and removes this project's volumes/networks):

```bash
make reset
```

## Available Commands

Run `make` from the project root to see all available commands with descriptions.

### Setup & Initialization

| Command | Description |
|---------|-------------|
| `make init` | Initialize repository after checkout (installs dependencies, sets up VS Code, prepares git hooks) |
| `make install` | Install project dependencies only |
| `make health` | Check prerequisites (Node.js version, Yarn version) and report per-stack data volumes |

### Development

| Command | Description |
|---------|-------------|
| `make dev` | Bring up the full per-worktree dev stack (Docker services + migrations + Caddy route at `<project>.localhost` + api/web via overmind). Foreground; Ctrl-C tears down. |
| `make dev-down` | Deregister this worktree's Caddy route (clears a stale route from a crashed run) |
| `make oauth` | Point the canonical OAuth host at this worktree's running stack (replaces any prior claim) |
| `make oauth-down` | Release the canonical OAuth host claim |
| `make graphql` | Generate GraphQL schema and frontend types |
| `make tooling` | Run development tooling services |
| `make stop` | Stop all running services (containers stay, data preserved) |
| `make reset` | Reset the local development environment (stops the stack, removes this project's volumes/networks) |

### Database

| Command | Description |
|---------|-------------|
| `make dbclear` | Clear the data stored in the PostgreSQL database |
| `make dbdestroy` | Drop all PostgreSQL data including tables |
| `make dbshell` | Open a psql shell to the PostgreSQL database |
| `make migrate` | Run database migrations |
| `make seed` | Seed database with John Smith user and demo data |

### Build & Deploy

| Command | Description |
|---------|-------------|
| `make build` | Build images (`ENV=local\|staging\|production`, default `local`; `GPU=cpu\|cuda\|rocm`, default `cpu`) |
| `make staging` | Run the staging deployment |
| `make production` | Run the production deployment |
| `make publish` | Publish CI-Server images and metadata to the CI-Portal store |
| `make seed-production` | Seed the production database via an ephemeral proxy |

### HBPE

| Command | Description |
|---------|-------------|
| `make predict` | Run the HBPE prediction pipeline against the local container |
| `make predict-production` | Run the HBPE prediction pipeline against the production container |

### Admin Scripts

| Command | Description |
|---------|-------------|
| `make chatreset` | Reset John Smith's demo threads |
| `make filereset` | Clear all files from the system |
| `make gentoken` | Generates a stable access token for use during development |
| `make signup` | Generates a set of signup codes for user registration |
| `make userpw` | Change a user's password |

### Linting

```bash
yarn lint      # Run ESLint across the entire monorepo
yarn lint:fix  # Auto-fix linting issues
```

### Backend API Commands (`backend/apps/api`)

```bash
yarn dev                    # Start development server with nodemon
yarn migrate:make <name>    # Create a new migration file
yarn migrate:rollback       # Rollback the last migration
yarn lint:circular-imports  # Check for circular import dependencies
yarn lint                   # Lint backend code
yarn lint:fix               # Auto-fix backend linting issues
```

### Frontend SPA Commands (`frontend/apps/web`)

```bash
yarn dev                    # Start Vite development server
yarn storybook              # Start Storybook for component development
yarn lint                   # Lint frontend code
yarn lint:fix               # Auto-fix frontend linting issues
```
