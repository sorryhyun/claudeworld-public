/**
 * Item templates — `worlds/{name}/items/{item_id}.yaml`.
 *
 * Ported from `backend/services/item_service.py`.
 *
 * `items/` is the source of truth for what an item *is*: name, description,
 * default properties, and the optional classification/component blocks
 * (`category`, `tags`, `rarity`, `icon`, `stacking`, `equippable`, `usable`).
 * `player.yaml`'s inventory holds only references — `{item_id, quantity,
 * instance_properties}` — so editing a template updates every copy the player
 * is carrying instead of leaving a stale duplicate in the save file.
 *
 * Two behaviours here are load-bearing rather than incidental:
 *
 * - **{@link ItemService.toReferenceFormat} writes templates as a side effect.**
 *   That is how an item an agent invents mid-turn becomes a persistent
 *   definition: the Action Manager hands the whole item to the player state, and
 *   the save path materialises `items/<id>.yaml` on the way to disk.
 * - **Templates are keyed by the file's own `id` field, not by its filename.**
 *   The filename is a sanitised approximation of the id (see
 *   {@link UNSAFE_ITEM_ID_CHARS}); an id containing a space cannot round-trip
 *   through the name, so the id inside the file is the only reliable key.
 *
 * `delete_item_template` is deliberately not ported — it has no call site in the
 * Python tree.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { MtimeCache, WorldService } from './world-service'
import { InventoryItem, normalizeProperties } from '../domain/player-rules'
import type { Equippable, InventoryEntry, ItemTemplate } from '../domain/player-rules'
import { getLogger } from '../infrastructure/logging/logger'

const logger = getLogger('ItemService')

// ============================================================================
// Types
// ============================================================================

/**
 * Arguments to {@link ItemService.saveItemTemplate}.
 *
 * Python takes eleven keyword arguments; an options object is the TS equivalent
 * and stops `description` and `category` — both optional strings — from being
 * swapped at a call site.
 */
export interface SaveItemTemplateInput {
  /** Unique id. Also the basis for the filename, after sanitisation. */
  itemId: string
  name: string
  description?: string | null
  /** Written as `default_properties`; instances override individual keys. */
  properties?: Record<string, unknown> | null
  /** gift / credential / clue / tool / … — free-form, world-defined. */
  category?: string | null
  tags?: string[] | null
  rarity?: string | null
  /** UI hint only. */
  icon?: string | null
  stacking?: Record<string, unknown> | null
  equippable?: Equippable | null
  usable?: Record<string, unknown> | null
  /** Without this an existing file is left alone and `false` is returned. */
  overwrite?: boolean
}

/** One world's parsed `items/` directory, with the mtime that validated it. */
interface CachedTemplates {
  templates: Record<string, ItemTemplate>
  mtimeMs: number
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Characters an item id may contribute to its filename.
 *
 * Mirrors Python's `c.isalnum() or c in "._-"`, which is Unicode-aware, hence
 * `\p{L}\p{N}` rather than `[a-z0-9]`. **This is narrower than the world-name
 * sanitiser in `world-service.ts`, which also keeps the space.** `"Old Lantern"`
 * becomes `OldLantern.yaml` here but `Old Lantern/` there, so the two must not
 * be shared.
 */
const UNSAFE_ITEM_ID_CHARS = /[^\p{L}\p{N}._-]/gu

/** Whether a value is a plain JSON object, i.e. what Python calls a `dict`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Python truthiness for a collection: `{}` and `[]` are falsy there, truthy
 * here. Every `if tags:` / `if stacking:` branch in the source goes through this.
 */
function isNonEmpty(value: Record<string, unknown> | unknown[] | null | undefined): boolean {
  if (value === null || value === undefined) return false
  return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0
}

/**
 * Look one template up by id.
 *
 * `templates[id]` would resolve `"constructor"` or `"toString"` against
 * `Object.prototype` and hand back a function where Python's `dict.get` returns
 * `None`. Item ids come from model output, so the own-property check is not
 * theoretical.
 */
function getTemplate(
  templates: Record<string, ItemTemplate>,
  itemId: string,
): ItemTemplate | undefined {
  return Object.hasOwn(templates, itemId) ? templates[itemId] : undefined
}

/**
 * Serialise the way `_LiteralDumper` (`item_service.py:21-33`) does.
 *
 * That dumper exists for one reason: multi-line strings must come out in
 * literal block style (`|`) so a long item description stays readable in the
 * file an author edits by hand. The `yaml` package already picks block literal
 * for multi-line strings, so no custom stringifier is needed — only
 * `sortMapEntries` (PyYAML's `sort_keys=True` default, which means the key order
 * the template is *built* in never reaches disk) and `indentSeq: false` (PyYAML
 * writes `- x` flush with its key; the `yaml` default indents it) are required
 * to match byte for byte.
 *
 * One known divergence remains: PyYAML folds a long plain scalar at the first
 * space *after* column 80, the `yaml` package at the last space *before* it, so
 * a description over 80 characters wraps one word earlier here. Folding a plain
 * scalar is pure whitespace — both files parse to the same string in either
 * language — so the difference is recorded rather than emulated.
 */
function dumpYaml(data: unknown): string {
  return stringifyYaml(data, { sortMapEntries: true, indentSeq: false })
}

// ============================================================================
// Service
// ============================================================================

export class ItemService {
  private readonly worlds: WorldService

