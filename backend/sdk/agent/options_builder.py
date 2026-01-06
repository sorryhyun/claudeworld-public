"""
Claude Agent SDK options builder.

This module provides functions to build ClaudeAgentOptions for agent
response generation, including MCP server configuration and hooks.
"""

from __future__ import annotations

import logging
import os
import sys
import tempfile
from typing import TYPE_CHECKING

from claude_agent_sdk import ClaudeAgentOptions
from core import get_settings

from sdk.agent.hooks import build_hooks
from sdk.agent.task_subagent_definitions import build_subagent_definitions_for_agent
from sdk.client.mcp_registry import get_mcp_registry

if TYPE_CHECKING:
    from domain.value_objects.contexts import AgentResponseContext

    from sdk.agent.agent_manager import AgentManager

logger = logging.getLogger(__name__)

# Get settings singleton
_settings = get_settings()
USE_SONNET = _settings.use_sonnet
ENABLE_CLI_TRACING = _settings.enable_cli_tracing

# Cached cwd for Claude agent SDK (created once per process)
_claude_cwd: str | None = None


def _get_claude_cwd() -> str:
    """Get or create a cross-platform temporary directory for Claude agent SDK.

    This creates an empty directory that exists (required by SDK subprocess).
    Uses tempfile for cross-platform compatibility (works on both Windows and Linux).
    """
    global _claude_cwd
    if _claude_cwd is None or not os.path.exists(_claude_cwd):
        # Create a persistent temp directory for this process
        _claude_cwd = os.path.join(tempfile.gettempdir(), "claude-empty")
        os.makedirs(_claude_cwd, exist_ok=True)
    return _claude_cwd


def build_agent_options(
    context: AgentResponseContext,
    system_prompt: str,
    anthropic_calls_capture: list[str] | None = None,
    agent_manager: "AgentManager | None" = None,
) -> tuple[ClaudeAgentOptions, str]:
    """
    Build Claude Agent SDK options for the agent.

    Args:
        context: Agent response context
        system_prompt: The system prompt to use
        anthropic_calls_capture: Optional list to capture anthropic tool call situations
        agent_manager: Optional AgentManager for pre-connection in tools

    Returns:
        Tuple of (ClaudeAgentOptions, config_hash)
        - config_hash is used by ClientPool to detect when MCP config has changed
    """
    # Use MCP registry to build server configuration (cached based on context hash)
    mcp_registry = get_mcp_registry()
    mcp_config = mcp_registry.build_mcp_config(context, agent_manager=agent_manager)

    # Build hooks
    hooks = build_hooks(context, anthropic_calls_capture)

    # Build output_format if provided (must be included at connect time)
    output_format = context.output_format if context.output_format else None

    # Build sub-agent definitions for agents that can invoke sub-agents
    # (Action Manager, Onboarding Manager)
    agents = build_subagent_definitions_for_agent(context.agent_name)
    if agents:
        logger.debug(f"Adding {len(agents)} sub-agent definitions for {context.agent_name}")

    # Build environment variables
    env = {
        "CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK": "true",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "true",
        "DISABLE_TELEMETRY": "true",
        "CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK": "true",
    }

    # Add tracing environment variables if enabled (requires patched CLI with observability)
    if ENABLE_CLI_TRACING:
        env.update(
            {
                "CCDECOMP_PHASE_TRACE": "1",
                "CCDECOMP_PHASE_TRACE_FORMAT": "jsonl",
                "CCDECOMP_TELEMETRY_TRACE": "1",
                "CCDECOMP_TELEMETRY_DRY_RUN": "1",
                "CCDECOMP_TELEMETRY_TRACE_FORMAT": "jsonl",
            }
        )
        logger.info("CLI tracing enabled - traces will be written to stderr")

    # Only use custom cli_path in development mode; packaged .exe uses native Claude Code CLI
    cli_path = (
        None
        if getattr(sys, "frozen", False)
        else os.path.join(os.path.dirname(__file__), "..", "cli.js")
    )

    options = ClaudeAgentOptions(
        model="claude-opus-4-5-20251101" if not USE_SONNET else "claude-sonnet-4-5-20250929",
        system_prompt=system_prompt,
        cli_path=cli_path,
        permission_mode="bypassPermissions",
        max_thinking_tokens=32768,
        mcp_servers=mcp_config.mcp_servers,
        allowed_tools=mcp_config.allowed_tool_names + ["Task", "TaskOutput"],
        tools=mcp_config.allowed_tool_names + ["Task", "TaskOutput"],
        setting_sources=[],
        cwd=_get_claude_cwd(),
        env=env,
        hooks=hooks,
        output_format=output_format,
        include_partial_messages=True,
        agents=agents,
    )

    if context.session_id:
        options.resume = context.session_id

    return options, mcp_config.config_hash
