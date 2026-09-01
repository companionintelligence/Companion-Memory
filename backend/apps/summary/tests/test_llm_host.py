"""
Correcting an inference URL for the namespace the process is actually in.

The bug: `LLM_API_BASE` is written once in `.env` and read from both sides of a
container boundary. `http://localhost:11434/v1` is right for the host-run API
and names the container itself inside a sidecar; `http://host.docker.internal:
11434/v1` is right for the sidecars and resolves nowhere on a macOS or linux
host. Whichever one `.env` holds, the other side is pointed at nothing — and
compose's `${LLM_API_BASE:-<good default>}` means the wrong value wins over the
right default. Observed live 2026-08-30: summary-service refusing every
connection, HBPE writing zero labels for a full nightly run (#2484).
"""

from __future__ import annotations

from pathlib import Path

from ci.summary import llm_host

CONTAINER = {"in_container": True, "resolves": lambda host: True}
HOST = {"in_container": False, "resolves": lambda host: False}


# ── The two directions ──────────────────────────────────────────────────────


def test_loopback_becomes_the_gateway_inside_a_container():
    """The live summary-service bug."""
    url, note = llm_host.resolve_url("http://localhost:11434/v1", **CONTAINER)

    assert url == "http://host.docker.internal:11434/v1"
    assert note and "localhost" not in url


def test_gateway_becomes_loopback_on_the_host():
    """The mirror image: what .env.default ships breaks the host-run API."""
    url, note = llm_host.resolve_url("http://host.docker.internal:11434/v1", **HOST)

    assert url == "http://localhost:11434/v1"
    assert note


def test_loopback_is_left_alone_on_the_host():
    """The ordinary `make dev` case must not be touched."""
    url, note = llm_host.resolve_url("http://localhost:11434/v1", **HOST)

    assert url == "http://localhost:11434/v1"
    assert note is None


def test_gateway_is_left_alone_inside_a_container():
    url, note = llm_host.resolve_url(
        "http://host.docker.internal:11434/v1", **CONTAINER
    )

    assert url == "http://host.docker.internal:11434/v1"
    assert note is None


# ── What must survive a rewrite ─────────────────────────────────────────────


def test_port_and_path_survive():
    """A vLLM port and a /v1 suffix are not ours to normalize."""
    url, _ = llm_host.resolve_url("http://localhost:8000/v1", **CONTAINER)

    assert url == "http://host.docker.internal:8000/v1"


def test_a_missing_trailing_slash_stays_missing():
    """OLLAMA_HOST is concatenated onto (`${host}/api/tags`); an added slash breaks it."""
    url, _ = llm_host.resolve_url("http://localhost:11434", **CONTAINER)

    assert url == "http://host.docker.internal:11434"


def test_scheme_userinfo_and_query_survive():
    url, _ = llm_host.resolve_url("https://u:p@localhost:8443/v1?x=1", **CONTAINER)

    assert url == "https://u:p@host.docker.internal:8443/v1?x=1"


def test_a_default_port_is_not_invented():
    url, _ = llm_host.resolve_url("http://localhost/v1", **CONTAINER)

    assert url == "http://host.docker.internal/v1"


# ── Hosts that are nobody's business but the operator's ─────────────────────


def test_a_real_hostname_is_never_touched():
    for base in ("http://ollama:11434/v1", "https://api.example.com/v1"):
        assert llm_host.resolve_url(base, **CONTAINER) == (base, None)
        assert llm_host.resolve_url(base, **HOST) == (base, None)


def test_empty_and_malformed_values_pass_through():
    assert llm_host.resolve_url("", **CONTAINER) == ("", None)
    assert llm_host.resolve_url("   ", **CONTAINER) == ("", None)
    assert llm_host.resolve_url("not a url", **CONTAINER) == ("not a url", None)
    assert llm_host.resolve_url("http://localhost:99999/v1", **CONTAINER)[0] == (
        "http://localhost:99999/v1"
    )


