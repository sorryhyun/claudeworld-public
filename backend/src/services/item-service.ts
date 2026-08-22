/**
 * Item templates — `worlds/{name}/items/{item_id}.yaml`, the source of truth for
 * what an item *is*; `player.yaml`'s inventory holds only references. Two
 * load-bearing behaviours: {@link ItemService.toReferenceFormat} writes
 * templates as a side effect, which is how an item invented mid-turn becomes
 * persistent; and templates are keyed by the file's own `id` field, not by its
 * filename, which is only a sanitised approximation of it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { MtimeCache, WorldService } from './world-service'
import { InventoryItem, normalizeProperties } from '../domain/player-rules'
import type { Equippable, InventoryEntry, ItemTemplate } from '../domain/player-rules'
import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('ItemService')

export interface SaveItemTemplateInput {
  itemId: string
  name: string
  description?: string | null
  /** Written as `default_properties`; instances override individual keys. */
  properties?: Record<string, unknown> | null
  category?: string | null
  tags?: string[] | null
  rarity?: string | null
  icon?: string | null
  stacking?: Record<string, unknown> | null
  equippable?: Equippable | null
  usable?: Record<string, unknown> | null
  /** Without this an existing file is left alone and `false` is returned. */
  overwrite?: boolean
}

interface CachedTemplates {
  templates: Record<string, ItemTemplate>
  mtimeMs: number
}

// Narrower than the world-name sanitiser in `world-service.ts`, which also
// keeps the space — the two must not be shared.
const UNSAFE_ITEM_ID_CHARS = /[^\p{L}\p{N}._-]/gu

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmpty(value: Record<string, unknown> | unknown[] | null | undefined): boolean {
  if (value === null || value === undefined) return false
  return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0
}

// Item ids come from model output, so a bare `templates[id]` would resolve
// `"constructor"` against `Object.prototype`.
function getTemplate(
  templates: Record<string, ItemTemplate>,
  itemId: string,
): ItemTemplate | undefined {
  return Object.hasOwn(templates, itemId) ? templates[itemId] : undefined
}

function dumpYaml(data: unknown): string {
  return stringifyYaml(data, { sortMapEntries: true, indentSeq: false })
}

export class ItemService {
  private readonly worlds: WorldService

  // Not an MtimeCache: invalidation is the *maximum* mtime across `items/` and
  // every file in it, so add/remove/edit are all noticed.
  private readonly templateCache = new Map<string, CachedTemplates>()

  constructor(worldsDir: string, cache: MtimeCache = new MtimeCache()) {
    this.worlds = new WorldService(worldsDir, cache)
  }

  private itemsDir(worldName: string): string {
    return join(this.worlds.getWorldPath(worldName), 'items')
  }

  clearCache(): void {
    this.templateCache.clear()
  }

  private listTemplateFiles(itemsDir: string): string[] {
    let names: string[]
    try {
      names = readdirSync(itemsDir)
    } catch {
      return []
    }
    return names
      .filter((name) => name.endsWith('.yaml') && !name.startsWith('.'))
      .map((name) => join(itemsDir, name))
  }

  // The directory mtime catches an added or deleted file; each file's catches
  // an edit in place.
  private getItemsDirMtime(worldName: string): number {
    const itemsDir = this.itemsDir(worldName)

    let maxMtime: number
    try {
      maxMtime = statSync(itemsDir).mtimeMs
    } catch {
      return 0
    }

    for (const file of this.listTemplateFiles(itemsDir)) {
      try {
        maxMtime = Math.max(maxMtime, statSync(file).mtimeMs)
      } catch {
        // Deleted between listing and stat; the directory mtime already moved.
      }
    }

    return maxMtime
  }

  /**
   * Every template in a world, keyed by the `id` inside each file. An
   * unparseable or id-less file is skipped: one hand-edited template must not
   * take the whole inventory down mid-turn.
   */
  loadAllItemTemplates(worldName: string): Record<string, ItemTemplate> {
    const currentMtime = this.getItemsDirMtime(worldName)

    // Exact equality, not `>=`: a directory restored from an older copy must
    // reload rather than read as fresh.
    const cached = this.templateCache.get(worldName)
    if (cached && cached.mtimeMs === currentMtime) return cached.templates

    const templates: Record<string, ItemTemplate> = {}
    for (const file of this.listTemplateFiles(this.itemsDir(worldName))) {
      try {
        const data: unknown = parseYaml(readFileSync(file, 'utf-8'))
        if (isRecord(data) && 'id' in data) {
          templates[String(data.id)] = data as ItemTemplate
        }
      } catch (error) {
        logger.warning(`Failed to load item template ${file}: ${String(error)}`)
      }
    }

    this.templateCache.set(worldName, { templates, mtimeMs: currentMtime })
    return templates
  }

