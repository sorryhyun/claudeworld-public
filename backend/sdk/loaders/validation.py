"""
Configuration validation and logging.

Provides functions for validating configuration schema and startup logging.
"""

import logging

from .cache import clear_cache
from .tools import is_tool_enabled
from .yaml_loaders import (
    get_conversation_context_config,
    get_debug_config,
    get_guidelines_config,
    get_guidelines_file,
    get_tools_config,
)

logger = logging.getLogger(__name__)


def reload_all_configs():
    """Force reload all configuration files by clearing the cache."""
    clear_cache()
    logger.info("Reloaded all configuration files")


def validate_config_schema() -> list[str]:
    """
    Validate configuration files have required keys and structure.

    Returns:
        List of validation errors (empty if all valid)
    """
    errors = []

    # Validate tools config (loaded from *_tool_descriptions.py modules)
    tools_config = get_tools_config()
    if not tools_config:
        errors.append("Tool config is empty or missing (check *_tool_descriptions.py modules)")
    else:
        # Check for required tool groups and their source files
        required_groups = {
            "action": "action_tool_descriptions.py",
            "guidelines": "guideline_tool_descriptions.py",
        }
        for group, source_file in required_groups.items():
            if group not in tools_config:
                errors.append(f"{source_file} missing required group: {group}")

        # Check for required tools within groups
        required_tools = {
            "action": ["skip", "memorize", "recall"],
            "guidelines": ["read"],
        }
        for group, tools in required_tools.items():
            source_file = required_groups.get(group, "tools config")
            if group in tools_config:
                for tool_name in tools:
                    if tool_name not in tools_config[group]:
                        errors.append(f"{source_file} missing required tool: {group}.{tool_name}")
                    else:
                        tool = tools_config[group][tool_name]
                        # Validate tool structure
                        if "name" not in tool:
                            errors.append(f"{source_file} tool '{group}.{tool_name}' missing 'name' field")
                        # Tools must have either 'description' or 'source'
                        if "description" not in tool and "source" not in tool:
                            errors.append(
                                f"{source_file} tool '{group}.{tool_name}' missing 'description' or 'source' field"
                            )

    # Validate guidelines yaml (guidelines_3rd.yaml or guidelines_v2.yaml)
    guidelines_config = get_guidelines_config()
    guidelines_filename = f"{get_guidelines_file()}.yaml"
    if not guidelines_config:
        errors.append(f"{guidelines_filename} is empty or missing")
    else:
        # Check for active_version (guidelines template)
        if "active_version" not in guidelines_config:
            errors.append(f"{guidelines_filename} missing 'active_version' field")
        else:
            active_version = guidelines_config.get("active_version")
            if active_version not in guidelines_config:
                errors.append(f"{guidelines_filename} missing version section: {active_version}")
            else:
                version_config = guidelines_config[active_version]
                if "template" not in version_config:
                    errors.append(f"{guidelines_filename} version '{active_version}' missing 'template' field")

        # Check for system_prompt
        active_system_prompt = guidelines_config.get("active_system_prompt", "system_prompt")
        if active_system_prompt not in guidelines_config:
            errors.append(f"{guidelines_filename} missing system prompt: '{active_system_prompt}'")

    # Validate debug.yaml
    debug_config = get_debug_config()
    if not debug_config:
        errors.append("debug.yaml is empty or missing")
    elif "debug" not in debug_config:
        errors.append("debug.yaml missing 'debug' section")

    # Validate conversation_context.yaml
    context_config = get_conversation_context_config()
    if not context_config:
        errors.append("conversation_context.yaml is empty or missing")

    return errors


def log_config_validation():
    """
    Validate and log configuration status at startup.

    This should be called once during application initialization.
    """
    logger.info("Validating YAML configuration files...")

    errors = validate_config_schema()

    if errors:
        logger.error("Configuration validation failed:")
        for error in errors:
            logger.error(f"   - {error}")
        logger.error("Fix configuration files in backend/sdk/config/")
    else:
        logger.info("All configuration files validated successfully")

    # Log active configuration settings
    tools_config = get_tools_config()
    guidelines_config = get_guidelines_config()

    logger.info(f"Guidelines file: {get_guidelines_file()}.yaml")
    active_version = guidelines_config.get("active_version", "unknown")
    logger.info(f"Active guidelines version: {active_version}")

    active_system_prompt = guidelines_config.get("active_system_prompt", "system_prompt")
    logger.info(f"Active system prompt: {active_system_prompt}")

    # Count enabled tools across all groups
    all_tools = []
    enabled_tools = []
    for group_name, group_tools in tools_config.items():
        if isinstance(group_tools, dict):
            for tool_name in group_tools.keys():
                all_tools.append(f"{group_name}.{tool_name}")
                if is_tool_enabled(tool_name):
                    enabled_tools.append(tool_name)
    if all_tools:
        logger.info(f"Enabled tools: {len(enabled_tools)}/{len(all_tools)}")
