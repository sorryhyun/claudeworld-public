"""
MCP Server Registry for managing tool groups and MCP server creation.

This module centralizes the logic for:
- Determining which tool groups are enabled for an agent
- Creating and configuring MCP servers for each tool group
- Building the allowed tools list
- Caching MCP configs to avoid per-turn rebuilds

Separates tool/MCP server management from the AgentManager to improve
maintainability and testability.
"""

import hashlib
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from domain.entities.agent import is_action_manager, is_onboarding_manager
from domain.value_objects.contexts import AgentResponseContext

from sdk.loaders import (
    get_agent_tool_config,
    get_tool_names_by_group,
)
from sdk.tools import (
    SUBAGENT_TOOL_NAMES,
    create_action_manager_mcp_server,
    create_action_mcp_server,
    create_guidelines_mcp_server,
    create_onboarding_mcp_server,
)
from sdk.tools.context import ToolContext

logger = logging.getLogger("MCPRegistry")

# Default tool groups that are always enabled (unless explicitly disabled)
DEFAULT_TOOL_GROUPS = {"guidelines", "action"}


@dataclass
class MCPServerConfig:
    """Configuration result from MCP registry."""

    mcp_servers: dict[str, Any] = field(default_factory=dict)
    allowed_tool_names: list[str] = field(default_factory=list)
    enabled_groups: set[str] = field(default_factory=set)
    config_hash: str = ""  # Hash of context fields that affect config


