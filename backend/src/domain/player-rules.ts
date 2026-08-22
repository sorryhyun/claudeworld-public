/**
 * Pure domain rules for player state. CRUD (DB) and PlayerService (filesystem)
 * both call in here so the two persistence paths cannot drift. Record shapes
 * keep snake_case keys because they are the stored JSON and YAML.
 */

export interface StatDefinition {
  name: string
  min?: number | null
  max?: number | null
  default?: number | null
  [key: string]: unknown
}

export interface StatDefinitions {
  stats?: StatDefinition[]
  [key: string]: unknown
}

export type StatMap = Record<string, StatDefinition>

/**
 * One inventory entry, in either the reference format (`item_id` +
 * `instance_properties`) or the legacy embedded one — so every reader here
 * checks both spellings of the id.
 */
export interface InventoryEntry {
  id?: string
  item_id?: string
  name?: string
  description?: string | null
  quantity?: number
  properties?: Record<string, unknown> | null
  instance_properties?: Record<string, unknown> | null
  [key: string]: unknown
}

export interface Equippable {
  slot?: string
  accepts_as?: string[]
  passive_effects?: Record<string, number>
  [key: string]: unknown
}

/** An item template as stored in `worlds/<world>/items/<item_id>.json`. */
export interface ItemTemplate {
  id?: string
  name?: string
  description?: string | null
  properties?: Record<string, unknown> | null
  default_properties?: Record<string, unknown> | null
  equippable?: Equippable | null
  [key: string]: unknown
}

export interface SlotDefinition {
  accepts_as?: string[]
  [key: string]: unknown
}

/** `slot name -> slot definition`. An empty catalog disables slot validation. */
export type SlotCatalog = Record<string, SlotDefinition>

/** `slot name -> equipped item id`, `null` when the slot is empty. */
export type Equipment = Record<string, string | null>

export interface StatBounds {
  min?: number | null
  max?: number | null
  [key: string]: unknown
}

export interface AffordanceRequirements {
  stats?: Record<string, StatBounds>
  flags_all?: string[]
  flags_any?: string[]
  flags_none?: string[]
  items?: string[]
  [key: string]: unknown
}

export interface StatChangeSpec {
  stat?: string
  delta?: number
  [key: string]: unknown
}

/** One `set_flags` entry. `value` defaults to true when omitted. */
export interface FlagChangeSpec {
  flag?: string
  value?: boolean
  [key: string]: unknown
}

export interface Affordance {
  id?: string
  requirements?: AffordanceRequirements | null
  cost?: { stat_changes?: StatChangeSpec[]; [key: string]: unknown } | null
  effects?: {
    stat_changes?: StatChangeSpec[]
    set_flags?: FlagChangeSpec[]
    [key: string]: unknown
  } | null
  charges?: { max?: number | null; consume?: number; [key: string]: unknown } | null
  cooldown?: { domain?: string; value?: number; [key: string]: unknown } | null
  [key: string]: unknown
}

export interface NormalizedProperty {
  value: unknown
  higher_is_better: boolean
}

/** An empty object or array counts as empty; several branches turn on this. */
function isNonEmpty(value: Record<string, unknown> | unknown[] | null | undefined): boolean {
  if (value === null || value === undefined) return false
  return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Messages built here are shown to agents and players verbatim and must keep
// rendering `None`/`True`/`False` rather than `undefined`/`true`/`false`.
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  return String(value)
}

export interface InventoryItemFields {
  id: string
  name: string
  description?: string | null
  quantity?: number
  properties?: Record<string, unknown> | null
}

/** An inventory item, in either storage format. */
export class InventoryItem {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly quantity: number
  readonly properties: Record<string, unknown> | null

  constructor(fields: InventoryItemFields) {
    this.id = fields.id
    this.name = fields.name
    this.description = fields.description ?? null
    this.quantity = fields.quantity ?? 1
    this.properties = fields.properties ?? null
  }

  /** The embedded format — all five keys — as sent to the frontend and stored. */
  toDict(): InventoryEntry {
    return {
      item_id: this.id,
      name: this.name,
      description: this.description,
      quantity: this.quantity,
      properties: this.properties ?? {},
    }
  }

