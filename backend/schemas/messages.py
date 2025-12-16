"""Message-related schemas."""

from datetime import datetime
from typing import Any, List, Optional

from domain.value_objects.enums import MessageRole, ParticipantType
from i18n.serializers import serialize_utc_datetime as _serialize_utc_datetime
from pydantic import BaseModel, field_serializer, model_validator


class MessageBase(BaseModel):
    content: str
    role: MessageRole
    participant_type: Optional[ParticipantType] = None  # Type of participant (user, character, etc.)
    participant_name: Optional[str] = None  # Custom name for 'character' mode
    image_data: Optional[str] = None  # Base64-encoded image data
    image_media_type: Optional[str] = None  # MIME type (e.g., 'image/png', 'image/jpeg')


class MessageCreate(MessageBase):
    agent_id: Optional[int] = None
    thinking: Optional[str] = None
    anthropic_calls: Optional[List[str]] = None
    mentioned_agent_ids: Optional[List[int]] = None  # Agent IDs from @mentions
    chat_session_id: Optional[int] = None  # Chat session ID for separating chat mode context


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

    @model_validator(mode="before")
    @classmethod
    def populate_agent_fields(cls, data: Any) -> Any:
        """Populate agent_name, agent_profile_pic, and parse anthropic_calls from JSON."""
        # If data is a model instance (has __dict__), extract fields
        if hasattr(data, "__dict__"):
            # Parse anthropic_calls from JSON string if stored (always do this)
            anthropic_calls = None
            if hasattr(data, "anthropic_calls") and data.anthropic_calls:
                import json

                try:
                    anthropic_calls = json.loads(data.anthropic_calls)
                except (json.JSONDecodeError, TypeError):
                    anthropic_calls = None

            # Get the agent relationship if it exists
            agent = getattr(data, "agent", None)

            # Build dict with all fields, including parsed anthropic_calls
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
                "image_data": data.image_data,
                "image_media_type": data.image_media_type,
                "chat_session_id": getattr(data, "chat_session_id", None),
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
    "MessageBase",
    "MessageCreate",
    "Message",
    "PollResponse",
]
