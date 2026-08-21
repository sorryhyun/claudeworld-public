/**
 * Domain rules for player state mutations — port of
 * `backend/domain/services/player_rules.py`.
 *
 * Pure functions for stat clamping, inventory management, equipment and item
 * affordances. No database, no filesystem, no async: CRUD (DB) and
 * PlayerService (filesystem) both call in here so the two persistence paths
 * cannot drift apart.
 *
 * Two conventions run through the whole file:
 *
 * - **The record shapes keep snake_case keys.** They are not TS domain objects,
 *   they are the JSON blobs in `player_states.{stats,inventory}` and the YAML in
 *   `worlds/<world>/{player,items}/*.yaml`, and the Python backend reads the
 *   same bytes. Only the function *returns* invented by this port (the objects
 *   replacing Python's tuples) use camelCase.
 * - **Python's empty-collection falsiness is explicit.** `if not properties:` is
 *   true for `{}` in Python and false for `{}` in JS, and several branches here
 *   turn on exactly that. `isNonEmpty()` marks every such site.
 *
 * Python returns tuples from nine of these functions; TypeScript gets named
 * objects instead. Positional tuple destructuring at a call site is the kind of
 * thing that silently swaps two values of the same type, and `success`/`ready`
 * booleans sitting next to id strings is precisely that hazard.
 */

// =============================================================================
// Shapes
// =============================================================================

/** A stat as declared in the world's stat definitions. */
export interface StatDefinition {
  name: string
  min?: number | null
  max?: number | null
  default?: number | null
  [key: string]: unknown
}

/** The world's `stat_definitions` blob: a `stats` list plus display metadata. */
export interface StatDefinitions {
  stats?: StatDefinition[]
  [key: string]: unknown
}

/** `stat name -> definition`, as built by {@link buildStatMap}. */
export type StatMap = Record<string, StatDefinition>

/**
 * One entry of the inventory list.
 *
 * Both historical formats live in this type: the reference format
 * (`item_id` + `instance_properties`) that `player.yaml` writes today, and the
 * legacy embedded format (`id`/`item_id` plus the full item data) still present
 * in older worlds. Every reader here checks both spellings of the id.
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

/** The `equippable` block of an item template. */
export interface Equippable {
  slot?: string
  accepts_as?: string[]
  passive_effects?: Record<string, number>
  [key: string]: unknown
}

/** An item template as stored in `worlds/<world>/items/<item_id>.yaml`. */
export interface ItemTemplate {
  id?: string
  name?: string
  description?: string | null
  properties?: Record<string, unknown> | null
  default_properties?: Record<string, unknown> | null
  equippable?: Equippable | null
  [key: string]: unknown
}

/** One slot in the world's slot catalog. */
export interface SlotDefinition {
  accepts_as?: string[]
  [key: string]: unknown
}

/** `slot name -> slot definition`. An empty catalog disables slot validation. */
export type SlotCatalog = Record<string, SlotDefinition>

/** `slot name -> equipped item id`, `null` when the slot is empty. */
export type Equipment = Record<string, string | null>

/** A `{min, max}` bound in an affordance requirement. */
export interface StatBounds {
  min?: number | null
  max?: number | null
  [key: string]: unknown
}

/** The `requirements` block of an affordance. */
export interface AffordanceRequirements {
  stats?: Record<string, StatBounds>
  flags_all?: string[]
  flags_any?: string[]
  flags_none?: string[]
  items?: string[]
  [key: string]: unknown
}

/** One `stat_changes` entry: a delta applied to a named stat. */
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

/** An item affordance — a thing the item lets the player do. */
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

/** A property value carrying the metadata the UI needs to compare two items. */
export interface NormalizedProperty {
  value: unknown
  higher_is_better: boolean
}

// =============================================================================
// Local helpers
// =============================================================================

/**
 * Python truthiness for a collection: `{}` and `[]` are falsy there, truthy
 * here. Every `if not <collection>` branch in the source goes through this.
 */
function isNonEmpty(value: Record<string, unknown> | unknown[] | null | undefined): boolean {
  if (value === null || value === undefined) return false
  return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0
}

