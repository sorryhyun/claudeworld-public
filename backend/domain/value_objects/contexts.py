"""
Consolidated context data structures.

Contains all context dataclasses for operations throughout the application.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from domain.entities.agent_config import AgentConfigData
from domain.value_objects.enums import ConversationMode

from .task_identifier import TaskIdentifier

if TYPE_CHECKING:
    from infrastructure.database import models
    from sdk import AgentManager
    from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class MessageContext:
    """
    Context for message operations.

    This dataclass groups parameters for message-related operations,
    reducing parameter count in handler functions.

    Attributes:
        db: Database session
        room_id: Room ID
        agent: Agent object
        chat_session_id: Optional chat session ID for chat mode messages
        game_time_snapshot: Optional game time for display on messages (only during active gameplay)
    """

    db: "AsyncSession"
    room_id: int
    agent: "models.Agent"
    chat_session_id: Optional[int] = None
    game_time_snapshot: Optional[Dict[str, int]] = None


@dataclass
class OrchestrationContext:
    """
    Shared context for orchestration operations.

    This dataclass groups the common parameters passed through
    orchestration methods, reducing repetition.

    Attributes:
        db: Database session
        room_id: Room ID
        agent_manager: AgentManager for generating responses
        world_id: Optional world ID (for TRPG game tools)
        world_name: Optional world name (for TRPG game tools)
        chat_session_id: Optional chat session ID for separating chat mode context
    """

    db: "AsyncSession"
    room_id: int
    agent_manager: "AgentManager"
    world_id: Optional[int] = None
    world_name: Optional[str] = None
    chat_session_id: Optional[int] = None


@dataclass
class ConversationContextParams:
    """
    Parameters for building conversation context.

    Groups all parameters needed by build_conversation_context(), reducing
    the parameter count from 16 to 1.

    Attributes:
        messages: List of recent messages from the room
        agent: Agent object (provides id, name, group)
        agent_count: Number of agents in the room
        mode: Conversation mode (normal, onboarding, game, chat)
        world_user_name: Player's display name in the world
        world_language: World language setting ('en', 'ko', or 'jp')
        limit: Maximum number of recent messages to include
        include_response_instruction: If True, append response instruction
        skip_latest_image: If True, skip embedding image from the latest message
        keep_only_latest_action_manager: If True, only keep most recent AM message
        keep_only_latest_user: If True, only keep most recent user message
    """

    messages: List
    agent: Optional["models.Agent"] = None
    agent_count: Optional[int] = None
    mode: ConversationMode = ConversationMode.NORMAL
    world_user_name: Optional[str] = None
    world_language: Optional[str] = None
    limit: int = 25
    include_response_instruction: bool = True
    skip_latest_image: bool = False
    keep_only_latest_action_manager: bool = False
    keep_only_latest_user: bool = False


@dataclass
class ImageAttachment:
    """
    Image attachment data for multimodal messages.

    Attributes:
        data: Base64-encoded image data (without data URL prefix)
        media_type: MIME type (e.g., 'image/png', 'image/jpeg')
    """

    data: str
    media_type: str


@dataclass
class AgentResponseContext:
    """
    Context required for generating agent responses.

    This dataclass groups all parameters needed by AgentManager.generate_sdk_response(),
    reducing the parameter count from 11 to 1.

    Attributes:
        system_prompt: The system prompt that defines the agent's behavior
        user_message: The user's message to respond to
        agent_name: The name of the agent (used for dynamic agent settings)
        config: Agent configuration data (grouped)
        room_id: Room ID where this response is being generated
        agent_id: Agent ID generating the response
        group_name: Optional group name for applying group-specific tool config overrides
        session_id: Optional session ID to resume a previous conversation
        task_id: Optional unique identifier for tracking this task (for interruption)
        conversation_started: Optional timestamp when the conversation started
        image: Optional image attachment for multimodal messages
        output_format: Optional structured output format (e.g., {"type": "json_schema", "schema": ...})
        world_name: Optional world name for TRPG mode (used by WorldSeedManager)
        db: Optional database session for TRPG game tools
        world_id: Optional world ID for TRPG game tools
        npc_reactions: Optional list of NPC reactions from the reaction cell
    """

    system_prompt: str
    user_message: str
    agent_name: str
    config: AgentConfigData
    room_id: int
    agent_id: int
    group_name: Optional[str] = None
    session_id: Optional[str] = None
    task_id: Optional[TaskIdentifier] = None
    conversation_started: Optional[str] = None
    image: Optional[ImageAttachment] = None
    output_format: Optional[dict] = None
    world_name: Optional[str] = None
    db: Optional["AsyncSession"] = None
    world_id: Optional[int] = None
    npc_reactions: Optional[List[Dict[str, Any]]] = None
