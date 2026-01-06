from datetime import datetime, timezone

from domain.value_objects.enums import Language, MessageRole, WorldPhase
from sqlalchemy import Boolean, Column, DateTime, Enum, ForeignKey, Index, Integer, String, Table, Text, text
from sqlalchemy.orm import relationship

from .connection import Base

# Association table for many-to-many relationship between rooms and agents
room_agents = Table(
    "room_agents",
    Base.metadata,
    Column("room_id", Integer, ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True),
    Column("agent_id", Integer, ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True),
    Column("joined_at", DateTime(timezone=True), nullable=True),  # Timestamp when agent was added to room
)


class Room(Base):
    __tablename__ = "rooms"
    # UNIQUE on (owner_id, name, world_id) to allow same-named locations across different worlds
    # Note: NULL world_id values are considered distinct in SQLite/PostgreSQL, so chat-mode rooms work
    __table_args__ = (Index("ux_rooms_owner_name_world", "owner_id", "name", "world_id", unique=True),)

    id = Column(Integer, primary_key=True, index=True)
    owner_id = Column(String, nullable=True, index=True)
    name = Column(String, nullable=False, index=True)
    max_interactions = Column(Integer, nullable=True)  # Maximum number of agent interactions (None = unlimited)
    is_paused = Column(Boolean, default=False, server_default=text("0"))  # Whether room is paused
    is_finished = Column(
        Boolean, default=False, server_default=text("0")
    )  # Whether all agents have skipped (conversation ended)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    last_activity_at = Column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )  # Track last message time (updated only when messages are created)
    last_read_at = Column(DateTime(timezone=True), nullable=True)  # Track when user last viewed this room

    # TRPG: Link room to world for easy cleanup (nullable for ClaudeWorld rooms)
    world_id = Column(Integer, ForeignKey("worlds.id", ondelete="CASCADE"), nullable=True, index=True)

    agents = relationship("Agent", secondary=room_agents, back_populates="rooms")
    messages = relationship("Message", back_populates="room", cascade="all, delete-orphan")
    agent_sessions = relationship("RoomAgentSession", back_populates="room", cascade="all, delete-orphan")
    world = relationship("World", foreign_keys=[world_id], back_populates="rooms")

    @property
    def world_phase(self) -> str | None:
        """Get the phase of the associated world, if any."""
        return self.world.phase if self.world else None


