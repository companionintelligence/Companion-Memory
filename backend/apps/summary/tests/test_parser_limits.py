"""Size, inflation and time limits on the document parser."""

from __future__ import annotations

import asyncio
import io
import os
import sys
import zipfile
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.testclient import TestClient

from ci.summary import parser as parser_module
from ci.summary.config import settings
from ci.summary.parser import LimitRequestBody, app
from ci.summary.parser_worker import (
    MAX_COMPRESSION_RATIO,
    ConversionFailed,
    ConversionTimeout,
    ConversionWorker,
    _new_markitdown,
    archive_problem,
)

# The fake conversion targets must be importable by name in a spawned child,
# which inherits sys.path but not pytest's importlib-mode module registry.
sys.path.insert(0, str(Path(__file__).parent))
import _parser_fakes

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
AUTH = {"Authorization": "Bearer s3cret"}


def _docx_bytes(paragraph: str = "Hello world", padding: bytes = b"") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
            'officeDocument" Target="word/document.xml"/></Relationships>',
        )
        archive.writestr(
            "word/document.xml",
            '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body><w:p><w:r><w:t>{paragraph}</w:t></w:r></w:p></w:body></w:document>",
        )
        if padding:
            archive.writestr("word/media/padding.bin", padding)
    return buffer.getvalue()


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(settings, "sidecar_auth_secret", "s3cret")
    return TestClient(app)


# ── archive checks ────────────────────────────────────────────


def test_a_real_docx_passes_the_archive_check(tmp_path: Path) -> None:
    path = tmp_path / "ok.docx"
    path.write_bytes(_docx_bytes())
    assert archive_problem(str(path)) is None


def test_a_file_that_is_not_a_zip_is_not_an_archive_problem(tmp_path: Path) -> None:
    path = tmp_path / "plain.txt"
    path.write_text("just text")
    assert archive_problem(str(path)) is None


def test_an_archive_that_inflates_far_past_its_size_is_refused(tmp_path: Path) -> None:
    # 20 MB of zeros deflates to about 20 KB: the shape of a decompression bomb.
    path = tmp_path / "bomb.docx"
    path.write_bytes(_docx_bytes(padding=bytes(20 * 1024 * 1024)))
    problem = archive_problem(str(path))
    assert problem is not None and f"limit {MAX_COMPRESSION_RATIO}x" in problem


def test_an_archive_that_inflates_past_the_total_limit_is_refused(
    tmp_path: Path,
) -> None:
    path = tmp_path / "large.docx"
    path.write_bytes(_docx_bytes(padding=os.urandom(4096)))
    problem = archive_problem(str(path), max_uncompressed=4000)
    assert problem is not None and "limit 4000" in problem


def test_an_archive_with_too_many_members_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "many.zip"
    with zipfile.ZipFile(path, "w") as archive:
        for index in range(6):
            archive.writestr(f"part{index}.xml", "<x/>")
    assert (
        archive_problem(str(path), max_members=5) == "archive has 6 members (limit 5)"
    )


# ── the conversion child ─────────────────────────────────────


def test_a_conversion_that_runs_too_long_is_killed_and_reported() -> None:
    worker = ConversionWorker(target=_parser_fakes.echo)
    try:
        with pytest.raises(ConversionTimeout):
            asyncio.run(worker.convert("/tmp/hang.pdf", seconds=1.0))
        assert worker._child is None  # killed, not left running
        # The next document gets a fresh child.
        assert asyncio.run(worker.convert("/tmp/next.pdf", seconds=30)).startswith(
            "converted /tmp/next.pdf"
        )
    finally:
        worker.close()


def test_a_child_that_dies_mid_conversion_is_replaced() -> None:
    worker = ConversionWorker(target=_parser_fakes.echo)
    try:
        first = asyncio.run(worker.convert("/tmp/a.pdf", seconds=30))
        with pytest.raises(ConversionFailed, match="exited while converting"):
            asyncio.run(worker.convert("/tmp/crash.pdf", seconds=30))
        second = asyncio.run(worker.convert("/tmp/b.pdf", seconds=30))
        assert first.split(" in ")[1] != second.split(" in ")[1]  # a different process
    finally:
        worker.close()


