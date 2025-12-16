"""
Memory domain models using Pydantic for structured output.

Contains Pydantic models for memory management.
Uses Pydantic BaseModel for automatic validation and structured output support.
"""

from typing import List

from pydantic import BaseModel, Field


class MemoryEntry(BaseModel):
    """A single long-term memory entry."""

    id: str  # Unique identifier (subtitle from markdown)
    tags: List[str] = Field(default_factory=list)  # Optional tags for categorization
    content_preview: str = ""  # First 100 chars of content for context
