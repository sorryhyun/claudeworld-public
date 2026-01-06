"""
Database migration utilities for claudeworld (SQLite and PostgreSQL).

This module provides automatic schema migration functionality to handle
database upgrades without requiring manual deletion of the database.
Supports both SQLite (development) and PostgreSQL (production) databases.
"""

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)


async def get_database_type(conn) -> str:
    """
    Detect database type from connection.

    Returns:
        "postgresql" if PostgreSQL, "sqlite" if SQLite, "unknown" otherwise
    """
    try:
        # Try PostgreSQL-specific query
        await conn.execute(text("SELECT 1 FROM pg_type LIMIT 1"))
        return "postgresql"
    except Exception:
        # Assume SQLite if PostgreSQL query fails
        return "sqlite"


async def run_migrations(engine: AsyncEngine):
    """
    Run all database migrations to ensure schema is up-to-date.

    This function checks for missing columns and adds them with appropriate
    defaults, allowing seamless upgrades from older database versions.
    """
    logger.info("🔄 Running database migrations...")

    async with engine.begin() as conn:
        # Enum type migrations - must run FIRST before table migrations
        await _migrate_enum_types(conn)

        # Schema migrations - add missing columns/indexes
        await _migrate_agents_table(conn)
        await _migrate_messages_table(conn)
        await _migrate_rooms_table(conn)
        await _migrate_room_agents_table(conn)
        await _add_indexes(conn)

        # TRPG/Game migrations
        await _migrate_game_tables(conn)
        await _migrate_locations_table(conn)
        await _migrate_player_states_table(conn)

        # Cleanup migrations - remove deprecated tables
        await _remove_deprecated_tables(conn)

        # Timezone-aware migration
        await _migrate_to_timezone_aware(conn)

        # Data migrations - sync data from filesystem
        await _sync_agents_from_filesystem(conn)

    logger.info("✅ Database migrations completed")


# =============================================================================
# Enum Type Migrations
# =============================================================================


async def _enum_type_exists(conn, enum_name: str) -> bool:
    """Check if a PostgreSQL enum type exists."""
    result = await conn.execute(
        text("""
            SELECT COUNT(*) as count
            FROM pg_type
            WHERE typname = :enum_name
        """),
        {"enum_name": enum_name},
    )
    return result.first().count > 0


async def _get_enum_values(conn, enum_name: str) -> list[str]:
    """Get the current values of a PostgreSQL enum type."""
    result = await conn.execute(
        text("""
            SELECT e.enumlabel
            FROM pg_enum e
            JOIN pg_type t ON e.enumtypid = t.oid
            WHERE t.typname = :enum_name
            ORDER BY e.enumsortorder
        """),
        {"enum_name": enum_name},
    )
    return [row.enumlabel for row in result.fetchall()]


async def _create_or_update_enum(conn, enum_name: str, values: list[str]):
    """Create enum type if it doesn't exist, or add missing values if it does."""
    if not await _enum_type_exists(conn, enum_name):
        logger.info(f"  Creating {enum_name} enum type...")
        values_str = ", ".join(f"'{v}'" for v in values)
        await conn.execute(text(f"CREATE TYPE {enum_name} AS ENUM ({values_str})"))
        logger.info(f"  ✓ Created {enum_name} enum with values: {values}")
    else:
        # Add missing values to existing enum
        existing_values = await _get_enum_values(conn, enum_name)
        for value in values:
            if value not in existing_values:
                logger.info(f"  Adding '{value}' to {enum_name} enum...")
                await conn.execute(text(f"ALTER TYPE {enum_name} ADD VALUE '{value}'"))
                logger.info(f"  ✓ Added '{value}' to {enum_name} enum")


async def _migrate_enum_types(conn):
    """Ensure all enum types exist with correct values (PostgreSQL only)."""
    db_type = await get_database_type(conn)

    if db_type == "sqlite":
        logger.info("  Skipping enum types (SQLite uses VARCHAR for enums)")
        return

    from domain.value_objects.enums import Language, MessageRole, WorldPhase

    logger.info("  Checking enum types...")

    # Core enum types used across all tables
    await _create_or_update_enum(conn, "messagerole", [e.value for e in MessageRole])

    # TRPG/Game enum types
    await _create_or_update_enum(conn, "language", [e.value for e in Language])
    await _create_or_update_enum(conn, "worldphase", [e.value for e in WorldPhase])

    logger.info("  ✓ Enum types migration complete")