  /**
   * The reference format `player.json` persists — deliberately not
   * {@link toDict}'s key set: name and description live in the item template and
   * duplicating them here would shadow an edit with a stale copy.
   */
  toReferenceDict(): InventoryEntry {
    const result: InventoryEntry = {
      item_id: this.id,
      quantity: this.quantity,
    }
    if (isNonEmpty(this.properties)) {
      result.instance_properties = this.properties
    }
    return result
  }

  /** Either id spelling; `id` wins, and a *non-empty* `properties` wins. */
  static fromDict(data: InventoryEntry): InventoryItem {
    return new InventoryItem({
      id: data.id || data.item_id || '',
      name: data.name ?? '',
      description: data.description ?? null,
      quantity: data.quantity ?? 1,
      properties: (isNonEmpty(data.properties) ? data.properties : null) ?? data.instance_properties ?? null,
    })
  }

  /**
   * Reference format with a template merged underneath: template defaults first,
   * instance properties on top, so a new default back-fills existing instances.
   * `properties` is the older `default_properties` and is read only if it is empty.
   */
  static fromReference(refData: InventoryEntry, template?: ItemTemplate | null): InventoryItem {
    const itemId = refData.item_id || refData.id || ''
    const quantity = refData.quantity ?? 1
    const instanceProps =
      (isNonEmpty(refData.instance_properties) ? refData.instance_properties : null) ??
      (isNonEmpty(refData.properties) ? refData.properties : null) ??
      {}

    if (template) {
      const defaultProps =
        (isNonEmpty(template.default_properties) ? template.default_properties : null) ??
        (isNonEmpty(template.properties) ? template.properties : null) ??
        {}
      const mergedProps = { ...defaultProps, ...instanceProps }

      return new InventoryItem({
        id: itemId,
        // A template with a null name is malformed; show the id, not a null.
        name: template.name ?? itemId,
        description: template.description ?? null,
        quantity,
        properties: isNonEmpty(mergedProps) ? mergedProps : null,
      })
    }

    return new InventoryItem({
      id: itemId,
      name: refData.name ?? itemId,
      description: refData.description ?? null,
      quantity,
      properties: isNonEmpty(instanceProps) ? instanceProps : null,
    })
  }
}

/** Throws on a nameless definition: dropping it would let values drift unbounded. */
export function buildStatMap(statDefinitions: StatDefinitions | null | undefined): StatMap {
  if (!statDefinitions) return {}

  const statMap: StatMap = {}
  for (const stat of statDefinitions.stats ?? []) {
    if (typeof stat?.name !== 'string') {
      throw new TypeError('stat definition is missing a "name"')
    }
    statMap[stat.name] = stat
  }
  return statMap
}

/**
 * Clamp a stat to its declared bounds. An undefined stat comes back untouched —
 * unbounded, not zeroed — which is what ad-hoc agent-invented stats rely on.
 */
export function clampStatValue(value: number, statName: string, statMap: StatMap): number {
  const statDef = statMap[statName]
  if (!statDef) return value

  let clamped = value
  if (statDef.min !== null && statDef.min !== undefined) clamped = Math.max(statDef.min, clamped)
  if (statDef.max !== null && statDef.max !== undefined) clamped = Math.min(statDef.max, clamped)
  return clamped
}

/** Apply `name -> delta` changes, clamping each. A missing stat starts at 0. */
export function applyStatChanges(
  currentStats: Record<string, number>,
  changes: Record<string, number>,
  statDefinitions?: StatDefinitions | null,
): Record<string, number> {
  const statMap = buildStatMap(statDefinitions)
  const newStats: Record<string, number> = { ...currentStats }

  for (const [statName, change] of Object.entries(changes)) {
    const oldValue = newStats[statName] ?? 0
    newStats[statName] = clampStatValue(oldValue + change, statName, statMap)
  }

  return newStats
}

/**
 * Starting stats: each declared `default` (0 if absent), then overrides on top.
 * Overrides are *not* clamped and may introduce undeclared stats.
 */
export function initializeStatsFromDefinitions(
  statDefinitions: StatDefinitions,
  initialOverrides?: Record<string, number> | null,
): Record<string, number> {
  const stats: Record<string, number> = {}
  for (const stat of statDefinitions.stats ?? []) {
    if (typeof stat?.name !== 'string') {
      throw new TypeError('stat definition is missing a "name"')
    }
    stats[stat.name] = stat.default ?? 0
  }

  if (initialOverrides) {
    Object.assign(stats, initialOverrides)
  }

  return stats
}

