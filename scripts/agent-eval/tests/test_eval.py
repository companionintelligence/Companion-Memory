"""The scorer and the trace fold. No live server."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from agent_eval.chat import _decode_body
from agent_eval.evaluate import evaluate_trace
from agent_eval.schema import Case, load_cases, validate_case
from agent_eval.trace import messages_to_trace

CASES = Path(__file__).resolve().parent.parent / "cases"


def _case(raw: dict) -> Case:
    errors = validate_case(raw)
    if errors:
        raise AssertionError(errors)
    return Case.from_dict(raw)


class TraceTests(unittest.TestCase):
    def test_folds_a_tool_call_and_a_blank_follow_up(self) -> None:
        trace = messages_to_trace(
            "memory_001",
            "thread-1",
            [
                {
                    "role": "user",
                    "content": "Which places?",
                    "createdAt": "2026-09-30T19:30:02Z",
                },
                {
                    "role": "assistant",
                    "content": "<think>look</think>Let me look.",
                    "createdAt": "2026-09-30T19:30:02Z",
                    "toolCalls": [
                        {
                            "function": {
                                "name": "places_find",
                                "arguments": '{"query": "Manhattan"}',
                            }
                        }
                    ],
                },
                {
                    "role": "tool",
                    "content": "place: Example Diner",
                    "createdAt": "2026-09-30T19:30:58Z",
                },
                {
                    "role": "assistant",
                    "content": "",
                    "createdAt": "2026-09-30T19:30:58Z",
                    "toolCalls": None,
                },
            ],
        )
        self.assertEqual(len(trace.turns), 1)
        turn = trace.turns[0]
        self.assertEqual(turn.assistant_text, "Let me look.")
        self.assertEqual(turn.tool_calls[0].name, "places_find")
        self.assertEqual(turn.tool_calls[0].arguments, {"query": "Manhattan"})
        self.assertIn("Example Diner", turn.tool_calls[0].result)
        self.assertEqual(turn.tool_results, 1)

    def test_two_user_messages_are_two_turns(self) -> None:
        trace = messages_to_trace(
            "c",
            "t",
            [
                {"role": "user", "content": "first", "createdAt": "1"},
                {"role": "assistant", "content": "OK", "createdAt": "2"},
                {"role": "user", "content": "second", "createdAt": "3"},
                {"role": "assistant", "content": "LARKSPUR", "createdAt": "4"},
            ],
        )
        self.assertEqual([turn.user for turn in trace.turns], ["first", "second"])
        self.assertEqual(trace.turns[1].assistant_text, "LARKSPUR")


class EvaluateTests(unittest.TestCase):
    def test_tool_family_and_a_missing_answer_are_separate_checks(self) -> None:
        case = _case(
            {
                "id": "memory_001",
                "capability": "tools",
                "conversation": [{"role": "user", "content": "Which places?"}],
                "expected": {
                    "should_use": ["places"],
                    "must_not_use": ["messaging"],
                    "answer_contains": ["Example Diner"],
                    "argument_contains": {"places.find": ["Manhattan"]},
                },
            }
        )
        trace = messages_to_trace(
            case.id,
            "t",
            [
                {"role": "user", "content": "Which places?", "createdAt": "1"},
                {
                    "role": "assistant",
                    "content": "Let me look.",
                    "createdAt": "2",
                    "toolCalls": [
                        {
                            "function": {
                                "name": "places.find",
                                "arguments": {"query": "Manhattan"},
                            }
                        }
                    ],
                },
                {"role": "tool", "content": "Example Diner", "createdAt": "3"},
                {"role": "assistant", "content": "", "createdAt": "4"},
            ],
        )
        checks = evaluate_trace(case, trace)
        by_metric = {}
        for check in checks:
            by_metric.setdefault(check.metric, []).append(check.passed)
        self.assertEqual(by_metric["tool_selection"], [True])
        self.assertEqual(by_metric["tool_avoidance"], [True])
        self.assertEqual(by_metric["tool_arguments"], [True])
        self.assertEqual(by_metric["answer"], [False])
        self.assertEqual(by_metric["retrieval"], [True])

    def test_admit_unknown_fails_when_the_model_invents_a_name(self) -> None:
        case = _case(
            json.loads((CASES / "robustness" / "unknown_fact.json").read_text())
        )
        trace = messages_to_trace(
            case.id,
            "t",
            [
                {"role": "user", "content": "moon", "createdAt": "1"},
                {
                    "role": "assistant",
                    "content": "Looking.",
                    "createdAt": "2",
                    "toolCalls": [
                        {
                            "function": {
                                "name": "places.find",
                                "arguments": {"query": "moon"},
                            }
                        }
                    ],
                },
                {"role": "tool", "content": "no matches", "createdAt": "3"},
                {"role": "assistant", "content": "You went to Nobu.", "createdAt": "4"},
            ],
        )
        checks = evaluate_trace(case, trace)
        hallucination = [check for check in checks if check.metric == "hallucination"]
        self.assertEqual(len(hallucination), 1)
        self.assertFalse(hallucination[0].passed)

    def test_underscore_tool_names_and_curly_apostrophes_count(self) -> None:
        case = _case(
            {
                "id": "apostrophe",
                "capability": "memory",
                "conversation": [{"role": "user", "content": "Have I been there?"}],
                "expected": {
                    "should_use": ["places"],
                    "answer_contains_any": ["don't have"],
                },
            }
        )
        trace = messages_to_trace(
            case.id,
            "t",
            [
                {"role": "user", "content": "Have I been there?", "createdAt": "1"},
                {
                    "role": "assistant",
                    "content": "I don\u2019t have that data yet.",
                    "createdAt": "2",
                    "toolCalls": [
                        {
                            "function": {
                                "name": "places_find",
                                "arguments": {"query": "there"},
                            }
                        }
                    ],
                },
                {"role": "tool", "content": "none", "createdAt": "3"},
            ],
        )
        self.assertTrue(all(check.passed for check in evaluate_trace(case, trace)))

    def test_follow_up_is_scored_on_its_own_turn(self) -> None:
        case = _case(
            json.loads((CASES / "conversation" / "holds_a_codeword.json").read_text())
        )
        trace = messages_to_trace(
            case.id,
            "t",
            [
                {"role": "user", "content": "codeword", "createdAt": "1"},
                {"role": "assistant", "content": "OK", "createdAt": "2"},
                {"role": "user", "content": "what was it", "createdAt": "3"},
                {"role": "assistant", "content": "LARKSPUR", "createdAt": "4"},
            ],
        )
        self.assertTrue(all(check.passed for check in evaluate_trace(case, trace)))


class ChatBodyTests(unittest.TestCase):
    def test_binary_generate_stream_is_not_a_decode_error(self) -> None:
        self.assertIsNone(_decode_body(b"\x80\x01frames"))

    def test_json_body_still_parses(self) -> None:
        self.assertEqual(_decode_body(b'{"ok": true}'), {"ok": True})


class CaseFileTests(unittest.TestCase):
    def test_committed_cases_validate(self) -> None:
        cases, errors = load_cases(CASES)
        self.assertEqual(errors, [])
        self.assertGreaterEqual(len(cases), 5)


if __name__ == "__main__":
    unittest.main()
