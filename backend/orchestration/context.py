"""
Conversation context builder for multi-agent chat rooms.

This module provides functionality to build conversation context from
recent room messages for multi-agent awareness.
"""

from typing import List, Optional

from core import get_settings
from core.settings import SKIP_MESSAGE_TEXT
from domain.value_objects.enums import ParticipantType
from i18n.korean import format_with_particles
from sdk.loaders import get_conversation_context_config, get_group_config

from orchestration.conversation import detect_conversation_type
from orchestration.whiteboard import process_messages_for_whiteboard

# Get settings singleton
_settings = get_settings()


def build_conversation_context(
    messages: List,
    limit: int = 25,
    agent_id: Optional[int] = None,
    agent_name: Optional[str] = None,
    agent_group: Optional[str] = None,
    agent_count: Optional[int] = None,
    user_name: Optional[str] = None,
    include_response_instruction: bool = True,
    is_onboarding: bool = False,
    is_game: bool = False,
    is_chat_mode: bool = False,
    world_user_name: Optional[str] = None,
    world_language: Optional[str] = None,
    recent_events: Optional[str] = None,
) -> str:
    """
    Build conversation context from recent room messages for multi-agent awareness.

    Args:
        messages: List of recent messages from the room
        limit: Maximum number of recent messages to include
        agent_id: If provided, only include messages after this agent's last response
        agent_name: Optional agent name to include in the thinking block instruction
        agent_group: Optional agent group name (for checking can_see_system_messages)
        agent_count: Number of agents in the room (for detecting 1-on-1 conversations)
        user_name: Name of the user/character participant (for 1-on-1 conversations)
        include_response_instruction: If True, append response instruction; if False, only include conversation history
        is_onboarding: If True, use onboarding-specific response instructions
        is_game: If True, use game-specific response instructions (TRPG active gameplay)
        is_chat_mode: If True, use chat mode response instructions (direct NPC conversation)
        world_user_name: Player's display name in the world (for language detection in onboarding)
        world_language: World language setting ('en' or 'ko') for game instructions
        recent_events: Agent's recent events to inject before response instruction (fresh each turn)

    Returns:
        Formatted conversation history string
    """
    if not messages:
        return ""

    # If agent_id is provided, find messages after the agent's last response
    if agent_id is not None:
        # Find the index of the agent's last message
        last_agent_msg_idx = -1
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].agent_id == agent_id:
                last_agent_msg_idx = i
                break

        # If agent has responded before, only include messages after that
        if last_agent_msg_idx >= 0:
            recent_messages = messages[last_agent_msg_idx + 1 :]
        else:
            # Agent hasn't responded yet, use recent messages
            recent_messages = messages[-limit:] if len(messages) > limit else messages
    else:
        # No agent_id provided, use recent messages
        recent_messages = messages[-limit:] if len(messages) > limit else messages

    # If no new messages, return empty
    if not recent_messages:
        return ""

    # Load conversation context configuration
    context_config = get_conversation_context_config()
    config = context_config.get("conversation_context", {})

    # Build header
    header = config.get("header", "Here's the conversation so far:")
    context_lines = [header]

    # Process whiteboard messages to get rendered content (accumulated state)
    # This converts diff format to full rendered whiteboard for other agents
    whiteboard_rendered = process_messages_for_whiteboard(messages)

    # Track seen messages to avoid duplicates (speaker, content) pairs
    seen_messages = set()

    # Check if agent's group can see system messages
    can_see_system = False
    if agent_group:
        group_config = get_group_config(agent_group)
        can_see_system = group_config.get("can_see_system_messages", False)

    for msg in recent_messages:
        # Skip messages that are marked as "skip" (invisible to others)
        # Also handle legacy Korean text for backward compatibility
        if msg.content == SKIP_MESSAGE_TEXT or msg.content == "(무시함)":
            continue

        # Skip system messages unless agent's group has can_see_system_messages: true
        if msg.participant_type == ParticipantType.SYSTEM and not can_see_system:
            continue

        # Format each message with speaker identification
        if msg.role == "user":
            # Use participant_name if provided, otherwise determine by type
            if msg.participant_name:
                speaker = msg.participant_name
            elif msg.participant_type == ParticipantType.SITUATION_BUILDER:
                speaker = "Situation Builder"
            else:
                # Use world_user_name if provided (for game context), otherwise fallback to USER_NAME
                speaker = world_user_name or _settings.user_name
        elif msg.agent_id:
            # Get agent name from the message relationship
            speaker = msg.agent.name if hasattr(msg, "agent") and msg.agent else f"Agent {msg.agent_id}"
        else:
            speaker = "Unknown"

        # Create a unique key for this message (speaker + content)
        message_key = (speaker, msg.content)

        # Skip if we've already seen this exact message from this speaker
        if message_key in seen_messages:
            continue

        seen_messages.add(message_key)

        # Get message content (use rendered whiteboard content if available)
        content = whiteboard_rendered.get(msg.id, msg.content)

        # Format message with embedded image if present
        if hasattr(msg, "image_data") and msg.image_data and hasattr(msg, "image_media_type") and msg.image_media_type:
            # Embed image as data URL for Claude vision
            data_url = f"data:{msg.image_media_type};base64,{msg.image_data}"
            if content:
                context_lines.append(f"{speaker}: {data_url}\n{content}\n")
            else:
                context_lines.append(f"{speaker}: {data_url}\n")
        else:
            context_lines.append(f"{speaker}: {content}\n")

    # Add footer (closing tag) after conversation messages
    footer = config.get("footer", "")
    if footer:
        context_lines.append(footer)

    # Add recall tool reminder when including instructions
    if include_response_instruction:
        recall_reminder = config.get("recall_reminder", "")
        if recall_reminder:
            context_lines.append(f"\n{recall_reminder}\n")

    # Inject recent_events before response instruction (fresh each turn)
    # This allows agents to see newly recorded memories immediately after using memorize tool
    if recent_events and recent_events.strip():
        context_lines.append(f"\n<recent_events>\n{recent_events.strip()}\n</recent_events>\n")

    # Add response instruction based on conversation type (if requested)
    if include_response_instruction:
        # Check for onboarding mode first
        if is_onboarding and world_user_name:
            # Detect language based on world_user_name
            # Korean names like '손님' indicate Korean language preference
            is_korean = _is_korean_text(world_user_name)
            instruction_key = (
                "response_instruction_onboarding_ko" if is_korean else "response_instruction_onboarding_en"
            )
            instruction = config.get(instruction_key, "")
            if instruction:
                context_lines.append(
                    format_with_particles(instruction, user_name=world_user_name, agent_name=agent_name or "")
                )
        # Check for chat mode (direct NPC conversation)
        elif is_chat_mode and agent_name:
            # Chat mode uses the agent-active instruction for more natural NPC responses
            instruction = config.get("response_instruction_with_agent_active", "")
            if instruction:
                context_lines.append(format_with_particles(instruction, agent_name=agent_name))
        # Check for game mode (TRPG active gameplay)
        elif is_game and agent_name:
            # Use world_language if provided, otherwise detect from world_user_name
            is_korean = world_language == "ko" or (world_user_name and _is_korean_text(world_user_name))
            instruction_key = "response_instruction_game_ko" if is_korean else "response_instruction_game_en"
            instruction = config.get(instruction_key, "")
            if instruction:
                context_lines.append(
                    format_with_particles(instruction, user_name=world_user_name or "", agent_name=agent_name)
                )
        elif agent_name:
            # Determine conversation type using shared utility
            is_one_on_one, _, _ = detect_conversation_type(recent_messages, agent_count or 0)

            # Add response instruction based on conversation type
            # Use _active variants when READ_GUIDELINE_BY=active_tool
            # Use 1-on-1 template if it's a 1-on-1 conversation and user_name is provided
            if is_one_on_one and user_name:
                instruction = config.get("response_instruction_with_user_active", "")
                if instruction:
                    context_lines.append(format_with_particles(instruction, agent_name=agent_name, user_name=user_name))
            else:
                # Use multi-agent template when there are multiple agents (>1)
                # Otherwise use standard agent template
                if agent_count and agent_count > 1:
                    instruction = config.get("response_instruction_with_multi_agent_active", "")
                else:
                    instruction = config.get("response_instruction_with_agent_active", "")

                if instruction:
                    context_lines.append(format_with_particles(instruction, agent_name=agent_name))

    return "\n".join(context_lines)


def _is_korean_text(text: str) -> bool:
    """Check if the text contains Korean characters."""
    if not text:
        return False
    # Check for Korean Hangul character range
    for char in text:
        if "\uac00" <= char <= "\ud7af" or "\u1100" <= char <= "\u11ff" or "\u3130" <= char <= "\u318f":
            return True
    return False
