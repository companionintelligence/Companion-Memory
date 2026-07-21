# PRD: Asynchronous Document Parsing and Search

| Field | Value |
|---|---|
| **Status** | Draft |
| **Date** | 2026-04-03 |
| **Author(s)** | @max, @codex |
| **Reviewers** | TBD |
| **Feature** | TBD |
| **Target Release** | 2026-Q2 |

## Problem Statement

CI-Server currently stores uploaded files in S3/Minio and indexes only file metadata such as filename and MIME type. It does not extract document text, chunk it, or make it searchable. As a result, uploaded PDFs, DOCX files, spreadsheets, receipts, and notes are opaque blobs: users can retrieve them, but cannot search within them or use them as grounded context for LLM responses.

Leaving this unsolved limits the value of the file upload feature, reduces hybrid search recall, and prevents uploaded documents from participating in retrieval-augmented generation workflows.

## Goals & Success Metrics

- Automatically extract text from supported uploaded documents after upload.
- Chunk extracted text and index chunks into the existing search pipeline.
- Generate embeddings for chunks using the existing `EmbeddingGenerationService` and `nomic-embed-text`.
- Make document content discoverable through existing hybrid search.
- Surface enough source metadata for users and downstream LLM workflows to identify which document and section a result came from.
- `>90%` of supported uploaded documents produce non-empty extracted text within 30 seconds of upload under normal load.
- Hybrid search recall improves measurably for queries that match document body text rather than filename metadata.
- Parsed document chunks are available for LLM retrieval without requiring a separate ingestion workflow.

## Non-Goals

- Building a document editor or rich document viewer.
- Real-time collaborative editing.
- Full replacement for OCR/PDF-specialist tools such as PaddleOCR or Stirling-PDF.
- Parsing audio, video, CAD, or arbitrary binary formats in the initial release.
- High-fidelity document rendering; the goal is searchable text extraction.

## Investigation Summary

The current backend already has the right async primitives: files are uploaded through the Files domain, downstream work is handled through the `pg-boss` event system, and search indexing already exists for files and content. The main gap is that no post-upload parser extracts document body text.

A repo review found an important schema discrepancy: historical docs mention `document_chunks`, but the current migration set drops `ci.document_chunks` and `ci.facts`. This PRD therefore assumes the feature will introduce a new persisted chunk store for uploaded file content rather than relying on an active existing table.

For extraction, the preferred direction is a Python-based parser service using [MarkItDown](https://github.com/microsoft/markitdown). This fits the repo's existing pattern of shipping Python sidecars, supports common office formats, and avoids pulling large document parsing stacks into the NestJS runtime. Initial OCR for scanned PDFs is deferred; the design should leave room for later integration via MarkItDown OCR/plugin support or marketplace OCR services.

## User Stories / Use Cases

As a user, I want to upload a PDF and later search for a phrase inside it so that I can find documents by their contents.

As a user, I want uploaded DOCX, XLSX, CSV, and text files to become part of my searchable knowledge base so that file format does not determine discoverability.

As a user, I want the LLM to reference my uploaded document content when answering questions so that answers are grounded in my own data.

As a user, I want search results to show which document and section a match came from so that I can navigate back to the source.

As a user, I want parsing to happen asynchronously after upload so that large files do not block the upload flow.

## Requirements

### Functional Requirements

- The system must enqueue document parsing automatically after a supported file upload completes.
- The initial supported formats must include `PDF`, `DOCX`, `XLSX`, `CSV`, and plain text.
- The parser must download file bytes from S3/Minio and extract normalized markdown or plain text.
- The system must split extracted content into chunks using a deterministic chunking strategy with overlap.
- Each chunk must store:
  - owning `file_id`
  - chunk index
  - extracted text/markdown
  - optional section or page metadata
  - parse metadata needed for traceability
- Each chunk must be indexed into the existing keyword and embedding search pipeline.
- Search results must be able to return chunk-level hits and identify the parent file.
- The file record must expose parse lifecycle state such as `processing`, `completed`, `failed`, or `skipped`, plus error details for failures.
- Re-uploading or updating a file with the same stored object must not create duplicate chunk records.
- Parsing must be retryable from the job system.
- The initial LLM integration must reuse the existing search path for retrieval rather than introducing a separate bespoke retrieval stack.

### Non-Functional Requirements

- Upload latency must remain bounded by storage only; parsing must not run inline on the upload request.
- The pipeline must be idempotent and safe under retries.
- Parsing failures must not break file uploads or unrelated indexing flows.
- The system must support at least 10 concurrent parse jobs without blocking existing queue consumers.
- Chunk indexing must complete within 30 seconds for at least 90% of supported documents under typical development/staging workloads.
- The parser boundary must be versioned so future extractor changes can trigger controlled reprocessing.
- Access control for chunks must remain consistent with file ownership and existing search visibility rules.

## Design & UX

The initial UX should reuse existing surfaces rather than introduce a new documents area. Files continue to appear in the Files page and File modal. The file detail surface should show parse status, and search results should display the parent filename plus section/page context when available.

No advanced document viewer is required for V1. A simple extracted-text preview or "search matched this section" treatment is sufficient if needed.

## Dependencies

- `backend/apps/api` for file lifecycle, queue orchestration, search indexing, and GraphQL/API changes.
- S3/Minio for source file retrieval.
- PostgreSQL and `pgvector` for chunk persistence and embeddings.
- `pg-boss` for asynchronous parse execution.
- Ollama `nomic-embed-text` via `EmbeddingGenerationService`.
- A new Python parser service or worker using MarkItDown.
- Existing search modules in `search-ingress` and `search-next`.

## Risks & Open Questions

- Current migrations removed historical chunk tables, so the persistence model needs to be reintroduced deliberately.
- Chunk size and overlap need calibration to balance recall, precision, and storage cost.
- OCR for scanned PDFs is not included in V1; this will limit recall for image-only documents.
- ETL-created external files currently persist mostly metadata, not durable bytes; V1 should focus on uploaded files stored in object storage.
- Search result UX needs a clear model for mixing file-level and chunk-level hits.
- It remains open whether spreadsheet extraction should preserve sheet/tab metadata in V1 or flatten all content.

## Timeline & Milestones

1. Design and schema alignment: confirm chunk storage model, file parse status fields, and queue/event contract.
2. Parser service implementation: stand up MarkItDown-based service with supported format extraction and structured responses.
3. Backend integration: enqueue parse jobs after upload, persist chunks, generate embeddings, and index keyword vectors.
4. Search integration: return chunk-origin metadata and validate recall improvements.
5. UX integration: show parse status and source attribution in file/search surfaces.
6. Hardening: retries, observability, reprocessing path, and performance validation.

## References

- [Files domain](/Users/max/Code/CompInt/CI-Server/backend/apps/api/src/domains/files)
- [Search ingress](/Users/max/Code/CompInt/CI-Server/backend/apps/api/src/domains/search-ingress)
- [Search next](/Users/max/Code/CompInt/CI-Server/backend/apps/api/src/domains/search-next)
- [Embeddings](/Users/max/Code/CompInt/CI-Server/backend/apps/api/src/common/embeddings)
- [LLM domain](/Users/max/Code/CompInt/CI-Server/backend/apps/api/src/domains/llm)
- [Dropped chunk/fact migration](/Users/max/Code/CompInt/CI-Server/backend/apps/api/db/postgres/migrations/20260212191500_drop_unused_tables_and_document_chunk_function.sql)
- [MarkItDown](https://github.com/microsoft/markitdown)