class Agent(Base):
    __tablename__ = "agents"
    # UNIQUE on (name, world_name) to allow same-named characters in different worlds
    # NULL world_name is for system agents (shared across all worlds)
    __table_args__ = (Index("ux_agents_name_world", "name", "world_name", unique=True),)

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)  # No longer globally unique
    world_name = Column(String, nullable=True, index=True)  # NULL for system agents, world name for characters
    group = Column(String, nullable=True, index=True)  # Group name (e.g., "체인소맨" from "group_체인소맨" folder)
    config_file = Column(String, nullable=True)  # Path to agent config file (e.g., "agents/alice.md")
    profile_pic = Column(Text, nullable=True)  # Profile picture (base64 encoded image data)
    in_a_nutshell = Column(Text, nullable=True)  # Brief identity summary
    characteristics = Column(Text, nullable=True)  # Personality traits and behaviors
    recent_events = Column(Text, nullable=True)  # Short-term recent context
    system_prompt = Column(Text, nullable=False)  # Final combined system prompt
    interrupt_every_turn = Column(Boolean, default=False)  # Whether agent always responds after any message
    priority = Column(Integer, default=0)  # Priority level (0 = normal, higher = more priority)
    transparent = Column(Boolean, default=False)  # Whether agent's messages don't trigger other agents
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    rooms = relationship("Room", secondary=room_agents, back_populates="agents")
    messages = relationship("Message", back_populates="agent")
    room_sessions = relationship("RoomAgentSession", back_populates="agent", cascade="all, delete-orphan")

    def get_config_data(self, use_cache: bool = True):
        """
        Extract agent configuration from filesystem (primary source) or database (fallback).
        This implements the filesystem-primary architecture with in-memory caching.

        Args:
            use_cache: If True, check cache before loading from filesystem (default: True)

        Returns:
            AgentConfigData instance with this agent's configuration
        """
        from domain.entities.agent_config import AgentConfigData

        from infrastructure.cache import agent_config_key, get_cache

        # Check cache first if enabled
        if use_cache:
            cache = get_cache()
            cache_key = agent_config_key(self.id)
            cached_config = cache.get(cache_key)
            if cached_config is not None:
                return cached_config

        # FILESYSTEM-PRIMARY: Load from filesystem first
        config_data = None
        if self.config_file:
            try:
                from services import AgentConfigService

                # load_agent_config now returns AgentConfigData directly
                config_data = AgentConfigService.load_agent_config(self.config_file)
            except Exception as e:
                # Log error but fallback to database
                import logging

                logging.warning(f"Failed to load config from {self.config_file}, using database cache: {e}")

        # FALLBACK: Use database values if filesystem load failed
        if config_data is None:
            config_data = AgentConfigData.from_dict(
                {
                    "config_file": self.config_file,
                    "in_a_nutshell": self.in_a_nutshell or "",
                    "characteristics": self.characteristics or "",
                    "recent_events": self.recent_events or "",
                }
            )
        else:
            # Ensure config_file is set even when loaded from filesystem
            config_data.config_file = self.config_file

        # Cache the result (TTL: 300 seconds = 5 minutes)
        if use_cache:
            cache = get_cache()
            cache_key = agent_config_key(self.id)
            cache.set(cache_key, config_data, ttl_seconds=300)

        return config_data


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    room_id = Column(Integer, ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False)
    agent_id = Column(Integer, ForeignKey("agents.id", ondelete="SET NULL"), nullable=True)
    content = Column(Text, nullable=False)
    role = Column(
        Enum(MessageRole, values_callable=lambda x: [e.value for e in x]), nullable=False
    )  # 'user' or 'assistant'
    participant_type = Column(String, nullable=True)  # For user messages: 'user', 'character'; NULL for agents
    participant_name = Column(String, nullable=True)  # Custom name for 'character' mode
    thinking = Column(Text, nullable=True)  # Agent's thinking process (for assistant messages)
    anthropic_calls = Column(Text, nullable=True)  # JSON array of anthropic tool call situations
    timestamp = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        server_default=text("CURRENT_TIMESTAMP"),
        nullable=False,
    )
    image_data = Column(Text, nullable=True)  # DEPRECATED: Use images column instead
    image_media_type = Column(String, nullable=True)  # DEPRECATED: Use images column instead
    images = Column(Text, nullable=True)  # JSON array: [{"data": "base64...", "media_type": "image/webp"}, ...]

    # Chat session ID for separating chat mode conversations from game mode
    chat_session_id = Column(Integer, nullable=True, index=True)

    # Game time snapshot for displaying in-game time on messages (JSON: {"hour": int, "minute": int, "day": int})
    game_time_snapshot = Column(Text, nullable=True)

    # Indexes for frequently queried foreign keys
    __table_args__ = (
        Index("idx_message_room_id", "room_id"),
        Index("idx_message_agent_id", "agent_id"),
        Index("idx_message_room_timestamp", "room_id", "timestamp"),
        Index("idx_message_chat_session", "room_id", "chat_session_id"),
    )

    room = relationship("Room", back_populates="messages")
    agent = relationship("Agent", back_populates="messages")


class RoomAgentSession(Base):
    __tablename__ = "room_agent_sessions"

    room_id = Column(Integer, ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True)
    agent_id = Column(Integer, ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True)
    session_id = Column(String, nullable=False)  # Claude Agent SDK session ID for this room-agent pair
    updated_at = Column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc)
    )

    room = relationship("Room", back_populates="agent_sessions")
    agent = relationship("Agent", back_populates="room_sessions")


# =============================================================================
# TRPG (ClaudeWorld) Models
# =============================================================================


