/**
 * Item template validation against a world's catalogs.
 *
 * Ported from `backend/domain/services/item_validation.py`.
 *
 * An item template is authored by an agent through the `persist_item` tool and
 * can name any stat, equipment slot, time domain or recharge event it likes.
 * These checks are what stop a template referring to a stat the world does not
 * have — the item would persist fine and then do nothing, which is far harder
 * to notice than a rejected write.
 *
 * Two shapes to keep in mind while reading:
 *
 * - **Keys are snake_case.** The template is a JSON blob that the Python
 *   backend also reads and writes; `passive_effects`, `stat_changes` and the
 *   rest are the on-disk names, not TypeScript identifiers.
 * - **An empty catalog disables its check.** Python spells this `if not
 *   catalog: return True` — a world that never defined equipment slots must not
 *   have every slot rejected. `{}` is falsy in Python, so the emptiness test
 *   below is on key count, not on null.
 *
 * Everything here is pure: no database, no filesystem, no logging. The Python
 * module holds a module-level logger it never calls; that is dropped.
 */

/** A parsed JSON object. Templates and catalogs arrive already deserialized. */
type Dict = Record<string, unknown>

/** A catalog argument: absent, empty, or a mapping of names to definitions. */
type Catalog = Dict | null | undefined

export interface ItemValidationResult {
  /** Problems that should block the write. */
  errors: string[]
  /** Problems worth surfacing that still leave a usable item. */
  warnings: string[]
}

export interface ItemValidationCatalogs {
  /** Stats from the world's `stats.yaml`. */
  statDefinitions?: Catalog
  /** Equipment slots from the world config. */
  slotCatalog?: Catalog
  /** Time domains from the world config. */
  timeDomains?: Catalog
  /** Recharge events from the world config. */
  rechargeEvents?: Catalog
}

function asDict(value: unknown): Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Dict)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * The catalog if it has any entries, else null.
 *
 * Python spells the same test as `if not catalog`, which is false for `{}` as
 * well as for `None`. Returning the narrowed value rather than a boolean is
 * what lets the callers below pass it on without a non-null assertion.
 */
function catalogOrNull(catalog: Catalog): Dict | null {
  if (catalog === null || catalog === undefined) return null
  return Object.keys(catalog).length > 0 ? catalog : null
}

/**
 * Every stat name a template mentions that the world does not define, as
 * dotted paths into the template.
 *
 * The paths are the return value's whole point: an item can reference stats in
 * four different places and "invalid stat reference" without a path leaves the
 * author hunting through a nested blob.
 */
export function validateStatReferences(itemTemplate: Dict, statDefinitions: Dict): string[] {
  const validStats = new Set(Object.keys(statDefinitions))
  const invalidRefs: string[] = []

  // A missing stat name reads as `undefined` in the path below where Python
  // writes `None` (`item_template.get("stat")` on a change with no `stat` key).
  // Both are just diagnostic text; neither is parsed.
  const nameOf = (value: unknown): string => String(value)

  const equippable = asDict(itemTemplate.equippable)
  for (const statName of Object.keys(asDict(equippable.passive_effects))) {
    if (!validStats.has(statName)) {
      invalidRefs.push(`equippable.passive_effects.${statName}`)
    }
  }

  const usable = asDict(itemTemplate.usable)
  asArray(usable.affordances).forEach((rawAffordance, i) => {
    const affordance = asDict(rawAffordance)
    const prefix = `usable.affordances[${i}]`

    const requirementStats = asDict(asDict(affordance.requirements).stats)
    for (const statName of Object.keys(requirementStats)) {
      if (!validStats.has(statName)) {
        invalidRefs.push(`${prefix}.requirements.stats.${statName}`)
      }
    }

    for (const rawChange of asArray(asDict(affordance.cost).stat_changes)) {
      const stat = asDict(rawChange).stat
      if (typeof stat !== 'string' || !validStats.has(stat)) {
        invalidRefs.push(`${prefix}.cost.stat_changes.${nameOf(stat)}`)
      }
    }

    for (const rawChange of asArray(asDict(affordance.effects).stat_changes)) {
      const stat = asDict(rawChange).stat
      if (typeof stat !== 'string' || !validStats.has(stat)) {
        invalidRefs.push(`${prefix}.effects.stat_changes.${nameOf(stat)}`)
      }
    }
  })

  return invalidRefs
}

/** Whether `slot` exists in the world's slot catalog — vacuously true if there is none. */
export function validateSlotReference(slot: string, slotCatalog: Catalog): boolean {
  const catalog = catalogOrNull(slotCatalog)
  return catalog === null || Object.hasOwn(catalog, slot)
}

/** Whether `domain` exists in the world's time domains — vacuously true if there are none. */
export function validateTimeDomain(domain: string, timeDomains: Catalog): boolean {
  const catalog = catalogOrNull(timeDomains)
  return catalog === null || Object.hasOwn(catalog, domain)
}

/** Whether `event` exists in the world's recharge events — vacuously true if there are none. */
export function validateRechargeEvent(event: string, rechargeEvents: Catalog): boolean {
  const catalog = catalogOrNull(rechargeEvents)
  return catalog === null || Object.hasOwn(catalog, event)
}

/**
 * Run every check over one template.
 *
 * The severity split is Python's and is not arbitrary: a bad stat or slot means
 * the item cannot work, while an unknown time domain or recharge event only
 * means a cooldown will not tick — the item is still usable, so it warns.
 *
 * Python takes the four catalogs as separate optional positional parameters
 * (`item_validation.py:120-127`). They are collected into one options object
 * here because all four have the same type, and a transposed pair would
 * typecheck and then validate slots against time domains.
 */
export function validateItemTemplate(
  itemTemplate: Dict,
  { statDefinitions, slotCatalog, timeDomains, rechargeEvents }: ItemValidationCatalogs = {},
): ItemValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  const stats = catalogOrNull(statDefinitions)
  if (stats !== null) {
    for (const ref of validateStatReferences(itemTemplate, stats)) {
      errors.push(`Invalid stat reference: ${ref}`)
    }
  }

  const equippable = asDict(itemTemplate.equippable)
  const slot = equippable.slot
  if (typeof slot === 'string' && slot !== '' && !validateSlotReference(slot, slotCatalog)) {
    errors.push(`Invalid equipment slot: ${slot}`)
  }

  const usable = asDict(itemTemplate.usable)
  asArray(usable.affordances).forEach((rawAffordance, i) => {
    const affordance = asDict(rawAffordance)

    const domain = asDict(affordance.cooldown).domain
    if (typeof domain === 'string' && domain !== '' && !validateTimeDomain(domain, timeDomains)) {
      warnings.push(`Unknown time domain in affordance[${i}]: ${domain}`)
    }

    const event = asDict(asDict(affordance.charges).recharge).event
    if (
      typeof event === 'string' &&
      event !== '' &&
      !validateRechargeEvent(event, rechargeEvents)
    ) {
      warnings.push(`Unknown recharge event in affordance[${i}]: ${event}`)
    }
  })

  return { errors, warnings }
}
