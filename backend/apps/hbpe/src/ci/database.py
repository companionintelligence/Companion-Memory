"""
Database connection helper for the HBPE service.

Provides a psycopg2 connection context manager used by all tokenizer modules.
"""
from __future__ import annotations

import contextlib
from typing import Generator

import psycopg2
import psycopg2.extras
from psycopg2.extensions import connection as PgConnection

from ci.config import settings


@contextlib.contextmanager
def get_conn() -> Generator[PgConnection, None, None]:
    """
    Yield an auto-committing psycopg2 connection, rolling back on exception.

    Usage::

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(...)
    """
    conn = psycopg2.connect(settings.database_url)
    psycopg2.extras.register_uuid(conn)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