class MCPRegistry:
    """
    Registry for MCP servers and tool groups.

    Handles the creation and configuration of MCP servers based on
    agent context and tool group configuration.

    Implements caching to avoid per-turn MCP config rebuilds:
    - Cache key: hash of context fields that affect config
    - Cache invalidation: automatic when context changes
    """

    def __init__(self, settings):
        """
        Initialize the MCP registry.

        Args:
            settings: Application settings instance
        """
        self.settings = settings
        # Cache: config_hash -> MCPServerConfig
        self._config_cache: dict[str, MCPServerConfig] = {}

    def _compute_config_hash(self, context: AgentResponseContext) -> str:
        """
        Compute a hash of context fields that affect MCP config.

        This determines when we need to rebuild vs reuse cached config.
        Fields included:
        - agent_name, agent_id: affect tool context
        - group_name: affects enabled tool groups
        - config_file, long_term_memory_index: affect action MCP server
        - has_situation_builder: affects guidelines MCP server
        - world_name, world_id, room_id: affect onboarding/action_manager/narrator servers

        Note: db session is excluded as it's a runtime dependency, not config.
        """
        # Build a tuple of hashable fields
        hash_parts = [
            str(context.agent_name),
            str(context.agent_id),
            str(getattr(context, "group_name", "")),
            str(context.config.config_file) if context.config.config_file else "",
            str(context.config.long_term_memory_index) if context.config.long_term_memory_index else "",
            str(context.has_situation_builder),
            str(context.world_name) if context.world_name else "",
            str(context.world_id) if context.world_id else "",
            str(context.room_id) if context.room_id else "",
            # Include read_guideline_by setting as it affects MCP server creation
            str(self.settings.read_guideline_by),
        ]
        hash_input = "|".join(hash_parts)
        return hashlib.sha256(hash_input.encode()).hexdigest()[:16]

    def build_mcp_config(self, context: AgentResponseContext) -> MCPServerConfig:
        """
        Build MCP server configuration for an agent.

        This method:
        1. Computes a config hash and checks cache
        2. If cache hit, returns cached config (avoids per-turn rebuild)
        3. If cache miss, builds config and caches it:
           - Determines which tool groups are enabled
           - Creates MCP servers for each enabled group
           - Builds the list of allowed tool names

        Args:
            context: Agent response context

        Returns:
            MCPServerConfig with mcp_servers dict, allowed_tool_names list, and config_hash
        """
        # Compute config hash for cache lookup
        config_hash = self._compute_config_hash(context)

        # Check cache first (fast path)
        if config_hash in self._config_cache:
            cached_config = self._config_cache[config_hash]
            logger.debug(
                f"MCP config CACHE HIT for {context.agent_name}: "
                f"hash={config_hash[:8]}, servers={list(cached_config.mcp_servers.keys())}"
            )
            return cached_config

        # Cache miss - build new config
        logger.debug(f"MCP config CACHE MISS for {context.agent_name}: hash={config_hash[:8]}, building...")

        config = MCPServerConfig()
        config.config_hash = config_hash

        # Get per-agent tool configuration
        agent_tool_config = self._get_agent_tool_config(context)

        # Determine enabled tool groups
        config.enabled_groups = self._compute_enabled_groups(agent_tool_config)

        # System agents (Action Manager, Onboarding Manager) don't need action tools
        is_system_agent = is_action_manager(context.agent_name) or is_onboarding_manager(context.agent_name)
        if is_system_agent:
            config.enabled_groups.discard("action")
            logger.debug(f"Removed 'action' from enabled groups for system agent: {context.agent_name}")

        # Create MCP servers for each enabled group
        config.mcp_servers = self._create_mcp_servers(context, config.enabled_groups)

        # Build allowed tool names from enabled groups
        config.allowed_tool_names = self._build_allowed_tools(config.enabled_groups, agent_tool_config)

        # Cache the config
        self._config_cache[config_hash] = config

        logger.debug(
            f"MCP config BUILT for {context.agent_name}: "
            f"hash={config_hash[:8]}, groups={config.enabled_groups}, "
            f"servers={list(config.mcp_servers.keys())}, "
            f"tools={len(config.allowed_tool_names)}"
        )

        return config

    def invalidate_cache(self, config_hash: Optional[str] = None) -> int:
        """
        Invalidate cached MCP configs.

        Args:
            config_hash: Specific hash to invalidate, or None to clear all

        Returns:
            Number of cache entries cleared
        """
        if config_hash:
            if config_hash in self._config_cache:
                del self._config_cache[config_hash]
                logger.debug(f"Invalidated MCP config cache for hash={config_hash[:8]}")
                return 1
            return 0
        else:
            count = len(self._config_cache)
            self._config_cache.clear()
            logger.debug(f"Cleared all MCP config cache ({count} entries)")
            return count

    def _get_agent_tool_config(self, context: AgentResponseContext) -> dict:
        """Get per-agent tool configuration from group_config.yaml."""
        group_name = getattr(context, "group_name", None)
        if not group_name or not isinstance(group_name, str):
            return {}

        # Strip "group_" prefix if present for lookup
        group_name_for_lookup = group_name
        if group_name_for_lookup.startswith("group_"):
            group_name_for_lookup = group_name_for_lookup[6:]

        return get_agent_tool_config(group_name_for_lookup, context.agent_name)

    def _compute_enabled_groups(self, agent_tool_config: dict) -> set[str]:
        """Compute the set of enabled tool groups based on configuration."""
        enabled_groups = set(DEFAULT_TOOL_GROUPS)

        # Add group-wide enabled tool groups
        if agent_tool_config.get("enabled_tool_groups"):
            for group in agent_tool_config["enabled_tool_groups"]:
                enabled_groups.add(group)
                logger.debug(f"Added tool group '{group}' from config")

        # Remove group-wide disabled tool groups
        if agent_tool_config.get("disabled_tool_groups"):
            for group in agent_tool_config["disabled_tool_groups"]:
                enabled_groups.discard(group)
                logger.debug(f"Removed tool group '{group}' from config")

        return enabled_groups

    def _create_mcp_servers(
        self,
        context: AgentResponseContext,
        enabled_groups: set[str],
    ) -> dict[str, Any]:
        """Create MCP servers for enabled tool groups."""
        mcp_servers = {}

        # Create action MCP server (skip, memorize, recall tools) if enabled
        if "action" in enabled_groups:
            logger.debug(f"Creating action MCP server for agent: '{context.agent_name}'")
            action_ctx = ToolContext(
                agent_name=context.agent_name,
                agent_id=context.agent_id,
                config_file=Path(context.config.config_file) if context.config.config_file else None,
                long_term_memory_index=context.config.long_term_memory_index,
                group_name=context.group_name,
            )
            mcp_servers["action"] = create_action_mcp_server(action_ctx)

        # Always create guidelines MCP server
        logger.debug(
            f"Creating guidelines MCP server for agent: '{context.agent_name}' "
            f"(mode: {self.settings.read_guideline_by})"
        )
        mcp_servers["guidelines"] = create_guidelines_mcp_server(
            agent_name=context.agent_name,
            has_situation_builder=context.has_situation_builder,
            group_name=context.group_name,
        )

        # Onboarding MCP server
        if "onboarding" in enabled_groups:
            logger.debug(f"Adding onboarding tools for agent: {context.agent_name}")
            onboarding_ctx = ToolContext(
                agent_name=context.agent_name,
                agent_id=context.agent_id,
                config_file=Path(context.config.config_file) if context.config.config_file else None,
                group_name=context.group_name,
                room_id=context.room_id,
                world_name=context.world_name,
                world_id=context.world_id,
                db=context.db,
            )
            mcp_servers["onboarding"] = create_onboarding_mcp_server(onboarding_ctx)

        # Action Manager MCP server (gameplay tools)
        # Sub-agent invocation now uses SDK native AgentDefinition + Task tool pattern
        if "action_manager" in enabled_groups:
            if context.db is not None and context.world_id is not None and context.world_name:
                logger.debug(f"Adding action_manager tools for agent: {context.agent_name}")
                action_manager_ctx = ToolContext(
                    agent_name=context.agent_name,
                    agent_id=context.agent_id,
                    group_name=context.group_name,
                    room_id=context.room_id,
                    world_name=context.world_name,
                    world_id=context.world_id,
                    db=context.db,
                )
                mcp_servers["action_manager"] = create_action_manager_mcp_server(action_manager_ctx)
            else:
                logger.warning(
                    f"action_manager tool group enabled but missing required context "
                    f"(db={context.db is not None}, world_id={context.world_id}, "
                    f"world_name={context.world_name})"
                )

        # Note: narrator MCP server removed - narration now handled via Action Manager's narration tool

        return mcp_servers

    def _build_allowed_tools(
        self,
        enabled_groups: set[str],
        agent_tool_config: dict,
    ) -> list[str]:
        """Build list of allowed tool names from enabled groups."""
        allowed_tool_names = []

        # Collect tools from each enabled group
        for group in enabled_groups:
            allowed_tool_names.extend(get_tool_names_by_group(group))

        # Add subagent persist tools based on enabled groups
        # These tools are dynamically created (not in YAML config) so we add them manually
        # Each persist tool belongs to its parent's MCP server:
        # - action_manager: persist_stat_changes, persist_character_design, persist_location_design
        # - onboarding: persist_world_seed
        if "action_manager" in enabled_groups:
            # Add gameplay persist tools (used by subagents invoked via Task tool)
            action_manager_persist_tools = [
                SUBAGENT_TOOL_NAMES["stat_calculator"],
                SUBAGENT_TOOL_NAMES["character_designer"],
                SUBAGENT_TOOL_NAMES["location_designer"],
            ]
            allowed_tool_names.extend(action_manager_persist_tools)
            logger.debug(f"Added action_manager persist tools: {action_manager_persist_tools}")

        if "onboarding" in enabled_groups:
            # Add onboarding persist tool (used by world_seed_generator subagent)
            onboarding_persist_tool = SUBAGENT_TOOL_NAMES["world_seed_generator"]
            if onboarding_persist_tool:
                allowed_tool_names.append(onboarding_persist_tool)
                logger.debug(f"Added onboarding persist tool: {onboarding_persist_tool}")

        # Apply specific tool filtering (disabled_tools)
        if agent_tool_config.get("disabled_tools"):
            disabled = set(agent_tool_config["disabled_tools"])
            allowed_tool_names = [
                name for name in allowed_tool_names if not any(name.endswith(f"__{tool}") for tool in disabled)
            ]
            logger.debug(f"Disabled tools: {disabled}")

        return allowed_tool_names


# Global singleton instance
_mcp_registry: Optional[MCPRegistry] = None


def get_mcp_registry() -> MCPRegistry:
    """Get or create the global MCP registry instance."""
    global _mcp_registry
    if _mcp_registry is None:
        from core import get_settings

        _mcp_registry = MCPRegistry(get_settings())
    return _mcp_registry
