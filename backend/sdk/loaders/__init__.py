"""
SDK Configuration Loaders.

This package provides functions for loading and managing YAML configuration files.
It consolidates functionality previously in the config/ package.
"""

# Re-export from cache
from .cache import (
    _config_cache,
    _get_file_mtime,
    _load_yaml_file,
    clear_cache,
    get_cached_config,
)

# Re-export from guidelines
from .guidelines import get_base_system_prompt

# Re-export from tools
from .tools import (
    get_tool_description,
    get_tool_group,
    get_tool_input_schema,
    get_tool_names_by_group,
    get_tool_response,
    get_tools_by_group,
    is_tool_enabled,
)

# Re-export from validation
from .validation import (
    log_config_validation,
    reload_all_configs,
    validate_config_schema,
)

# Re-export from yaml_loaders
from .yaml_loaders import (
    get_agent_tool_config,
    get_conversation_context_config,
    get_debug_config,
    get_extreme_traits,
    get_group_config,
    get_guidelines_config,
    get_guidelines_config_path,
    get_guidelines_file,
    get_localization_config,
    get_lore_guidelines_config,
    get_tools_config,
    merge_tool_configs,
)

# Backward compatibility alias
_get_cached_config = get_cached_config

__all__ = [
    # Cache
    "_config_cache",
    "_get_file_mtime",
    "_load_yaml_file",
    "clear_cache",
    "get_cached_config",
    "_get_cached_config",
    # YAML Loaders
    "get_tools_config",
    "get_guidelines_config",
    "get_guidelines_config_path",
    "get_guidelines_file",
    "get_debug_config",
    "get_conversation_context_config",
    "get_localization_config",
    "get_lore_guidelines_config",
    "get_extreme_traits",
    "get_group_config",
    "get_agent_tool_config",
    "merge_tool_configs",
    # Guidelines
    "get_base_system_prompt",
    # Tools
    "get_tool_description",
    "get_tool_input_schema",
    "get_tool_response",
    "is_tool_enabled",
    "get_tools_by_group",
    "get_tool_names_by_group",
    "get_tool_group",
    # Validation
    "reload_all_configs",
    "validate_config_schema",
    "log_config_validation",
]
