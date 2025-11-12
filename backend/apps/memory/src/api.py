"""FastAPI surface for manual browser-history processing."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel, Field, ConfigDict

from .browser_history_processor import history_processor
from . import __version__


app = FastAPI(
    title="CI Memory Browser History API",
    version=__version__,
    description="Utility endpoints for uploading browser history CSV exports and receiving summaries.",
)


class HistoryEntry(BaseModel):
    date: str
    time: str
    title: str = ""
    url: str = ""
    visit_count: int = Field(default=1, alias="visitCount")
    typed_count: int = Field(default=0, alias="typedCount")
    transition: Optional[str] = None

    model_config = ConfigDict(populate_by_name=True)


class HistoryPayload(BaseModel):
    entries: List[HistoryEntry]
    output_filename: Optional[str] = Field(
        default=None,
        description="Optional relative path for the generated summary CSV.",
    )


@app.post("/history/process-file")
async def process_history_file(
    file: UploadFile = File(...),
    output_filename: Optional[str] = None,
) -> Dict[str, Any]:
    """Accept a CSV upload, summarize it, and return the generated rows."""
    if file.content_type not in ("text/csv", "application/vnd.ms-excel", None):
        raise HTTPException(status_code=400, detail="Only CSV uploads are supported")

    data = await file.read()
    try:
        result = history_processor.process_csv_bytes(
            data,
            output_path=output_filename,
            source_name=file.filename or "upload.csv",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return result


@app.post("/history/process-entries")
async def process_history_entries(payload: HistoryPayload) -> Dict[str, Any]:
    """Process raw JSON payloads without going through the queue or listener."""
    rows = [entry.model_dump(by_alias=True) for entry in payload.entries]

    try:
        result = history_processor.process_entries(
            rows,
            output_path=payload.output_filename,
            source_name="manual-payload",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return result


__all__ = ["app"]
