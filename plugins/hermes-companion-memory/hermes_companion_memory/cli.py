"""CLI extensions for the Companion Intelligence memory plugin.

Adds `hermes companion status` and `hermes companion setup` sub-commands.
These are registered by the hermes_agent CLI machinery when the plugin is
installed; here they are implemented as plain functions so they can also be
called directly for debugging.
"""
from __future__ import annotations

import os
import sys


def cmd_status() -> int:
    """Print the current status of the Companion memory provider."""
    api_key = os.environ.get("COMPANION_API_KEY")
    base_url = os.environ.get("COMPANION_BASE_URL", "https://api.companion.intelligence")
    agent_id = os.environ.get("COMPANION_AGENT_ID", "<not set>")

    print("Companion Intelligence Memory Provider — status")
    print("=" * 50)
    print(f"  API key set : {'yes (***' + api_key[-4:] + ')' if api_key else 'NO — not configured'}")
    print(f"  Base URL    : {base_url}")
    print(f"  Agent ID    : {agent_id}")
    print()
    if not api_key:
        print("  [WARN] COMPANION_API_KEY is not set. Memory provider will be disabled.")
        print("         Run `hermes companion setup` for configuration instructions.")
        return 1
    print("  [OK] Provider is available.")
    return 0


def cmd_setup() -> int:
    """Print configuration instructions for the Companion memory provider."""
    print("Companion Intelligence Memory Provider — setup")
    print("=" * 50)
    print()
    print("1. Obtain an API key from https://companion.intelligence/dashboard")
    print()
    print("2. Export the following environment variables (add to ~/.zshrc or ~/.bashrc):")
    print()
    print("     export COMPANION_API_KEY='your-api-key-here'")
    print("     export COMPANION_BASE_URL='https://api.companion.intelligence'  # optional")
    print("     export COMPANION_AGENT_ID='my-hermes-agent'                     # optional")
    print()
    print("3. Restart Hermes or reload your shell, then verify:")
    print()
    print("     hermes companion status")
    print()
    return 0


def register_commands(cli) -> None:  # noqa: ANN001
    """Register companion sub-commands with the Hermes CLI object.

    The ``cli`` argument is the top-level Hermes CLI group (e.g. a Click group
    or argparse subparsers object). This function is called by hermes_agent
    after the plugin is loaded.
    """
    try:
        # Attempt Click-style registration (most common in hermes_agent).
        import click  # type: ignore[import-untyped]

        @cli.group("companion")
        def _companion_group() -> None:
            """Companion Intelligence memory commands."""

        @_companion_group.command("status")
        def _status() -> None:
            """Show the current status of the Companion memory provider."""
            sys.exit(cmd_status())

        @_companion_group.command("setup")
        def _setup() -> None:
            """Print setup instructions for the Companion memory provider."""
            sys.exit(cmd_setup())

    except (ImportError, AttributeError):
        # Fallback: nothing to register — callers can invoke cmd_status /
        # cmd_setup directly.
        pass


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(prog="hermes companion")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("status", help="Show provider status")
    sub.add_parser("setup", help="Print setup instructions")

    args = parser.parse_args()
    if args.command == "status":
        sys.exit(cmd_status())
    elif args.command == "setup":
        sys.exit(cmd_setup())
    else:
        parser.print_help()
        sys.exit(1)
