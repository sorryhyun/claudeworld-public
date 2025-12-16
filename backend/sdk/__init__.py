"""
Agent management module for Claude SDK integration.

This module provides the AgentManager class and related utilities for
managing agent lifecycle, response generation, and debugging.

Package structure:
- sdk/client/ - Claude SDK integration infrastructure (client pooling, stream parsing, MCP registry)
- sdk/agent/ - High-level agent orchestration (agent manager, agent definitions, subagent prompts)
- sdk/tools/ - MCP tool implementations (onboarding_tools includes sub-agent tools for SDK native pattern)
- sdk/config/ - YAML configurations (tools, guidelines, debug)
"""

from infrastructure.logging.formatters import format_message_for_debug

from sdk.agent.agent_definitions import build_subagent_definition, build_subagent_definitions

# Re-exports from agent
from sdk.agent.agent_manager import AgentManager
from sdk.agent.subagent_prompts import SUBAGENT_PROMPTS, get_subagent_prompt

# Re-exports from client for backwards compatibility
from sdk.client.client_pool import ClientPool
from sdk.client.stream_parser import StreamParser

# Re-exports from tools
from sdk.tools import create_action_mcp_server

# Subagent tools for SDK native Task pattern
from sdk.tools.gameplay_tools.onboarding_tools import SUBAGENT_TOOL_NAMES, create_onboarding_tools

__all__ = [
    # Agent orchestration
    "AgentManager",
    # Sub-agent prompts
    "SUBAGENT_PROMPTS",
    "get_subagent_prompt",
    # AgentDefinition builders
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
