/**
 * Human-readable transcripts of what each agent was actually sent and returned.
 *
 * Ported from `backend/infrastructure/logging/agent_logger.py` and
 * `formatters.py`. Off by default; turned on by `debug.enabled` in
 * `backend/infrastructure/logging/debug.yaml` or by `DEBUG_AGENTS=true`, and
 * written to `<backendDir>/<output_file>` (`backend/debug.txt`) so both
 * backends append to the same file and a mixed session reads in order.
 *
 * Every switch in `debug.yaml` is honoured, including the ones that are
 * currently `true` for everyone — the file is the user's control surface, and
 * silently ignoring half of it would be worse than the small amount of
 * branching here.
 *
 * One divergence: Python recovers tool descriptions by reaching into each MCP
 * server instance and invoking its `ListToolsRequest` handler. The declarations
 * already exist as plain data in `src/sdk/tools/`, so callers pass them in
 * instead. Same output, no dependency on SDK internals.
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Options } from '@anthropic-ai/claude-agent-sdk'

import { getSettings } from '../../config/settings'
import { getDebugConfig } from '../../sdk/loaders/yaml-config'
import type { ToolDefinition } from '../../sdk/tools/definitions'
import { getLogger } from './logger'

const logger = getLogger('DebugLogger')

// ============================================================================
// debug.yaml access
// ============================================================================

function section(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function flag(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = config[key]
  return typeof value === 'boolean' ? value : fallback
}

function integer(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(config: Record<string, unknown>, key: string, fallback: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : fallback
}

export interface DebugSettings {
  enabled: boolean
  outputPath: string
  logInput: { systemPrompt: boolean; toolDescriptions: boolean; messageContent: boolean }
  logOutput: { responseText: boolean; thinkingText: boolean; skippedStatus: boolean }
  format: {
    timestamp: boolean
    separatorLine: string
    includeAgentName: boolean
    includeTaskId: boolean
  }
  formatting: { truncateStrings: boolean; maxStringLength: number; includeSignatures: boolean }
}

/** Read `debug.yaml` (hot-reloaded) into a resolved, fully-defaulted shape. */
export function readDebugSettings(): DebugSettings {
  const debug = section(getDebugConfig(), 'debug')
  const logging = section(debug, 'logging')
  const format = section(debug, 'format')
  const formatting = section(debug, 'formatting')

  const separator = str(format, 'separator', '=')
  const separatorLength = integer(format, 'separator_length', 80)

  return {
    enabled: flag(debug, 'enabled', false),
    // `output_file` is documented as "relative to backend directory", and the
    // Python code resolves it against `backend/` — not the project root.
    outputPath: join(getSettings().paths.backendDir, str(debug, 'output_file', 'debug.txt')),
    logInput: {
      systemPrompt: flag(section(logging, 'input'), 'system_prompt', true),
      toolDescriptions: flag(section(logging, 'input'), 'tool_descriptions', true),
      messageContent: flag(section(logging, 'input'), 'message_content', true),
    },
    logOutput: {
      responseText: flag(section(logging, 'output'), 'response_text', true),
      thinkingText: flag(section(logging, 'output'), 'thinking_text', true),
      skippedStatus: flag(section(logging, 'output'), 'skipped_status', true),
    },
    format: {
      timestamp: flag(format, 'timestamp', true),
      separatorLine: separator.repeat(Math.max(0, separatorLength)),
      includeAgentName: flag(format, 'include_agent_name', true),
      includeTaskId: flag(format, 'include_task_id', true),
    },
    formatting: {
      truncateStrings: flag(formatting, 'truncate_strings', true),
      maxStringLength: integer(formatting, 'max_string_length', 500),
      includeSignatures: flag(formatting, 'include_signatures', false),
    },
  }
}

function append(path: string, text: string): void {
  try {
    appendFileSync(path, text, 'utf-8')
  } catch (error) {
    logger.warning(`Failed to write debug log: ${String(error)}`)
  }
}

// ============================================================================
// Input log
// ============================================================================

export interface AgentInputLog {
  agentName: string
  taskId: string
  /** The message actually pushed to the session, conversation history included. */
  messageToSend: string
  /** The options the turn will run with — the real ones, not a reconstruction. */
  options: Options
  /** Tool declarations per MCP server name, as offered to this agent. */
  toolsByServer?: Record<string, readonly ToolDefinition[]>
}

/**
 * Append one agent's complete input to the debug log.
 *
 * Python gates the whole function on `logging.input.system_prompt`, so turning
 * that one switch off suppresses the tool and message sections too. Reproduced:
 * it is the only way `debug.yaml` can currently silence input logging wholesale.
 */
