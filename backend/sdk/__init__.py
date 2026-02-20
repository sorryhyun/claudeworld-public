"""
Agent management module for Claude SDK integration.

This module provides the AgentManager class and related utilities for
managing agent lifecycle, response generation, and debugging.

Package structure:
- sdk/client/ - Claude SDK integration infrastructure (client pooling, stream parsing, MCP registry)
- sdk/agent/ - High-level agent orchestration (agent manager, agent definitions)
- sdk/tools/ - Tool definitions (schemas, descriptions, input models)
- sdk/handlers/ - MCP tool handler implementations (server factories, tool call logic)
- sdk/config/ - YAML configurations (guidelines, localization)
"""

# Monkey-patch the SDK's message parser to handle rate_limit_event gracefully.
# The SDK raises MessageParseError for unknown message types like rate_limit_event,
# which kills the entire response stream. This patch converts them to SystemMessage instead.
import claude_agent_sdk._internal.client as _cl
import claude_agent_sdk._internal.message_parser as _mp
from claude_agent_sdk.types import SystemMessage as _SystemMessage

_original_parse_message = _mp.parse_message


def _patched_parse_message(data):
    if isinstance(data, dict) and data.get("type") == "rate_limit_event":
        return _SystemMessage(subtype="rate_limit", data=data)
    return _original_parse_message(data)


_mp.parse_message = _patched_parse_message
_cl.parse_message = _patched_parse_message  # type: ignore[attr-defined]  # Patch the already-imported reference

from infrastructure.logging.formatters import format_message_for_debug

# Re-exports from agent
from sdk.agent.agent_manager import AgentManager
from sdk.agent.task_subagent_definitions import (
    SUBAGENT_TYPES,
    build_subagent_definition,
    build_subagent_definitions,
)

# Re-exports from client for backwards compatibility
from sdk.client.client_pool import ClientPool
from sdk.client.stream_parser import StreamParser

# Re-exports from handlers
from sdk.handlers import create_action_mcp_server

# Subagent tools for SDK native Task pattern
from sdk.handlers.onboarding_tools import SUBAGENT_TOOL_NAMES, create_onboarding_tools

__all__ = [
    # Agent orchestration
    "AgentManager",
    # Sub-agent types and AgentDefinition builders
    "SUBAGENT_TYPES",
    "build_subagent_definition",
    "build_subagent_definitions",
    # Subagent tools
    "SUBAGENT_TOOL_NAMES",
    "create_onboarding_tools",
    # Client infrastructure
    "ClientPool",
    "StreamParser",
    # Tools
    "create_action_mcp_server",
    # Utilities
    "format_message_for_debug",
]
