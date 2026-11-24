"""
The process that runs MarkItDown for the parser, and the limits around it.

MarkItDown used to run inside the parser's request handler, on its event
loop, with nothing bounding it. A DOCX whose XML inflates to gigabytes got the
whole parser OOM-killed, and a slow PDF blocked every other parse behind it.
Conversion now happens in one long-lived child process:

- the child caps its own address space (``RLIMIT_AS``), so a document that
  needs too much memory fails that document instead of the container;
- the parent waits a bounded time and kills the child when it is up, which a
  thread could never be (``asyncio.wait_for`` on ``to_thread`` returns, but the
  conversion keeps running);
- the child is replaced after a timeout, a crash or a ``MemoryError``.

ZIP-based uploads (DOCX, XLSX, or anything that sniffs as a ZIP) are measured
before they are converted, from the central directory: Python's ``zipfile``,
which MarkItDown and its converters read with, never inflates a member past
the size its header declares.

Only stdlib is imported at module level. The child imports MarkItDown itself,
so importing this module in the API process costs nothing.
"""

from __future__ import annotations

import asyncio
import multiprocessing
import os
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from multiprocessing.connection import Connection
from typing import Any

# The largest upload the parser reads. The API posts whole files it already
# holds in memory; past this the document is not parsed for search at all.
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
# For ZIP-based files: the most the members may add up to once inflated, how
# many members there may be, and how far the archive may inflate relative to
# its own size. Real DOCX/XLSX inflate 5-20x; a decompression bomb, 1000x.
MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 10_000
MAX_COMPRESSION_RATIO = 100
# Per document, once its turn comes.
CONVERT_TIMEOUT_SECONDS = 120.0
# The child's address space. A worker with MarkItDown loaded maps about 1.4 GB
# before it reads anything; the rest is the document's.
CONVERT_MEMORY_BYTES = 4 * 1024 * 1024 * 1024

_CONTEXT = multiprocessing.get_context("spawn")


def archive_problem(
    path: str,
    *,
    max_uncompressed: int = MAX_UNCOMPRESSED_BYTES,
    max_members: int = MAX_ARCHIVE_MEMBERS,
    max_ratio: float = MAX_COMPRESSION_RATIO,
) -> str | None:
    """Why the ZIP at ``path`` must not be converted, or None (also for a non-ZIP)."""
    if not zipfile.is_zipfile(path):
        return None

    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
    except (zipfile.BadZipFile, OSError, ValueError) as exc:
        return f"unreadable archive: {exc}"

    if len(members) > max_members:
        return f"archive has {len(members)} members (limit {max_members})"

    inflated = sum(member.file_size for member in members)

    if inflated > max_uncompressed:
        return f"archive inflates to {inflated} bytes (limit {max_uncompressed})"

    size = max(os.path.getsize(path), 1)

    if inflated / size > max_ratio:
        return (
            f"archive inflates {inflated / size:.0f}x its size (limit {max_ratio:.0f}x)"
        )

    return None


class ConversionTimeout(Exception):
    """The document did not finish converting in time; the child was killed."""


class ConversionFailed(Exception):
    """MarkItDown raised, ran out of memory, or the child died."""


def _new_markitdown() -> Any:
    # Only the converters for formats the parser advertises. The built-in set
    # also sniffs content and recurses into ZIPs, transcribes audio through a
    # web API and fetches URLs, none of which a document upload should reach.
    from markitdown import PRIORITY_GENERIC_FILE_FORMAT, MarkItDown
    from markitdown.converters import (
        CsvConverter,
        DocxConverter,
        PdfConverter,
        PlainTextConverter,
        XlsConverter,
        XlsxConverter,
    )

    markitdown = MarkItDown(enable_builtins=False)
    markitdown.register_converter(
        PlainTextConverter(), priority=PRIORITY_GENERIC_FILE_FORMAT
    )

    # Typed as Any: markitdown ships no annotations for these constructors.
    specific: tuple[Any, ...] = (
        DocxConverter,
        XlsxConverter,
        XlsConverter,
        PdfConverter,
        CsvConverter,
    )

    for converter in specific:
        markitdown.register_converter(converter())

    return markitdown


def serve(conn: Connection, memory_bytes: int) -> None:
    """Child process: convert each path received on ``conn`` until it closes."""
    import resource

    # Never above a hard limit the container already set: raising one is an
    # error, and a child that dies here fails every document as a 422.
    _, hard = resource.getrlimit(resource.RLIMIT_AS)
    limit = memory_bytes if hard == resource.RLIM_INFINITY else min(memory_bytes, hard)
    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    markitdown = _new_markitdown()

    while True:
        try:
            path = conn.recv()
        except EOFError:
            return

        try:
            text = markitdown.convert(path).text_content or ""
        except MemoryError:
            # The heap may be in any state after this. "fatal" tells the parent
            # this child is done, so the next document gets a fresh one.
            conn.send(
                ("fatal", "the document needs more memory than the parser allows")
            )
            return
        except Exception as exc:  # every failure here is this document's
            conn.send(("error", str(exc) or exc.__class__.__name__))
            continue

        conn.send(("ok", text))


@dataclass
class _Child:
    process: Any
    conn: Connection


class ConversionWorker:
    """Runs conversions one at a time in a child process, replacing it when needed."""

    def __init__(
        self,
        *,
        target: Callable[[Connection, int], None] = serve,
        memory_bytes: int = CONVERT_MEMORY_BYTES,
    ) -> None:
        self._target = target
        self._memory_bytes = memory_bytes
        self._child: _Child | None = None
        self._lock = asyncio.Lock()

    def _start(self) -> _Child:
        parent, child_end = _CONTEXT.Pipe()
        process = _CONTEXT.Process(
            target=self._target, args=(child_end, self._memory_bytes), daemon=True
        )
        process.start()
        child_end.close()
        return _Child(process, parent)

    def _stop(self) -> None:
        child, self._child = self._child, None

        if child is None:
            return

        child.conn.close()

        if child.process.is_alive():
            child.process.kill()

        child.process.join(timeout=5)

    async def convert(self, path: str, seconds: float = CONVERT_TIMEOUT_SECONDS) -> str:
        async with self._lock:
            if self._child is None or not self._child.process.is_alive():
                self._stop()
                self._child = await asyncio.to_thread(self._start)

            child = self._child
            child.conn.send(path)

            try:
                status, payload = await self._reply(child, seconds)
            except asyncio.CancelledError:
                # Cancelled while the child still works on this path. Its answer
                # would sit in the pipe and be read as the NEXT document's text,
                # so this child goes, and the next document gets a fresh one.
                self._stop()
                raise

            if status == "fatal":
                await asyncio.to_thread(self._stop)

            if status != "ok":
                raise ConversionFailed(payload)

            return payload

    async def _reply(self, child: _Child, seconds: float) -> tuple[str, str]:
        # poll() also returns once the child has died and closed its end.
        if not await asyncio.to_thread(child.conn.poll, seconds):
            await asyncio.to_thread(self._stop)
            raise ConversionTimeout(f"conversion took longer than {seconds:.0f}s")

        try:
            reply: tuple[str, str] = await asyncio.to_thread(child.conn.recv)
        except (EOFError, OSError):
            await asyncio.to_thread(self._stop)
            raise ConversionFailed(
                "the parser process exited while converting (out of memory or crashed)"
            ) from None

        return reply

    def close(self) -> None:
        self._stop()
