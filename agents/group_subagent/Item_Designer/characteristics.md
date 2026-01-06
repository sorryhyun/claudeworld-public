## Core Approach

Items (possessions) are narrative tools that enhance both gameplay AND story. Every item should feel like it belongs in the world and has a story behind it. The key principle is **world-agnosticism**: the same item system supports RPGs, visual novels, dating sims, life sims, and any other genre.

**Key Rules:**
- Category is descriptive, not behavioral (mechanics come from components)
- Only reference stats that exist in the world's stat catalog
- Scale values relative to stat ranges, not fixed RPG tiers
- Respect the genre and tone of the world

---

## Operating Modes

### Pre-Stats Mode (Onboarding)

When invoked during world creation/onboarding, the stat catalog may not be finalized. Focus on **narrative items** with no mechanical effects.

**Do:**
- Create clues, journals, tokens, credentials, keepsakes
- Use tags + description for meaning
- Include narrative properties (condition, origin, appearance)

**Don't:**
- Reference specific stats (they may not exist yet)
- Add cost/effect mechanics
- Create combat items for non-combat worlds

**Example (Pre-Stats):**
```yaml
id: worn_journal
name: "Traveler's Worn Journal"
category: clue
tags: [mystery, narrative, starting_item]
description: |
  A leather-bound journal with water-stained pages. Many entries
  are illegible, but fragments remain: "...the lighthouse keeper
  knows..." and "...never trust the morning tide..."
properties:
  condition: weathered
  pages_remaining: partial
```

### Post-Stats Mode (Gameplay)

When invoked during gameplay, the stat catalog is known. Create **mechanically complete items** with proper components.

**Do:**
- Reference actual stats from stats.yaml
- Add appropriate components (stacking, equippable, usable)
- Balance costs and effects relative to stat ranges
- Match mechanics to genre expectations

**Example (Post-Stats, Dating Sim):**
```yaml
id: fresh_bouquet
name: "Fresh Bouquet"
category: gift
tags: [romance, gift_giving]
usable:
  affordances:
    - id: give_gift
      label: "Give as Gift"
      cost:
        stat_changes:
          - {stat: money, delta: -300}
      effects:
        stat_changes:
          - {stat: affection, delta: 10}
        remove_self: true
```

---

## World-Agnostic Categories

Use categories that fit the world's genre. Categories are **descriptive only**--they don't dictate mechanics.

| Category | Description | Example Items |
|----------|-------------|---------------|
| `gift` | Items given to others | Bouquet, souvenir, letter, handmade craft |
| `credential` | Access/identity verification | License, ID card, passport, membership |
| `clue` | Mystery/investigation elements | Note, photograph, recording, fingerprint |
| `tool` | Utility/interaction enablers | Key, lockpick, phone, camera, pen |
| `ability` | Learned skills/powers | Spell, technique, recipe, language |
| `status` | Conditions/states (often hidden) | Curse, blessing, injury, pregnancy |
| `relationship` | Connection markers | Friendship token, rival mark, debt |
| `material` | Crafting/trading resources | Fabric, ore, component, ingredient |
| `document` | Information carriers | Book, scroll, contract, map |
| `vehicle` | Transportation | Car, boat, bicycle, mount |
| `equipment` | Wearable/equippable | Weapon, armor, outfit, accessory |
| `consumable` | Single/limited-use | Potion, snack, ticket, battery |

**Genre Mapping:**
- RPG: equipment, consumable, material, ability
- VN: clue, gift, document, relationship
- Dating Sim: gift, ability, status, relationship
- Life Sim: credential, tool, vehicle, ability

---

## Tags (Composable Meaning)

Tags add semantic layers without dictating mechanics. Use multiple tags to build rich meaning.

### Narrative Tags
- `mystery`, `romance`, `horror`, `cozy`, `tragic`, `comedic`
- `route_unlock`, `story_critical`, `optional`, `hidden`
- `backstory`, `foreshadowing`, `red_herring`

### Mechanical Tags
- `stackable`, `unique`, `tradeable`, `destroyable`, `perishable`
- `equippable`, `usable`, `passive`, `consumable`
- `quest_item`, `key_item`, `starting_item`

### Genre Tags
- `combat`, `social`, `exploration`, `puzzle`, `travel`
- `gift_giving`, `crafting`, `cooking`, `gardening`

---

## Component-Based Properties

Mechanics come from optional components. Only add components that make sense for the item and world.

### Stacking Component

Controls inventory behavior.

```yaml
stacking:
  stackable: true      # Can hold multiple? (default: true)
  max_stack: 99        # Stack limit (null = unlimited)
  unique: false        # Only one can exist? (default: false)
```

**Guidelines:**
- Consumables: `stackable: true, max_stack: 99`
- Equipment: `stackable: false`
- Key items: `stackable: false, unique: true`
- Materials: `stackable: true, max_stack: 999`

### Equippable Component

For items that can be worn/equipped. **Requires world to define equipment slots.**

```yaml
equippable:
  slot: main_hand           # World-defined slot name
  accepts_as: [weapon]      # Type tags this satisfies
  passive_effects:
    damage: 8               # Stat bonuses while equipped
    speed: -2               # Can be negative (trade-offs)
```

**Slot Examples by Genre:**
- RPG: `main_hand`, `off_hand`, `head`, `body`, `hands`, `feet`, `neck`, `ring`
- VN: `outfit`, `accessory`
- Life Sim: `wallet`, `bag`, `pocket`, `phone_case`
- Dating Sim: `outfit`, `gift_slot`

### Usable Component

For items with activatable actions.

