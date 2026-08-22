import { describe, expect, test } from 'bun:test'

import {
  applyAffordanceCosts,
  applyAffordanceEffects,
  applyStatChanges,
  buildStatMap,
  checkAffordanceRequirements,
  checkChargesAvailable,
  checkCooldownReady,
  clampStatValue,
  equipItem,
  findInventoryItem,
  getEquippedPassiveEffects,
  initializeStatsFromDefinitions,
  InventoryItem,
  LOWER_IS_BETTER_PROPERTIES,
  mergeInventoryItem,
  normalizeProperties,
  normalizePropertyValue,
  removeInventoryItem,
  unequipSlot,
  updateChargesAndCooldown,
  updateInventoryItemProps,
  type Affordance,
  type Equipment,
  type InventoryEntry,
  type StatDefinitions,
} from '../domain/player-rules'

/** The stat block a generated world typically produces. */
const STAT_DEFS: StatDefinitions = {
  stats: [
    { name: 'health', min: 0, max: 100, default: 100 },
    { name: 'stamina', min: 0, max: 10, default: 10 },
    // Reputation is signed and uncapped upward: min only.
    { name: 'reputation', min: -100, default: 0 },
    // Coin has no bounds at all.
    { name: 'coin', default: 5 },
  ],
}

describe('buildStatMap', () => {
  test('keys definitions by name', () => {
    const map = buildStatMap(STAT_DEFS)
    expect(Object.keys(map).sort()).toEqual(['coin', 'health', 'reputation', 'stamina'])
    expect(map.health?.max).toBe(100)
  })

  test('null, empty and stat-less definitions all give an empty map', () => {
    expect(buildStatMap(null)).toEqual({})
    expect(buildStatMap(undefined)).toEqual({})
    expect(buildStatMap({})).toEqual({})
    expect(buildStatMap({ stats: [] })).toEqual({})
  })

  test('a nameless definition throws, as Python raises KeyError', () => {
    expect(() => buildStatMap({ stats: [{ min: 0 } as never] })).toThrow(TypeError)
  })
})

describe('clampStatValue', () => {
  const map = buildStatMap(STAT_DEFS)

  test('clamps at both bounds and passes values in between', () => {
    expect(clampStatValue(100, 'health', map)).toBe(100) // exactly at max
    expect(clampStatValue(0, 'health', map)).toBe(0) // exactly at min
    expect(clampStatValue(50, 'health', map)).toBe(50)
    expect(clampStatValue(150, 'health', map)).toBe(100) // past max
    expect(clampStatValue(-30, 'health', map)).toBe(0) // past min
  })

  test('applies only the bound that is defined', () => {
    expect(clampStatValue(9999, 'reputation', map)).toBe(9999) // no max
    expect(clampStatValue(-500, 'reputation', map)).toBe(-100)
    expect(clampStatValue(-500, 'coin', map)).toBe(-500) // no bounds at all
  })

  test('an undefined stat is returned untouched, not zeroed', () => {
    expect(clampStatValue(-999, 'sanity', map)).toBe(-999)
    expect(clampStatValue(999, 'sanity', {})).toBe(999)
  })
})

describe('applyStatChanges', () => {
  test('adds deltas and clamps each result', () => {
    const stats = { health: 95, stamina: 3 }
    expect(applyStatChanges(stats, { health: 20, stamina: -1 }, STAT_DEFS)).toEqual({
      health: 100,
      stamina: 2,
    })
  })

  test('does not mutate the input', () => {
    const stats = { health: 50 }
    applyStatChanges(stats, { health: -10 }, STAT_DEFS)
    expect(stats).toEqual({ health: 50 })
  })

  test('a stat absent from the current block starts at 0', () => {
    expect(applyStatChanges({}, { health: -5 }, STAT_DEFS)).toEqual({ health: 0 })
    expect(applyStatChanges({}, { coin: -5 }, STAT_DEFS)).toEqual({ coin: -5 })
  })

  test('with no definitions nothing is clamped', () => {
    expect(applyStatChanges({ health: 95 }, { health: 20 })).toEqual({ health: 115 })
  })

  test('an undefined stat is added unclamped alongside defined ones', () => {
    expect(applyStatChanges({ health: 10 }, { health: -100, sanity: -100 }, STAT_DEFS)).toEqual({
      health: 0,
      sanity: -100,
    })
  })
})

