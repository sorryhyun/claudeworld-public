/**
 * Pure validation of an agent-authored item template against a world's
 * catalogs. Without these checks a template naming a stat the world does not
 * have persists fine and then does nothing. An empty catalog disables its own
 * check, so a world that never defined equipment slots does not have every slot
 * rejected — hence the key-count test, not a null test.
 */

type Dict = Record<string, unknown>

type Catalog = Dict | null | undefined

export interface ItemValidationResult {
  /** Blocking problems. */
  errors: string[]
  /** Problems worth surfacing that still leave a usable item. */
  warnings: string[]
}

export interface ItemValidationCatalogs {
  /** Stats from the world's `stats.json`. */
  statDefinitions?: Catalog
  /** Equipment slots, time domains and recharge events from the world config. */
  slotCatalog?: Catalog
  timeDomains?: Catalog
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

// Narrowed rather than a boolean so callers can pass it on unasserted.
function catalogOrNull(catalog: Catalog): Dict | null {
  if (catalog === null || catalog === undefined) return null
  return Object.keys(catalog).length > 0 ? catalog : null
}

/**
 * Every stat name a template mentions that the world does not define, as dotted
 * paths — an item can reference stats in four places, so a bare name leaves the
 * author hunting through a nested blob.
 */
export function validateStatReferences(itemTemplate: Dict, statDefinitions: Dict): string[] {
  const validStats = new Set(Object.keys(statDefinitions))
  const invalidRefs: string[] = []

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

/** Vacuously true when the world defines no slot catalog. */
export function validateSlotReference(slot: string, slotCatalog: Catalog): boolean {
  const catalog = catalogOrNull(slotCatalog)
  return catalog === null || Object.hasOwn(catalog, slot)
}

export function validateTimeDomain(domain: string, timeDomains: Catalog): boolean {
  const catalog = catalogOrNull(timeDomains)
  return catalog === null || Object.hasOwn(catalog, domain)
}

export function validateRechargeEvent(event: string, rechargeEvents: Catalog): boolean {
  const catalog = catalogOrNull(rechargeEvents)
  return catalog === null || Object.hasOwn(catalog, event)
}

/**
 * Run every check over one template. The severity split is deliberate: a bad
 * stat or slot means the item cannot work, an unknown time domain or recharge
 * event only means a cooldown will not tick. The catalogs are one options
 * object because all four share a type, and a transposed pair would typecheck.
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