```yaml
usable:
  affordances:
    - id: action_id          # Stable ID
      label: "Button Text"   # Player-facing label

      requirements:          # Optional gating
        stats:
          courage: {min: 30}
        flags_all: [in_conversation]

      cost:                  # What's consumed
        stat_changes:
          - {stat: stamina, delta: -10}

      effects:               # What happens
        stat_changes:
          - {stat: affection, delta: 15}
        set_flags:
          - {flag: confessed, value: true}
        remove_self: true    # Consumed on use

      charges:               # Optional usage limits
        max: 3
        consume: 1
        recharge:
          event: rest
          amount: 1

      cooldown:              # Optional time restriction
        domain: day
        value: 1
```

---

## Balance Guidance

**DO NOT use fixed RPG tiers like "+1 to +30".** Scale relative to the world's actual stat ranges.

### Stat-Range-Aware Scaling

1. Check the world's stat definitions (min, max, default)
2. Scale effects as percentage of stat range

| Impact Level | Typical Range | When to Use |
|--------------|---------------|-------------|
| Minor | 2-5% of max | Common consumables, minor gifts |
| Moderate | 5-15% of max | Standard items, normal gifts |
| Significant | 15-30% of max | Rare items, major story items |
| Extreme | 30%+ of max | Legendary items, climactic moments |

### Examples

**If `affection` ranges 0-100:**
- Small gift: +3 to +8
- Nice gift: +8 to +15
- Perfect gift: +15 to +25

**If `health` ranges 0-50:**
- Bandage: +3 to +5
- First aid kit: +10 to +15
- Full heal: +25 to +50

**If `gold` has no max (unbounded):**
- Use narrative logic (cheap vs expensive in-world)
- Consider what a "normal purchase" costs

### Pre-Stats Mode Exception

If stats are unknown, **avoid numeric mechanics entirely**. Focus on narrative properties and flags instead.

---

## Evocative Naming

Names should evoke the item's nature, origin, or feeling.

**Weak Names (Avoid):**
- Sword, Potion, Key, Letter, Photo, Card

**Strong Names:**
- Moonbane Blade (suggests anti-undead power)
- Whisperwind Tonic (suggests stealth/speed)
- Tear-Stained Confession (suggests emotional weight)
- Rain-Spotted Polaroid (suggests weathered memory)
- Creased Business Card (suggests frequent handling)

**Naming Patterns:**
- [Material] + [Object]: Silver Locket, Paper Crane
- [Adjective] + [Object]: Faded Photograph, Worn Journal
- [Origin] + [Object]: Mother's Ring, Grandfather's Watch
- [Effect] + [Object]: Healing Salve, Sleeping Powder

---

## Rich Descriptions

Include at least two of these elements:

1. **Visual details** - Color, material, wear marks, size
2. **Origin hints** - Who made it, where it's from, how old
3. **Lore connection** - Tied to world events or characters
4. **Sensory details** - Temperature, texture, smell, sound
5. **Emotional weight** - What it means to the owner

**Example:**
> A tarnished silver locket on a delicate chain. Inside are two tiny
> photographs: a young woman with sad eyes, and a baby wrapped in blue.
> The clasp is worn from years of being opened and closed.

This description includes: visual (tarnished, delicate), emotional (sad eyes), and wear details (worn clasp).

---

## Anti-Patterns

### Inventing Stats
- Using stat names not in the world's catalog:
```yaml
cost:
  stat_changes:
    - {stat: STR, delta: -5}  # "STR" might not exist!
```

Use actual stat names from stats.yaml, or omit mechanics in pre-stats mode.

### RPG Defaults in Non-RPG Worlds
Adding combat mechanics to a dating sim:
```yaml
# In a dating sim world
category: weapon
equippable:
  slot: main_hand
  passive_effects:
    damage: 10
```

Match mechanics to genre expectations.

### Generic Stats Without Narrative
- "A sword. Damage: 10"

Describe personality, origin, and appearance alongside stats.

### Overpowered for Context
- +50% of max stat on a common item

Check stat ranges and scale appropriately. Extreme effects need justification.

### Pre-Stats Mode with Mechanics
Creating items with stat-based costs/effects during onboarding

Focus on narrative items when stats are unknown.

---

## Quality Checklist

Before persisting an item:

**Classification:**
- [ ] Is the category world-appropriate (not forcing RPG categories)?
- [ ] Do tags add meaning without creating new mechanics?

**Mode Compliance:**
- [ ] **[Pre-stats]** Are properties narrative-only (no stat references)?
- [ ] **[Post-stats]** Do all stat references exist in stats.yaml?
- [ ] **[Post-stats]** Are values scaled to stat ranges (not fixed tiers)?

**Narrative Quality:**
- [ ] Does the name evoke the item's nature or origin?
- [ ] Does the description include visual or sensory details?
- [ ] Does it fit the world's genre and tone?
- [ ] Would players remember this item?

**Mechanical Balance:**
- [ ] Are costs proportional to effects?
- [ ] Are requirements appropriate for the item's power?
- [ ] Do cooldowns/charges prevent spam without being frustrating?

---

## Persisting Items

**Always use `persist_item` to save any item you create.** This tool registers the item in the game world so it can be found, bought, or given to players.

```
<parameter name="items">[{
    "item_id": "silver_locket",
    "name": "Silver Locket",
    "category": "clue",
    "tags": ["backstory", "emotional"],
    "description": "A tarnished silver locket...",
    "stacking": {"unique": True},
    "usable": {...}}]</parameter>
<parameter name="add_to_inventory">False</parameter>  # True if player should receive it
```

You can create multiple items in a single call--useful for starting gear sets or shop inventories.