class World(Base):
    """
    Database cache for world metadata.
    Primary data stored in filesystem: worlds/{name}/
    """

    __tablename__ = "worlds"
    __table_args__ = (Index("ux_worlds_owner_name", "owner_id", "name", unique=True),)

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)  # Folder name
    owner_id = Column(String, nullable=True, index=True)
    user_name = Column(String, nullable=True)  # Player's display name in the world
    language = Column(
        Enum(Language, values_callable=lambda x: [e.value for e in x]), default=Language.ENGLISH
    )  # UI/message language
    phase = Column(
        Enum(WorldPhase, values_callable=lambda x: [e.value for e in x]), default=WorldPhase.ONBOARDING
    )  # Game phase
    genre = Column(String, nullable=True)  # For listing/filtering
    theme = Column(String, nullable=True)
    stat_definitions = Column(Text, nullable=True)  # JSON string of stat system definition

    # Onboarding room for pre-gameplay chat
    onboarding_room_id = Column(Integer, ForeignKey("rooms.id", ondelete="SET NULL"), nullable=True)

    # Timestamps for sorting
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc)
    )
    last_played_at = Column(DateTime(timezone=True), nullable=True)

    # Relationships
    onboarding_room = relationship("Room", foreign_keys=[onboarding_room_id])
    locations = relationship("Location", back_populates="world", cascade="all, delete-orphan")
    player_state = relationship("PlayerState", back_populates="world", uselist=False, cascade="all, delete-orphan")
    # All rooms belonging to this world (rooms deleted via FK CASCADE, not ORM cascade to avoid circular dep)
    rooms = relationship("Room", foreign_keys="Room.world_id", back_populates="world")


class Location(Base):
    """
    Database cache for location data.
    Primary data stored in: worlds/{world}/locations/{location}/
    """

    __tablename__ = "locations"
    __table_args__ = (Index("ix_location_world", "world_id"),)

    id = Column(Integer, primary_key=True, index=True)
    world_id = Column(Integer, ForeignKey("worlds.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=False)  # Folder name (slug)
    display_name = Column(String, nullable=True)  # Human-readable name
    description = Column(Text, nullable=True)  # Location description
    label = Column(String, nullable=True)  # User-assigned label

    # Position for map rendering
    position_x = Column(Integer, default=0)
    position_y = Column(Integer, default=0)

    # Adjacent locations (JSON array of location IDs)
    adjacent_locations = Column(Text, nullable=True)

    # Link to chat room for message storage
    room_id = Column(Integer, ForeignKey("rooms.id", ondelete="SET NULL"), nullable=True)

    # Quick lookup fields
    is_current = Column(Boolean, default=False)
    is_discovered = Column(Boolean, default=True)
    is_draft = Column(Boolean, default=False)  # True if awaiting enrichment from Location Designer

    world = relationship("World", back_populates="locations")
    room = relationship("Room")


class PlayerState(Base):
    """
    Current player state in a world.
    Primary data stored in: worlds/{world}/player.yaml
    """

    __tablename__ = "player_states"

    id = Column(Integer, primary_key=True, index=True)
    world_id = Column(Integer, ForeignKey("worlds.id", ondelete="CASCADE"), nullable=False, unique=True)

    # Current position
    current_location_id = Column(Integer, ForeignKey("locations.id", ondelete="SET NULL"), nullable=True)

    # Game state
    turn_count = Column(Integer, default=0)
    stats = Column(Text, nullable=True)  # JSON dict of stat values
    inventory = Column(Text, nullable=True)  # JSON array of items
    effects = Column(Text, nullable=True)  # JSON array of active effects
    action_history = Column(Text, nullable=True)  # JSON array of recent actions

    # Chat mode state
    is_chat_mode = Column(Boolean, default=False)  # Whether player is in free-form chat mode
    chat_mode_start_message_id = Column(Integer, nullable=True)  # Message ID when chat mode started
    chat_session_id = Column(Integer, nullable=True)  # Current chat session ID for message grouping

    world = relationship("World", back_populates="player_state")
    current_location = relationship("Location")
