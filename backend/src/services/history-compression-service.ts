/**
 * Compressing `history.md` into `consolidated_history.md`.
 *
 * Ported from `backend/services/history_compression_service.py`.
 *
 * A world's `history.md` grows by one `## Turn N - Location` entry per travel,
 * and the Action Manager's context carries it whole. Left alone it eventually
 * dominates the prompt. Compression folds it into batches of three turns, hands
 * each batch to the `History_Summarizer` agent, and appends the summaries to
 * `consolidated_history.md` under `## [subtitle]` headings — the same shape as
 * an agent's `consolidated_memory.md`, which is what lets the `recall_history`
 * tool offer the subtitles and fetch one section on demand.
 *
 * ## The summarizer is injected
 *
 * The parsing, batching and formatting is the part that can be wrong in a way
 * that loses a player's history, and none of it needs a model. It is therefore
 * separated from the one call that does: {@link Summarize} is the whole of this
 * module's dependency on the SDK, exactly as `TapeExecutor` depends on a
 * `respond` function rather than on the turn runner. {@link createSummarizer}
 * supplies the real one.
 *
 * ## What lives elsewhere
 *
 * Python's three read helpers — `load_consolidated_history`,
 * `get_history_subtitles`, `get_history_by_subtitle` — are pure reads of a file
 * in the world directory and are already ported onto `WorldService`, next to
 * `loadHistory`. They are not duplicated here; call them there.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { and, eq } from 'drizzle-orm'

import { getSettings } from '../config/settings'
import type { Db } from '../db'
import { agents, type Agent } from '../db/schema'
import { getLogger } from '../infrastructure/logging/logger'
import { TurnRunner } from '../sdk/agent/turn-runner'
import type { SessionPool } from '../sdk/client/session-pool'
import { AgentConfigService } from './agent-config-service'
import { buildSystemPrompt } from './prompt-builder'
import { MtimeCache, WorldService } from './world-service'

const logger = getLogger('HistoryCompressionService')

// ============================================================================
// Constants
// ============================================================================

/**
 * `## Turn 12 - tavern` headings in `history.md`.
 *
 * `[\s\S]` is never involved: the pattern is line-anchored with `m` and no `s`,
 * so the location half stops at the newline exactly as Python's `.+` under
 * `MULTILINE` does.
 */
const TURN_PATTERN = /^## Turn (\d+) - (.+)$/gm

/** Turns folded into one consolidated section. */
export const BATCH_SIZE = 3

/** What `WorldService.createWorld` writes into a fresh `history.md`. */
const EMPTY_HISTORY_MARKER = '# World History'

/** The name the summarizer agent is registered under. */
const SUMMARIZER_NAME = 'History_Summarizer'

/** Group the summarizer belongs to; the lookup is scoped to it, as in Python. */
const SUMMARIZER_GROUP = 'gameplay'

// ============================================================================
// Types
// ============================================================================

/** One `## Turn N - Location` entry and the prose beneath it. */
export interface TurnEntry {
  turnNumber: number
  location: string
  /** Body between this heading and the next, trimmed. */
  content: string
}

/**
 * The compression route's response body.
 *
 * Keys are snake_case because this object *is* the JSON the endpoint returns
 * (`routers/game/worlds.py:484-486` returns the dict unchanged), and the parity
 * contract freezes the wire shape. It is the one place in this file where the
 * on-disk/on-wire spelling wins over the TypeScript one.
 */
export interface CompressionResult {
  success: boolean
  turns_compressed: number
  sections_created: number
  message: string
}

/**
 * The SDK call, narrowed to what compression needs.
 *
 * Returns the consolidated section — heading included — or `null` when the model
 * produced nothing. A rejection is a failure of that one batch, not of the run:
 * see {@link HistoryCompressionService.compressHistory}.
 */
export type Summarize = (request: SummarizeRequest) => Promise<string | null>

export interface SummarizeRequest {
  agent: Agent
  systemPrompt: string
  userMessage: string
  /** Room the work is attributed to; 0 outside a room, as in Python. */
  roomId: number
}

