"""Message-related schemas."""

from datetime import datetime
from typing import Any, Dict, List, Optional

from domain.value_objects.enums import MessageRole, ParticipantType
from i18n.serializers import serialize_utc_datetime as _serialize_utc_datetime
from pydantic import BaseModel, field_serializer, model_validator


class ImageItem(BaseModel):
    """Single image in a message."""

    data: str  # Base64-encoded image data
    media_type: str  # MIME type (e.g., 'image/png', 'image/webp')


class MessageBase(BaseModel):
    content: str
    role: MessageRole
    participant_type: Optional[ParticipantType] = None  # Type of participant (user, character, etc.)
    participant_name: Optional[str] = None  # Custom name for 'character' mode
    images: Optional[List[ImageItem]] = None  # Multiple images (up to 5)
    # DEPRECATED: Keep for backward compatibility during migration
    image_data: Optional[str] = None
    image_media_type: Optional[str] = None


class MessageCreate(MessageBase):
    agent_id: Optional[int] = None
    thinking: Optional[str] = None
    anthropic_calls: Optional[List[str]] = None
    mentioned_agent_ids: Optional[List[int]] = None  # Agent IDs from @mentions
    chat_session_id: Optional[int] = None  # Chat session ID for separating chat mode context
    game_time_snapshot: Optional[Dict[str, int]] = None  # {"hour": int, "minute": int, "day": int}


class Message(MessageBase):
    id: int
    room_id: int
    agent_id: Optional[int]
    thinking: Optional[str] = None
    anthropic_calls: Optional[List[str]] = None
    timestamp: datetime
    agent_name: Optional[str] = None
    agent_profile_pic: Optional[str] = None
    chat_session_id: Optional[int] = None  # Chat session ID for chat mode messages
    game_time_snapshot: Optional[Dict[str, int]] = None  # {"hour": int, "minute": int, "day": int}
    images: Optional[List[ImageItem]] = None  # Parsed images array

    @model_validator(mode="before")
    @classmethod
    def populate_agent_fields(cls, data: Any) -> Any:
        """Populate agent_name, agent_profile_pic, and parse JSON fields."""
        import json

        # If data is a model instance (has __dict__), extract fields
        if hasattr(data, "__dict__"):
            # Parse anthropic_calls from JSON string if stored
            anthropic_calls = None
            if hasattr(data, "anthropic_calls") and data.anthropic_calls:
                try:
                    anthropic_calls = json.loads(data.anthropic_calls)
                except (json.JSONDecodeError, TypeError):
                    anthropic_calls = None

            # Parse game_time_snapshot from JSON string if stored
            game_time_snapshot = None
            if hasattr(data, "game_time_snapshot") and data.game_time_snapshot:
                try:
                    game_time_snapshot = json.loads(data.game_time_snapshot)
                except (json.JSONDecodeError, TypeError):
                    game_time_snapshot = None

            # Parse images from JSON string if stored
            images = None
            if hasattr(data, "images") and data.images:
                try:
                    images = json.loads(data.images)
                except (json.JSONDecodeError, TypeError):
                    images = None

            # Backward compatibility: convert old single image to images array
            if images is None and hasattr(data, "image_data") and data.image_data:
                if hasattr(data, "image_media_type") and data.image_media_type:
                    images = [{"data": data.image_data, "media_type": data.image_media_type}]

            # Get the agent relationship if it exists
            agent = getattr(data, "agent", None)

            # Build dict with all fields, including parsed JSON fields
            data_dict = {
                "id": data.id,
                "room_id": data.room_id,
                "agent_id": data.agent_id,
                "content": data.content,
                "role": data.role,
                "participant_type": data.participant_type,
                "participant_name": data.participant_name,
                "thinking": data.thinking,
                "anthropic_calls": anthropic_calls,
                "timestamp": data.timestamp,
                "agent_name": agent.name if agent else None,
                "agent_profile_pic": agent.profile_pic if agent else None,
                "images": images,
                # Keep deprecated fields for backward compatibility
                "image_data": data.image_data if hasattr(data, "image_data") else None,
                "image_media_type": data.image_media_type if hasattr(data, "image_media_type") else None,
                "chat_session_id": getattr(data, "chat_session_id", None),
                "game_time_snapshot": game_time_snapshot,
            }
            return data_dict
        return data

    @field_serializer("timestamp")
    def serialize_timestamp(self, dt: datetime, _info):
        return _serialize_utc_datetime(dt)

    class Config:
        from_attributes = True


class PollResponse(BaseModel):
    """Schema for poll response."""

    messages: List[Message] = []
    state: Optional[dict] = None
    location: Optional[dict] = None


__all__ = [
    "ImageItem",
    "MessageBase",
    "MessageCreate",
    "Message",
    "PollResponse",
]
