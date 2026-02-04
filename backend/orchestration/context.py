"""
Conversation context builder for multi-agent chat rooms.

This module provides functionality to build conversation context from
recent room messages for multi-agent awareness.
"""

from core import get_settings
from core.settings import SKIP_MESSAGE_TEXT
from domain.entities.agent import is_action_manager
from domain.value_objects.contexts import ConversationContextParams
from domain.value_objects.enums import ConversationMode, ParticipantType
from i18n.korean import format_with_particles
from sdk.loaders import get_conversation_context_config, get_group_config

from orchestration.whiteboard import process_messages_for_whiteboard

# Get settings singleton
_settings = get_settings()


def build_conversation_context(params: ConversationContextParams) -> str:
    """
    Build conversation context from recent room messages for multi-agent awareness.

    Args:
        params: ConversationContextParams containing all context parameters

    Returns:
        Formatted conversation history string
    """
    # Extract frequently used params
    messages = params.messages
    limit = params.limit
    agent = params.agent
    agent_id = agent.id if agent else None
    agent_name = agent.name if agent else None
    agent_group = agent.group if agent else None

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

    # Find the last Action Manager message index (to filter older ones in game mode)
    last_action_manager_idx = -1
    if params.keep_only_latest_action_manager:
        for i in range(len(recent_messages) - 1, -1, -1):
            msg = recent_messages[i]
            if msg.agent_id:
                agent_obj = msg.agent if hasattr(msg, "agent") and msg.agent else None
                if agent_obj and is_action_manager(agent_obj.name):
                    last_action_manager_idx = i
                    break

    # Find the last user message index (to filter older ones in game mode)
    # Claude Agent SDK natively maintains conversation context, so we only need
    # the most recent user message (the current action/input)
    last_user_idx = -1
    if params.keep_only_latest_user:
        for i in range(len(recent_messages) - 1, -1, -1):
            msg = recent_messages[i]
            if msg.role == "user":
                last_user_idx = i
                break

    for idx, msg in enumerate(recent_messages):
        # Skip messages that are marked as "skip" (invisible to others)
        # Also handle legacy Korean text for backward compatibility
        if msg.content == SKIP_MESSAGE_TEXT or msg.content == "(무시함)":
            continue

        # Skip system messages unless agent's group has can_see_system_messages: true
        if msg.participant_type == ParticipantType.SYSTEM and not can_see_system:
            continue

        # Skip older Action Manager messages (keep only the most recent one)
        # This prevents context from growing with accumulated GM narrations
        if params.keep_only_latest_action_manager and msg.agent_id and idx != last_action_manager_idx:
            agent_obj = msg.agent if hasattr(msg, "agent") and msg.agent else None
            if agent_obj and is_action_manager(agent_obj.name):
                continue

        # Skip older user messages (keep only the most recent one)
        # Claude Agent SDK maintains its own conversation context, so NPCs only need
        # the current user action, not the full history of user inputs
        if params.keep_only_latest_user and msg.role == "user" and idx != last_user_idx:
            continue

        # Format each message with speaker identification
        if msg.role == "user":
            # Use participant_name if provided, otherwise determine by type
            if msg.participant_name:
                speaker = msg.participant_name
            else:
                # Use world_user_name if provided (for game context), otherwise fallback to USER_NAME
                speaker = params.world_user_name or _settings.user_name
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

        # Format message with embedded images if present
        # Support both new 'images' JSON field and legacy 'image_data'/'image_media_type'
        is_latest_message = msg == recent_messages[-1] if recent_messages else False

        # Parse images from message
        images = []
        if hasattr(msg, "images") and msg.images:
            import json

            try:
                images = json.loads(msg.images) if isinstance(msg.images, str) else msg.images
            except (json.JSONDecodeError, TypeError):
                images = []

        # Backward compatibility: convert legacy single image to list
        if not images and hasattr(msg, "image_data") and msg.image_data:
            if hasattr(msg, "image_media_type") and msg.image_media_type:
                images = [{"data": msg.image_data, "media_type": msg.image_media_type}]

        if images:
            if params.skip_latest_image and is_latest_message:
                # Insert placeholder for native SDK images (will be replaced with actual image blocks)
                img_count = len(images)
                placeholder = "[[IMAGE]]" if img_count == 1 else f"[[{img_count} IMAGES]]"
                if content:
                    context_lines.append(f"{speaker}: {placeholder}\n{content}\n")
                else:
                    context_lines.append(f"{speaker}: {placeholder}\n")
            else:
                # Embed previous message images as data URLs for Claude vision
                image_urls = []
                for img in images:
                    media_type = img.get("media_type") or img.get("mediaType")
                    data = img.get("data")
                    if data and media_type:
                        image_urls.append(f"data:{media_type};base64,{data}")

                if image_urls:
                    images_str = "\n".join(image_urls)
                    if content:
                        context_lines.append(f"{speaker}: {images_str}\n{content}\n")
                    else:
                        context_lines.append(f"{speaker}: {images_str}\n")
                else:
                    context_lines.append(f"{speaker}: {content}\n")
        else:
            context_lines.append(f"{speaker}: {content}\n")

    # Add footer (closing tag) after conversation messages
    footer = config.get("footer", "")
    if footer:
        context_lines.append(footer)

    # Add recall tool reminder when including instructions
    if params.include_response_instruction:
        recall_reminder = config.get("recall_reminder", "")
        if recall_reminder:
            context_lines.append(f"\n{recall_reminder}\n")

    # Append response instruction after </conversation_so_far>
    # response_AM is handled separately in gameplay_context.py for Action Manager
    if params.include_response_instruction and agent_name:
        # Determine language key
        lang = params.world_language
        if lang == "jp":
            lang_key = "jp"
        elif lang == "ko":
            lang_key = "ko"
        else:
            lang_key = "en"

        # Select instruction based on mode
        if params.mode == ConversationMode.ONBOARDING:
            response_config = config.get("response_OM", {})
        else:
            response_config = config.get("response_agent", {})

        instruction = response_config.get(lang_key, "")
        if instruction:
            formatted = format_with_particles(instruction.strip(), agent_name=agent_name)
            context_lines.append(formatted)

    return "\n".join(context_lines)
