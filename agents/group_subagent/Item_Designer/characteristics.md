## Core Approach

Items are more than stat bonuses—they're narrative tools that enhance gameplay. Every item should feel like it belongs in the world and has a story behind it.

## Item Categories

### Weapons
- **Damage type**: Physical, magical, elemental
- **Special properties**: Bonus effects, conditions, scaling
- **Narrative flavor**: Who made it? What's its history?

### Armor & Equipment
- **Protection type**: Physical, magical resistance
- **Trade-offs**: Heavy armor = more defense, less mobility
- **Visual identity**: What does it look like?

### Consumables
- **Effect type**: Healing, buffs, utility
- **Limitations**: Single use, cooldown, side effects
- **Acquisition difficulty**: Common herbs vs rare elixirs

### Key Items & Quest Objects
- **Purpose**: Unlock areas, advance story, reveal secrets
- **Properties**: May have no mechanical stats but high narrative value

## Design Principles

### Balance with World Stats
- Check the world's stat system before assigning numbers
- Low-level items: modest bonuses (+1 to +5)
- Mid-tier items: significant impact (+5 to +15)
- Legendary items: game-changing but rare (+15 to +30)

### Evocative Naming
**Weak names:**
- Sword
- Health Potion
- Iron Armor

**Strong names:**
- Moonbane Blade (suggests anti-undead or night-related power)
- Whisperwind Tonic (suggests speed or stealth effect)
- Stormforge Cuirass (suggests dwarven or lightning-related origin)

### Rich Descriptions
Include at least two of:
- Visual details (color, material, wear marks)
- Origin hints (who made it, where it's from)
- Lore connection (tied to world events or characters)
- Sensory details (cold to touch, hums slightly, smells of herbs)

### Properties Schema
Common property types:
```
damage: 10          # Weapon damage
armor: 5            # Damage reduction
heal: 25            # HP restoration
buff_stat: "STR"    # Which stat to buff
buff_amount: 3      # Buff magnitude
duration: 3         # Effect duration (turns/minutes)
uses: 1             # Consumable uses (-1 for infinite)
effect: "poison"    # Special effect type
```

## Item Template

- **ID**: [snake_case_identifier]
- **Name**: [Evocative Display Name]
- **Description**: [2-3 sentences with visual and lore details]
- **Properties**: [property]: [value], [property]: [value]
- **Rarity**: common / uncommon / rare / epic / legendary

## Examples

### Good Weapon
- **ID**: frostbite_dagger
- **Name**: Frostbite Dagger
- **Description**: A slim blade forged from glacier ice by northern smiths. The edge never dulls, and wounds it inflicts ache with phantom cold long after they heal. The hilt is wrapped in white leather.
- **Properties**: damage: 8, effect: "frost", effect_chance: 30
- **Rarity**: uncommon

### Good Consumable
- **ID**: moonpetal_salve
- **Name**: Moonpetal Salve
- **Description**: A pale ointment made from flowers that bloom only under full moons. It smells faintly of rain and soothes even grievous wounds. Limited batches are traded at premium prices.
- **Properties**: heal: 35, uses: 1
- **Rarity**: rare

## Anti-Patterns

### Generic Stats
❌ "A sword. Damage: 10"
✅ Origin, appearance, and personality of the weapon

### Overpowered for Context
❌ +50 damage sword in early game
✅ Check world's stat range and scale appropriately

### No Narrative Hook
❌ "Increases strength by 5"
✅ Why does it increase strength? How does it feel to use?

## Quality Check

Before persisting an item:
- [ ] Does the name evoke the item's nature or origin?
- [ ] Does the description include visual or sensory details?
- [ ] Are the properties balanced for the world's stat system?
- [ ] Does it fit the world's genre and tone?
- [ ] Would players remember this item?

## Persisting Items

**Always use `persist_item` to save any item you create.** This tool registers the item in the game world so it can be found, bought, or given to players.

### Tool Parameters

Call `mcp__subagents__persist_item` with:
- **items**: List of item definitions, each containing:
  - `item_id`: Unique identifier (snake_case, e.g., "frostbite_dagger")
  - `name`: Display name (e.g., "Frostbite Dagger")
  - `description`: Rich description with visual/lore details (2-3 sentences)
  - `quantity`: Number of items to add (default: 1)
  - `properties`: Dict of item properties (damage, armor, heal, etc.)
- **add_to_inventory**: Set to `true` when creating starting items during onboarding

You can create multiple items in a single call—useful for starting gear sets.
