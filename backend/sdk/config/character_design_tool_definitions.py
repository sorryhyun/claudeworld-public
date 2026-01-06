"""
Character design tool definitions.

Defines tools for comprehensive character creation with backstory and consolidated memory.
Used by detailed_character_designer agent during onboarding to create deep, memorable characters.

Combines input models and tool definitions in one place.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from .tool_definitions import ToolDefinition, ToolDict


# =============================================================================
# Input Models
# =============================================================================


class ConsolidatedMemory(BaseModel):
    """A single consolidated memory entry with subtitle and content."""

    subtitle: str = Field(
        ...,
        min_length=1,
        description="Memory subtitle (will be shown in index, e.g., 'childhood_trauma', '첫_만남')",
    )
    content: str = Field(
        ...,
        min_length=10,
        description="Full memory content (narrative, feelings, reflections)",
    )

    @field_validator("subtitle", "content", mode="before")
    @classmethod
    def validate_required(cls, v: str | None) -> str:
        if v is None:
            raise ValueError("Field is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Field cannot be empty")
        return v


class CreateComprehensiveCharacterInput(BaseModel):
    """Input for create_comprehensive_character tool.

    Used by detailed_character_designer to create a fully-fledged character
    with deep backstory, personality, and initial consolidated memories.
    """

    name: str = Field(..., min_length=1, description="Character's name")
    role: str = Field(..., min_length=1, description="Character's role (e.g., merchant, guard, sage)")
    appearance: str = Field(
        ...,
        min_length=50,
        description="Detailed physical description (50+ chars)",
    )
    personality: str = Field(
        ...,
        min_length=100,
        description="Comprehensive personality description with traits, quirks, values (100+ chars)",
    )
    backstory: str = Field(
        ...,
        min_length=200,
        description="Rich backstory narrative (200+ chars) - formative events, relationships, motivations",
    )
    which_location: str = Field(
        default="current",
        description="Where to place: 'current' or location name",
    )
    secret: str | None = Field(
        default=None,
        description="Hidden detail or motivation (optional but recommended)",
    )
    initial_disposition: str = Field(
        default="neutral",
        description="Initial attitude: friendly, neutral, wary, hostile",
    )
    initial_memories: list[ConsolidatedMemory] | None = Field(
        default=None,
        description="Initial consolidated memories (3-8 recommended) - will be implanted via separate tool",
    )

    @field_validator("name", "role", "appearance", "personality", "backstory", mode="before")
    @classmethod
    def validate_required(cls, v: str | None) -> str:
        if v is None:
            raise ValueError("Field is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Field cannot be empty")
        return v

    @field_validator("appearance", mode="before")
    @classmethod
    def validate_appearance(cls, v: str | None) -> str:
        if v is None:
            raise ValueError("Appearance is required")
        v = str(v).strip()
        if len(v) < 50:
            raise ValueError("Appearance must be at least 50 characters for detailed description")
        return v

    @field_validator("personality", mode="before")
    @classmethod
    def validate_personality(cls, v: str | None) -> str:
        if v is None:
            raise ValueError("Personality is required")
        v = str(v).strip()
        if len(v) < 100:
            raise ValueError("Personality must be at least 100 characters for comprehensive description")
        return v

    @field_validator("backstory", mode="before")
    @classmethod
    def validate_backstory(cls, v: str | None) -> str:
        if v is None:
            raise ValueError("Backstory is required")
        v = str(v).strip()
        if len(v) < 200:
            raise ValueError("Backstory must be at least 200 characters for rich narrative")
        return v


class ImplantConsolidatedMemoryInput(BaseModel):
    """Input for implant_consolidated_memory tool.

    Used to populate consolidated_memory.md file for a character.
    Can be called multiple times - each call APPENDS new memories.
    """

    character_name: str = Field(
        ...,
        min_length=1,
        description="Character name (must match existing character in world)",
    )
    memories: list[ConsolidatedMemory] = Field(
        ...,
        min_length=1,
        description="List of consolidated memories to implant (each with subtitle and content)",
    )
    mode: str = Field(
        default="append",
        description="Operation mode: 'append' (add to existing) or 'overwrite' (replace all)",
    )

    @field_validator("character_name", mode="before")
    @classmethod
    def validate_character_name(cls, v: str | None) -> str:
        if v is None:
            raise ValueError("Character name is required")
        v = str(v).strip()
        if not v:
            raise ValueError("Character name cannot be empty")
        return v

    @field_validator("mode", mode="before")
    @classmethod
    def validate_mode(cls, v: str | None) -> str:
        if v is None:
            return "append"
        v = str(v).strip().lower()
        if v not in ["append", "overwrite"]:
            raise ValueError("Mode must be 'append' or 'overwrite'")
        return v


# =============================================================================
# Tool Definitions
# =============================================================================


CHARACTER_DESIGN_TOOLS: ToolDict = {
    "create_comprehensive_character": ToolDefinition(
        name="mcp__character_design__create_comprehensive_character",
        description="""\
Create a comprehensive character with detailed backstory, personality, and initial memories.

This tool creates a fully-fledged character suitable for deep roleplay interactions.
Use this during onboarding when the user wants rich, memorable characters rather than simple NPCs.

**What it does:**
1. Creates character files (in_a_nutshell.md, characteristics.md) with backstory
2. Adds character to specified location
3. Prepares character for memory implantation (call implant_consolidated_memory next)

**When to use:**
- User explicitly requests "detailed character" or "comprehensive character"
- Creating main story NPCs with rich backgrounds
- Building characters that need depth and complexity

**After calling this tool:**
Call implant_consolidated_memory to populate the character's long-term memories.""",
        input_model=CreateComprehensiveCharacterInput,
        response="{creation_result}",
        enabled=True,
    ),
    "implant_consolidated_memory": ToolDefinition(
        name="mcp__character_design__implant_consolidated_memory",
        description="""\
Implant consolidated memories into a character's long-term memory file.

Populates consolidated_memory.md with formatted memories that the character can recall.
Each memory has a subtitle (shown in memory index) and content (full narrative).

**Format in consolidated_memory.md:**
```markdown
## [memory_subtitle]
Memory content here...

## [another_memory]
More content...
```

**Usage:**
- Call after create_comprehensive_character to add initial memories
- Can be called multiple times (append mode) to add more memories later
- Use overwrite mode to completely replace all memories

**Memory design tips:**
- 3-8 memories recommended for initial setup
- Subtitles should be memorable keywords (e.g., 'childhood_trauma', '스승의_가르침')
- Content should include narrative + emotional reflection
- Mix formative events, relationships, skills, and beliefs""",
        input_model=ImplantConsolidatedMemoryInput,
        response="{implant_result}",
        enabled=True,
    ),
}