describe('initializeStatsFromDefinitions', () => {
  test('uses each stat default, falling back to 0', () => {
    expect(initializeStatsFromDefinitions({ stats: [{ name: 'luck' }] })).toEqual({ luck: 0 })
    expect(initializeStatsFromDefinitions(STAT_DEFS)).toEqual({
      health: 100,
      stamina: 10,
      reputation: 0,
      coin: 5,
    })
  })

  test('overrides win and may introduce undeclared stats, unclamped', () => {
    expect(initializeStatsFromDefinitions(STAT_DEFS, { health: 250, sanity: 3 })).toMatchObject({
      health: 250, // character creation is trusted; no clamping here
      sanity: 3,
    })
  })
})

describe('InventoryItem serialization', () => {
  test('toDict emits the full embedded key set', () => {
    const item = new InventoryItem({
      id: 'rusty_sword',
      name: 'Rusty Sword',
      description: 'Blunt.',
      quantity: 2,
      properties: { damage: 3 },
    })
    expect(item.toDict()).toEqual({
      item_id: 'rusty_sword',
      name: 'Rusty Sword',
      description: 'Blunt.',
      quantity: 2,
      properties: { damage: 3 },
    })
  })

  test('toDict normalizes absent properties to an empty object', () => {
    const item = new InventoryItem({ id: 'rope', name: 'Rope' })
    expect(item.toDict()).toEqual({
      item_id: 'rope',
      name: 'Rope',
      description: null,
      quantity: 1,
      properties: {},
    })
  })

  test('toReferenceDict emits only the reference keys', () => {
    const item = new InventoryItem({
      id: 'rusty_sword',
      name: 'Rusty Sword',
      description: 'Blunt.',
      quantity: 2,
      properties: { durability: 40 },
    })
    expect(item.toReferenceDict()).toEqual({
      item_id: 'rusty_sword',
      quantity: 2,
      instance_properties: { durability: 40 },
    })
    // Name and description must not leak into player.json.
    expect(Object.keys(item.toReferenceDict()).sort()).toEqual([
      'instance_properties',
      'item_id',
      'quantity',
    ])
  })

  test('toReferenceDict omits instance_properties when there are none', () => {
    expect(new InventoryItem({ id: 'rope', name: 'Rope' }).toReferenceDict()).toEqual({
      item_id: 'rope',
      quantity: 1,
    })
    // Empty is falsy in Python, so `{}` is omitted too, not written through.
    expect(
      new InventoryItem({ id: 'rope', name: 'Rope', properties: {} }).toReferenceDict(),
    ).toEqual({ item_id: 'rope', quantity: 1 })
  })

  test('fromDict accepts either id spelling and either properties spelling', () => {
    expect(InventoryItem.fromDict({ id: 'a', name: 'A' }).id).toBe('a')
    expect(InventoryItem.fromDict({ item_id: 'b', name: 'B' }).id).toBe('b')
    expect(InventoryItem.fromDict({}).id).toBe('')
    expect(InventoryItem.fromDict({ item_id: 'c', properties: { x: 1 } }).properties).toEqual({
      x: 1,
    })
    expect(
      InventoryItem.fromDict({ item_id: 'c', instance_properties: { y: 2 } }).properties,
    ).toEqual({ y: 2 })
    // Empty `properties` is falsy in Python and falls through.
    expect(
      InventoryItem.fromDict({ item_id: 'c', properties: {}, instance_properties: { y: 2 } })
        .properties,
    ).toEqual({ y: 2 })
  })
})