# =============================================================================
# Schema Migrations
# =============================================================================


async def _column_exists(conn, table: str, column: str) -> bool:
    """Check if a column exists in a table (supports both PostgreSQL and SQLite)."""
    db_type = await get_database_type(conn)

    if db_type == "postgresql":
        result = await conn.execute(
            text("""
                SELECT COUNT(*) as count
                FROM information_schema.columns
                WHERE table_name = :table AND column_name = :column
            """),
            {"table": table, "column": column},
        )
        return result.first().count > 0
    else:  # SQLite
        # First check if table exists
        if not await _table_exists(conn, table):
            return False

        result = await conn.execute(text(f"PRAGMA table_info({table})"))
        columns = [row[1] for row in result.fetchall()]  # Column name is at index 1
        return column in columns


async def _index_exists(conn, index_name: str) -> bool:
    """Check if an index exists (supports both PostgreSQL and SQLite)."""
    db_type = await get_database_type(conn)

    if db_type == "postgresql":
        result = await conn.execute(
            text("""
                SELECT COUNT(*) as count
                FROM pg_indexes
                WHERE indexname = :index_name
            """),
            {"index_name": index_name},
        )
    else:  # SQLite
        result = await conn.execute(
            text("""
                SELECT COUNT(*) as count
                FROM sqlite_master
                WHERE type='index' AND name = :index_name
            """),
            {"index_name": index_name},
        )

    return result.first().count > 0


async def _migrate_agents_table(conn):
    """Add/remove columns in agents table."""
    # Columns to add: (name, type, default)
    columns_to_add = [
        ("group", "VARCHAR", None),  # Note: quoted in SQL due to reserved word
        ("interrupt_every_turn", "BOOLEAN", "FALSE"),
        ("priority", "INTEGER", "0"),
        ("transparent", "BOOLEAN", "FALSE"),
        ("world_name", "VARCHAR", None),  # NULL for system agents, world name for characters
    ]

    # Columns to remove (deprecated)
    columns_to_remove = ["anti_pattern", "backgrounds", "memory", "is_critic"]

    # Add missing columns
    for col_name, col_type, default in columns_to_add:
        if not await _column_exists(conn, "agents", col_name):
            quoted_name = f'"{col_name}"' if col_name == "group" else col_name
            default_clause = f" DEFAULT {default}" if default else ""
            logger.info(f"  Adding {col_name} column to agents table...")
            await conn.execute(text(f"ALTER TABLE agents ADD COLUMN {quoted_name} {col_type}{default_clause}"))
            if col_name == "group":
                await conn.execute(text('CREATE INDEX IF NOT EXISTS idx_agents_group ON agents("group")'))
            if col_name == "world_name":
                await conn.execute(text("CREATE INDEX IF NOT EXISTS idx_agents_world_name ON agents(world_name)"))
            logger.info(f"  ✓ Added {col_name} column")

    # Remove deprecated columns
    for col_name in columns_to_remove:
        if await _column_exists(conn, "agents", col_name):
            try:
                await conn.execute(text(f"ALTER TABLE agents DROP COLUMN {col_name}"))
                logger.info(f"  ✓ Removed deprecated {col_name} column")
            except Exception:
                pass

    # Migrate unique constraint from (name) to (name, world_name)
    # This allows same-named characters in different worlds
    await _migrate_agents_unique_constraint(conn)


