# CI Server

A comprehensive Companion Intelligence system with a modern web application, robust backend API, and job queue system.

## COPYRIGHT COMPANION INTELLIGENCE - LIFESCOPE INC

## DO NOT DISTRIBUTE

## PRIVATE AND CONFIDENTIAL

## Prerequisites

### Homebrew

If you're on MacOS, install Homebrew with the instructions found [here](https://brew.sh/).

### Docker

You'll want to install Docker on your machine to run containerized versions of our dependencies during development.
The easiest method here is downloading and installing the Docker Desktop app from [here](https://www.docker.com/products/docker-desktop/). The CLI tools should be automatically installed alongside the app.

After it's installed, boot Docker Desktop and verify that it's running and accessible from the command line.

```
docker --version
```

### SDK version manager

Many SDK version managers will work just fine, but `asdf` is a great pluggable one that supports multiple languages.

You can install `asdf` by following the getting started instructions [here](https://asdf-vm.com/guide/getting-started.html)

Autocompletions are nice to have, but not required to get everything running. Feel free to skip that configuration step.

#### NodeJS plugin

Install the `asdf-nodejs` plugin by following the getting started instructions [here](https://github.com/asdf-vm/asdf-nodejs).

Cross-compatibility with `nvm` is nice, so adding the following to `$HOME/.asdfrc` is recommended:

```
legacy_version_file = yes
```

### Ollama

Ollama is an open-source tool that enables users to run large language models (LLMs) like Llama, Mistral, and Gemma directly on their local machines. The easiest method to install Ollama is by following the download instructions [here](https://ollama.com/download).

Note that if you're on MacOS and you've already installed Homebrew you can instead run:

```
brew install ollama
```

The `ollama` binary can serve LLM responses from a variety of models that can be each be downloaded from [here](https://ollama.com/search).

The `ollama` binary can be daemonized if using Homebrew with:

```
brew services start ollama
```

You will want to pull at least:

* `nomic-embed-text` [here](https://ollama.com/library/nomic-embed-text) which powers our embed vector generation

E.g.

```
ollama pull nomic-embed-text
```

If the `ollama` daemon is running, just having the model present should be sufficient, you don't need to serve it explicitly.


2 DOCKER FILES THAT MATTER

CICD


docker compose --profile infra up -d


make init
vs make install


make infra
make migrate
make seed


make local

vs

make build/staging


docker compose --profile staging down



## Local infrastructure - OUT OF DATE




We run some dependencies as part of the Companion Intelligence service.
For local development you'll want to have a version of these running.
To spin up your local infrastructure you will need Docker and Docker compose installed.

Executing the following command will spin up:

* A PostgreSQL database
* An Nginx reverse proxy
* ... more to come

```
docker compose --profile local up -d
```

You can additionally spin up tooling / monitoring with:

```
docker compose --profile tools up -d
```

This will spin up:

* The OpenSearch management dashboard
* The Open WebUI LLM interface that communicates with the `ollama` service

### Hostfile

You'll want to edit your hostfile so that `dev.companionintelligence.com` resolves to 127.0.0.1.

## Running the application

Now that you have prerequisites installed and the local infrastructure running you should be able to run:

```bash
make init
```

```bash
make infra
```

To initialize the repository requirements.

```bash
make install
```

To install repository dependencies.

```bash
make migrate
```

To execute any database migrations.

```bash
make dev
```

To boot the development environment.

You may additionally want to check the README files for each of our development services.

* Backend (api) [README](backend/apps/api/README.md)
* Frontend (web) [README](frontend/apps/web/README.md)

## Exercising the application

You should now be able to view the application at:

[dev.companionintelligence.com](http://dev.companionintelligence.com)

If you run the seeding scripts can you login using john.smith@example.com / companion .

## Available Commands

### Root Level Commands

From the project root, you can run:

```bash
# Development workflow
make help          # List all available make commands
make init          # Initialize repository after checkout
make install       # Install project dependencies
make migrate       # Run database migrations
make dev          # Start development environment with tmux

# Linting
yarn lint         # Run ESLint across the workspace
```

### Backend API Commands (`backend/apps/api`)

Navigate to `backend/apps/api` and run:

```bash
# Development
yarn dev                    # Start development server with nodemon
yarn dev:pretty            # Start dev server with pretty-printed logs

# Database operations
yarn migrate               # Run latest database migrations
yarn migrate:make <name>   # Create a new migration file
yarn migrate:rollback     # Rollback the last migration

# Code quality
yarn lint:circular-imports # Check for circular import dependencies

# Database seeding
npx ts-node scripts/seed-database.ts  # Seed database with test data
```


### Available Scripts

#### Database Seeding
```bash
# Seed database with test data
npx ts-node scripts/seed-database.ts
```

### Frontend Web App Commands (`frontend/apps/web`)

Navigate to `frontend/apps/web` and run:

```bash
# Development
yarn dev          # Start Vite development server
yarn build        # Build for production (TypeScript + Vite)
yarn preview      # Preview production build locally
```

### Docker Commands

```bash
# Local development infrastructure
docker compose --profile local up -d     # Start core services (PostgreSQL, Nginx)
docker compose --profile local down      # Stop core services

# Development tools
docker compose --profile tools up -d     # Start monitoring tools (OpenSearch dashboard, Open WebUI)
docker compose --profile tools down      # Stop monitoring tools

# View logs
docker compose logs -f                   # Follow all container logs
docker compose logs -f <service-name>    # Follow specific service logs

# Container management
docker compose ps                        # List running containers
docker compose restart <service-name>    # Restart specific service
```

### Job Queue System

The backend includes a comprehensive job queue system powered by PG-Boss. See [backend/apps/api/JOB_QUEUE_README.md](backend/apps/api/JOB_QUEUE_README.md) for detailed documentation.

Key features:
- AI processing jobs (embeddings, analysis)
- Scheduled recurring tasks
- Job monitoring and management
- Dead letter queue handling
- Real-time job status tracking

### Package Structure

This is a Yarn workspace monorepo with the following structure:

```
├── backend/apps/
│   └── api/                    # Main backend API service (Feathers.js)
├── frontend/apps/
│   ├── web/                    # Main web application (React + Vite)
│   └── native/                 # Future native app
└── frontend/packages/
    ├── common/                 # Shared components and utilities
    └── thingo/                 # Additional shared package
```

### Environment Setup

1. **Node.js Version**: This project uses Node.js v22 (see [.nvmrc](.nvmrc))
2. **Package Manager**: Yarn v4.9.1 (configured with Corepack)
3. **Database**: PostgreSQL with pgvector extension
4. **Development Tools**:
   - ESLint for code linting
   - Prettier for code formatting
   - TypeScript for type safety
   - Vite for frontend bundling

### CI/CD

GitHub Actions workflows are configured for:
- **Linting**: Runs ESLint on push/PR to main branch

### Architecture Overview

- **Backend**: Feathers.js API with Knex.js for database operations
- **Frontend**: React SPA with modern UI components (Radix UI, Tailwind CSS)
- **Database**: PostgreSQL with vector embeddings support
- **Queue System**: PG-Boss for background job processing
- **AI Integration**: Ollama for local LLM processing

### Development Workflow

1. Start local infrastructure: `docker compose --profile local up -d`
2. Install dependencies: `make install`
3. Run migrations: `make migrate`
4. Start development servers: `make dev`
5. Access the application at `dev.companionintelligence.com`

The `make dev` command starts both backend and frontend in a tmux session for convenient development.

## Proposed folder structure

Backend

- ***api*** - Feathers API server - OpenAPI and/or GraphQL
    - ***database*** - Everything needed to setup the OpenSearch Database
    - ***chron*** - schedule server for Data ETL into digital memory, scheduled jobs for questions, insights, actions etc
- ***agent*** - llm and rag server for making lang queries into the OpenSearch database

Frontend

- ***client*** - front end web code - TS / Tailwind / React
    - ***native*** - capacitor / electron code for mobile and desktop
    - ***xr*** - unity and threejs code

Other

- ***ops*** - K8s and OS Distro build tools
    - ***queue** - some worker scheduler
- ***dev*** - dev setup tools
