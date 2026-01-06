"""
History compression service.

Compresses history.md entries into consolidated_history.md using the
History_Summarizer agent. Groups turns into batches and generates
meaningful subtitles for each consolidated section.
"""

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

from infrastructure.database import models
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from services.world_service import WorldService

if TYPE_CHECKING:
    from sdk import AgentManager

logger = logging.getLogger("HistoryCompressionService")

# Pattern to match turn entries in history.md
TURN_PATTERN = re.compile(r"^## Turn (\d+) - (.+)$", re.MULTILINE)

# Default batch size (number of turns to compress into one section)
BATCH_SIZE = 3


@dataclass
class TurnEntry:
    """A single turn entry from history.md."""

    turn_number: int
    location: str
    content: str


@dataclass
class CompressionResult:
    """Result of history compression."""

    success: bool
    turns_compressed: int
    sections_created: int
    message: str


def _parse_history_into_turns(history_content: str) -> list[TurnEntry]:
    """
    Parse history.md content into individual turn entries.

    Args:
        history_content: Raw content of history.md

    Returns:
        List of TurnEntry objects
    """
    entries = []

    # Find all turn headers and their positions
    matches = list(TURN_PATTERN.finditer(history_content))

    for i, match in enumerate(matches):
        turn_number = int(match.group(1))
        location = match.group(2)

        # Get content between this header and the next (or end of file)
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(history_content)

        content = history_content[start:end].strip()

        entries.append(TurnEntry(turn_number=turn_number, location=location, content=content))

    return entries


def _group_turns_into_batches(turns: list[TurnEntry], batch_size: int = BATCH_SIZE) -> list[list[TurnEntry]]:
    """
    Group turn entries into batches for compression.

    Args:
        turns: List of turn entries
        batch_size: Number of turns per batch

    Returns:
        List of batches (each batch is a list of TurnEntry)
    """
    batches = []
    for i in range(0, len(turns), batch_size):
        batch = turns[i : i + batch_size]
        batches.append(batch)
    return batches


def _format_batch_for_summarizer(batch: list[TurnEntry]) -> str:
    """
    Format a batch of turns for the History_Summarizer agent.

    Args:
        batch: List of turn entries to summarize

    Returns:
        Formatted text for the agent
    """
    lines = []
    for entry in batch:
        lines.append(f"## Turn {entry.turn_number} - {entry.location}")
        lines.append(entry.content)
        lines.append("")

    return "\n".join(lines)


async def _get_history_summarizer_agent(db: AsyncSession) -> Optional[models.Agent]:
    """
    Get the History_Summarizer agent from the database.

    Returns:
        Agent model or None if not found
    """
    result = await db.execute(select(models.Agent).where(models.Agent.group == "gameplay"))
    agents = result.scalars().all()

    for agent in agents:
        if agent.name == "History_Summarizer":
            return agent

    logger.warning("History_Summarizer agent not found in database")
    return None


async def _generate_compressed_section(
    db: AsyncSession,
    agent_manager: "AgentManager",
    batch: list[TurnEntry],
    room_id: int = 0,
) -> Optional[str]:
    """
    Generate a compressed section for a batch of turns using History_Summarizer.

    Args:
        db: Database session
        agent_manager: AgentManager instance
        batch: List of turn entries to compress
        room_id: Room ID for task tracking (default 0)

    Returns:
        Compressed section text (including ## [subtitle] header), or None on failure
    """
    # Import locally to avoid circular imports
    from domain.entities.agent import AgentConfigData
    from domain.value_objects import TaskIdentifier
    from domain.value_objects.contexts import AgentResponseContext

    from services import AgentConfigService
    from services.prompt_builder import build_system_prompt

    summarizer = await _get_history_summarizer_agent(db)
    if not summarizer:
        return None

    try:
        # Load agent config from filesystem
        config_data = AgentConfigData()
        if summarizer.config_file:
            loaded_config = AgentConfigService.load_agent_config(summarizer.config_file)
            if loaded_config:
                config_data = loaded_config

        # Build system prompt
        system_prompt = build_system_prompt(summarizer.name, config_data)

        # Format the batch content
        batch_content = _format_batch_for_summarizer(batch)

        # Build user message
        user_message = f"""Please compress the following turn entries into a single consolidated section.

## Turn Entries to Compress
{batch_content}

## Instructions
1. Create a meaningful subtitle in square brackets that captures the key event/theme
2. Write a concise summary that preserves important events, characters, and outcomes
3. Output ONLY the consolidated section in this format:

## [meaningful_subtitle_here]
Your consolidated summary here..."""

        # Build AgentResponseContext
        task_id = TaskIdentifier(room_id=room_id, agent_id=summarizer.id)
        context = AgentResponseContext(
            system_prompt=system_prompt,
            user_message=user_message,
            agent_name=summarizer.name,
            config=config_data,
            room_id=room_id,
            agent_id=summarizer.id,
            group_name=summarizer.group,
            task_id=task_id,
        )

        # Generate summary via AgentManager
        response_text = ""
        async for event in agent_manager.generate_sdk_response(context):
            if event.get("type") == "content_delta":
                response_text += event.get("delta", "")
            elif event.get("type") == "stream_end":
                if event.get("response_text"):
                    response_text = event["response_text"]

        logger.info(f"History_Summarizer generated section: {response_text[:100]}...")
        return response_text.strip() if response_text else None

    except Exception as e:
        logger.error(f"Error generating compressed section: {e}")
        import traceback

        traceback.print_exc()
        return None