async def _migrate_agents_unique_constraint(conn):
    """Migrate agents unique constraint from (name) to (name, world_name)."""
    db_type = await get_database_type(conn)

    # Check if the old unique constraint exists (either as index or constraint)
    has_old_constraint = False

    if db_type == "postgresql":
        # Check for unique constraint on just name
        result = await conn.execute(
            text("""
                SELECT COUNT(*) as count
                FROM pg_indexes
                WHERE tablename = 'agents'
                AND indexdef LIKE '%UNIQUE%'
                AND indexdef LIKE '%(name)%'
                AND indexdef NOT LIKE '%(name, world_name)%'
            """)
        )
        has_old_constraint = result.first().count > 0

        # Also check for agents_name_key constraint (common name)
        if not has_old_constraint:
            result = await conn.execute(
                text("""
                    SELECT COUNT(*) as count
                    FROM pg_constraint c
                    JOIN pg_class t ON c.conrelid = t.oid
                    WHERE t.relname = 'agents'
                    AND c.conname = 'agents_name_key'
                """)
            )
            has_old_constraint = result.first().count > 0
    else:  # SQLite
        # Check for unique index on name
        result = await conn.execute(
            text("""
                SELECT COUNT(*) as count
                FROM sqlite_master
                WHERE type='index'
                AND tbl_name='agents'
                AND sql LIKE '%UNIQUE%'
                AND sql LIKE '%name%'
                AND name NOT LIKE '%world_name%'
            """)
        )
        has_old_constraint = result.first().count > 0

        # Also check column definition for UNIQUE
        if not has_old_constraint:
            result = await conn.execute(text("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'"))
            row = result.first()
            if row and row.sql:
                # Check if name column has UNIQUE constraint
                has_old_constraint = "name" in row.sql.lower() and "unique" in row.sql.lower()

    # Drop old unique constraint if exists
    if has_old_constraint:
        logger.info("  Dropping old unique constraint on agents.name...")
        try:
            if db_type == "postgresql":
                # Try dropping constraint by common names
                for constraint_name in ["agents_name_key", "agents_name_unique", "ix_agents_name"]:
                    try:
                        await conn.execute(text(f"ALTER TABLE agents DROP CONSTRAINT IF EXISTS {constraint_name}"))
                    except Exception:
                        pass
                # Try dropping unique index
                try:
                    await conn.execute(text("DROP INDEX IF EXISTS agents_name_key"))
                except Exception:
                    pass
            else:  # SQLite
                # SQLite can drop indexes, just not inline column constraints
                # The ix_agents_name index was created separately, so we can drop it
                try:
                    await conn.execute(text("DROP INDEX IF EXISTS ix_agents_name"))
                    logger.info("  ✓ Dropped ix_agents_name index")
                except Exception as e:
                    logger.warning(f"  Could not drop ix_agents_name: {e}")
            logger.info("  ✓ Dropped old unique constraint")
        except Exception as e:
            logger.warning(f"  Could not drop old unique constraint: {e}")

    # Create new unique index on (name, world_name) if it doesn't exist
    if not await _index_exists(conn, "ux_agents_name_world"):
        logger.info("  Adding unique constraint on (name, world_name)...")
        try:
            await conn.execute(text("CREATE UNIQUE INDEX ux_agents_name_world ON agents(name, world_name)"))
            logger.info("  ✓ Added unique constraint on (name, world_name)")
        except Exception as e:
            logger.warning(f"  Could not add unique constraint (may have duplicates): {e}")


async def _migrate_messages_table(conn):
    """Add columns to messages table."""
    columns = [
        ("participant_type", "VARCHAR", None),
        ("participant_name", "VARCHAR", None),
        ("image_data", "TEXT", None),
        ("image_media_type", "VARCHAR", None),
        ("anthropic_calls", "TEXT", None),
        ("chat_session_id", "INTEGER", None),  # Chat session ID for separating chat mode context
        ("game_time_snapshot", "TEXT", None),  # JSON: {"hour": int, "minute": int, "day": int}
        ("images", "TEXT", None),  # JSON array for multiple images
    ]

    for col_name, col_type, default in columns:
        if not await _column_exists(conn, "messages", col_name):
            default_clause = f" DEFAULT {default}" if default else ""
            logger.info(f"  Adding {col_name} column to messages table...")
            await conn.execute(text(f"ALTER TABLE messages ADD COLUMN {col_name} {col_type}{default_clause}"))
            logger.info(f"  ✓ Added {col_name} column")

    # Migrate existing single-image data to new images JSON array format
    await _migrate_single_images_to_array(conn)

    # Backfill NULL timestamps and add constraints
    await _fix_message_timestamps(conn)