/** Both fields are null when not found. */
export interface FoundInventoryItem {
  /** The live entry from the passed list, not a copy — callers mutate it. */
  item: InventoryEntry | null
  index: number | null
}

/** Find an item by id, accepting either the `id` or the `item_id` spelling. */
export function findInventoryItem(
  inventory: InventoryEntry[],
  itemId: string,
): FoundInventoryItem {
  for (const [idx, item] of inventory.entries()) {
    if (item.id === itemId || item.item_id === itemId) {
      return { item, index: idx }
    }
  }
  return { item: null, index: null }
}

/**
 * Add an item, stacking onto an entry of the same id — everything stacks, there
 * is no `stackable` flag. Shallow-copied, so nested `properties` stay shared.
 */
export function mergeInventoryItem(
  inventory: InventoryEntry[],
  item: InventoryItem,
): InventoryEntry[] {
  const newInventory = inventory.map((entry) => ({ ...entry }))

  const { item: existing } = findInventoryItem(newInventory, item.id)
  if (existing !== null) {
    existing.quantity = (existing.quantity ?? 0) + item.quantity
  } else {
    newInventory.push(item.toDict())
  }

  return newInventory
}

export interface RemoveInventoryResult {
  /** On failure this is the *original* array, unchanged and not copied. */
  inventory: InventoryEntry[]
  success: boolean
  /** Quantity left afterwards; on a shortfall, the quantity actually held. */
  remaining: number
}

/**
 * Remove `quantity`, dropping the entry at zero. Removing more than is held
 * fails outright — a partial consume would look like the whole cost was paid.
 */
export function removeInventoryItem(
  inventory: InventoryEntry[],
  itemId: string,
  quantity = 1,
): RemoveInventoryResult {
  const newInventory = inventory.map((entry) => ({ ...entry }))

  const { item: existing, index } = findInventoryItem(newInventory, itemId)
  if (existing === null || index === null) {
    return { inventory, success: false, remaining: 0 }
  }

  const currentQuantity = existing.quantity ?? 0
  if (currentQuantity < quantity) {
    return { inventory, success: false, remaining: currentQuantity }
  }

  const remaining = currentQuantity - quantity
  if (remaining <= 0) {
    newInventory.splice(index, 1)
    return { inventory: newInventory, success: true, remaining: 0 }
  }

  existing.quantity = remaining
  return { inventory: newInventory, success: true, remaining }
}

/** Replace one item's `instance_properties`. A miss is not an error. */
export function updateInventoryItemProps(
  inventory: InventoryEntry[],
  itemId: string,
  newProps: Record<string, unknown>,
): InventoryEntry[] {
  const newInventory = inventory.map((entry) => ({ ...entry }))

  for (const item of newInventory) {
    if (item.item_id === itemId || item.id === itemId) {
      item.instance_properties = newProps
      break
    }
  }

  return newInventory
}

/** Lower-is-better property names, matched case-insensitively; the default is the opposite. */
export const LOWER_IS_BETTER_PROPERTIES: ReadonlySet<string> = new Set([
  'weight',
  'cursed_level',
  'corruption',
  'decay',
  'fragility',
  'cooldown',
  'cost',
  'mana_cost',
  'stamina_cost',
])

/**
 * An already-structured `{value: ...}` keeps its own `higher_is_better`,
 * overriding the guess made from {@link LOWER_IS_BETTER_PROPERTIES}.
 */
export function normalizePropertyValue(prop: unknown, propName = ''): NormalizedProperty {
  if (isRecord(prop) && 'value' in prop) {
    return {
      value: prop.value,
      higher_is_better: 'higher_is_better' in prop ? Boolean(prop.higher_is_better) : true,
    }
  }

  return {
    value: prop,
    higher_is_better: !LOWER_IS_BETTER_PROPERTIES.has(propName.toLowerCase()),
  }
}

/** Normalize every property in a dict. Null and `{}` both give `{}`. */
export function normalizeProperties(
  properties: Record<string, unknown> | null | undefined,
): Record<string, NormalizedProperty> {
  if (!properties || !isNonEmpty(properties)) return {}

  const normalized: Record<string, NormalizedProperty> = {}
  for (const [name, value] of Object.entries(properties)) {
    normalized[name] = normalizePropertyValue(value, name)
  }
  return normalized
}

export interface EquipResult {
  /** On failure this is the *original* equipment object, unchanged. */
  equipment: Equipment
  unequippedItemId: string | null
  /** Human-readable outcome, shown to the player verbatim. */
  message: string
}

