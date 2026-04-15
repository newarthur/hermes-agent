"""Tests for agent/google_oauth.py — Google OAuth PKCE flow."""

import json
import os
import time
from unittest.mock import patch, MagicMock

import pytest

from agent import google_oauth


@pytest.fixture(autouse=True)
def _isolate_gemini_oauth(monkeypatch, tmp_path):
    """Redirect Gemini OAuth files into a temp directory."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    # Recompute module-level paths based on the new HERMES_HOME
    monkeypatch.setattr(google_oauth, "GEMINI_OAUTH_FILE", home / "auth" / "google_oauth.json")
    monkeypatch.setattr(google_oauth, "GEMINI_OAUTH_LOCK_FILE", home / "auth" / "google_oauth.json.lock")


@pytest.fixture(autouse=True)
def _clean_gemini_env(monkeypatch):
    """Remove any real Gemini client credentials from the environment."""
    for var in ("HERMES_GEMINI_CLIENT_ID", "HERMES_GEMINI_CLIENT_SECRET"):
        monkeypatch.delenv(var, raising=False)


# ── PKCE helpers ──

class TestGeneratePkce:
    def test_returns_verifier_and_challenge(self):
        verifier, challenge = google_oauth._generate_pkce()
        assert len(verifier) > 20
        assert len(challenge) > 20
        assert verifier != challenge


# ── Client credentials ──

class TestGetClientCredentials:
    def test_raises_when_not_configured(self):
        with pytest.raises(RuntimeError, match="client_id is not configured"):
            google_oauth._get_client_credentials()

    def test_uses_env_vars(self, monkeypatch):
        monkeypatch.setenv("HERMES_GEMINI_CLIENT_ID", "test-client-id")
        monkeypatch.setenv("HERMES_GEMINI_CLIENT_SECRET", "test-secret")
        client_id, client_secret = google_oauth._get_client_credentials()
        assert client_id == "test-client-id"
        assert client_secret == "test-secret"


# ── Credential I/O ──

class TestCredentialIo:
    def test_load_credentials_missing(self):
        assert google_oauth.load_credentials() is None

    def test_save_and_load_roundtrip(self):
        creds = {"access_token": "tok", "refresh_token": "ref", "expires_at": 123}
        google_oauth.save_credentials(creds)
        loaded = google_oauth.load_credentials()
        assert loaded["access_token"] == "tok"
        assert loaded["refresh_token"] == "ref"

    def test_file_permissions(self):
        google_oauth.save_credentials({"access_token": "x"})
        mode = oct(google_oauth.GEMINI_OAUTH_FILE.stat().st_mode)[-3:]
        assert mode == "600"

    def test_clear_credentials(self):
        google_oauth.save_credentials({"access_token": "x"})
        assert google_oauth.clear_credentials() is True
        assert google_oauth.load_credentials() is None
        assert google_oauth.clear_credentials() is False


# ── Token exchange ──

class TestTokenExchange:
    def test_normalize_token_response(self):
        result = google_oauth._normalize_token_response(
            {"access_token": "abc", "expires_in": 3600, "token_type": "Bearer"}
        )
        assert result["access_token"] == "abc"
        assert result["token_type"] == "Bearer"
        assert result["expires_in"] == 3600
        assert result["expires_at"] > time.time()

    def test_exchange_code(self, monkeypatch):
        monkeypatch.setenv("HERMES_GEMINI_CLIENT_ID", "cid")
        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "access_token": "atok",
            "refresh_token": "rtok",
            "expires_in": 3600,
        }
        mock_resp.raise_for_status = MagicMock()
        with patch("agent.google_oauth.httpx.post", return_value=mock_resp) as mock_post:
            result = google_oauth.exchange_code("code123", "verifier")
        assert result["access_token"] == "atok"
        args, kwargs = mock_post.call_args
        assert kwargs["data"]["code"] == "code123"
        assert kwargs["data"]["code_verifier"] == "verifier"

    def test_refresh_access_token(self, monkeypatch):
        monkeypatch.setenv("HERMES_GEMINI_CLIENT_ID", "cid")
        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "access_token": "new_atok",
            "expires_in": 3600,
        }
        mock_resp.raise_for_status = MagicMock()
        with patch("agent.google_oauth.httpx.post", return_value=mock_resp) as mock_post:
            result = google_oauth.refresh_access_token("old_rtok")
        assert result["access_token"] == "new_atok"
        args, kwargs = mock_post.call_args
        assert kwargs["data"]["grant_type"] == "refresh_token"
        assert kwargs["data"]["refresh_token"] == "old_rtok"


# ── Valid access token ──

class TestGetValidAccessToken:
    def test_raises_when_no_credentials(self):
        with pytest.raises(RuntimeError, match="No Gemini OAuth credentials found"):
            google_oauth.get_valid_access_token()

    def test_returns_unexpired_token(self):
        google_oauth.save_credentials({
            "access_token": "fresh",
            "expires_at": time.time() + 600,
            "refresh_token": "ref",
        })
        assert google_oauth.get_valid_access_token() == "fresh"

    def test_refreshes_when_expiring(self, monkeypatch):
        monkeypatch.setenv("HERMES_GEMINI_CLIENT_ID", "cid")
        google_oauth.save_credentials({
            "access_token": "stale",
            "expires_at": time.time() + 10,
            "refresh_token": "ref",
        })
        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "access_token": "refreshed",
            "expires_in": 3600,
        }
        mock_resp.raise_for_status = MagicMock()
        with patch("agent.google_oauth.httpx.post", return_value=mock_resp):
            token = google_oauth.get_valid_access_token()
        assert token == "refreshed"
        loaded = google_oauth.load_credentials()
        assert loaded["access_token"] == "refreshed"

    def test_preserves_refresh_token_if_not_returned(self, monkeypatch):
        monkeypatch.setenv("HERMES_GEMINI_CLIENT_ID", "cid")
        google_oauth.save_credentials({
            "access_token": "stale",
            "expires_at": time.time() + 10,
            "refresh_token": "persistent_ref",
        })
        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "access_token": "refreshed",
            "expires_in": 3600,
            # no refresh_token
        }
        mock_resp.raise_for_status = MagicMock()
        with patch("agent.google_oauth.httpx.post", return_value=mock_resp):
            google_oauth.get_valid_access_token()
        loaded = google_oauth.load_credentials()
        assert loaded["refresh_token"] == "persistent_ref"


# ── Callback server ──

class TestCallbackServer:
    def _make_request_mock(self):
        """Return a mock socket/request object that BaseHTTPRequestHandler can initialize."""
        from io import BytesIO
        request = MagicMock()
        # BaseHTTPRequestHandler reads from rfile
        request.makefile.return_value = BytesIO(b"GET /oauth2callback HTTP/1.1\r\n\r\n")
        return request

    def test_returns_code_on_success(self):
        from urllib.parse import urlencode
        with patch("http.server.HTTPServer") as mock_server_cls:
            mock_server = MagicMock()
            mock_server_cls.return_value = mock_server

            # Simulate a thread that immediately sets the result via do_GET
            def simulate_request(*args, **kwargs):
                from io import BytesIO
                # Find the handler class
                handler_cls = mock_server_cls.call_args[0][1]
                request = self._make_request_mock()
                client_address = ("127.0.0.1", 12345)
                server = mock_server
                # Prevent BaseHTTPRequestHandler from auto-handling during __init__
                with patch.object(handler_cls, "handle"):
                    handler = handler_cls(request, client_address, server)
                handler.path = "/oauth2callback?" + urlencode({"code": "abc123", "state": "st"})
                # Bypass real HTTP response writing
                handler._send_html = lambda status, body: None
                handler.do_GET()

            mock_server.serve_forever.side_effect = simulate_request

            result = google_oauth._start_callback_server(port=8085, timeout=1.0)
            assert result["code"] == "abc123"
            assert result["state"] == "st"

    def test_returns_error_on_denied(self):
        from urllib.parse import urlencode
        with patch("http.server.HTTPServer") as mock_server_cls:
            mock_server = MagicMock()
            mock_server_cls.return_value = mock_server

            def simulate_request(*args, **kwargs):
                from io import BytesIO
                handler_cls = mock_server_cls.call_args[0][1]
                request = self._make_request_mock()
                client_address = ("127.0.0.1", 12345)
                server = mock_server
                with patch.object(handler_cls, "handle"):
                    handler = handler_cls(request, client_address, server)
                handler.path = "/oauth2callback?" + urlencode({"error": "access_denied"})
                handler._send_html = lambda status, body: None
                handler.do_GET()

            mock_server.serve_forever.side_effect = simulate_request

            result = google_oauth._start_callback_server(port=8085, timeout=1.0)
            assert result["error"] == "access_denied"

    def test_returns_none_when_port_in_use(self):
        with patch("http.server.HTTPServer", side_effect=OSError("Address in use")):
            result = google_oauth._start_callback_server(port=8085, timeout=1.0)
            assert result is None


# ── Full OAuth flow ──

class TestStartOauthFlow:
    def test_successful_flow_with_callback(self, monkeypatch):
        monkeypatch.setenv("HERMES_GEMINI_CLIENT_ID", "cid")
        callback_result = {"code": "code123", "state": "st"}

        with patch("agent.google_oauth._start_callback_server", return_value=callback_result):
            with patch("agent.google_oauth.webbrowser.open"):
                with patch("agent.google_oauth.httpx.post") as mock_post:
                    mock_post.return_value = MagicMock(
                        json=lambda: {
                            "access_token": "atok",
                            "refresh_token": "rtok",
                            "expires_in": 3600,
                        },
                        raise_for_status=MagicMock(),
                    )
                    with patch("agent.google_oauth.httpx.get") as mock_get:
                        mock_get.return_value = MagicMock(
                            status_code=200,
                            json=lambda: {"email": "user@example.com"},
                        )
                        # Patch state generation so we can match it
                        with patch("agent.google_oauth.secrets.token_bytes", return_value=b"x" * 16):
                            with patch("agent.google_oauth.base64.urlsafe_b64encode", return_value=b"st"):
                                creds = google_oauth.start_oauth_flow(open_browser=False)

        assert creds is not None
        assert creds["access_token"] == "atok"
        assert creds["email"] == "user@example.com"
        assert google_oauth.load_credentials() is not None

    def test_fallback_manual_entry(self, monkeypatch):
        monkeypatch.setenv("HERMES_GEMINI_CLIENT_ID", "cid")

        with patch("agent.google_oauth._start_callback_server", return_value=None):
            with patch("agent.google_oauth.webbrowser.open"):
                with patch("agent.google_oauth.httpx.post") as mock_post:
                    mock_post.return_value = MagicMock(
                        json=lambda: {
                            "access_token": "atok",
                            "refresh_token": "rtok",
                            "expires_in": 3600,
                        },
                        raise_for_status=MagicMock(),
                    )
                    with patch("agent.google_oauth.httpx.get") as mock_get:
                        mock_get.return_value = MagicMock(
                            status_code=200,
                            json=lambda: {"email": "user@example.com"},
                        )
                        with patch("builtins.input", return_value="code123"):
                            creds = google_oauth.start_oauth_flow(open_browser=False)

        assert creds is not None
        assert creds["access_token"] == "atok"

    def test_state_mismatch_cancels(self, monkeypatch):
        monkeypatch.setenv("HERMES_GEMINI_CLIENT_ID", "cid")
        callback_result = {"code": "code123", "state": "wrong_state"}

        with patch("agent.google_oauth._start_callback_server", return_value=callback_result):
            with patch("agent.google_oauth.webbrowser.open"):
                with patch("agent.google_oauth.secrets.token_bytes", return_value=b"x" * 16):
                    with patch("agent.google_oauth.base64.urlsafe_b64encode", return_value=b"expected_state"):
                        creds = google_oauth.start_oauth_flow(open_browser=False)

        assert creds is None

    def test_cancellation_on_error(self, monkeypatch):
        monkeypatch.setenv("HERMES_GEMINI_CLIENT_ID", "cid")
        callback_result = {"error": "access_denied"}

        with patch("agent.google_oauth._start_callback_server", return_value=callback_result):
            with patch("agent.google_oauth.webbrowser.open"):
                creds = google_oauth.start_oauth_flow(open_browser=False)

        assert creds is None
