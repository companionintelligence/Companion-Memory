"""
The /decision/rerank route scores its passages off the event loop.

A pass is one model call per passage. Run on the loop, it would hold every other
request until it finished, so these tests hold a pass open and check that another
request completes while it is still running.
"""

from __future__ import annotations

import asyncio
import threading

import httpx

from ci.hbpe import api
from ci.hbpe.config import settings
from ci.hbpe.inference import decision_model

USER_ID = "3b0c9c7e-6a52-4a52-8c53-0d3b2c2b1e11"
SECRET = "s3cret"
HEADERS = {"Authorization": f"Bearer {SECRET}"}
BODY = {
    "query": "When is my dentist appointment?",
    "passages": [{"id": "p1", "text": "Dentist at 3pm"}],
}


def test_rerank_pass_leaves_the_event_loop_free_for_other_requests(monkeypatch):
    monkeypatch.setattr(settings, "sidecar_auth_secret", SECRET)
    pass_started = threading.Event()
    release_pass = threading.Event()

    def held_pass(query: str, passages: list[dict[str, str]]) -> list[dict]:
        pass_started.set()
        release_pass.wait(timeout=5)

        return [{"id": passage["id"], "score": 0.5} for passage in passages]

    monkeypatch.setattr(decision_model, "rerank_passages", held_pass)

    async def scenario():
        transport = httpx.ASGITransport(app=api.app)

        async with httpx.AsyncClient(
            transport=transport, base_url="http://sidecar.test"
        ) as client:
            rerank = asyncio.create_task(
                client.post(
                    "/decision/rerank",
                    params={"user_id": USER_ID},
                    json=BODY,
                    headers=HEADERS,
                )
            )

            assert await asyncio.to_thread(pass_started.wait, 5), (
                "the rerank pass never started"
            )

            health = await asyncio.wait_for(
                client.get("/health", headers=HEADERS), timeout=5
            )
            pass_still_running = not rerank.done()

            release_pass.set()
            reply = await rerank

            return health, pass_still_running, reply

    health, pass_still_running, reply = asyncio.run(scenario())

    assert health.status_code == 200
    assert pass_still_running, "the health check waited for the rerank pass to finish"
    assert reply.status_code == 200
    assert reply.json() == {"user_id": USER_ID, "results": [{"id": "p1", "score": 0.5}]}