async def _migrate_single_images_to_array(conn):
    """Migrate existing image_data/image_media_type to images JSON array."""
    import json

    # Find messages with old image format but no new format
    result = await conn.execute(
        text("""
            SELECT id, image_data, image_media_type
            FROM messages
            WHERE image_data IS NOT NULL
              AND image_media_type IS NOT NULL
              AND images IS NULL
        """)
    )
    rows = result.fetchall()

    if not rows:
        return

    logger.info(f"  Migrating {len(rows)} messages from single-image to images array format...")

    for row in rows:
        images_json = json.dumps([{"data": row.image_data, "media_type": row.image_media_type}])
        await conn.execute(
            text("UPDATE messages SET images = :images WHERE id = :id"),
            {"images": images_json, "id": row.id},
        )

    logger.info(f"  ✓ Migrated {len(rows)} messages to images array format")


async def _fix_message_timestamps(conn):
    """Backfill NULL timestamps and ensure NOT NULL constraint (PostgreSQL only)."""
    db_type = await get_database_type(conn)

    if db_type == "sqlite":
        logger.info("  Skipping timestamp checks (SQLite schema is correct from create_all)")
        return

    logger.info("  Checking message timestamps...")

    # First, backfill any NULL timestamps with current time
    result = await conn.execute(text("SELECT COUNT(*) FROM messages WHERE timestamp IS NULL"))
    null_count = result.scalar()
    logger.info(f"    Found {null_count} messages with NULL timestamp")

    if null_count and null_count > 0:
        logger.info(f"  Backfilling {null_count} NULL timestamps in messages table...")
        await conn.execute(text("UPDATE messages SET timestamp = CURRENT_TIMESTAMP WHERE timestamp IS NULL"))
        logger.info(f"  ✓ Backfilled {null_count} timestamps")

    # Add server default if not present
    result = await conn.execute(
        text("""
            SELECT column_default, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'messages' AND column_name = 'timestamp'
        """)
    )
    row = result.first()
    logger.info(
        f"    Current column_default: {row.column_default if row else 'N/A'}, is_nullable: {row.is_nullable if row else 'N/A'}"
    )

    if row and row.column_default is None:
        logger.info("  Adding server default for messages.timestamp...")
        await conn.execute(text("ALTER TABLE messages ALTER COLUMN timestamp SET DEFAULT CURRENT_TIMESTAMP"))
        logger.info("  ✓ Added server default")

    # Add NOT NULL constraint if not present
    if row and row.is_nullable == "YES":
        logger.info("  Adding NOT NULL constraint for messages.timestamp...")
        await conn.execute(text("ALTER TABLE messages ALTER COLUMN timestamp SET NOT NULL"))
        logger.info("  ✓ Added NOT NULL constraint")

    logger.info("  ✓ Message timestamps check complete")


async def _migrate_rooms_table(conn):
    """Add columns and constraints to rooms table."""
    # Check if owner_id exists
    has_owner = await _column_exists(conn, "rooms", "owner_id")

    if not has_owner:
        logger.info("  Adding owner_id column to rooms table...")
        await conn.execute(text("ALTER TABLE rooms ADD COLUMN owner_id VARCHAR"))
        await conn.execute(text("UPDATE rooms SET owner_id = 'admin' WHERE owner_id IS NULL"))
        logger.info("  ✓ Added owner_id column")

    # Migrate unique constraint to include world_id (allows same-named locations across different worlds)
    # Old constraint: (owner_id, name) - New constraint: (owner_id, name, world_id)
    if await _index_exists(conn, "ux_rooms_owner_name"):
        logger.info("  Migrating unique constraint to include world_id...")
        await conn.execute(text("DROP INDEX IF EXISTS ux_rooms_owner_name"))
        logger.info("  ✓ Dropped old unique constraint")

    if not await _index_exists(conn, "ux_rooms_owner_name_world"):
        logger.info("  Adding unique constraint on (owner_id, name, world_id)...")
        try:
            await conn.execute(text("CREATE UNIQUE INDEX ux_rooms_owner_name_world ON rooms(owner_id, name, world_id)"))
            logger.info("  ✓ Added unique constraint with world_id")
        except Exception as e:
            logger.warning(f"  Could not add unique constraint (may have duplicates): {e}")

    # Simple column additions
    simple_columns = [
        ("last_read_at", "TIMESTAMPTZ", None),
        ("is_finished", "BOOLEAN", "FALSE"),
    ]

    for col_name, col_type, default in simple_columns:
        if not await _column_exists(conn, "rooms", col_name):
            default_clause = f" DEFAULT {default}" if default else ""
            logger.info(f"  Adding {col_name} column to rooms table...")
            await conn.execute(text(f"ALTER TABLE rooms ADD COLUMN {col_name} {col_type}{default_clause}"))
            logger.info(f"  ✓ Added {col_name} column")

    # Fix NULL values in boolean columns (SQLite doesn't enforce defaults on existing rows)
    await conn.execute(text("UPDATE rooms SET is_paused = 0 WHERE is_paused IS NULL"))
    await conn.execute(text("UPDATE rooms SET is_finished = 0 WHERE is_finished IS NULL"))