// ============================================================================
// Parsing / batching — no model involved
// ============================================================================

/**
 * Split `history.md` into its turn entries.
 *
 * Anything before the first heading — the `# World History` title, and any
 * hand-written preamble — is dropped, which is what makes the file's title
 * survive the rewrite at the end of a compression run rather than being folded
 * into the first summary.
 *
 * A malformed or headingless file yields `[]` rather than one giant entry, and
 * `compressHistory` treats that as "nothing to compress" instead of feeding the
 * whole file to the model.
 */
export function parseHistoryIntoTurns(historyContent: string): TurnEntry[] {
  const matches = [...historyContent.matchAll(TURN_PATTERN)]

  return matches.map((match, i) => {
    const start = (match.index ?? 0) + match[0].length
    const end = matches[i + 1]?.index ?? historyContent.length

    return {
      // The capture group is `\d+`, so this cannot be NaN.
      turnNumber: Number.parseInt(match[1] ?? '0', 10),
      location: match[2] ?? '',
      content: historyContent.slice(start, end).trim(),
    }
  })
}

/**
 * Chunk turns into fixed-size batches, in order.
 *
 * The last batch is short rather than padded or merged, so compressing 7 turns
 * at a batch size of 3 produces three sections, the last covering one turn.
 * A `batchSize` of 0 or less would loop forever in Python's `range(0, n, 0)`
 * equivalent; it is rejected here instead.
 */
