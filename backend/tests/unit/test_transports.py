from unittest.mock import Mock, patch

from claude_agent_sdk import ClaudeAgentOptions
from domain.value_objects.task_identifier import TaskIdentifier
from sdk.client.transports import JsonlLoggingSubprocessTransport, build_transport


def test_build_transport_disabled_returns_none():
    with patch(
        "sdk.client.transports.get_debug_config",
        return_value={"debug": {"logging": {"transport": {"enabled": False}}}},
    ):
        transport = build_transport(ClaudeAgentOptions(), TaskIdentifier(room_id=1, agent_id=2))
        assert transport is None


def test_build_transport_enabled_returns_logging_transport(tmp_path):
    dummy_settings = Mock()
    dummy_settings.backend_dir = tmp_path

    with (
        patch(
            "sdk.client.transports.get_debug_config",
            return_value={
                "debug": {
                    "enabled": True,
                    "logging": {"transport": {"enabled": True}},
                }
            },
        ),
        patch("sdk.client.transports.get_settings", return_value=dummy_settings),
    ):
        transport = build_transport(ClaudeAgentOptions(), TaskIdentifier(room_id=1, agent_id=2))
        assert isinstance(transport, JsonlLoggingSubprocessTransport)
        assert transport._log_path.name.startswith("transport_room1_agent2_")  # noqa: SLF001
        assert transport._log_path.name.endswith(".jsonl")  # noqa: SLF001