describe('InventoryItem.fromReference', () => {
  const template = {
    id: 'rusty_sword',
    name: 'Rusty Sword',
    description: 'Blunt but yours.',
    default_properties: { damage: 3, durability: 100 },
  }

  test('instance properties override template defaults', () => {
    const item = InventoryItem.fromReference(
      { item_id: 'rusty_sword', quantity: 1, instance_properties: { durability: 12 } },
      template,
    )
    expect(item.name).toBe('Rusty Sword')
    expect(item.description).toBe('Blunt but yours.')
    // damage back-fills from the template, durability is the instance's.
    expect(item.properties).toEqual({ damage: 3, durability: 12 })
  })

  test('the legacy template key `properties` is used only when defaults are empty', () => {
    expect(
      InventoryItem.fromReference({ item_id: 'x' }, { name: 'X', properties: { legacy: true } })
        .properties,
    ).toEqual({ legacy: true })
    expect(
      InventoryItem.fromReference(
        { item_id: 'x' },
        { name: 'X', default_properties: { modern: true }, properties: { legacy: true } },
      ).properties,
    ).toEqual({ modern: true })
  })

  test('with no template the reference itself carries name and description', () => {
    const item = InventoryItem.fromReference({
      item_id: 'old_thing',
      name: 'Old Thing',
      description: 'Embedded.',
      quantity: 3,
      properties: { worn: true },
    })
    expect(item.name).toBe('Old Thing')
    expect(item.description).toBe('Embedded.')
    expect(item.quantity).toBe(3)
    expect(item.properties).toEqual({ worn: true })
  })

  test('a nameless reference with no template falls back to the id', () => {
    const item = InventoryItem.fromReference({ item_id: 'mystery' })
    expect(item.name).toBe('mystery')
    expect(item.properties).toBeNull()
  })

  test('reference round-trip: toReferenceDict -> fromReference is identity', () => {
    const original = new InventoryItem({
      id: 'rusty_sword',
      name: 'Rusty Sword',
      description: 'Blunt but yours.',
      quantity: 2,
      properties: { damage: 3, durability: 12 },
    })
    const restored = InventoryItem.fromReference(original.toReferenceDict(), template)
    expect(restored.toDict()).toEqual(original.toDict())
  })

  test('round-trip of a property-less item keeps properties null', () => {
    const original = new InventoryItem({ id: 'rope', name: 'Rope', description: null })
    const restored = InventoryItem.fromReference(original.toReferenceDict(), {
      name: 'Rope',
      description: null,
    })
    expect(restored.toDict()).toEqual(original.toDict())
    expect(restored.properties).toBeNull()
  })
})

describe('findInventoryItem', () => {
  const inventory: InventoryEntry[] = [
    { item_id: 'rope', quantity: 1 },
    { id: 'lamp', quantity: 1 },
  ]

  test('matches either id spelling and reports the index', () => {
    expect(findInventoryItem(inventory, 'rope').index).toBe(0)
    expect(findInventoryItem(inventory, 'lamp').index).toBe(1)
  })

  test('a miss returns nulls, not a zero index', () => {
    expect(findInventoryItem(inventory, 'sword')).toEqual({ item: null, index: null })
  })
})

describe('mergeInventoryItem', () => {
  test('stacks onto an existing entry', () => {
    const inventory: InventoryEntry[] = [{ item_id: 'potion', quantity: 2 }]
    const merged = mergeInventoryItem(
      inventory,
      new InventoryItem({ id: 'potion', name: 'Potion', quantity: 3 }),
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.quantity).toBe(5)
    expect(inventory[0]?.quantity).toBe(2) // input untouched
  })

  test('a distinct item is appended in full embedded form', () => {
    const merged = mergeInventoryItem(
      [{ item_id: 'potion', quantity: 2 }],
      new InventoryItem({ id: 'sword', name: 'Sword', properties: { damage: 5 } }),
    )
    expect(merged).toHaveLength(2)
    expect(merged[1]).toEqual({
      item_id: 'sword',
      name: 'Sword',
      description: null,
      quantity: 1,
      properties: { damage: 5 },
    })
  })

  test('a unique item stacks like anything else — there is no non-stacking flag', () => {
    // Two swords land as one entry with quantity 2, not two entries. Worth
    // pinning: it is the behaviour, not an oversight in the test.
    const first = mergeInventoryItem([], new InventoryItem({ id: 'sword', name: 'Sword' }))
    const second = mergeInventoryItem(first, new InventoryItem({ id: 'sword', name: 'Sword' }))
    expect(second).toHaveLength(1)
    expect(second[0]?.quantity).toBe(2)
  })

  test('stacks onto an entry stored under the legacy `id` key', () => {
    const merged = mergeInventoryItem(
      [{ id: 'potion', quantity: 1 }],
      new InventoryItem({ id: 'potion', name: 'Potion', quantity: 1 }),
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.quantity).toBe(2)
  })
})

