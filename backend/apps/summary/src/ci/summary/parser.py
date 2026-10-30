"""
Document parser endpoint.

FastAPI app that extracts text from uploaded documents using MarkItDown.
Returns a normalized ParsedDocument for downstream chunking and indexing.
Runs on port 8002 alongside the summary API.

Every upload is bounded before and during conversion: the body size here, the
ZIP inflation check and the conversion's time and memory in parser_worker.py.
"""

import asyncio
import os
import re
import shutil
import tempfile
import uuid
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .auth import install_sidecar_auth
from .parser_worker import (
    MAX_UPLOAD_BYTES,
    ConversionFailed,
    ConversionTimeout,
    ConversionWorker,
    archive_problem,
)

PARSER_VERSION = "1.0.0"

app = FastAPI(
    title="CI Parser Service",
    version=PARSER_VERSION,
    description="Extracts text from uploaded documents and returns a normalized ParsedDocument.",
)
install_sidecar_auth(app)

# Room for the multipart framing and the mime_type field around the file.
_MULTIPART_SLACK_BYTES = 1024 * 1024


class _BodyTooLarge(HTTPException):
    def __init__(self) -> None:
        super().__init__(
            status_code=413,
            detail=f"Upload exceeds the parser's {MAX_UPLOAD_BYTES} byte limit",
        )


class LimitRequestBody:
    """
    Refuse a request body over ``max_bytes`` without reading it.

    A declared Content-Length over the limit is answered 413 before a byte of
    the body is read; a chunked body is counted as it arrives and cut off at
    the limit. Starlette spools a multipart upload to disk before the handler
    runs, so a limit checked in the handler would come too late.
    """

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        declared = dict(scope.get("headers") or []).get(b"content-length")

        if (
            declared is not None
            and declared.isdigit()
            and int(declared) > self.max_bytes
        ):
            await _too_large_response()(scope, receive, send)
            return

        received = 0
        exceeded = False
        answered = False

        async def counted() -> Message:
            nonlocal received, exceeded
            message = await receive()

            if message["type"] == "http.request":
                received += len(message.get("body", b""))

                if received > self.max_bytes:
                    exceeded = True
                    raise _BodyTooLarge()

            return message

        async def answer(message: Message) -> None:
            # What the app makes of the exception above depends on what sits
            # between: behind the sidecar auth (a BaseHTTPMiddleware) anyio
            # wraps it in an ExceptionGroup and FastAPI answers 400 "error
            # parsing the body", which the API would retry. The client is owed
            # the 413, so once the limit is passed the app's answer is replaced.
            nonlocal answered

            if not exceeded:
                await send(message)
            elif message["type"] == "http.response.start" and not answered:
                answered = True
                await _too_large_response()(scope, receive, send)

        await self.app(scope, counted, answer)


def _too_large_response() -> JSONResponse:
    return JSONResponse(status_code=413, content={"detail": _BodyTooLarge().detail})


# Added after the auth middleware, so it is the outer one: an oversized body is
# refused before anything else looks at the request.
app.add_middleware(
    LimitRequestBody, max_bytes=MAX_UPLOAD_BYTES + _MULTIPART_SLACK_BYTES
)

_worker = ConversionWorker()

SUPPORTED_MIME_TYPES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",  # docx
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",  # xlsx
    "application/vnd.ms-excel",  # xls
    "text/csv",
    "text/plain",
    "text/markdown",
    "application/msword",  # doc
}


class Section(BaseModel):
    sectionId: str
    title: str | None = None
    text: str
    metadata: dict[str, Any] = {}


class ParserInfo(BaseModel):
    name: str
    version: str


class ParsedDocument(BaseModel):
    parser: ParserInfo
    title: str | None = None
    language: str | None = None
    sections: list[Section]
    warnings: list[str]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": PARSER_VERSION}


@app.post("/parse", response_model=ParsedDocument)
async def parse_file(
    file: UploadFile = File(...),
    mime_type: str = Form(...),
) -> ParsedDocument:
    """
    Parse an uploaded file and return a normalized document structure.

    Accepts any supported document format and extracts text via MarkItDown.
    The response sections preserve heading hierarchy from the source document.
    """
    if mime_type not in SUPPORTED_MIME_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported MIME type: {mime_type}. Supported: {sorted(SUPPORTED_MIME_TYPES)}",
        )

    if file.size is not None and file.size > MAX_UPLOAD_BYTES:
        raise _BodyTooLarge()

    suffix = _extension_for_mime(mime_type)
    warnings: list[str] = []

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = tmp.name

    try:
        # Copied in chunks, off the event loop, never held in memory whole.
        await file.seek(0)
        await asyncio.to_thread(_copy_upload, file, tmp_path)

        problem = await asyncio.to_thread(archive_problem, tmp_path)

        if problem:
            raise HTTPException(
                status_code=413, detail=f"Refusing to extract: {problem}"
            )

        try:
            markdown_text = await _worker.convert(tmp_path)
        except ConversionTimeout as exc:
            raise HTTPException(
                status_code=504, detail=f"Extraction timed out: {exc}"
            ) from exc
        except ConversionFailed as exc:
            raise HTTPException(
                status_code=422, detail=f"Extraction failed: {exc}"
            ) from exc

        if not markdown_text.strip():
            warnings.append("Extractor produced no text content")

        sections = await asyncio.to_thread(
            _split_into_sections, markdown_text, warnings
        )
        title = _extract_title(sections)

        return ParsedDocument(
            parser=ParserInfo(name="markitdown", version=PARSER_VERSION),
            title=title,
            language=None,
            sections=sections,
            warnings=warnings,
        )
    finally:
        os.unlink(tmp_path)


def _copy_upload(upload: UploadFile, path: str) -> None:
    with open(path, "wb") as target:
        shutil.copyfileobj(upload.file, target, 1024 * 1024)


def _split_into_sections(markdown: str, warnings: list[str]) -> list[Section]:
    """
    Split markdown text into sections based on heading boundaries.

    Each heading (# ## ###) starts a new section. Content before the first
    heading is grouped under an implicit root section.
    """
    if not markdown.strip():
        return []

    heading_pattern = re.compile(r"^(#{1,3})\s+(.+)$", re.MULTILINE)
    matches = list(heading_pattern.finditer(markdown))

    if not matches:
        return [
            Section(
                sectionId=str(uuid.uuid4()),
                title=None,
                text=markdown.strip(),
            )
        ]

    sections: list[Section] = []

    if matches[0].start() > 0:
        preamble = markdown[: matches[0].start()].strip()
        if preamble:
            sections.append(
                Section(
                    sectionId=str(uuid.uuid4()),
                    title=None,
                    text=preamble,
                )
            )

    for i, match in enumerate(matches):
        heading_title = match.group(2).strip()
        content_start = match.end()
        content_end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        body = markdown[content_start:content_end].strip()

        if not body and not heading_title:
            continue

        sections.append(
            Section(
                sectionId=str(uuid.uuid4()),
                title=heading_title,
                text=body,
                metadata={"headingLevel": len(match.group(1))},
            )
        )

    if not sections:
        warnings.append("No sections could be extracted from the document")

    return sections


def _extract_title(sections: list[Section]) -> str | None:
    for section in sections:
        if section.title:
            return section.title
    return None


def _extension_for_mime(mime_type: str) -> str:
    mapping = {
        "application/pdf": ".pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "application/vnd.ms-excel": ".xls",
        "application/msword": ".doc",
        "text/csv": ".csv",
        "text/plain": ".txt",
        "text/markdown": ".md",
    }
    return mapping.get(mime_type, ".bin")