async def _migrate_room_agents_table(conn):
    """Add columns to room_agents table."""
    if not await _column_exists(conn, "room_agents", "joined_at"):
        logger.info("  Adding joined_at column to room_agents table...")
        await conn.execute(text("ALTER TABLE room_agents ADD COLUMN joined_at TIMESTAMPTZ"))
        logger.info("  ✓ Added joined_at column")


async def _add_indexes(conn):
    """Add performance indexes."""
    indexes = [
        ("idx_message_room_timestamp", "messages", "(room_id, timestamp)"),
        ("ix_rooms_last_activity_at", "rooms", "(last_activity_at)"),
        ("idx_message_chat_session", "messages", "(room_id, chat_session_id)"),
    ]

    for idx_name, table, columns in indexes:
        if not await _index_exists(conn, idx_name):
            logger.info(f"  Adding {idx_name} index...")
            await conn.execute(text(f"CREATE INDEX {idx_name} ON {table} {columns}"))
            logger.info(f"  ✓ Added {idx_name} index")


# =============================================================================
# Data Migrations
# =============================================================================


async def _sync_agents_from_filesystem(conn):
    """Sync agent data from filesystem (paths, groups, profile pics, system prompts)."""

    from domain.entities.agent_config import AgentConfigData
    from i18n.korean import format_with_particles
    from sdk.loaders import get_base_system_prompt
    from sdk.parsing import list_available_configs, parse_agent_config

    logger.info("  Syncing agents from filesystem...")

    available_configs = list_available_configs()
    if not available_configs:
        return

    result = await conn.execute(text('SELECT id, name, config_file, "group", profile_pic FROM agents'))
    agents = result.fetchall()
    if not agents:
        return

    from core.settings import get_settings

    settings = get_settings()
    system_prompt_template = get_base_system_prompt()
    agents_dir = settings.agents_dir
    project_root = settings.project_root
    image_extensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]
    common_names = ["profile", "avatar", "picture", "photo"]

    for agent in agents:
        updates = {}

        # Sync path and group from filesystem
        if agent.name in available_configs:
            fs_config = available_configs[agent.name]
            if agent.config_file != fs_config["path"]:
                updates["config_file"] = fs_config["path"]
            if agent.group != fs_config["group"]:
                updates['"group"'] = fs_config["group"]

        # Sync profile pic - use config_file path to find agent folder (supports group folders)
        if not (agent.profile_pic and agent.profile_pic.startswith("data:")):
            # Use config_file path if available, otherwise fall back to direct folder
            agent_folder = None
            if agent.config_file:
                agent_folder = project_root / agent.config_file
            if not agent_folder or not agent_folder.exists():
                agent_folder = agents_dir / agent.name

            found_pic = None
            if agent_folder and agent_folder.exists() and agent_folder.is_dir():
                # First try common profile pic names
                for name in common_names:
                    for ext in image_extensions:
                        if (agent_folder / f"{name}{ext}").exists():
                            found_pic = f"{name}{ext}"
                            break
                    if found_pic:
                        break
                # Fallback: find any image file in the folder
                if not found_pic:
                    for ext in image_extensions:
                        for file in agent_folder.glob(f"*{ext}"):
                            found_pic = file.name
                            break
                        if found_pic:
                            break
            if found_pic and found_pic != agent.profile_pic:
                updates["profile_pic"] = found_pic

        # Update system prompt
        formatted_prompt = format_with_particles(system_prompt_template, agent_name=agent.name)
        if agent.config_file:
            file_config = parse_agent_config(agent.config_file)
            if file_config:
                agent_config = AgentConfigData(
                    in_a_nutshell=file_config.in_a_nutshell,
                    characteristics=file_config.characteristics,
                    recent_events=file_config.recent_events,
                    long_term_memory_subtitles=file_config.long_term_memory_subtitles,
                )
                config_markdown = agent_config.to_system_prompt_markdown(agent.name)
                if config_markdown:
                    formatted_prompt += config_markdown
        updates["system_prompt"] = formatted_prompt

        # Apply updates
        if updates:
            set_parts = []
            params = {"id": agent.id}
            for k, v in updates.items():
                param_name = k.replace('"', "")
                set_parts.append(f"{k} = :{param_name}")
                params[param_name] = v
            set_clause = ", ".join(set_parts)
            await conn.execute(text(f"UPDATE agents SET {set_clause} WHERE id = :id"), params)

    logger.info("  ✓ Agents synced from filesystem")