/**
 * Validation order is the order the player sees blame in: slot exists, item
 * held, item equippable, item declares this slot, then type compatibility.
 * Failures come back in `message`, not thrown. An empty `slotCatalog` skips slot
 * validation, and `accepts_as` is enforced only when both sides declare it.
 */
export function equipItem(
  inventory: InventoryEntry[],
  equipment: Equipment,
  itemId: string,
  slot: string,
  itemTemplate: ItemTemplate,
  slotCatalog: SlotCatalog,
): EquipResult {
  if (isNonEmpty(slotCatalog) && !(slot in slotCatalog)) {
    return { equipment, unequippedItemId: null, message: `Invalid slot: ${slot}` }
  }

  const itemInInventory = inventory.some((inv) => inv.item_id === itemId || inv.id === itemId)
  if (!itemInInventory) {
    return { equipment, unequippedItemId: null, message: `Item not in inventory: ${itemId}` }
  }

  const equippable: Equippable = itemTemplate.equippable ?? {}
  if (!isNonEmpty(equippable)) {
    return { equipment, unequippedItemId: null, message: `Item is not equippable: ${itemId}` }
  }

  const itemSlot = equippable.slot
  if (itemSlot !== slot) {
    return {
      equipment,
      unequippedItemId: null,
      message: `Item cannot be equipped to ${slot} (requires ${pyStr(itemSlot)})`,
    }
  }

  if (isNonEmpty(slotCatalog)) {
    const slotAccepts = slotCatalog[slot]?.accepts_as ?? []
    const itemAcceptsAs = equippable.accepts_as ?? []

    if (isNonEmpty(slotAccepts) && isNonEmpty(itemAcceptsAs)) {
      if (!itemAcceptsAs.some((type) => slotAccepts.includes(type))) {
        return {
          equipment,
          unequippedItemId: null,
          message: `Slot ${slot} does not accept this item type`,
        }
      }
    }
  }

  // Occupied slots swap; the displaced id comes back so the caller stows it.
  const newEquipment: Equipment = { ...equipment }
  const unequippedId = newEquipment[slot] ?? null
  newEquipment[slot] = itemId

  const itemName = itemTemplate.name ?? itemId
  return unequippedId
    ? {
        equipment: newEquipment,
        unequippedItemId: unequippedId,
        message: `Equipped ${itemName} to ${slot} (unequipped previous)`,
      }
    : {
        equipment: newEquipment,
        unequippedItemId: null,
        message: `Equipped ${itemName} to ${slot}`,
      }
}

/** Empty a slot. An already-empty slot is a no-op, reported in the message. */
export function unequipSlot(equipment: Equipment, slot: string): EquipResult {
  const unequippedId = equipment[slot] ?? null

  if (!unequippedId) {
    return { equipment, unequippedItemId: null, message: `Nothing equipped in ${slot}` }
  }

  const newEquipment: Equipment = { ...equipment }
  newEquipment[slot] = null
  return {
    equipment: newEquipment,
    unequippedItemId: unequippedId,
    message: `Unequipped item from ${slot}`,
  }
}

/** An id with no template contributes nothing, degrading the bonus not the turn. */
export function getEquippedPassiveEffects(
  equipment: Equipment,
  itemTemplates: Record<string, ItemTemplate>,
): Record<string, number> {
  const totalEffects: Record<string, number> = {}

  for (const itemId of Object.values(equipment)) {
    if (!itemId) continue

    const passiveEffects = itemTemplates[itemId]?.equippable?.passive_effects ?? {}
    for (const [stat, modifier] of Object.entries(passiveEffects)) {
      totalEffects[stat] = (totalEffects[stat] ?? 0) + modifier
    }
  }

  return totalEffects
}

export interface RequirementCheck {
  canUse: boolean
  /** Why — the first unmet requirement, or a confirmation when all are met. */
  reason: string
}

/**
 * Returns on the first failure so the reason names one blocker. Missing stats
 * read as 0 and missing flags as false.
 */
