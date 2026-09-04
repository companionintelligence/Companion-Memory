"""CI-Server memory benchmark.

Public API kept tight — most callers want :func:`run_all` + a reporter.
"""

from .adapters import ADAPTERS, MemoryAdapter, get_adapter, register_adapter
from .aggregation import AggregatedSystemResult, aggregate_runs
from .judge_cache import JudgeCache, cached_scorer
from .regression import RegressionChange, RegressionReport, compare, format_summary
from .reporter import build_json_report, build_markdown_report
from .runner import run_all, run_system, run_system_repeated
from .schema import EvalQuestion, QuestionResult, SystemResult, validate_persona
from .scoring import make_llm_scorer, score_keyword

__all__ = [
    "ADAPTERS",
    "AggregatedSystemResult",
    "EvalQuestion",
    "JudgeCache",
    "MemoryAdapter",
    "QuestionResult",
    "RegressionChange",
    "RegressionReport",
    "SystemResult",
    "aggregate_runs",
    "build_json_report",
    "build_markdown_report",
    "cached_scorer",
    "compare",
    "format_summary",
    "get_adapter",
    "make_llm_scorer",
    "register_adapter",
    "run_all",
    "run_system",
    "run_system_repeated",
    "score_keyword",
    "validate_persona",
]
