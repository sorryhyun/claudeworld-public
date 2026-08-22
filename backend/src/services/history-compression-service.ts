/**
 * Compresses `history.md` into `consolidated_history.md`: turns are batched,
 * summarised by `History_Summarizer`, and appended under `## [subtitle]`
 * headings — the shape `recall_history` reads back. The model call is injected
 * as {@link Summarize} so the batching half, which can lose a player's history,
 * is testable without the SDK. Reads live on `WorldService`.
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

const TURN_PATTERN = /^## Turn (\d+) - (.+)$/gm

export const BATCH_SIZE = 3

const EMPTY_HISTORY_MARKER = '# World History'

const SUMMARIZER_NAME = 'History_Summarizer'

const SUMMARIZER_GROUP = 'gameplay'

export interface TurnEntry {
  turnNumber: number
  location: string
  content: string
}

/** The compression route's response body — snake_case is the frozen wire shape. */
export interface CompressionResult {
  success: boolean
  turns_compressed: number
  sections_created: number
  message: string
}

/** Returns the section, heading included, or `null`; a rejection costs that
 * batch, not the run. */
export type Summarize = (request: SummarizeRequest) => Promise<string | null>

export interface SummarizeRequest {
  agent: Agent
  systemPrompt: string
  userMessage: string
  /** Room the work is attributed to; 0 outside a room. */
  roomId: number
}

/** Anything before the first heading is dropped, so the `# World History` title
 * survives the end-of-run rewrite; a headingless file yields `[]`. */
export function parseHistoryIntoTurns(historyContent: string): TurnEntry[] {
  const matches = [...historyContent.matchAll(TURN_PATTERN)]

  return matches.map((match, i) => {
    const start = (match.index ?? 0) + match[0].length
    const end = matches[i + 1]?.index ?? historyContent.length

    return {
      turnNumber: Number.parseInt(match[1] ?? '0', 10),
      location: match[2] ?? '',
      content: historyContent.slice(start, end).trim(),
    }
  })
}

/** Chunk turns into batches, in order; the last one is short, not padded. A
 * `batchSize` below 1 would loop forever, so it throws. */
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

/** Round-trips to the parsed form: the summarizer's config describes history in
 * these terms, and its headings must match what `getHistoryBySubtitle` parses. */
export function formatBatchForSummarizer(batch: TurnEntry[]): string {
  const lines: string[] = []
  for (const entry of batch) {
    lines.push(`## Turn ${entry.turnNumber} - ${entry.location}`)
    lines.push(entry.content)
    lines.push('')
  }
  return lines.join('\n')
}

/** A prompt, trailing ellipsis and all: paraphrasing it changes every run. */
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

/**
 * A {@link Summarize} backed by the Agent SDK. No MCP servers: the summarizer
 * has no `agents:` entry and would get an empty set anyway. Keying the session
 * on room 0 makes every batch reuse one warm session and see the previous
 * batches, which is why the sections read as continuous history.
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
      // The section is written to a file, never streamed into the room.
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
        // Matters when the turn produced no deltas at all, which is what a
        // non-streaming result message looks like.
        responseText = event.responseText
      }
    }

    return responseText.trim() || null
  }
}

export class HistoryCompressionService {
  private readonly worlds: WorldService
  private readonly cache: MtimeCache
  private readonly configs: AgentConfigService

  // `summarize` is not defaulted to `createSummarizer`: that needs a
  // `SessionPool`, and would let a test silently spawn a CLI.
  constructor(
    private readonly summarize: Summarize,
    worldsDir: string = getSettings().paths.worldsDir,
    configs: AgentConfigService = new AgentConfigService(),
  ) {
    // Held here because `compressHistory` rewrites `history.md` through `fs`
    // and must drop that entry: two writes inside one millisecond would leave
    // the emptied file invisible to `loadHistory`.
    this.cache = new MtimeCache()
    this.worlds = new WorldService(worldsDir, this.cache)
    this.configs = configs
  }

  /**
   * Compress a world's `history.md` and clear it; only a run where *every* batch
   * failed reports `success: false`. **Sharp edge:** the file is cleared
   * regardless, so a partial run permanently discards the turns whose batches
   * failed. It looks like a bug, but changing it changes what a world retains.
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
      // Sequential: the batches share one warm session and append in order.
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

  // Scoped to `gameplay` so a world character of the same name cannot match.
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

  // The system prompt is rebuilt from the config folder, not read from the
  // `system_prompt` column, so an edit takes effect on the next compression.
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

      // Trimmed here, so a blank section fails the batch for every Summarize.
      const section = raw?.trim() || null
      if (section) logger.info(`${SUMMARIZER_NAME} generated section: ${section.slice(0, 100)}...`)
      return section
    } catch (error) {
      logger.exception('Error generating compressed section', error)
      return null
    }
  }

  // Right-trimmed before the join, so repeated runs leave one blank line.
  private appendConsolidatedSections(worldName: string, sections: string[]): void {
    const file = join(this.worlds.getWorldPath(worldName), 'consolidated_history.md')

    const existing = existsSync(file) ? readFileSync(file, 'utf-8') : ''
    const added = sections.join('\n\n')
    const final = existing ? `${existing.trimEnd()}\n\n${added}` : added

    writeFileSync(file, final, 'utf-8')
  }

  private resetHistory(worldName: string): void {
    const file = join(this.worlds.getWorldPath(worldName), 'history.md')
    writeFileSync(file, `${EMPTY_HISTORY_MARKER}\n\n`, 'utf-8')
    this.cache.invalidate(file)
  }
}

function emptyResult(message: string): CompressionResult {
  return { success: true, turns_compressed: 0, sections_created: 0, message }
}
