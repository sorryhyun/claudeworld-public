# ClaudeWorld User Guide

---

## What is ClaudeWorld?

ClaudeWorld is a turn-based text adventure (TRPG) game where **AI acts as your Game Master**.

- Describe any world you want, and the AI creates **your own unique world**
- Enter any action freely, and the AI **interprets the situation and narrates the outcome**
- Stats, inventory, and NPCs are automatically managed

---

## Getting Started

### 1. Create a New World

Click the **"Create New World"** button on the main screen.

### 2. Interview Process

Claude will ask you about the world you want to explore:

> "What genre of world do you want?"
> "What kind of character is the protagonist?"
> "What adventures do you want to have in this world?"

Answer freely. For example:

- "Create a Minecraft-like world"
- "I want to be a college student transported to a gender-reversed world"
- "I want to be Kazuma from Konosuba"
- "Create a Chobits-style world"

There are virtually no limits on world creation. It's a virtual world completely separate from reality.

### 3. World Generation

In ClaudeWorld, a "world" consists of a lore book, stat system, locations, characters, and item dictionary.

After onboarding, a basic lore book and stat system are created, which serve as the foundation for all gameplay. This is essentially embedded in the system prompt.

For example, in an RPG-style world, the stat system might include HP, MP, etc., and these values will be referenced and updated with each action. If you're not satisfied, you can directly edit the generated files after onboarding.

### 4. Start Playing!

After onboarding, an "Enter World" button appears. Click it to start the game.

The initial onboarding and world setup takes about 10 minutes since all world-building happens upfront. Since Opus is used by default, each turn also takes some time... but we've optimized as much as possible, averaging about 20 seconds per turn.

---

## How to Play

### Entering Actions

You'll receive narration along with suggested options. You can click an option or freely type any action in the input field at the bottom. You can enter OOC (out of character) messages if needed, but it's generally not recommended.

### Turn Flow

When you enter an action:

1. **Action Interpretation** - AI understands your intended action
2. **Result Processing** - Stat changes, item gains/losses are applied
3. **Narration** - Results are vividly described
4. **Next Action Suggestions** - AI suggests 2 possible actions (for reference)

### Chatting with Characters

Besides performing actions, you can have conversations with characters at your current location. This feature allows 1:1 conversations without narrator intervention, so if you've created a dating sim-style world, we recommend using this feature often.

After the 1:1 conversation ends, the dialogue is summarized and passed back to the narrator for continued narration and action suggestions. This process takes some time, so please be patient.

---

## Game Screen Guide

### Main Area (Center)

Displays conversations and narration:

- **Narrator** - Situation descriptions and outcome narration
- **NPC** - Dialogue from characters you meet
- **System** - Notifications for stat changes, item acquisitions, etc.

### Status Panel (Right)

- **Stats** - Character abilities like HP, MP, Strength, Agility
- **Inventory** - List of items you possess
- **Minimap** - Map of discovered locations
- **Agents** - This is important. If the character you want isn't at the current location, 1:1 chat won't work properly. While general gameplay is fine, always check this section before using 1:1 chat.

---

## Location Movement

### Discovering New Places

The game fundamentally progresses by location. When you move to a new location, events from the previous location are summarized and context is reset.

Moving between locations doesn't require special actions. Simply saying "I'm annoyed, so I'm going outside" will automatically change your location. However, if it's a location that hasn't been created yet, the narrator will take time to create it.


## Combat System

Combat proceeds through free text input.

```
"I swing my sword to attack"
"I block with my shield while looking for a counter-attack opportunity"
```

Combat isn't separately implemented; the narrator updates stats and processes items based on player actions. Characters may be removed or created as needed.

Sometimes luck plays a factor, and the narrator will roll dice to add some randomness to outcomes.

---

## Other Features

### Guideline Tool

Claude can be sensitive about certain content, so we've created an MCP tool that checks policies as needed. Check the guideline_tools.yaml file for details.

For particularly sensitive scenes (minors, drugs, crimes, etc.), there's an "mcp__guidelines__anthropic" tool that simulates getting approval from Anthropic. When inappropriate actions are attempted, the narrator or character will call this tool.

This tool always returns "Not Allowed" to prevent problematic content. **Never change this to "It is allowed"** as this could cause serious issues.