  loadItemTemplate(worldName: string, itemId: string): ItemTemplate | null {
    return getTemplate(this.loadAllItemTemplates(worldName), itemId) ?? null
  }

  /** Every item definition in a world, for the `/state/items` endpoint. */
  getAllItemsInWorld(worldName: string): ItemTemplate[] {
    return Object.values(this.loadAllItemTemplates(worldName))
  }

  /**
   * Write `items/{safe_id}.yaml`. Returns `false` — not an error — when the file
   * exists and `overwrite` is not set, so `persist_item` skips an item the world
   * already defines. `default_properties` is always written, even empty, because
   * the resolver distinguishes "no defaults" from a file predating it.
   */
  saveItemTemplate(worldName: string, input: SaveItemTemplateInput): boolean {
    const itemsDir = this.itemsDir(worldName)
    mkdirSync(itemsDir, { recursive: true })

    const safeId = input.itemId.replace(UNSAFE_ITEM_ID_CHARS, '')
    const itemFile = join(itemsDir, `${safeId}.yaml`)

    if (existsSync(itemFile) && !input.overwrite) {
      logger.debug(`Item template '${input.itemId}' already exists, skipping`)
      return false
    }

    // Build order is cosmetic — `dumpYaml` sorts keys on the way out.
    const template: ItemTemplate = {
      id: input.itemId,
      name: input.name,
      description: input.description || '',
    }

    if (input.category) template.category = input.category
    if (isNonEmpty(input.tags)) template.tags = input.tags
    if (input.rarity) template.rarity = input.rarity
    if (input.icon) template.icon = input.icon
    if (isNonEmpty(input.stacking)) template.stacking = input.stacking
    if (isNonEmpty(input.equippable)) template.equippable = input.equippable
    if (isNonEmpty(input.usable)) template.usable = input.usable

    template.default_properties = input.properties ?? {}

    writeFileSync(itemFile, dumpYaml(template), 'utf-8')

    // Makes a same-millisecond write visible where mtime resolution is coarser
    // than the gap between two saves.
    this.templateCache.delete(worldName)

    logger.info(`Saved item template '${input.itemId}' in world '${worldName}'`)
    return true
  }

  /**
   * Merge `player.yaml`'s inventory references with the templates they name,
   * instance properties over template defaults. An entry with no template still
   * resolves, through the legacy embedded path in `InventoryItem.fromReference`.
   */
  resolveInventory(
    worldName: string,
    inventoryRefs: InventoryEntry[],
    normalizeProps = true,
  ): InventoryEntry[] {
    const templates = this.loadAllItemTemplates(worldName)
    const resolved: InventoryEntry[] = []

    for (const ref of inventoryRefs) {
      const itemId = ref.item_id || ref.id || ''
      const itemDict = InventoryItem.fromReference(ref, getTemplate(templates, itemId)).toDict()

      if (normalizeProps && isNonEmpty(itemDict.properties)) {
        itemDict.properties = normalizeProperties(itemDict.properties)
      }

      resolved.push(itemDict)
    }

    return resolved
  }

  /**
   * Reduce full inventory items to the reference form `player.yaml` stores,
   * creating any missing template. The write is the point: an item conjured
   * mid-turn gets a durable definition at the moment the save file points at it.
   */
  toReferenceFormat(worldName: string, inventoryItems: InventoryEntry[]): InventoryEntry[] {
    const templates = this.loadAllItemTemplates(worldName)
    const references: InventoryEntry[] = []

    for (const itemData of inventoryItems) {
      const item = InventoryItem.fromDict(itemData)

      if (!Object.hasOwn(templates, item.id)) {
        this.saveItemTemplate(worldName, {
          itemId: item.id,
          name: item.name,
          description: item.description,
          properties: item.properties,
        })
      }

      references.push(item.toReferenceDict())
    }

    return references
  }
}
