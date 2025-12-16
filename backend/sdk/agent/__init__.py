"""SDK agent components - high-level agent orchestration."""

# AgentDefinition builders for SDK native pattern
from sdk.agent.agent_definitions import (
    build_subagent_definition,
    build_subagent_definitions,
)
from sdk.agent.agent_manager import AgentManager
from sdk.agent.subagent_prompts import SUBAGENT_PROMPTS, get_subagent_prompt

__all__ = [
    "AgentManager",
    # Sub-agent prompts
    "SUBAGENT_PROMPTS",
    "get_subagent_prompt",
    # AgentDefinition builders
    "build_subagent_definition",
    "build_subagent_definitions",
]