/** Whether a value is a plain JSON object, i.e. what Python calls a `dict`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Render a value the way Python's f-string interpolation would.
 *
 * The messages these functions return are shown to agents and players verbatim,
 * and the Python backend can still produce them for the same world, so `None`,
 * `True` and `False` have to survive the port rather than turning into
 * `undefined`, `true` and `false`.
 */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  return String(value)
}

// =============================================================================
// InventoryItem
// =============================================================================

/** Constructor fields for {@link InventoryItem}, mirroring the dataclass. */
export interface InventoryItemFields {
  id: string
  name: string
  description?: string | null
  quantity?: number
  properties?: Record<string, unknown> | null
}

/**
 * Domain representation of an inventory item.
 *
 * Supports both the reference-based format (`item_id` + `instance_properties`)
 * and the legacy embedded format (full item data in `player.yaml`).
 */
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

  /**
   * Serialize to the legacy embedded format: every field, always all five keys.
   *
   * This is what the API returns to the frontend and what the DB inventory blob
   * holds. `properties` is normalised to `{}` rather than left null, matching
   * Python's `self.properties or {}`.
   */
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
   * Serialize to the reference format `player.yaml` persists.
   *
   * Deliberately *not* the same key set as {@link toDict}: only `item_id` and
   * `quantity`, plus `instance_properties` when there is something to store.
   * Name and description live in `items/<item_id>.yaml` and must not be
   * duplicated into the player file, or an edited template would be shadowed by
   * a stale copy. The `instance_properties` key is omitted entirely for empty
   * properties (Python's `if self.properties:`), not written as `{}`.
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

  /**
   * Build from a dictionary in either id spelling.
   *
   * `id` wins over `item_id`, and `properties` over `instance_properties` — but
   * only when non-empty, because Python chains these with `or`, so an empty
   * `properties` falls through to `instance_properties`.
   */
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
   * Build from the reference format, merging an item template underneath it.
   *
   * Merge precedence: template defaults first, instance properties over the top,
   * so a per-instance durability overrides the template's default durability and
   * a template gaining a new default property back-fills existing instances.
   * `default_properties` is the modern template key; `properties` is the older
   * one and is only consulted when `default_properties` is empty.
   *
   * With no template this is the legacy path, where `player.yaml` carried the
   * whole item: name and description come from the reference itself.
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
        // Python's `template.get("name", item_id)` keeps an explicit `name: null`
        // as None; `??` falls back to the id instead. A template with a null name
        // is malformed either way, and a visible id beats a null in the UI.
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

// =============================================================================
// Stats
// =============================================================================

/**
 * Build the `stat name -> definition` lookup used for clamping.
 *
 * A definition without a `name` throws, as Python's `stat["name"]` raises
 * KeyError: a stat that cannot be addressed by name can never be clamped, and
 * silently dropping it would let values drift past their bounds unnoticed.
 */
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
 * Clamp a stat value to its declared bounds.
 *
 * A stat with no definition is returned untouched — unbounded, not clamped to
 * zero. Ad-hoc stats invented mid-game by an agent take this path, and so does
 * every stat when the caller passes no definitions at all. Each bound is
 * independent: a stat may declare only a `min` or only a `max`.
 */
export function clampStatValue(value: number, statName: string, statMap: StatMap): number {
  const statDef = statMap[statName]
  if (!statDef) return value

  let clamped = value
  if (statDef.min !== null && statDef.min !== undefined) clamped = Math.max(statDef.min, clamped)
  if (statDef.max !== null && statDef.max !== undefined) clamped = Math.min(statDef.max, clamped)
  return clamped
}

/**
 * Apply `name -> delta` changes to the current stats, clamping each result.
 *
 * A stat not present in `currentStats` starts from 0, so a change can introduce
 * a stat. The input is copied, never mutated.
 */
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
 * Build the starting stats block for a new character.
 *
 * Every declared stat gets its `default` (0 when it declares none), then the
 * overrides are layered on top. Overrides are *not* clamped and may introduce
 * stats the definitions never mention — character creation is trusted here.
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

// =============================================================================
// Inventory
// =============================================================================

/** Result of {@link findInventoryItem}: both fields are null when not found. */
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
 * Add an item, stacking onto an existing entry of the same id.
 *
 * Everything stacks: there is no per-item `stackable` flag, so two swords land
 * as one entry with `quantity: 2` exactly as two potions would. The entries are
 * shallow-copied, so the returned list is safe to persist but nested
 * `properties` objects are still shared with the input.
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

/** Result of {@link removeInventoryItem}. */
export interface RemoveInventoryResult {
  /** On failure this is the *original* array, unchanged and not copied. */
  inventory: InventoryEntry[]
  success: boolean
  /** Quantity left afterwards; on a shortfall, the quantity actually held. */
  remaining: number
}

/**
 * Remove `quantity` of an item, dropping the entry when it hits zero.
 *
 * Removing more than is held fails outright rather than removing what there is:
 * a partial consume would leave the caller thinking the whole cost was paid.
 * The failure still reports the held quantity so the caller can say how short
 * the player was.
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

/**
 * Replace one item's `instance_properties`.
 *
 * Only the first match is updated, and a miss is not an error — the list comes
 * back copied either way.
 */
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

// =============================================================================
// Property normalization (higher_is_better metadata)
// =============================================================================

/**
 * Property names where a lower number is the better one.
 *
 * The default is "higher is better", so this set is the inversion list, matched
 * case-insensitively against the property name. It exists so the UI can colour a
 * comparison without the world author annotating every property.
 */
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
 * Normalize one property value to `{value, higher_is_better}`.
 *
 * An already-structured `{value: ...}` keeps its own `higher_is_better` (default
 * true), which is how a world author overrides the name-based guess. A bare
 * value gets the guess: better-when-higher unless the name is in
 * {@link LOWER_IS_BETTER_PROPERTIES}.
 *
 * Python passes a non-boolean `higher_is_better` straight through; this coerces
 * it, since the field is typed and every consumer only tests its truthiness.
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

// =============================================================================
// Equipment
// =============================================================================

/** Result of {@link equipItem} / {@link unequipSlot}. */
export interface EquipResult {
  /** On failure this is the *original* equipment object, unchanged. */
  equipment: Equipment
  /** The item displaced from the slot, if any. */
  unequippedItemId: string | null
  /** Human-readable outcome, shown to the player verbatim. */
  message: string
}

/**
 * Equip an inventory item into a slot.
 *
 * Validation order matters — the first failing check is the message the player
 * sees: slot exists, item is held, item is equippable at all, item declares this
 * slot, then slot/item type compatibility. Failures are reported in the message
 * rather than thrown; the caller is a tool handler that narrates the reason.
 *
 * An empty `slotCatalog` skips slot validation entirely (Python's
 * `if slot_catalog and ...`), which is how a world with no slot definitions
 * still allows equipping. Likewise `accepts_as` is only enforced when both sides
 * declare it.
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

  // Occupied slots swap rather than refuse: the displaced id comes back so the
  // caller can put it away, and the slot never holds two items.
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

/**
 * Sum the passive stat modifiers of everything currently equipped.
 *
 * An item id with no template contributes nothing rather than throwing, so a
 * deleted item template degrades the bonus instead of breaking the turn.
 */
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

// =============================================================================
// Affordances
// =============================================================================

/** Result of {@link checkAffordanceRequirements}. */
export interface RequirementCheck {
  canUse: boolean
  /** Why — the first unmet requirement, or a confirmation when all are met. */
  reason: string
}

/**
 * Check whether the player meets an affordance's requirements.
 *
 * Returns on the first failure, so the reason names one specific blocker rather
 * than a list. An affordance with no `requirements` block is always usable.
 * Stats missing from `currentStats` read as 0 and flags missing from `flags`
 * read as false, which makes `flags_none` pass by default.
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

/** Result of {@link applyAffordanceCosts}. */
export interface AffordanceCostResult {
  /** On failure this is the *original* stats object: costs are all-or-nothing. */
  stats: Record<string, number>
  success: boolean
  message: string
}

/**
 * Deduct an affordance's costs from the player's stats.
 *
 * Unlike {@link applyAffordanceEffects}, a cost that would push a stat below its
 * declared minimum *fails* instead of clamping — that is the whole point of a
 * cost, and clamping would let the player cast a spell they cannot pay for. The
 * maximum still clamps, since overshooting a cap is not a failure to pay. A stat
 * with no minimum defined can therefore go negative.
 *
 * Costs are all-or-nothing: a later change failing discards the earlier ones.
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
    // Python would happily write a `None` key here and only fail later, when the
    // stats blob is serialized. A nameless change is dropped instead.
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

/** Result of {@link applyAffordanceEffects}. */
export interface AffordanceEffectResult {
  stats: Record<string, number>
  flags: Record<string, boolean>
  /** A comma-joined summary of what changed, for the narration prompt. */
  message: string
}

/**
 * Apply an affordance's effects: stat deltas and flag assignments.
 *
 * Effects clamp at both bounds and cannot fail — a heal past max health is
 * capped, not refused. Compare {@link applyAffordanceCosts}, which refuses.
 */
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

    // The reported delta is the requested one, not the clamped result, matching
    // Python. "health +50" after a cap at +10 is what the player sees.
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
 * Record a use of an affordance in the item's instance properties.
 *
 * Charges and cooldowns are keyed per affordance (`charges_<id>`,
 * `cooldown_<id>`) inside one flat properties dict, so an item with several
 * affordances tracks each separately. An affordance with no `id` shares the
 * `default` key.
 *
 * Charges only exist when `charges.max` is set, and a cooldown is only written
 * when the affordance declares both a domain and a non-zero value *and* the
 * caller knows the current value of that time domain — without it there is
 * nothing to compute an expiry from, so the use simply does not start a
 * cooldown.
 *
 * Python also takes a `current_time` mapping here and never reads it; it is not
 * ported.
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
    // An unused item has no stored count yet and starts from a full bar. A
    // stored non-number is malformed (Python would raise on the subtraction) and
    // is treated the same as unused rather than failing the turn.
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

/** Result of {@link checkCooldownReady}. */
export interface CooldownCheck {
  ready: boolean
  message: string
}

/**
 * Check whether an affordance is off cooldown.
 *
 * A missing entry means "never used", which is ready. The stored entry carries
 * its own domain so the message can say "3 turns remaining" or "3 days
 * remaining"; the caller supplies the current value of that domain.
 */
export function checkCooldownReady(
  instanceProperties: Record<string, unknown>,
  affordance: Affordance,
  currentDomainValue: number,
): CooldownCheck {
  const affordanceId = affordance.id ?? 'default'
  const cooldownData = instanceProperties[`cooldown_${affordanceId}`]

  if (!cooldownData) return { ready: true, message: 'Ready' }
  if (!isRecord(cooldownData)) {
    // Python raises AttributeError on the `.get` below. A malformed entry is
    // read as "no cooldown recorded" instead of failing the player's turn.
    return { ready: true, message: 'Ready' }
  }

  const expiresAt = typeof cooldownData.expires_at === 'number' ? cooldownData.expires_at : 0
  const domain = typeof cooldownData.domain === 'string' ? cooldownData.domain : 'turn'

  if (currentDomainValue >= expiresAt) return { ready: true, message: 'Ready' }

  const remaining = expiresAt - currentDomainValue
  return { ready: false, message: `On cooldown (${remaining} ${domain}s remaining)` }
}

/** Result of {@link checkChargesAvailable}. */
export interface ChargesCheck {
  hasCharges: boolean
  /** Charges left, or -1 for an affordance with no charge limit. */
  charges: number
  message: string
}

/**
 * Check whether an affordance has charges left for one more use.
 *
 * An affordance without `charges.max` is unlimited and reports -1, which is why
 * callers must test `hasCharges` rather than the count. An item that has never
 * been used has no stored count and reads as full.
 */
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
