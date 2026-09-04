"""
Tests for the hourly backfill's transport, its force flag, and the upsert that
makes both of them safe.

Three defects these pin, all of them found in review of the hourly-dedup change:

* `store_summary_activity` was a bare INSERT minting a fresh summary_id against
  a NON-unique index, so the check-then-insert in `hourly_summary` reproduced
  the duplicates it was added to prevent whenever two runs raced the same
  window. It now upserts against `summaries_user_window_uniq` (migration
  20260903162709) and returns the SURVIVING row's id.
* A 24-hour backfill awaited 24 full LLM summaries inside one HTTP request.
  Multi-hour ranges are now accepted into the runner and answered with a poll
  url, with per-window progress published as each hour lands.
* The backfill could only fill gaps. An hour summarized before its import batch
  finished landing stayed wrong forever, because its thin row satisfied the
  exact-window match. `force` bypasses that check.

No database and no LLM: activities and the runner are monkeypatched.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import Response

from ci.summary import activities, api, functions


def _patch(monkeypatch: pytest.MonkeyPatch, name: str, result: Any) -> list[tuple]:
    """Replace an activity with a recording stub returning ``result``."""
    calls: list[tuple] = []

    async def stub(*args: Any, **kwargs: Any) -> Any:
        calls.append((args, kwargs))
        return result

    monkeypatch.setattr(functions, name, stub)

    return calls


USER = "01a0124f-cbca-7609-938a-2d044dd8fbbc"


@pytest.fixture(autouse=True)
def _isolate_backfill_progress():
    """
    Progress records live in a process-global map, so a record another test
    left queued would make the in-flight dedup answer on execution order.
    """
    functions._backfill_progress.clear()
    yield
    functions._backfill_progress.clear()


# ── Force: regenerating an already-summarized window ──────────────────


@pytest.mark.asyncio
async def test_force_regenerates_a_window_that_already_has_a_summary(monkeypatch):
    """The partial-import repair path: an existing row must not short-circuit."""
    existing = _patch(
        monkeypatch,
        "find_existing_summary_activity",
        {"summary_id": "summary-thin", "content": {"summary_text": "half an hour"}},
    )
    _patch(monkeypatch, "aggregate_data_activity", {"events": [{"id": "e1"}]})
    _patch(
        monkeypatch,
        "generate_hourly_summary_activity",
        {
            "summary_text": "the whole hour",
            "activity_counts": {"events": 9, "total": 9},
            "tokens_used": 60,
        },
    )
    stored = _patch(monkeypatch, "store_summary_activity", "summary-thin")

    result = await functions.hourly_summary(
        USER,
        start_time="2026-08-18T14:00:00+00:00",
        end_time="2026-08-18T15:00:00+00:00",
        force=True,
    )

    assert "skipped" not in result
    assert result["forced"] is True
    assert result["summary_text"] == "the whole hour"
    # The existing-row check is not even consulted under force — it is the
    # thing standing between the operator and the repair.
    assert existing == []
    assert len(stored) == 1


@pytest.mark.asyncio
async def test_without_force_an_existing_window_is_still_reused(monkeypatch):
    _patch(
        monkeypatch,
        "find_existing_summary_activity",
        {"summary_id": "summary-thin", "content": {"summary_text": "half an hour"}},
    )
    generated = _patch(monkeypatch, "generate_hourly_summary_activity", {})

    result = await functions.hourly_summary(
        USER,
        start_time="2026-08-18T14:00:00+00:00",
        end_time="2026-08-18T15:00:00+00:00",
    )

    assert result["skipped"] == "already_exists"
    assert generated == []


@pytest.mark.asyncio
async def test_every_window_reports_the_same_keys_whether_or_not_it_was_skipped(
    monkeypatch,
):
    """
    Each window result is spread verbatim into the progress record's `windows`,
    so a key on only some branches is a KeyError for whoever reads the run —
    and `forced` was missing from exactly the already-summarized windows a
    forced backfill exists to repair.
    """
    hours = iter(("already_exists", "no_activity", "generated"))
    branch: dict[str, str] = {}

    async def find_existing(*_args: Any, **_kwargs: Any) -> Any:
        branch["hour"] = next(hours)
        if branch["hour"] == "already_exists":
            return {"summary_id": "summary-old", "content": {}}
        return None

    async def aggregate(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        if branch["hour"] == "no_activity":
            return {}
        return {"events": [{"id": "e1"}]}

    monkeypatch.setattr(functions, "find_existing_summary_activity", find_existing)
    monkeypatch.setattr(functions, "aggregate_data_activity", aggregate)
    monkeypatch.setattr(
        functions,
        "count_activities",
        lambda data: {"total": 0 if not data else 4},
    )
    _patch(monkeypatch, "generate_hourly_summary_activity", {"summary_text": "an hour"})
    _patch(monkeypatch, "store_summary_activity", "summary-new")

    result = await functions.hourly_summary_backfill(
        USER,
        start_time="2026-09-01T00:00:00+00:00",
        end_time="2026-09-01T03:00:00+00:00",
    )

    windows = result["windows"]
    assert [window.get("skipped") for window in windows] == [
        "already_exists",
        "no_activity",
        None,
    ]
    assert [window["forced"] for window in windows] == [False, False, False]
    # `skipped` signals by presence, as the rollups do; every other key is on
    # every window whichever branch produced it.
    assert len({frozenset(window) - {"skipped"} for window in windows}) == 1


@pytest.mark.asyncio
async def test_backfill_threads_force_to_every_window(monkeypatch):
    seen: list[tuple[str, bool]] = []

    async def hourly(_user_id: str, *, start_time: str, force: bool = False, **_):
        seen.append((start_time, force))
        return {"summary_id": f"summary-{len(seen)}"}

    monkeypatch.setattr(functions, "hourly_summary", hourly)

    result = await functions.hourly_summary_backfill(
        USER,
        start_time="2026-08-18T12:00:00+00:00",
        end_time="2026-08-18T14:00:00+00:00",
        force=True,
    )

    assert [forced for _, forced in seen] == [True, True]
    assert result["forced"] is True
    assert result["generated"] == 2


# ── Transport: a multi-hour backfill is accepted, not awaited ─────────


@pytest.mark.asyncio
async def test_multi_hour_backfill_is_queued_and_answered_immediately(monkeypatch):
    """The 24-hour range must not run inside the request that asked for it."""
    submitted: list[Any] = []
    inline = _patch(monkeypatch, "hourly_summary", {"summary_id": "s"})

    class _Record:
        run_id = "run-1"

    def submit(request):
        submitted.append(request)
        return _Record()

    monkeypatch.setattr(api.runner, "submit", submit)

    http_response = Response()
    response = await api.manual_trigger_summary(
        api.ManualSummaryRequest(
            user_id=USER,
            period_type="hourly_backfill",
            start_time="2026-09-01T00:00:00+00:00",
            end_time="2026-09-02T00:00:00+00:00",
            force=True,
        ),
        http_response,
    )

    # 202, not 200: a caller keying off the status code must not read this as
    # a finished summary.
    assert http_response.status_code == 202
    assert response["status"] == "accepted"
    assert response["hours"] == 24
    assert response["run_id"] == "run-1"
    assert response["progress_url"] == f"/summary/backfill/{response['backfill_id']}"
    # Nothing was generated on the request thread.
    assert inline == []

    assert len(submitted) == 1
    assert submitted[0].function == "hourly_summary_backfill"
    assert submitted[0].args["force"] is True
    assert submitted[0].args["backfill_id"] == response["backfill_id"]


@pytest.mark.asyncio
async def test_progress_answers_between_the_202_and_a_worker_picking_it_up(monkeypatch):
    """
    The runner defaults to two workers running minutes-long LLM jobs, so a
    queued backfill waits minutes before its function body runs. Publishing
    progress only from inside that body made the progress_url handed out with
    the 202 answer 404 for the whole wait — telling the operator their healthy
    backfill never started.
    """

    class _Record:
        run_id = "run-queued"

    monkeypatch.setattr(api.runner, "submit", lambda _request: _Record())

    accepted = await api.manual_trigger_summary(
        api.ManualSummaryRequest(
            user_id=USER,
            period_type="hourly_backfill",
            start_time="2026-09-01T00:00:00+00:00",
            end_time="2026-09-01T06:00:00+00:00",
        ),
        Response(),
    )

    # Nothing has run: the runner was stubbed out entirely.
    progress = await api.get_backfill_progress(accepted["backfill_id"])

    assert progress["status"] == "queued"
    assert progress["hours"] == 6
    assert progress["completed"] == 0
    assert progress["windows"] == []
    assert progress["run_id"] == "run-queued"


@pytest.mark.asyncio
async def test_a_started_backfill_takes_over_the_record_it_was_accepted_with(
    monkeypatch,
):
    """One id, one record: the caller keeps polling the url the 202 gave them."""
    submitted: list[Any] = []

    class _Record:
        run_id = "run-taken-over"

    def submit(request):
        submitted.append(request)
        return _Record()

    monkeypatch.setattr(api.runner, "submit", submit)
    monkeypatch.setattr(functions, "hourly_summary", _make_hourly_stub())

    accepted = await api.manual_trigger_summary(
        api.ManualSummaryRequest(
            user_id=USER,
            period_type="hourly_backfill",
            start_time="2026-09-01T00:00:00+00:00",
            end_time="2026-09-01T02:00:00+00:00",
        ),
        Response(),
    )

    await functions.hourly_summary_backfill(**submitted[0].args)

    progress = await api.get_backfill_progress(accepted["backfill_id"])

    assert progress["status"] == "completed"
    assert progress["completed"] == 2
    assert progress["run_id"] == "run-taken-over"


@pytest.mark.asyncio
async def test_resubmitting_a_range_in_flight_returns_the_run_already_going(
    monkeypatch,
):
    """
    runner.submit takes no singleton key, so a double-submitted day queued two
    identical runs and spent 24 more LLM summaries rewriting the same windows.
    """
    submitted: list[Any] = []

    class _Record:
        run_id = "run-first"

    def submit(request):
        submitted.append(request)
        return _Record()

    monkeypatch.setattr(api.runner, "submit", submit)

    def request() -> api.ManualSummaryRequest:
        return api.ManualSummaryRequest(
            user_id=USER,
            period_type="hourly_backfill",
            start_time="2026-09-01T00:00:00+00:00",
            end_time="2026-09-01T05:00:00+00:00",
            force=True,
        )

    first = await api.manual_trigger_summary(request(), Response())
    second = await api.manual_trigger_summary(request(), Response())

    assert len(submitted) == 1
    assert second["duplicate"] is True
    assert second["backfill_id"] == first["backfill_id"]
    assert second["run_id"] == "run-first"
    assert first["duplicate"] is False

    # A different range — and the same range without force — is different work.
    other = await api.manual_trigger_summary(
        api.ManualSummaryRequest(
            user_id=USER,
            period_type="hourly_backfill",
            start_time="2026-09-01T00:00:00+00:00",
            end_time="2026-09-01T05:00:00+00:00",
        ),
        Response(),
    )

    assert other["duplicate"] is False
    assert len(submitted) == 2


@pytest.mark.asyncio
async def test_a_finished_range_can_be_submitted_again(monkeypatch):
    """Dedup covers work in flight only; re-running a repaired day is legitimate."""
    submitted: list[Any] = []

    class _Record:
        run_id = "run-done"

    def submit(request):
        submitted.append(request)
        return _Record()

    monkeypatch.setattr(api.runner, "submit", submit)
    monkeypatch.setattr(functions, "hourly_summary", _make_hourly_stub())

    accepted = await api.manual_trigger_summary(
        api.ManualSummaryRequest(
            user_id=USER,
            period_type="hourly_backfill",
            start_time="2026-09-02T00:00:00+00:00",
            end_time="2026-09-02T02:00:00+00:00",
        ),
        Response(),
    )
    await functions.hourly_summary_backfill(**submitted[0].args)

    again = await api.manual_trigger_summary(
        api.ManualSummaryRequest(
            user_id=USER,
            period_type="hourly_backfill",
            start_time="2026-09-02T00:00:00+00:00",
            end_time="2026-09-02T02:00:00+00:00",
        ),
        Response(),
    )

    assert again["duplicate"] is False
    assert again["backfill_id"] != accepted["backfill_id"]
    assert len(submitted) == 2


@pytest.mark.asyncio
async def test_backfill_is_dispatchable_through_the_function_registry():
    """
    Absent from FUNCTIONS, the inline request was the only path there was.
    """
    assert functions.FUNCTIONS["hourly_summary_backfill"] is (
        functions.hourly_summary_backfill
    )


@pytest.mark.asyncio
async def test_single_hour_backfill_still_runs_inline(monkeypatch):
    """One LLM call is cheap enough to answer directly, as it always did."""

    def submit(_request):  # pragma: no cover - must not be reached
        raise AssertionError("a single hour should not be queued")

    monkeypatch.setattr(api.runner, "submit", submit)
    monkeypatch.setattr(
        functions,
        "hourly_summary",
        _one_hour_stub := _make_hourly_stub(),
    )

    http_response = Response()
    response = await api.manual_trigger_summary(
        api.ManualSummaryRequest(
            user_id=USER,
            period_type="hourly_backfill",
            start_time="2026-09-01T00:00:00+00:00",
            end_time="2026-09-01T01:00:00+00:00",
        ),
        http_response,
    )

    assert response["status"] == "success"
    assert response["result"]["hours"] == 1
    assert _one_hour_stub.calls == 1


@pytest.mark.asyncio
async def test_wait_forces_a_long_range_inline_for_an_operator_who_asks(monkeypatch):
    def submit(_request):  # pragma: no cover - must not be reached
        raise AssertionError("wait=true must not queue")

    monkeypatch.setattr(api.runner, "submit", submit)
    monkeypatch.setattr(functions, "hourly_summary", _make_hourly_stub())

    http_response = Response()
    response = await api.manual_trigger_summary(
        api.ManualSummaryRequest(
            user_id=USER,
            period_type="hourly_backfill",
            start_time="2026-09-01T00:00:00+00:00",
            end_time="2026-09-01T03:00:00+00:00",
            wait=True,
        ),
        http_response,
    )

    assert response["status"] == "success"
    assert response["result"]["hours"] == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("start_time", "end_time", "message"),
    [
        ("2026-09-01T00:30:00+00:00", "2026-09-01T04:30:00+00:00", "hour boundaries"),
        ("2026-09-01T00:00:00+00:00", "2026-08-31T00:00:00+00:00", "after start_time"),
        ("2026-09-01T00:00:00+00:00", "2026-09-03T00:00:00+00:00", "limited to 24"),
    ],
)
async def test_unsafe_ranges_are_rejected_before_anything_is_queued(
    monkeypatch, start_time, end_time, message
):
    """
    A queued run's ValueError is a background failure nobody is watching, so
    the range has to be checked while the caller is still on the line.
    """

    def submit(_request):  # pragma: no cover - must not be reached
        raise AssertionError("an invalid range must never be accepted")

    monkeypatch.setattr(api.runner, "submit", submit)

    with pytest.raises(api.HTTPException) as excinfo:
        await api.manual_trigger_summary(
            api.ManualSummaryRequest(
                user_id=USER,
                period_type="hourly_backfill",
                start_time=start_time,
                end_time=end_time,
            ),
            Response(),
        )

    assert excinfo.value.status_code == 400
    assert message in excinfo.value.detail


# ── Progress: which hours landed, while it is still running ───────────


@pytest.mark.asyncio
async def test_progress_is_published_after_every_window_not_at_the_end(monkeypatch):
    seen: list[dict[str, Any]] = []

    async def hourly(_user_id: str, *, start_time: str, **_):
        # Snapshot the record mid-run: a backfill that publishes only on
        # completion answers nothing during the hours it is actually running.
        seen.append(dict(functions.backfill_progress("bf-1") or {}))
        return {"summary_id": f"summary-{len(seen)}"}

    monkeypatch.setattr(functions, "hourly_summary", hourly)

    await functions.hourly_summary_backfill(
        USER,
        start_time="2026-09-01T00:00:00+00:00",
        end_time="2026-09-01T03:00:00+00:00",
        backfill_id="bf-1",
    )

    assert [snapshot["completed"] for snapshot in seen] == [0, 1, 2]
    assert [snapshot["status"] for snapshot in seen] == ["running"] * 3

    final = functions.backfill_progress("bf-1")
    assert final["status"] == "completed"
    assert final["completed"] == 3
    assert final["generated"] == 3
    assert [window["start_time"] for window in final["windows"]] == [
        "2026-09-01T00:00:00+00:00",
        "2026-09-01T01:00:00+00:00",
        "2026-09-01T02:00:00+00:00",
    ]


@pytest.mark.asyncio
async def test_a_failed_backfill_leaves_its_partial_progress_visible(monkeypatch):
    async def hourly(_user_id: str, *, start_time: str, **_):
        if start_time.startswith("2026-09-01T02"):
            raise RuntimeError("model went away")
        return {"summary_id": "summary-1"}

    monkeypatch.setattr(functions, "hourly_summary", hourly)

    with pytest.raises(RuntimeError, match="model went away"):
        await functions.hourly_summary_backfill(
            USER,
            start_time="2026-09-01T00:00:00+00:00",
            end_time="2026-09-01T04:00:00+00:00",
            backfill_id="bf-failed",
        )

    record = functions.backfill_progress("bf-failed")
    assert record["status"] == "failed"
    assert "model went away" in record["error"]
    # Two hours were written before it died; the operator needs to know which.
    assert record["completed"] == 2
    assert record["hours"] == 4


@pytest.mark.asyncio
async def test_progress_records_are_bounded(monkeypatch):
    monkeypatch.setattr(functions, "hourly_summary", _make_hourly_stub())

    for index in range(functions.MAX_BACKFILL_RECORDS + 5):
        await functions.hourly_summary_backfill(
            USER,
            start_time="2026-09-01T00:00:00+00:00",
            end_time="2026-09-01T01:00:00+00:00",
            backfill_id=f"bf-{index}",
        )

    assert functions.backfill_progress("bf-0") is None
    assert (
        functions.backfill_progress(f"bf-{functions.MAX_BACKFILL_RECORDS + 4}")
        is not None
    )


@pytest.mark.asyncio
async def test_unknown_backfill_id_is_a_404_that_does_not_guess_why():
    with pytest.raises(api.HTTPException) as excinfo:
        await api.get_backfill_progress("no-such-id")

    assert excinfo.value.status_code == 404
    # The old message told the operator the backfill "never started", which was
    # a lie for every id that was queued and waiting on a worker. A missing
    # record cannot tell those apart, so it must not claim to.
    assert "never started" not in excinfo.value.detail
    assert "restart" in excinfo.value.detail


# ── Storage: the upsert, not a second row ────────────────────────────


@pytest.mark.asyncio
async def test_store_summary_upserts_against_the_unique_window_index(monkeypatch):
    """
    A bare INSERT let two concurrent runs both write the same window. The write
    must name the index's columns and predicate so the second run updates.
    """
    writes: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(
        activities.db,
        "execute_write",
        lambda query, params: writes.append((query, params)),
    )
    monkeypatch.setattr(
        activities.db,
        "execute_query",
        lambda query, params: [{"summary_id": "summary-already-there"}],
    )

    summary_id = await activities.store_summary_activity(
        USER,
        {"summary_type": "hourly", "summary_text": "an hour"},
        "2026-09-01T00:00:00+00:00",
        "2026-09-01T01:00:00+00:00",
        "UTC",
    )

    query, _params = writes[0]
    assert "ON CONFLICT (user_id, period_type, period_start, period_end)" in query
    assert "WHERE period_type <> 'insight'" in query
    assert "DO UPDATE SET" in query
    # `seen` is the user's read state, not generated content — regenerating a
    # window must not mark it unread again.
    assert "seen = EXCLUDED.seen" not in query

    # The row that survives a conflict is the one already on disk; returning
    # the freshly minted uuid would hand callers an id nothing points at.
    assert summary_id == "summary-already-there"


def _make_hourly_stub():
    """An hourly_summary stub that counts its calls."""

    class _Stub:
        calls = 0

        async def __call__(self, _user_id: str, **_: Any) -> dict[str, Any]:
            type(self).calls += 1
            return {"summary_id": f"summary-{type(self).calls}"}

    return _Stub()
