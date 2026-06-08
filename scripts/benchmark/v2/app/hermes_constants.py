# stub for vendored Holographic store (only used when db_path is None; we always pass one)
from pathlib import Path
def get_hermes_home(): return Path("/tmp/holo_home")
