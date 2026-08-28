"""NaiveAdapter — used as a smoke baseline and the runner fixture."""

from __future__ import annotations

from benchmark.adapters.naive import NaiveAdapter


def test_setup_clears_prior_state():
    a = NaiveAdapter()
    a.setup("u1")
    a.ingest("Jordan moved to Austin, Texas.", session_id="s1")
    a.setup("u2")  # second setup must wipe
    assert a.search("Austin") == ""


def test_search_returns_top_k_by_overlap():
    a = NaiveAdapter(top_k=2)
    a.setup("u")
    a.ingest("Jordan moved to Austin, Texas.", "s1")
    a.ingest("The dog barked at the mail carrier.", "s2")
    a.ingest("Jordan started a new job in Austin.", "s3")
    ctx = a.search("Austin Jordan")
    # Both Austin/Jordan fragments are ranked above the dog one.
    assert "Austin" in ctx
    assert "barked" not in ctx


def test_empty_query_or_no_overlap_returns_empty_string():
    a = NaiveAdapter()
    a.setup("u")
    a.ingest("Jordan moved to Austin.", "s1")
    assert a.search("") == ""
    assert a.search("airplane submarine") == ""


def test_teardown_clears_state():
    a = NaiveAdapter()
    a.setup("u")
    a.ingest("Austin Texas", "s1")
    a.teardown()
    assert a.search("Austin") == ""