describe('removeInventoryItem', () => {
  const inventory: InventoryEntry[] = [
    { item_id: 'potion', quantity: 3 },
    { item_id: 'rope', quantity: 1 },
  ]

  test('decrements when some is left', () => {
    const result = removeInventoryItem(inventory, 'potion', 2)
    expect(result.success).toBe(true)
    expect(result.remaining).toBe(1)
    expect(result.inventory[0]?.quantity).toBe(1)
    expect(inventory[0]?.quantity).toBe(3) // input untouched
  })

  test('drops the entry when the last one goes', () => {
    const result = removeInventoryItem(inventory, 'rope', 1)
    expect(result.success).toBe(true)
    expect(result.remaining).toBe(0)
    expect(result.inventory).toHaveLength(1)
    expect(findInventoryItem(result.inventory, 'rope').item).toBeNull()
  })

  test('defaults to removing one', () => {
    expect(removeInventoryItem(inventory, 'potion').remaining).toBe(2)
  })

  test('removing more than held fails without removing any', () => {
    const result = removeInventoryItem(inventory, 'potion', 5)
    expect(result.success).toBe(false)
    // The shortfall reports what is actually held, so the caller can say so.
    expect(result.remaining).toBe(3)
    // And the original list comes back by reference, not a half-applied copy.
    expect(result.inventory).toBe(inventory)
    expect(result.inventory[0]?.quantity).toBe(3)
  })

  test('a missing item fails with remaining 0', () => {
    const result = removeInventoryItem(inventory, 'sword', 1)
    expect(result.success).toBe(false)
    expect(result.remaining).toBe(0)
    expect(result.inventory).toBe(inventory)
  })
})

describe('updateInventoryItemProps', () => {
  test('updates the first match and copies the list', () => {
    const inventory: InventoryEntry[] = [{ item_id: 'lamp', quantity: 1 }]
    const updated = updateInventoryItemProps(inventory, 'lamp', { fuel: 2 })
    expect(updated[0]?.instance_properties).toEqual({ fuel: 2 })
    expect(inventory[0]?.instance_properties).toBeUndefined()
  })

  test('a miss is not an error', () => {
    const updated = updateInventoryItemProps([{ item_id: 'lamp' }], 'sword', { x: 1 })
    expect(updated).toEqual([{ item_id: 'lamp' }])
  })
})

describe('property normalization', () => {
  test('a higher-is-better property is inferred from its name', () => {
    expect(normalizePropertyValue(10, 'damage')).toEqual({ value: 10, higher_is_better: true })
  })

  test('a lower-is-better property is inferred from the inversion set', () => {
    expect(normalizePropertyValue(3, 'weight')).toEqual({ value: 3, higher_is_better: false })
    expect(normalizePropertyValue(5, 'mana_cost')).toEqual({ value: 5, higher_is_better: false })
    // The match is case-insensitive.
    expect(normalizePropertyValue(3, 'Weight').higher_is_better).toBe(false)
  })

  test('every name in the inversion set inverts', () => {
    for (const name of LOWER_IS_BETTER_PROPERTIES) {
      expect(normalizePropertyValue(1, name).higher_is_better).toBe(false)
    }
  })

  test('an already-structured value keeps its own flag', () => {
    expect(normalizePropertyValue({ value: 3, higher_is_better: false }, 'damage')).toEqual({
      value: 3,
      higher_is_better: false,
    })
    // Structured without a flag defaults to true even for a "lower is better" name.
    expect(normalizePropertyValue({ value: 3 }, 'weight')).toEqual({
      value: 3,
      higher_is_better: true,
    })
  })

  test('a dict without a `value` key is treated as a bare value', () => {
    expect(normalizePropertyValue({ min: 1 }, 'damage')).toEqual({
      value: { min: 1 },
      higher_is_better: true,
    })
  })

  test('normalizeProperties maps every entry and tolerates empty input', () => {
    expect(normalizeProperties({ damage: 7, weight: 2 })).toEqual({
      damage: { value: 7, higher_is_better: true },
      weight: { value: 2, higher_is_better: false },
    })
    expect(normalizeProperties(null)).toEqual({})
    expect(normalizeProperties({})).toEqual({})
  })
})

