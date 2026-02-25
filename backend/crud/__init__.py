"""
CRUD operations module.

This module provides database operations organized by domain aggregate.
All CRUD functions are exported at the package level for backward compatibility.
"""

# Room operations
# Agent operations
from .agents import (
    create_agent,
    delete_agent,
    get_agent,
    get_agent_by_name,
    get_agents_by_world,
    get_all_agents,
    sync_agents_with_filesystem,
    update_agent,
)

# Cached operations
from .cached import (
    get_agent_cached,
    get_agents_cached,
    get_messages_after_agent_response_cached,
    get_messages_cached,
    get_messages_since_cached,
    get_recent_messages_cached,
    get_room_cached,
    invalidate_agent_cache,
    invalidate_messages_cache,
    invalidate_room_cache,
)

# Location operations
from .locations import (
    add_adjacent_location,
    add_character_to_location,
    create_location,
    create_new_room_for_location,
    get_agent_locations_in_world,
    get_all_characters_in_world,
    get_characters_at_location,
    get_location,
    get_location_by_name,
    get_locations,
    move_character_to_location,
    remove_character_from_location,
    update_location,
    update_location_label,
)

# Message operations
from .messages import (
    create_message,
    delete_room_messages,
    get_chat_session_messages,
    get_messages,
    get_messages_after_agent_response,
    get_messages_excluding_chat,
    get_messages_since,
    get_recent_messages,
)

# Player state operations
from .player_state import (
    add_action_to_history,
    add_inventory_item,
    enter_chat_mode,
    exit_chat_mode,
    get_player_state,
    increment_turn,
    initialize_player_stats,
    remove_inventory_item,
    set_current_location,
    update_stats,
)

# Room-Agent relationship operations
from .room_agents import (
    add_agent_to_room,
    get_agents,
    get_room_agent_session,
    remove_agent_from_room,
    update_room_agent_session,
)
from .rooms import (
    create_room,
    delete_room,
    get_or_create_direct_room,
    get_room,
    get_rooms,
    mark_room_as_finished,
    update_room,
)

# World operations
from .worlds import (
    add_gameplay_agents_to_room,
    create_world,
    delete_world,
    get_gameplay_agents,
    get_world,
    get_world_by_name,
    get_worlds_by_owner,
    import_world_from_filesystem,
    update_world,
    update_world_last_played,
)

# Export all functions
__all__ = [
    # Room operations
    "create_room",
    "get_rooms",
    "get_room",
    "update_room",
    "mark_room_as_finished",
    "delete_room",
    "get_or_create_direct_room",
    # Agent operations
    "create_agent",
    "get_all_agents",
    "get_agent",
    "get_agent_by_name",
    "get_agents_by_world",
    "delete_agent",
    "sync_agents_with_filesystem",
    "update_agent",
    # Message operations
    "create_message",
    "get_chat_session_messages",
    "get_messages",
    "get_messages_excluding_chat",
    "get_messages_since",
    "get_recent_messages",
    "get_messages_after_agent_response",
    "delete_room_messages",
    # Room-Agent relationship operations
    "get_agents",
    "add_agent_to_room",
    "remove_agent_from_room",
    "get_room_agent_session",
    "update_room_agent_session",
    # Cached operations
    "get_agent_cached",
    "get_room_cached",
    "get_agents_cached",
    "get_messages_cached",
    "get_recent_messages_cached",
    "get_messages_since_cached",
    "get_messages_after_agent_response_cached",
    "invalidate_room_cache",
    "invalidate_agent_cache",
    "invalidate_messages_cache",
    # Game/TRPG operations
    "create_world",
    "get_world",
    "get_world_by_name",
    "get_worlds_by_owner",
    "update_world",
    "update_world_last_played",
    "delete_world",
    "create_location",
    "create_new_room_for_location",
    "get_location",
    "get_location_by_name",
    "get_locations",
    "update_location",
    "update_location_label",
    "add_adjacent_location",
    "get_player_state",
    "set_current_location",
    "increment_turn",
    "update_stats",
    "add_inventory_item",
    "remove_inventory_item",
    "add_action_to_history",
    "initialize_player_stats",
    "enter_chat_mode",
    "exit_chat_mode",
    "get_gameplay_agents",
    "add_gameplay_agents_to_room",
    "import_world_from_filesystem",
    "add_character_to_location",
    "remove_character_from_location",
    "move_character_to_location",
    "get_characters_at_location",
    "get_all_characters_in_world",
    "get_agent_locations_in_world",
]
