from types import SimpleNamespace

from agent.copilot_acp_client import _coerce_timeout_seconds, _DEFAULT_TIMEOUT_SECONDS


def test_coerce_timeout_seconds_accepts_numeric():
    assert _coerce_timeout_seconds(12) == 12.0
    assert _coerce_timeout_seconds(1.5) == 1.5


def test_coerce_timeout_seconds_preserves_previous_falsy_semantics():
    assert _coerce_timeout_seconds(0) == _DEFAULT_TIMEOUT_SECONDS
    assert _coerce_timeout_seconds(False) == _DEFAULT_TIMEOUT_SECONDS


def test_coerce_timeout_seconds_accepts_openai_style_timeout_object():
    timeout = SimpleNamespace(read=45.0)
    assert _coerce_timeout_seconds(timeout) == 45.0


def test_coerce_timeout_seconds_uses_default_for_falsy_timeout_object_fields():
    timeout = SimpleNamespace(read=0)
    assert _coerce_timeout_seconds(timeout) == _DEFAULT_TIMEOUT_SECONDS


def test_coerce_timeout_seconds_falls_back_to_default_for_unknown_object():
    timeout = SimpleNamespace(connect=10.0)
    assert _coerce_timeout_seconds(timeout) == _DEFAULT_TIMEOUT_SECONDS