def test_a_cancelled_conversion_never_answers_the_next_document() -> None:
    worker = ConversionWorker(target=_parser_fakes.echo)

    async def scenario() -> str:
        # Warm the child first so the cancel lands while it converts.
        await worker.convert("/tmp/warm.pdf", seconds=30)
        slow = asyncio.create_task(worker.convert("/tmp/slow.pdf", seconds=30))
        await asyncio.sleep(0.5)
        slow.cancel()
        with pytest.raises(asyncio.CancelledError):
            await slow
        return await worker.convert("/tmp/next.pdf", seconds=30)

    try:
        assert asyncio.run(scenario()).startswith("converted /tmp/next.pdf")
    finally:
        worker.close()


def test_a_conversion_that_runs_out_of_memory_fails_that_document_only() -> None:
    worker = ConversionWorker(target=_parser_fakes.echo)
    try:
        with pytest.raises(ConversionFailed, match="more memory"):
            asyncio.run(worker.convert("/tmp/memory.pdf", seconds=30))
        assert asyncio.run(worker.convert("/tmp/c.pdf", seconds=30)).startswith(
            "converted /tmp/c.pdf"
        )
    finally:
        worker.close()


def _pdf_bytes(text: str) -> bytes:
    """A one-page PDF with ``text`` on it, xref offsets and all."""
    stream = f"BT /F1 24 Tf 72 700 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R"
        b" /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % number + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for offset in offsets:
        out.write(b"%010d 00000 n \n" % offset)
    out.write(
        b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objects) + 1, xref)
    )
    return out.getvalue()


def test_the_narrowed_converters_read_every_advertised_format_as_before(
    tmp_path: Path,
) -> None:
    import openpyxl
    from markitdown import MarkItDown

    workbook = openpyxl.Workbook()
    workbook.active.append(["name", "amount"])
    workbook.active.append(["tea", 3])
    xlsx = io.BytesIO()
    workbook.save(xlsx)

    samples = {
        ".pdf": _pdf_bytes("Invoice total 42"),
        ".docx": _docx_bytes("Docx words"),
        ".xlsx": xlsx.getvalue(),
        ".csv": b"name,amount\ntea,3\n",
        ".txt": b"plain words\nsecond line\n",
        ".md": b"# Heading\n\nbody text\n",
    }
    full, narrow = MarkItDown(), _new_markitdown()

    for suffix, data in samples.items():
        path = tmp_path / f"sample{suffix}"
        path.write_bytes(data)
        expected = full.convert(str(path)).text_content
        assert expected.strip(), suffix
        assert narrow.convert(str(path)).text_content == expected, suffix


def test_the_narrowed_converters_never_open_a_zip(tmp_path: Path) -> None:
    # The full set converts every member of a ZIP, recursively; an upload must
    # not get there by sniffing as one.
    from markitdown import MarkItDown, UnsupportedFormatException

    path = tmp_path / "bundle.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("notes.txt", "inside the zip")

    assert "inside the zip" in MarkItDown().convert(str(path)).text_content
    with pytest.raises(UnsupportedFormatException):
        _new_markitdown().convert(str(path))


def test_the_child_runs_under_the_address_space_limit_it_is_given(
    tmp_path: Path,
) -> None:
    # A 64 MB cap is too small to load MarkItDown at all, so the conversion must
    # fail rather than run unbounded. Not 512 MB: what MarkItDown maps grows by
    # about 40 MB per CPU (815 MB on 2 CPUs, 1.4 GB on 16), and on the 4-vCPU
    # CI runner it loads and converts under 512 MB. Caps from 256 MB up pass or
    # fail by core count, and near the line the child can hang to the timeout.
    path = tmp_path / "doc.docx"
    path.write_bytes(_docx_bytes())
    worker = ConversionWorker(memory_bytes=64 * 1024 * 1024)
    try:
        with pytest.raises(ConversionFailed):
            asyncio.run(worker.convert(str(path), seconds=60))
    finally:
        worker.close()


# ── the request body limit ───────────────────────────────────


def _limited_app(
    max_bytes: int, reached: list[str], *, http_middleware: bool = False
) -> FastAPI:
    small = FastAPI()

    @small.post("/upload")
    async def upload(file: UploadFile = File(...)) -> dict[str, int]:
        reached.append(file.filename or "")
        return {"size": len(await file.read())}

    if http_middleware:
        # The shape of the sidecar auth: a BaseHTTPMiddleware inside the limit.
        @small.middleware("http")
        async def passthrough(request: Request, call_next: Any) -> Any:
            return await call_next(request)

    small.add_middleware(LimitRequestBody, max_bytes=max_bytes)
    return small


