"""
Configuration file loaders.

Provides functions to load specific configuration files with caching.

Tool definitions are loaded from Python modules in sdk/tools/
which combine input models and descriptions in one place. The YAML files
are deprecated but group_config.yaml overrides are still supported.
"""

import logging
import os
from pathlib import Path
from typing import Any, Dict

from .cache import get_cached_config

logger = logging.getLogger(__name__)


def _load_tool_descriptions_from_python() -> Dict[str, Any]:
    """
    Load tool descriptions from Python modules.

    Returns a dictionary in the same format as the old YAML structure:
    {
        "action": {"skip": {"name": ..., "description": ..., "response": ..., "enabled": ...}, ...},
        "guidelines": {...},
        "onboarding": {...},
        "action_manager": {...},
        "subagents": {...},
    }
    """
    from sdk.tools.action import ACTION_TOOLS
    from sdk.tools.gameplay import ACTION_MANAGER_TOOLS
    from sdk.tools.guideline import GUIDELINE_TOOLS
    from sdk.tools.onboarding import ONBOARDING_TOOLS
    from sdk.tools.subagent import SUBAGENT_TOOLS
    from sdk.tools.tool_definitions import ToolDefinition

    def to_dict(tool: ToolDefinition) -> Dict[str, Any]:
        """Convert ToolDefinition to dictionary format."""
        return {
            "name": tool.name,
            "description": tool.description,
            "response": tool.response,
            "enabled": tool.enabled,
        }

    def convert_group(tools: Dict[str, ToolDefinition]) -> Dict[str, Dict[str, Any]]:
        """Convert a group of tools to dictionary format."""
        return {name: to_dict(tool) for name, tool in tools.items()}

    return {
        "action": convert_group(ACTION_TOOLS),
        "guidelines": convert_group(GUIDELINE_TOOLS),
        "onboarding": convert_group(ONBOARDING_TOOLS),
        "action_manager": convert_group(ACTION_MANAGER_TOOLS),
        "subagents": convert_group(SUBAGENT_TOOLS),
    }


def get_guidelines_file() -> str:
    """
    Get the guidelines file name from settings.

    Returns:
        Guidelines file name (without .yaml extension)
    """
    from core import get_settings

    return get_settings().guidelines_file


def get_guidelines_config_path() -> Path:
    """
    Get the path to the guidelines config file.

    Returns:
        Path to the guidelines YAML file
    """
    from core import get_settings

    return get_settings().guidelines_config_path


# Backward compatibility: module-level constants that delegate to settings
def __getattr__(name: str):
    from core import get_settings

    settings = get_settings()

    # Map old constant names to settings properties
    path_map = {
        "CONFIG_DIR": settings.config_dir,
        "TOOLS_CONFIG": settings.tools_config_path,
        "DEBUG_CONFIG": settings.debug_config_path,
        "CONVERSATION_CONTEXT_CONFIG": settings.conversation_context_config_path,
        "GUIDELINES_SEP_CONFIG": settings.guidelines_sep_config_path,
        "GUIDELINES_FILE": settings.guidelines_file,
        "GUIDELINES_CONFIG": settings.guidelines_config_path,
    }

    if name in path_map:
        return path_map[name]

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def get_tools_config() -> Dict[str, Any]:
    """
    Load the tools configuration from Python modules.

    Tool descriptions are now defined in Python files (*_tool_descriptions.py)
    for better type safety and IDE support.

    Returns:
        Dictionary containing tool definitions from all modules
    """
    return _load_tool_descriptions_from_python()


def get_guidelines_config() -> Dict[str, Any]:
    """
    Load the guidelines configuration from guidelines.yaml.

    Returns:
        Dictionary containing guideline templates
    """
    return get_cached_config(get_guidelines_config_path())