export function checkAffordanceRequirements(
  affordance: Affordance,
  currentStats: Record<string, number>,
  flags: Record<string, boolean>,
  inventory: InventoryEntry[],
): RequirementCheck {
  const requirements = affordance.requirements ?? {}

  if (!isNonEmpty(requirements)) {
    return { canUse: true, reason: 'No requirements' }
  }

  for (const [statName, bounds] of Object.entries(requirements.stats ?? {})) {
    const currentValue = currentStats[statName] ?? 0
    const { min, max } = bounds

    if (min !== null && min !== undefined && currentValue < min) {
      return { canUse: false, reason: `Requires ${statName} >= ${min} (current: ${currentValue})` }
    }
    if (max !== null && max !== undefined && currentValue > max) {
      return { canUse: false, reason: `Requires ${statName} <= ${max} (current: ${currentValue})` }
    }
  }

  for (const flag of requirements.flags_all ?? []) {
    if (!flags[flag]) return { canUse: false, reason: `Requires flag: ${flag}` }
  }

  const flagsAny = requirements.flags_any ?? []
  if (isNonEmpty(flagsAny) && !flagsAny.some((flag) => flags[flag])) {
    return { canUse: false, reason: `Requires one of: ${flagsAny.join(', ')}` }
  }

  for (const flag of requirements.flags_none ?? []) {
    if (flags[flag]) return { canUse: false, reason: `Cannot have flag: ${flag}` }
  }

  const inventoryIds = new Set(inventory.map((inv) => inv.item_id || inv.id))
  for (const itemId of requirements.items ?? []) {
    if (!inventoryIds.has(itemId)) {
      return { canUse: false, reason: `Requires item: ${itemId}` }
    }
  }

  return { canUse: true, reason: 'Requirements met' }
}

export interface AffordanceCostResult {
  /** On failure this is the *original* stats object: costs are all-or-nothing. */
  stats: Record<string, number>
  success: boolean
  message: string
}

/**
 * Unlike {@link applyAffordanceEffects}, a cost pushing a stat below its minimum
 * *fails* instead of clamping — clamping would let the player cast a spell they
 * cannot pay for. The maximum still clamps, a stat with no minimum can go
 * negative, and costs are all-or-nothing.
 */
export function applyAffordanceCosts(
  affordance: Affordance,
  currentStats: Record<string, number>,
  statDefinitions?: StatDefinitions | null,
): AffordanceCostResult {
  const statChanges = affordance.cost?.stat_changes ?? []

  if (!isNonEmpty(statChanges)) {
    return { stats: currentStats, success: true, message: 'No costs' }
  }

  const statMap = buildStatMap(statDefinitions)
  const newStats: Record<string, number> = { ...currentStats }

  for (const change of statChanges) {
    // A nameless change is dropped rather than written under a null key.
    const statName = change.stat
    if (typeof statName !== 'string') continue
    const delta = change.delta ?? 0

    const currentValue = newStats[statName] ?? 0
    let newValue = currentValue + delta

    const statDef = statMap[statName]
    const min = statDef?.min
    const max = statDef?.max

    if (min !== null && min !== undefined && newValue < min) {
      return {
        stats: currentStats,
        success: false,
        message: `Not enough ${statName} (need ${Math.abs(delta)}, have ${currentValue})`,
      }
    }

    if (max !== null && max !== undefined) newValue = Math.min(newValue, max)

    newStats[statName] = newValue
  }

  return { stats: newStats, success: true, message: 'Costs applied' }
}

export interface AffordanceEffectResult {
  stats: Record<string, number>
  flags: Record<string, boolean>
  /** A comma-joined summary of what changed, for the narration prompt. */
  message: string
}

/** Effects clamp at both bounds and cannot fail, unlike {@link applyAffordanceCosts}. */
export function applyAffordanceEffects(
  affordance: Affordance,
  currentStats: Record<string, number>,
  flags: Record<string, boolean>,
  statDefinitions?: StatDefinitions | null,
): AffordanceEffectResult {
  const effects = affordance.effects ?? {}

  const statMap = buildStatMap(statDefinitions)
  const newStats: Record<string, number> = { ...currentStats }
  const newFlags: Record<string, boolean> = { ...flags }
  const effectMessages: string[] = []

  for (const change of effects.stat_changes ?? []) {
    const statName = change.stat
    if (typeof statName !== 'string') continue
    const delta = change.delta ?? 0

    let newValue = (newStats[statName] ?? 0) + delta

    const statDef = statMap[statName]
    const min = statDef?.min
    const max = statDef?.max
    if (min !== null && min !== undefined) newValue = Math.max(newValue, min)
    if (max !== null && max !== undefined) newValue = Math.min(newValue, max)

    newStats[statName] = newValue

    // The requested delta, not the clamped result: "health +50" after a +10 cap.
    const sign = delta > 0 ? '+' : ''
    effectMessages.push(`${statName} ${sign}${delta}`)
  }

  for (const flagChange of effects.set_flags ?? []) {
    const flagName = flagChange.flag
    if (typeof flagName !== 'string') continue
    const flagValue = flagChange.value ?? true
    newFlags[flagName] = flagValue
    effectMessages.push(`${flagName} = ${pyStr(flagValue)}`)
  }

  const message = isNonEmpty(effectMessages) ? effectMessages.join(', ') : 'No effects'
  return { stats: newStats, flags: newFlags, message }
}