def test_a_declared_length_over_the_limit_is_refused_before_the_body_is_read() -> None:
    reached: list[str] = []
    response = TestClient(_limited_app(1_000, reached)).post(
        "/upload", files={"file": ("big.bin", b"x" * 5_000)}
    )
    assert response.status_code == 413
    assert reached == []


def test_a_declared_length_over_the_limit_is_answered_without_reading_at_all() -> None:
    received: list[object] = []
    sent: list[dict[str, object]] = []

    async def app_never_called(scope: object, receive: object, send: object) -> None:
        raise AssertionError("the app saw an oversized request")

    async def receive() -> dict[str, object]:
        received.append("read")
        return {"type": "http.request", "body": b"x" * 10, "more_body": True}

    async def send(message: dict[str, object]) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/parse",
        "headers": [(b"content-length", b"5000")],
    }
    asyncio.run(
        LimitRequestBody(app_never_called, max_bytes=1_000)(scope, receive, send)
    )

    assert sent[0]["status"] == 413
    assert received == []


@pytest.mark.parametrize("http_middleware", [False, True])
def test_a_chunked_body_is_cut_off_at_the_limit(http_middleware: bool) -> None:
    reached: list[str] = []

    def chunks():
        boundary = b"--b\r\n"
        yield (
            boundary
            + b'Content-Disposition: form-data; name="file"; filename="big.bin"\r\n\r\n'
        )
        for _ in range(10):
            yield b"x" * 1_000
        yield b"\r\n--b--\r\n"

    app_under_test = _limited_app(4_000, reached, http_middleware=http_middleware)
    response = TestClient(app_under_test).post(
        "/upload",
        content=chunks(),
        headers={"Content-Type": "multipart/form-data; boundary=b"},
    )
    # Behind a BaseHTTPMiddleware the app itself answers 400; still a 413 here.
    assert response.status_code == 413
    assert "byte limit" in response.json()["detail"]
    assert reached == []


def test_a_body_under_the_limit_is_untouched() -> None:
    reached: list[str] = []
    response = TestClient(_limited_app(10_000, reached)).post(
        "/upload", files={"file": ("small.bin", b"x" * 500)}
    )
    assert response.status_code == 200
    assert response.json() == {"size": 500}


# ── /parse end to end ────────────────────────────────────────


def test_parse_refuses_an_upload_over_the_size_limit_without_converting(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_module, "MAX_UPLOAD_BYTES", 1_000)

    async def never(_path: str) -> str:
        raise AssertionError("converted an oversized upload")

    monkeypatch.setattr(parser_module._worker, "convert", never)
    response = client.post(
        "/parse",
        headers=AUTH,
        files={"file": ("big.pdf", b"%PDF" + b"x" * 5_000, "application/pdf")},
        data={"mime_type": "application/pdf"},
    )
    assert response.status_code == 413


def test_parse_refuses_a_decompression_bomb(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def never(_path: str) -> str:
        raise AssertionError("converted a decompression bomb")

    monkeypatch.setattr(parser_module._worker, "convert", never)
    response = client.post(
        "/parse",
        headers=AUTH,
        files={
            "file": ("bomb.docx", _docx_bytes(padding=bytes(20 * 1024 * 1024)), DOCX)
        },
        data={"mime_type": DOCX},
    )
    assert response.status_code == 413
    assert "Refusing to extract" in response.json()["detail"]


@pytest.mark.parametrize(
    ("error", "status"),
    [
        (ConversionTimeout("conversion took longer than 120s"), 504),
        (ConversionFailed("boom"), 422),
    ],
)
def test_parse_reports_a_timeout_and_a_failed_conversion(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, error: Exception, status: int
) -> None:
    async def failing(_path: str) -> str:
        raise error

    monkeypatch.setattr(parser_module._worker, "convert", failing)
    response = client.post(
        "/parse",
        headers=AUTH,
        files={"file": ("doc.docx", _docx_bytes(), DOCX)},
        data={"mime_type": DOCX},
    )
    assert response.status_code == status


def test_parse_converts_a_real_docx_in_the_child(client: TestClient) -> None:
    response = client.post(
        "/parse",
        headers=AUTH,
        files={"file": ("doc.docx", _docx_bytes("Quarterly numbers"), DOCX)},
        data={"mime_type": DOCX},
    )
    assert response.status_code == 200, response.text
    assert "Quarterly numbers" in response.json()["sections"][0]["text"]