# =============================================================================
# TRPG/Game Migrations
# =============================================================================


async def _table_exists(conn, table: str) -> bool:
    """Check if a table exists (supports both PostgreSQL and SQLite)."""
    db_type = await get_database_type(conn)

    if db_type == "postgresql":
        result = await conn.execute(
            text("""
                SELECT COUNT(*) as count
                FROM information_schema.tables
                WHERE table_name = :table
            """),
            {"table": table},
        )
    else:  # SQLite
        result = await conn.execute(
            text("""
                SELECT COUNT(*) as count
                FROM sqlite_master
                WHERE type='table' AND name = :table
            """),
            {"table": table},
        )

    return result.first().count > 0


async def _migrate_player_states_table(conn):
    """Add chat mode columns to player_states table."""
    columns_to_add = [
        ("is_chat_mode", "BOOLEAN", "FALSE"),
        ("chat_mode_start_message_id", "INTEGER", None),
        ("chat_session_id", "INTEGER", None),  # Current chat session ID for message grouping
    ]

    for col_name, col_type, default in columns_to_add:
        if not await _column_exists(conn, "player_states", col_name):
            default_clause = f" DEFAULT {default}" if default else ""
            logger.info(f"  Adding {col_name} column to player_states table...")
            await conn.execute(text(f"ALTER TABLE player_states ADD COLUMN {col_name} {col_type}{default_clause}"))
            logger.info(f"  ✓ Added {col_name} column")


async def _migrate_locations_table(conn):
    """Add columns to locations table."""
    if not await _table_exists(conn, "locations"):
        return  # Table will be created by _migrate_game_tables

    columns_to_add = [
        ("is_draft", "BOOLEAN", "FALSE"),  # True if awaiting enrichment from Location Designer
    ]

    for col_name, col_type, default in columns_to_add:
        if not await _column_exists(conn, "locations", col_name):
            default_clause = f" DEFAULT {default}" if default else ""
            logger.info(f"  Adding {col_name} column to locations table...")
            await conn.execute(text(f"ALTER TABLE locations ADD COLUMN {col_name} {col_type}{default_clause}"))
            logger.info(f"  ✓ Added {col_name} column")