def test_the_escape_hatch_disables_every_rewrite():
    env = {"CI_LLM_HOST_REWRITE": "off"}
    url, note = llm_host.resolve_url("http://localhost:11434/v1", env=env, **CONTAINER)

    assert (url, note) == ("http://localhost:11434/v1", None)


def test_an_operator_supplied_gateway_is_used():
    url, _ = llm_host.resolve_url(
        "http://localhost:11434/v1",
        env={"CI_LLM_HOST_GATEWAY": "docker-host.internal"},
        **CONTAINER,
    )

    assert url == "http://docker-host.internal:11434/v1"


# ── The cases where nothing can be fixed still have to be loud ──────────────


def test_loopback_in_a_container_with_no_gateway_route_warns():
    url, note = llm_host.resolve_url(
        "http://localhost:11434/v1", in_container=True, resolves=lambda host: False
    )

    assert url == "http://localhost:11434/v1"
    assert note and "extra_hosts" in note


def test_unresolvable_gateway_in_a_container_warns_instead_of_guessing():
    """localhost would be flatly wrong here — it is this container."""
    url, note = llm_host.resolve_url(
        "http://host.docker.internal:11434/v1",
        in_container=True,
        resolves=lambda host: False,
    )

    assert url == "http://host.docker.internal:11434/v1"
    assert note and "extra_hosts" in note


# ── resolve_env: the entry point both services actually call ────────────────


def test_resolve_env_fixes_chat_and_embedding_together(monkeypatch):
    """Fixing chat while embeddings still say localhost just moves the outage."""
    monkeypatch.setattr(llm_host, "running_in_container", lambda: True)
    monkeypatch.setattr(llm_host, "hostname_resolves", lambda host: True)
    env = {
        "LLM_API_BASE": "http://localhost:11434/v1",
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "EMBEDDING_API_BASE": "http://ollama:11434/v1",
        "UNRELATED_URL": "http://localhost:9999",
    }

    notes = llm_host.resolve_env(env)

    assert env["LLM_API_BASE"] == "http://host.docker.internal:11434/v1"
    assert env["OLLAMA_HOST"] == "http://host.docker.internal:11434"
    assert env["EMBEDDING_API_BASE"] == "http://ollama:11434/v1"
    assert env["UNRELATED_URL"] == "http://localhost:9999"
    assert set(notes) == {"LLM_API_BASE", "OLLAMA_HOST"}


def test_resolve_env_leaves_unset_vars_unset(monkeypatch):
    monkeypatch.setattr(llm_host, "running_in_container", lambda: True)
    monkeypatch.setattr(llm_host, "hostname_resolves", lambda host: True)
    env = {"LLM_API_BASE": "", "OLLAMA_HOST": "   "}

    assert llm_host.resolve_env(env) == {}
    assert env == {"LLM_API_BASE": "", "OLLAMA_HOST": "   "}


def test_resolve_env_logs_every_rewrite(monkeypatch, caplog):
    """A silent rewrite of where inference goes is its own trap."""
    monkeypatch.setattr(llm_host, "running_in_container", lambda: True)
    monkeypatch.setattr(llm_host, "hostname_resolves", lambda host: True)

    with caplog.at_level("WARNING"):
        llm_host.resolve_env({"LLM_API_BASE": "http://localhost:11434/v1"})

    assert "host.docker.internal" in caplog.text


# ── The two copies of this module must not drift ────────────────────────────


def test_the_hbpe_copy_is_identical():
    """
    llm_host.py is duplicated in ci.hbpe rather than shared through a package
    under backend/packages/, which would have to be wired into four Dockerfiles
    including the CUDA and ROCm ones. This test is what pays for that choice.
    """
    here = Path(llm_host.__file__).resolve()
    twin = here.parents[4] / "hbpe" / "src" / "ci" / "hbpe" / "llm_host.py"

    if not twin.is_file():
        # Inside the built image only one service's source is present.
        return

    assert twin.read_text(encoding="utf-8") == here.read_text(encoding="utf-8"), (
        f"{twin} has drifted from {here}; the two copies must stay identical."
    )
