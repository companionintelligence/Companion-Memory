"""Unit tests for CompanionMemoryProvider.

Run with: python -m pytest plugins/hermes-companion-memory/
"""
from __future__ import annotations

import threading
import time
import unittest
from unittest.mock import MagicMock, patch


class TestIsAvailable(unittest.TestCase):
    """Tests for CompanionMemoryProvider.is_available()."""

    def _make_provider(self):
        from hermes_companion_memory.provider import CompanionMemoryProvider
        return CompanionMemoryProvider()

    def test_is_available_when_api_key_set(self):
        with patch.dict("os.environ", {"COMPANION_API_KEY": "test-key-123"}):
            provider = self._make_provider()
            self.assertTrue(provider.is_available())

    def test_not_available_when_api_key_missing(self):
        env = {"COMPANION_API_KEY": ""}  # empty string is falsy
        with patch.dict("os.environ", env, clear=False):
            import os
            saved = os.environ.pop("COMPANION_API_KEY", None)
            try:
                provider = self._make_provider()
                self.assertFalse(provider.is_available())
            finally:
                if saved is not None:
                    os.environ["COMPANION_API_KEY"] = saved

    def test_not_available_when_env_var_absent(self):
        import os
        saved = os.environ.pop("COMPANION_API_KEY", None)
        try:
            provider = self._make_provider()
            self.assertFalse(provider.is_available())
        finally:
            if saved is not None:
                os.environ["COMPANION_API_KEY"] = saved


class TestPrefetch(unittest.TestCase):
    """Tests for CompanionMemoryProvider.prefetch() — v1 contract."""

    def _make_initialized_provider(self):
        from hermes_companion_memory.provider import CompanionMemoryProvider
        provider = CompanionMemoryProvider()
        with patch.dict("os.environ", {"COMPANION_API_KEY": "test-key"}):
            with patch("hermes_companion_memory.provider.CompanionClient"):
                provider.initialize()
        return provider

    def test_prefetch_returns_empty_string_in_v1(self):
        provider = self._make_initialized_provider()
        result = provider.prefetch("what did I do last weekend?")
        self.assertEqual(result, "")

    def test_prefetch_always_returns_str(self):
        provider = self._make_initialized_provider()
        result = provider.prefetch("")
        self.assertIsInstance(result, str)

    def test_prefetch_does_not_call_client_in_v1(self):
        from hermes_companion_memory.provider import CompanionMemoryProvider
        provider = CompanionMemoryProvider()
        mock_client = MagicMock()
        with patch.dict("os.environ", {"COMPANION_API_KEY": "test-key"}):
            with patch("hermes_companion_memory.provider.CompanionClient", return_value=mock_client):
                provider.initialize()
        provider.prefetch("test query")
        mock_client.fetch_injection.assert_not_called()
        mock_client.post_context.assert_not_called()


class TestSyncTurn(unittest.TestCase):
    """Tests for CompanionMemoryProvider.sync_turn()."""

    def _make_initialized_provider(self, mock_client=None):
        from hermes_companion_memory.provider import CompanionMemoryProvider
        provider = CompanionMemoryProvider()
        if mock_client is None:
            mock_client = MagicMock()
        with patch.dict("os.environ", {"COMPANION_API_KEY": "test-key"}):
            with patch("hermes_companion_memory.provider.CompanionClient", return_value=mock_client):
                provider.initialize()
        provider._client = mock_client
        return provider, mock_client

    def test_sync_turn_spawns_daemon_thread(self):
        """sync_turn must start a daemon thread so it never blocks agent shutdown."""
        spawned_threads: list[threading.Thread] = []
        original_start = threading.Thread.start

        def patched_start(self_thread, *args, **kwargs):
            spawned_threads.append(self_thread)
            original_start(self_thread, *args, **kwargs)

        provider, mock_client = self._make_initialized_provider()
        mock_client.post_context.return_value = {}

        with patch.object(threading.Thread, "start", patched_start):
            provider.sync_turn("Hello", "Hi there!")

        self.assertTrue(len(spawned_threads) >= 1, "Expected at least one thread to be spawned")
        # All spawned companion threads must be daemon threads.
        companion_threads = [t for t in spawned_threads if "companion-sync" in t.name]
        self.assertTrue(len(companion_threads) >= 1, "Expected a companion-sync thread")
        for t in companion_threads:
            self.assertTrue(t.daemon, f"Thread {t.name} must be a daemon thread")

    def test_sync_turn_never_raises_even_if_client_raises(self):
        """sync_turn must never propagate exceptions from the HTTP client."""
        provider, mock_client = self._make_initialized_provider()
        mock_client.post_context.side_effect = RuntimeError("network failure")

        # This must not raise.
        try:
            provider.sync_turn("user message", "assistant response")
            # Give the background thread a moment to run and (silently) fail.
            if provider._prev_sync_thread is not None:
                provider._prev_sync_thread.join(timeout=2.0)
        except Exception as exc:  # noqa: BLE001
            self.fail(f"sync_turn raised an unexpected exception: {exc}")

    def test_sync_turn_posts_messages_to_client(self):
        """sync_turn must eventually POST the turn messages to the client."""
        provider, mock_client = self._make_initialized_provider()
        mock_client.post_context.return_value = {}

        provider.sync_turn("What time is it?", "It is 3pm.")
        # Join so we can assert on the call.
        if provider._prev_sync_thread is not None:
            provider._prev_sync_thread.join(timeout=5.0)

        mock_client.post_context.assert_called_once()
        call_kwargs = mock_client.post_context.call_args.kwargs
        messages = call_kwargs.get("messages", [])
        roles = [m["role"] for m in messages]
        self.assertIn("user", roles)
        self.assertIn("assistant", roles)

    def test_sync_turn_increments_turn_index(self):
        """Each call to sync_turn must increment the turn counter."""
        provider, mock_client = self._make_initialized_provider()
        mock_client.post_context.return_value = {}

        self.assertEqual(provider._turn_index, 0)
        provider.sync_turn("msg1", "resp1")
        self.assertEqual(provider._turn_index, 1)
        provider.sync_turn("msg2", "resp2")
        self.assertEqual(provider._turn_index, 2)

    def test_sync_turn_before_initialize_does_not_raise(self):
        """sync_turn called before initialize() should silently do nothing."""
        from hermes_companion_memory.provider import CompanionMemoryProvider
        provider = CompanionMemoryProvider()  # _client is None
        try:
            provider.sync_turn("hello", "world")
        except Exception as exc:  # noqa: BLE001
            self.fail(f"sync_turn before initialize raised: {exc}")


class TestGetToolSchemas(unittest.TestCase):
    def test_get_tool_schemas_returns_empty_list_in_v1(self):
        from hermes_companion_memory.provider import CompanionMemoryProvider
        provider = CompanionMemoryProvider()
        schemas = provider.get_tool_schemas()
        self.assertEqual(schemas, [])
        self.assertIsInstance(schemas, list)


class TestHandleToolCall(unittest.TestCase):
    def test_handle_tool_call_returns_error_dict_in_v1(self):
        from hermes_companion_memory.provider import CompanionMemoryProvider
        provider = CompanionMemoryProvider()
        result = provider.handle_tool_call("companion_search", {"query": "test"})
        self.assertIn("error", result)
        self.assertEqual(result["error"], "not_implemented")


if __name__ == "__main__":
    unittest.main()
