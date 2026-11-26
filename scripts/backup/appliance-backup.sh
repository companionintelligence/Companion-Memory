#!/usr/bin/env bash
# Complete, consistent local snapshot: database + uploaded files + encryption keys.
# Use database-backup.sh when a portable SQL-only export is specifically wanted.
set -euo pipefail
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/appliance-recovery.py" backup "$@"
