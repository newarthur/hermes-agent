"""
Google OAuth PKCE flow for Gemini provider.

Implements Authorization Code + PKCE (S256) with a localhost callback server.
Credentials are stored independently at ~/.hermes/auth/google_oauth.json.

Public API:
    start_oauth_flow() -> dict | None
    get_valid_access_token() -> str
    load_credentials() -> dict | None
    save_credentials(creds: dict) -> None
    refresh_access_token(refresh_token: str) -> dict
    clear_credentials() -> bool
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import socket
import threading
import time
import uuid
import webbrowser
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse, urlencode

import httpx

from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Override via env vars until a built-in desktop client is registered.
DEFAULT_GEMINI_CLIENT_ID = (
    os.getenv("HERMES_GEMINI_CLIENT_ID", "").strip()
)
DEFAULT_GEMINI_CLIENT_SECRET = (
    os.getenv("HERMES_GEMINI_CLIENT_SECRET", "").strip()
)

GEMINI_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GEMINI_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
GEMINI_OAUTH_REDIRECT_URI = "http://127.0.0.1:8085/oauth2callback"
GEMINI_OAUTH_SCOPES = " ".join([
    "https://www.googleapis.com/auth/generative-language",
    "https://www.googleapis.com/auth/userinfo.email",
])

GEMINI_OAUTH_FILE = get_hermes_home() / "auth" / "google_oauth.json"
GEMINI_OAUTH_LOCK_FILE = GEMINI_OAUTH_FILE.with_suffix(".lock")

REFRESH_SKEW_SECONDS = 300  # refresh 5 min before expiry

# ---------------------------------------------------------------------------
# File locking helpers (mirrors hermes_cli/auth.py pattern)
# ---------------------------------------------------------------------------

try:
    import fcntl
except Exception:  # pragma: no cover
    fcntl = None

try:
    import msvcrt
except Exception:  # pragma: no cover
    msvcrt = None

_lock_holder = threading.local()


@contextmanager
def _credentials_lock(timeout_seconds: float = 30.0):
    """Cross-process advisory lock for google_oauth.json."""
    if getattr(_lock_holder, "depth", 0) > 0:
        _lock_holder.depth += 1
        try:
            yield
        finally:
            _lock_holder.depth -= 1
        return

    GEMINI_OAUTH_LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)

    if fcntl is None and msvcrt is None:
        _lock_holder.depth = 1
        try:
            yield
        finally:
            _lock_holder.depth = 0
        return

    if msvcrt and (not GEMINI_OAUTH_LOCK_FILE.exists() or GEMINI_OAUTH_LOCK_FILE.stat().st_size == 0):
        GEMINI_OAUTH_LOCK_FILE.write_text(" ", encoding="utf-8")

    with GEMINI_OAUTH_LOCK_FILE.open("r+" if msvcrt else "a+") as lock_file:
        deadline = time.time() + max(1.0, timeout_seconds)
        while True:
            try:
                if fcntl:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                else:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except (BlockingIOError, OSError, PermissionError):
                if time.time() >= deadline:
                    raise TimeoutError("Timed out waiting for Gemini OAuth credentials lock")
                time.sleep(0.05)

        _lock_holder.depth = 1
        try:
            yield
        finally:
            _lock_holder.depth = 0
            if fcntl:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            elif msvcrt:
                try:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                except (OSError, IOError):
                    pass


# ---------------------------------------------------------------------------
# PKCE helpers
# ---------------------------------------------------------------------------

def _generate_pkce() -> tuple[str, str]:
    """Generate PKCE code_verifier and code_challenge (S256)."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    return verifier, challenge


def _get_client_credentials() -> tuple[str, str]:
    """Return (client_id, client_secret) from env or defaults."""
    client_id = os.getenv("HERMES_GEMINI_CLIENT_ID", DEFAULT_GEMINI_CLIENT_ID).strip()
    client_secret = os.getenv("HERMES_GEMINI_CLIENT_SECRET", DEFAULT_GEMINI_CLIENT_SECRET).strip()
    if not client_id:
        raise RuntimeError(
            "Google OAuth client_id is not configured. "
            "Hermes does not ship with a built-in Google OAuth client.\n\n"
            "To use the Gemini OAuth provider:\n"
            "1. Go to https://console.cloud.google.com/apis/credentials\n"
            "2. Create a Desktop app OAuth client ID\n"
            "3. Enable the Generative Language API\n"
            "4. Set the environment variable:\n"
            "   export HERMES_GEMINI_CLIENT_ID=\"your-client-id.apps.googleusercontent.com\"\n\n"
            "See docs: https://docs.hermesagent.ai/integrations/providers#google-gemini-cli-oauth"
        )
    return client_id, client_secret


# ---------------------------------------------------------------------------
# Credential I/O
# ---------------------------------------------------------------------------