def get_guidelines_sep_config() -> Dict[str, Any]:
    """
    Load the segmented guidelines configuration from guidelines_sep.yaml.

    Returns:
        Dictionary containing segmented prompt variations (first_1, first_2, etc.)
    """
    from core import get_settings

    return get_cached_config(get_settings().guidelines_sep_config_path)


def get_debug_config() -> Dict[str, Any]:
    """
    Load the debug configuration from debug.yaml with environment variable overrides.

    Environment variables take precedence:
    - DEBUG_AGENTS=true overrides debug.enabled

    Returns:
        Dictionary containing debug settings
    """
    from core import get_settings

    config = get_cached_config(get_settings().debug_config_path)

    # Apply environment variable overrides
    if "debug" in config:
        debug_env = os.getenv("DEBUG_AGENTS", "").lower()
        if debug_env in ("true", "false"):
            config["debug"]["enabled"] = debug_env == "true"

    return config


def get_conversation_context_config() -> Dict[str, Any]:
    """
    Load the conversation context configuration from conversation_context.yaml.

    Returns:
        Dictionary containing conversation context templates
    """
    from core import get_settings

    return get_cached_config(get_settings().conversation_context_config_path)


def get_localization_config() -> Dict[str, Any]:
    """
    Load the localization configuration from localization.yaml.

    Returns:
        Dictionary containing localized message templates
    """
    from core import get_settings

    return get_cached_config(get_settings().localization_config_path)


def get_lore_guidelines_config() -> Dict[str, Any]:
    """
    Load the lore guidelines configuration from lore_guidelines.yaml.

    Returns:
        Dictionary containing lore writing guideline templates
    """
    from core import get_settings

    return get_cached_config(get_settings().lore_guidelines_config_path)


def get_group_config(group_name: str) -> Dict[str, Any]:
    """
    Load group-specific configuration from group_config.yaml.

    Args:
        group_name: Name of the group (e.g., "슈타게", "체인소맨")

    Returns:
        Dictionary containing group-specific tool overrides, or empty dict if not found
    """
    if not group_name:
        return {}

    from core import get_settings

    # Use settings to get agents directory path
    group_config_path = get_settings().agents_dir / f"group_{group_name}" / "group_config.yaml"

    if not group_config_path.exists():
        logger.debug(f"No group config found for group '{group_name}' at {group_config_path}")
        return {}

    try:
        config = get_cached_config(group_config_path)
        logger.debug(f"Loaded group config for '{group_name}': {list(config.keys())}")
        return config
    except Exception as e:
        logger.warning(f"Error loading group config for '{group_name}': {e}")
        return {}


def get_extreme_traits(group_name: str) -> Dict[str, str]:
    """
    Load extreme traits configuration from group's extreme_traits.yaml.

    Args:
        group_name: Name of the group (e.g., "마마마", "슈타게")

    Returns:
        Dictionary mapping agent names to their extreme traits, or empty dict if not found
    """
    if not group_name:
        return {}

    from core import get_settings

    extreme_traits_path = get_settings().agents_dir / f"group_{group_name}" / "extreme_traits.yaml"

    if not extreme_traits_path.exists():
        logger.debug(f"No extreme traits found for group '{group_name}' at {extreme_traits_path}")
        return {}

    try:
        config = get_cached_config(extreme_traits_path)
        logger.debug(f"Loaded extreme traits for '{group_name}': {list(config.keys())}")
        return config if isinstance(config, dict) else {}
    except Exception as e:
        logger.warning(f"Error loading extreme traits for '{group_name}': {e}")
        return {}


