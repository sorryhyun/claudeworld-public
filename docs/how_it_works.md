# How ClaudeWorld Works

> **Works with Claude Code!** ClaudeWorld is designed to work seamlessly with [Claude Code](https://claude.ai/code). If you have a Claude subscription, you can run this project without any additional API costs or configuration—the Claude Agent SDK authenticates automatically through your active Claude Code session.

This document explains the TRPG system architecture, game flow, and agent collaboration.

---

## ClaudeWorld Overview

ClaudeWorld is a **turn-based text adventure (TRPG)** where AI agents collaborate to create and run interactive worlds:

1. **Onboarding Phase**: Interview → World generation → Character creation
2. **Gameplay Phase**: User action → NPC reactions → Interpretation → Resolution → Narration

The system uses a **2-cell tape architecture**:
- **Cell 1**: NPCs at the player's location react concurrently (hidden)
- **Cell 2**: Action Manager receives reactions, coordinates sub-agents via SDK Task tool, and generates visible output via `narration` and `suggest_options` tools

---

## TRPG System Agents

Seven specialized agents work together, organized into two groups:

### System Agents (`agents/group_gameplay/`)

| Agent | Role | Invocation |
|-------|------|------------|
| **Onboarding_Manager** | Interviews player, generates world seed (stats, location, inventory) | Triggered by system message |
| **Action_Manager** | Interprets player actions, coordinates sub-agents, generates narration | In tape (hidden from frontend) |
| **Chat_Summarizer** | Summarizes chat mode conversations when exiting | Direct invocation on `/end` |
| **History_Summarizer** | Compresses turn history into consolidated summaries for long-term recall | Invoked periodically during gameplay |

### Sub-Agents (`agents/group_subagent/`)

| Agent | Role | Invocation |
|-------|------|------------|
| **Item_Designer** | Creates new item templates with balanced stats and rich lore | Sub-agent via Task tool |
| **Character_Designer** | Creates NPCs when interactions require them | Sub-agent via Task tool |
| **Location_Designer** | Creates new locations during exploration | Sub-agent via Task tool |

---

## Game Flow

### The 2-Cell Tape System

ClaudeWorld uses a **2-cell tape** where NPCs react to player actions before the Action Manager processes them:

```
User Action
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  Cell 1: NPC Reactions (concurrent, hidden)                 │
│  ─────────────────────────────────────────                  │
│  All NPCs at current location react in parallel.            │
│  Reactions are collected (not saved to DB) and passed       │
│  to the next cell.                                          │
└─────────────────────────────────────────────────────────────┘
     │ collected reactions
     ▼
┌─────────────────────────────────────────────────────────────┐
│  Cell 2: Action_Manager (hidden)                            │
│  ────────────────────────────────                           │
│  Receives NPC reactions in context, then:                   │
│    ├── change_stat()             → Direct stat changes      │
│    ├── Task(item_designer)       → Create items             │
│    ├── Task(character_designer)  → Create NPCs              │
│    ├── Task(location_designer)   → Create locations         │
│    ├── narration()               → Visible narrative        │
│    └── suggest_options()         → Clickable actions        │
└─────────────────────────────────────────────────────────────┘
```

**Key Architecture:**
- **Cell 1**: NPC reaction cell—runs all NPCs at the player's location concurrently, collects their hidden responses
- **Cell 2**: Action_Manager—receives NPC reactions in context, interprets actions, and generates visible output
- **Sub-agents**: Invoked via SDK Task tool with AgentDefinitions
- **Persist tools**: Sub-agents use persist tools to save results directly (filesystem-first)
- **Visible output**: Action_Manager creates visible messages via `narration` and `suggest_options` tools

### Turn Processing Flow

1. **User submits action** via `/api/worlds/{world_id}/action`
2. **Action saved to database** and turn counter incremented
3. **TRPG Orchestrator** triggers agent responses in background
4. **Tape Executor** runs:
   - **Cell 1**: NPCs at current location react concurrently (hidden), reactions collected
   - **Cell 2**: Action_Manager receives reactions, interprets action, invokes sub-agents, creates narration
5. **Polling endpoint** delivers responses to frontend

---

## Onboarding Phase

### How Onboarding Works

When a player creates a world, the **Onboarding_Manager** conducts an interview:

1. **Interview Phase**:
   - Asks about preferred genre, theme, atmosphere
   - Explores specific elements the player wants
   - Compiles a comprehensive "world brief"

2. **Draft World** (via `draft_world` tool):
   - Creates lightweight world draft with:
     - **Genre**: e.g., "dark fantasy", "sci-fi horror"
     - **Theme**: e.g., "survival and redemption"
     - **Lore summary**: One-paragraph summary to unblock sub-agents

3. **Sub-agent Population** (via Task tool):
   - Invokes sub-agents in background with draft context
   - location_designer, character_designer, item_designer

4. **Persist World** (via `persist_world` tool):
   - Creates comprehensive world with:
     - **Full lore**: 8-15 paragraphs (overwrites draft)
     - **Stat system**: HP, Mana, etc. with min/max/default values
     - **World notes**: Context for gameplay agents

5. **Finalization** (via `complete` tool):
   - Sets player name
   - World phase transitions from "onboarding" to "active"

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
| `change_stat` | Apply stat/inventory changes directly |
| `Task(item_designer)` | Invoke Item_Designer to create new item templates |
| `Task(character_designer)` | Invoke Character_Designer to create NPCs |
| `Task(location_designer)` | Invoke Location_Designer to create new areas |
| `narration` | Create visible narrative message to the player |
| `suggest_options` | Provide 2 clickable action buttons |
| `travel` | Move player to location (triggers NPC memory round, saves chat summary, creates narration) |
| `remove_character` | Archive NPCs (death/departure) |
| `move_character` | Relocate NPC to different location |
| `inject_memory` | Add memory to specific NPC's recent_events.md |

### Chat Mode

During gameplay, players can enter **Chat Mode** to have free-form conversations with NPCs:

- Start via `/chat` command (warms Chat_Summarizer client in background)
- Direct back-and-forth dialogue without Action Manager overhead
- NPC responds in character based on their personality and current context
- End via `/end` command:
  1. Chat_Summarizer generates a 2-4 sentence summary of the conversation
  2. Summary passed to Action Manager for narration and gameplay continuation

### NPC Memory System

NPCs maintain their own memories via the `memorize` and `recall` tools. When the player travels to a new location, a **memory round** is triggered:

```
Player action: "Go to the forest"
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  Cell 1: NPC Reactions (as usual)                           │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  Cell 2: Action Manager                                     │
│    └── travel() tool called                                 │
│          ├── 1. Save chat summary to history.md             │
│          ├── 2. Trigger Memory Round (parallel)             │
│          │     └── Each NPC at departing location:          │
│          │         "Use memorize tool for significant       │
│          │          events before player leaves"            │
│          ├── 3. Move player to destination                  │
│          └── 4. Create arrival narration                    │
└─────────────────────────────────────────────────────────────┘
```

**Key points:**
- NPCs only remember events they personally witnessed (stored in `consolidated_memory.md`)
- Memory round runs in parallel for all NPCs at the departing location
- NPCs use `memorize` tool to save significant events to their long-term memory
- On future encounters, NPCs use `recall` tool to retrieve relevant memories

This design ensures:
- **Realistic knowledge**: NPCs don't know about events at other locations
- **Persistent relationships**: NPC memories survive across game sessions
- **Efficient context**: Only relevant memories are loaded on demand via `recall`

---

## Sub-Agent Invocation

Sub-agents are invoked via the SDK Task tool with AgentDefinitions:

### Architecture

```python
# Each sub-agent invocation:
# 1. Action Manager calls Task(agent_name="item_designer", prompt="...")
# 2. SDK creates sub-agent with registered AgentDefinition
# 3. Sub-agent uses persist tool (e.g., persist_item)
# 4. Persist tool writes to filesystem + syncs to database
# 5. Task result returned to Action Manager
```

### Item Designer

**Invoked by**: `Task(agent_name="item_designer", prompt="...")`

**Uses tool**: `persist_item` to create item templates

**Input schema** for persist tool:
```python
item_id: str         # snake_case identifier (e.g., "frostbite_dagger")
name: str            # Display name (e.g., "Frostbite Dagger")
description: str     # Rich lore and visual details
properties: dict     # Item stats (damage, armor, heal, effect, etc.)
```

Creates item template in `worlds/{world_name}/items/{item_id}.yaml`.

### Direct Stat Changes

Action Manager uses `change_stat` directly (no sub-agent needed):

**Input schema**:
```python
stat_changes: list[StatChange]      # {stat_name, delta}
inventory_changes: list[ItemChange] # add/remove items (items must exist)
summary: str                        # Natural language summary
time_advance_minutes: int           # In-game time progression
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
    ├── lore.md                 # World background (8-15 paragraphs)
    ├── player.yaml             # Player state (stats, inventory, location)
    ├── history.md              # Compressed turn history summaries
    ├── _state.json             # Current runtime state (stats, inventory, effects)
    ├── _initial.json           # Initial state snapshot (for world reset)
    ├── locations/
    │   ├── _index.yaml         # Location registry with positions
    │   └── {location_name}/
    │       ├── description.md  # Rich 2-3 paragraph description
    │       └── events.md       # Location-specific events
    ├── agents/                 # NPCs created during gameplay
    │   └── {npc_name}/
    │       ├── in_a_nutshell.md
    │       ├── characteristics.md
    │       ├── recent_events.md       # Short-term context (auto-updated)
    │       └── consolidated_memory.md # Long-term memories (via memorize tool)
    ├── items/                  # Item definitions (YAML files)
    │   └── {item_id}.yaml      # Item template with properties
    └── maps/                   # Optional map assets
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

- **Correct**: "Action_Manager is the hidden orchestrator who..."
- **Wrong**: "You are the Action_Manager, a hidden orchestrator..."

The system prompt (in `guidelines_3rd.yaml`) uses `{agent_name}` placeholders to instruct Claude to embody the character.

---

## Example Turn

```
1. User: "I attack the goblin with my sword"
   ↓
2. POST /api/worlds/123/action {"text": "I attack the goblin..."}
   ↓
3. TRPG Orchestrator creates tape:
   - Cell 1: [Goblin, Guard] (concurrent, hidden, reaction)
   - Cell 2: [Action Manager] (hidden)
   ↓
4. Cell 1 - NPC Reactions:
   - Goblin reacts: "Snarls and raises its club defensively"
   - Guard reacts: "Watches cautiously, hand on sword"
   - Reactions collected (not saved to DB)
   ↓
5. Cell 2 - Action Manager (receives NPC reactions):
   - Interprets: Combat action against goblin
   - Uses goblin's reaction to inform combat resolution
   - Calls change_stat: -15 HP for goblin, -2 stamina for player
   - Calls narration("Your sword flashes... The goblin snarls...")
   - Calls suggest_options(["Loot the goblin", "Continue exploring"])
   ↓
6. Frontend polls /api/worlds/123/poll
   - Receives narration message (visible)
   - Displays updated stats
   - Shows suggested actions as buttons
```

---

## Further Reading

- **[CLAUDE.md](../CLAUDE.md)** - Development commands, agent configuration, environment variables
- **[README.md](../README.md)** - Quick start, API endpoints, deployment
- **[backend/README.md](../backend/README.md)** - Backend architecture, debugging
