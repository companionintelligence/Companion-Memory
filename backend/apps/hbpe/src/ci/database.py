"""
Database connection helper for the HBPE service.

Provides a psycopg2 connection context manager used by all tokenizer modules.
"""
from __future__ import annotations

import contextlib
import logging
from typing import Generator

import psycopg2
import psycopg2.extras
from psycopg2.extensions import connection as PgConnection
from psycopg2.pool import ThreadedConnectionPool

from ci.config import settings

log = logging.getLogger(__name__)

_pool: ThreadedConnectionPool | None = None


def init_db(minconn: int = 1, maxconn: int = 20) -> None:
    """Initialize the global ThreadedConnectionPool and verify connectivity."""
    global _pool
    if _pool is not None:
        return

    log.info("initializing database pool: host=%s db=%s", 
             settings.database_url.split('@')[-1].split('/')[0], 
             settings.database_url.split('/')[-1].split('?')[0])
             
    try:
        _pool = ThreadedConnectionPool(minconn, maxconn, dsn=settings.database_url)
        # Verify connection by getting one, and also register UUID loader for it? 
        # Actually register_uuid() with None registers globally, but psycopg2 might require an active connection for introspection.
        conn = _pool.getconn()
        try:
            psycopg2.extras.register_uuid(conn)
        finally:
            _pool.putconn(conn)
            
        log.info("database pool initialized successfully")
    except Exception as exc:
        log.error("failed to initialize database connection pool", exc_info=exc)
        raise


@contextlib.contextmanager
def get_conn() -> Generator[PgConnection, None, None]:
    """
    Yield an auto-committing psycopg2 connection from the pool, rolling back on exception.

    Usage::

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(...)
    """
    if _pool is None:
        init_db()
        
    conn = _pool.getconn()
    try:
        # Some loaders might need to be registered per connection
        psycopg2.extras.register_uuid(conn)
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.putconn(conn)