def load_credentials() -> Optional[Dict[str, Any]]:
    """Load credentials from disk inside a lock."""
    with _credentials_lock():
        if not GEMINI_OAUTH_FILE.exists():
            return None
        try:
            return json.loads(GEMINI_OAUTH_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None


def save_credentials(creds: Dict[str, Any]) -> None:
    """Atomically save credentials to disk inside a lock, with 0o600 permissions."""
    with _credentials_lock():
        GEMINI_OAUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(creds, indent=2) + "\n"
        tmp_path = GEMINI_OAUTH_FILE.with_name(
            f"{GEMINI_OAUTH_FILE.name}.tmp.{os.getpid()}.{uuid.uuid4().hex}"
        )
        try:
            with tmp_path.open("w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, GEMINI_OAUTH_FILE)
            # Restrict to owner read/write only
            os.chmod(GEMINI_OAUTH_FILE, 0o600)
        finally:
            if tmp_path.exists():
                tmp_path.unlink()


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _post_token_exchange(data: Dict[str, Any]) -> Dict[str, Any]:
    """POST to Google token endpoint and return parsed JSON."""
    resp = httpx.post(
        GEMINI_OAUTH_TOKEN_URL,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=30.0,
    )
    resp.raise_for_status()
    return resp.json()


def exchange_code(code: str, verifier: str) -> Dict[str, Any]:
    """Exchange authorization code for tokens."""
    client_id, client_secret = _get_client_credentials()
    payload: Dict[str, Any] = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": code,
        "redirect_uri": GEMINI_OAUTH_REDIRECT_URI,
        "code_verifier": verifier,
    }
    if client_secret:
        payload["client_secret"] = client_secret
    result = _post_token_exchange(payload)
    return _normalize_token_response(result)


def refresh_access_token(refresh_token: str) -> Dict[str, Any]:
    """Refresh an access token."""
    client_id, client_secret = _get_client_credentials()
    payload: Dict[str, Any] = {
        "grant_type": "refresh_token",
        "client_id": client_id,
        "refresh_token": refresh_token,
    }
    if client_secret:
        payload["client_secret"] = client_secret
    result = _post_token_exchange(payload)
    return _normalize_token_response(result)


def _normalize_token_response(result: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize Google token response and add computed expiry."""
    access_token = result.get("access_token", "")
    refresh_token = result.get("refresh_token", "")
    expires_in = result.get("expires_in", 3600)
    scope = result.get("scope", "")
    token_type = result.get("token_type", "Bearer")

    if not access_token:
        raise RuntimeError("Token response did not contain access_token")

    expires_at = time.time() + int(expires_in)
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_at": expires_at,
        "expires_in": int(expires_in),
        "scope": scope,
        "token_type": token_type,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Localhost callback server
# ---------------------------------------------------------------------------

def _build_auth_url(verifier: str, challenge: str, state: str) -> str:
    client_id, _ = _get_client_credentials()
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": GEMINI_OAUTH_REDIRECT_URI,
        "scope": GEMINI_OAUTH_SCOPES,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "access_type": "offline",
        "prompt": "consent",
    }
    return f"{GEMINI_OAUTH_AUTH_URL}?{urlencode(params)}"


def _start_callback_server(port: int = 8085, timeout: float = 300.0) -> Optional[Dict[str, Any]]:
    """Start a localhost HTTP server to capture the OAuth callback."""
    from http.server import BaseHTTPRequestHandler, HTTPServer

    result_container: Dict[str, Any] = {"code": None, "error": None}
    ready_event = threading.Event()

    class CallbackHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            # suppress default stderr logging
            pass

        def _send_html(self, status: int, body: str):
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path != "/oauth2callback":
                self._send_html(404, "<h1>Not Found</h1>")
                return

            qs = parse_qs(parsed.query)
            code = qs.get("code", [None])[0]
            error = qs.get("error", [None])[0]
            state = qs.get("state", [None])[0]

            if error:
                result_container["error"] = error
                self._send_html(
                    400,
                    f"""<html>
                    <body style="font-family:sans-serif;text-align:center;padding:40px">
                        <h2 style="color:#c00">Authorization failed</h2>
                        <p>{error}</p>
                    </body></html>""",
                )
                ready_event.set()
                return

            if not code:
                result_container["error"] = "missing_code"
                self._send_html(
                    400,
                    """<html>
                    <body style="font-family:sans-serif;text-align:center;padding:40px">
                        <h2 style="color:#c00">Authorization failed</h2>
                        <p>No authorization code received.</p>
                    </body></html>""",
                )
                ready_event.set()
                return

            result_container["code"] = code
            result_container["state"] = state
            self._send_html(
                200,
                """<html>
                <body style="font-family:sans-serif;text-align:center;padding:40px">
                    <h2 style="color:#090">Authorization successful</h2>
                    <p>You can close this tab and return to Hermes.</p>
                </body></html>""",
            )
            ready_event.set()

    # Try to bind to the port
    try:
        server = HTTPServer(("127.0.0.1", port), CallbackHandler)
    except socket.error as exc:
        logger.debug("Could not bind callback server to port %s: %s", port, exc)
        return None

    server.timeout = 1.0
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.5})
    thread.daemon = True
    thread.start()

    # Wait for the callback or timeout
    ready = ready_event.wait(timeout=timeout)
    server.shutdown()
    server.server_close()
    thread.join(timeout=5.0)

    if not ready:
        return {"error": "timeout"}
    if result_container.get("error"):
        return {"error": result_container["error"]}
    return {"code": result_container["code"], "state": result_container.get("state", "")}


# ---------------------------------------------------------------------------
# Public flow entry points
# ---------------------------------------------------------------------------

def start_oauth_flow(open_browser: bool = True) -> Optional[Dict[str, Any]]:
    """
    Start the full PKCE OAuth flow.

    Returns a credentials dict on success, or None if the user cancels.
    Stores the resulting credentials to disk automatically.
    """
    verifier, challenge = _generate_pkce()
    state = base64.urlsafe_b64encode(secrets.token_bytes(16)).rstrip(b"=").decode()

    try:
        auth_url = _build_auth_url(verifier, challenge, state)
    except RuntimeError as exc:
        print(f"[Gemini OAuth] {exc}")
        return None

    print()
    print("Authorize Hermes with Google Gemini.")
    print()
    print("╭─ Google Gemini Authorization ─────────────────────╮")
    print("│                                                   │")
    print("│  Open this link in your browser:                  │")
    print("╰───────────────────────────────────────────────────╯")
    print()
    print(f"  {auth_url}")
    print()

    if open_browser:
        try:
            webbrowser.open(auth_url)
            print("  (Browser opened automatically)")
        except Exception:
            pass

    # Attempt localhost callback first
    callback_result = _start_callback_server(port=8085, timeout=300.0)

    if callback_result is None:
        # Fallback: manual code entry
        print()
        print("Unable to start local callback server (port 8085 may be in use).")
        print("After authorizing, paste the full callback URL or the code below.")
        print()
        try:
            raw = input("Callback URL or code: ").strip()
        except (KeyboardInterrupt, EOFError):
            return None
        if not raw:
            print("No code entered.")
            return None

        # Try to extract code from a pasted URL
        if raw.startswith("http"):
            parsed = urlparse(raw)
            qs = parse_qs(parsed.query)
            code = qs.get("code", [None])[0]
            received_state = qs.get("state", [None])[0]
        else:
            code = raw
            received_state = ""

        if not code:
            print("Could not parse authorization code from input.")
            return None
        callback_result = {"code": code, "state": received_state or ""}

    if callback_result.get("error"):
        print(f"Authorization failed: {callback_result['error']}")
        return None

    code = callback_result["code"]
    received_state = callback_result.get("state", "")

    if received_state and received_state != state:
        print("Authorization failed: state mismatch (possible CSRF).")
        return None

    try:
        tokens = exchange_code(code, verifier)
    except Exception as exc:
        print(f"Token exchange failed: {exc}")
        return None

    # Fetch user email via Google UserInfo API
    email = ""
    try:
        userinfo_resp = httpx.get(
            "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
            timeout=15.0,
        )
        if userinfo_resp.status_code == 200:
            email = userinfo_resp.json().get("email", "")
    except Exception:
        pass

    creds = {
        "client_id": _get_client_credentials()[0],
        "client_secret": _get_client_credentials()[1],
        "email": email,
        **tokens,
    }
    save_credentials(creds)
    return creds


def get_valid_access_token(
    *,
    refresh_if_expiring: bool = True,
    skew_seconds: float = REFRESH_SKEW_SECONDS,
) -> str:
    """
    Return a valid access token, refreshing automatically if needed.

    Raises RuntimeError if no credentials exist or refresh fails.
    """
    creds = load_credentials()
    if not creds:
        raise RuntimeError(
            "No Gemini OAuth credentials found. Run `hermes auth add google-gemini-cli` to authenticate."
        )

    access_token = creds.get("access_token", "")
    expires_at = creds.get("expires_at")
    refresh_token = creds.get("refresh_token", "")

    now = time.time()
    needs_refresh = (
        refresh_if_expiring
        and refresh_token
        and (expires_at is None or now >= (expires_at - skew_seconds))
    )

    if not needs_refresh:
        if not access_token:
            raise RuntimeError("Gemini OAuth credentials are missing access_token.")
        return access_token

    try:
        new_tokens = refresh_access_token(refresh_token)
    except Exception as exc:
        raise RuntimeError(f"Failed to refresh Gemini access token: {exc}") from exc

    # Preserve the existing refresh_token if Google didn't return a new one
    if not new_tokens.get("refresh_token"):
        new_tokens["refresh_token"] = refresh_token

    updated = {
        **creds,
        **new_tokens,
    }
    save_credentials(updated)
    return new_tokens["access_token"]


def clear_credentials() -> bool:
    """Delete stored Gemini OAuth credentials. Returns True if a file was removed."""
    with _credentials_lock():
        if GEMINI_OAUTH_FILE.exists():
            GEMINI_OAUTH_FILE.unlink()
            return True
        return False
