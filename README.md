## COPYRIGHT COMPANION INTELLIGENCE - LIFESCOPE INC

## DO NOT DISTRIBUTE

## PRIVATE AND CONFIDENTIAL

# CI Server - Front + Back End API + Web Monorepo

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

## Getting started

### Install prerequisites

#### Homebrew

If you're on MacOS, install Homebrew with the instructions found [here](https://brew.sh/).

#### Docker

You'll want to install Docker on your machine to run containerized versions of our dependencies during development.
The easiest method here is downloading and installing the Docker Desktop app from [here](https://www.docker.com/products/docker-desktop/).
The CLI tools should be automatically installed alongside the app.

After it's installed, boot Docker Desktop and verify that it's running and accessible from the command line. We don't run "docker compose up" but rather "make local" below will do this work.

```bash
docker --version
```

#### SDK version manager

Many SDK version managers will work just fine, but `asdf` is a great pluggable one that supports multiple languages.

You can install `asdf` by following the getting started instructions [here](https://asdf-vm.com/guide/getting-started.html).

Autocompletions are nice to have, but not required to get everything running. Feel free to skip that configuration step.

##### NodeJS plugin

Install the `asdf-nodejs` plugin by following the getting started instructions [here](https://github.com/asdf-vm/asdf-nodejs).

Cross-compatibility with `nvm` is nice, so adding the following to `$HOME/.asdfrc` is recommended:

```
legacy_version_file = yes
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

You will want to pull at least:

* `nomic-embed-text` from [here](https://ollama.com/library/nomic-embed-text) which powers our embed vector generation
* `gemma3:1b` from [here](https://ollama.com/library/gemma3:1b) which is a low-memory model that works well enough for development

E.g.

```bash
ollama pull nomic-embed-text
```

If the `ollama` daemon is running, just having the model present should be sufficient, you don't need to serve it explicitly.

### Hostfile

You'll want to edit your hostfile so that `dev.companionintelligence.com` resolves to 127.0.0.1.

## Running the application

Now that you have prerequisites installed you should be able to run a few Make commands to get everything booted.

You should first execute:

```bash
make init
```

Which will:
* Ensure you have NodeJS installed and that the version matches what's expected
* Ensure you have Ollama installed, that it is running, and that you've downloaded the minimum required models
* Ensure you have a hostfile entry for dev.companionintelligence.com
* Set up Yarn PnP with the SDKs relevant to our project and configure VSCode to work with them
* Install Yarn dependencies

To then boot the local infrastructure.

```bash
make local
```

This should start:
* A PostgreSQL server which we currently use as a primary database and job queue
* A Minio S3 static file bucket where we upload all static files
* An NGINX reverse proxy that publishes our backend (NodeJS) and frontend (Vite) processes to dev.companionintelligence.com

To then idempotently execute any database migrations.

```bash
make migrate
```

To then idempotently seed the database:

```bash
make seed
```

To then idempotently index the database and enable searching:

```bash
make index
```

To then boot the development environment.

```bash
make dev
```

Note that `make dev` requires `tmux` to be installed.

```
brew install tmux
```

This is not required and you can instead run the applications manually following the instructions in the READMEs for each of our services.
Running services individually can be preferable for examining log scrollback, etc.

* Backend (api) [README](backend/apps/api/README.md)
* Frontend (web) [README](frontend/apps/web/README.md)

## Exercising the application

You should now be able to view the application at:

[dev.companionintelligence.com](http://dev.companionintelligence.com)

If you have run `make seed`, you can login using the credentials:

```
Username: jsmith@example.com
Password: ]60.a6{CJ}lB*rHAp;w;
```

## Available commands

### Root level

From the project root, you can run:

```bash
make
```

To show all available make commands.

Or

```bash
yarn lint
```

To execute repository-wide linting.

#### Useful development commands

To generate a stable access token (24 hour expiration) for a user use:

```
make gentoken
```

And provide the user's email address. If they exist in the database you should get an access token printed.

### Backend API Commands (`backend/apps/api`)

Navigate to `backend/apps/api` and run:

```bash
# Development
yarn dev                    # Start development server with nodemon
yarn dev:pretty             # Start development server with nodemon and pretty-printed logs

# Database operations
yarn migrate:make <name>    # Create a new migration file
yarn migrate:rollback       # Rollback the last migration

# Code quality
yarn lint:circular-imports  # Check for circular import dependencies
```

### Frontend SPA commands (`frontend/apps/web`)

Navigate to `frontend/apps/web` and run:

```bash
yarn dev          # Start Vite development server
```

### Docker useful commands

```
# View logs
docker compose logs -f                   # Follow all container logs
docker compose logs -f <service-name>    # Follow specific service logs

# Container management
docker compose ps                        # List running containers
docker compose restart <service-name>    # Restart specific service
```


### Tool Use 
Right now, the LLM has limited access to tools. There are two tools developed, one for getting user preferences and one for getting family members. The LLM itself has discression over when and how to use the tools, but it seems to have a strong preference for the family member tool which is now disabled. 

Tools are defined in `backend/apps/api/src/domains/llm/tools`.
