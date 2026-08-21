import type { z } from 'zod'

/**
 * A tool's declaration, separated from its implementation.
 *
 * Port of `sdk/tools/tool_definitions.py`. Python kept these apart because the
 * description and the response template are overridable per agent group via
 * `group_config.yaml`, while the handler is fixed — so the two halves have
 * different lifetimes and different owners.
 *
 * One thing is fixed that Python left loose: Python stored the fully-qualified
 * `mcp__server__tool` name in the definition *and* separately registered the
 * short name with the SDK, leaving the two to be kept in sync by hand. Here the
 * short name is the only name written down and the qualified form is derived
 * (`qualifiedToolName`), so they cannot drift.
 */
export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** Short name as the model sees it after the server prefix, e.g. `narration`. */
  name: string
  description: string
  /** Zod raw shape — the SDK's `tool()` takes the shape, not a wrapped object. */
  inputSchema: Shape
  /**
   * Template for the tool's success text, with `{placeholder}` slots.
   *
   * Group configs override this to change what an agent is told after a call —
   * the `recall` tool's `{memory_content}` override, for instance, makes an
   * agent's memories come back verbatim instead of summarized.
   */
  response?: string
  enabled?: boolean
}

/** The name the model actually calls, as assembled by the SDK's MCP layer. */
export function qualifiedToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
}

/**
 * Fill `{placeholder}` slots, leaving unknown ones untouched.
 *
 * Tolerant by design: Python's `format_response` caught KeyError and returned
 * the raw template, because a group config carrying a placeholder the caller
 * does not supply should degrade to a slightly odd message rather than fail the
 * tool call mid-turn.
 */
export function formatTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  )
}
