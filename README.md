
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

### 1. Set up the reverse proxy

Follow the [CI-Gateway README](https://github.com/companionintelligence/CI-Gateway) to configure local TLS termination and hostname routing for `*.ci.localhost`.

### 2. Run the local Docker deployment

```bash
make local
```

This runs a variety of commands to do setup, including:

* Ensure you have NodeJS installed and that the version matches what's expected
* Ensure you have Ollama installed, that it is running, and that you've downloaded the minimum required models
* Set up Yarn PnP with the SDKs relevant to our project and configure VSCode to work with them
* Install Yarn dependencies
* Boot local docker containers:
  * **PostgreSQL** Which we use as a primary database and job queue (via PGBoss)
  * **Minio** S3 static file bucket where we upload all static files
  * **Temporal** A durable orchestration engine that manages our more complex async workflows
  * **NGINX** A reverse proxy that publishes our backend (NodeJS) and frontend (Vite) processes to a single port
* Run data schema migrations


### 3. Run local services

Run our applications following the instructions in their respective READMEs.

* Backend (api) [README](backend/apps/api/README.md)
* Frontend (web) [README](frontend/apps/web/README.md)

Seed the database with development data:

```bash
make seed
```

You should now be able to view the application and log in with the credentials below.

* **With [CI-Gateway](https://github.com/companionintelligence/CI-Gateway)** (TLS + hostname routing): **https://memory.ci.localhost**
* **Without CI-Gateway** (Docker nginx only): **http://localhost:8642**

```
Username: jsmith@example.com
Password: ]60.a6{CJ}lB*rHAp;w;
```

If you run into problems with this, you can reset the docker environment using:

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
| `make health` | Check prerequisites (Node.js version, Yarn version, Ollama, required models) |

### Development

| Command | Description |
|---------|-------------|
| `make dev` | Run the development environment locally (health check, local services, tmux session) |
| `make local` | Run the local deployment (Docker services: PostgreSQL, Minio, NGINX, etc.) |
| `make graphql` | Generate GraphQL schema and frontend types |
| `make tooling` | Run development tooling services |
| `make reset` | Reset the local development environment (removes all containers, volumes, images) |

### Database

| Command | Description |
|---------|-------------|
| `make dbclear` | Clear the data stored in the PostgreSQL database |
| `make dbdestroy` | Drop all PostgreSQL data including tables |
| `make migrate` | Run database migrations |
| `make seed` | Seed database with John Smith user and demo data |

### Build & Deploy

| Command | Description |
|---------|-------------|
| `make build` | Build the application (API, frontend, Docker images) |
| `make staging` | Run the staging deployment |
| `make production` | Run the production deployment |

### Admin Scripts

| Command | Description |
|---------|-------------|
| `make chatreset` | Reset John Smith's demo threads |
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
