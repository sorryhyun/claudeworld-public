# How ClaudeWorld Works

> **Works with Claude Code!** ClaudeWorld is designed to work seamlessly with [Claude Code](https://claude.ai/code). If you have a Claude subscription, you can run this project without any additional API costs or configuration—the Claude Agent SDK authenticates automatically through your active Claude Code session.

This document explains the TRPG system architecture, game flow, and agent collaboration.

---

## ClaudeWorld Overview

ClaudeWorld is a **turn-based text adventure (TRPG)** where AI agents collaborate to create and run interactive worlds:

1. **Onboarding Phase**: Interview → World generation → Character creation
2. **Gameplay Phase**: User action → Interpretation → Resolution → Narration

The system uses a **1-agent tape architecture** where the Action Manager (hidden) coordinates sub-agents via the SDK Task tool and generates visible output via `narration` and `suggest_options` tools.

---

## TRPG System Agents

Eight specialized agents work together, organized into two groups:

### Onboarding Phase (`agents/group_onboarding/`)

| Agent | Key Responsibility |
|-------|-------------------|
| **Onboarding_Manager** | Interviews player about world preferences |
| **World_Seed_Generator** | Creates world lore, stat system, starting location |

### Gameplay Phase (`agents/group_gameplay/`)

| Agent | Role | Invocation |
|-------|------|------------|
| **Action_Manager** | Interprets player actions, coordinates sub-agents, generates narration | In tape (hidden from frontend) |
| **Stat_Calculator** | Processes mechanical game effects (stats, items) | Sub-agent via Task tool |
| **Character_Designer** | Creates NPCs when interactions require them | Sub-agent via Task tool |
| **Location_Designer** | Creates new locations during exploration | Sub-agent via Task tool |
| **Summarizer** | Generates location/conversation summaries | Sub-agent via Task tool |
| **Chat_Summarizer** | Summarizes chat mode conversations | Sub-agent via Task tool |

---

## Game Flow

### The 1-Agent Tape System

ClaudeWorld uses a **1-agent tape with Task-based sub-agent invocation**:

```
User Action → Action_Manager (hidden)
                    │
                    ├── Task(stat_calculator)     → Stat_Calculator → persist_stat_changes
                    ├── Task(character_designer)  → Character_Designer → persist_character_design
                    ├── Task(location_designer)   → Location_Designer → persist_location_design
                    ├── narration()               → Creates visible narrative message
                    └── suggest_options()         → Creates clickable action buttons
```

**Key Architecture:**
- **Tape agents**: Only Action_Manager is in the tape (hidden from frontend)
- **Sub-agents**: Invoked via SDK Task tool with AgentDefinitions
- **Persist tools**: Sub-agents use persist tools to save results directly (filesystem-first)
- **Visible output**: Action_Manager creates visible messages via `narration` and `suggest_options` tools

### Turn Processing Flow

1. **User submits action** via `/api/worlds/{world_id}/action`
2. **Action saved to database** and turn counter incremented
3. **TRPG Orchestrator** triggers agent responses in background
4. **Tape Executor** runs:
   - Action_Manager interprets action, invokes sub-agents as needed
   - Narrator describes the outcome and suggests next actions
5. **Polling endpoint** delivers responses to frontend

---

## Onboarding Phase

### Step 1: Onboarding Manager Interview

When a player creates a world, the **Onboarding_Manager** conducts an interview:

- Asks about preferred genre, theme, atmosphere
- Explores specific elements the player wants
- Compiles a comprehensive "world brief"

When satisfied, it calls the `complete` tool with:
- Genre and theme
- World lore outline
- Player's character name

### Step 2: World Seed Generation

The `complete` tool invokes **World_Seed_Generator** via `WorldSeedManager`:

1. Persists world config (genre, theme, lore) to filesystem
2. World_Seed_Generator returns a `WorldSeed` with:
   - **Stat system**: HP, Mana, etc. with min/max/default values
   - **Initial location**: Starting area with rich description
   - **Starting inventory**: Optional initial items
   - **World notes**: Context for gameplay agents
3. World phase transitions from "onboarding" to "active"

---

## Gameplay Phase

### Action Manager

**Role**: Hidden orchestrator that interprets actions, coordinates sub-agents, and generates all visible output

**Responsibilities:**
- Interprets free-text player input
- Determines action feasibility and involved NPCs
- Invokes sub-agents via Task tool for mechanical effects
- Creates narrative descriptions via `narration` tool
- Suggests next actions via `suggest_options` tool

**Available Tools:**

| Tool | Purpose |
|------|---------|
| `Task(stat_calculator)` | Invoke Stat_Calculator for stat/inventory changes |
| `Task(character_designer)` | Invoke Character_Designer to create NPCs |
| `Task(location_designer)` | Invoke Location_Designer to create new areas |
| `narration` | Create visible narrative message to the player |
| `suggest_options` | Provide 2 clickable action buttons |
| `travel` | Move player to location (combines narration + suggestions + chat summary) |
| `remove_character` | Archive NPCs (death/departure) |
| `move_character` | Relocate NPC to different location |
| `inject_memory` | Add memory to specific NPC's recent_events.md |

### Chat Mode

During gameplay, players can enter **Chat Mode** to have free-form conversations with NPCs:

- Start via `/api/worlds/{id}/chat-mode/start` with target NPC
- Direct back-and-forth dialogue without Action Manager/Narrator overhead
- NPC responds in character based on their personality and current context
- End via `/api/worlds/{id}/chat-mode/end` to return to normal gameplay

---

## Sub-Agent Invocation

Sub-agents are invoked via the SDK Task tool with AgentDefinitions:

### Architecture

```python
# Each sub-agent invocation:
# 1. Action Manager calls Task(agent_name="stat_calculator", prompt="...")
# 2. SDK creates sub-agent with registered AgentDefinition
# 3. Sub-agent uses persist tool (e.g., persist_stat_changes)
# 4. Persist tool writes to filesystem + syncs to database
# 5. Task result returned to Action Manager
```

### Stat Calculator

**Invoked by**: `Task(agent_name="stat_calculator", prompt="...")`

**Uses tool**: `persist_stat_changes` to apply changes

**Input schema** for persist tool:
```python
stat_changes: list[StatChange]      # old_value → new_value
inventory_changes: list[ItemChange] # add/remove items
summary: str                        # Natural language summary
```

Changes are persisted to filesystem (`_state.json`) and synced to database.

### Character Designer

**Invoked by**: `Task(agent_name="character_designer", prompt="...")`

**Uses tool**: `persist_character_design` to create NPC

**Input schema** for persist tool:
```python
name: str
role: str                    # shopkeeper, guard, quest_giver, etc.
appearance: str
personality: str
secret: str | None           # Hidden motivation
initial_disposition: str     # Attitude toward player
```

Creates agent folder in `agents/{world_name}/{npc_name}/` with `in_a_nutshell.md` and `characteristics.md`.

### Location Designer

**Invoked by**: `Task(agent_name="location_designer", prompt="...")`

**Uses tool**: `persist_location_design` to create location

**Input schema** for persist tool:
```python
name: str                    # Slug (e.g., "dark_forest")
display_name: str            # Human-readable name
description: str             # Rich 2-3 paragraph description
position_x: int              # Map coordinates
position_y: int
adjacent_hints: list[str]    # Connected locations
```

Creates location in filesystem (`worlds/{world_name}/locations/{name}/`) and database with associated room.

---

## Data Storage

ClaudeWorld uses **filesystem-primary architecture**—the filesystem is the source of truth, the database is cache.

### Filesystem Structure

```
worlds/
  {world_name}/
    ├── world.yaml              # Config (genre, theme, phase, owner_id)
    ├── stats.yaml              # Stat system definitions
    ├── lore.md                 # World background
    ├── player.yaml             # Player state (stats, inventory, location)
    ├── locations/
    │   ├── _index.yaml         # Location registry
    │   └── {location_name}/
    │       ├── description.md
    │       └── events.md       # Location-specific events
    ├── agents/                 # NPCs created during gameplay
    │   └── {npc_name}/
    │       ├── in_a_nutshell.md
    │       └── characteristics.md
    └── items/                  # Item definitions
```

### Database Models

| Model | Purpose |
|-------|---------|
| **World** | Metadata cache (phase, genre, timestamps, onboarding_room_id) |
| **PlayerState** | Current stats, inventory, turn count, effects |
| **Location** | Discovered areas with room associations, position |
| **Room** | Message containers for each location |

### Room Integration

Each Location has an associated Room for message history. When the player travels, they switch to that location's room and see its conversation context.

---

## Why Third-Person Perspective?

Agent files use **third-person** because the Claude Agent SDK inherits an immutable "You are Claude Code" system prompt. Third-person descriptions avoid conflicting "You are..." statements:

- **Correct**: "The Narrator is a masterful storyteller who..."
- **Wrong**: "You are the Narrator, a masterful storyteller..."

The system prompt (in `guidelines_3rd.yaml`) uses `{agent_name}` placeholders to instruct Claude to embody the character.

---

## Example Turn

```
1. User: "I attack the goblin with my sword"
   ↓
2. POST /api/worlds/123/action {"text": "I attack the goblin..."}
   ↓
3. TRPG Orchestrator creates tape: [Action Manager (hidden)]
   ↓
4. Action Manager:
   - Interprets: Combat action against goblin
   - Calls Task(stat_calculator, "player attacks goblin")
     - Stat Calculator calls persist_stat_changes
     - -15 HP for goblin, -2 stamina for player persisted
   - Calls narration("Your sword flashes...")
     - Creates visible narrative message
   - Calls suggest_options(["Loot the goblin", "Continue exploring"])
     - Creates clickable action buttons
   ↓
5. Frontend polls /api/worlds/123/poll
   - Receives narration message (visible)
   - Displays updated stats
   - Shows suggested actions as buttons
```

---

## Further Reading

- **[CLAUDE.md](CLAUDE.md)** - Development commands, agent configuration, environment variables
- **[README.md](README.md)** - Quick start, API endpoints, deployment
- **[backend/README.md](backend/README.md)** - Backend architecture, debugging