async def _migrate_game_tables(conn):
    """Create TRPG game tables if they don't exist."""
    logger.info("  Checking game tables...")

    # Create worlds table
    if not await _table_exists(conn, "worlds"):
        logger.info("  Creating worlds table...")
        await conn.execute(
            text("""
            CREATE TABLE worlds (
                id SERIAL PRIMARY KEY,
                name VARCHAR NOT NULL,
                owner_id VARCHAR,
                user_name VARCHAR,
                language language DEFAULT 'en',
                phase worldphase DEFAULT 'onboarding',
                genre VARCHAR,
                theme VARCHAR,
                stat_definitions TEXT,
                onboarding_room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                last_played_at TIMESTAMPTZ
            )
        """)
        )
        await conn.execute(text("CREATE INDEX ix_worlds_name ON worlds(name)"))
        await conn.execute(text("CREATE INDEX ix_worlds_owner_id ON worlds(owner_id)"))
        await conn.execute(text("CREATE UNIQUE INDEX ux_worlds_owner_name ON worlds(owner_id, name)"))
        logger.info("  ✓ Created worlds table")
    else:
        # Add onboarding_room_id column if it doesn't exist (migration for existing tables)
        if not await _column_exists(conn, "worlds", "onboarding_room_id"):
            logger.info("  Adding onboarding_room_id column to worlds table...")
            await conn.execute(
                text("ALTER TABLE worlds ADD COLUMN onboarding_room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL")
            )
            logger.info("  ✓ Added onboarding_room_id column")

        # Add user_name column if it doesn't exist
        if not await _column_exists(conn, "worlds", "user_name"):
            logger.info("  Adding user_name column to worlds table...")
            await conn.execute(text("ALTER TABLE worlds ADD COLUMN user_name VARCHAR"))
            logger.info("  ✓ Added user_name column")

        # Add language column if it doesn't exist, or convert VARCHAR to enum (PostgreSQL only)
        if not await _column_exists(conn, "worlds", "language"):
            logger.info("  Adding language column to worlds table...")
            db_type = await get_database_type(conn)
            if db_type == "postgresql":
                await conn.execute(text("ALTER TABLE worlds ADD COLUMN language language DEFAULT 'en'"))
            else:  # SQLite
                await conn.execute(text("ALTER TABLE worlds ADD COLUMN language VARCHAR DEFAULT 'en'"))
            logger.info("  ✓ Added language column")
        else:
            # Check if it's VARCHAR and needs conversion to enum (PostgreSQL only)
            db_type = await get_database_type(conn)
            if db_type == "postgresql":
                result = await conn.execute(
                    text("""
                        SELECT data_type, udt_name
                        FROM information_schema.columns
                        WHERE table_name = 'worlds' AND column_name = 'language'
                    """)
                )
                row = result.first()
                if row and row.data_type == "character varying":
                    logger.info("  Converting language column from VARCHAR to enum...")
                    # Convert using USING clause to handle type conversion
                    await conn.execute(
                        text("ALTER TABLE worlds ALTER COLUMN language TYPE language USING language::language")
                    )
                    logger.info("  ✓ Converted language column to enum type")

        # Add phase column or convert to enum if it's VARCHAR (PostgreSQL only)
        if not await _column_exists(conn, "worlds", "phase"):
            logger.info("  Adding phase column to worlds table...")
            db_type = await get_database_type(conn)
            if db_type == "postgresql":
                await conn.execute(text("ALTER TABLE worlds ADD COLUMN phase worldphase DEFAULT 'onboarding'"))
            else:  # SQLite
                await conn.execute(text("ALTER TABLE worlds ADD COLUMN phase VARCHAR DEFAULT 'onboarding'"))
            logger.info("  ✓ Added phase column")
        else:
            # Check if it's VARCHAR and needs conversion to enum (PostgreSQL only)
            db_type = await get_database_type(conn)
            if db_type == "postgresql":
                result = await conn.execute(
                    text("""
                        SELECT data_type, udt_name
                        FROM information_schema.columns
                        WHERE table_name = 'worlds' AND column_name = 'phase'
                    """)
                )
                row = result.first()
                if row and row.data_type == "character varying":
                    logger.info("  Converting phase column from VARCHAR to enum...")
                    await conn.execute(
                        text("ALTER TABLE worlds ALTER COLUMN phase TYPE worldphase USING phase::worldphase")
                    )
                    logger.info("  ✓ Converted phase column to enum type")

    # Create locations table
    if not await _table_exists(conn, "locations"):
        logger.info("  Creating locations table...")
        await conn.execute(
            text("""
            CREATE TABLE locations (
                id SERIAL PRIMARY KEY,
                world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
                name VARCHAR NOT NULL,
                display_name VARCHAR,
                description TEXT,
                label VARCHAR,
                position_x INTEGER DEFAULT 0,
                position_y INTEGER DEFAULT 0,
                adjacent_locations TEXT,
                room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
                is_current BOOLEAN DEFAULT FALSE,
                is_discovered BOOLEAN DEFAULT TRUE
            )
        """)
        )
        await conn.execute(text("CREATE INDEX ix_location_world ON locations(world_id)"))
        logger.info("  ✓ Created locations table")

    # Create player_states table
    if not await _table_exists(conn, "player_states"):
        logger.info("  Creating player_states table...")
        await conn.execute(
            text("""
            CREATE TABLE player_states (
                id SERIAL PRIMARY KEY,
                world_id INTEGER NOT NULL UNIQUE REFERENCES worlds(id) ON DELETE CASCADE,
                current_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
                turn_count INTEGER DEFAULT 0,
                stats TEXT,
                inventory TEXT,
                effects TEXT,
                action_history TEXT
            )
        """)
        )
        logger.info("  ✓ Created player_states table")

    # Add world_id column to rooms table (links room to world for CASCADE delete)
    if not await _column_exists(conn, "rooms", "world_id"):
        logger.info("  Adding world_id column to rooms table...")
        await conn.execute(
            text("ALTER TABLE rooms ADD COLUMN world_id INTEGER REFERENCES worlds(id) ON DELETE CASCADE")
        )
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_rooms_world_id ON rooms(world_id)"))
        logger.info("  ✓ Added world_id column")

        # Backfill world_id for existing onboarding rooms
        logger.info("  Backfilling world_id for existing onboarding rooms...")
        await conn.execute(
            text("""
                UPDATE rooms
                SET world_id = worlds.id
                FROM worlds
                WHERE rooms.id = worlds.onboarding_room_id
            """)
        )
        # Backfill world_id for existing location rooms
        logger.info("  Backfilling world_id for existing location rooms...")
        await conn.execute(
            text("""
                UPDATE rooms
                SET world_id = locations.world_id
                FROM locations
                WHERE rooms.id = locations.room_id
            """)
        )
        logger.info("  ✓ Backfilled world_id for existing rooms")

    logger.info("  ✓ Game tables migration complete")


