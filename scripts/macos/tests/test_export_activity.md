# Snapshot acquisition tests

## Purpose
Exercise real SQLite WAL acquisition, original-file preservation, private file
permissions, stable device identity, atomic output and unavailable-source reports.
All fixtures are synthetic and live in temporary directories.

## Contract
Run with `python -m pytest scripts/macos/tests`; no Mac privacy permissions,
personal databases, network, model, or running CI-Server are required.