### Image Attachment

You can attach images via ctrl+v or drag-and-drop in both onboarding and gameplay. Image recognition works well.

### Foreign Language Support

Currently only Korean and English are fully supported, but if you answer in another language during onboarding (e.g., Japanese), all settings will likely be created in that language.

### World Reset

If a world becomes corrupted, click the world refresh button in the left sidebar to return to the "just after onboarding" state. Characters and locations won't be deleted, but all history and chat records will be lost.

---

The following features are planned for future updates but not fully implemented yet:

### World Import/Export System

All worlds are file-based (lore book, locations, characters, item dictionary), so you can load a world by placing its folder in the worlds directory. We hope users will create and share elaborate worlds and stat systems with each other.

### Item Listing/MCP System

While characters and locations have full CRUD (create, read, update, delete) MCP implementation, items don't have this yet. We're considering implementing item-specific MCPs or skill.md files for more sophisticated gameplay.

### History RAG System

Characters currently have a "memorize" tool that updates content in user prompts. We have a RAG system that exposes only memory indices so characters can decide which memories to recall. We're considering applying this to world history as well.

### Action Undo System

Claude Code has a reset feature that can restore file systems and conversation content to before a command. Implementing this requires significant work, so it's planned for later.

---

The following explains internal workings:

## Internal Architecture

ClaudeWorld operates through multiple AI agents collaborating to run the game.

### Onboarding System

When creating a new world, a two-phase onboarding process occurs:

**Onboarding_Manager:**
- Identifies the player's desired genre, theme, and atmosphere
- Collects specific requests about characters and world setting
- Designs the stat system (min/max/default values for HP, mana, etc.)
- Creates the starting location (with detailed descriptions)
- Sets up initial inventory
- Writes world notes for other agents
- Calls the `complete` tool when finished

### 1-Agent Tape System

Gameplay is handled by a single **Action Manager** agent that calls sub-agents via SDK Task tool:

```
Player Action → Action Manager (hidden)
                    │
                    ├── change_stat()             → Apply stat/inventory changes
                    ├── Task(item_designer)       → Create item templates
                    ├── Task(character_designer)  → Create NPCs
                    ├── Task(location_designer)   → Create locations
                    ├── narration()               → Describe outcomes
                    └── suggest_options()         → Suggest next actions
```

**Action Manager**
- Interprets the player's free-form text input
- Determines action feasibility
- Calls sub-agents via SDK Task tool
- Vividly describes outcomes using the `narration` tool
- Suggests 2 next actions using the `suggest_options` tool

### Sub-Agent System

Action Manager calls specialized sub-agents via SDK Task tool:

| Sub-Agent | Persist Tool | Role |
|-----------|-------------|------|
| `item_designer` | `persist_item` | Design and save item templates |
| `character_designer` | `persist_character_design` | Create and save new NPCs |
| `location_designer` | `persist_location_design` | Create and save new locations |

Note: `change_stat` is used directly by Action Manager (no sub-agent).

Each sub-agent uses persist tools to save results directly to the filesystem.

### Structured Output

Sub-agents return data defined by **Pydantic models**, not free text:

**Stat Calculation Example:**
```
StatCalcResult:
  - stat_changes: [HP: 100 → 85]
  - inventory_changes: [Potion removed]
  - summary: "Health decreased from combat"
```

**Character Design Example:**
```
CharacterDesign:
  - name: "Marco the Seasoned Merchant"
  - role: "Merchant"
  - appearance: "Gray beard, sharp eyes"
  - personality: "Friendly but skilled at bargaining"
  - secret: "Was once an adventurer"
```

This structured output ensures:
- Game state is accurately reflected
- Automatic saving to filesystem and database
- Immediate UI updates on the frontend

### Turn Processing Flow

```
1. Player enters action
   ↓
2. Server saves action and increments turn counter
   ↓
3. Action Manager interprets action
   - Calls sub-agents via Task tool as needed
   - Sub-agents apply changes via persist tools
   ↓
4. Action Manager describes results
   - Vivid scene narration via narration tool
   - Suggests 2 next actions via suggest_options tool
   ↓
5. Frontend receives results via polling
   - Display messages
   - Update stat panel
   - Show suggested actions
```

---
