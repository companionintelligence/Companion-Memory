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
        # TCP keepalives so connections idle during a multi-hour nightly label
        # run aren't silently dropped by the OS / a NAT / Postgres before the
        # next query reuses them.
        _pool = ThreadedConnectionPool(
            minconn, maxconn, dsn=settings.database_url,
            keepalives=1, keepalives_idle=30,
            keepalives_interval=10, keepalives_count=5,
        )
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


def _conn_is_live(conn: PgConnection) -> bool:
    """
    Cheap liveness probe for a pooled connection.

    psycopg2's ThreadedConnectionPool does NOT health-check on getconn(), so a
    connection the server killed (``server closed the connection unexpectedly``
    — e.g. a Postgres restart or a crash-recovery reset that terminates every
    backend) stays in the pool and is handed back dead on every later checkout
    (``connection already closed``), permanently poisoning the pool until the
    process restarts. We rollback any leftover aborted-transaction state and
    issue ``SELECT 1`` so dead connections can be detected and discarded.
    """
    if conn.closed:
        return False
    try:
        conn.rollback()
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        return True
    except psycopg2.Error:
        return False


def _checkout_live_conn() -> PgConnection:
    """
    Return a connection from the pool that is verified alive.

    Dead connections are discarded with ``close=True`` (so the pool opens a
    fresh one next time) until a live connection is obtained. Bounded by the
    pool size + 1 so a fully-reset pool is drained and refilled rather than
    looping forever.
    """
    attempts = getattr(_pool, "maxconn", 20) + 1
    for _ in range(attempts):
        conn = _pool.getconn()
        if _conn_is_live(conn):
            return conn
        log.warning("discarding dead pooled connection (server reset?) — recycling")
        _pool.putconn(conn, close=True)
    raise psycopg2.OperationalError(
        "could not obtain a live database connection after recycling the pool"
    )


@contextlib.contextmanager
def get_conn() -> Generator[PgConnection, None, None]:
    """
    Yield a live, auto-committing psycopg2 connection from the pool, rolling
    back on exception.

    The connection is liveness-checked on checkout and discarded if dead, so a
    transient Postgres outage (restart / crash-recovery reset) can't poison the
    pool for the lifetime of the process. A connection that dies mid-use is
    dropped from the pool (``putconn(close=True)``) instead of being returned.

    Usage::

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(...)
    """
    if _pool is None:
        init_db()

    conn = _checkout_live_conn()
    try:
        # Some loaders might need to be registered per connection
        psycopg2.extras.register_uuid(conn)
        yield conn
        conn.commit()
    except Exception:
        # Roll back only if the socket is still alive; rolling back a dead
        # connection raises again and masks the original error.
        if not conn.closed:
            try:
                conn.rollback()
            except psycopg2.Error as rb_exc:
                # Intentionally swallowed: re-raising here would replace the
                # original exception with the rollback failure. Log at debug so
                # the original error still propagates below.
                log.debug("rollback after error failed (ignored): %s", rb_exc)
        raise
    finally:
        # Never return a broken connection to the pool — close=True discards it.
        _pool.putconn(conn, close=bool(conn.closed))
