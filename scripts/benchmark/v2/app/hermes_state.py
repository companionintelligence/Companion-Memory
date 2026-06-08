# stub for vendored Holographic store: WAL pragma helper (Hermes runtime shim)
def apply_wal_with_fallback(conn, db_label=""):
    try: conn.execute("PRAGMA journal_mode=WAL")
    except Exception: pass
