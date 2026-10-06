"""
Stand-ins for the conversion child, importable by a spawned process.

``ConversionWorker`` starts its target with the ``spawn`` method, which
pickles the target by module and name, so these live in a plain module on the
test path rather than inside a test function.
"""

from __future__ import annotations

import os
import time
from multiprocessing.connection import Connection


def echo(conn: Connection, _memory_bytes: int) -> None:
    """Converts every path to a fixed text, crashing on ``crash``, hanging on ``hang`` and taking 2 s on ``slow``."""
    while True:
        try:
            path = conn.recv()
        except EOFError:
            return

        if "crash" in path:
            os._exit(3)

        if "hang" in path:
            time.sleep(600)

        if "slow" in path:
            time.sleep(2)

        if "memory" in path:
            conn.send(
                ("fatal", "the document needs more memory than the parser allows")
            )
            return

        conn.send(("ok", f"converted {path} in {os.getpid()}"))