export function groupTurnsIntoBatches(
  turns: TurnEntry[],
  batchSize: number = BATCH_SIZE,
): TurnEntry[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, got ${batchSize}`)
  }

  const batches: TurnEntry[][] = []
  for (let i = 0; i < turns.length; i += batchSize) {
    batches.push(turns.slice(i, i + batchSize))
  }
  return batches
}

/**
 * Render a batch back into the `## Turn N - Location` form it was parsed from.
 *
 * Round-tripping rather than inventing a new format is deliberate: the
 * summarizer's own config describes history in these terms, and its output
 * heading style has to match what `getHistoryBySubtitle` later parses.
 *
 * Each entry is followed by a blank line — including the last, so the string
 * ends with a newline. Python's `"\n".join` over a trailing `""` produces
 * exactly that.
 */
export function formatBatchForSummarizer(batch: TurnEntry[]): string {
  const lines: string[] = []
  for (const entry of batch) {
    lines.push(`## Turn ${entry.turnNumber} - ${entry.location}`)
    lines.push(entry.content)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * The instruction wrapped around one batch.
 *
 * Reproduced verbatim from `history_compression_service.py:169-180`, trailing
 * ellipsis and all: it is a prompt, and paraphrasing it changes the output of
 * every compression run.
 */
export function buildSummarizerPrompt(batchContent: string): string {
  return `Please compress the following turn entries into a single consolidated section.

## Turn Entries to Compress
${batchContent}

## Instructions
1. Create a meaningful subtitle in square brackets that captures the key event/theme
2. Write a concise summary that preserves important events, characters, and outcomes
3. Output ONLY the consolidated section in this format:

## [meaningful_subtitle_here]
Your consolidated summary here...`
}

// ============================================================================
// The real summarizer
// ============================================================================

/**
 * A {@link Summarize} backed by the Agent SDK.
 *
 * Two details are worth stating rather than discovering:
 *
 * - **No tools, no MCP servers.** `History_Summarizer` has no entry under
 *   `agents:` in `agents/group_gameplay/group_config.yaml`, so it inherits only
 *   the group's `disabled_tools` and ends up with nothing enabled. Building the
 *   server set for it would produce an empty one at more cost, and would couple
 *   this module to the handler layer for no behavioural difference.
 * - **The session is keyed on room 0.** Python passes `room_id=0` for task
 *   tracking (`history_compression_service.py:124`); here that becomes a pool
 *   key of `room_0_agent_{id}`, so consecutive batches reuse one warm session —
 *   which also means each batch is summarised with the previous batches in
 *   context. That is Python's behaviour, and it is arguably why the sections
 *   read as a continuous history rather than as three unrelated summaries.
 */
export function createSummarizer(
  pool: SessionPool,
  options: { useSonnet?: boolean } = {},
): Summarize {
  const runner = new TurnRunner(pool)
  const useSonnet = options.useSonnet ?? getSettings().useSonnet

  return async (request) => {
    let responseText = ''

    for await (const event of runner.run({
      roomId: request.roomId,
      agentId: request.agent.id,
      agentName: request.agent.name,
      content: request.userMessage,
      // Nothing the summarizer says is shown to the player; the section it
      // returns is written to a file, not streamed into the room.
      hidden: true,
      options: {
        systemPrompt: request.systemPrompt,
        mcpServers: {},
        toolNames: [],
        useSonnet,
      },
    })) {
      if (event.type === 'content_delta') {
        responseText += event.delta
      } else if (event.type === 'stream_end' && event.responseText) {
        // The accumulated deltas and the final text are the same string in the
        // normal case; the assignment matters when the turn produced no deltas
        // at all, which is what a non-streaming result message looks like.
        responseText = event.responseText
      }
    }

    return responseText.trim() || null
  }
}

// ============================================================================
// Service
// ============================================================================

export class HistoryCompressionService {
  private readonly worlds: WorldService
  private readonly cache: MtimeCache
  private readonly configs: AgentConfigService

  /**
   * @param summarize The model call. Required, and not defaulted to
   *   {@link createSummarizer}, because that would need a `SessionPool` this
   *   class has no business owning — and would let a test silently spawn a CLI.
   * @param worldsDir Root of the `worlds/` tree.
   * @param configs Reader for the `agents/` tree, for the summarizer's own
   *   character files.
   */
  constructor(
    private readonly summarize: Summarize,
    worldsDir: string = getSettings().paths.worldsDir,
    configs: AgentConfigService = new AgentConfigService(),
  ) {
    // The cache is held rather than left inside WorldService because
    // `compressHistory` rewrites `history.md` through `fs` directly and has to
    // drop that path's entry — two writes inside one millisecond would
    // otherwise leave the emptied file invisible to the next `loadHistory`.
    this.cache = new MtimeCache()
    this.worlds = new WorldService(worldsDir, this.cache)
    this.configs = configs
  }

  /**
   * Compress a world's `history.md` and clear it.
   *
   * Three outcomes, all reported as `success: true` except the last:
   *
   * - nothing to compress (missing, or still just the `# World History` header);
   * - no turn entries found (a file with content but no headings);
   * - every batch failed, which is the only `success: false` — a *partial*
   *   failure is reported as success with a lower `sections_created`, because
   *   the sections that did land have been written and `history.md` is about to
   *   be cleared regardless.
   *
   * **That last point is the sharp edge.** Clearing `history.md` after a partial
   * run permanently discards the turns whose batches failed. Python does the
   * same (`history_compression_service.py:293-320`); it is called out here
   * because it looks like a bug and changing it would change which text a
   * player's world retains.
   */
  async compressHistory(
    db: Db,
    worldName: string,
    batchSize: number = BATCH_SIZE,
  ): Promise<CompressionResult> {
    const historyContent = this.worlds.loadHistory(worldName)

    if (!historyContent || historyContent.trim() === EMPTY_HISTORY_MARKER) {
      return emptyResult('No history to compress')
    }

    const turns = parseHistoryIntoTurns(historyContent)
    if (turns.length === 0) {
      return emptyResult('No turn entries found in history')
    }

    const batches = groupTurnsIntoBatches(turns, batchSize)
    logger.info(
      `Compressing ${turns.length} turns into ${batches.length} batches for world '${worldName}'`,
    )

    const summarizer = this.findSummarizerAgent(db)
    const compressedSections: string[] = []

    for (const batch of batches) {
      // Sequential, not `Promise.all`: the batches share one warm session (see
      // `createSummarizer`) and, more importantly, the sections are appended in
      // order, so a concurrent run would have to reassemble them anyway.
      const section = summarizer ? await this.generateSection(summarizer, batch) : null
      if (section) {
        compressedSections.push(section)
      } else {
        logger.warning(
          `Failed to compress batch starting at turn ${String(batch[0]?.turnNumber)}`,
        )
      }
    }

    if (compressedSections.length === 0) {
      return {
        success: false,
        turns_compressed: 0,
        sections_created: 0,
        message: 'Failed to generate any compressed sections',
      }
    }

    this.appendConsolidatedSections(worldName, compressedSections)
    logger.info(
      `Written ${compressedSections.length} sections to consolidated_history.md`,
    )

    this.resetHistory(worldName)
    logger.info(`Cleared history.md for world '${worldName}'`)

    return {
      success: true,
      turns_compressed: turns.length,
      sections_created: compressedSections.length,
      message: `Compressed ${turns.length} turns into ${compressedSections.length} sections`,
    }
  }

  /**
   * The `History_Summarizer` row, or `null` with a warning.
   *
   * Scoped to the `gameplay` group, which is what makes this immune to a world
   * character someone happened to name `History_Summarizer`. Python filters the
   * group in SQL and the name in Python (`history_compression_service.py:106-117`);
   * one `WHERE` is the same query.
   */
  private findSummarizerAgent(db: Db): Agent | null {
    const agent =
      db
        .select()
        .from(agents)
        .where(and(eq(agents.group, SUMMARIZER_GROUP), eq(agents.name, SUMMARIZER_NAME)))
        .get() ?? null

    if (!agent) logger.warning(`${SUMMARIZER_NAME} agent not found in database`)
    return agent
  }

  /**
   * Summarise one batch. `null` on any failure, which costs that batch and not
   * the run.
   *
   * The system prompt is rebuilt from the agent's config folder rather than read
   * from the `system_prompt` column, so an edit to the summarizer's character
   * files takes effect on the next compression without a reload — the
   * filesystem-primary rule, same as every other agent turn.
   */
  private async generateSection(summarizer: Agent, batch: TurnEntry[]): Promise<string | null> {
    try {
      const configData = this.configs.loadAgentConfig(summarizer.configFile)
      const systemPrompt = buildSystemPrompt(
        summarizer.name,
        configData ?? {
          inANutshell: null,
          characteristics: null,
          recentEvents: null,
          longTermMemorySubtitles: null,
        },
      )

      const raw = await this.summarize({
        agent: summarizer,
        systemPrompt,
        userMessage: buildSummarizerPrompt(formatBatchForSummarizer(batch)),
        roomId: 0,
      })

      // Trimmed here rather than left to the summarizer, so a blank section is
      // a batch failure for every implementation of {@link Summarize} and not
      // just for the SDK-backed one. Python trims in the same place
      // (`history_compression_service.py:216`).
      const section = raw?.trim() || null
      if (section) logger.info(`${SUMMARIZER_NAME} generated section: ${section.slice(0, 100)}...`)
      return section
    } catch (error) {
      logger.exception('Error generating compressed section', error)
      return null
    }
  }

  /**
   * Append sections to `consolidated_history.md`, creating it if needed.
   *
   * Existing content is right-trimmed before the join so repeated runs produce
   * exactly one blank line between sections rather than a growing gap.
   */
  private appendConsolidatedSections(worldName: string, sections: string[]): void {
    const file = join(this.worlds.getWorldPath(worldName), 'consolidated_history.md')

    const existing = existsSync(file) ? readFileSync(file, 'utf-8') : ''
    const added = sections.join('\n\n')
    const final = existing ? `${existing.trimEnd()}\n\n${added}` : added

    writeFileSync(file, final, 'utf-8')
  }

  /** Truncate `history.md` back to its header and drop the cached read. */
  private resetHistory(worldName: string): void {
    const file = join(this.worlds.getWorldPath(worldName), 'history.md')
    writeFileSync(file, `${EMPTY_HISTORY_MARKER}\n\n`, 'utf-8')
    this.cache.invalidate(file)
  }
}

function emptyResult(message: string): CompressionResult {
  return { success: true, turns_compressed: 0, sections_created: 0, message }
}
