<p align="center">
  <img width="256" height="256" alt="Companion Memory" src="https://github.com/user-attachments/assets/e8f0d40b-3e84-44ad-85ee-55f677b08cb3" />
</p>

# Companion Memory

**Your personal database and memory brain for Companion Intelligence — running entirely on your own hardware.**

Companion Memory is the private, self-hosted system of record for your digital
life. It captures what you read, say, and do across your apps, stores it in a
personal database that only you control, and turns it into a searchable,
predictive memory your companion can reason over. No cloud. No data brokers.
Just your data, on your device.

[**▶ Install from the Companion store**](https://hub.ci.computer/store/ci-memory)

---

## Watch the demo

<video src="./media/companion-memory-demo.mp4" poster="./media/companion-memory-demo-poster.png" controls width="100%"></video>

> Player not showing? [**Watch the demo »**](./media/companion-memory-demo.mp4)

A short tour of how Companion Memory captures your day, builds a private
knowledge base, and answers questions about your own life — all without a single
request leaving your machine.

---

## What you get

- **A personal database** — PostgreSQL 18 with `pgvector` and TimescaleDB, so
  your time-series activity and semantic vectors live together in one store you
  own outright.
- **A REST + LLM API** — a NestJS backend with JWT authentication and
  tool-calling endpoints, the single interface every Companion client talks to
  at `ci-server.localhost`.
- **Retrieval-augmented memory (RAG)** — ask questions in plain language and get
  answers grounded in *your* captured history, with citations back to the source.
- **On-device behavioral prediction (HBPE)** — the Human Behavioral Prediction
  Engine runs as a local ONNX INT8 sidecar that anticipates your habits and needs
  from your own patterns — never a shared model.
- **Local AI, end to end** — Ollama powers both the language model and the
  embeddings. Nothing is sent to a third-party API.
- **Automatic summarization** — long articles, transcripts, and threads are
  condensed into recall-ready notes in the background.
- **Connectors** — ingest from the CI Browser Extension, CI-Connect,
  CI-Import-Tools, and CI-Applet, and link the accounts you already use —
  Google, GitHub, Spotify, Slack, Discord, Notion, and more.
- **Durable orchestration & background jobs** — long-running workflows keep your
  memory fresh and consistent without manual babysitting.
- **Built-in object storage** — an S3-compatible MinIO bucket holds your files,
  images, and media alongside their metadata.
- **One endpoint** — an NGINX gateway publishes every service behind a single
  port, so the whole appliance is one URL to remember.

---

## See it in action — your first run

The first time you open Companion Memory, a short, friendly setup helps your
companion get to know you. It takes about a minute.

![Companion Memory first-time user experience](./media/companion-memory-ftue.gif)

1. **Welcome** — a quick hello and a note that your companion keeps learning as
   you interact.
2. **Focus areas** — tell it what matters to you right now.
3. **Connect your accounts** — link the services you want remembered.
4. **A few preferences** — food, movies, and activities, so recommendations feel
   like *you* from day one.
5. **Done** — your private memory starts building immediately.

> This is just the beginning — your companion gets sharper the more you use it.

---

## Screenshots

Point your client at a running Companion Memory server:

<img height="150" alt="Point to your Companion Memory server URL" src="https://github.com/user-attachments/assets/ba285919-36cd-435f-946c-912dfbbad034" />

Automatic, guided setup:

<img height="350" alt="Automatic setup" src="https://github.com/user-attachments/assets/e85091a4-3169-40c4-933a-5deabff679ca" />

Choose your memory provider:

<img height="300" alt="Select your memory provider" src="https://github.com/user-attachments/assets/aba17970-b2d2-4842-b268-495bffdde2c8" />

---

## How it works

Companion Memory ships as a small set of containers that come up together with
one install:

| Service        | Role                                                            |
| -------------- | -------------------------------------------------------------- |
| **gateway**    | NGINX reverse proxy — the single public port (8642)            |
| **api**        | NestJS REST/LLM API and authentication                         |
| **database**   | PostgreSQL 18 + pgvector + TimescaleDB + PostGIS                         |
| **summary**    | LLM summarization service (via Ollama)                         |
| **hbpe**       | Behavioral-prediction sidecar (ONNX INT8)                     |
| **orchestrator** | Durable workflow engine for background jobs                  |
| **object-store** | MinIO S3-compatible file storage                            |

Everything reads and writes the same local Postgres instance, and everything
stays on your appliance.

---

## Privacy & ownership

- **Local-first.** Core functionality has zero cloud dependencies.
- **Your data, your disk.** The database, the files, and the models all live on
  hardware you control.
- **No telemetry of your memories.** Your captured life is never the product.

---

## Requirements

- Docker (amd64 or arm64)
- A host with [Ollama](https://ollama.com) available for local LLM and embeddings
- Runs alongside other Companion apps installed from the Hub

---

## Part of Companion Intelligence

Companion Memory is the memory layer of the Companion Intelligence appliance. It
receives data from CI-Browser-Extension, CI-Connect, CI-Import-Tools, and
CI-Applet, and is consumed by every client over REST/GraphQL.

---

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**
