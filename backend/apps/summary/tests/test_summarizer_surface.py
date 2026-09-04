"""Pins what `summarizer` is still allowed to be.

summarizer.py used to carry a full second implementation of the hourly,
rollup, insight and action paths, duplicating summary_functions.py. Nothing
called it: the only live entry points are dossier_builder's
`summarizer.generate_user_dossier` and llm_config's import of the pydantic
response models. The duplicates rotted in place -- they enumerated data
sources (`measurements`, `activities`, `api_logs`, `screen_captures`) that
SUMMARY_SOURCES has never emitted, and read `from_entity_id` off rows whose
query stopped selecting it -- while still reading as the authoritative
implementation to anyone who opened the file first.

These tests exist so a second implementation cannot silently regrow. If one of
them fails, the fix is almost always to put the new code in
summary_functions.py (which the workflow actually runs), not to widen the pin.
"""

import ast
import inspect
from pathlib import Path

from ci.summary import summarizer as summarizer_module
from ci.summary.summarizer import Summarizer, summarizer
from ci.summary.summary_sources import SUMMARY_SOURCES

SUMMARIZER_SOURCE_PATH = Path(inspect.getfile(summarizer_module))


def _public_names(obj) -> set[str]:
    return {name for name in vars(obj) if not name.startswith("_")}


def _string_literals_in_code() -> set[str]:
    """Every string constant summarizer.py uses as data, docstrings excluded.

    Scanning the raw source instead would flag this module's own docstring,
    which names the retired sources on purpose to explain why they are gone.
    """
    tree = ast.parse(SUMMARIZER_SOURCE_PATH.read_text())
    docstrings = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(
            node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef
        )
        and node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
        and isinstance(node.body[0].value.value, str)
    }
    return {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
    }


def _names_imported_from_summarizer(module_filename: str) -> set[str]:
    """Every name a sibling module pulls out of `.summarizer`."""
    tree = ast.parse((SUMMARIZER_SOURCE_PATH.parent / module_filename).read_text())
    return {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module == "summarizer"
        for alias in node.names
    }


def test_summarizer_class_only_owns_the_dossier_path() -> None:
    """The class keeps exactly one generator; every other path is a duplicate.

    Hourly summaries, rollups, insights and actions all run through
    summary_functions.py via activities.py. A second `generate_*` here would be
    dead on arrival and would contradict the live one.
    """
    assert _public_names(Summarizer) == {"generate_user_dossier"}


def test_summarizer_instance_builds_only_the_dossier_agent() -> None:
    """One agent, because there is one caller.

    `summarizer = Summarizer()` runs at import time, so every agent declared in
    __init__ is constructed on any import of this module -- including by
    llm_config, which only wants the response models. Agents for paths nobody
    calls are import-time cost for nothing.
    """
    agents = {name for name in _public_names(summarizer) if name.endswith("_agent")}
    assert agents == {"dossier_agent"}


def test_summarizer_names_no_source_the_aggregator_does_not_emit() -> None:
    """Catches the specific rot that killed the old prompt builders.

    They hardcoded category names from a schema that no longer exists, so the
    prompts they built were structurally empty and nothing ever said so.
    """
    emitted = {source_spec.name for source_spec in SUMMARY_SOURCES}
    retired = {"measurements", "activities", "api_logs", "screen_captures"}
    assert not retired & emitted, "test's retired-source list is stale"

    named = retired & _string_literals_in_code()
    assert not named, (
        f"summarizer.py names {named}, which SUMMARY_SOURCES does not emit"
    )


def test_summarizer_reads_no_column_the_insight_queries_dropped() -> None:
    """`from_entity_id` left the recent-communications projection.

    insight_aggregator._get_recent_communications now selects `from_name`; the
    dead prompt builder here still asked rows for `from_entity_id` and quietly
    got "" for every one.
    """
    assert "from_entity_id" not in _string_literals_in_code()


def test_summarizer_still_exports_everything_its_importers_need() -> None:
    """The other half of the pin: shrinking this module must not break imports.

    llm_config imports the response models and `wrap_output` from here, and
    dossier_builder imports the `summarizer` singleton. Both are read straight
    off the importing source so this cannot drift.
    """
    needed = _names_imported_from_summarizer("llm_config.py") | (
        _names_imported_from_summarizer("dossier_builder.py")
    )
    assert "wrap_output" in needed and "summarizer" in needed, (
        "importer parsing found nothing -- the test, not the module, is broken"
    )
    for name in sorted(needed):
        assert hasattr(summarizer_module, name), f"summarizer no longer exports {name}"
        assert name in summarizer_module.__all__, f"{name} is used but not in __all__"