def get_agent_tool_config(group_name: str, agent_name: str) -> Dict[str, Any]:
    """
    Get per-agent tool configuration from group_config.yaml.

    This retrieves agent-specific tool settings like:
    - enabled_tool_groups: List of tool groups to enable
    - disabled_tool_groups: List of tool groups to disable
    - enabled_tools: List of specific tools to enable
    - disabled_tools: List of specific tools to disable

    Group-level settings (disabled_tools, enabled_tools, disabled_tool_groups,
    enabled_tool_groups) are merged with per-agent settings. Per-agent settings
    extend group-level settings (lists are combined, not replaced).

    Args:
        group_name: Name of the group (e.g., "trpg", "체인소맨")
        agent_name: Name of the agent within the group

    Returns:
        Dictionary with tool configuration for this agent, or empty dict if not found
    """
    if not group_name or not agent_name:
        return {}

    group_config = get_group_config(group_name)
    if not group_config:
        return {}

    # Start with group-level tool settings
    result: Dict[str, Any] = {}

    # Copy group-level list settings
    list_keys = ["disabled_tools", "enabled_tools", "disabled_tool_groups", "enabled_tool_groups"]
    for key in list_keys:
        if key in group_config and isinstance(group_config[key], list):
            result[key] = list(group_config[key])

    # Merge per-agent configuration (extends group-level lists)
    agents_config = group_config.get("agents", {})
    agent_config = agents_config.get(agent_name, {})

    if agent_config:
        for key, value in agent_config.items():
            if key in list_keys and isinstance(value, list):
                # Extend list settings (avoid duplicates)
                existing = set(result.get(key, []))
                result[key] = list(existing | set(value))
            else:
                # Override other settings
                result[key] = value
        logger.debug(f"Found per-agent tool config for '{group_name}/{agent_name}': {list(agent_config.keys())}")

    if result:
        logger.debug(f"Merged tool config for '{group_name}/{agent_name}': {result}")

    return result


def merge_tool_configs(base_config: Dict[str, Any], group_config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Merge group-specific tool configurations over base (global) tool configurations.

    Group config can override any field in the base config (e.g., response, description, etc.)

    Supports both legacy and new formats:
    - Legacy: group_config has "tools: { skip: {...}, memorize: {...} }"
    - New: group_config has "action: { skip: {...} }, game: { update_stats: {...} }"

    Args:
        base_config: Base tools configuration from tools.yaml (group-based structure)
        group_config: Group-specific configuration from group_config.yaml

    Returns:
        Merged configuration dictionary
    """
    # Deep copy base config to avoid mutation
    import copy

    merged = copy.deepcopy(base_config)

    # Known tool groups (now loaded from Python modules)
    tool_groups = ["action", "guidelines", "onboarding", "action_manager", "subagents"]

    # Check for new format (group names at top level in group_config)
    has_new_format = any(group_name in group_config for group_name in tool_groups)

    # Check for legacy format (tools key in group_config)
    has_legacy_format = "tools" in group_config

    if has_new_format:
        # New format: merge group-by-group
        for group_name in tool_groups:
            if group_name in group_config and group_name in merged:
                group_overrides = group_config[group_name]
                if isinstance(group_overrides, dict):
                    for tool_name, tool_overrides in group_overrides.items():
                        if tool_name in merged[group_name]:
                            merged[group_name][tool_name].update(tool_overrides)
                            logger.debug(
                                f"Applied group config override for {group_name}.{tool_name}: "
                                f"{list(tool_overrides.keys())}"
                            )
                        else:
                            logger.warning(f"Group config specifies unknown tool '{group_name}.{tool_name}', ignoring")

    elif has_legacy_format:
        # Legacy format: tools are listed flat, need to find which group they belong to
        group_tools = group_config.get("tools", {})

        for tool_name, tool_overrides in group_tools.items():
            # Find which group this tool belongs to
            found = False
            for group_name in tool_groups:
                if group_name in merged and tool_name in merged[group_name]:
                    merged[group_name][tool_name].update(tool_overrides)
                    logger.debug(
                        f"Applied legacy group config override for {group_name}.{tool_name}: "
                        f"{list(tool_overrides.keys())}"
                    )
                    found = True
                    break

            if not found:
                logger.warning(f"Group config specifies unknown tool '{tool_name}', ignoring")

    return merged
