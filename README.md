# CI Server

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


## Local infrastructure

We run some dependencies as part of the Companion Intelligence service.
For local development you'll want to have a version of these running.
To spin up your local infrastructure you will need Docker and Docker compose installed.

Executing the following command will spin up:

* A PostgreSQL database (with pgvector extension enabled)
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

You should now be able to view the application at:

[dev.companionintelligence.com](http://dev.companionintelligence.com)

----------------

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