  /**
   * Per-world parse of `items/`, keyed by world name.
   *
   * Not an {@link MtimeCache}: invalidation is the *maximum* mtime across the
   * directory and every `*.yaml` in it, because a template can be added,
   * removed or edited and all three must be noticed. That is a directory-level
   * question, and `MtimeCache` stats one file.
   */
  private readonly templateCache = new Map<string, CachedTemplates>()

  /**
   * @param worldsDir Root of the `worlds/` tree.
   * @param cache Shared with other services, or omit for a private one. Only
   *   the wrapped {@link WorldService} uses it — see {@link templateCache}.
   */
  constructor(worldsDir: string, cache: MtimeCache = new MtimeCache()) {
    this.worlds = new WorldService(worldsDir, cache)
  }

  private itemsDir(worldName: string): string {
    return join(this.worlds.getWorldPath(worldName), 'items')
  }

  /** Drop every world's cached template parse. */
  clearCache(): void {
    this.templateCache.clear()
  }

  // --------------------------------------------------------------------
  // Directory scanning
  // --------------------------------------------------------------------

  /**
   * Template files in a world's `items/`, in whatever order the OS lists them.
   *
   * Python uses `items_dir.glob("*.yaml")`, which skips dotfiles and matches
   * only that one extension — `.yml` templates are invisible to both backends.
   */
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

  /**
   * Latest mtime across `items/` and its templates, or 0 when there is no such
   * directory.
   *
   * The directory's own mtime catches an added or deleted file; each file's
   * catches an edit in place.
   */
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
        // Deleted between listing and stat. The directory mtime already moved.
      }
    }

    return maxMtime
  }

  // --------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------

  /**
   * Every template in a world, keyed by the `id` field inside each file.
   *
   * A file that will not parse, or that has no `id`, is logged and skipped: one
   * hand-edited template with a stray tab must not take the whole inventory
   * down mid-turn.
   */
  loadAllItemTemplates(worldName: string): Record<string, ItemTemplate> {
    const currentMtime = this.getItemsDirMtime(worldName)

    // Python compares `cached.mtime >= current_mtime`, which treats a directory
    // restored from an older copy as fresh. Exact equality reloads instead,
    // matching the choice already made in `MtimeCache`.
    const cached = this.templateCache.get(worldName)
    if (cached && cached.mtimeMs === currentMtime) return cached.templates

    const templates: Record<string, ItemTemplate> = {}
    for (const file of this.listTemplateFiles(this.itemsDir(worldName))) {
      try {
        const data: unknown = parseYaml(readFileSync(file, 'utf-8'))
        // Python's `if data and "id" in data` also accepts a list or a string
        // and then keys the dict by something unusable; anything but a mapping
        // is treated as malformed here.
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

  /** One template by id, or `null` when the world has no such item. */
  loadItemTemplate(worldName: string, itemId: string): ItemTemplate | null {
    return getTemplate(this.loadAllItemTemplates(worldName), itemId) ?? null
  }

  /** Every item definition in a world, for the `/state/items` endpoint. */
  getAllItemsInWorld(worldName: string): ItemTemplate[] {
    return Object.values(this.loadAllItemTemplates(worldName))
  }

  // --------------------------------------------------------------------
  // Writes
  // --------------------------------------------------------------------

  /**
   * Write `items/{safe_id}.yaml`.
   *
   * Returns `false` — not an error — when the file exists and `overwrite` is
   * not set. `persist_item` relies on that to skip an item the world already
   * defines rather than clobbering an author's edits with a model's guess.
   *
   * Optional fields are omitted from the file entirely when falsy, so a
   * template carries only what its author actually declared;
   * `default_properties` is always written, even empty, because the resolver
   * distinguishes "no defaults" from "an older file that predates the key".
   *
   * Python's `items_dir.mkdir(exist_ok=True)` has no `parents=True` and so
   * raises when the world directory itself is missing. This creates the parent
   * instead: the only way to reach that state is a world deleted mid-turn, and
   * recreating the tree is a better outcome than a failed save.
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

    // Built in Python's key order (`item_service.py:127-152`) for readability
    // only — `sortMapEntries` in `dumpYaml` re-sorts on the way out, exactly as
    // PyYAML's `sort_keys` default does.
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

    // The directory mtime moved, so the cache would reload anyway; dropping the
    // entry makes a same-millisecond write visible on filesystems whose mtime
    // resolution is coarser than the gap between two saves.
    this.templateCache.delete(worldName)

    logger.info(`Saved item template '${input.itemId}' in world '${worldName}'`)
    return true
  }

  // --------------------------------------------------------------------
  // Reference <-> resolved
  // --------------------------------------------------------------------

  /**
   * Merge `player.yaml`'s inventory references with the templates they name.
   *
   * The result is the full item — name, description, template defaults with the
   * instance's own properties layered over them — which is what the UI renders
   * and what the Action Manager's context describes. An entry naming an item
   * with no template still resolves, through the legacy embedded path in
   * {@link InventoryItem.fromReference}.
   *
   * `normalizeProps` attaches the `higher_is_better` metadata the UI needs to
   * colour a comparison. An item whose properties are empty is left alone —
   * Python's `if item_dict.get("properties")` is false for `{}`.
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
   * creating any template that does not exist yet.
   *
   * The write is the point, not a convenience: this runs on every
   * `savePlayerState`, so an item the Action Manager conjured during a turn is
   * given a durable definition under `items/` at the same moment the player's
   * save file starts pointing at it. Without it the reference would dangle and
   * the item would lose its name and description on the next load.
   *
   * The template snapshot is taken once and not refreshed, so two entries with
   * the same id try to save twice; the second hits the exists-check in
   * {@link saveItemTemplate} and is skipped. That is the Python behaviour.
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
