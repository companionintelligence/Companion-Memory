#!/usr/bin/env python3
"""
Daemonize a command so it survives the parent (Claude Code) session restarting.

The harness's background tasks are children of the session's process group and
get killed when the session resumes/compacts. A double-fork + os.setsid()
detaches the command into its own session, immune to the parent's death.

Usage:
  python3 run_detached.py <logfile> <cmd> [args...]

Writes the daemon PID to <logfile>.pid. Returns immediately.
"""

import os
import sys

log = os.path.abspath(sys.argv[1])
cmd = sys.argv[2:]
if not cmd:
    sys.exit("no command given")

# First fork — parent returns to the shell immediately.
if os.fork() > 0:
    os._exit(0)

os.setsid()  # new session; detach from the parent process group / controlling tty

# Second fork — ensure we can't reacquire a controlling terminal.
if os.fork() > 0:
    os._exit(0)

# Record PID for later inspection / kill.
with open(log + ".pid", "w") as f:
    f.write(str(os.getpid()) + "\n")

# Redirect stdio: stdin from /dev/null, stdout/stderr to the log (append, unbuffered).
fd_in = os.open(os.devnull, os.O_RDONLY)
fd_out = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd_in, 0)
os.dup2(fd_out, 1)
os.dup2(fd_out, 2)

os.execvp(cmd[0], cmd)