describe('equipItem', () => {
  const inventory: InventoryEntry[] = [
    { item_id: 'rusty_sword', quantity: 1 },
    { item_id: 'shield', quantity: 1 },
    { item_id: 'rope', quantity: 1 },
  ]
  const sword = {
    name: 'Rusty Sword',
    equippable: { slot: 'main_hand', accepts_as: ['weapon'] },
  }
  const shield = { name: 'Shield', equippable: { slot: 'main_hand', accepts_as: ['shield'] } }
  const catalog = { main_hand: { accepts_as: ['weapon'] }, head: { accepts_as: ['helmet'] } }

  test('equips into an empty slot', () => {
    const result = equipItem(inventory, {}, 'rusty_sword', 'main_hand', sword, catalog)
    expect(result.equipment).toEqual({ main_hand: 'rusty_sword' })
    expect(result.unequippedItemId).toBeNull()
    expect(result.message).toBe('Equipped Rusty Sword to main_hand')
  })

  test('an occupied slot swaps and reports the displaced item', () => {
    const equipment: Equipment = { main_hand: 'old_sword' }
    const result = equipItem(inventory, equipment, 'rusty_sword', 'main_hand', sword, catalog)
    expect(result.equipment).toEqual({ main_hand: 'rusty_sword' })
    expect(result.unequippedItemId).toBe('old_sword')
    expect(result.message).toBe('Equipped Rusty Sword to main_hand (unequipped previous)')
    expect(equipment).toEqual({ main_hand: 'old_sword' }) // input untouched
  })

  test('a slot explicitly holding null counts as empty', () => {
    const result = equipItem(
      inventory,
      { main_hand: null },
      'rusty_sword',
      'main_hand',
      sword,
      catalog,
    )
    expect(result.unequippedItemId).toBeNull()
    expect(result.message).toBe('Equipped Rusty Sword to main_hand')
  })

  test('rejects an unknown slot, an unheld item and a non-equippable item', () => {
    expect(equipItem(inventory, {}, 'rusty_sword', 'tail', sword, catalog).message).toBe(
      'Invalid slot: tail',
    )
    expect(equipItem(inventory, {}, 'ghost', 'main_hand', sword, catalog).message).toBe(
      'Item not in inventory: ghost',
    )
    expect(equipItem(inventory, {}, 'rope', 'main_hand', { name: 'Rope' }, catalog).message).toBe(
      'Item is not equippable: rope',
    )
  })

  test('rejects the wrong slot, naming the one the item wants', () => {
    expect(equipItem(inventory, {}, 'rusty_sword', 'head', sword, catalog).message).toBe(
      'Item cannot be equipped to head (requires main_hand)',
    )
    // An equippable block with no slot renders Python's None, not `undefined`.
    expect(
      equipItem(inventory, {}, 'rope', 'head', { equippable: { accepts_as: ['x'] } }, catalog)
        .message,
    ).toBe('Item cannot be equipped to head (requires None)')
  })

  test('rejects an incompatible accepts_as, and returns the original equipment', () => {
    const equipment: Equipment = { main_hand: null }
    const result = equipItem(inventory, equipment, 'shield', 'main_hand', shield, catalog)
    expect(result.message).toBe('Slot main_hand does not accept this item type')
    expect(result.equipment).toBe(equipment)
  })

  test('an empty slot catalog disables slot validation entirely', () => {
    const result = equipItem(inventory, {}, 'shield', 'anywhere', {
      name: 'Shield',
      equippable: { slot: 'anywhere' },
    }, {})
    expect(result.message).toBe('Equipped Shield to anywhere')
  })

  test('accepts_as is only enforced when both sides declare it', () => {
    expect(
      equipItem(inventory, {}, 'shield', 'main_hand', { name: 'Shield', equippable: { slot: 'main_hand' } }, catalog)
        .message,
    ).toBe('Equipped Shield to main_hand')
    expect(
      equipItem(inventory, {}, 'shield', 'main_hand', shield, {
        main_hand: {},
      }).message,
    ).toBe('Equipped Shield to main_hand')
  })

  test('falls back to the item id when the template has no name', () => {
    expect(
      equipItem(inventory, {}, 'rusty_sword', 'main_hand', { equippable: { slot: 'main_hand' } }, catalog)
        .message,
    ).toBe('Equipped rusty_sword to main_hand')
  })
})

describe('unequipSlot', () => {
  test('empties an occupied slot', () => {
    const equipment: Equipment = { main_hand: 'rusty_sword' }
    const result = unequipSlot(equipment, 'main_hand')
    expect(result.equipment).toEqual({ main_hand: null })
    expect(result.unequippedItemId).toBe('rusty_sword')
    expect(result.message).toBe('Unequipped item from main_hand')
    expect(equipment).toEqual({ main_hand: 'rusty_sword' })
  })

  test('an empty or unknown slot is a no-op', () => {
    expect(unequipSlot({ main_hand: null }, 'main_hand').message).toBe('Nothing equipped in main_hand')
    expect(unequipSlot({}, 'head').unequippedItemId).toBeNull()
  })
})

