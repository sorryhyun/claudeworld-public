"""
Tool configuration functions.

Provides functions to get tool descriptions, schemas, and groupings.

YAML Structure (group-based):
  action:
    skip: { name, description, input_schema, response, enabled }
    memorize: { ... }
  guidelines:
    read: { ... }
  onboarding:
    complete: { ... }
  action_manager:
    stat_calc: { ... }
  narrator:
    suggest_actions: { ... }
"""

import logging
from typing import Any, Dict, Optional, Tuple

from .yaml_loaders import (
    get_conversation_context_config,
    get_group_config,
    get_guidelines_config,
    get_tools_config,
    merge_tool_configs,
)

logger = logging.getLogger(__name__)

# Known group names in tools.yaml and gameplay_tools.yaml
TOOL_GROUPS = ["action", "guidelines", "onboarding", "action_manager", "narrator"]


def _find_tool_in_config(
    tools_config: Dict[str, Any], tool_name: str
) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """
    Find a tool by name across all groups.

    Args:
        tools_config: Tools configuration dictionary (group-based structure)
        tool_name: Short name of the tool (e.g., "skip", "complete")

    Returns:
        Tuple of (group_name, tool_config) or (None, None) if not found
    """
    for group_name in TOOL_GROUPS:
        if group_name in tools_config:
            group_tools = tools_config[group_name]
            if isinstance(group_tools, dict) and tool_name in group_tools:
                return group_name, group_tools[tool_name]
    return None, None


def _get_tools_config_for_group(group_name: Optional[str] = None) -> Dict[str, Any]:
    """
    Get tools configuration with group-specific overrides applied.

    Args:
        group_name: Optional agent group name to apply group-specific overrides

    Returns:
        Tools configuration dictionary (merged with group config if applicable)
    """
    base_config = get_tools_config()

    if not group_name:
        return base_config

    # Load and merge group config
    group_config = get_group_config(group_name)
    if group_config:
        return merge_tool_configs(base_config, group_config)

    return base_config


def get_tool_description(
    tool_name: str,
    agent_name: str = "",
    config_sections: str = "",
    situation_builder_note: str = "",
    memory_subtitles: str = "",
    group_name: Optional[str] = None,
    default: Optional[str] = None,
) -> Optional[str]:
    """
    Get a tool description with template variables substituted.

    Args:
        tool_name: Name of the tool (skip, memorize, recall, read, complete, etc.)
        agent_name: Agent name to substitute in templates
        config_sections: Configuration sections for the configuration tool
        situation_builder_note: Situation builder note to include
        memory_subtitles: Available memory subtitles for the recall tool
        group_name: Optional agent group name to apply group-specific overrides
        default: Default description if tool not found in configuration

    Returns:
        Tool description string with variables substituted, or default/None if tool not found
    """
    # Handle guidelines tool specially - it loads from a separate file
    # (not defined in tools.yaml, loaded from guidelines_3rd.yaml)
    if tool_name == "guidelines":
        guidelines_config = get_guidelines_config()
        active_version = guidelines_config.get("active_version", "v1")
        template = guidelines_config.get(active_version, {}).get("template", "")

        # Substitute template variables
        description = template.format(agent_name=agent_name, situation_builder_note=situation_builder_note)
        return description

    # For other tools, load from tools.yaml (with optional group overrides)
    tools_config = _get_tools_config_for_group(group_name)

    # Find tool across all groups
    _, tool_config = _find_tool_in_config(tools_config, tool_name)

    if not tool_config:
        if default is not None:
            return default
        logger.warning(f"Tool '{tool_name}' not found in configuration")
        return None

    # Check if tool is enabled
    if not tool_config.get("enabled", True):
        logger.debug(f"Tool '{tool_name}' is disabled in configuration")
        return None

    # Get description from tools.yaml (or group override)
    description = tool_config.get("description", "")

    # Substitute template variables
    description = description.format(
        agent_name=agent_name,
        config_sections=config_sections,
        situation_builder_note=situation_builder_note,
        memory_subtitles=memory_subtitles,
    )

    return description


