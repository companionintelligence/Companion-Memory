"""
Document parser endpoint.

FastAPI app that extracts text from uploaded documents using MarkItDown.
Returns a normalized ParsedDocument for downstream chunking and indexing.
Runs on port 8002 alongside the summary API.
"""

import os
import re
import tempfile
import uuid
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from markitdown import MarkItDown
from pydantic import BaseModel

PARSER_VERSION = "1.0.0"

app = FastAPI(
    title="CI Parser Service",
    version=PARSER_VERSION,
    description="Extracts text from uploaded documents and returns a normalized ParsedDocument.",
)

_md = MarkItDown()

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
    title: Optional[str] = None
    text: str
    metadata: Dict[str, Any] = {}


class ParserInfo(BaseModel):
    name: str
    version: str


class ParsedDocument(BaseModel):
    parser: ParserInfo
    title: Optional[str] = None
    language: Optional[str] = None
    sections: List[Section]
    warnings: List[str]


@app.get("/health")
def health() -> Dict[str, str]:
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

    suffix = _extension_for_mime(mime_type)
    warnings: List[str] = []

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = tmp.name
        try:
            content = await file.read()
            tmp.write(content)
            tmp.flush()

            try:
                result = _md.convert(tmp_path)
                markdown_text = result.text_content or ""
            except Exception as exc:
                raise HTTPException(
                    status_code=422,
                    detail=f"Extraction failed: {exc}",
                ) from exc

            if not markdown_text.strip():
                warnings.append("Extractor produced no text content")

            sections = _split_into_sections(markdown_text, warnings)
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


def _split_into_sections(markdown: str, warnings: List[str]) -> List[Section]:
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

    sections: List[Section] = []

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


def _extract_title(sections: List[Section]) -> Optional[str]:
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