/**
 * Charges and cooldowns are keyed per affordance (`charges_<id>`,
 * `cooldown_<id>`) in one flat dict; no `id` means `default`. A cooldown needs a
 * domain, a non-zero value and a known `timeDomainValue`.
 */
export function updateChargesAndCooldown(
  instanceProperties: Record<string, unknown>,
  affordance: Affordance,
  timeDomainValue?: number | null,
): Record<string, unknown> {
  const newProps: Record<string, unknown> = { ...instanceProperties }
  const affordanceId = affordance.id ?? 'default'

  const chargesConfig = affordance.charges ?? {}
  const maxCharges = chargesConfig.max
  if (maxCharges !== null && maxCharges !== undefined) {
    const chargesKey = `charges_${affordanceId}`
    // Unused (or malformed) reads as a full bar rather than failing the turn.
    const stored = newProps[chargesKey]
    const currentCharges = typeof stored === 'number' ? stored : maxCharges
    const consume = chargesConfig.consume ?? 1
    newProps[chargesKey] = Math.max(0, currentCharges - consume)
  }

  const cooldownConfig = affordance.cooldown ?? {}
  const domain = cooldownConfig.domain
  const value = cooldownConfig.value
  if (domain && value && timeDomainValue !== null && timeDomainValue !== undefined) {
    newProps[`cooldown_${affordanceId}`] = { domain, expires_at: timeDomainValue + value }
  }

  return newProps
}

export interface CooldownCheck {
  ready: boolean
  message: string
}

/** A missing entry means never used. The entry carries its own time domain. */
export function checkCooldownReady(
  instanceProperties: Record<string, unknown>,
  affordance: Affordance,
  currentDomainValue: number,
): CooldownCheck {
  const affordanceId = affordance.id ?? 'default'
  const cooldownData = instanceProperties[`cooldown_${affordanceId}`]

  if (!cooldownData) return { ready: true, message: 'Ready' }
  if (!isRecord(cooldownData)) {
    // Malformed reads as "no cooldown recorded", not a failed turn.
    return { ready: true, message: 'Ready' }
  }

  const expiresAt = typeof cooldownData.expires_at === 'number' ? cooldownData.expires_at : 0
  const domain = typeof cooldownData.domain === 'string' ? cooldownData.domain : 'turn'

  if (currentDomainValue >= expiresAt) return { ready: true, message: 'Ready' }

  const remaining = expiresAt - currentDomainValue
  return { ready: false, message: `On cooldown (${remaining} ${domain}s remaining)` }
}

export interface ChargesCheck {
  hasCharges: boolean
  /** Charges left, or -1 for an affordance with no charge limit. */
  charges: number
  message: string
}

/** Without `charges.max` an affordance is unlimited and reports -1, so test `hasCharges`. */
export function checkChargesAvailable(
  instanceProperties: Record<string, unknown>,
  affordance: Affordance,
): ChargesCheck {
  const chargesConfig = affordance.charges ?? {}
  const maxCharges = chargesConfig.max

  if (maxCharges === null || maxCharges === undefined) {
    return { hasCharges: true, charges: -1, message: 'Unlimited uses' }
  }

  const affordanceId = affordance.id ?? 'default'
  const stored = instanceProperties[`charges_${affordanceId}`]
  const currentCharges = typeof stored === 'number' ? stored : maxCharges
  const consume = chargesConfig.consume ?? 1

  if (currentCharges >= consume) {
    return {
      hasCharges: true,
      charges: currentCharges,
      message: `${currentCharges} charges remaining`,
    }
  }
  return {
    hasCharges: false,
    charges: currentCharges,
    message: `No charges remaining (${currentCharges}/${maxCharges})`,
  }
}
