/**
 * Shared scaffolding for the tool-handler suites.
 *
 * Two things every one of them needs and neither is interesting enough to
 * write five times: a way to *call* a tool the way the SDK does — parse the raw
 * arguments through the declared Zod shape, then run the handler — and a way to
 * read the text back out of an MCP result.
 *
 * Parsing rather than hand-constructing the arguments is the point. Half of the
 * parity landmines in this layer live in the schema (`bring_characters` given a
 * JSON string, `stat_changes` given `'[]'`, `adjacent_to` given a bare name),
 * and a test that skips the parse cannot see any of them.
 */

import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { SdkTool } from '../sdk/handlers/context'

/** Find one tool in what a factory returned; throws rather than returning undefined. */
export function findTool(tools: SdkTool[], name: string): SdkTool {
  const found = tools.find((tool) => tool.name === name)
  if (!found) {
    throw new Error(`No tool named "${name}" among [${tools.map((t) => t.name).join(', ')}]`)
  }
  return found
}

/** Parse `args` through the tool's own schema, then invoke its handler. */
export async function callTool(
  tool: SdkTool,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const parsed = z.object(tool.inputSchema).parse(args)
  return tool.handler(parsed, undefined)
}

/** The concatenated text of an MCP result. */
export function resultText(result: CallToolResult): string {
  return (result.content as { type: string; text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/** Whether the result carries the `isError` flag the model sees as a failure. */
export function isError(result: CallToolResult): boolean {
  return result.isError === true
}