def get_tool_input_schema(tool_name: str) -> Dict[str, Any]:
    """
    Get the input schema for a tool, converted to proper JSON Schema format.

    The YAML config uses a simplified format:
        param_name:
          type: "string"
          description: "..."
          required: true

    This function converts it to proper JSON Schema:
        {
          "type": "object",
          "properties": {
            "param_name": {"type": "string", "description": "..."}
          },
          "required": ["param_name"]
        }

    Args:
        tool_name: Name of the tool

    Returns:
        JSON Schema dictionary for the tool's input
    """
    tools_config = get_tools_config()

    _, tool_config = _find_tool_in_config(tools_config, tool_name)

    if not tool_config:
        return {}

    yaml_schema = tool_config.get("input_schema", {})

    # If empty or already proper JSON Schema, return as-is
    if not yaml_schema:
        return {}
    if "type" in yaml_schema and "properties" in yaml_schema:
        return yaml_schema

    # Convert simplified YAML format to proper JSON Schema
    properties = {}
    required = []

    for param_name, param_config in yaml_schema.items():
        if isinstance(param_config, dict):
            # Extract type and description from YAML config
            prop_schema: Dict[str, Any] = {}

            param_type = param_config.get("type", "string")
            prop_schema["type"] = param_type

            if "description" in param_config:
                prop_schema["description"] = param_config["description"]

            # Handle nested properties for object types
            if param_type == "object" and "properties" in param_config:
                prop_schema["properties"] = param_config["properties"]

            # Handle items for array types
            if param_type == "array" and "items" in param_config:
                prop_schema["items"] = param_config["items"]

            properties[param_name] = prop_schema

            # Track required fields
            if param_config.get("required", False):
                required.append(param_name)
        else:
            # Simple type (e.g., param_name: str)
            properties[param_name] = {"type": "string"}

    return {
        "type": "object",
        "properties": properties,
        "required": required,
    }


def get_tool_response(tool_name: str, group_name: Optional[str] = None, **kwargs) -> str:
    """
    Get the response message for a tool with variables substituted.

    Args:
        tool_name: Name of the tool
        group_name: Optional agent group name to apply group-specific overrides
        **kwargs: Variables to substitute in the response template

    Returns:
        Response string with variables substituted
    """
    tools_config = _get_tools_config_for_group(group_name)

    _, tool_config = _find_tool_in_config(tools_config, tool_name)

    if not tool_config:
        return "Tool response not configured."

    response_template = tool_config.get("response", "")

    try:
        return response_template.format(**kwargs)
    except KeyError as e:
        logger.warning(f"Missing variable in tool response template: {e}")
        return response_template


def get_situation_builder_note(has_situation_builder: bool) -> str:
    """
    Get the situation builder note if enabled and needed.

    Args:
        has_situation_builder: Whether the room has a situation builder agent

    Returns:
        Situation builder note string or empty string
    """
    if not has_situation_builder:
        return ""

    context_config = get_conversation_context_config()

    if "situation_builder" not in context_config:
        return ""

    sb_config = context_config["situation_builder"]

    if not sb_config.get("enabled", False):
        return ""

    return sb_config.get("template", "")


def is_tool_enabled(tool_name: str, default: bool = False) -> bool:
    """
    Check if a tool is enabled in configuration.

    Args:
        tool_name: Name of the tool
        default: Default value if tool is not found in configuration

    Returns:
        True if tool is enabled, False otherwise
    """
    tools_config = get_tools_config()

    _, tool_config = _find_tool_in_config(tools_config, tool_name)

    if not tool_config:
        return default

    return tool_config.get("enabled", True)


def get_tools_by_group(tool_group_name: str) -> Dict[str, Dict[str, Any]]:
    """
    Get all tools that belong to a specific group.

    Args:
        tool_group_name: Name of the tool group (e.g., "action", "game", "onboarding")

    Returns:
        Dictionary mapping tool names (short names like "skip", "memorize") to their config
    """
    tools_config = get_tools_config()

    if tool_group_name not in tools_config:
        return {}

    group_tools = tools_config[tool_group_name]
    if not isinstance(group_tools, dict):
        return {}

    return group_tools


def get_tool_names_by_group(tool_group_name: str, enabled_only: bool = True) -> list[str]:
    """
    Get full MCP tool names for all tools in a specific group.

    Args:
        tool_group_name: Name of the tool group (e.g., "action", "game", "onboarding")
        enabled_only: Only return enabled tools (default: True)

    Returns:
        List of full MCP tool names (e.g., ["mcp__action__skip", "mcp__action__memorize"])
    """
    tools_in_group = get_tools_by_group(tool_group_name)

    tool_names = []
    for tool_name, tool_config in tools_in_group.items():
        # Check if tool is enabled (if enabled_only is True)
        if enabled_only and not is_tool_enabled(tool_name):
            continue

        # Get the full MCP name
        mcp_name = tool_config.get("name")
        if mcp_name:
            tool_names.append(mcp_name)

    return tool_names


def get_tool_group(tool_name: str) -> Optional[str]:
    """
    Get the group name for a specific tool.

    Args:
        tool_name: Name of the tool (short name like "skip" or "complete")

    Returns:
        Group name (e.g., "action", "onboarding", "game") or None if not found
    """
    tools_config = get_tools_config()

    group_name, _ = _find_tool_in_config(tools_config, tool_name)
    return group_name
