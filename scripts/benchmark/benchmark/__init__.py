"""CI-Server memory benchmark.

Public API kept tight — most callers want :func:`run_all` + a reporter.
"""

from .adapters import ADAPTERS, MemoryAdapter, get_adapter, register_adapter
from .regression import RegressionChange, RegressionReport, compare, format_summary
from .reporter import build_json_report, build_markdown_report
from .runner import run_all, run_system
from .schema import EvalQuestion, QuestionResult, SystemResult, validate_persona
from .scoring import make_llm_scorer, score_keyword

__all__ = [
    "ADAPTERS",
    "EvalQuestion",
    "MemoryAdapter",
    "QuestionResult",
    "RegressionChange",
    "RegressionReport",
    "SystemResult",
    "build_json_report",
    "build_markdown_report",
    "compare",
    "format_summary",
    "get_adapter",
    "make_llm_scorer",
    "register_adapter",
    "run_all",
    "run_system",
    "score_keyword",
    "validate_persona",
]