describe('getEquippedPassiveEffects', () => {
  const templates = {
    ring_a: { equippable: { slot: 'ring', passive_effects: { defense: 2, luck: 1 } } },
    ring_b: { equippable: { slot: 'ring', passive_effects: { defense: 3 } } },
    plain: { equippable: { slot: 'ring' } },
  }

  test('sums modifiers across slots', () => {
    expect(
      getEquippedPassiveEffects({ ring_l: 'ring_a', ring_r: 'ring_b' }, templates),
    ).toEqual({ defense: 5, luck: 1 })
  })

  test('empty slots, unknown items and effect-less items contribute nothing', () => {
    expect(
      getEquippedPassiveEffects(
        { a: null, b: 'deleted_template', c: 'plain', d: 'ring_a' },
        templates,
      ),
    ).toEqual({ defense: 2, luck: 1 })
  })
})

describe('checkAffordanceRequirements', () => {
  const stats = { health: 50, stamina: 2 }
  const flags = { has_key: true, cursed: false }
  const inventory: InventoryEntry[] = [{ item_id: 'torch' }]

  test('an affordance with no requirements is always usable', () => {
    expect(checkAffordanceRequirements({}, stats, flags, inventory)).toEqual({
      canUse: true,
      reason: 'No requirements',
    })
    expect(checkAffordanceRequirements({ requirements: {} }, stats, flags, inventory).canUse).toBe(
      true,
    )
  })

  test('stat bounds are inclusive at the boundary', () => {
    const at = { requirements: { stats: { stamina: { min: 2, max: 2 } } } }
    expect(checkAffordanceRequirements(at, stats, flags, inventory).canUse).toBe(true)
  })

  test('a stat below the minimum reports the shortfall', () => {
    expect(
      checkAffordanceRequirements(
        { requirements: { stats: { stamina: { min: 5 } } } },
        stats,
        flags,
        inventory,
      ),
    ).toEqual({ canUse: false, reason: 'Requires stamina >= 5 (current: 2)' })
  })

  test('a stat above the maximum fails, and a missing stat reads as 0', () => {
    expect(
      checkAffordanceRequirements(
        { requirements: { stats: { health: { max: 20 } } } },
        stats,
        flags,
        inventory,
      ).reason,
    ).toBe('Requires health <= 20 (current: 50)')
    expect(
      checkAffordanceRequirements(
        { requirements: { stats: { sanity: { min: 1 } } } },
        stats,
        flags,
        inventory,
      ).reason,
    ).toBe('Requires sanity >= 1 (current: 0)')
  })

  test('flags_all, flags_any and flags_none', () => {
    const check = (requirements: Affordance['requirements']) =>
      checkAffordanceRequirements({ requirements }, stats, flags, inventory)

    expect(check({ flags_all: ['has_key'] }).canUse).toBe(true)
    expect(check({ flags_all: ['has_key', 'cursed'] }).reason).toBe('Requires flag: cursed')
    expect(check({ flags_any: ['cursed', 'has_key'] }).canUse).toBe(true)
    expect(check({ flags_any: ['cursed', 'unknown'] }).reason).toBe(
      'Requires one of: cursed, unknown',
    )
    expect(check({ flags_none: ['cursed'] }).canUse).toBe(true) // false flag is fine
    expect(check({ flags_none: ['has_key'] }).reason).toBe('Cannot have flag: has_key')
    expect(check({ flags_none: ['never_set'] }).canUse).toBe(true) // missing reads false
  })

  test('required items check both id spellings', () => {
    expect(
      checkAffordanceRequirements({ requirements: { items: ['torch'] } }, stats, flags, inventory)
        .canUse,
    ).toBe(true)
    expect(
      checkAffordanceRequirements(
        { requirements: { items: ['lamp'] } },
        stats,
        flags,
        [{ id: 'lamp' }],
      ).canUse,
    ).toBe(true)
    expect(
      checkAffordanceRequirements({ requirements: { items: ['key'] } }, stats, flags, inventory)
        .reason,
    ).toBe('Requires item: key')
  })

  test('the first unmet requirement is the one reported', () => {
    const result = checkAffordanceRequirements(
      { requirements: { stats: { stamina: { min: 9 } }, flags_all: ['nope'] } },
      stats,
      flags,
      inventory,
    )
    expect(result.reason).toBe('Requires stamina >= 9 (current: 2)')
  })
})