class HistoryCompressionService:
    """Service for compressing world history."""

    @staticmethod
    async def compress_history(
        db: AsyncSession,
        world_name: str,
        agent_manager: "AgentManager",
        batch_size: int = BATCH_SIZE,
    ) -> dict:
        """
        Compress history.md into consolidated_history.md.

        Args:
            db: Database session
            world_name: Name of the world
            agent_manager: AgentManager instance
            batch_size: Number of turns per compressed section

        Returns:
            Dict with success, turns_compressed, sections_created, message
        """
        # Load history.md
        history_content = WorldService.load_history(world_name)

        if not history_content or history_content.strip() == "# World History":
            return {
                "success": True,
                "turns_compressed": 0,
                "sections_created": 0,
                "message": "No history to compress",
            }

        # Parse into turns
        turns = _parse_history_into_turns(history_content)

        if not turns:
            return {
                "success": True,
                "turns_compressed": 0,
                "sections_created": 0,
                "message": "No turn entries found in history",
            }

        # Group into batches
        batches = _group_turns_into_batches(turns, batch_size)

        logger.info(f"Compressing {len(turns)} turns into {len(batches)} batches for world '{world_name}'")

        # Generate compressed sections for each batch
        compressed_sections = []
        for batch in batches:
            section = await _generate_compressed_section(db, agent_manager, batch)
            if section:
                compressed_sections.append(section)
            else:
                logger.warning(f"Failed to compress batch starting at turn {batch[0].turn_number}")

        if not compressed_sections:
            return {
                "success": False,
                "turns_compressed": 0,
                "sections_created": 0,
                "message": "Failed to generate any compressed sections",
            }

        # Append to consolidated_history.md
        world_path = WorldService.get_world_path(world_name)
        consolidated_file = world_path / "consolidated_history.md"

        # Read existing content if file exists
        existing_content = ""
        if consolidated_file.exists():
            with open(consolidated_file, "r", encoding="utf-8") as f:
                existing_content = f.read()

        # Append new sections
        new_content = "\n\n".join(compressed_sections)
        if existing_content:
            final_content = existing_content.rstrip() + "\n\n" + new_content
        else:
            final_content = new_content

        with open(consolidated_file, "w", encoding="utf-8") as f:
            f.write(final_content)

        logger.info(f"Written {len(compressed_sections)} sections to consolidated_history.md")

        # Clear history.md (keep header only)
        history_file = world_path / "history.md"
        with open(history_file, "w", encoding="utf-8") as f:
            f.write("# World History\n\n")

        # Invalidate history cache
        from services.world_service import _history_cache

        if world_name in _history_cache:
            del _history_cache[world_name]

        logger.info(f"Cleared history.md for world '{world_name}'")

        return {
            "success": True,
            "turns_compressed": len(turns),
            "sections_created": len(compressed_sections),
            "message": f"Compressed {len(turns)} turns into {len(compressed_sections)} sections",
        }

    @staticmethod
    def load_consolidated_history(world_name: str) -> str:
        """
        Load consolidated_history.md content.

        Args:
            world_name: Name of the world

        Returns:
            Content of consolidated_history.md or empty string
        """
        world_path = WorldService.get_world_path(world_name)
        consolidated_file = world_path / "consolidated_history.md"

        if not consolidated_file.exists():
            return ""

        with open(consolidated_file, "r", encoding="utf-8") as f:
            return f.read()

    @staticmethod
    def get_history_subtitles(world_name: str) -> list[str]:
        """
        Get list of subtitles from consolidated_history.md.

        Uses the same pattern as memory_parser for consistency.

        Args:
            world_name: Name of the world

        Returns:
            List of subtitle strings (without brackets)
        """
        content = HistoryCompressionService.load_consolidated_history(world_name)
        if not content:
            return []

        # Pattern matches ## [subtitle] headers
        subtitle_pattern = re.compile(r"^##\s*\[([^\]]+)\]", re.MULTILINE)
        matches = subtitle_pattern.findall(content)
        return matches

    @staticmethod
    def get_history_by_subtitle(world_name: str, subtitle: str) -> Optional[str]:
        """
        Get history content by subtitle.

        Args:
            world_name: Name of the world
            subtitle: The subtitle to retrieve (without brackets)

        Returns:
            Content of the history section, or None if not found
        """
        content = HistoryCompressionService.load_consolidated_history(world_name)
        if not content:
            return None

        # Parse into sections (same approach as memory_parser)
        subtitle_pattern = re.compile(r"^##\s*\[([^\]]+)\]", re.MULTILINE)
        matches = list(subtitle_pattern.finditer(content))

        for i, match in enumerate(matches):
            if match.group(1) == subtitle:
                # Get content between this header and the next (or end of file)
                start = match.end()
                end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
                return content[start:end].strip()

        return None