export function writeAgentInputLog(entry: AgentInputLog): void {
  const settings = readDebugSettings()
  if (!settings.enabled || !settings.logInput.systemPrompt) return

  const { separatorLine } = settings.format
  const parts: string[] = ['\n', separatorLine, '\n']

  if (settings.format.timestamp) parts.push(`TIMESTAMP: ${new Date().toISOString()}\n`)
  if (settings.format.includeAgentName) parts.push(`AGENT: ${entry.agentName}\n`)
  if (settings.format.includeTaskId) parts.push(`TASK_ID: ${entry.taskId}\n`)
  parts.push(separatorLine, '\n\n')

  parts.push('--- ACTUAL SYSTEM PROMPT (from ClaudeAgentOptions) ---\n')
  parts.push(typeof entry.options.systemPrompt === 'string'
    ? entry.options.systemPrompt
    : JSON.stringify(entry.options.systemPrompt))
  parts.push('\n\n')

  if (settings.logInput.toolDescriptions) {
    parts.push('--- ACTUAL TOOL CONFIGURATION (from ClaudeAgentOptions) ---\n\n')
    parts.push(`MODEL: ${String(entry.options.model)}\n`)
    if (entry.options.resume) parts.push(`SESSION ID: ${entry.options.resume}\n`)
    parts.push('\n')

    const toolsByServer = entry.toolsByServer ?? {}
    if (Object.keys(toolsByServer).length > 0) {
      parts.push('TOOLS AVAILABLE TO AGENT:\n\n')
      for (const [serverName, tools] of Object.entries(toolsByServer)) {
        if (tools.length === 0) continue
        parts.push(`[${serverName.toUpperCase()} SERVER]\n`)
        for (const tool of tools) {
          parts.push(`\nTool: ${tool.name}\n`)
          parts.push(`Description: ${tool.description || 'No description'}\n`)
          parts.push(`Input Schema: ${Object.keys(tool.inputSchema).join(', ')}\n`)
        }
        parts.push('\n')
      }
    }

    if (entry.options.allowedTools?.length) {
      parts.push('ALLOWED TOOLS (names only):\n')
      for (const name of entry.options.allowedTools) parts.push(`  - ${name}\n`)
      parts.push('\n')
    }
    if (entry.options.disallowedTools?.length) {
      parts.push('DISALLOWED TOOLS:\n')
      for (const name of entry.options.disallowedTools) parts.push(`  - ${name}\n`)
      parts.push('\n')
    }
  }

  if (settings.logInput.messageContent) {
    parts.push('--- MESSAGE TO SEND (including conversation history) ---\n')
    parts.push(entry.messageToSend, '\n\n')
  }

  parts.push(separatorLine, '\n\n')

  append(settings.outputPath, parts.join(''))
  logger.info(`📝 Debug log written to ${settings.outputPath}`)
}

// ============================================================================
// Output log
// ============================================================================

export interface AgentResponseLog {
  agentName: string
  taskId: string
  responseText: string
  thinkingText: string
  skipped: boolean
}

/** Append an agent's response to the debug log. */
export function writeAgentResponseLog(entry: AgentResponseLog): void {
  const settings = readDebugSettings()
  if (!settings.enabled || !settings.logOutput.responseText) return

  const header = ['--- AGENT RESPONSE']
  if (settings.format.includeAgentName) header.push(`AGENT: ${entry.agentName}`)
  if (settings.format.includeTaskId) header.push(`TASK_ID: ${entry.taskId}`)

  const parts: string[] = [`${header.join(', ')} ---\n\n`]

  if (entry.skipped && settings.logOutput.skippedStatus) {
    parts.push('[AGENT SKIPPED THIS TURN]\n\n')
  } else {
    if (entry.thinkingText && settings.logOutput.thinkingText) {
      parts.push('THINKING:\n', entry.thinkingText, '\n\n')
    }
    parts.push('RESPONSE:\n', entry.responseText || '[No response text]', '\n\n')
  }

  parts.push(settings.format.separatorLine, '\n\n')

  append(settings.outputPath, parts.join(''))
  logger.info('📝 Agent response appended to debug log')
}

// ============================================================================
// Message formatting (formatters.py)
// ============================================================================

/**
 * Render an SDK message as indented JSON for eyeballing.
 *
 * Python walks `__dict__` because its SDK messages are dataclasses; the TS SDK
 * hands over plain objects, so a `JSON.stringify` replacer does the same job.
 * Both truncate long strings and drop `signature` fields by default — thinking
 * signatures are hundreds of opaque characters that bury everything around them.
 */
export function formatMessageForDebug(message: unknown): string {
  const { truncateStrings, maxStringLength, includeSignatures } = readDebugSettings().formatting
  const seen = new WeakSet<object>()

  const replacer = (key: string, value: unknown): unknown => {
    if (!includeSignatures && key === 'signature') return undefined
    if (typeof value === 'string' && truncateStrings && value.length > maxStringLength) {
      return `${value.slice(0, maxStringLength)}... (truncated, total ${value.length} chars)`
    }
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'object' && value !== null) {
      // Python's recursion would hit RecursionError on a cycle; JSON.stringify
      // throws. Neither is useful in a debug path, so cycles are elided.
      if (seen.has(value)) return '[circular]'
      seen.add(value)
    }
    return value
  }

  try {
    return JSON.stringify(message, replacer, 2) ?? String(message)
  } catch (error) {
    return `<Error formatting message: ${String(error)}>`
  }
}