describe('applyAffordanceCosts', () => {
  test('an affordance with no cost passes the stats straight through', () => {
    const stats = { stamina: 5 }
    const result = applyAffordanceCosts({}, stats, STAT_DEFS)
    expect(result).toEqual({ stats, success: true, message: 'No costs' })
    expect(result.stats).toBe(stats)
  })

  test('deducts affordable costs', () => {
    const result = applyAffordanceCosts(
      { cost: { stat_changes: [{ stat: 'stamina', delta: -3 }] } },
      { stamina: 5, health: 100 },
      STAT_DEFS,
    )
    expect(result.success).toBe(true)
    expect(result.stats).toEqual({ stamina: 2, health: 100 })
    expect(result.message).toBe('Costs applied')
  })

  test('spending down to exactly the minimum is allowed', () => {
    const result = applyAffordanceCosts(
      { cost: { stat_changes: [{ stat: 'stamina', delta: -5 }] } },
      { stamina: 5 },
      STAT_DEFS,
    )
    expect(result.success).toBe(true)
    expect(result.stats.stamina).toBe(0)
  })

  test('a cost below the minimum fails instead of clamping', () => {
    const stats = { stamina: 2 }
    const result = applyAffordanceCosts(
      { cost: { stat_changes: [{ stat: 'stamina', delta: -5 }] } },
      stats,
      STAT_DEFS,
    )
    expect(result.success).toBe(false)
    expect(result.message).toBe('Not enough stamina (need 5, have 2)')
    expect(result.stats).toBe(stats) // nothing applied
  })

  test('a later unaffordable cost discards the earlier deductions', () => {
    const stats = { stamina: 5, coin: 1 }
    const result = applyAffordanceCosts(
      {
        cost: {
          stat_changes: [
            { stat: 'stamina', delta: -1 },
            { stat: 'health', delta: -500 },
          ],
        },
      },
      { ...stats, health: 10 },
      STAT_DEFS,
    )
    expect(result.success).toBe(false)
    expect(result.stats.stamina).toBe(5)
  })

  test('a stat with no declared minimum can go negative', () => {
    const result = applyAffordanceCosts(
      { cost: { stat_changes: [{ stat: 'coin', delta: -10 }] } },
      { coin: 3 },
      STAT_DEFS,
    )
    expect(result.success).toBe(true)
    expect(result.stats.coin).toBe(-7)
  })

  test('without definitions nothing can be unaffordable', () => {
    const result = applyAffordanceCosts(
      { cost: { stat_changes: [{ stat: 'stamina', delta: -50 }] } },
      { stamina: 1 },
    )
    expect(result.success).toBe(true)
    expect(result.stats.stamina).toBe(-49)
  })

  test('a positive cost still clamps at the maximum', () => {
    const result = applyAffordanceCosts(
      { cost: { stat_changes: [{ stat: 'health', delta: 50 }] } },
      { health: 90 },
      STAT_DEFS,
    )
    expect(result.stats.health).toBe(100)
  })
})

describe('applyAffordanceEffects', () => {
  test('clamps rather than failing, and summarizes the requested deltas', () => {
    const result = applyAffordanceEffects(
      {
        effects: {
          stat_changes: [
            { stat: 'health', delta: 50 },
            { stat: 'stamina', delta: -50 },
          ],
        },
      },
      { health: 90, stamina: 2 },
      {},
      STAT_DEFS,
    )
    expect(result.stats).toEqual({ health: 100, stamina: 0 })
    // The message reports what was asked for, not the clamped outcome.
    expect(result.message).toBe('health +50, stamina -50')
  })

  test('sets flags, rendering booleans the way Python does', () => {
    const flags = { cursed: false }
    const result = applyAffordanceEffects(
      { effects: { set_flags: [{ flag: 'blessed' }, { flag: 'cursed', value: false }] } },
      {},
      flags,
      STAT_DEFS,
    )
    expect(result.flags).toEqual({ cursed: false, blessed: true })
    expect(result.message).toBe('blessed = True, cursed = False')
    expect(flags).toEqual({ cursed: false }) // input untouched
  })

  test('no effects at all', () => {
    const result = applyAffordanceEffects({}, { health: 5 }, { a: true })
    expect(result.message).toBe('No effects')
    expect(result.stats).toEqual({ health: 5 })
    expect(result.flags).toEqual({ a: true })
  })
})