async def _migrate_to_timezone_aware(conn):
    """
    Migrate all timestamp columns from TIMESTAMP to TIMESTAMP WITH TIME ZONE (PostgreSQL only).
    This ensures all datetime values are timezone-aware (UTC).
    SQLite uses timezone-naive DATETIME, but SQLAlchemy handles conversion in application layer.
    """
    db_type = await get_database_type(conn)

    if db_type == "sqlite":
        logger.info("  Skipping timezone migration (SQLite DATETIME is timezone-naive, handled by SQLAlchemy)")
        return

    # List of (table, column) pairs to migrate
    columns_to_migrate = [
        ("rooms", "created_at"),
        ("rooms", "last_activity_at"),
        ("rooms", "last_read_at"),
        ("agents", "created_at"),
        ("messages", "timestamp"),
        ("room_agent_sessions", "updated_at"),
        ("room_agents", "joined_at"),
        ("worlds", "created_at"),
        ("worlds", "updated_at"),
        ("worlds", "last_played_at"),
    ]

    migrated_any = False
    for table, column in columns_to_migrate:
        # Check if column exists and is not already timestamptz
        if not await _column_exists(conn, table, column):
            continue

        result = await conn.execute(
            text("""
                SELECT data_type
                FROM information_schema.columns
                WHERE table_name = :table AND column_name = :column
            """),
            {"table": table, "column": column},
        )
        row = result.first()
        if row and row.data_type == "timestamp without time zone":
            if not migrated_any:
                logger.info("  Migrating timestamp columns to timezone-aware...")
                migrated_any = True
            await conn.execute(
                text(f"""
                    ALTER TABLE {table}
                    ALTER COLUMN {column} TYPE TIMESTAMP WITH TIME ZONE
                    USING {column} AT TIME ZONE 'UTC'
                """)
            )
            logger.info(f"    ✓ Migrated {table}.{column}")

    if migrated_any:
        logger.info("  ✓ Timezone migration complete")


# =============================================================================
# Cleanup Migrations
# =============================================================================


async def _remove_deprecated_tables(conn):
    """
    Remove deprecated tables from the database.

    This handles cleanup of tables that are no longer part of the schema.
    """
    # Tables to drop (if they exist)
    deprecated_tables = [
        "npcs",  # NPC tracking now uses room_agents for character location
    ]

    for table_name in deprecated_tables:
        if await _table_exists(conn, table_name):
            logger.info(f"  Dropping deprecated table: {table_name}...")
            await conn.execute(text(f"DROP TABLE {table_name} CASCADE"))
            logger.info(f"  ✓ Dropped {table_name} table")