describe('charges and cooldowns', () => {
  const potion: Affordance = { id: 'drink', charges: { max: 3 } }
  const twoPerUse: Affordance = { id: 'blast', charges: { max: 5, consume: 2 } }
  const unlimited: Affordance = { id: 'look' }

  test('an unused item reads as a full bar', () => {
    expect(checkChargesAvailable({}, potion)).toEqual({
      hasCharges: true,
      charges: 3,
      message: '3 charges remaining',
    })
  })

  test('an affordance without a charge limit reports -1', () => {
    expect(checkChargesAvailable({}, unlimited)).toEqual({
      hasCharges: true,
      charges: -1,
      message: 'Unlimited uses',
    })
  })

  test('each use consumes, and the store is keyed per affordance', () => {
    let props: Record<string, unknown> = {}
    props = updateChargesAndCooldown(props, potion)
    expect(props).toEqual({ charges_drink: 2 })
    props = updateChargesAndCooldown(props, potion)
    props = updateChargesAndCooldown(props, potion)
    expect(props.charges_drink).toBe(0)
  })

  test('exhaustion: the last charge works, the next does not', () => {
    expect(checkChargesAvailable({ charges_drink: 1 }, potion).hasCharges).toBe(true)
    expect(checkChargesAvailable({ charges_drink: 0 }, potion)).toEqual({
      hasCharges: false,
      charges: 0,
      message: 'No charges remaining (0/3)',
    })
  })

  test('a multi-charge cost needs the full amount, and never goes below zero', () => {
    expect(checkChargesAvailable({ charges_blast: 2 }, twoPerUse).hasCharges).toBe(true)
    expect(checkChargesAvailable({ charges_blast: 1 }, twoPerUse)).toEqual({
      hasCharges: false,
      charges: 1,
      message: 'No charges remaining (1/5)',
    })
    expect(updateChargesAndCooldown({ charges_blast: 1 }, twoPerUse).charges_blast).toBe(0)
  })

  test('an affordance with no id shares the `default` key', () => {
    expect(updateChargesAndCooldown({}, { charges: { max: 2 } })).toEqual({ charges_default: 1 })
  })

  test('a never-used affordance is off cooldown', () => {
    expect(checkCooldownReady({}, potion, 10)).toEqual({ ready: true, message: 'Ready' })
  })

  test('a use records an expiry in the declared time domain', () => {
    const props = updateChargesAndCooldown(
      {},
      { id: 'blast', cooldown: { domain: 'turn', value: 3 } },
      7,
    )
    expect(props.cooldown_blast).toEqual({ domain: 'turn', expires_at: 10 })
  })

  test('no cooldown is written without a current domain value', () => {
    const affordance: Affordance = { id: 'blast', cooldown: { domain: 'turn', value: 3 } }
    expect(updateChargesAndCooldown({}, affordance)).toEqual({})
    expect(updateChargesAndCooldown({}, affordance, null)).toEqual({})
  })

  test('a zero-length cooldown is not recorded at all', () => {
    expect(
      updateChargesAndCooldown({}, { id: 'blast', cooldown: { domain: 'turn', value: 0 } }, 7),
    ).toEqual({})
  })

  test('cooldown boundary: ready exactly at the expiry turn', () => {
    const affordance: Affordance = { id: 'blast' }
    const props = { cooldown_blast: { domain: 'turn', expires_at: 10 } }
    expect(checkCooldownReady(props, affordance, 9)).toEqual({
      ready: false,
      message: 'On cooldown (1 turns remaining)',
    })
    expect(checkCooldownReady(props, affordance, 10)).toEqual({ ready: true, message: 'Ready' })
    expect(checkCooldownReady(props, affordance, 11).ready).toBe(true)
  })

  test('the stored domain names the unit in the message', () => {
    expect(
      checkCooldownReady(
        { cooldown_blast: { domain: 'day', expires_at: 5 } },
        { id: 'blast' },
        2,
      ).message,
    ).toBe('On cooldown (3 days remaining)')
  })

  test('a malformed cooldown entry reads as ready rather than throwing', () => {
    expect(checkCooldownReady({ cooldown_blast: 'yesterday' }, { id: 'blast' }, 1).ready).toBe(true)
  })
})
